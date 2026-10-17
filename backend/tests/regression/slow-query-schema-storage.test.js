'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Pool}=require('pg');
const {migrationStatements}=require('../../../database/sqlStatements');
const root=path.resolve(__dirname,'../../..');

test('actual PostgreSQL15 slow-query migration and live statement helpers',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS with pg_stat_statements preloaded');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
  const suffix=crypto.randomBytes(8).toString('hex');
  const schema='slow_schema_'+suffix,database='slow_db_'+suffix,foreignSchema='slow_foreign_'+suffix;
  let pool;
  try{
    assert.match((await admin.query('SHOW shared_preload_libraries')).rows[0].shared_preload_libraries,/pg_stat_statements/);
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public');
    await admin.query(`CREATE DATABASE ${database} TEMPLATE template0`);
    const fixtureURL=new URL(process.env.TEST_DATABASE_URL);fixtureURL.pathname='/'+database;
    pool=new Pool({connectionString:fixtureURL.toString(),max:1,options:`-c search_path=${schema},public`});
    await pool.query('CREATE EXTENSION pg_stat_statements WITH SCHEMA public');
    await pool.query(`CREATE SCHEMA ${schema}`);
    const apply=async text=>{const c=await pool.connect();try{await c.query('BEGIN');for(const sql of migrationStatements(text))await c.query(sql);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
    const read=file=>fs.readFile(path.join(root,'database/pending',file),'utf8');
    const raw=await read('20260627_041000__enable_pg_stat_statements.sql');
    const repair=await read('repairs/20260627_041000__enable_pg_stat_statements.sql');
    const identities=async()=> (await pool.query("SELECT relname,oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname IN('slow_query_history','index_suggestions','query_performance_baseline','slow_query_history_id_seq') ORDER BY relname")).rows;
    await apply(await read('repairs/20260610_103000__enable_pg_stat_statements_and_analysis_tables.sql'));
    await pool.query("INSERT INTO slow_query_history(query_id,query_text,mean_time_ms,calls) VALUES(77,'historical preserved',123.456,9)");
    await pool.query("INSERT INTO index_suggestions(table_name,column_name,suggested_sql) VALUES('old_table','old_column','historical suggestion')");
    await pool.query("INSERT INTO query_performance_baseline(query_signature,p95_execution_time_ms) VALUES('historic',88.125)");
    await pool.query('CREATE VIEW retained_slow_history AS SELECT * FROM slow_query_history');
    await pool.query('CREATE TABLE retained_slow_reference(id integer REFERENCES slow_query_history(id))');
    await pool.query('INSERT INTO retained_slow_reference SELECT id FROM slow_query_history');
    const before=await identities();const history=(await pool.query('SELECT * FROM retained_slow_history')).rows;
    await t.test('original floating point rounding fails and rolls back all new helper definitions',async()=>{
      await assert.rejects(apply(raw),{code:'42883'});
      assert.equal((await pool.query("SELECT to_regprocedure('analyze_slow_queries(double precision)') AS fn")).rows[0].fn,null);
      assert.deepEqual(await identities(),before);assert.deepEqual((await pool.query('SELECT * FROM retained_slow_history')).rows,history);
    });
    await t.test('repair preserves existing table/sequence identities, exact history, views and foreign keys',async()=>{
      await apply(repair);assert.deepEqual(await identities(),before);
      assert.deepEqual((await pool.query('SELECT * FROM retained_slow_history')).rows,history);
      assert.equal((await pool.query('SELECT id FROM retained_slow_reference')).rowCount,1);
      assert.equal((await pool.query('SELECT suggested_sql FROM index_suggestions')).rows[0].suggested_sql,'historical suggestion');
      assert.equal((await pool.query('SELECT p95_execution_time_ms FROM query_performance_baseline')).rows[0].p95_execution_time_ms,88.125);
    });
    await t.test('actual index-usage ratios retain the intended numeric two-decimal result',async()=>{
      const rows=(await pool.query('SELECT * FROM v_index_usage_summary WHERE schemaname=current_schema()')).rows;assert.ok(rows.length>0);
      for(const row of rows){assert.equal(Number(row.total_indexes),Number(row.used_indexes)+Number(row.unused_indexes));assert.equal(row.usage_ratio,(Number(row.used_indexes)/Number(row.total_indexes)*100).toFixed(2));}
    });
    await t.test('helpers use actual current-database execution statistics and exclude another database',async()=>{
      await admin.query(`CREATE SCHEMA ${foreignSchema}`);
      await admin.query(`CREATE TABLE ${foreignSchema}.foreign_slow_probe(id integer PRIMARY KEY)`);
      await admin.query(`INSERT INTO ${foreignSchema}.foreign_slow_probe VALUES(1)`);
      await admin.query(`SELECT count(*) FROM ${foreignSchema}.foreign_slow_probe CROSS JOIN pg_sleep(0.05)`);
      const foreign=(await admin.query('SELECT queryid,mean_exec_time FROM public.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query LIKE $1',[`SELECT count(*) FROM ${foreignSchema}.foreign_slow_probe%`])).rows;
      assert.equal(foreign.length,1);assert.ok(foreign[0].mean_exec_time>=1,'Foreign slow query must qualify before testing its exclusion');
      await pool.query('CREATE TABLE live_slow_probe(id integer PRIMARY KEY)');await pool.query('INSERT INTO live_slow_probe VALUES(1)');
      await pool.query(`SELECT count(*) FROM ${schema}.live_slow_probe CROSS JOIN pg_sleep(0.015)`);
      const observed=(await pool.query('SELECT queryid,mean_exec_time,total_exec_time,calls FROM public.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query LIKE $1',[`SELECT count(*) FROM ${schema}.live_slow_probe%`])).rows;
      assert.equal(observed.length,1);assert.ok(observed[0].mean_exec_time>=1);assert.ok(Number(observed[0].calls)>=1);
      const analysis=(await pool.query('SELECT * FROM analyze_slow_queries(1)')).rows;
      assert.ok(analysis.every(row=>row.query_id!==foreign[0].queryid),'Current database report must not contain another database statement');
      const analyzed=analysis.find(row=>row.query_id===observed[0].queryid);assert.ok(analyzed);assert.equal(analyzed.mean_time,observed[0].mean_exec_time);assert.equal(analyzed.total_time,observed[0].total_exec_time);
      const snap=(await pool.query('SELECT snapshot_slow_queries(1) AS inserted')).rows[0].inserted;assert.ok(snap>=1);
      const saved=(await pool.query('SELECT * FROM slow_query_history WHERE query_id=$1',[observed[0].queryid])).rows;assert.ok(saved.length>=1);assert.equal(saved[0].mean_time_ms,observed[0].mean_exec_time);assert.equal(saved[0].calls,observed[0].calls);
      assert.equal((await pool.query('SELECT 1 FROM slow_query_history WHERE query_id=$1',[foreign[0].queryid])).rowCount,0);
    });
    await t.test('local deadlines preserve session configuration without per-transaction display-name changes',async()=>{
      const {TransactionManager}=require('../../shared/TransactionManager');
      const manager=new TransactionManager(pool);
      const originalName=(await pool.query('SHOW application_name')).rows[0].application_name;
      const originalTimeout=(await pool.query('SHOW statement_timeout')).rows[0].statement_timeout;
      const names=new Set();
      for(let i=0;i<5;i++)await manager.execute(async c=>{
        names.add(manager.getActiveTransactions()[0].id);
        assert.equal((await c.query('SHOW application_name')).rows[0].application_name,originalName);
        assert.notEqual((await c.query('SHOW statement_timeout')).rows[0].statement_timeout,'0');
      });
      assert.equal(names.size,5,'Cancellation ownership remains unique');
      const settings=(await pool.query("SELECT calls FROM public.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query LIKE 'SELECT set_config(%'")).rows;
      assert.equal(settings.length,0,'Cancellation ownership must not add per-operation configuration rows');
      assert.equal((await pool.query("SELECT 1 FROM public.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query LIKE 'SET LOCAL application_name=%'")).rowCount,0);
      assert.equal((await pool.query('SHOW application_name')).rows[0].application_name,originalName);
      assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout,originalTimeout);
    });
    await t.test('retained snapshot cutoff remains30 days and does not remove newer history',async()=>{
      await pool.query("INSERT INTO slow_query_history(query_id,query_text,recorded_at) VALUES(900001,'old',now()-interval '31 days'),(900002,'recent',now()-interval '29 days')");
      await pool.query('SELECT snapshot_slow_queries(1000000000)');assert.equal((await pool.query('SELECT query_id FROM slow_query_history WHERE query_id=900001')).rowCount,0);assert.equal((await pool.query('SELECT query_id FROM slow_query_history WHERE query_id=900002')).rowCount,1);
    });
    await t.test('rerunning repair retains existing function OIDs and old rows',async()=>{
      const before=(await pool.query("SELECT oid FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname IN('analyze_slow_queries','snapshot_slow_queries') ORDER BY proname")).rows;
      const data=(await pool.query('SELECT * FROM slow_query_history ORDER BY id')).rows;
      await apply(repair);assert.deepEqual((await pool.query("SELECT oid FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname IN('analyze_slow_queries','snapshot_slow_queries') ORDER BY proname")).rows,before);assert.deepEqual((await pool.query('SELECT * FROM slow_query_history ORDER BY id')).rows,data);
    });
  }finally{
    if(pool)await pool.end();
    try{await admin.query(`DROP DATABASE IF EXISTS ${database}`);await admin.query(`DROP SCHEMA IF EXISTS ${foreignSchema} CASCADE`);}finally{await admin.end();}
  }
});
