'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {promisify}=require('node:util');const {execFile}=require('node:child_process');const {Pool}=require('pg');
const {migrationStatements}=require('../../../database/sqlStatements');const {parseMigrationFile}=require('../../../database/migrate');
const root=path.resolve(__dirname,'../../..'),filename='20260711_120000__add_job_monitoring_tables.sql';const read=f=>fs.readFile(path.join(root,f),'utf8');const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function apply(pool,source){const c=await pool.connect();try{await c.query('BEGIN');for(const sql of migrationStatements(parseMigrationFile(source).up))await c.query(sql);await c.query('COMMIT');}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}}
async function fixture(fn){
 assert.ok(process.env.TEST_DATABASE_URL,'owned PostGIS fixture required');const schema='job_storage_'+crypto.randomBytes(8).toString('hex');const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
 await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');await admin.query('CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);const pool=new Pool({connectionString:url.toString(),max:2});
 try{await pool.query(await read('database/migrations/V1__initial_schema.sql'));await pool.query(await read('database/seeds/V2__seed_data.sql'));await fn({pool,schema,url:url.toString(),repair:await read('database/pending/repairs/'+filename)});}finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function snapshot(pool){return {
 objects:(await pool.query("SELECT oid,relname,relkind,relacl,obj_description(oid,'pg_class') AS comment FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY oid")).rows,
 constraints:(await pool.query("SELECT c.oid,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid WHERE r.relnamespace=current_schema()::regnamespace ORDER BY c.oid")).rows,
 indexes:(await pool.query("SELECT i.indexrelid,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace=current_schema()::regnamespace ORDER BY i.indexrelid")).rows,
 views:(await pool.query("SELECT oid,pg_get_viewdef(oid,true) AS definition FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='v' ORDER BY oid")).rows
};}

test('canonical job history repairs the impossible index and preserves actual retained operational data',async t=>fixture(async({pool,schema,url,repair})=>{
 const initial=await snapshot(pool);
 await t.test('original proposal fails at nonexistent created_time and all partial DDL rolls back',async()=>{await assert.rejects(apply(pool,await read('database/pending/'+filename)),{code:'42703'});assert.deepEqual(await snapshot(pool),initial);});
 await apply(pool,repair);
 const actor=crypto.randomUUID();await pool.query("INSERT INTO users(id,nickname) VALUES($1,'job-storage-admin')",[actor]);
 await pool.query("INSERT INTO job_execution_logs(job_id,job_name,category,status,start_time,end_time,duration_ms,error_message,metadata,created_at) VALUES('fixture-backup','Fixture backup','backup','success','2026-01-01 01:00','2026-01-01 01:00:01',1000,NULL,'{\"retained\":true}','2026-01-01'),('fixture-backup','Fixture backup','backup','failed','2026-01-01 02:00','2026-01-01 02:00:03',3000,'fixture-disk-error','{}','2026-01-01'),('fixture-backup','Fixture backup','backup','timeout','2026-01-01 03:00','2026-01-01 03:00:04',4000,'fixture-timeout','{}','2026-01-01')");
 await pool.query("INSERT INTO job_alert_history(alert_id,job_id,alert_type,severity,message,channels,metadata,sent_at,acknowledged_at,acknowledged_by) VALUES('fixture-alert','fixture-backup','failure','critical','fixture local history','[\"fixture-only\"]','{\"retained\":true}',NOW(),NOW(),$1)",[actor]);
 await pool.query("INSERT INTO job_health_snapshots(job_id,health_score,grade,success_rate,avg_duration_ms,run_count,failure_count,factors) VALUES('fixture-backup',40,'D',33.33,2667,3,2,'{\"real\":true}')");
 await pool.query("INSERT INTO alert_suppression_log(alert_key,original_alert_id,suppressed_at,suppression_window_ms,reason) VALUES('fixture-alert-key','fixture-alert',NOW(),600000,'fixture repeat')");
 await pool.query("COMMENT ON TABLE job_execution_logs IS 'operator-owned job history'; COMMENT ON VIEW job_daily_statistics IS 'operator-owned statistics'; CREATE VIEW operator_job_statistics AS SELECT * FROM job_daily_statistics; CREATE TABLE operator_job_reference(log_id integer REFERENCES job_execution_logs(id)); INSERT INTO operator_job_reference VALUES(1)");
 const tables=['job_execution_logs','job_alert_history','job_health_snapshots','alert_suppression_log'];const rows={};for(const table of tables)rows[table]=(await pool.query(`SELECT to_jsonb(r)::text AS row FROM ${table} r ORDER BY id`)).rows;
 await t.test('current index uses real created_at descending and UUID acknowledgements retain canonical linkage',async()=>{
  const index=(await pool.query("SELECT pg_get_indexdef('idx_job_logs_created_at'::regclass) AS definition")).rows[0].definition;assert.match(index,/\(created_at DESC\)/);assert.doesNotMatch(index,/created_time/);
  assert.equal((await pool.query("SELECT acknowledged_by FROM job_alert_history WHERE alert_id='fixture-alert'")).rows[0].acknowledged_by,actor);
  await assert.rejects(pool.query("UPDATE job_alert_history SET acknowledged_by=$1 WHERE alert_id='fixture-alert'",[crypto.randomUUID()]),{code:'23503'});
 });
 await t.test('actual daily aggregation preserves counts, timeout classification, durations and two decimal success rates',async()=>{
  const row=(await pool.query("SELECT * FROM job_daily_statistics WHERE job_id='fixture-backup'")).rows[0];assert.equal(row.total_runs,'3');assert.equal(row.success_count,'1');assert.equal(row.failure_count,'1');assert.equal(row.timeout_count,'1');assert.equal(row.success_rate,'33.33');assert.equal(Number(row.avg_duration_ms),8000/3);
  assert.equal((await pool.query('SELECT * FROM operator_job_statistics')).rowCount,1);
 });
 await t.test('rerun retains OIDs, sequences, four histories, foreign keys, dependent views and operator comments',async()=>{
  const state=await snapshot(pool);const sequences=(await pool.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename")).rows;
  await apply(pool,repair);assert.deepEqual(await snapshot(pool),state);assert.deepEqual((await pool.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename")).rows,sequences);
  for(const table of tables)assert.deepEqual((await pool.query(`SELECT to_jsonb(r)::text AS row FROM ${table} r ORDER BY id`)).rows,rows[table]);
 });
 await t.test('genuine root CLI up/up/verify retains raw and execution checksums without rewriting earlier history',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'minego-job-cli-'));
  try{
   const original=await read('database/pending/'+filename);await fs.mkdir(path.join(dir,'repairs'));await fs.writeFile(path.join(dir,filename),original);await fs.writeFile(path.join(dir,'repairs',filename),repair);
   const manifest=JSON.parse(await read('database/pending/repairs.json'));await fs.writeFile(path.join(dir,'repairs.json'),JSON.stringify({schemaVersion:1,repairs:{'20260711_120000':manifest.repairs['20260711_120000']}}));
   const cli=command=>promisify(execFile)(process.execPath,[path.join(root,'database/migrate.js'),command],{env:{...process.env,DATABASE_URL:url,MINEGO_MIGRATIONS_DIR:dir},timeout:30000});
   await cli('up');const row=(await pool.query('SELECT checksum,execution_checksum FROM schema_migrations')).rows[0];assert.equal(row.checksum,hash(original));assert.equal(row.execution_checksum,hash(JSON.stringify({up:repair.trim(),down:''})));
   const state=await snapshot(pool);await cli('up');await cli('verify');assert.deepEqual(await snapshot(pool),state);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
 });
}));

test('customized job layouts, statistics, index semantics and owner links refuse atomically',async t=>{
 for(const [name,sql,pattern]of [
  ['wrong timestamp column type','ALTER TABLE job_execution_logs ALTER COLUMN created_at TYPE date',/Customized job history contract/],
  ['wrong created_at index','DROP INDEX idx_job_logs_created_at;CREATE INDEX idx_job_logs_created_at ON job_execution_logs(start_time DESC)',/Customized job index/],
  ['wrong descending sort','DROP INDEX idx_job_logs_created_at;CREATE INDEX idx_job_logs_created_at ON job_execution_logs(created_at)',/Customized job index/],
  ['missing UUID owner link','ALTER TABLE job_alert_history DROP CONSTRAINT job_alert_history_acknowledged_by_fkey',/Customized job history contract/],
 ]){
  await t.test(name,async()=>fixture(async({pool,repair})=>{await apply(pool,repair);await pool.query(sql);const state=await snapshot(pool);await assert.rejects(apply(pool,repair),pattern);assert.deepEqual(await snapshot(pool),state);}));
 }
 await t.test('operator view definition is preserved rather than replaced',async()=>fixture(async({pool,repair})=>{
  await apply(pool,repair);const definition=(await pool.query("SELECT pg_get_viewdef('job_daily_statistics'::regclass,true) AS definition")).rows[0].definition;await pool.query('CREATE OR REPLACE VIEW job_daily_statistics AS '+definition.replace('GROUP BY','WHERE false GROUP BY'));const state=await snapshot(pool);await assert.rejects(apply(pool,repair),/Customized job statistics view/);assert.deepEqual(await snapshot(pool),state);
 }));
});

test('actual production execution logger persists scoped history, atomic completion and bounded retention on real PostgreSQL',async t=>fixture(async({pool,repair,url})=>{
 const {JobExecutionLogger}=require('../../shared/jobMonitor/jobExecutionLogger');const logger=new JobExecutionLogger({pool});
 await t.test('missing canonical storage rejects initialization without creating ad hoc runtime tables',async()=>{
  const state=await snapshot(pool);await assert.rejects(logger.initialize(),{code:'42P01'});assert.deepEqual(await snapshot(pool),state);assert.equal(logger.isInitialized,false);
 });
 await apply(pool,repair);const state=await snapshot(pool);await Promise.all([logger.initialize(),logger.initialize()]);assert.deepEqual(await snapshot(pool),state);
 const start=new Date('2026-07-01T12:00:00.000Z'),end=new Date('2026-07-01T12:00:01.250Z');let id;
 try{
  await t.test('empty history reports an unknown success rate without dividing by zero',async()=>{
   const stats=await logger.getStatistics('never-ran');assert.equal(stats.total_runs,'0');assert.equal(stats.success_rate,null);assert.equal(stats.avg_duration_ms,null);
  });
  await t.test('real start/end preserves metadata and actual milliseconds with stable UTC reads',async()=>{
   id=await logger.logStart('real-job','Real fixture','backup',start);const final=await logger.logEnd('real-job',id,'success',end);
   assert.equal(final.id,id);assert.equal(final.duration_ms,1250);assert.equal(final.start_time.toISOString(),start.toISOString());assert.equal(final.end_time.toISOString(),end.toISOString());assert.deepEqual(final.metadata,{action:'started'});
   assert.equal((await logger.getLogStartTime(id,'real-job')).toISOString(),start.toISOString());assert.equal(await logger.getLogStartTime(id,'another-job'),undefined);
   assert.equal((await logger.logEnd('real-job',id,'success',new Date(end.getTime()+5000))).duration_ms,1250);
   await assert.rejects(logger.logEnd('another-job',id,'failed',end),error=>error.status===404);
   await assert.rejects(logger.logEnd('real-job',id,'failed',end),error=>error.status===409);
  });
  await t.test('actual UTC and Shanghai processes retain identical instants with a different PostgreSQL session timezone',async()=>{
   const script=`const {Pool}=require('./backend/node_modules/pg');const {JobExecutionLogger}=require('./backend/shared/jobMonitor/jobExecutionLogger');(async()=>{const pool=new Pool({connectionString:process.env.JOB_FIXTURE_URL,max:1});const logger=new JobExecutionLogger({pool});try{await pool.query(\"SET TimeZone='America/New_York'\");const start=new Date('2026-07-02T00:00:00.000Z');const id=await logger.logStart('timezone-'+process.env.TZ,'Timezone','backup',start);const row=await logger.logEnd('timezone-'+process.env.TZ,id,'success',new Date(start.getTime()+1234));if(row.start_time.toISOString()!==start.toISOString()||row.duration_ms!==1234||Math.abs(Date.now()-row.created_at.getTime())>5000)throw Error('Wrong timestamp');console.log(JSON.stringify({timezone:process.env.TZ,start:row.start_time.toISOString(),durationMs:row.duration_ms}));}finally{await logger.close();await pool.end();}})().catch(error=>{console.error(error.code||'FIXTURE_FAILED');process.exitCode=1;});`;
   for(const timezone of ['UTC','Asia/Shanghai']){const result=await promisify(execFile)(process.execPath,['-e',script],{cwd:root,env:{...process.env,TZ:timezone,JOB_FIXTURE_URL:url},timeout:15000});assert.deepEqual(JSON.parse(result.stdout.trim()),{timezone,start:'2026-07-02T00:00:00.000Z',durationMs:1234});}
  });
  await t.test('default logger uses the configured shared DATABASE_URL pool without taking ownership',async()=>{
   const script=`const db=require('./backend/shared/db');const {JobExecutionLogger}=require('./backend/shared/jobMonitor/jobExecutionLogger');(async()=>{const logger=new JobExecutionLogger();try{await logger.initialize();if(logger.pool!==db.getPool())throw Error('Wrong pool');const current=(await db.query('SELECT current_schema() AS schema')).rows[0].schema;await logger.close();await db.query('SELECT 1');console.log(JSON.stringify({schema:current,sharedPoolRetained:true}));}finally{await db.closePools();}})().catch(error=>{console.error(error.code||'FIXTURE_FAILED');process.exitCode=1;});`;
   const result=await promisify(execFile)(process.execPath,['-e',script],{cwd:root,env:{...process.env,DATABASE_URL:url,PG_HOST:'127.0.0.1',PG_PORT:'1',LOG_LEVEL:'error'},timeout:15000});assert.equal(JSON.parse(result.stdout.trim()).sharedPoolRetained,true);assert.match(JSON.parse(result.stdout.trim()).schema,/^job_storage_/);
  });
  await t.test('explicitly owned dedicated pools close naturally when their logger closes',async()=>{
   const dedicated=new Pool({connectionString:url,max:1});const owner=new JobExecutionLogger({pool:dedicated,ownsPool:true});await owner.initialize();await owner.close();await assert.rejects(dedicated.query('SELECT 1'),/Cannot use a pool after calling end/);
  });
  await t.test('actual two-client completion race has one durable winner and one conflict',async()=>{
   const race=await logger.logStart('real-race','Race','backup',start);
   const result=await Promise.allSettled([logger.logEnd('real-race',race,'success',end),logger.logEnd('real-race',race,'failed',end,new Error('fixture-failure'))]);
   assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.find(x=>x.status==='rejected').reason.status,409);
   const row=(await logger.getHistory('real-race'))[0];assert.equal(row.duration_ms,1250);assert.ok(['success','failed'].includes(row.status));
  });
  await t.test('history filters, counts, true rates and failure distribution use real persisted records',async()=>{
   await logger.log({jobId:'real-job',jobName:'Real fixture',category:'backup',status:'failed',startTime:start,endTime:end,errorMessage:'fixture disk error',metadata:{attempt:2}});
   await logger.log({jobId:'real-job',jobName:'Real fixture',category:'backup',status:'timeout',startTime:start,endTime:end});
   const period={startDate:'2026-07-01T00:00:00Z',endDate:'2026-07-02T00:00:00Z'};
   const stats=await logger.getStatistics('real-job',period);assert.equal(stats.total_runs,'3');assert.equal(stats.success_count,'1');assert.equal(stats.failure_count,'1');assert.equal(stats.timeout_count,'1');assert.equal(stats.success_rate,1/3);assert.equal(Number(stats.avg_duration_ms),1250);
   assert.equal((await logger.getHistory('real-job',{...period,status:'failed',limit:1,offset:0})).length,1);assert.equal((await logger.getRecentFailures('real-job',1))[0].error_message,'fixture disk error');
   assert.equal((await logger.getAllRecentLogs(2)).length,2);assert.equal((await logger.getAllJobsStatistics(period)).find(r=>r.job_id==='real-job').total_runs,'3');assert.equal((await logger.getFailureDistribution('real-job',period))[0].count,'1');
  });
  await t.test('invalid input and earlier completion leave stored records unchanged',async()=>{
   for(const options of [{retentionDays:89},{retentionDays:90.5}])assert.throws(()=>new JobExecutionLogger({pool,...options}),error=>error.status===400);
   for(const options of [{limit:0},{offset:-1},{status:'arbitrary'},{startDate:'invalid'},{startDate:'2026-07-03',endDate:'2026-07-01'}])await assert.rejects(logger.getHistory('real-job',options),error=>error.status===400);
   await assert.rejects(logger.getHistory('',{}),error=>error.status===400);await assert.rejects(logger.getStatistics('real-job',{startDate:'2026-07-03',endDate:'2026-07-01'}),error=>error.status===400);
   await assert.rejects(logger.log({jobId:'real-job',status:'running',startTime:'invalid'}),error=>error.status===400);
   await assert.rejects(logger.log({jobId:'real-job',status:'unknown',startTime:start}),error=>error.status===400);
   const circular={};circular.self=circular;await assert.rejects(logger.log({jobId:'real-job',status:'running',startTime:start,metadata:circular}),error=>error.status===400);
   const held=await logger.logStart('held-job','Held','backup',start);await assert.rejects(logger.logEnd('held-job',held,'success',new Date(start.getTime()-1)),error=>error.status===400);assert.equal((await logger.getHistory('held-job'))[0].status,'running');
  });
  await t.test('retention deletes only old completed fixture rows and keeps running, recent and unknown legacy states',async()=>{
   const old=new Date(Date.now()-100*86400000).toISOString().slice(0,-1),recent=new Date(Date.now()-86400000).toISOString().slice(0,-1);
   await pool.query("INSERT INTO job_execution_logs(job_id,status,start_time,end_time,created_at) VALUES('retention','success',$1::timestamp,$1::timestamp,$1::timestamp),('retention','running',$1::timestamp,NULL,$1::timestamp),('retention','success',$2::timestamp,$2::timestamp,$2::timestamp),('retention','legacy-unknown',$1::timestamp,$1::timestamp,$1::timestamp)",[old,recent]);
   assert.equal(await logger.cleanupOldLogs(),1);const rows=await logger.getHistory('retention');assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r.status).sort(),['legacy-unknown','running','success']);
  });
 }finally{await logger.close();}
 await t.test('closing a caller-owned logger leaves its actual pool usable and rejects further operations',async()=>{assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n,1);await assert.rejects(logger.getHistory('real-job'),error=>error.status===503);});
}));
