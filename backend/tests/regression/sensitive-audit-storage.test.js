'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {promisify}=require('node:util');const {execFile}=require('node:child_process');const {Pool}=require('pg');
const {migrationStatements}=require('../../../database/sqlStatements');const {parseMigrationFile}=require('../../../database/migrate');
const root=path.resolve(__dirname,'../../..'),filename='20260608_200000__add_sensitive_data_audit_tables.sql';const read=f=>fs.readFile(path.join(root,f),'utf8');const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function apply(pool,source){const c=await pool.connect();try{await c.query('BEGIN');for(const sql of migrationStatements(parseMigrationFile(source).up))await c.query(sql);await c.query('COMMIT');}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}}
async function fixture(fn){
 assert.ok(process.env.TEST_DATABASE_URL,'owned PostGIS fixture required');const schema='sensitive_audit_'+crypto.randomBytes(8).toString('hex'),outside=schema+'_other';const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
 await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');await admin.query('CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');await admin.query(`CREATE SCHEMA ${schema};CREATE SCHEMA ${outside}`);
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);const pool=new Pool({connectionString:url.toString(),max:2});const outsiderUrl=new URL(process.env.TEST_DATABASE_URL);outsiderUrl.searchParams.set('options',`-c search_path=${outside},public`);const outsider=new Pool({connectionString:outsiderUrl.toString(),max:1});
 try{
  for(const target of [outsider,pool]){await target.query(await read('database/migrations/V1__initial_schema.sql'));await target.query(await read('database/seeds/V2__seed_data.sql'));await apply(target,await read('database/pending/20260608_194800__add_sensitive_data_protection_tables.sql'));}
  await apply(outsider,await read('database/pending/'+filename));
  await fn({pool,outsider,schema,outside,url:url.toString(),repair:await read('database/pending/repairs/'+filename)});
 }finally{await pool.end();await outsider.end();await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP SCHEMA ${outside} CASCADE`);await admin.end();}
}
async function snapshot(pool){return {
 objects:(await pool.query("SELECT oid,relname,relkind,relacl,obj_description(oid,'pg_class') AS comment FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY oid")).rows,
 columns:(await pool.query("SELECT a.attrelid,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default,col_description(a.attrelid,a.attnum) AS comment FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace=current_schema()::regnamespace AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attrelid,a.attnum")).rows,
 functions:(await pool.query("SELECT p.oid,p.prosrc,p.prosecdef,p.proconfig,p.proacl FROM pg_proc p WHERE pronamespace=current_schema()::regnamespace ORDER BY p.oid")).rows,
 views:(await pool.query("SELECT oid,pg_get_viewdef(oid,true) AS definition FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='v' ORDER BY oid")).rows
};}

test('actual sensitive audit storage isolates installation and preserves canonical encrypted history',async t=>fixture(async({pool,outsider,schema,outside,url,repair})=>{
 const actor=crypto.randomUUID();await pool.query("INSERT INTO users(id,nickname) VALUES($1,'sensitive-fixture')",[actor]);
 await pool.query("INSERT INTO audit_logs(user_id,action,details,created_at) VALUES($1,'legacy-existing','{\"retained\":true}','2020-03-01T12:00:00Z')",[actor]);
 const before=await snapshot(pool),otherBefore=await snapshot(outsider);
 await t.test('original unscoped lookup skips the current tag column and rolls back when another schema owns it',async()=>{
  await assert.rejects(apply(pool,await read('database/pending/'+filename)),{code:'42703'});assert.deepEqual(await snapshot(pool),before);assert.deepEqual(await snapshot(outsider),otherBefore);
 });
 const keyId=crypto.randomUUID(),workKey=crypto.randomBytes(32),master=crypto.randomBytes(32),wrapIv=crypto.randomBytes(16),wrapper=crypto.createCipheriv('aes-256-gcm',master,wrapIv);const wrapped=Buffer.concat([wrapIv,wrapper.update(workKey),wrapper.final(),wrapper.getAuthTag()]);
 await pool.query('INSERT INTO encryption_keys(id,encrypted_key,created_at) VALUES($1,$2,$3)',[keyId,wrapped,'2020-03-01T12:00:00Z']);
 const pathBefore=(await pool.query('SHOW search_path')).rows[0].search_path;
 await apply(pool,repair);
 await t.test('all four actual encryption columns exist and caller search_path/other schema remain intact',async()=>{
  const rows=(await pool.query("SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='audit_logs'::regclass AND attname=ANY($1)",[['encrypted_data','encryption_key_id','encryption_iv','encryption_auth_tag']])).rows;assert.equal(rows.length,4);assert.equal(rows.find(r=>r.attname==='encrypted_data').type,'bytea');
  assert.equal((await pool.query('SHOW search_path')).rows[0].search_path,pathBefore);assert.deepEqual(await snapshot(outsider),otherBefore);
 });
 await t.test('canonical timezone-free history and old key versions remain unknown instead of inventing instants',async()=>{
  const row=(await pool.query("SELECT id,created_at::text AS recorded_wall_time,timestamp FROM audit_logs WHERE action='legacy-existing'")).rows[0];assert.equal(row.timestamp,null);assert.equal(row.recorded_wall_time,'2020-03-01 12:00:00');
  const key=(await pool.query('SELECT key_version,encrypted_key FROM encryption_keys WHERE id=$1',[keyId])).rows[0];assert.equal(key.key_version,null);assert.deepEqual(key.encrypted_key,wrapped);
 });
 const iv=crypto.randomBytes(16),cipher=crypto.createCipheriv('aes-256-gcm',workKey,iv),plain=Buffer.from('fixture-only private audit');const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]),tag=cipher.getAuthTag();
 await pool.query('INSERT INTO audit_logs(user_id,action,encrypted_data,encryption_key_id,encryption_iv,encryption_auth_tag) VALUES($1,$2,$3,$4,$5,$6)',[actor,'actual-cipher-history',encrypted,keyId,iv.toString('hex'),tag.toString('hex')]);
 await pool.query("COMMENT ON TABLE encryption_keys IS 'operator-owned wrapped keys';COMMENT ON COLUMN audit_logs.encryption_auth_tag IS 'operator-owned tag';COMMENT ON VIEW sensitive_access_statistics IS 'operator-owned statistics';CREATE VIEW operator_sensitive_view AS SELECT * FROM sensitive_access_statistics");
 await t.test('rerun retains actual ciphertext/tag/IV/wrapped keys, serial audit identity, dependent views and operator comments',async()=>{
  const state=await snapshot(pool),rows=(await pool.query('SELECT to_jsonb(r)::text AS row FROM audit_logs r ORDER BY id')).rows;await apply(pool,repair);assert.deepEqual(await snapshot(pool),state);assert.deepEqual((await pool.query('SELECT to_jsonb(r)::text AS row FROM audit_logs r ORDER BY id')).rows,rows);
  const row=(await pool.query("SELECT * FROM audit_logs WHERE action='actual-cipher-history'")).rows[0];assert.deepEqual(row.encrypted_data,encrypted);assert.equal(row.encryption_auth_tag,tag.toString('hex'));const decryptor=crypto.createDecipheriv('aes-256-gcm',workKey,iv);decryptor.setAuthTag(Buffer.from(row.encryption_auth_tag,'hex'));assert.deepEqual(Buffer.concat([decryptor.update(row.encrypted_data),decryptor.final()]),plain);
  assert.equal((await pool.query("SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='audit_logs'::regclass AND attname='id'")).rows[0].type,'bigint');assert.equal((await pool.query('SELECT * FROM operator_sensitive_view')).rowCount,0);
 });
 await t.test('both known cleanup entry points use invoker rights, pinned relation scope and no PUBLIC execute grant',async()=>{
  const rows=(await pool.query("SELECT p.oid,p.prosrc,p.prosecdef,p.proconfig FROM pg_proc p WHERE pronamespace=current_schema()::regnamespace AND proname IN('cleanup_expired_sensitive_logs','cleanup_expired_sensitive_access_logs') ORDER BY proname")).rows;assert.equal(rows.length,2);
  for(const row of rows){assert.equal(row.prosecdef,false);assert.deepEqual(row.proconfig,['search_path=pg_catalog']);assert.ok(row.prosrc.includes(schema+'.sensitive_data_access_logs'));assert.ok(!row.prosrc.includes(outside));const acl=(await pool.query("SELECT count(*)::int AS n FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1 AND a.grantee=0 AND a.privilege_type='EXECUTE'",[row.oid])).rows[0];assert.equal(acl.n,0);}
 });
 await t.test('a real read-only role cannot execute publicly or acquire owner DELETE rights through either function',async()=>{
  const role='audit_reader_'+crypto.randomBytes(8).toString('hex');await pool.query(`CREATE ROLE ${role} NOLOGIN`);const client=await pool.connect();
  const invoke=async name=>{await client.query('BEGIN');try{await client.query(`SET LOCAL ROLE ${role}`);return await client.query(`SELECT ${schema}.${name}()`);}finally{await client.query('ROLLBACK');}};
  try{
   await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};GRANT SELECT ON audit_logs,sensitive_data_access_logs TO ${role}`);
   for(const name of ['cleanup_expired_sensitive_logs','cleanup_expired_sensitive_access_logs']){
    await assert.rejects(invoke(name),{code:'42501'});
    await pool.query(`GRANT EXECUTE ON FUNCTION ${name}() TO ${role}`);await assert.rejects(invoke(name),{code:'42501'});
   }
  }finally{
   client.release();await pool.query(`REVOKE EXECUTE ON FUNCTION cleanup_expired_sensitive_logs(),cleanup_expired_sensitive_access_logs() FROM ${role};REVOKE SELECT ON audit_logs,sensitive_data_access_logs FROM ${role};REVOKE USAGE ON SCHEMA ${schema} FROM ${role};DROP ROLE ${role}`);
  }
 });
 await t.test('actual root CLI up/up/verify retains raw and executed checksums',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'minego-sensitive-cli-'));
  try{const original=await read('database/pending/'+filename);await fs.mkdir(path.join(dir,'repairs'));await fs.writeFile(path.join(dir,filename),original);await fs.writeFile(path.join(dir,'repairs',filename),repair);const manifest=JSON.parse(await read('database/pending/repairs.json'));await fs.writeFile(path.join(dir,'repairs.json'),JSON.stringify({schemaVersion:1,repairs:{'20260608_200000':manifest.repairs['20260608_200000']}}));const cli=command=>promisify(execFile)(process.execPath,[path.join(root,'database/migrate.js'),command],{env:{...process.env,DATABASE_URL:url,MINEGO_MIGRATIONS_DIR:dir},timeout:30000});await cli('up');const row=(await pool.query('SELECT checksum,execution_checksum FROM schema_migrations')).rows[0];assert.equal(row.checksum,hash(original));assert.equal(row.execution_checksum,hash(JSON.stringify({up:repair.trim(),down:''})));const state=await snapshot(pool);await cli('up');await cli('verify');assert.deepEqual(await snapshot(pool),state);}finally{await fs.rm(dir,{recursive:true,force:true});}
 });
}));

test('unknown audit encryption/function/view contracts refuse atomically',async t=>{
 for(const [name,sql,pattern,first=false]of [
  ['wrong historical timestamp type','ALTER TABLE audit_logs ADD COLUMN timestamp integer',/Sensitive audit column/],
  ['wrong encryption tag type','ALTER TABLE audit_logs ADD COLUMN encryption_auth_tag integer',/Sensitive audit column/],
  ['custom cleanup function',"CREATE FUNCTION cleanup_expired_sensitive_logs() RETURNS void LANGUAGE plpgsql AS $$BEGIN RAISE NOTICE 'operator-defined';END;$$",/Customized sensitive-log cleanup/],
  ['removed pinned search path','ALTER FUNCTION cleanup_expired_sensitive_logs() RESET search_path',/Customized sensitive-log cleanup/,true],
  ['custom older cleanup function',"CREATE OR REPLACE FUNCTION cleanup_expired_sensitive_access_logs() RETURNS void LANGUAGE plpgsql AS $$BEGIN RAISE NOTICE 'operator-defined';END;$$",/Customized sensitive-access cleanup/],
 ]){
  await t.test(name,async()=>fixture(async({pool,repair})=>{if(first)await apply(pool,repair);await pool.query(sql);const state=await snapshot(pool);await assert.rejects(apply(pool,repair),pattern);assert.deepEqual(await snapshot(pool),state);}));
 }
 await t.test('custom statistics definition stays intact and requires explicit adoption',async()=>fixture(async({pool,repair})=>{
  await apply(pool,repair);const definition=(await pool.query("SELECT pg_get_viewdef('sensitive_access_statistics'::regclass,true) AS definition")).rows[0].definition;await pool.query('CREATE OR REPLACE VIEW sensitive_access_statistics AS '+definition.replace('WHERE','WHERE false AND'));const state=await snapshot(pool);await assert.rejects(apply(pool,repair),/Customized sensitive statistics/);assert.deepEqual(await snapshot(pool),state);
 }));
 await t.test('a genuine timezone-bearing historical creation instant can supply the new event timestamp',async()=>fixture(async({pool,repair})=>{
  await pool.query("ALTER TABLE audit_logs ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';INSERT INTO audit_logs(action,created_at) VALUES('known-instant','2020-03-01T12:00:00Z')");await apply(pool,repair);const row=(await pool.query("SELECT timestamp FROM audit_logs WHERE action='known-instant'")).rows[0];assert.equal(row.timestamp.toISOString(),'2020-03-01T12:00:00.000Z');
 }));

});
