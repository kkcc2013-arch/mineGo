'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const os=require('node:os');const {promisify}=require('node:util');const {execFile}=require('node:child_process');
const fs=require('node:fs/promises');const path=require('node:path');const {Pool,Client}=require('pg');
const {parseMigrationFile}=require('../../../database/migrate');const {migrationStatements}=require('../../../database/sqlStatements');
const root=path.resolve(__dirname,'../../..'),filename='20260707_100000__cdc_triggers_for_cache_invalidation.sql';
const read=f=>fs.readFile(path.join(root,f),'utf8');const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function apply(pool,source){const c=await pool.connect();try{await c.query('BEGIN');for(const sql of migrationStatements(parseMigrationFile(source).up))await c.query(sql);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function fixture(fn){
  assert.ok(process.env.TEST_DATABASE_URL,'owned isolated PostGIS database required');const schema='cdc_storage_'+crypto.randomBytes(8).toString('hex');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');await admin.query('CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
  const pool=new Pool({connectionString:url.toString(),max:2});const listener=new Client({connectionString:url.toString()});const notifications=[];
  try{
    await pool.query(await read('database/migrations/V1__initial_schema.sql'));await pool.query(await read('database/seeds/V2__seed_data.sql'));
    for(const f of ['20261008_140000__audit_partition_conversion.sql','repairs/20260610_100000__add_table_partitioning_system.sql','20261008_130000__item_catalog_prerequisite.sql','repairs/20260609_124500__add_item_inventory_system.sql'])await apply(pool,await read('database/pending/'+f));
    await listener.connect();listener.on('notification',msg=>notifications.push(msg));
    const channel='minego_cache_'+crypto.createHash('md5').update(schema).digest('hex');await listener.query(`LISTEN ${channel}`);
    await fn({pool,schema,url:url.toString(),listener,notifications,repair:await read('database/pending/repairs/'+filename)});
  }finally{await listener.end();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await delay(5);}throw new Error('actual event deadline exceeded');}
async function snapshot(pool){return {
 objects:(await pool.query("SELECT oid,relname FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY oid")).rows,
 functions:(await pool.query("SELECT oid,pg_get_functiondef(oid) AS definition,proconfig,proacl FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY oid")).rows,
 triggers:(await pool.query("SELECT t.oid,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY t.oid")).rows
};}

test('canonical bounded CDC journal captures real committed identity changes without private row data',async t=>fixture(async({pool,schema,notifications,repair})=>{
  const owner=crypto.randomUUID(),other=crypto.randomUUID();await pool.query("INSERT INTO users(id,nickname) VALUES($1,'cdc-owner'),($2,'cdc-other')",[owner,other]);
  const before=await snapshot(pool);
  await t.test('original missing pokemon trigger fails and rolls back even the earlier users trigger/function',async()=>{
    await assert.rejects(apply(pool,await read('database/pending/'+filename)),{code:'42P01'});assert.deepEqual(await snapshot(pool),before);
  });
  await apply(pool,repair);
  await t.test('all18 actual sources bind without fake aliases or manufacturing historical change records',async()=>{
    assert.equal((await pool.query('SELECT * FROM cache_invalidation_outbox')).rowCount,0);
    assert.equal((await pool.query("SELECT * FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND t.tgname LIKE 'minego_cache_cdc_%' AND t.tgparentid=0")).rowCount,18);
    for(const name of ['pokemon','gyms_teams','friends','inventory','reward_records','payments'])assert.equal((await pool.query('SELECT to_regclass($1) AS name',[name])).rows[0].name,null);
  });
  await t.test('source mutation and outbox are invisible before commit and neither survives rollback',async()=>{
    const c=await pool.connect();try{await c.query('BEGIN');await c.query('UPDATE users SET coins=coins+1 WHERE id=$1',[owner]);assert.equal((await pool.query('SELECT * FROM cache_invalidation_outbox')).rowCount,0);await delay(25);assert.equal(notifications.length,0);await c.query('ROLLBACK');}finally{c.release();}
    assert.equal((await pool.query('SELECT * FROM cache_invalidation_outbox')).rowCount,0);assert.equal(notifications.length,0);
  });
  await t.test('committed huge/private source updates publish only an opaque UUID and persist only approved IDs',async()=>{
    await pool.query('ALTER TABLE users ADD COLUMN fixture_private_blob text');
    await pool.query('UPDATE users SET fixture_private_blob=$1 WHERE id=$2',['fixture-private-value-'+'.'.repeat(256000),owner]);
    await until(()=>notifications.length===1);assert.match(notifications[0].payload,/^[a-f0-9-]{36}$/);assert.equal(Buffer.byteLength(notifications[0].payload),36);
    const row=(await pool.query('SELECT * FROM cache_invalidation_outbox')).rows[0];assert.equal(row.event_id,notifications[0].payload);assert.equal(row.table_name,'users');assert.equal(row.operation,'update');assert.deepEqual(row.old_keys,{id:owner});assert.deepEqual(row.new_keys,{id:owner});assert.ok(!JSON.stringify(row).includes('fixture-private-value'));
  });
  await t.test('real ownership updates retain both old/new owner identities and delete captures OLD',async()=>{
    const pokemon=crypto.randomUUID();await pool.query('INSERT INTO pokemon_instances(id,user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) VALUES($1,$2,1,20,10,10,1,2,3)',[pokemon,owner]);
    await pool.query('UPDATE pokemon_instances SET user_id=$1 WHERE id=$2',[other,pokemon]);await pool.query('DELETE FROM pokemon_instances WHERE id=$1',[pokemon]);
    const rows=(await pool.query("SELECT * FROM cache_invalidation_outbox WHERE table_name='pokemon_instances' ORDER BY created_at,event_id")).rows;assert.equal(rows.length,3);assert.equal(rows[1].old_keys.user_id,owner);assert.equal(rows[1].new_keys.user_id,other);assert.equal(rows[2].old_keys.user_id,other);assert.deepEqual(rows[2].new_keys,{});
  });
  await t.test('actual partition-leaf writes retain the canonical parent name and no false events from data movement',async()=>{
    const id=crypto.randomUUID();await pool.query("INSERT INTO catch_records(id,user_id,pokemon_id,created_at) VALUES($1,$2,$3,'2040-01-02')",[id,owner,crypto.randomUUID()]);
    const count=(await pool.query("SELECT count(*)::int AS n FROM cache_invalidation_outbox WHERE table_name='catch_records'")).rows[0].n;assert.equal(count,1);
    await pool.query("SELECT minego_create_time_partition('catch_records','catch_records_2040_01','2040-01-01+00','2040-02-01+00')");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM cache_invalidation_outbox WHERE table_name='catch_records'")).rows[0].n,count);
    await pool.query('DELETE FROM catch_records WHERE id=$1',[id]);const row=(await pool.query("SELECT * FROM cache_invalidation_outbox WHERE table_name='catch_records' AND operation='delete'")).rows[0];assert.equal(row.old_keys.id,id);
  });
  await t.test('unknown/private/large key fields cannot be inserted into the pending journal',async()=>{
    for(const keys of [{id:owner,password_hash:'fixture-only'},{id:'x'.repeat(129)},{id:{nested:'fixture-only'}}])await assert.rejects(pool.query("INSERT INTO cache_invalidation_outbox(table_name,operation,new_keys,old_keys) VALUES('users','update',$1,'{}')",[keys]),{code:'23514'});
  });
  await t.test('rerun preserves all pending work, trigger/function/OIDs and source values',async()=>{
    const rows=(await pool.query('SELECT to_jsonb(r)::text AS row FROM cache_invalidation_outbox r ORDER BY event_id')).rows;const state=await snapshot(pool);await apply(pool,repair);assert.deepEqual(await snapshot(pool),state);assert.deepEqual((await pool.query('SELECT to_jsonb(r)::text AS row FROM cache_invalidation_outbox r ORDER BY event_id')).rows,rows);
    assert.equal((await pool.query('SELECT length(fixture_private_blob)::int AS n FROM users WHERE id=$1',[owner])).rows[0].n,256022);
  });
  await t.test('actual migration CLI retains raw/execution checksums and verifies an idempotent up/up',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'minego-cdc-cli-'));
    try{
      const original=await read('database/pending/'+filename);await fs.mkdir(path.join(dir,'repairs'));await fs.writeFile(path.join(dir,filename),original);await fs.writeFile(path.join(dir,'repairs',filename),repair);
      const manifest=JSON.parse(await read('database/pending/repairs.json'));await fs.writeFile(path.join(dir,'repairs.json'),JSON.stringify({schemaVersion:1,repairs:{'20260707_100000':manifest.repairs['20260707_100000']}}));
      const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
      const cli=command=>promisify(execFile)(process.execPath,[path.join(root,'database/migrate.js'),command],{env:{...process.env,DATABASE_URL:url.toString(),MINEGO_MIGRATIONS_DIR:dir},timeout:30000});
      const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
      await cli('up');const row=(await pool.query('SELECT checksum,execution_checksum FROM schema_migrations')).rows[0];assert.equal(row.checksum,hash(original));assert.equal(row.execution_checksum,hash(JSON.stringify({up:repair.trim(),down:''})));
      const state=await snapshot(pool);await cli('up');await cli('verify');assert.deepEqual(await snapshot(pool),state);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });

}));

test('unknown CDC function/trigger/outbox/legacy contracts refuse without replacing owned state',async t=>{
  for(const [label,sql,pattern,first=false] of [
    ['custom capture function',"CREATE FUNCTION minego_capture_cache_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END;$$",/Customized cache function/],
    ['disabled source trigger','ALTER TABLE users DISABLE TRIGGER minego_cache_cdc_users',/Customized cache trigger/,true],
    ['outbox privacy check removed','ALTER TABLE cache_invalidation_outbox DROP CONSTRAINT cache_invalidation_outbox_new_keys_check',/Customized cache outbox contract/,true],
    ['settings singleton check removed','ALTER TABLE cache_invalidation_settings DROP CONSTRAINT cache_invalidation_settings_singleton_check',/Customized cache settings contract/,true],
    ['settings revision check removed','ALTER TABLE cache_invalidation_settings DROP CONSTRAINT cache_invalidation_settings_revision_check',/Customized cache settings contract/,true],
    ['active legacy full-row trigger',"CREATE FUNCTION notify_cache_invalidation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$; CREATE TRIGGER cdc_users_trigger AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation()",/Active legacy cache notifications/]
  ])await t.test(label,async()=>fixture(async({pool,repair})=>{
    if(first)await apply(pool,repair);await pool.query(sql);const state=await snapshot(pool);await assert.rejects(apply(pool,repair),pattern);assert.deepEqual(await snapshot(pool),state);
  }));
});
