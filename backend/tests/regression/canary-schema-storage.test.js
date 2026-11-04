'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const {Pool}=require('pg');
const {migrationStatements}=require('../../../database/sqlStatements');
const root=path.resolve(__dirname,'../../..');
const filename='20260701_110000__add_canary_deployment_tables.sql';
const read=f=>fs.readFile(path.join(root,f),'utf8');
const raw=()=>read('database/pending/'+filename);
const repair=()=>read('database/pending/repairs/'+filename);
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function apply(pool,source){
  const c=await pool.connect();
  try{await c.query('BEGIN');for(const sql of migrationStatements(source))await c.query(sql);await c.query('COMMIT');}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function fixture(fn,{earlier=true}={}){
  assert.ok(process.env.TEST_DATABASE_URL,'owned isolated PostGIS database required');
  const schema='canary_schema_'+crypto.randomBytes(8).toString('hex');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await admin.query('CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:2,options:`-c search_path=${schema},public`});
  try{
    await pool.query(await read('database/migrations/V1__initial_schema.sql'));
    await pool.query(await read('database/seeds/V2__seed_data.sql'));
    if(earlier){
      await apply(pool,await read('database/pending/repairs/20260611_102500__add_canary_deployment_tables.sql'));
      await pool.query("INSERT INTO canary_deployments(service_name,canary_version,stable_version,traffic_split,strategy,rules,auto_promote,metrics_baseline,status,started_at,updated_at,created_by) VALUES('catch-service','canary-actual','stable-actual',25,'manual',$1,false,$2,'promoting','2024-01-02','2024-01-03',77),('catch-service','old','older',100,'progressive','{}',false,'{}','completed','2023-01-01','2023-01-02',88)",[{regions:['saved-region']},{errorRate:0.012}]);
      await pool.query("INSERT INTO canary_deployment_history(deployment_id,action,details,created_at) SELECT id,'retained',$1,'2024-01-03' FROM canary_deployments",[{ticket:'historical'}]);
      await pool.query("INSERT INTO canary_metrics_snapshots(deployment_id,metrics,created_at) SELECT id,$1,'2024-01-03' FROM canary_deployments",[{errorRate:0.02,latencyP95:891,successRate:0.98}]);
      await pool.query('CREATE VIEW retained_canary_history AS SELECT id,status,rules FROM canary_deployments');
      await pool.query('CREATE TABLE retained_canary_reference(id integer REFERENCES canary_deployments(id))');
      await pool.query('INSERT INTO retained_canary_reference SELECT id FROM canary_deployments');
      await pool.query("COMMENT ON TABLE canary_deployments IS 'Operator rollout history'; COMMENT ON COLUMN canary_deployments.strategy IS 'Operator strategy'");
    }
    await fn({pool,schema});
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function snapshot(pool){
  const objects=(await pool.query("SELECT relname,oid,obj_description(oid,'pg_class') AS note FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY relname")).rows;
  const rows={};
  for(const obj of objects){
    const name=obj.relname;
    if(['canary_deployments','canary_deployment_history','canary_metrics_snapshots','canary_request_logs'].includes(name))rows[name]=(await pool.query(`SELECT to_jsonb(r)::text AS row FROM ${name} r ORDER BY id`)).rows;
    if(name.endsWith('_id_seq'))rows[name]=(await pool.query(`SELECT last_value,is_called FROM ${name}`)).rows;
  }
  return {objects,rows,
    constraints:(await pool.query('SELECT oid,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=current_schema()::regnamespace ORDER BY oid')).rows,
    indexes:(await pool.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() ORDER BY indexname')).rows,
    functions:(await pool.query('SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY oid')).rows,
    triggers:(await pool.query('SELECT t.oid,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY t.oid')).rows};
}
const insert=(pool,service,status='active')=>pool.query("INSERT INTO canary_deployments(service_name,canary_version,stable_version,status) VALUES($1,'new','stable',$2) RETURNING *",[service,status]);

test('repeated canary proposal reconciles with authentic earlier rollout storage',async t=>fixture(async({pool,schema})=>{
  const before=await snapshot(pool);
  await t.test('original inline partial uniqueness fails syntax and leaves historical objects untouched',async()=>{
    await assert.rejects(apply(pool,await raw()),{code:'42601'});assert.deepEqual(await snapshot(pool),before);
  });
  await apply(pool,await repair());
  await t.test('old IDs/data/history/views/FKs/sequences/comments/indexes survive; unknown creation stays NULL',async()=>{
    const after=await snapshot(pool);
    for(const obj of before.objects)assert.deepEqual(after.objects.find(x=>x.relname===obj.relname),obj);
    for(const [table,rows]of Object.entries(before.rows)){
      const actual=after.rows[table];
      if(table==='canary_deployments')assert.deepEqual(actual.map(x=>JSON.parse(x.row)).map(({created_at,...r})=>r),rows.map(x=>JSON.parse(x.row)));
      else assert.deepEqual(actual,rows);
    }
    for(const item of before.constraints)assert.deepEqual(after.constraints.find(x=>x.oid===item.oid),item);
    for(const item of before.indexes)assert.deepEqual(after.indexes.find(x=>x.indexname===item.indexname),item);
    assert.equal((await pool.query('SELECT * FROM retained_canary_history')).rowCount,2);
    assert.equal((await pool.query('SELECT * FROM retained_canary_reference')).rowCount,2);
    assert.equal((await pool.query('SELECT created_at FROM canary_deployments WHERE created_at IS NULL')).rowCount,2);
    assert.equal((await pool.query("SELECT col_description('canary_deployments'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='canary_deployments'::regclass AND attname='strategy')) AS note")).rows[0].note,'Operator strategy');
  });
  await t.test('new rows have actual creation time; updater changes only updated_at and preserves all decisions',async()=>{
    const row=(await insert(pool,'user-service')).rows[0];assert.ok(row.created_at instanceof Date);
    await pool.query("UPDATE canary_deployments SET updated_at='2000-01-01',traffic_split=50 WHERE id=$1",[row.id]);
    const updated=(await pool.query('SELECT * FROM canary_deployments WHERE id=$1',[row.id])).rows[0];
    assert.equal(updated.created_at.toISOString(),row.created_at.toISOString());assert.equal(updated.traffic_split,50);assert.ok(updated.updated_at.getUTCFullYear()>2000);
    const saved=(await pool.query('SELECT * FROM canary_deployments WHERE id=1')).rows[0];assert.deepEqual(saved.rules,{regions:['saved-region']});assert.equal(saved.auto_promote,false);assert.equal(saved.created_by,77);
  });
  await t.test('actual two-caller active/promoting race allows exactly one rollout for a service',async()=>{
    const results=await Promise.allSettled([insert(pool,'race-service','active'),insert(pool,'race-service','promoting')]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'23505');
    await pool.query("UPDATE canary_deployments SET status='completed' WHERE service_name='race-service'");
    await insert(pool,'race-service','completed');await insert(pool,'race-service','active');
    assert.equal((await pool.query("SELECT * FROM canary_deployments WHERE service_name='race-service'")).rowCount,3);
  });
  await t.test('request logs enforce the actual parent FK and retain actual status/latency values',async()=>{
    await assert.rejects(pool.query('INSERT INTO canary_request_logs(deployment_id,status_code,latency_ms) VALUES(2147483647,200,37)'),{code:'23503'});
    await pool.query('INSERT INTO canary_request_logs(deployment_id,status_code,latency_ms) VALUES(1,200,37),(1,503,1200)');
    assert.deepEqual((await pool.query('SELECT status_code,latency_ms FROM canary_request_logs ORDER BY id')).rows,[{status_code:200,latency_ms:37},{status_code:503,latency_ms:1200}]);
    const row=(await insert(pool,'delete-only-fixture','completed')).rows[0];
    await pool.query('INSERT INTO canary_request_logs(deployment_id,status_code,latency_ms) VALUES($1,200,2)',[row.id]);await pool.query('DELETE FROM canary_deployments WHERE id=$1',[row.id]);
    assert.equal((await pool.query('SELECT * FROM canary_request_logs WHERE deployment_id=$1',[row.id])).rowCount,0);
  });
  await t.test('rerun preserves every row/sequence/function/trigger/OID and existing creation-time default',async()=>{
    await pool.query("ALTER TABLE canary_deployments ALTER COLUMN created_at SET DEFAULT '2020-01-01'::timestamp");
    const state=await snapshot(pool);await apply(pool,await repair());assert.deepEqual(await snapshot(pool),state);
    assert.match((await pool.query("SELECT pg_get_expr(adbin,adrelid) AS value FROM pg_attrdef WHERE adrelid='canary_deployments'::regclass AND adnum=(SELECT attnum FROM pg_attribute WHERE attrelid='canary_deployments'::regclass AND attname='created_at')")).rows[0].value,/2020-01-01/);
  });
  await t.test('genuine CLI journals immutable raw and executed repair hashes separately; up/verify rerun preserve history',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'minego-canary-cli-'));
    try{
      const original=await raw(),fixed=await repair();await fs.mkdir(path.join(dir,'repairs'));await fs.writeFile(path.join(dir,filename),original);await fs.writeFile(path.join(dir,'repairs',filename),fixed);
      const manifest=JSON.parse(await read('database/pending/repairs.json'));await fs.writeFile(path.join(dir,'repairs.json'),JSON.stringify({schemaVersion:1,repairs:{'20260701_110000':manifest.repairs['20260701_110000']}}));
      const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
      const cli=command=>promisify(execFile)(process.execPath,[path.join(root,'database/migrate.js'),command],{env:{...process.env,DATABASE_URL:url.toString(),MINEGO_MIGRATIONS_DIR:dir},timeout:15000});
      await cli('up');const row=(await pool.query('SELECT checksum,execution_checksum FROM schema_migrations')).rows[0];assert.equal(row.checksum,hash(original));assert.equal(row.execution_checksum,hash(JSON.stringify({up:fixed.trim(),down:''})));
      const state=await snapshot(pool);await cli('up');await cli('verify');assert.deepEqual(await snapshot(pool),state);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
}));

test('fresh canary proposal provisions all four real tables without an earlier rollout',async()=>fixture(async({pool})=>{
  await apply(pool,await repair());assert.equal((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'canary_%'")).rowCount,4);
  const row=(await insert(pool,'fresh-service')).rows[0];assert.ok(row.created_at instanceof Date);await apply(pool,await repair());
},{earlier:false}));

test('unknown canary contracts refuse atomically without discarding rollout history',async t=>{
  for(const [label,first,sql,pattern]of [
    ['wrong request parent type',false,'CREATE TABLE canary_request_logs(id serial PRIMARY KEY,deployment_id uuid)',/canary_request_logs.deployment_id requires explicit/],
    ['preexisting conflicting active/promoting history',false,"INSERT INTO canary_deployments(service_name,canary_version,stable_version,status) VALUES('catch-service','third','stable','active')",/Multiple active canaries/],
    ['missing request-log FK',true,'ALTER TABLE canary_request_logs DROP CONSTRAINT canary_request_logs_deployment_id_fkey',/canary_request_logs reference/],
    ['disabled update trigger',true,'ALTER TABLE canary_deployments DISABLE TRIGGER trigger_update_canary_deployments_updated_at',/Customized canary timestamp trigger/],
    ['custom update function',true,'CREATE OR REPLACE FUNCTION update_canary_deployments_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$',/Customized canary timestamp function/],
    ['lost partial predicate',true,"UPDATE canary_deployments SET service_name=service_name||'-'||id; DROP INDEX canary_one_active_service; CREATE UNIQUE INDEX canary_one_active_service ON canary_deployments(service_name)",/Canary active-service index/],
    ['wrong active-service index',true,"DROP INDEX canary_one_active_service; CREATE UNIQUE INDEX canary_one_active_service ON canary_deployments(service_name,status) WHERE status='active'",/Canary active-service index/]
  ])await t.test(label,async()=>fixture(async({pool})=>{
    if(first)await apply(pool,await repair());await pool.query(sql);const state=await snapshot(pool);
    await assert.rejects(apply(pool,await repair()),pattern);assert.deepEqual(await snapshot(pool),state);
  }));
});

test('actual canary manager/database, API and metric consumers expose concrete integration boundaries',async()=>fixture(async({pool,schema})=>{
  await apply(pool,await repair());
  const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
  const script=`
    const assert=require('node:assert/strict');
    const db=require('./backend/shared/db');
    const {canaryManager}=require('./backend/shared/canaryManager');
    (async()=>{
      try{
        db.getPoolManagerInstance().getPool('default',{max:2,min:1});
        const active=await canaryManager.getAllActive();assert.equal(active.length,1);assert.equal(active[0].status,'promoting');
        const empty=await canaryManager.collectMetrics(1);assert.equal(empty.errorRate,0);assert.equal(empty.latencyP95,0);assert.equal(empty.successRate,1);
        await db.query('INSERT INTO canary_request_logs(deployment_id,status_code,latency_ms) VALUES(1,503,1500)');
        const errors=await canaryManager.collectMetrics(1);assert.equal(errors.errorRate,1);assert.equal(errors.latencyP95,1500);assert.equal(errors.successRate,1);
        await assert.rejects(canaryManager.createCanaryDeployment({serviceName:'runtime-service',canaryVersion:'new',stableVersion:'old'}),/publish is not a function/);
        assert.equal((await db.query("SELECT * FROM canary_deployments WHERE service_name='runtime-service'")).rowCount,1);
        assert.equal((await db.query("SELECT h.* FROM canary_deployment_history h JOIN canary_deployments d ON d.id=h.deployment_id WHERE d.service_name='runtime-service' AND h.action='created'")).rowCount,1);
        assert.throws(()=>require('./backend/gateway/src/routes/canary'),/handler|callback/i);
        assert.throws(()=>require('./backend/shared/canaryMetrics').recordCanaryRequest('fixture-service','new',200,37),/increment is not a function/);
        process.stdout.write('ACTUAL_CANARY_BOUNDARIES_CONFIRMED\\n');
      }finally{await db.closePools();}
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const result=await promisify(execFile)(process.execPath,['-e',script],{cwd:root,env:{...process.env,DATABASE_URL:url.toString(),SERVICE_NAME:'default',DB_SSL:'false'},timeout:15000});
  assert.match(result.stdout,/ACTUAL_CANARY_BOUNDARIES_CONFIRMED/);
}));
