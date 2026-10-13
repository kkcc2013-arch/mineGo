'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {Pool} = require('pg');
const {migrationStatements} = require('../../../database/sqlStatements');
const {parseMigrationFile} = require('../../../database/migrate');
const root = path.resolve(__dirname, '../../..');
const version = '20260618_160000';
const file = `${version}__add_voice_chat_tables.sql`;
let raw, repair;

async function fixture(run) {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must identify isolated PostGIS');
  raw = await fs.readFile(path.join(root, 'database/pending', file), 'utf8');
  repair = await fs.readFile(path.join(root, 'database/pending/repairs', file), 'utf8');
  const schema = `voice_schema_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Pool({connectionString: process.env.TEST_DATABASE_URL, max: 1});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({connectionString: process.env.TEST_DATABASE_URL, max: 2, options: `-c search_path=${schema},public`});
  const apply = async sql => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of migrationStatements(sql)) await client.query(statement);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  };
  try { await run({pool, schema, apply}); }
  finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}

test('original mutable TURN predicate really fails PostgreSQL and rolls back its DDL', async () => fixture(async ({pool, apply}) => {
  // Bypass only the earlier invalid inline partial UNIQUE to expose the original time predicate.
  const membership = /,\s*UNIQUE\(room_id, user_id\) WHERE left_at IS NULL/;
  assert.match(raw, membership);
  await assert.rejects(apply(raw.replace(membership, '')), e => e.code === '42P17' && /IMMUTABLE/.test(e.message));
  assert.equal((await pool.query("SELECT to_regclass('turn_credentials') AS relation")).rows[0].relation, null);
}));

test('repaired actual voice schema retains historical membership and enforces active uniqueness', async () => fixture(async ({pool, apply}) => {
  await apply(repair);
  const room = (await pool.query("INSERT INTO voice_rooms(creator_id) VALUES('owner') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO voice_room_members(room_id,user_id,left_at) VALUES($1,'member','2020-01-01'),($1,'member','2020-02-01')", [room]);
  await pool.query("INSERT INTO voice_room_members(room_id,user_id) VALUES($1,'member')", [room]);
  await assert.rejects(pool.query("INSERT INTO voice_room_members(room_id,user_id) VALUES($1,'member')", [room]), {code:'23505'});
  await pool.query("UPDATE voice_room_members SET left_at=NOW() WHERE room_id=$1 AND left_at IS NULL", [room]);
  await pool.query("INSERT INTO voice_room_members(room_id,user_id,role) VALUES($1,'member','observer')", [room]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM voice_room_members')).rows[0].n, 4);
  await assert.rejects(pool.query("INSERT INTO voice_room_members(room_id,user_id) VALUES($1,'foreign-room')", [crypto.randomUUID()]), {code:'23503'});
  assert.equal((await pool.query('SELECT config FROM voice_rooms')).rows[0].config.codec, 'opus');
}));

test('actual TURN index supports current-time queries without deleting expired or revoked audit rows', async () => fixture(async ({pool, apply}) => {
  await apply(repair);
  await pool.query(`INSERT INTO turn_credentials(user_id,username,credential_hash,expires_at,revoked_at)
    VALUES('owner','active','fixture-hash',NOW()+INTERVAL '1 day',NULL),
    ('owner','expired','fixture-hash',NOW()-INTERVAL '1 day',NULL),
    ('owner','revoked','fixture-hash',NOW()+INTERVAL '1 day',NOW()),
    ('other','foreign','fixture-hash',NOW()+INTERVAL '1 day',NULL)`);
  const live = "SELECT username FROM turn_credentials WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW()";
  assert.deepEqual((await pool.query(live, ['owner'])).rows, [{username:'active'}]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL enable_seqscan=off');
    const plan = (await client.query('EXPLAIN (FORMAT JSON) '+live, ['owner'])).rows[0]['QUERY PLAN'];
    assert.match(JSON.stringify(plan), /idx_turn_creds_active/);
    await client.query('ROLLBACK');
  } finally { client.release(); }
  await pool.query("UPDATE turn_credentials SET expires_at=NOW()-INTERVAL '1 second' WHERE username='active'");
  assert.deepEqual((await pool.query(live, ['owner'])).rows, []);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM turn_credentials')).rows[0].n, 4);
  const predicate = (await pool.query("SELECT pg_get_expr(indpred,indrelid) AS predicate FROM pg_index WHERE indexrelid='idx_turn_creds_active'::regclass")).rows[0].predicate;
  assert.equal(predicate, '(revoked_at IS NULL)');
  // The real manager still lacks usage columns and ignores revocation; this schema test is not its acceptance.
  const columns = (await pool.query("SELECT attname FROM pg_attribute WHERE attrelid='turn_credentials'::regclass AND attnum>0 AND NOT attisdropped")).rows.map(r => r.attname);
  assert.equal(columns.includes('used_count'), false);
}));

test('upgrade preserves actual relation identities, rows, references and an exact operator index', async () => fixture(async ({pool, schema, apply}) => {
  const oldSchema = repair.replace(/CREATE UNIQUE INDEX voice_room_active_members[^;]+;/, '').replace(/DO \$turn_index\$[\s\S]*?\$turn_index\$;/, '');
  await apply(oldSchema);
  await pool.query("COMMENT ON INDEX idx_turn_creds_active IS 'operator-owned'");
  await pool.query("INSERT INTO turn_credentials(user_id,username,credential_hash,expires_at) VALUES('prior','historic','kept-hash','2020-01-01')");
  await pool.query('CREATE VIEW retained_turn_history AS SELECT * FROM turn_credentials');
  await pool.query('CREATE TABLE retained_turn_reference(id uuid REFERENCES turn_credentials(id))');
  await pool.query('INSERT INTO retained_turn_reference SELECT id FROM turn_credentials');
  const before = (await pool.query('SELECT * FROM turn_credentials')).rows;
  const objects = () => pool.query("SELECT oid,relname,obj_description(oid,'pg_class') AS comment FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN('turn_credentials','idx_turn_creds_active','voice_rooms') ORDER BY relname", [schema]);
  const ids = (await objects()).rows;
  await apply(repair);
  assert.deepEqual((await objects()).rows, ids);
  assert.deepEqual((await pool.query('SELECT * FROM retained_turn_history')).rows, before);
  assert.deepEqual((await pool.query('SELECT id FROM retained_turn_reference')).rows, [{id:before[0].id}]);
}));

test('unknown operator index is refused atomically without rewriting its records or definition', async () => fixture(async ({pool, apply}) => {
  await pool.query('CREATE TABLE turn_credentials(id uuid PRIMARY KEY,user_id varchar(50),username varchar(100),credential_hash varchar(255),ip_address inet,user_agent text,expires_at timestamptz,created_at timestamptz,revoked_at timestamptz)');
  await pool.query('CREATE INDEX idx_turn_creds_active ON turn_credentials(username)');
  const before = (await pool.query("SELECT pg_get_indexdef('idx_turn_creds_active'::regclass) AS definition")).rows[0];
  await assert.rejects(apply(repair), /explicit adoption/);
  assert.deepEqual((await pool.query("SELECT pg_get_indexdef('idx_turn_creds_active'::regclass) AS definition")).rows[0], before);
  assert.equal((await pool.query("SELECT to_regclass('voice_rooms') AS relation")).rows[0].relation, null);
}));

test('real migration CLI records original and executed voice checksums and verifies them', async () => fixture(async ({pool, schema}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minego-voice-history-'));
  let child;
  try {
    await fs.mkdir(path.join(directory, 'repairs'));
    await fs.writeFile(path.join(directory, file), raw); await fs.writeFile(path.join(directory, 'repairs', file), repair);
    const manifest = JSON.parse(await fs.readFile(path.join(root,'database/pending/repairs.json'),'utf8'));
    await fs.writeFile(path.join(directory,'repairs.json'), JSON.stringify({schemaVersion:1,repairs:{[version]:manifest.repairs[version]}}));
    const url = new URL(process.env.TEST_DATABASE_URL); url.searchParams.set('options',`-c search_path=${schema},public`);
    const run = async command => {
      child = spawn(process.execPath,[path.join(root,'database/migrate.js'),command],{env:{...process.env,DATABASE_URL:url.toString(),MINEGO_MIGRATIONS_DIR:directory},stdio:['ignore','pipe','pipe']});
      let output=''; child.stdout.on('data',b => output+=b); child.stderr.on('data',b => output+=b);
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}); child=null;
      assert.equal(code,0,output);
    };
    await run('up'); await run('verify');
    const record=(await pool.query('SELECT checksum,execution_checksum FROM schema_migrations WHERE version=$1',[version])).rows[0];
    const digest=s => crypto.createHash('sha256').update(s).digest('hex');
    assert.equal(record.checksum,digest(raw)); assert.equal(record.execution_checksum,digest(JSON.stringify(parseMigrationFile(repair))));
    await run('up'); assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,1);
  } finally {
    if(child && child.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await ended;}
    await fs.rm(directory,{recursive:true,force:true});
  }
}));
