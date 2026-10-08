'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const {Pool}=require('pg');
const {parseMigrationFile}=require('../../../database/migrate');const {migrationStatements}=require('../../../database/sqlStatements');
const source=path.resolve(__dirname,'../../../database/pending/20261008_140000__audit_partition_conversion.sql');

test('real audit partition conversion preserves V1 data, identity, writes, views, grants and rollback',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify an isolated PostGIS database');
  const schema=`audit_part_${crypto.randomBytes(8).toString('hex')}`;const reader=`audit_reader_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`CREATE ROLE ${reader}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const migration=parseMigrationFile(await fs.readFile(source,'utf8'));
  async function apply(direction){const c=await fixture.connect();try{await c.query('BEGIN');for(const statement of migrationStatements(migration[direction]))await c.query(statement);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  const parentOid=async()=> (await fixture.query("SELECT 'audit_logs'::regclass::oid AS oid")).rows[0].oid;
  const count=async(table)=>Number((await fixture.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const fields=async()=> (await fixture.query("SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='audit_logs'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows;
  let originalOid,originalFields,oldRows,expressionBody;
  const user=crypto.randomUUID();
  try{
    await fixture.query(await fs.readFile(path.resolve(__dirname,'../../../database/migrations/V1__initial_schema.sql'),'utf8'));
    await fixture.query('ALTER TABLE audit_logs ADD COLUMN encrypted_data bytea,ADD COLUMN encryption_key_id text,ADD COLUMN encryption_iv text,ADD COLUMN service text,ADD COLUMN ip_address inet');
    await fixture.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[user,'audit-partition-owner']);
    await fixture.query('CREATE TABLE audit_trigger_events(action text)');
    await fixture.query(`CREATE FUNCTION mark_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.details=COALESCE(NEW.details,'{}'::jsonb)||'{"marked":true}'::jsonb; INSERT INTO audit_trigger_events VALUES(NEW.action); RETURN NEW; END$$`);
    await fixture.query('CREATE TRIGGER mark_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION mark_audit()');
    await fixture.query("CREATE FUNCTION disabled_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'disabled trigger fired'; END$$");
    await fixture.query('CREATE TRIGGER disabled_audit BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION disabled_audit()');
    await fixture.query('ALTER TABLE audit_logs DISABLE TRIGGER disabled_audit');
    await fixture.query("CREATE INDEX audit_expression_idx ON audit_logs(lower(action)) INCLUDE(user_id) WHERE action<>'ignored'");
    await fixture.query('CREATE VIEW audit_visible AS SELECT id,user_id,action,details,created_at FROM audit_logs');
    await fixture.query(`GRANT USAGE ON SCHEMA ${schema} TO ${reader}; GRANT SELECT,INSERT,UPDATE,DELETE ON audit_logs TO ${reader}; GRANT SELECT ON audit_visible TO ${reader}; GRANT INSERT ON audit_trigger_events TO ${reader}; GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${reader}`);
    for(const [action,date] of [['historic','2020-01-15'],['june','2026-06-15'],['current','2026-10-08']]){
      await fixture.query("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details,created_at,encrypted_data) VALUES($1,$2,'user','entity-preserved','{\"preserved\":true}',$3,$4)",[user,action,date,Buffer.from('preserved-ciphertext')]);
    }
    expressionBody=(await fixture.query("SELECT pg_get_indexdef('audit_expression_idx'::regclass) AS definition")).rows[0].definition.split(' USING ')[1];
    originalOid=await parentOid();originalFields=await fields();oldRows=(await fixture.query('SELECT id,user_id,action,entity_type,entity_id,details,created_at,encrypted_data FROM audit_logs ORDER BY id')).rows;
    await t.test('conversion keeps every original column/type/value and attaches the same storage object',async()=>{
      await apply('up');assert.notEqual(await parentOid(),originalOid);
      assert.equal((await fixture.query("SELECT relkind FROM pg_class WHERE oid='audit_logs'::regclass")).rows[0].relkind,'p');
      assert.equal((await fixture.query("SELECT 'audit_logs_default'::regclass::oid AS oid")).rows[0].oid,originalOid);
      for(const field of originalFields)assert.deepEqual((await fields()).find(row=>row.attname===field.attname),field);
      assert.deepEqual((await fixture.query('SELECT id,user_id,action,entity_type,entity_id,details,created_at,encrypted_data FROM audit_logs ORDER BY id')).rows,oldRows);
      assert.equal(await count('audit_log_identity'),3);assert.equal(await count('audit_visible'),3);
    });
    await t.test('creating ranges moves default data without duplicate trigger effects or missing views',async()=>{
      const events=await count('audit_trigger_events');
      assert.equal((await fixture.query("SELECT minego_create_time_partition('audit_logs','audit_logs_2026_06','2026-06-01+00','2026-07-01+00') AS created")).rows[0].created,true);
      assert.equal(await count('audit_trigger_events'),events);assert.equal(await count('audit_logs'),3);assert.equal(await count('audit_log_identity'),3);assert.equal(await count('audit_visible'),3);
      assert.equal((await fixture.query("SELECT tableoid::regclass::text AS part FROM audit_logs WHERE action='june'")).rows[0].part,'audit_logs_2026_06');
      assert.equal((await fixture.query("SELECT minego_create_time_partition('audit_logs','audit_logs_2026_06','2026-06-01+00','2026-07-01+00') AS created")).rows[0].created,false);
      await assert.rejects(fixture.query("SELECT minego_create_time_partition('audit_logs','audit_logs_2026_06','2026-06-01+00','2026-08-01+00')"),/bounds differ/);
    });
    await t.test('default and explicit-range inserts preserve the serial sequence, trigger effects and global ID uniqueness',async()=>{
      const events=await count('audit_trigger_events');
      const a=(await fixture.query("INSERT INTO audit_logs(user_id,action,created_at) VALUES($1,'ranged','2026-06-20') RETURNING id,tableoid::regclass::text AS part,details",[user])).rows[0];
      const b=(await fixture.query("INSERT INTO audit_logs(user_id,action,created_at) VALUES($1,'default','2035-01-01') RETURNING id,tableoid::regclass::text AS part",[user])).rows[0];
      assert.equal(a.part,'audit_logs_2026_06');assert.equal(b.part,'audit_logs_default');assert.ok(Number(a.id)>3&&Number(b.id)>Number(a.id));assert.equal(a.details.marked,true);
      assert.equal(await count('audit_trigger_events'),events+2);
      await assert.rejects(fixture.query("INSERT INTO audit_logs(id,action,created_at) VALUES($1,'duplicate','2036-01-01')",[a.id]),/Duplicate audit log id/);
      assert.equal(await count('audit_log_identity'),await count('audit_logs'));
      await assert.rejects(fixture.query("INSERT INTO audit_logs(user_id,action) VALUES($1,'invalid user')",[crypto.randomUUID()]),/foreign key/);
    });
    await t.test('concurrent inserts into different time partitions cannot duplicate a logical ID',async()=>{
      const results=await Promise.allSettled([fixture.query("INSERT INTO audit_logs(id,action,created_at) VALUES(9000,'concurrent-a','2026-06-22')"),fixture.query("INSERT INTO audit_logs(id,action,created_at) VALUES(9000,'concurrent-b','2037-01-01')")]);
      assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((await fixture.query('SELECT count(*)::int AS n FROM audit_logs WHERE id=9000')).rows[0].n,1);
    });
    await t.test('date/ID updates and deletes retain exactly one identity entry and disabled trigger state',async()=>{
      await fixture.query("UPDATE audit_logs SET created_at='2027-01-01' WHERE action='june'");
      assert.equal((await fixture.query("SELECT tableoid::regclass::text AS part FROM audit_logs WHERE action='june'")).rows[0].part,'audit_logs_default');
      await fixture.query("UPDATE audit_logs SET id=9100 WHERE action='june'");assert.equal((await fixture.query('SELECT count(*)::int AS n FROM audit_log_identity WHERE id=9100')).rows[0].n,1);
      await fixture.query('DELETE FROM audit_logs WHERE id=9100');assert.equal((await fixture.query('SELECT count(*)::int AS n FROM audit_log_identity WHERE id=9100')).rows[0].n,0);
      assert.equal(await count('audit_log_identity'),await count('audit_logs'));
      assert.equal((await fixture.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='audit_logs'::regclass AND tgname='disabled_audit'")).rows[0].tgenabled,'D');
    });
    await t.test('ordinary views, expression indexes and original reader/writer grants remain effective',async()=>{
      assert.equal(await count('audit_visible'),await count('audit_logs'));
      const definitions=(await fixture.query("SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid='audit_logs'::regclass")).rows.map(row=>row.definition);
      assert.ok(definitions.some(definition=>definition.split(' USING ')[1]===expressionBody));
      const c=await fixture.connect();try{
        await c.query(`SET ROLE ${reader}`);assert.equal(Number((await c.query('SELECT count(*) AS n FROM audit_visible')).rows[0].n),await count('audit_logs'));
        assert.ok((await c.query("INSERT INTO audit_logs(action,created_at) VALUES('role-write','2038-01-01') RETURNING id")).rows[0].id);
      }finally{await c.query('RESET ROLE');c.release();}
    });
    await t.test('bulk duplicate IDs and failed partition attachment roll back every row and trigger change',async()=>{
      const snapshot=(await fixture.query('SELECT * FROM audit_logs ORDER BY id')).rows;
      const events=await count('audit_trigger_events');
      await assert.rejects(fixture.query("INSERT INTO audit_logs(id,action,created_at) VALUES(9800,'bulk-a','2026-06-21'),(9800,'bulk-b','2040-01-01')"),/Duplicate audit log id/);
      assert.deepEqual((await fixture.query('SELECT * FROM audit_logs ORDER BY id')).rows,snapshot);
      await assert.rejects(fixture.query("SELECT minego_create_time_partition('audit_logs','overlap_attempt','2026-05-01+00','2026-07-01+00')"),/overlap/);
      assert.equal((await fixture.query("SELECT to_regclass('overlap_attempt') AS relation")).rows[0].relation,null);
      await fixture.query('CREATE TABLE unrelated_target(important text)');
      await fixture.query("INSERT INTO unrelated_target VALUES('must survive')");
      await assert.rejects(fixture.query("SELECT minego_create_time_partition('audit_logs','unrelated_target','2026-08-01+00','2026-09-01+00')"),/another relation/);
      await assert.rejects(fixture.query("SELECT minego_create_time_partition('audit_logs','bad_bounds','2026-09-01+00','2026-08-01+00')"),/Invalid time/);
      assert.deepEqual((await fixture.query('SELECT * FROM unrelated_target')).rows,[{important:'must survive'}]);
      assert.equal(await count('audit_trigger_events'),events);assert.equal(await count('audit_log_identity'),snapshot.length);
      assert.equal((await fixture.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='audit_logs_default'::regclass AND tgname='disabled_audit'")).rows[0].tgenabled,'D');
    });
    await t.test('concurrent creators recheck committed bounds and move current data exactly once in UTC',async()=>{
      const events=await count('audit_trigger_events');
      const results=await Promise.all([fixture.query("SELECT minego_create_time_partition('audit_logs','audit_logs_2026_10','2026-10-01+00','2026-11-01+00') AS created"),fixture.query("SELECT minego_create_time_partition('audit_logs','audit_logs_2026_10','2026-10-01+00','2026-11-01+00') AS created")]);
      assert.deepEqual(results.map(result=>result.rows[0].created).sort(),[false,true]);
      assert.equal((await fixture.query("SELECT tableoid::regclass::text AS part FROM audit_logs WHERE action='current'")).rows[0].part,'audit_logs_2026_10');
      const c=await fixture.connect();try{
        await c.query("SET TimeZone='Asia/Shanghai'");
        assert.equal((await c.query("SELECT minego_create_time_partition('audit_logs','audit_logs_2026_10','2026-10-01+00','2026-11-01+00') AS created")).rows[0].created,false);
        assert.equal((await c.query('SHOW TimeZone')).rows[0].TimeZone,'Asia/Shanghai');
      }finally{await c.query("SET TimeZone='UTC'");c.release();}
      assert.equal(await count('audit_trigger_events'),events);assert.equal(await count('audit_log_identity'),await count('audit_logs'));
    });
    await t.test('rollback retains old and new rows, original storage/OID, sequence, views and trigger behavior',async()=>{
      const snapshot=(await fixture.query('SELECT * FROM audit_logs ORDER BY id')).rows;const events=await count('audit_trigger_events');
      await apply('down');assert.equal(await parentOid(),originalOid);assert.equal((await fixture.query("SELECT relkind FROM pg_class WHERE oid='audit_logs'::regclass")).rows[0].relkind,'r');
      assert.deepEqual((await fixture.query('SELECT * FROM audit_logs ORDER BY id')).rows,snapshot);assert.equal(await count('audit_trigger_events'),events);assert.equal(await count('audit_visible'),snapshot.length);
      assert.equal((await fixture.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='audit_logs'::regclass AND contype='p'")).rows[0].definition,'PRIMARY KEY (id)');
      assert.equal((await fixture.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='audit_logs'::regclass AND tgname='disabled_audit'")).rows[0].tgenabled,'D');
      const written=(await fixture.query("INSERT INTO audit_logs(action) VALUES('post-rollback') RETURNING id,details")).rows[0];assert.ok(Number(written.id)>3);assert.equal(written.details.marked,true);
    });
  }finally{
    await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.query(`DROP ROLE ${reader}`);await admin.end();
  }
});


test('unsupported audit dependencies fail atomically instead of discarding data or rules',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`audit_guards_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const c=await fixture.connect();
  try{
    await c.query(await fs.readFile(path.resolve(__dirname,'../../../database/migrations/V1__initial_schema.sql'),'utf8'));
    await c.query("INSERT INTO audit_logs(action) VALUES('guarded original')");
    const originalOid=(await c.query("SELECT 'audit_logs'::regclass::oid AS oid")).rows[0].oid;
    const statements=migrationStatements(parseMigrationFile(await fs.readFile(source,'utf8')).up);
    for(const [name,setup,expected] of [
      ['incoming foreign keys','CREATE TABLE audit_references(id bigint REFERENCES audit_logs(id))',/Incoming audit foreign keys/],
      ['additional uniqueness','CREATE UNIQUE INDEX audit_extra_unique ON audit_logs(action)',/Additional audit uniqueness/],
      ['forced RLS','ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY',/Forced audit RLS/],
      ['materialized views','CREATE MATERIALIZED VIEW audit_cached AS SELECT * FROM audit_logs',/Materialized audit views/],
      ['unowned target table',"CREATE TABLE audit_logs_default(important text)",/target already exists/],
    ]){
      await t.test(name,async()=>{
        await c.query('BEGIN');try{
          await c.query(setup);
          await assert.rejects(async()=>{for(const statement of statements)await c.query(statement);},expected);
        }finally{await c.query('ROLLBACK');}
        assert.equal((await c.query("SELECT 'audit_logs'::regclass::oid AS oid")).rows[0].oid,originalOid);
        assert.deepEqual((await c.query('SELECT action FROM audit_logs')).rows,[{action:'guarded original'}]);
        assert.equal((await c.query("SELECT to_regclass('audit_partition_conversion_state') AS relation")).rows[0].relation,null);
        assert.equal((await c.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='audit_logs'::regclass AND contype='p'")).rows[0].definition,'PRIMARY KEY (id)');
      });
    }
  }finally{c.release();await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test('the actual five production parents accept historical and current data and move it to real ranges',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`all_parents_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const c=await fixture.connect();const user=crypto.randomUUID();
  try{
    await c.query(await fs.readFile(path.resolve(__dirname,'../../../database/migrations/V1__initial_schema.sql'),'utf8'));
    await c.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[user,'all-parents-owner']);
    await c.query("INSERT INTO audit_logs(user_id,action,created_at) VALUES($1,'pre-conversion','2020-01-01')",[user]);
    await c.query('BEGIN');
    for(const file of [source,path.resolve(__dirname,'../../../database/pending/repairs/20260610_100000__add_table_partitioning_system.sql')]){
      const parsed=parseMigrationFile(await fs.readFile(file,'utf8'));
      for(const statement of migrationStatements(parsed.up))await c.query(statement);
    }
    await c.query('COMMIT');
    for(const table of ['catch_records','location_updates','audit_logs','event_logs','payment_transactions']){
      await t.test(table,async()=>{
        assert.equal((await c.query('SELECT relkind FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relkind,'p');
        const insert=table==='catch_records'?"INSERT INTO catch_records(id,user_id,pokemon_id,created_at) VALUES($1,$2,$3,$4) RETURNING tableoid::regclass::text AS part":
          table==='location_updates'?"INSERT INTO location_updates(id,user_id,created_at) VALUES($1,$2,$4) RETURNING tableoid::regclass::text AS part":
          table==='event_logs'?"INSERT INTO event_logs(id,user_id,event_type,created_at) VALUES($1,$2,'storage-test',$4) RETURNING tableoid::regclass::text AS part":
          table==='payment_transactions'?"INSERT INTO payment_transactions(id,user_id,order_id,amount,status,created_at) VALUES($1,$2,'storage-test',10,'success',$4) RETURNING tableoid::regclass::text AS part":
          "INSERT INTO audit_logs(user_id,action,created_at) VALUES($2,'storage-test',$4) RETURNING tableoid::regclass::text AS part";
        // Use a four-slot CTE so PostgreSQL has concrete types for unused slots too.
        const sql=`WITH params AS(SELECT $1::uuid AS id,$2::uuid AS user_id,$3::uuid AS pokemon_id,$4::timestamptz AS created_at) ${insert.replaceAll('$1','(SELECT id FROM params)').replaceAll('$2','(SELECT user_id FROM params)').replaceAll('$3','(SELECT pokemon_id FROM params)').replaceAll('$4','(SELECT created_at FROM params)')}`;
        for(const date of ['2020-01-01T00:00:00Z','2026-06-10T12:00:00Z','2026-10-08T12:00:00Z']){
          const written=(await c.query(sql,[crypto.randomUUID(),user,crypto.randomUUID(),date])).rows[0];
          assert.ok(written.part.startsWith(table+'_'));
          if(date.startsWith('2026-10'))assert.equal(written.part,table+'_default');
        }
        const snapshot=(await c.query(`SELECT * FROM ${table} ORDER BY id,created_at`)).rows;
        assert.equal((await c.query("SELECT minego_create_time_partition($1,$2,'2026-10-08T00:00:00Z','2026-10-09T00:00:00Z') AS created",[table,table+'_current_test'])).rows[0].created,true);
        assert.deepEqual((await c.query(`SELECT * FROM ${table} ORDER BY id,created_at`)).rows,snapshot);
        assert.equal((await c.query(`SELECT tableoid::regclass::text AS part FROM ${table} WHERE created_at>='2026-10-08' AND created_at<'2026-10-09'`)).rows[0].part,table+'_current_test');
      });
    }
    assert.equal((await c.query("SELECT 'audit_logs_default'::regclass::oid=(SELECT original_oid FROM audit_partition_conversion_state) AS preserved")).rows[0].preserved,true);
  }catch(error){await c.query('ROLLBACK');throw error;}
  finally{c.release();await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test('a preexisting partitioned audit table survives prerequisite up and down unchanged',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`existing_parent_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const c=await fixture.connect();
  try{
    await c.query('CREATE TABLE audit_logs(id bigint,created_at timestamptz,action text,PRIMARY KEY(id,created_at)) PARTITION BY RANGE(created_at)');
    await c.query('CREATE TABLE existing_audit_default PARTITION OF audit_logs DEFAULT');
    await c.query("INSERT INTO audit_logs VALUES(42,'2026-10-08','existing-data')");
    const original=(await c.query("SELECT 'audit_logs'::regclass::oid AS oid")).rows[0].oid;
    const snapshot=(await c.query('SELECT * FROM audit_logs')).rows;
    const parsed=parseMigrationFile(await fs.readFile(source,'utf8'));
    for(const direction of ['up','down']){
      await c.query('BEGIN');for(const statement of migrationStatements(parsed[direction]))await c.query(statement);await c.query('COMMIT');
      assert.equal((await c.query("SELECT 'audit_logs'::regclass::oid AS oid")).rows[0].oid,original);
      assert.deepEqual((await c.query('SELECT * FROM audit_logs')).rows,snapshot);
    }
    assert.equal((await c.query("SELECT to_regclass('audit_log_identity') AS relation")).rows[0].relation,null);
  }catch(error){await c.query('ROLLBACK');throw error;}
  finally{c.release();await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
