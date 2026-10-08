'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {Pool}=require('pg');

const root=path.resolve(__dirname,'../../..');
const filename1='20261001_000001__fixture_base.sql';
const filename2='20261001_000002__fixture_column.sql';
const first=String.raw`-- migrate:up
BEGIN;
CREATE TABLE migration_fixture(id integer PRIMARY KEY,payload text NOT NULL);
INSERT INTO migration_fixture VALUES (1,'row;it''s');
CREATE FUNCTION migration_fixture_value() RETURNS text AS $fn$ BEGIN RETURN 'value;kept'; END $fn$ LANGUAGE plpgsql;
COMMIT;
-- migrate:down
DROP FUNCTION migration_fixture_value(); DROP TABLE migration_fixture;`;
const second=`-- migrate:up
ALTER TABLE migration_fixture ADD COLUMN extra text;
INSERT INTO migration_fixture VALUES (2,'second','new');
-- migrate:down
DELETE FROM migration_fixture WHERE id=2; ALTER TABLE migration_fixture DROP COLUMN extra;`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('production migration CLI against actual PostgreSQL verifies transactions, checksums, locking and rollback', {timeout:90000},async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
  const schema=`migration_${crypto.randomBytes(8).toString('hex')}`;
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minego-migration-test-'));
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
  const environment={...process.env,DATABASE_URL:url.toString(),MINEGO_MIGRATIONS_DIR:directory};
  delete environment.NODE_PATH;
  const children=new Set();
  function launch(args,overrides={}){
    const child=spawn(process.execPath,[path.join(root,'database/migrate.js'),...args],{cwd:root,env:{...environment,...overrides},stdio:['ignore','pipe','pipe']});
    children.add(child);let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const result=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{children.delete(child);resolve({code,signal,output});});});
    return {child,result};
  }
  const run=(...args)=>launch(args).result;
  const rows=()=>fixture.query('SELECT id,payload FROM migration_fixture ORDER BY id');
  try{
    await t.test('CLI create and status work without NODE_PATH; templates do not pretend to apply SQL',async()=>{
      const created=await run('create','storage fixture');assert.equal(created.code,0);
      const files=await fs.readdir(directory);assert.equal(files.length,1);assert.match(files[0],/^\d{8}_\d{6}__storage_fixture.sql$/);
      const empty=await run('up');assert.equal(empty.code,1);assert.match(empty.output,/no executable SQL/);
      await fs.rm(path.join(directory,files[0]));
      assert.equal((await run('status')).code,0);
      assert.equal((await run('unknown')).code,1);
    });
    await fs.writeFile(path.join(directory,filename1),first);await fs.writeFile(path.join(directory,filename2),second);
    await t.test('actual apply/history/status/verify is durable and idempotent',async()=>{
      const applied=await run('up');assert.equal(applied.code,0,applied.output);
      assert.deepEqual((await rows()).rows,[{id:1,payload:"row;it's"},{id:2,payload:'second'}]);
      assert.equal((await fixture.query('SELECT migration_fixture_value() AS value')).rows[0].value,'value;kept');
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,2);
      const status=await run('status');assert.equal(status.code,0);assert.match(status.output,/Total: 2 executed, 0 pending/);
      assert.equal((await run('verify')).code,0);
      const repeated=await run('up');assert.equal(repeated.code,0);assert.match(repeated.output,/Found 0 pending/);
    });
    await t.test('changed or missing applied scripts block verify, up and down without data changes',async()=>{
      await fs.appendFile(path.join(directory,filename1),'\n-- checksum drift\n');
      for(const command of ['verify','up','down']){const result=await run(command);assert.equal(result.code,1);assert.match(result.output,/checksum mismatch/i);}
      assert.equal((await rows()).rows.length,2);await fs.writeFile(path.join(directory,filename1),first);
      await fs.rename(path.join(directory,filename1),path.join(directory,'saved-source.txt'));
      const missing=await run('verify');assert.equal(missing.code,1);assert.match(missing.output,/file is missing/);
      await fs.rename(path.join(directory,'saved-source.txt'),path.join(directory,filename1));
      assert.equal((await run('verify')).code,0);
    });
    await t.test('duplicate and invalid identities cannot silently skip or apply migrations',async()=>{
      const duplicate=path.join(directory,'20261001_000001__duplicate.sql');await fs.writeFile(duplicate,'SELECT 1;');
      const dup=await run('up');assert.equal(dup.code,1);assert.match(dup.output,/Duplicate migration/);await fs.rm(duplicate);
      const invalid=path.join(directory,'bad-name.sql');await fs.writeFile(invalid,'SELECT 1;');
      assert.equal((await run('up')).code,1);await fs.rm(invalid);
    });
    await t.test('target and last rollback are atomic; empty rollback releases its transaction',async()=>{
      const target=await run('down','20261001_000001');assert.equal(target.code,0,target.output);
      assert.equal((await rows()).rows.length,1);
      assert.equal((await fixture.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='migration_fixture' AND column_name='extra'",[schema])).rows[0].n,0);
      assert.equal((await run('down')).code,0);
      assert.equal((await fixture.query("SELECT to_regclass('migration_fixture') AS name")).rows[0].name,null);
      assert.equal((await run('down')).code,0);
      assert.equal((await run('verify')).code,0);
    });
    await t.test('a real SQL failure rolls back all DDL/data/history including legacy outer transaction wrappers',async()=>{
      const failing=path.join(directory,'20261001_000003__failure.sql');await fs.writeFile(failing,'CREATE TABLE failed_fixture(id int); INSERT INTO failed_fixture VALUES(1); SELECT 1/0;');
      const result=await run('up');assert.equal(result.code,1);assert.match(result.output,/division by zero/);
      assert.doesNotMatch(result.output,/release migration lock|ReferenceError/);
      assert.equal((await fixture.query("SELECT to_regclass('migration_fixture') AS base,to_regclass('failed_fixture') AS failed")).rows[0].base,null);
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,0);
      await fs.rm(failing);
    });
    await t.test('two real CLI processes serialize and apply each migration exactly once',async()=>{
      await fs.writeFile(path.join(directory,filename1),first.replace('CREATE TABLE migration_fixture','SELECT pg_sleep(0.5); CREATE TABLE migration_fixture'));
      const [a,b]=await Promise.all([run('up'),run('up')]);assert.equal(a.code,0,a.output);assert.equal(b.code,0,b.output);
      assert.equal((await rows()).rows.length,2);assert.equal((await fixture.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,2);
      // Retain the exact applied source checksum until rollback completes.
      assert.equal((await run('down','20261001_000001')).code,0);assert.equal((await run('down')).code,0);
      await fs.writeFile(path.join(directory,filename1),first);
    });
    await t.test('lock timeout honors configuration, and a killed owner releases its lock and transaction',async()=>{
      const owner=await fixture.connect();try{
        await owner.query('BEGIN');await owner.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':minego:migrations',0))");
        const blocked=await launch(['up'],{MIGRATION_LOCK_TIMEOUT_MS:'100'}).result;
        assert.equal(blocked.code,1);assert.match(blocked.output,/lock timeout/);
      }finally{await owner.query('ROLLBACK');owner.release();}
      await fs.writeFile(path.join(directory,filename1),first.replace('CREATE TABLE migration_fixture','SELECT pg_sleep(10) /* minego_owned_crash_fixture */; CREATE TABLE migration_fixture'));
      const killed=launch(['up']);let backendPid;
      for(let attempt=0;attempt<50;attempt++){
        const activity=await admin.query("SELECT pid FROM pg_stat_activity WHERE state='active' AND query LIKE '%minego_owned_crash_fixture%' AND pid<>pg_backend_pid()");
        if(activity.rowCount){backendPid=activity.rows[0].pid;break;}await sleep(50);
      }
      assert.ok(backendPid,'Owned CLI must hold the real transaction before interruption');killed.child.kill('SIGKILL');assert.equal((await killed.result).signal,'SIGKILL');
      // A server executing pg_sleep may observe client loss only after that
      // command returns. Confirm that exact owned session has ended before
      // asserting its transaction lock was released, rather than assuming it.
      let sessionClosed=false;
      for(let attempt=0;attempt<150;attempt++){
        const activity=await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[backendPid]);
        if(!activity.rowCount){sessionClosed=true;break;}await sleep(100);
      }
      assert.ok(sessionClosed,'Interrupted owner must eventually release its database session');
      await fs.writeFile(path.join(directory,filename1),first);
      const recovered=await launch(['up'],{MIGRATION_LOCK_TIMEOUT_MS:'3000'}).result;assert.equal(recovered.code,0,recovered.output);
      assert.equal((await rows()).rows.length,2);
    });
    await t.test('shared startup initialization executes pending SQL and closes its owned pool',async()=>{
      const startupFile=path.join(directory,'20261001_000004__startup.sql');await fs.writeFile(startupFile,'-- migrate:up\nCREATE TABLE initialized_on_start(id int);\n-- migrate:down\nDROP TABLE initialized_on_start;');
      const child=spawn(process.execPath,['-e',"const db=require('./backend/shared/db'); Promise.all([db.initializeMigrations(),db.initializeMigrations()]).catch(e=>{console.error(e.message);process.exitCode=1});"],{cwd:root,env:{...environment,AUTO_MIGRATE:'true'},stdio:['ignore','pipe','pipe']});
      children.add(child);let output='';child.stderr.on('data',b=>output+=b);child.stdout.on('data',b=>output+=b);
      const code=await new Promise(resolve=>child.once('exit',code=>{children.delete(child);resolve(code);}));assert.equal(code,0,output);
      assert.equal((await fixture.query("SELECT to_regclass('initialized_on_start') AS name")).rows[0].name,'initialized_on_start');
      assert.equal((await fixture.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,3);
    });
  }finally{
    await Promise.all([...children].map(child=>new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL');})));
    await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await fs.rm(directory,{recursive:true,force:true});
  }
});
