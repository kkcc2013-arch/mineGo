'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { parseMigrationFile } = require('../../../database/migrate');
const { migrationStatements } = require('../../../database/sqlStatements');
const root = path.resolve(__dirname,'../../..');
const bootstrap = 'database/pending/20261007_120000__title_identity_compatibility.sql';
const repair = 'database/pending/repairs/20260615_170500__add_title_system.sql';
async function apply(pool,file) {
  if(file===bootstrap) {
    const manifest=JSON.parse(await fs.readFile(path.join(root,'database/pending/repairs.json'),'utf8'));
    const entry=manifest.repairs['20261007_120000'];
    const raw=await fs.readFile(path.join(root,file));
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),entry.sourceSha256);
    file=path.join('database/pending',entry.file);
  }
  const parsed=parseMigrationFile(await fs.readFile(path.join(root,file),'utf8'));
  const c=await pool.connect();
  try { await c.query('BEGIN'); for(const sql of migrationStatements(parsed.up)) await c.query(sql); await c.query('COMMIT'); }
  catch(error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
}
async function fixture(fn) {
  assert.ok(process.env.TEST_DATABASE_URL,'isolated PostGIS is required');
  const schema=`title_upgrade_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL}); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const owner=crypto.randomUUID();
  try {
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[owner,'title-upgrade']);
    await fn({pool,owner});
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}
async function snapshot(pool) {
  return {
    definitions:(await pool.query('SELECT * FROM title_definitions ORDER BY title_id')).rows,
    titles:(await pool.query('SELECT * FROM user_titles ORDER BY id')).rows,
    objects:(await pool.query("SELECT oid,relname FROM pg_class WHERE oid IN('title_definitions'::regclass,'user_titles'::regclass,'user_title_stats'::regclass) ORDER BY oid")).rows,
    triggers:(await pool.query("SELECT oid,tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='title_definitions'::regclass AND NOT tgisinternal ORDER BY oid")).rows,
    functions:(await pool.query("SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname='update_title_definitions_updated_at'")).rows,
    keys:(await pool.query("SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='user_titles'::regclass ORDER BY oid")).rows
  };
}
test('later title repair retains populated bootstrap identities, trigger state and operator values',async t=>fixture(async({pool,owner})=>{
  await apply(pool,bootstrap);
  await pool.query("INSERT INTO user_titles(user_id,title_id,source_type,unlocked_at) VALUES($1,'novice_trainer','gift','2020-01-01')",[owner]);
  await pool.query("UPDATE title_definitions SET name='{\"en\":\"Operator title\"}',stat_bonuses='{\"catch_rate\":0.02}' WHERE title_id='novice_trainer'");
  const before=await snapshot(pool); await apply(pool,repair);
  await t.test('existing data, OIDs, keys, function and trigger definitions remain exact',async()=>assert.deepEqual(await snapshot(pool),before));
  await t.test('update trigger still executes its actual timestamp contract',async()=>{
    await pool.query("UPDATE title_definitions SET updated_at='2020-01-01' WHERE title_id='novice_trainer'");
    assert.ok((await pool.query("SELECT updated_at>timestamp '2020-01-01' AS changed FROM title_definitions WHERE title_id='novice_trainer'")).rows[0].changed);
  });
  await t.test('disabled matching trigger stays disabled with its original identity',async()=>{
    await pool.query('ALTER TABLE title_definitions DISABLE TRIGGER trigger_update_title_definitions_updated_at');
    const before=await snapshot(pool); await apply(pool,bootstrap); await apply(pool,repair); assert.deepEqual(await snapshot(pool),before);
  });
  await t.test('repeated repaired SQL does not duplicate definitions, owned titles or triggers',async()=>{
    const before=await snapshot(pool); await apply(pool,repair); assert.deepEqual(await snapshot(pool),before);
    assert.equal(before.definitions.length,20);assert.equal(before.titles.length,1);assert.equal(before.triggers.length,1);
  });
}));
test('without a bootstrap, the repair creates and executes the exact original title update contract',async()=>fixture(async({pool})=>{
  await apply(pool,repair);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM title_definitions')).rows[0].n,18);
  await pool.query("UPDATE title_definitions SET updated_at='2020-01-01' WHERE title_id='novice_trainer'");
  assert.ok((await pool.query("SELECT updated_at>timestamp '2020-01-01' AS changed FROM title_definitions WHERE title_id='novice_trainer'")).rows[0].changed);
}));
test('custom title function or trigger metadata refuses an atomic overwrite',async t=>{
  for(const [name,sql,pattern] of [
    ['custom body',"CREATE OR REPLACE FUNCTION update_title_definitions_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=timestamp '2020-01-01'; RETURN NEW; END; $$",/title update function/],
    ['security definer','ALTER FUNCTION update_title_definitions_updated_at() SECURITY DEFINER',/title update function/],
    ['custom search path',"ALTER FUNCTION update_title_definitions_updated_at() SET search_path=public",/title update function/],
    ['custom volatility','ALTER FUNCTION update_title_definitions_updated_at() STABLE',/title update function/],
    ['custom event',`DROP TRIGGER trigger_update_title_definitions_updated_at ON title_definitions; CREATE TRIGGER trigger_update_title_definitions_updated_at BEFORE INSERT ON title_definitions FOR EACH ROW EXECUTE FUNCTION update_title_definitions_updated_at()`,/title update trigger/],
    ['custom condition',`DROP TRIGGER trigger_update_title_definitions_updated_at ON title_definitions; CREATE TRIGGER trigger_update_title_definitions_updated_at BEFORE UPDATE ON title_definitions FOR EACH ROW WHEN(NEW.is_active) EXECUTE FUNCTION update_title_definitions_updated_at()`,/title update trigger/]
  ]) await t.test(name,async()=>fixture(async({pool})=>{
    await apply(pool,bootstrap); await pool.query(sql); const before=await snapshot(pool);
    for(const file of [bootstrap,repair]) { await assert.rejects(apply(pool,file),pattern);assert.deepEqual(await snapshot(pool),before); }
  }));
});
