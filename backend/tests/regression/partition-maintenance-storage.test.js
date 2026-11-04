'use strict';
process.env.JWT_ACCESS_SECRET='partition-local-fixture-only';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {promisify}=require('node:util');const {execFile}=require('node:child_process');
const {Pool}=require('pg');const {Registry}=require('prom-client');const express=require('express');const jwt=require('jsonwebtoken');
const {migrationStatements}=require('../../../database/sqlStatements');const {parseMigrationFile}=require('../../../database/migrate');
const {PartitionMaintenance,TABLES}=require('../../shared/partitionMaintenance');
const {createPartitionRouter}=require('../../gateway/src/routes/partitions');const {errorHandler}=require('../../shared/auth');
const root=path.resolve(__dirname,'../../..'),filename='20260707_060000__complete_partition_management.sql';
const read=f=>fs.readFile(path.join(root,f),'utf8');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function apply(pool,source){const client=await pool.connect();try{await client.query('BEGIN');for(const sql of migrationStatements(parseMigrationFile(source).up))await client.query(sql);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
async function fixture(fn){
  assert.ok(process.env.TEST_DATABASE_URL,'owned isolated PostGIS database required');
  const schema='part_maint_'+crypto.randomBytes(8).toString('hex'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');await admin.query('CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:2,options:`-c search_path=${schema},public`});
  const manager=new PartitionMaintenance({database:pool,registry:new Registry()});
  try{
    await pool.query(await read('database/migrations/V1__initial_schema.sql'));
    for(const f of ['database/pending/20261008_140000__audit_partition_conversion.sql','database/pending/repairs/20260610_100000__add_table_partitioning_system.sql','database/pending/repairs/20260619_000000__add_table_partitioning.sql'])await apply(pool,await read(f));
    await fn({pool,schema,manager,repair:await read('database/pending/repairs/'+filename)});
  }finally{await manager.stop();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function snapshot(pool){return {
  objects:(await pool.query("SELECT c.oid,c.relname,c.relkind,obj_description(c.oid,'pg_class') AS comment,pg_get_expr(c.relpartbound,c.oid) AS bound FROM pg_class c WHERE relnamespace=current_schema()::regnamespace ORDER BY c.oid")).rows,
  functions:(await pool.query("SELECT oid,pg_get_functiondef(oid) AS definition,proacl,proconfig FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY oid")).rows,
  triggers:(await pool.query("SELECT t.oid,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY t.oid")).rows,
  views:(await pool.query("SELECT c.oid,c.relname,pg_get_viewdef(c.oid,true) AS definition FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind='v' ORDER BY c.oid")).rows,
};}

test('actual canonical partition maintenance preserves history and executes real operational behavior',async t=>fixture(async({pool,schema,manager,repair})=>{
  const owner=crypto.randomUUID();await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[owner,'partition-owner']);
  await pool.query("INSERT INTO audit_logs(user_id,action,details,created_at) VALUES($1,'keep-history','{\"opaque\":true}','2020-01-03')",[owner]);
  await pool.query("INSERT INTO catch_records(id,user_id,pokemon_id,location,created_at) VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint(121,31),4326),CURRENT_TIMESTAMP)",[crypto.randomUUID(),owner,crypto.randomUUID()]);
  await pool.query("INSERT INTO location_updates(id,user_id,location,created_at) VALUES($1,$2,ST_SetSRID(ST_MakePoint(121,31),4326),CURRENT_TIMESTAMP)",[crypto.randomUUID(),owner]);
  await pool.query("INSERT INTO audit_logs(user_id,action,details,created_at) VALUES($1,'keep-current-audit','{\"opaque\":true}',CURRENT_TIMESTAMP)",[owner]);
  await pool.query("INSERT INTO event_logs(id,user_id,event_type,payload,created_at) VALUES($1,$2,'keep-current-event','{\"opaque\":true}',CURRENT_TIMESTAMP)",[crypto.randomUUID(),owner]);
  await pool.query("INSERT INTO payment_transactions(id,user_id,order_id,amount,status,created_at) VALUES($1,$2,'kept-real-payment',123.45,'paid',CURRENT_TIMESTAMP)",[crypto.randomUUID(),owner]);
  const originals={};for(const table of TABLES)originals[table]=(await pool.query(`SELECT to_jsonb(r)::text AS row FROM ${table} r ORDER BY id`)).rows;
  await pool.query('CREATE VIEW retained_partition_sizes AS SELECT parent_table,partition_name,size_bytes,partition_bound FROM partition_stats');
  await pool.query("COMMENT ON VIEW partition_stats IS 'operator size contract'");
  const before=await snapshot(pool),rows=(await pool.query('SELECT to_jsonb(r)::text AS row FROM audit_logs r ORDER BY id')).rows;
  await t.test('original view-column replacement fails and atomically preserves existing functions/views/rows',async()=>{
    await assert.rejects(apply(pool,await read('database/pending/'+filename)),{code:'42P16'});assert.deepEqual(await snapshot(pool),before);
  });
  await apply(pool,repair);
  await t.test('five real parents, original view/OID/columns/dependents/helpers/history remain intact',async()=>{
    const after=await snapshot(pool);for(const item of before.objects)assert.deepEqual(after.objects.find(x=>x.oid===item.oid),item);for(const item of before.functions)assert.deepEqual(after.functions.find(x=>x.oid===item.oid),item);
    for(const table of TABLES)assert.deepEqual((await pool.query(`SELECT to_jsonb(r)::text AS row FROM ${table} r ORDER BY id`)).rows,originals[table]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_log_identity')).rows[0].n,2);
    assert.deepEqual(after.views,before.views);assert.deepEqual(after.triggers.filter(x=>before.triggers.some(b=>b.oid===x.oid)),before.triggers);
    assert.deepEqual((await pool.query('SELECT to_jsonb(r)::text AS row FROM audit_logs r ORDER BY id')).rows,rows);
    for(const table of TABLES)assert.equal((await pool.query('SELECT to_regclass($1) AS name',[table+'_partitioned'])).rows[0].name,null);
  });
  await t.test('current plus three future months are physically covered for all five UTC granularities',async()=>{
    for(const table of TABLES){
      const health=await manager.healthCheck(table);assert.equal(health.missingRanges,0);assert.equal(health.schema,schema);
      assert.deepEqual(await manager.ensureFuturePartitions(table),[]);
      const plan=(await pool.query('SELECT * FROM minego_partition_plan($1)',[table])).rows;assert.ok(plan.length>=4);
      for(const item of plan)assert.equal((await pool.query('SELECT * FROM minego_partition_children($1) WHERE start_at=$2 AND end_at=$3',[table,item.start_at,item.end_at])).rowCount,1);
      if(table==='event_logs')for(const item of plan){assert.equal(item.start_at.getUTCDay(),2);assert.equal(item.end_at-item.start_at,7*86400000);}
    }
  });
  await t.test('real default rows move to new ranges exactly once and produce exact real counts/bytes',async()=>{
    const now=(await pool.query("SELECT date_trunc('month',CURRENT_TIMESTAMP)+INTERVAL '6 months 3 days' AS at")).rows[0].at;
    await pool.query("INSERT INTO event_logs(id,user_id,event_type,payload,created_at) VALUES($1,$2,'actual-count','{\"opaque\":true}',$3)",[crypto.randomUUID(),owner,now]);
    const created=(await pool.query("SELECT minego_ensure_partition_horizon('event_logs',7) AS created")).rows[0].created;assert.ok(created.length>0);
    const stats=await manager.getPartitionStats('event_logs'),actual=(await pool.query("SELECT tableoid::regclass::text AS name FROM event_logs WHERE event_type='actual-count'")).rows[0].name;
    assert.equal(stats.find(x=>x.name===actual).rowCount,'1');assert.equal(stats.find(x=>x.isDefault).rowCount,'0');
    assert.equal(stats.find(x=>x.name===actual).sizeBytes,(await pool.query('SELECT pg_total_relation_size($1::regclass)::text AS n',[actual])).rows[0].n);
  });
  await t.test('cross-schema same-name children never enter actual counts or managed relations',async()=>{
    const outsider=schema+'_other';await pool.query(`CREATE SCHEMA ${outsider}`);
    try{await pool.query(`CREATE TABLE ${outsider}.event_logs(id int,created_at timestamptz) PARTITION BY RANGE(created_at); CREATE TABLE ${outsider}.event_logs_foreign PARTITION OF ${outsider}.event_logs DEFAULT; INSERT INTO ${outsider}.event_logs VALUES(1,NOW())`);
      const stats=await manager.getPartitionStats('event_logs');assert.ok(!stats.some(x=>x.name==='event_logs_foreign'));assert.equal(stats.reduce((s,x)=>s+BigInt(x.rowCount),0n),2n);
    }finally{await pool.query(`DROP SCHEMA ${outsider} CASCADE`);}
  });
  await t.test('custom legacy statistics view remains untouched while new actual statistics work independently',async()=>{
    const definition=(await pool.query("SELECT pg_get_viewdef('partition_stats'::regclass,true) AS definition")).rows[0].definition;
    assert.match(definition,/ORDER BY/);await pool.query('CREATE OR REPLACE VIEW partition_stats AS '+definition.replace('ORDER BY','AND false ORDER BY'));
    const state=await snapshot(pool);await apply(pool,repair);assert.deepEqual(await snapshot(pool),state);
    assert.equal((await pool.query('SELECT * FROM partition_stats')).rowCount,0);
    assert.equal((await manager.getPartitionStats('audit_logs')).reduce((sum,p)=>sum+BigInt(p.rowCount),0n),2n);
  });
  await t.test('actual two-client creation race creates missing child exactly once under parent lock',async()=>{
    const plan=(await pool.query("SELECT * FROM minego_partition_plan('catch_records') ORDER BY start_at DESC LIMIT 1")).rows[0];
    await pool.query(`DROP TABLE ${plan.partition_name}`);
    const result=await Promise.all([manager.ensureFuturePartitions('catch_records'),manager.ensureFuturePartitions('catch_records')]);assert.equal(result.flat().filter(n=>n===plan.partition_name).length,1);
    assert.equal((await manager.healthCheck('catch_records')).missingRanges,0);
  });
  await t.test('timezone, existing weekly phase and old default/history remain unchanged',async()=>{
    const client=await pool.connect();try{await client.query("SET TimeZone='Asia/Shanghai'");
      const plan=(await client.query("SELECT * FROM minego_partition_plan('audit_logs',3,'2032-02-29T23:30:00-08:00')")).rows;assert.equal(plan[0].start_at.toISOString(),'2032-03-01T00:00:00.000Z');assert.equal(plan.at(-1).end_at.toISOString(),'2032-07-01T00:00:00.000Z');
      assert.equal((await client.query('SHOW TimeZone')).rows[0].TimeZone,'Asia/Shanghai');
    }finally{await client.query("SET TimeZone='UTC'");client.release();}
    assert.deepEqual((await pool.query('SELECT to_jsonb(r)::text AS row FROM audit_logs r ORDER BY id')).rows,rows);
  });
  await t.test('real HTTP router rejects anonymous/ordinary/tampered users before any management query',async()=>{
    const app=express();app.use('/api/partitions',createPartitionRouter({manager}));app.use(errorHandler);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const base='http://127.0.0.1:'+server.address().port+'/api/partitions';
    const regular=jwt.sign({sub:owner,roles:[]},process.env.JWT_ACCESS_SECRET),admin=jwt.sign({sub:owner,roles:['admin']},process.env.JWT_ACCESS_SECRET);
    const call=(route,token,body)=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    try{
      const state=await snapshot(pool);
      assert.equal((await call('/overview')).status,401);assert.equal((await call('/overview',regular)).status,403);assert.equal((await call('/overview',admin+'bad')).status,401);assert.deepEqual(await snapshot(pool),state);
      assert.equal((await call('/config/list',admin)).status,200);
      const response=await call('/overview',admin);assert.equal(response.status,200);const overview=(await response.json()).data;assert.equal(overview.audit_logs.totalRows,'2');assert.equal(overview.event_logs.totalRows,'2');
      const summary=await call('/stats/summary',admin);assert.equal(summary.status,200);const totals=(await summary.json()).data;assert.equal(totals.totalRows,'7');assert.equal(totals.tables,5);
      const details=await call('/audit_logs',admin);assert.equal(details.status,200);assert.equal((await details.json()).data.health.status,'warning_default_rows');
      assert.equal((await call('/audit_logs/create',admin,{months:3})).status,200);
      for(const months of [0,13,1.5,'3'])assert.equal((await call('/audit_logs/create',admin,{months})).status,400);
      assert.equal((await call('/not-managed/create',admin,{months:3})).status,400);assert.equal((await call('/not-managed',admin)).status,400);
    }finally{await new Promise(r=>server.close(r));}
  });
  await t.test('removed empty future children do not leave stale Prometheus rows or byte labels',async()=>{
    const stats=await manager.getPartitionStats('event_logs');
    const extra=stats.filter(p=>!p.isDefault&&p.rowCount==='0').at(-1);assert.ok(extra);await pool.query(`DROP TABLE ${extra.name}`);
    await manager.getPartitionStats('event_logs');const output=await manager.registry.metrics();assert.ok(!output.includes(`partition="${extra.name}"`));
    await pool.query("SELECT minego_ensure_partition_horizon('event_logs',7)");
  });
  await t.test('Prometheus exposes actual counts/bytes and successful creation without fabricated samples',async()=>{
    const output=await manager.registry.metrics();assert.match(output,/minego_partition_managed_rows\{table="audit_logs",partition="audit_logs_default"\} 1/);assert.match(output,/minego_partition_management_duration_seconds_count/);assert.match(output,/minego_partition_managed_created_total\{table="catch_records"\} 1/);
  });
  await t.test('live periodic scheduler restores a missing empty range and stops its owned timer',async()=>{
    await assert.rejects(manager.start({intervalMs:1}),/Invalid/);
    await manager.start({intervalMs:1000});await manager.start({intervalMs:1000});
    const name=(await pool.query("SELECT partition_name FROM minego_partition_plan('payment_transactions') ORDER BY start_at DESC LIMIT 1")).rows[0].partition_name;await pool.query(`DROP TABLE ${name}`);
    let restored=false;for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,100));if((await manager.healthCheck('payment_transactions')).missingRanges===0){restored=true;break;}}
    assert.ok(restored);await manager.stop();assert.equal(manager.timer,null);assert.equal(manager.running,null);
  });
  await t.test('real database faults propagate and scheduled failures are observable without leaking timers',async()=>{
    await pool.query('ALTER FUNCTION minego_partition_live_stats(text) RENAME TO held_partition_live_stats');
    try{await assert.rejects(manager.getPartitionStats('audit_logs'),{code:'42883'});}finally{await pool.query('ALTER FUNCTION held_partition_live_stats(text) RENAME TO minego_partition_live_stats');}
    await pool.query('ALTER FUNCTION minego_ensure_partition_horizon(text,integer,timestamptz) RENAME TO held_partition_horizon');
    try{await assert.rejects(manager.start({intervalMs:1000}),{code:'42883'});assert.equal(manager.stopped,true);assert.equal(manager.running,null);}finally{await pool.query('ALTER FUNCTION held_partition_horizon(text,integer,timestamptz) RENAME TO minego_ensure_partition_horizon');}
    let observed;await manager.start({intervalMs:1000,onError:error=>{observed=error;}});
    await pool.query('ALTER FUNCTION minego_ensure_partition_horizon(text,integer,timestamptz) RENAME TO held_partition_horizon');
    try{for(let i=0;i<30&&!observed;i++)await new Promise(r=>setTimeout(r,100));assert.equal(observed?.code,'42883');}
    finally{await manager.stop();await pool.query('ALTER FUNCTION held_partition_horizon(text,integer,timestamptz) RENAME TO minego_ensure_partition_horizon');}
    assert.equal(manager.timer,null);assert.match(await manager.registry.metrics(),/minego_partition_management_failures_total/);
  });
  await t.test('genuine migration CLI journals raw and execution hashes; rerun preserves all object contracts',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'minego-partition-cli-'));
    try{
      const original=await read('database/pending/'+filename);await fs.mkdir(path.join(dir,'repairs'));await fs.writeFile(path.join(dir,filename),original);await fs.writeFile(path.join(dir,'repairs',filename),repair);
      const manifest=JSON.parse(await read('database/pending/repairs.json'));await fs.writeFile(path.join(dir,'repairs.json'),JSON.stringify({schemaVersion:1,repairs:{'20260707_060000':manifest.repairs['20260707_060000']}}));
      const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
      const cli=command=>promisify(execFile)(process.execPath,[path.join(root,'database/migrate.js'),command],{env:{...process.env,DATABASE_URL:url.toString(),MINEGO_MIGRATIONS_DIR:dir},timeout:30000});
      await cli('up');const row=(await pool.query('SELECT checksum,execution_checksum FROM schema_migrations')).rows[0];assert.equal(row.checksum,hash(original));assert.equal(row.execution_checksum,hash(JSON.stringify({up:repair.trim(),down:''})));
      const state=await snapshot(pool);await cli('up');await cli('verify');assert.deepEqual(await snapshot(pool),state);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
}));

test('incompatible layouts/functions and overlapping future ranges fail atomically',async t=>{
  for(const [label,sql,pattern,first=false] of [
    ['existing shadow layout',"CREATE TABLE event_logs_partitioned(keep text); INSERT INTO event_logs_partitioned VALUES('retained')",/shadow partition layout/],
    ['false-success underlying creator',"CREATE OR REPLACE FUNCTION minego_create_time_partition(parent_table text,partition_name text,start_date timestamptz,end_date timestamptz) RETURNS boolean LANGUAGE sql AS 'SELECT false'",/Partition creator did not produce expected bounds/],
    ['custom overlapping weekly phase',"SELECT minego_create_time_partition('event_logs','operator_weekly_range',date_bin(INTERVAL '7 days',CURRENT_TIMESTAMP,TIMESTAMPTZ '2026-06-02+00')+INTERVAL '1 day',date_bin(INTERVAL '7 days',CURRENT_TIMESTAMP,TIMESTAMPTZ '2026-06-02+00')+INTERVAL '8 days')",/overlap/],
    ['custom managed function',"CREATE FUNCTION minego_partition_children(text) RETURNS integer LANGUAGE sql AS 'SELECT 99'",/Customized partition function/],
    ['wrong UTC function configuration',"ALTER FUNCTION minego_partition_plan(text,integer,timestamptz) SET TimeZone='Asia/Shanghai'",/Customized partition function/,true],
    ['future name owned by another relation',"CREATE TABLE catch_records_2040_01(keep text); INSERT INTO catch_records_2040_01 VALUES('retained')",/another relation/],
  ])await t.test(label,async()=>fixture(async({pool,repair})=>{
    if(first)await apply(pool,repair);await pool.query(sql);const state=await snapshot(pool);
    if(label==='future name owned by another relation'){
      await apply(pool,repair);const ready=await snapshot(pool);await assert.rejects(pool.query("SELECT minego_ensure_partition_horizon('catch_records',1,'2040-01-03+00')"),pattern);assert.deepEqual(await snapshot(pool),ready);
    }else{await assert.rejects(apply(pool,repair),pattern);assert.deepEqual(await snapshot(pool),state);}
  }));
});
