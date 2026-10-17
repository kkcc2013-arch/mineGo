'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {promisify}=require('node:util');const {execFile}=require('node:child_process');const {Pool}=require('pg');
const {migrationStatements}=require('../../../database/sqlStatements');
const root=path.resolve(__dirname,'../../..'),filename='20260630_040000__add_pokemon_cosmetic_system.sql';
const read=f=>fs.readFile(path.join(root,f),'utf8');const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const raw=()=>read('database/pending/'+filename),repair=()=>read('database/pending/repairs/'+filename);
const tables=['cosmetic_items','user_cosmetics','pokemon_cosmetics','cosmetic_presets','cosmetic_statistics'];
function canonicalOriginal(source){return source.replace(/user_id INTEGER NOT NULL REFERENCES users\(id\)/g,'user_id UUID NOT NULL REFERENCES users(id)').replace('equipped_by INTEGER REFERENCES users(id)','equipped_by UUID REFERENCES users(id)').replace('pokemon_instance_id VARCHAR(50) NOT NULL REFERENCES pokemon_instances(id)','pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id)');}
async function apply(pool,source){const c=await pool.connect();try{await c.query('BEGIN');for(const sql of migrationStatements(source))await c.query(sql);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function fixture(fn){
  assert.ok(process.env.TEST_DATABASE_URL,'isolated PostGIS required');const schema='cosmetic_schema_'+crypto.randomBytes(8).toString('hex');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
  // The independent original/current schemas share the real V1 extension APIs.
  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await admin.query('CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:2,options:`-c search_path=${schema},public`});const owner=crypto.randomUUID(),other=crypto.randomUUID();
  try{
    await pool.query(await read('database/migrations/V1__initial_schema.sql'));await pool.query(await read('database/seeds/V2__seed_data.sql'));
    await pool.query("INSERT INTO users(id,nickname) VALUES($1,'cosmetic-owner'),($2,'cosmetic-other')",[owner,other]);
    const pokemon=(await pool.query('INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) VALUES($1,25,200,10,10,1,2,3) RETURNING id',[owner])).rows[0].id;
    await fn({pool,schema,owner,other,pokemon});
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function snapshot(pool){
  // Compare database JSON text so64-bit monetary counters never round in JS.
  const rows={};for(const table of tables){if((await pool.query('SELECT to_regclass($1) AS name',[table])).rows[0].name)rows[table]=(await pool.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;}
  return {rows,objects:(await pool.query('SELECT oid,relname,relkind,obj_description(oid,\'pg_class\') AS comment FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY oid')).rows,keys:(await pool.query('SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=current_schema()::regnamespace ORDER BY oid')).rows};
}

test('actual cosmetic schema fixes all UUID references and retains the original catalog',async t=>fixture(async({pool,owner,pokemon,schema})=>{
  await t.test('original and prior three-reference repair fail and roll back every cosmetic table',async()=>{
    const source=await raw();const previous=source.replace(/user_id INTEGER NOT NULL REFERENCES users\(id\)/g,'user_id UUID NOT NULL REFERENCES users(id)').replace('equipped_by INTEGER REFERENCES users(id)','equipped_by UUID REFERENCES users(id)');
    for(const candidate of [source,previous]){
      await assert.rejects(apply(pool,candidate),{code:'42804'});
      for(const table of tables)assert.equal((await pool.query('SELECT to_regclass($1) AS name',[table])).rows[0].name,null);
    }
  });
  await apply(pool,await repair());
  await t.test('all five tables and13 actual multilingual/category/price/position seed definitions exist',async()=>{
    for(const table of tables)assert.ok((await pool.query('SELECT to_regclass($1) AS name',[table])).rows[0].name);
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM cosmetic_items')).rows[0].n,13);
    const actual=(await pool.query("SELECT to_jsonb(c)-'created_at' AS row FROM cosmetic_items c ORDER BY id")).rows;
    let original;
    await fixture(async({pool:baseline})=>{await apply(baseline,canonicalOriginal(await raw()));original=(await baseline.query("SELECT to_jsonb(c)-'created_at' AS row FROM cosmetic_items c ORDER BY id")).rows;});
    assert.deepEqual(actual,original,'Every seeded field must retain the actual original definition');

    assert.equal((await pool.query('SELECT count(DISTINCT category)::integer AS n FROM cosmetic_items')).rows[0].n,6);
    const party=(await pool.query("SELECT name,price_coins,price_gems,position_data FROM cosmetic_items WHERE id='hat_party_hat'")).rows[0];
    assert.deepEqual(party.name,{en:'Party Hat',zh:'派对帽',ja:'パーティハット'});assert.equal(party.price_coins,500);assert.equal(party.price_gems,0);assert.deepEqual(party.position_data,{offset:[0,15,0],scale:1});
    assert.equal((await pool.query("SELECT price_gems FROM cosmetic_items WHERE id='aura_fire_aura'")).rows[0].price_gems,50);
    assert.equal((await pool.query("SELECT price_gems FROM cosmetic_items WHERE id='trail_rainbow_trail'")).rows[0].price_gems,50);
    assert.ok((await pool.query('SELECT * FROM cosmetic_statistics')).rows.every(r=>r.total_owned===0&&r.total_equipped===0&&r.total_purchased===0&&r.total_revenue_coins==='0'&&r.total_revenue_gems==='0'));
  });
  await t.test('actual UUID owner/Pokemon FKs accept canonical rows and reject nonexistent identities',async()=>{
    await pool.query("INSERT INTO user_cosmetics(user_id,cosmetic_id,quantity,obtained_from) VALUES($1,'hat_party_hat',2,'gift')",[owner]);
    await pool.query("INSERT INTO pokemon_cosmetics(pokemon_instance_id,cosmetic_id,equipped_by) VALUES($1,'hat_party_hat',$2)",[pokemon,owner]);
    await pool.query("INSERT INTO cosmetic_presets(user_id,name,preset_data) VALUES($1,'Saved', $2)",[owner,{hat_party_hat:0}]);
    await assert.rejects(pool.query("INSERT INTO pokemon_cosmetics(pokemon_instance_id,cosmetic_id,equipped_by) VALUES($1,'hat_santa_hat',$2)",[crypto.randomUUID(),owner]),{code:'23503'});
    await assert.rejects(pool.query("INSERT INTO user_cosmetics(user_id,cosmetic_id,obtained_from) VALUES($1,'hat_santa_hat','gift')",[crypto.randomUUID()]),{code:'23503'});
    await assert.rejects(pool.query("INSERT INTO pokemon_cosmetics(pokemon_instance_id,cosmetic_id,equipped_by) VALUES('123','hat_santa_hat',$1)",[owner]),{code:'22P02'});
  });
  await t.test('actual CLI journals immutable raw and exact repaired execution hashes and verifies a rerun',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'minego-cosmetic-history-'));
    try{
      await fs.mkdir(path.join(dir,'repairs'));const original=await raw(),fixed=await repair();await fs.writeFile(path.join(dir,filename),original);await fs.writeFile(path.join(dir,'repairs',filename),fixed);
      const manifest=JSON.parse(await read('database/pending/repairs.json'));await fs.writeFile(path.join(dir,'repairs.json'),JSON.stringify({schemaVersion:1,repairs:{'20260630_040000':manifest.repairs['20260630_040000']}}));
      const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
      const cli=command=>promisify(execFile)(process.execPath,[path.join(root,'database/migrate.js'),command],{env:{...process.env,DATABASE_URL:url.toString(),MINEGO_MIGRATIONS_DIR:dir},timeout:15000});
      await cli('up');const row=(await pool.query('SELECT version,checksum,execution_checksum FROM schema_migrations')).rows[0];assert.equal(row.checksum,digest(original));assert.equal(row.execution_checksum,digest(JSON.stringify({up:fixed.trim(),down:''})));
      const before=await snapshot(pool);await cli('up');await cli('verify');assert.deepEqual(await snapshot(pool),before);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
}));

test('existing compatible catalog/history/OIDs/sequences/views/FKs/comments and prices survive',async t=>fixture(async({pool,owner,other,pokemon})=>{
  await apply(pool,canonicalOriginal(await raw()));
  await pool.query("UPDATE cosmetic_items SET name=$1,price_coins=765,price_gems=77,position_data=$2 WHERE id='aura_fire_aura'",[{en:'Operator fire',zh:'自定义火焰'},{offset:[2,3,4],scale:2}]);
  await pool.query("UPDATE cosmetic_statistics SET total_owned=17,total_equipped=13,total_purchased=123,total_revenue_coins=9223372036854775806,total_revenue_gems=999 WHERE cosmetic_id='aura_fire_aura'");
  await pool.query("INSERT INTO user_cosmetics(user_id,cosmetic_id,quantity,obtained_from) VALUES($1,'hat_party_hat',3,'gift'),($2,'hat_party_hat',1,'purchase')",[owner,other]);
  await pool.query("INSERT INTO user_cosmetics(user_id,cosmetic_id,quantity,obtained_from,expires_at) VALUES($1,'hat_santa_hat',1,'event','2020-01-01')",[owner]);
  await pool.query("INSERT INTO pokemon_cosmetics(pokemon_instance_id,cosmetic_id,equipped_by) VALUES($1,'hat_party_hat',$2)",[pokemon,owner]);
  await pool.query("INSERT INTO cosmetic_presets(user_id,name,preset_data) VALUES($1,'Historical',$2)",[owner,{hat_party_hat:0}]);
  await pool.query('CREATE VIEW retained_cosmetic_catalog AS SELECT id,name,price_coins,price_gems FROM cosmetic_items');
  await pool.query('CREATE TABLE retained_cosmetic_reference(id integer REFERENCES pokemon_cosmetics(id))');await pool.query('INSERT INTO retained_cosmetic_reference SELECT id FROM pokemon_cosmetics');
  await pool.query("COMMENT ON TABLE cosmetic_items IS 'Operator catalog'; COMMENT ON COLUMN cosmetic_items.rarity IS 'Operator rarity'");
  const sequences=async()=> (await pool.query("SELECT last_value,is_called FROM user_cosmetics_id_seq UNION ALL SELECT last_value,is_called FROM pokemon_cosmetics_id_seq UNION ALL SELECT last_value,is_called FROM cosmetic_presets_id_seq")).rows;
  await t.test('first repair and rerun leave every existing row, object, FK, view and sequence untouched',async()=>{
    const before=await snapshot(pool),sequence=await sequences();await apply(pool,await repair());assert.deepEqual(await snapshot(pool),before);assert.deepEqual(await sequences(),sequence);
    assert.equal((await pool.query("SELECT col_description('cosmetic_items'::regclass,(SELECT attnum FROM pg_attribute WHERE attrelid='cosmetic_items'::regclass AND attname='rarity')) AS note")).rows[0].note,'Operator rarity');
    assert.equal((await pool.query('SELECT id FROM retained_cosmetic_reference')).rowCount,1);
  });
  await t.test('missing old statistics derive only observable active owners/equipment; purchase/revenue remain unknown',async()=>{
    await pool.query("DELETE FROM cosmetic_statistics WHERE cosmetic_id IN('hat_party_hat','hat_santa_hat')");
    const inventory=(await pool.query('SELECT * FROM user_cosmetics ORDER BY id')).rows;
    await apply(pool,await repair());const rows=(await pool.query("SELECT * FROM cosmetic_statistics WHERE cosmetic_id IN('hat_party_hat','hat_santa_hat') ORDER BY cosmetic_id")).rows;
    assert.equal(rows[0].total_owned,2);assert.equal(rows[0].total_equipped,1);assert.equal(rows[1].total_owned,0);
    for(const row of rows){assert.equal(row.total_purchased,null);assert.equal(row.total_revenue_coins,null);assert.equal(row.total_revenue_gems,null);}
    assert.deepEqual((await pool.query('SELECT * FROM user_cosmetics ORDER BY id')).rows,inventory);
    const before=await snapshot(pool);await apply(pool,await repair());assert.deepEqual(await snapshot(pool),before);
  });
}));

test('unmapped legacy identities and inconsistent resource/reference contracts fail without data loss',async t=>{
  for(const [label,stage,sql,pattern]of [
    ['legacy inventory owner',false,"CREATE TABLE user_cosmetics(id serial PRIMARY KEY,user_id integer,cosmetic_id text); INSERT INTO user_cosmetics(user_id,cosmetic_id) VALUES(77,'old')",/user_cosmetics.user_id identity/],
    ['legacy Pokemon reference',false,"CREATE TABLE pokemon_cosmetics(id serial PRIMARY KEY,pokemon_instance_id varchar(50),equipped_by uuid); INSERT INTO pokemon_cosmetics(pokemon_instance_id) VALUES('old-id')",/pokemon_cosmetics.pokemon_instance_id identity/],
    ['legacy equipping actor',false,"CREATE TABLE pokemon_cosmetics(id serial PRIMARY KEY,pokemon_instance_id uuid,equipped_by integer); INSERT INTO pokemon_cosmetics(pokemon_instance_id,equipped_by) VALUES(gen_random_uuid(),77)",/pokemon_cosmetics.equipped_by identity/],
    ['legacy preset owner',false,"CREATE TABLE cosmetic_presets(id serial PRIMARY KEY,user_id text); INSERT INTO cosmetic_presets(user_id) VALUES('old-owner')",/cosmetic_presets.user_id identity/],
    ['missing Pokemon FK',true,'ALTER TABLE pokemon_cosmetics DROP CONSTRAINT pokemon_cosmetics_pokemon_instance_id_fkey',/pokemon_cosmetics.pokemon_instance_id foreign-key/],
    ['unknown grant quantity',true,"INSERT INTO user_cosmetics(user_id,cosmetic_id,quantity,obtained_from) SELECT id,'hat_party_hat',NULL,'gift' FROM users",/Unknown cosmetic quantities/]
  ])await t.test(label,async()=>fixture(async({pool})=>{
    if(stage)await apply(pool,canonicalOriginal(await raw()));await pool.query(sql);const before=await snapshot(pool);await assert.rejects(apply(pool,await repair()),pattern);assert.deepEqual(await snapshot(pool),before);
  }));
});
