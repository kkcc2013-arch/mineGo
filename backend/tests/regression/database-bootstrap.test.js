'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Pool}=require('pg');
const {spawn}=require('node:child_process');

test('full production V1 schema and V2 sample seed retain valid evolution relationships',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify an isolated PostGIS database');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema=`bootstrap_${crypto.randomBytes(8).toString('hex')}`;await admin.query(`CREATE SCHEMA ${schema}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const client=await fixture.connect();
  try{
    const initial=await fs.readFile(path.resolve(__dirname,'../../../database/migrations/V1__initial_schema.sql'),'utf8');
    const seed=await fs.readFile(path.resolve(__dirname,'../../../database/seeds/V2__seed_data.sql'),'utf8');
    await client.query('BEGIN');await client.query(initial);await client.query(seed);await client.query('COMMIT');
    assert.equal((await fixture.query('SELECT count(*)::int AS count FROM pokemon_species')).rows[0].count,32);
    assert.equal((await fixture.query('SELECT count(*)::int AS count FROM achievement_definitions')).rows[0].count,8);
    assert.equal((await fixture.query('SELECT count(*)::int AS count FROM pokestops')).rows[0].count,5);
    assert.equal((await fixture.query('SELECT count(*)::int AS count FROM gyms')).rows[0].count,3);
    assert.equal((await fixture.query('SELECT 1 FROM pokemon_species s LEFT JOIN pokemon_species target ON s.evolves_to=target.id WHERE s.evolves_to IS NOT NULL AND target.id IS NULL')).rowCount,0);
    assert.deepEqual((await fixture.query('SELECT id,evolves_to FROM pokemon_species WHERE id IN(54,74,75,79) ORDER BY id')).rows,[{id:54,evolves_to:55},{id:74,evolves_to:75},{id:75,evolves_to:76},{id:79,evolves_to:80}]);
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

async function checkFullHistory({unrelatedAudit=false}={}){
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify an isolated PostGIS database');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema=`full_migrations_${crypto.randomBytes(8).toString('hex')}`;await admin.query(`CREATE SCHEMA ${schema}`);
  const outsider=schema+'_unrelated';let outsiderOid;
  if(unrelatedAudit){await admin.query(`CREATE SCHEMA ${outsider};CREATE TABLE ${outsider}.audit_logs(encrypted_data bytea,encryption_key_id varchar(64),encryption_iv varchar(64),encryption_auth_tag varchar(64),marker text);INSERT INTO ${outsider}.audit_logs(marker) VALUES('owned unrelated schema marker')`);outsiderOid=(await admin.query('SELECT to_regclass($1)::oid AS oid',[outsider+'.audit_logs'])).rows[0].oid;}
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  let child;
  try{
    await fixture.query(await fs.readFile(path.resolve(__dirname,'../../../database/migrations/V1__initial_schema.sql'),'utf8'));
    await fixture.query(await fs.readFile(path.resolve(__dirname,'../../../database/seeds/V2__seed_data.sql'),'utf8'));
    const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
    const env={...process.env,DATABASE_URL:url.toString()};delete env.MINEGO_MIGRATIONS_DIR;delete env.NODE_PATH;
    child=spawn(process.execPath,[path.resolve(__dirname,'../../../database/migrate.js'),'up'],{env,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});child=null;
    assert.equal(code,0,`Complete production migration history is unfinished:\n${output}`);
    const files=(await fs.readdir(path.join(__dirname,'../../../database/pending'))).filter(file=>file.endsWith('.sql'));
    const history=(await fixture.query('SELECT version,checksum FROM schema_migrations')).rows;
    assert.equal(history.length,files.length);
    for(const file of files){const source=await fs.readFile(path.join(__dirname,'../../../database/pending',file));const version=file.split('__')[0];assert.equal(history.find(row=>row.version===version)?.checksum,crypto.createHash('sha256').update(source).digest('hex'));}
    if(unrelatedAudit){assert.equal((await admin.query('SELECT to_regclass($1)::oid AS oid',[outsider+'.audit_logs'])).rows[0].oid,outsiderOid);assert.deepEqual((await admin.query(`SELECT marker FROM ${outsider}.audit_logs`)).rows,[{marker:'owned unrelated schema marker'}]);assert.equal((await fixture.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='audit_logs' AND column_name IN('encrypted_data','encryption_key_id','encryption_iv','encryption_auth_tag')")).rows[0].n,4);}
  }finally{
    if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;}
    await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);if(unrelatedAudit)await admin.query(`DROP SCHEMA ${outsider} CASCADE`);await admin.end();
  }
}

test('complete legacy pending migration history applies to the full seeded production schema',{timeout:60000},()=>checkFullHistory());
test('complete production history also installs beside another schema with the same audit encryption columns',{timeout:60000},()=>checkFullHistory({unrelatedAudit:true}));
