'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {Pool} = require('pg');
const {ensureStorageExtensions} = require('./storageSetup');
const {ErasureResourcePlanner} = require('../../shared/erasure/ErasureResourcePlanner');
const run = promisify(execFile), root = path.resolve(__dirname, '../../..');

test('actual complete-schema erasure inventory binds a consistent subject snapshot and exposes unreviewed deletion effects', {timeout:120000}, async t => {
  assert.ok(process.env.TEST_DATABASE_URL, 'An isolated real PostgreSQL database is required');
  const suffix = crypto.randomBytes(8).toString('hex'), schema = 'erasure_plan_' + suffix;
  const outside = schema + '_outside', reader = 'erasure_reader_' + suffix;
  const admin = new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
  let pool, roleCreated = false;
  const subject = crypto.randomUUID(), other = crypto.randomUUID();
  const request = {id:crypto.randomUUID(),user_id:subject,request_type:'full',requested_data_types:['all'],verified_at:null,approval_status:'pending',execute_after:null};
  const planner = new ErasureResourcePlanner();
  async function snapshot(fn) {
    const client = await pool.connect();
    try {await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const result = await fn(client);await client.query('ROLLBACK');return result;}
    catch (error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }
  let baseline;
  try {
    await ensureStorageExtensions(admin);
    await admin.query('CREATE SCHEMA ' + schema);await admin.query('CREATE SCHEMA ' + outside);
    const url = new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path=' + schema + ',public');
    pool = new Pool({connectionString:url.toString(),max:2});
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query(await fs.readFile(path.join(root,'database/seeds/V2__seed_data.sql'),'utf8'));
    const migrated = await run(process.execPath,[path.join(root,'database/migrate.js'),'up'],{cwd:root,env:{...process.env,DATABASE_URL:url.toString()},maxBuffer:4000000});
    assert.match(migrated.stdout,/87/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,87);
    await pool.query("INSERT INTO users(id,nickname) VALUES($1,'plan subject'),($2,'unrelated owner')",[subject,other]);
    await pool.query('INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) SELECT $1,25,100,10,10,1,2,3 FROM generate_series(1,2)',[subject]);
    await pool.query('INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) VALUES($1,25,200,20,20,1,2,3)',[other]);
    await pool.query('CREATE TABLE "erasure ""quoted; resource"(user_id uuid,private_note text)');
    await pool.query('INSERT INTO "erasure ""quoted; resource" VALUES($1,$3),($2,$3)',[subject,other,'must never appear in report']);
    await pool.query('CREATE TABLE erasure_retained_integer(user_id integer,private_note text); INSERT INTO erasure_retained_integer VALUES(77,\'retained integer history\')');
    await pool.query('CREATE TABLE erasure_actor_reference(contact uuid REFERENCES users(id))');
    await pool.query('INSERT INTO erasure_actor_reference VALUES($1),($2)',[subject,other]);
    await pool.query('CREATE TABLE erasure_uuid_array(user_ids uuid[],details jsonb)');
    await pool.query('INSERT INTO erasure_uuid_array VALUES(ARRAY[$1::uuid],jsonb_build_object(\'private\',$2::text))',[subject,'private embedded document']);
    await pool.query('CREATE TABLE erasure_partitioned(user_id uuid,day integer) PARTITION BY RANGE(day); CREATE TABLE erasure_partitioned_child PARTITION OF erasure_partitioned FOR VALUES FROM(0) TO(100)');
    await pool.query('INSERT INTO erasure_partitioned VALUES($1,1),($1,2),($2,3)',[subject,other]);
    await pool.query('CREATE TABLE erasure_rls(user_id uuid); ALTER TABLE erasure_rls ENABLE ROW LEVEL SECURITY; ALTER TABLE erasure_rls FORCE ROW LEVEL SECURITY; CREATE POLICY invisible ON erasure_rls USING(FALSE)');
    await pool.query('INSERT INTO erasure_rls VALUES($1),($2)',[subject,other]);
    await pool.query('CREATE TABLE erasure_unsafe_parent(user_id uuid,day integer) PARTITION BY RANGE(day); CREATE TABLE erasure_unsafe_child PARTITION OF erasure_unsafe_parent FOR VALUES FROM(0) TO(100); ALTER TABLE erasure_unsafe_child ENABLE ROW LEVEL SECURITY');
    await pool.query("CREATE FUNCTION planner_view_guard() RETURNS uuid LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'a view must not be executed'; END$$; CREATE VIEW erasure_private_view AS SELECT planner_view_guard() AS user_id");
    await pool.query('CREATE RULE erasure_no_delete AS ON DELETE TO erasure_retained_integer DO INSTEAD NOTHING');
    await pool.query("CREATE FUNCTION planner_effect() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; CREATE TRIGGER erasure_effect BEFORE INSERT ON erasure_actor_reference FOR EACH ROW EXECUTE FUNCTION planner_effect()");
    await pool.query('CREATE TABLE ' + outside + '.external_reference(pokemon_id uuid REFERENCES ' + schema + '.pokemon_instances(id) ON DELETE CASCADE)');
    await pool.query('INSERT INTO ' + outside + '.external_reference SELECT id FROM pokemon_instances WHERE user_id=$1 LIMIT 1',[subject]);
    await t.test('rejects non-snapshot reads and invalid subject identity', async () => {
      await assert.rejects(planner.inspect(pool,request),error=>error.code==='ERASURE_PLAN_SNAPSHOT_REQUIRED');
      await snapshot(client=>assert.rejects(planner.inspect(client,{...request,user_id:'------------------------------------'}),error=>error.code==='ERASURE_PLAN_SUBJECT_INVALID'));
    });
    await t.test('inventories every actual relation with canonical FK associations, real counts and private projections', async () => {
      baseline = await snapshot(client=>planner.inspect(client,request));
      process.stdout.write(JSON.stringify({erasureInventory:{...baseline.counts,executionReady:baseline.executionReady,isolation:baseline.isolation}})+'\n');
      const actual = (await pool.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN('r','p','f','v','m') ORDER BY c.relname")).rows.map(r=>r.relname);
      assert.deepEqual(baseline.resources.map(r=>r.name),actual);assert.ok(actual.length>500);
      assert.equal(baseline.resources.find(r=>r.name==='pokemon_instances').associatedRows,'2');
      assert.equal(baseline.resources.find(r=>r.name==='users').associatedRows,'1');
      const unusual = baseline.resources.find(r=>r.name==='erasure "quoted; resource');assert.equal(unusual.associatedRows,'1');assert.equal(unusual.associations[0].basis,'name_requires_ownership_review');
      const reference = baseline.resources.find(r=>r.name==='erasure_actor_reference');assert.equal(reference.associatedRows,'1');assert.equal(reference.associations[0].basis,'foreign_key_association');
      assert.equal(baseline.executionReady,false);assert.equal(baseline.isolation,'repeatable read');
      assert.ok(!JSON.stringify(baseline).includes('must never appear in report'));assert.ok(!JSON.stringify(baseline).includes('private embedded document'));
      assert.equal((await pool.query('SELECT id FROM data_erasure_tasks')).rowCount,0);
      assert.equal((await pool.query('SELECT id FROM pokemon_instances')).rowCount,3);
    });
    await t.test('exposes all incoming cascades, external namespaces, trigger hashes and rewrite rules', async () => {
      const pokemon = baseline.resources.find(r=>r.name==='pokemon_instances');
      assert.ok(pokemon.incomingReferences.some(fk=>fk.source==='pokemon_comments'&&fk.on_delete==='c'));
      assert.ok(pokemon.incomingReferences.some(fk=>fk.source==='catch_sessions'&&fk.on_delete==='a'));
      assert.ok(pokemon.incomingReferences.some(fk=>fk.source==='external_reference'&&fk.source_schema===outside&&fk.on_delete==='c'));
      assert.ok(baseline.foreignKeys.some(fk=>fk.source==='erasure_actor_reference'&&fk.target==='users'&&fk.source_columns[0]==='contact'));
      assert.ok(baseline.constraints.some(c=>c.relation==='users'&&c.kind==='p'));
      assert.ok(pokemon.reviewRequired.includes('EXTERNAL_REFERENCE_REVIEW_REQUIRED'));
      assert.ok(pokemon.reviewRequired.includes('TRIGGER_EFFECT_REVIEW_REQUIRED'));
      const effect = baseline.triggers.find(tr=>tr.name==='erasure_effect');assert.match(effect.function_definition,/^[0-9a-f]{64}$/);assert.ok(!JSON.stringify(effect).includes('RETURN NEW'));
      assert.ok(baseline.resources.find(r=>r.name==='erasure_retained_integer').reviewRequired.includes('RULE_EFFECT_REVIEW_REQUIRED'));
      assert.equal((await pool.query('SELECT pokemon_id FROM ' + outside + '.external_reference')).rowCount,1);
    });
    await t.test('requires explicit integer/array identity mapping and refuses filtered, view and duplicate partition counts', async () => {
      for (const name of ['erasure_retained_integer','erasure_uuid_array']) {const item=baseline.resources.find(r=>r.name===name);assert.equal(item.associatedRows,null);assert.ok(item.reviewRequired.includes('SUBJECT_MAPPING_REQUIRED'));}
      const parent = baseline.resources.find(r=>r.name==='erasure_partitioned');assert.equal(parent.associatedRows,'2');
      const child = baseline.resources.find(r=>r.name==='erasure_partitioned_child');assert.equal(child.associatedRows,null);assert.equal(child.parents[0].parent,parent.name);
      const rls = baseline.resources.find(r=>r.name==='erasure_rls');assert.equal(rls.associatedRows,null);assert.ok(rls.reviewRequired.includes('ROW_SECURITY_REVIEW_REQUIRED'));
      assert.equal(baseline.resources.find(r=>r.name==='erasure_unsafe_parent').associatedRows,null);
      assert.ok(baseline.resources.find(r=>r.name==='erasure_unsafe_parent').reviewRequired.includes('DESCENDANT_ACCESS_REVIEW_REQUIRED'));
      assert.equal(baseline.resources.find(r=>r.name==='erasure_private_view').associatedRows,null);
      assert.equal(baseline.policies.find(p=>p.name==='invisible').using_expression.length,64);
    });
    await t.test('keeps concurrent writes outside the observed snapshot and binds fingerprints to subject, scope and counts', async () => {
      await snapshot(async client=>{
        const first=await planner.inspect(client,request);
        await pool.query('INSERT INTO "erasure ""quoted; resource" VALUES($1,\'later write\')',[subject]);
        const same=await planner.inspect(client,request);assert.equal(same.fingerprint,first.fingerprint);assert.equal(same.catalogSha256,first.catalogSha256);
        const different=await planner.inspect(client,{...request,user_id:other});assert.notEqual(different.fingerprint,first.fingerprint);assert.equal(different.catalogSha256,first.catalogSha256);
        assert.notEqual((await planner.inspect(client,{...request,request_type:'partial',requested_data_types:['pokemon']})).fingerprint,first.fingerprint);
      });
      const fresh=await snapshot(client=>planner.inspect(client,request));assert.notEqual(fresh.fingerprint,baseline.fingerprint);assert.equal(fresh.catalogSha256,baseline.catalogSha256);
      assert.equal(fresh.resources.find(r=>r.name==='erasure "quoted; resource').associatedRows,'2');
    });
    await t.test('detects trigger-body and schema changes instead of treating an old review as current', async () => {
      await pool.query("CREATE OR REPLACE FUNCTION planner_effect() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM 1; RETURN NEW; END$$");
      const changed=await snapshot(client=>planner.inspect(client,request));assert.notEqual(changed.catalogSha256,baseline.catalogSha256);
      assert.notEqual(changed.triggers.find(tr=>tr.name==='erasure_effect').function_definition,baseline.triggers.find(tr=>tr.name==='erasure_effect').function_definition);
      await pool.query('ALTER TABLE erasure_actor_reference ADD COLUMN new_private_data text');
      const newColumn=await snapshot(client=>planner.inspect(client,request));assert.notEqual(newColumn.catalogSha256,changed.catalogSha256);assert.ok(newColumn.columns.some(c=>c.relation==='erasure_actor_reference'&&c.name==='new_private_data'));
    });
    await t.test('missing SELECT privileges yield explicit unknown counts and cannot produce apparent zero rows', async () => {
      await admin.query('CREATE ROLE ' + reader + ' NOLOGIN');roleCreated=true;
      await admin.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + reader);await admin.query('GRANT SELECT ON ' + schema + '.users TO ' + reader);
      const limited=await snapshot(async client=>{await client.query('SET LOCAL ROLE ' + reader);return planner.inspect(client,request);});
      const pokemon=limited.resources.find(r=>r.name==='pokemon_instances');assert.equal(pokemon.associatedRows,null);assert.ok(pokemon.reviewRequired.includes('SELECT_PRIVILEGE_REQUIRED'));assert.equal(limited.resources.find(r=>r.name==='users').associatedRows,'1');
    });
    await t.test('refuses a search-path schema without canonical UUID users', async () => {
      await pool.query('CREATE TABLE ' + outside + '.users(id integer)');
      await snapshot(async client=>{await client.query('SET LOCAL search_path=' + outside + ',public');await assert.rejects(planner.inspect(client,request),error=>error.code==='ERASURE_SCHEMA_INVALID');});
    });
  } finally {
    if(pool) await pool.end();
    await admin.query('DROP SCHEMA IF EXISTS ' + outside + ' CASCADE');await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    if(roleCreated) await admin.query('DROP ROLE ' + reader);
    await admin.end();
  }
});
