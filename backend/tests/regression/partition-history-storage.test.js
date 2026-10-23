'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {Pool} = require('pg');
const {parseMigrationFile} = require('../../../database/migrate');
const {migrationStatements} = require('../../../database/sqlStatements');
const root = path.resolve(__dirname, '../../..');
const parents = ['catch_records','location_updates','audit_logs','event_logs','payment_transactions'];
const file = '20260619_000000__add_table_partitioning.sql';

async function fixture(run) {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema = `partition_history_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({connectionString:process.env.TEST_DATABASE_URL,max:2,options:`-c search_path=${schema},public`});
  const apply = async sql => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); for(const s of migrationStatements(parseMigrationFile(sql).up)) await client.query(s); await client.query('COMMIT'); }
    catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
  };
  const read = file => fs.readFile(path.join(root,file),'utf8');
  try {
    await pool.query(await read('database/migrations/V1__initial_schema.sql'));
    await apply(await read('database/pending/20261008_140000__audit_partition_conversion.sql'));
    await apply(await read('database/pending/repairs/20260610_100000__add_table_partitioning_system.sql'));
    await run({pool,schema,apply,raw:await read('database/pending/'+file),repair:await read('database/pending/repairs/'+file)});
  } finally {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}

test('original duplicate migration fails actual BOOLEAN helper contract without leaving shadow tables',async()=>fixture(async({pool,apply,raw})=>{
  const before=(await pool.query("SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid='create_partition_if_not_exists(text,text,timestamptz,timestamptz)'::regprocedure")).rows;
  await assert.rejects(apply(raw),e=>e.code==='42P13'&&/return type/.test(e.message));
  assert.deepEqual((await pool.query("SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid='create_partition_if_not_exists(text,text,timestamptz,timestamptz)'::regprocedure")).rows,before);
  for(const parent of parents)assert.equal((await pool.query('SELECT to_regclass($1) AS relation',[parent+'_partitioned'])).rows[0].relation,null);
}));

test('duplicate repair preserves five actual parents, all records, business references and helper metadata',async()=>fixture(async({pool,schema,apply,repair})=>{
  const user=crypto.randomUUID(); await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[user,'partition-history-owner']);
  await pool.query("INSERT INTO catch_records(id,user_id,pokemon_id,location,created_at) VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint(1,2),4326),'2026-06-15')",[crypto.randomUUID(),user,crypto.randomUUID()]);
  await pool.query("INSERT INTO location_updates(id,user_id,location,created_at) VALUES($1,$2,ST_SetSRID(ST_MakePoint(1,2),4326),'2026-06-01')",[crypto.randomUUID(),user]);
  await pool.query("INSERT INTO audit_logs(user_id,action,details,created_at) VALUES($1,'preserved-audit','{\"original\":true}','2026-09-15')",[user]);
  await pool.query("INSERT INTO event_logs(id,user_id,event_type,payload,created_at) VALUES($1,$2,'preserved-event','{\"original\":true}','2026-06-02')",[crypto.randomUUID(),user]);
  await pool.query("INSERT INTO payment_transactions(id,user_id,order_id,amount,status,created_at) VALUES($1,$2,'kept-order',123.45,'paid','2026-09-15')",[crypto.randomUUID(),user]);
  await pool.query('CREATE VIEW retained_history_audit AS SELECT * FROM audit_logs');
  await pool.query("COMMENT ON FUNCTION create_partition_if_not_exists(text,text,timestamptz,timestamptz) IS 'operator helper metadata'");
  await pool.query("COMMENT ON TABLE audit_logs IS 'operator relation metadata'");
  const identities=()=>pool.query("SELECT oid,relname,obj_description(oid,'pg_class') AS comment FROM pg_class WHERE relnamespace=$1::regnamespace AND relname=ANY($2::text[]) ORDER BY relname",[schema,parents]);
  const functions=()=>pool.query("SELECT oid,prorettype,proacl,proconfig,pg_get_functiondef(oid) AS definition,obj_description(oid,'pg_proc') AS comment FROM pg_proc WHERE oid IN('create_partition_if_not_exists(text,text,timestamptz,timestamptz)'::regprocedure,'minego_create_time_partition(text,text,timestamptz,timestamptz)'::regprocedure) ORDER BY oid");
  const ids=(await identities()).rows, fns=(await functions()).rows, records={};
  for(const parent of parents)records[parent]=(await pool.query(`SELECT * FROM ${parent} ORDER BY id`)).rows;
  const juneWeek=(await pool.query("SELECT c.oid,pg_get_expr(c.relpartbound,c.oid) AS bound FROM pg_class c WHERE c.oid='event_logs_2026_w24'::regclass")).rows;
  await apply(repair);
  assert.deepEqual((await identities()).rows,ids);assert.deepEqual((await functions()).rows,fns);
  for(const parent of parents){assert.deepEqual((await pool.query(`SELECT * FROM ${parent} ORDER BY id`)).rows,records[parent]);assert.equal((await pool.query('SELECT to_regclass($1) AS relation',[parent+'_partitioned'])).rows[0].relation,null);}
  assert.deepEqual((await pool.query('SELECT * FROM retained_history_audit ORDER BY id')).rows,records.audit_logs);
  assert.deepEqual((await pool.query("SELECT c.oid,pg_get_expr(c.relpartbound,c.oid) AS bound FROM pg_class c WHERE c.oid='event_logs_2026_w24'::regclass")).rows,juneWeek);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_log_identity')).rows[0].n,records.audit_logs.length);
  for(const [table,target] of [['location_updates','location_updates_2026_06_01'],['audit_logs','audit_logs_2026_09'],['event_logs','event_logs_2026_w23'],['payment_transactions','payment_transactions_2026_09']])assert.equal((await pool.query(`SELECT tableoid::regclass::text AS part FROM ${table}`)).rows[0].part,target);
  const status=(await pool.query('SELECT schemaname,tablename FROM partition_status')).rows;
  assert.ok(status.length>5);assert.ok(status.every(r=>r.schemaname===schema));
  for(const parent of parents)assert.ok(status.some(r=>r.tablename===parent));
  await apply(repair);assert.deepEqual((await identities()).rows,ids);assert.deepEqual((await functions()).rows,fns);
  for(const parent of parents)assert.deepEqual((await pool.query(`SELECT * FROM ${parent} ORDER BY id`)).rows,records[parent]);
}));

test('shadow-layout and incompatible-parent adoption fail atomically and retain operator data',async()=>fixture(async({pool,apply,repair})=>{
  await pool.query('CREATE TABLE catch_records_partitioned(important text)');await pool.query("INSERT INTO catch_records_partitioned VALUES('must survive')");
  await assert.rejects(apply(repair),/explicit adoption/);
  assert.deepEqual((await pool.query('SELECT * FROM catch_records_partitioned')).rows,[{important:'must survive'}]);
  assert.equal((await pool.query("SELECT to_regclass('partition_status') AS relation")).rows[0].relation,null);
  await pool.query('ALTER TABLE catch_records_partitioned RENAME TO preserved_operator_shadow');
  await pool.query('ALTER TABLE payment_transactions RENAME TO preserved_payment_parent');
  await pool.query('CREATE TABLE payment_transactions(important text)');await pool.query("INSERT INTO payment_transactions VALUES('keep regular table')");
  await assert.rejects(apply(repair),/Canonical created_at range parent/);
  assert.deepEqual((await pool.query('SELECT * FROM payment_transactions')).rows,[{important:'keep regular table'}]);
  assert.equal((await pool.query("SELECT to_regclass('partition_status') AS relation")).rows[0].relation,null);
}));

test('custom status view refuses replacement and rolls back new range creation',async()=>fixture(async({pool,apply,repair})=>{
  await pool.query("CREATE VIEW partition_status AS SELECT 'operator-defined'::text AS marker");
  const before=(await pool.query("SELECT 'partition_status'::regclass::oid AS oid,pg_get_viewdef('partition_status'::regclass,true) AS definition")).rows;
  await assert.rejects(apply(repair),/explicit adoption/);
  assert.deepEqual((await pool.query("SELECT 'partition_status'::regclass::oid AS oid,pg_get_viewdef('partition_status'::regclass,true) AS definition")).rows,before);
  assert.deepEqual((await pool.query('SELECT * FROM partition_status')).rows,[{marker:'operator-defined'}]);
  assert.equal((await pool.query("SELECT to_regclass('event_logs_2026_w23') AS relation")).rows[0].relation,null);
  assert.equal((await pool.query("SELECT to_regclass('pg_temp.minego_partition_status_expected') AS relation")).rows[0].relation,null);
}));
