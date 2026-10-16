'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const crypto=require('node:crypto');const fs=require('node:fs/promises');const path=require('node:path');
const {Pool}=require('pg');const {TransactionManager}=require('../../shared/TransactionManager');
const {migrationStatements}=require('../../../database/sqlStatements');
const root=path.resolve(__dirname,'../../..');const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('actual production transaction ownership, isolation, contention and cleanup',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema='tx_owner_'+crypto.randomBytes(8).toString('hex');const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:2,options:`-c search_path=${schema},public`});
  const manager=new TransactionManager(pool,{retryDelayBase:0,maxRetryDelay:0});
  const a=crypto.randomUUID(),b=crypto.randomUUID();let shared;
  const raw=await fs.readFile(path.join(root,'database/pending/20260626_040000__add_deadlock_log_table.sql'),'utf8');
  const repaired=await fs.readFile(path.join(root,'database/pending/repairs/20260626_040000__add_deadlock_log_table.sql'),'utf8');
  const apply=async sql=>{const c=await pool.connect();try{await c.query('BEGIN');for(const s of migrationStatements(sql))await c.query(s);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
  const xp=async()=>Number((await pool.query('SELECT xp FROM users WHERE id=$1',[a])).rows[0].xp);
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query('INSERT INTO users(id,nickname,stardust) VALUES($1,$2,10000),($3,$4,10000)',[a,'transaction-a',b,'transaction-b']);
    await t.test('original malformed header fails actual PostgreSQL with no partial table',async()=>{await assert.rejects(apply(raw),{code:'42601'});assert.equal((await pool.query("SELECT to_regclass('deadlock_log') AS relation")).rows[0].relation,null);});
    await t.test('source-bound repair retains existing log identity, rows and indexes',async()=>{
      await pool.query('CREATE TABLE deadlock_log(id SERIAL PRIMARY KEY,code VARCHAR(10) NOT NULL,message TEXT,detail TEXT,processes JSONB,context JSONB,created_at TIMESTAMP DEFAULT NOW())');
      await pool.query("INSERT INTO deadlock_log(code,message,context) VALUES('40P01','historic','{\"legacy\":true}')");
      const original=(await pool.query('SELECT * FROM deadlock_log')).rows[0];const originalOid=(await pool.query("SELECT 'deadlock_log'::regclass::oid AS oid")).rows[0].oid;
      await pool.query('CREATE VIEW retained_deadlock_history AS SELECT * FROM deadlock_log');await pool.query('CREATE TABLE deadlock_reference(id integer REFERENCES deadlock_log(id))');await pool.query('INSERT INTO deadlock_reference VALUES($1)',[original.id]);
      await apply(repaired);assert.deepEqual((await pool.query('SELECT * FROM retained_deadlock_history')).rows[0],original);
      const upgraded=(await pool.query('SELECT * FROM deadlock_log')).rows[0];assert.equal(upgraded.retry_count,null);assert.equal(upgraded.transaction_name,null);assert.equal((await pool.query("SELECT 'deadlock_log'::regclass::oid AS oid")).rows[0].oid,originalOid);
      assert.equal((await pool.query('SELECT id FROM deadlock_reference')).rows[0].id,original.id);
      const oid=(await pool.query("SELECT 'deadlock_log'::regclass::oid AS oid")).rows[0].oid;const before=(await pool.query('SELECT * FROM deadlock_log')).rows;
      await apply(repaired);assert.equal((await pool.query("SELECT 'deadlock_log'::regclass::oid AS oid")).rows[0].oid,oid);assert.deepEqual((await pool.query('SELECT * FROM deadlock_log')).rows,before);
    });
    for(const isolationLevel of ['READ COMMITTED','REPEATABLE READ','SERIALIZABLE'])await t.test('actual '+isolationLevel+' commits on one owned client with local timeout reset',async()=>{
      const observed=await manager.execute(async c=>{const level=(await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation;await c.query('UPDATE users SET xp=xp+1 WHERE id=$1',[a]);return level;},{isolationLevel});
      assert.equal(observed,isolationLevel.toLowerCase());assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout,'0');assert.equal(manager.getActiveTransactionCount(),0);
    });
    await t.test('real constraint error rolls back earlier resource writes and does not retry',async()=>{
      const before=await xp();let attempts=0;
      await assert.rejects(manager.execute(async c=>{attempts++;await c.query('UPDATE users SET xp=xp+10 WHERE id=$1',[a]);await c.query('UPDATE users SET stardust=-1 WHERE id=$1',[a]);}),{code:'23514'});
      assert.equal(attempts,1);assert.equal(await xp(),before);assert.equal(manager.getActiveTransactionCount(),0);
    });
    await t.test('invalid isolation and retry/timeout inputs acquire no connection or mutate money',async()=>{
      for(const options of [{isolationLevel:'constructor'},{isolationLevel:'READ COMMITTED;COMMIT'},{maxRetries:-1},{maxRetries:NaN},{timeout:0},{timeout:'30'},{retryOnDeadlock:'yes'}])await assert.rejects(manager.execute(c=>c.query('UPDATE users SET stardust=0'),options),/Invalid/);
      assert.equal((await pool.query('SELECT sum(stardust)::int AS total FROM users')).rows[0].total,20000);
    });
    await t.test('callbacks cannot commit or end the owned scope through comments or batched SQL',async()=>{
      const before=await xp();
      for(const command of ['COMMIT','ROLLBACK','/* outer /* nested */ comment */ END','SELECT 1; COMMIT',"PREPARE TRANSACTION 'not_owned'",'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'])await assert.rejects(manager.execute(async c=>{await c.query('UPDATE users SET xp=xp+10 WHERE id=$1',[a]);await c.query(command);}),/owned by the manager/);
      assert.equal(await xp(),before);
      await manager.execute(async c=>{await c.query('SAVEPOINT recoverable');await c.query('UPDATE users SET xp=xp+10 WHERE id=$1',[a]);await c.query('ROLLBACK TO SAVEPOINT recoverable');await c.query("SELECT ';COMMIT' AS ordinary_literal");});assert.equal(await xp(),before);
    });
    await t.test('caught SQL errors cannot turn PostgreSQL implicit rollback into a successful result',async()=>{
      const before=await xp();await assert.rejects(manager.execute(async c=>{await c.query('UPDATE users SET xp=xp+10 WHERE id=$1',[a]);try{await c.query('UPDATE users SET stardust=-1 WHERE id=$1',[a]);}catch{}return 'not committed';}),{code:'25P02'});assert.equal(await xp(),before);
    });
    await t.test('unawaited in-flight SQL completes before the owned transaction reports a commit',async()=>{
      const before=await xp();let finished=false;
      const result=await manager.execute(c=>{
        c.query('WITH delay AS MATERIALIZED (SELECT pg_sleep(0.02)) UPDATE users SET xp=xp+1 FROM delay WHERE id=$1',[a]).then(()=>{finished=true;},()=>{});
        return 'queued result';
      });
      assert.equal(result,'queued result');assert.equal(finished,true);assert.equal(await xp(),before+1);
    });
    await t.test('unawaited pending SQL failure rolls back previous writes and cannot report success',async()=>{
      const before=await xp();
      await assert.rejects(manager.execute(async c=>{
        await c.query('UPDATE users SET xp=xp+10 WHERE id=$1',[a]);
        c.query('UPDATE users SET stardust=-1 WHERE id=$1',[a]);
        return 'not committed';
      }),{code:'23514'});
      assert.equal(await xp(),before);assert.equal(manager.getActiveTransactionCount(),0);
    });
    await t.test('JavaScript deadline rolls back and prevents late writes after the same client is reused',async()=>{
      const before=await xp();let late;
      await assert.rejects(manager.execute(async c=>{await c.query('UPDATE users SET xp=xp+100 WHERE id=$1',[a]);await delay(100);try{await c.query('UPDATE users SET xp=xp+1000 WHERE id=$1',[a]);}catch(e){late=e;throw e;}},{timeout:30}),{code:'57014'});
      await manager.execute(c=>c.query('UPDATE users SET xp=xp+1 WHERE id=$1',[a]));await delay(120);assert.equal(late.code,'57014');assert.equal(await xp(),before+1);assert.equal(manager.getActiveTransactionCount(),0);
    });
    await t.test('actual pg_sleep deadline cancels owned SQL and clears all earlier uncommitted data',async()=>{
      const before=await xp();await assert.rejects(manager.execute(async c=>{await c.query('UPDATE users SET xp=xp+100 WHERE id=$1',[a]);await c.query('SELECT pg_sleep(1)');},{timeout:40}),{code:'57014'});
      assert.equal(await xp(),before);assert.equal(manager.getActiveTransactionCount(),0);assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n,1);
    });
    await t.test('deadline includes a queued checkout and releases the eventual late lease',async()=>{
      const one=await pool.connect(),two=await pool.connect();let called=false;
      try{await assert.rejects(manager.execute(async()=>{called=true;},{timeout:25}),{code:'57014'});assert.equal(called,false);}finally{one.release();two.release();}
      await delay(20);assert.equal(pool.waitingCount,0);assert.equal(pool.idleCount,pool.totalCount);assert.equal(manager.getActiveTransactionCount(),0);
    });
    await t.test('genuine lock-not-available is not relabeled or automatically retried',async()=>{
      const holder=await pool.connect();await holder.query('BEGIN');await holder.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[a]);let attempts=0;
      try{await assert.rejects(manager.execute(async c=>{attempts++;await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[a]);}),{code:'55P03'});assert.equal(attempts,1);}finally{await holder.query('ROLLBACK');holder.release();}
    });
    await t.test('real SERIALIZABLE conflicts retry exactly three times and persist every event',async()=>{
      let attempts=0;const before=await xp();
      await assert.rejects(manager.execute(async c=>{attempts++;await c.query('SELECT xp FROM users WHERE id=$1',[a]);await pool.query('UPDATE users SET xp=xp+1 WHERE id=$1',[a]);await c.query('UPDATE users SET xp=xp+100 WHERE id=$1',[a]);},{isolationLevel:'SERIALIZABLE',transactionName:'serialization_exhaust'}),{code:'40001'});
      assert.equal(attempts,4);assert.equal(await xp(),before+4);
      const logs=(await pool.query("SELECT retry_count,context FROM deadlock_log WHERE transaction_name='serialization_exhaust' ORDER BY id")).rows;
      assert.deepEqual(logs.map(r=>r.retry_count),[1,2,3,3]);assert.deepEqual(logs.map(r=>r.context.willRetry),[true,true,true,false]);
    });
    await t.test('disabled contention retry leaves the failed SERIALIZABLE write rolled back',async()=>{
      let attempts=0;const before=await xp();await assert.rejects(manager.execute(async c=>{attempts++;await c.query('SELECT xp FROM users WHERE id=$1',[a]);await pool.query('UPDATE users SET xp=xp+1 WHERE id=$1',[a]);await c.query('UPDATE users SET xp=xp+100 WHERE id=$1',[a]);},{isolationLevel:'SERIALIZABLE',retryOnDeadlock:false,transactionName:'no_retry'}),{code:'40001'});assert.equal(attempts,1);assert.equal(await xp(),before+1);
    });
    await t.test('blocked contention audit obeys the same operation deadline and does not start a late retry',async()=>{
      const holder=await pool.connect();await holder.query('BEGIN');await holder.query('LOCK TABLE deadlock_log IN ACCESS EXCLUSIVE MODE');let attempts=0;
      const work=manager.execute(async c=>{attempts++;await c.query('SELECT xp FROM users WHERE id=$1',[a]);await admin.query(`UPDATE ${schema}.users SET xp=xp+1 WHERE id=$1`,[a]);await c.query('UPDATE users SET xp=xp+100 WHERE id=$1',[a]);},{isolationLevel:'SERIALIZABLE',timeout:200,transactionName:'bounded_audit'});
      const outcome=work.then(value=>({value}),error=>({error}));let watchdog;
      try{const observed=await Promise.race([outcome,new Promise(resolve=>watchdog=setTimeout(()=>resolve({overBudget:true}),800))]);assert.equal(observed.overBudget,undefined,'Audit must not hold the operation for its independent1s cleanup window');assert.equal(observed.error.code,'57014');assert.equal(attempts,1);}
      finally{clearTimeout(watchdog);await holder.query('ROLLBACK');holder.release();await outcome;}
      assert.equal(manager.getActiveTransactionCount(),0);
    });
    await t.test('genuine two-owner deadlock retries the victim and commits each resource change once',async()=>{
      let arrivals=0,release;const both=new Promise(resolve=>release=resolve);
      const fn=(first,second)=>{let attempt=0;return async c=>{attempt++;await c.query("SET LOCAL deadlock_timeout='20ms'");await c.query('UPDATE users SET premium_coins=premium_coins+1 WHERE id=$1',[first]);if(attempt===1){if(++arrivals===2)release();await both;}await c.query('UPDATE users SET premium_coins=premium_coins+1 WHERE id=$1',[second]);};};
      await Promise.all([manager.execute(fn(a,b),{transactionName:'deadlock_a'}),manager.execute(fn(b,a),{transactionName:'deadlock_b'})]);
      assert.deepEqual((await pool.query('SELECT premium_coins FROM users ORDER BY nickname')).rows,[{premium_coins:2},{premium_coins:2}]);
      const event=(await pool.query("SELECT code,processes,context FROM deadlock_log WHERE code='40P01' AND transaction_name LIKE 'deadlock_%' ORDER BY id DESC LIMIT 1")).rows[0];assert.equal(event.code,'40P01');assert.ok(event.processes.length>=2);assert.equal(event.context.willRetry,true);
    });
    await t.test('active transaction observations and real registry return to zero after settlement',async()=>{
      let entered,finish;const started=new Promise(resolve=>entered=resolve),done=new Promise(resolve=>finish=resolve);
      const work=manager.execute(async c=>{await c.query('SELECT 1');entered();await done;},{transactionName:'active_observation'});await started;assert.equal(manager.getActiveTransactionCount(),1);assert.equal(manager.getActiveTransactions()[0].name,'active_observation');finish();await work;assert.equal(manager.getActiveTransactionCount(),0);
      const text=await require('../../shared/metrics').register.metrics();assert.match(text,/db_deadlock_retries_total\{service="default",isolation_level="SERIALIZABLE"\} 3/);assert.match(text,/db_active_transactions\{service="default"\} 0/);assert.match(text,/db_transaction_duration_seconds_count/);
    });
    await t.test('lost commit connection reports uncertainty without retrying or leaking its owned lease',async()=>{
      await pool.query('CREATE TABLE owned_commit_guard(id uuid PRIMARY KEY)');
      await pool.query("CREATE FUNCTION owned_commit_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(5); RETURN NEW; END$$");
      await pool.query('CREATE CONSTRAINT TRIGGER owned_commit_delay AFTER INSERT ON owned_commit_guard DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_commit_wait()');
      let pid,tag,entered,attempts=0;const ready=new Promise(resolve=>entered=resolve);
      const work=manager.execute(async c=>{attempts++;pid=c.processID;tag=(await c.query('SHOW application_name')).rows[0].application_name;await c.query('INSERT INTO owned_commit_guard VALUES($1)',[crypto.randomUUID()]);entered();},{timeout:3000});
      const outcome=work.then(value=>({value}),error=>({error}));await ready;
      let waiting=false;for(let i=0;i<100;i++){const row=(await pool.query('SELECT query,wait_event FROM pg_stat_activity WHERE pid=$1 AND application_name=$2',[pid,tag])).rows[0];if(row?.query==='COMMIT'&&row.wait_event==='PgSleep'){waiting=true;break;}await delay(5);}
      assert.equal(waiting,true,'Owned commit must be observed before disconnecting it');
      const killed=await admin.query('SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE pid=$1 AND application_name=$2 AND usename=current_user AND datname=current_database()',[pid,tag]);assert.equal(killed.rows[0].stopped,true);
      const result=await outcome;assert.equal(result.error.commitOutcomeUnknown,true);assert.equal(attempts,1);assert.equal(manager.getActiveTransactionCount(),0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM owned_commit_guard')).rows[0].n,0);
    });
    await t.test('public db transaction and all three legacy convenience APIs run actual production manager',async()=>{
      const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();
      shared=require('../../shared/db');const wrappers=require('../../shared/transactionManager');
      const calls=[['READ COMMITTED',shared.transaction],['READ COMMITTED',wrappers.transactionReadCommitted],['REPEATABLE READ',wrappers.transactionRepeatableRead],['SERIALIZABLE',wrappers.transactionSerializable]];
      for(const [wanted,fn]of calls){const level=await fn(async c=>{await c.query('UPDATE users SET xp=xp+1 WHERE id=$1',[a]);return (await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation;});assert.equal(level,wanted.toLowerCase());}
      assert.equal((await wrappers.getDeadlockStats()).database,new URL(process.env.TEST_DATABASE_URL).pathname.slice(1));
    });
    await t.test('actual default currency service publishes through the public managed db transaction',async()=>{
      await apply(await fs.readFile(path.join(root,'database/pending/repairs/20260624_133000__add_multi_currency_support.sql'),'utf8'));
      const service=require('../../shared/exchangeRateService');await service.saveRate('USD','CNY','7.24','manual');
      assert.equal(await service.getRate('USD','CNY'),7.24);assert.equal((await service.convert('1.005','USD','CNY')).amountExact,'7.28');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM exchange_rates WHERE is_current AND from_currency='USD' AND to_currency='CNY'")).rows[0].n,1);
    });
  }finally{if(shared)await shared.closePools();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
