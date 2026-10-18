'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {promisify}=require('node:util');const {execFile}=require('node:child_process');const {Pool}=require('pg');
const {migrationStatements}=require('../../../database/sqlStatements');
const GDPRService=require('../../services/user-service/src/gdprService');
const root=path.resolve(__dirname,'../../..'),filename='20260630_050000__add_data_deletion_request_tables.sql';
const read=f=>fs.readFile(path.join(root,f),'utf8');const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const raw=()=>read('database/pending/'+filename),repair=()=>read('database/pending/repairs/'+filename);
async function apply(pool,source){const c=await pool.connect();try{await c.query('BEGIN');for(const sql of migrationStatements(source))await c.query(sql);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function fixture(fn){
  assert.ok(process.env.TEST_DATABASE_URL,'isolated PostGIS required');const schema='erasure_schema_'+crypto.randomBytes(8).toString('hex');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');await admin.query('CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:2,options:`-c search_path=${schema},public`});const owner=crypto.randomUUID(),other=crypto.randomUUID();
  try{
    await pool.query(await read('database/migrations/V1__initial_schema.sql'));await pool.query(await read('database/seeds/V2__seed_data.sql'));
    await pool.query("INSERT INTO users(id,nickname) VALUES($1,'erasure-owner'),($2,'erasure-other')",[owner,other]);
    // Apply authentic legacy tracking DDL without unrelated retention/cleanup behavior.
    const legacy=migrationStatements(await read('database/pending/20260605_161000__add_gdpr_tables.sql'));
    await pool.query(legacy.find(sql=>/CREATE TABLE IF NOT EXISTS data_deletion_requests\b/.test(sql)));
    await pool.query(legacy.find(sql=>/CREATE INDEX IF NOT EXISTS idx_deletion_requests_status\b/.test(sql)));
    await pool.query("INSERT INTO data_deletion_requests(user_id,status,requested_at,completed_at,error_message,confirmation_token) VALUES(77,'failed','2024-01-02',NULL,'old error','old token'),(88,'completed','2024-02-03','2024-02-04',NULL,'older token')");
    await pool.query('CREATE VIEW retained_deletion_history AS SELECT * FROM data_deletion_requests');
    await pool.query('CREATE TABLE retained_deletion_reference(id integer REFERENCES data_deletion_requests(id))');await pool.query('INSERT INTO retained_deletion_reference SELECT id FROM data_deletion_requests');
    await pool.query("CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$");
    await fn({pool,schema,owner,other});
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
const legacyState=async p=>({rows:(await p.query('SELECT to_jsonb(r)::text AS row FROM data_deletion_requests r ORDER BY id')).rows,sequence:(await p.query('SELECT * FROM data_deletion_requests_id_seq')).rows,objects:(await p.query("SELECT relname,oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname IN('data_deletion_requests','data_deletion_requests_id_seq','retained_deletion_history','retained_deletion_reference','idx_deletion_requests_status') ORDER BY oid")).rows,keys:(await p.query("SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN('data_deletion_requests'::regclass,'retained_deletion_reference'::regclass) ORDER BY oid")).rows,sharedFunction:(await p.query("SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid='update_updated_at_column()'::regprocedure")).rows});
const create=async(pool,owner)=> (await pool.query("INSERT INTO data_erasure_requests(user_id,live_user_id,request_type,verification_digest,verification_expires_at) VALUES($1,$1,'full',digest('owned-fixture-code','sha256'),NOW()+INTERVAL '1 day') RETURNING id",[owner])).rows[0].id;
async function complete(pool,id){await pool.query("UPDATE data_erasure_requests SET verified_at=NOW(),approval_status='auto_approved',approved_at=NOW(),execute_after=NOW(),processing_completed_at=NOW(),status='completed' WHERE id=$1",[id]);}
const keys=crypto.generateKeyPairSync('ed25519');
async function certificate(pool,id,owner,{count=3,categories=['pokemon'],categoryTotals=null,payloadOwner=owner,algorithm='Ed25519'}={}){
  const payload=JSON.stringify({requestId:id,userId:payloadOwner,totalRecords:String(count),categories:categoryTotals||Object.fromEntries(categories.map(c=>[c,String(count)])),completedAt:new Date().toISOString()});
  const signature=crypto.sign(null,Buffer.from(payload),keys.privateKey).toString('hex');
  return pool.query("INSERT INTO data_erasure_certificates(request_id,user_id,certificate_number,deletion_summary,signed_payload,payload_digest,deleted_data_categories,total_records_deleted,signature,signature_algorithm,signing_key_id,retention_until) VALUES($1,$2,$3,$4::text::jsonb,$4::text,digest($4::text,'sha256'),$5,$6,$7,$8,'owned-fixture-key',NOW()+INTERVAL '7 years') RETURNING *",[id,owner,'test-'+crypto.randomUUID(),payload,categories,count,signature,algorithm]);
}

test('distinct UUID erasure workflow preserves authentic SERIAL/numeric-owner request history',async t=>fixture(async({pool,owner,other,schema})=>{
  const before=await legacyState(pool);
  await t.test('original fails its UUID child reference and rolls back all attempted workflow objects',async()=>{
    await assert.rejects(apply(pool,await raw()),{code:'42804'});assert.deepEqual(await legacyState(pool),before);
    assert.equal((await pool.query("SELECT to_regclass('data_deletion_tasks') AS name")).rows[0].name,null);
  });
  await t.test('actual legacy GDPR requests fail against canonical UUID users rather than providing a working deletion API',async()=>{
    const service=new GDPRService(pool);
    await assert.rejects(service.requestDataDeletion(owner),{code:'22P02'});await assert.rejects(service.exportUserData(owner),{code:'42703'});assert.deepEqual(await legacyState(pool),before);
  });
  await apply(pool,await repair());
  await t.test('five UUID tables coexist without rewriting IDs, owners, history, views, FKs, sequence or shared function',async()=>{
    assert.deepEqual(await legacyState(pool),before);
    for(const table of ['requests','tasks','certificates','categories','approval_history'])assert.ok((await pool.query('SELECT to_regclass($1) AS name',['data_erasure_'+table])).rows[0].name);
    assert.equal((await pool.query('SELECT * FROM retained_deletion_reference')).rowCount,2);
    assert.equal((await pool.query('SELECT * FROM data_erasure_requests')).rowCount,0,'No unverifiable historical promotion');
  });
  await t.test('all8 category proposals remain configuration, without executable SQL templates or fake review',async()=>{
    const rows=(await pool.query('SELECT * FROM data_erasure_categories ORDER BY category_code')).rows;assert.equal(rows.length,8);
    assert.equal(rows.find(r=>r.category_code==='transaction').proposed_retention_days,2555);assert.deepEqual(rows.find(r=>r.category_code==='pokemon').declared_tables,['user_pokemon','pokemon_stats']);
    assert.ok(rows.every(r=>r.policy_reference===null&&r.resource_plan_version===null));
    const names=(await pool.query("SELECT attname FROM pg_attribute WHERE attrelid='data_erasure_tasks'::regclass AND NOT attisdropped")).rows.map(r=>r.attname);assert.equal(names.includes('query_template'),false);
    const requestNames=(await pool.query("SELECT attname FROM pg_attribute WHERE attrelid='data_erasure_requests'::regclass AND NOT attisdropped")).rows.map(r=>r.attname);assert.equal(requestNames.includes('verification_code'),false);assert.ok(requestNames.includes('verification_digest'));
  });
  const request=await create(pool,owner);
  await t.test('new subjects require actual live UUID owners and cannot be silently detached or reassigned',async()=>{
    await assert.rejects(pool.query("INSERT INTO data_erasure_requests(user_id,live_user_id,request_type) VALUES($1,$2,'full')",[crypto.randomUUID(),other]),/live subject/);
    await assert.rejects(pool.query("INSERT INTO data_erasure_requests(user_id,request_type) VALUES($1,'full')",[other]),/live subject/);
    await assert.rejects(pool.query("INSERT INTO data_erasure_requests(user_id,live_user_id,request_type) VALUES($1,$1,'full')",[crypto.randomUUID()]),{code:'23503'});
    await assert.rejects(pool.query('UPDATE data_erasure_requests SET user_id=$1 WHERE id=$2',[other,request]),/immutable/);
    await assert.rejects(pool.query('UPDATE data_erasure_requests SET live_user_id=NULL WHERE id=$1',[request]),/detach only/);
    await assert.rejects(pool.query('UPDATE data_erasure_requests SET live_user_id=$1 WHERE id=$2',[other,request]),/reassigned/);
    await assert.rejects(create(pool,owner),{code:'23505'});
  });
  await t.test('unverified states and incomplete task accounting cannot assert completion',async()=>{
    await assert.rejects(pool.query("UPDATE data_erasure_requests SET status='completed' WHERE id=$1",[request]),{code:'23514'});
    await assert.rejects(certificate(pool,request,owner),/requires completed/);
    await assert.rejects(pool.query("INSERT INTO data_erasure_tasks(request_id,task_name,service_name,data_category,resource_code,plan_version,status) VALUES($1,'owned','pokemon-service','pokemon','pokemon_instances','fixture-v1','completed')",[request]),{code:'23514'});
  });
  await pool.query('INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) SELECT $1,25,100,10,10,1,2,3 FROM generate_series(1,3)',[owner]);
  await pool.query('INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) VALUES($1,25,200,20,20,4,5,6)',[other]);
  const removed=await pool.query('DELETE FROM pokemon_instances WHERE user_id=$1 RETURNING id',[owner]);assert.equal(removed.rowCount,3);
  assert.equal((await pool.query('SELECT id FROM pokemon_instances WHERE user_id=$1',[other])).rowCount,1);
  await pool.query("INSERT INTO data_erasure_tasks(request_id,task_name,service_name,data_category,resource_code,plan_version,status,affected_rows,completed_at) VALUES($1,'owned','pokemon-service','pokemon','pokemon_instances','fixture-v1','completed',$2,NOW())",[request,removed.rowCount]);
  await complete(pool,request);
  await t.test('wrong subjects, counts, categories, signature claims and unfinished work cannot receive a receipt',async()=>{
    await assert.rejects(certificate(pool,request,other),{code:'23503'});
    await assert.rejects(certificate(pool,request,owner,{count:4}),/requires completed/);
    await assert.rejects(certificate(pool,request,owner,{categories:['profile']}),/requires completed/);
    await assert.rejects(certificate(pool,request,owner,{categoryTotals:{pokemon:'4'}}),/requires completed/);
    await assert.rejects(certificate(pool,request,owner,{payloadOwner:other}),{code:'23514'});
    await assert.rejects(certificate(pool,request,owner,{algorithm:'SHA256-HMAC'}),{code:'23514'});
    await pool.query("INSERT INTO data_erasure_tasks(request_id,task_name,service_name,data_category,resource_code,plan_version) VALUES($1,'pending','user-service','profile','users','fixture-v1')",[request]);
    await assert.rejects(certificate(pool,request,owner),/requires completed/);
    await pool.query("DELETE FROM data_erasure_tasks WHERE request_id=$1 AND resource_code='users'",[request]);
  });
  await t.test('actual signed payload survives account removal with tasks/history and matching subject identity intact',async()=>{
    await pool.query("INSERT INTO data_erasure_approval_history(request_id,action,actor_id,actor_type) VALUES($1,'approved',$2,'admin')",[request,other]);
    const receipt=(await certificate(pool,request,owner)).rows[0];assert.equal(crypto.verify(null,Buffer.from(receipt.signed_payload),keys.publicKey,Buffer.from(receipt.signature,'hex')),true);
    assert.equal(hash(receipt.signed_payload),receipt.payload_digest.toString('hex'));
    await pool.query('DELETE FROM users WHERE id=$1',[owner]);const row=(await pool.query('SELECT user_id,live_user_id FROM data_erasure_requests WHERE id=$1',[request])).rows[0];assert.deepEqual(row,{user_id:owner,live_user_id:null});
    assert.equal((await pool.query('SELECT * FROM data_erasure_tasks WHERE request_id=$1',[request])).rowCount,1);assert.equal((await pool.query('SELECT * FROM data_erasure_approval_history WHERE request_id=$1',[request])).rowCount,1);
    const retained=(await pool.query('SELECT signed_payload,signature FROM data_erasure_certificates WHERE request_id=$1',[request])).rows[0];assert.equal(retained.signature,receipt.signature);assert.equal(retained.signed_payload,receipt.signed_payload);assert.equal(crypto.verify(null,Buffer.from(retained.signed_payload),keys.publicKey,Buffer.from(retained.signature,'hex')),true);
    await assert.rejects(pool.query('DELETE FROM data_erasure_requests WHERE id=$1',[request]),{code:'23503'});assert.deepEqual(await legacyState(pool),before);
  });
  await t.test('rerun preserves category choices, request/receipt rows, function OIDs and trigger definitions',async()=>{
    await pool.query("UPDATE data_erasure_categories SET policy_reference='operator policy',proposed_retention_days=37 WHERE category_code='location'");
    const state=async()=>({rows:(await pool.query('SELECT to_jsonb(t)::text AS row FROM data_erasure_categories t ORDER BY category_code')).rows,requests:(await pool.query('SELECT to_jsonb(t)::text AS row FROM data_erasure_requests t ORDER BY id')).rows,receipts:(await pool.query('SELECT to_jsonb(t)::text AS row FROM data_erasure_certificates t ORDER BY id')).rows,functions:(await pool.query("SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'data_erasure_%' ORDER BY oid")).rows,triggers:(await pool.query("SELECT t.oid,tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY t.oid")).rows});
    const current=await state();await apply(pool,await repair());assert.deepEqual(await state(),current);assert.deepEqual(await legacyState(pool),before);
  });
  await t.test('actual CLI journals raw source separately and preserves request history on rerun',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'minego-erasure-history-'));
    try{
      await fs.mkdir(path.join(dir,'repairs'));const original=await raw(),fixed=await repair();await fs.writeFile(path.join(dir,filename),original);await fs.writeFile(path.join(dir,'repairs',filename),fixed);
      const manifest=JSON.parse(await read('database/pending/repairs.json'));await fs.writeFile(path.join(dir,'repairs.json'),JSON.stringify({schemaVersion:1,repairs:{'20260630_050000':manifest.repairs['20260630_050000']}}));
      const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);const cli=command=>promisify(execFile)(process.execPath,[path.join(root,'database/migrate.js'),command],{env:{...process.env,DATABASE_URL:url.toString(),MINEGO_MIGRATIONS_DIR:dir},timeout:15000});
      await cli('up');await cli('up');await cli('verify');const row=(await pool.query('SELECT checksum,execution_checksum FROM schema_migrations')).rows[0];assert.equal(row.checksum,hash(original));assert.equal(row.execution_checksum,hash(JSON.stringify({up:fixed.trim(),down:''})));assert.deepEqual(await legacyState(pool),before);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
}));

test('existing unknown UUID workflows and customized owned contracts require explicit adoption',async t=>{
  for(const [label,sql,pattern,existing=false]of [
    ['different UUID request namespace','DROP VIEW retained_deletion_history; DROP TABLE retained_deletion_reference; DROP TABLE data_deletion_requests; CREATE TABLE data_deletion_requests(id uuid PRIMARY KEY,user_id uuid); INSERT INTO data_deletion_requests VALUES(gen_random_uuid(),gen_random_uuid())',/Existing UUID deletion workflow/],
    ['unknown new subject schema','CREATE TABLE data_erasure_requests(id serial PRIMARY KEY,user_id integer,status varchar(20),execute_after timestamptz,created_at timestamptz)',/Erasure .* schema|column .* does not exist/],
    ['missing live-owner FK','ALTER TABLE data_erasure_requests DROP CONSTRAINT data_erasure_requests_live_user_id_fkey',/reference contract/,true],
    ['disabled subject binding','ALTER TABLE data_erasure_requests DISABLE TRIGGER erasure_bind_subject',/Customized erasure trigger/,true],
    ['changed active-request index','DROP INDEX erasure_one_active_request_per_subject; CREATE INDEX erasure_one_active_request_per_subject ON data_erasure_requests(user_id)',/active request index/,true],
    ['custom owned function',"CREATE FUNCTION data_erasure_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$",/Customized erasure function/]
  ])await t.test(label,async()=>fixture(async({pool})=>{
    if(existing)await apply(pool,await repair());
    await pool.query(sql);const triggerState=(await pool.query('SELECT t.oid,tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY t.oid')).rows;const objects=(await pool.query('SELECT oid,relname FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY oid')).rows;
    const functions=(await pool.query('SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY oid')).rows;
    const legacy=(await pool.query('SELECT to_jsonb(t)::text AS row FROM data_deletion_requests t ORDER BY to_jsonb(t)::text')).rows;
    await assert.rejects(apply(pool,await repair()),pattern);assert.deepEqual((await pool.query('SELECT oid,relname FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY oid')).rows,objects);assert.deepEqual((await pool.query('SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY oid')).rows,functions);assert.deepEqual((await pool.query('SELECT to_jsonb(t)::text AS row FROM data_deletion_requests t ORDER BY to_jsonb(t)::text')).rows,legacy);assert.deepEqual((await pool.query('SELECT t.oid,tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY t.oid')).rows,triggerState);
  }));
});
