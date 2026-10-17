'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const {Pool}=require('pg');
const {migrationStatements}=require('../../../database/sqlStatements');
const root=path.resolve(__dirname,'../../..');
const filename='20260627_060000__add_inventory_organization_system.sql';
const read=file=>fs.readFile(path.join(root,file),'utf8');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
async function apply(pool,source){
  const c=await pool.connect();
  try{await c.query('BEGIN');for(const sql of migrationStatements(source))await c.query(sql);await c.query('COMMIT');}
  catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function fixture(fn,{teams=true}={}){
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema='inventory_org_'+crypto.randomBytes(8).toString('hex');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:2,options:`-c search_path=${schema},public`});
  const owner=crypto.randomUUID(),other=crypto.randomUUID();
  try{
    await pool.query(await read('database/migrations/V1__initial_schema.sql'));
    await pool.query(await read('database/seeds/V2__seed_data.sql'));
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2),($3,$4)',[owner,'inventory-owner',other,'inventory-other']);
    const pokemon=(await pool.query(`INSERT INTO pokemon_instances(user_id,species_id,nickname,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp,is_favorite,caught_at)
      VALUES($1,25,'保留名字',900,50,50,15,14,13,true,'2026-01-02'),($2,1,'Other',600,40,40,1,2,3,false,'2026-01-03') RETURNING id`,[owner,other])).rows.map(r=>r.id);
    await pool.query('INSERT INTO candy_inventory(user_id,species_id,amount) VALUES($1,25,47),($1,1,19),($2,25,8)',[owner,other]);
    if(teams){
      const gym=migrationStatements(await read('database/pending/20260609_160000__add_gym_battle_system.sql'));
      await pool.query(gym.find(sql=>/\bCREATE TABLE IF NOT EXISTS battle_teams\b/.test(sql.trim())));
      await pool.query(gym.find(sql=>/\bCREATE INDEX IF NOT EXISTS idx_battle_teams_user\b/.test(sql.trim())));
      await pool.query('INSERT INTO battle_teams(user_id,name,pokemon_ids,is_default) VALUES($1,$2,$3,true)',[owner,'Original team',[pokemon[0]]]);
    }
    await fn({pool,schema,owner,other,pokemon});
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function snapshot(pool,{stripAdded=false}={}){
  const rows={};
  for(const table of ['users','pokemon_instances','pokemon_species','candy_inventory','battle_teams','user_inventory_preferences']){
    if(!(await pool.query('SELECT to_regclass($1) AS name',[table])).rows[0].name)continue;
    const strip=stripAdded&&table==='pokemon_instances'?"-'is_locked'-'custom_tags'-'sort_priority'-'deleted_at'":stripAdded&&table==='battle_teams'?"-'used_at'":'';
    rows[table]=(await pool.query(`SELECT to_jsonb(t)${strip} AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return rows;
}
const repair=()=>read('database/pending/repairs/'+filename);

test('inventory organization preserves real canonical data and identities',async t=>fixture(async({pool,owner,other,pokemon,schema})=>{
  await pool.query('CREATE VIEW retained_inventory AS SELECT id,user_id,nickname,cp,is_favorite FROM pokemon_instances');
  await pool.query('CREATE TABLE retained_inventory_reference(id uuid REFERENCES pokemon_instances(id))');
  await pool.query('INSERT INTO retained_inventory_reference VALUES($1)',[pokemon[0]]);
  const identities=async()=> (await pool.query("SELECT relname,oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname IN('pokemon_instances','pokemon_species','candy_inventory','battle_teams','retained_inventory','retained_inventory_reference') ORDER BY relname")).rows;
  const before=await snapshot(pool,{stripAdded:true}),oids=await identities();
  await t.test('the original fails on its nonexistent deletion field and rolls back its earlier additions',async()=>{
    await assert.rejects(apply(pool,await read('database/pending/'+filename)),{code:'42703'});
    assert.equal((await pool.query("SELECT 1 FROM pg_attribute WHERE attrelid='pokemon_instances'::regclass AND attname='is_locked' AND NOT attisdropped")).rowCount,0);
    assert.deepEqual(await identities(),oids);assert.deepEqual(await snapshot(pool,{stripAdded:true}),before);
  });
  await t.test('repair preserves instances, localized master data, per-species balances, UUID teams and dependent identities',async()=>{
    await apply(pool,await repair());assert.deepEqual(await identities(),oids);
    const current=await snapshot(pool,{stripAdded:true});delete current.user_inventory_preferences;assert.deepEqual(current,before);
    assert.equal((await pool.query('SELECT nickname FROM retained_inventory WHERE id=$1',[pokemon[0]])).rows[0].nickname,'保留名字');
    assert.equal((await pool.query('SELECT id FROM retained_inventory_reference')).rows[0].id,pokemon[0]);
  });
  await t.test('protection/tags add truthful defaults without fake levels, duplicated species metadata or global candy',async()=>{
    const row=(await pool.query('SELECT is_locked,custom_tags,sort_priority,deleted_at FROM pokemon_instances WHERE id=$1',[pokemon[0]])).rows[0];
    assert.deepEqual(row,{is_locked:false,custom_tags:[],sort_priority:0,deleted_at:null});
    const names=(await pool.query("SELECT attname FROM pg_attribute WHERE attrelid='pokemon_instances'::regclass AND NOT attisdropped")).rows.map(r=>r.attname);
    for(const name of ['combat_power','level','iv_total','types','rarity','evolution_stage','is_deleted'])assert.equal(names.includes(name),false,name);
    assert.equal((await pool.query("SELECT to_regclass('user_candies') AS name")).rows[0].name,null);
    assert.equal((await pool.query("SELECT character_maximum_length FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='pokemon_instances' AND column_name='nickname'")).rows[0].character_maximum_length,30);
  });
  await t.test('preferences seed actual UUID owners and keep foreign-owner/duplicate constraints',async()=>{
    assert.deepEqual((await pool.query('SELECT user_id FROM user_inventory_preferences ORDER BY user_id')).rows.map(r=>r.user_id),[owner,other].sort());
    await assert.rejects(pool.query('INSERT INTO user_inventory_preferences(user_id) VALUES($1)',[crypto.randomUUID()]),{code:'23503'});
    await assert.rejects(pool.query('INSERT INTO user_inventory_preferences(user_id) VALUES($1)',[owner]),{code:'23505'});
  });
  await t.test('existing team uniqueness, UUID arrays and maximum-six constraint remain enforced',async()=>{
    await assert.rejects(pool.query('INSERT INTO battle_teams(user_id,name,pokemon_ids) VALUES($1,$2,$3)',[owner,'Original team',pokemon]),{code:'23505'});
    await assert.rejects(pool.query('INSERT INTO battle_teams(user_id,name,pokemon_ids) VALUES($1,$2,$3)',[owner,'Too many',Array(7).fill(pokemon[0])]),{code:'23514'});
    await assert.rejects(pool.query("INSERT INTO battle_teams(user_id,name,pokemon_ids) VALUES($1,'Bad',ARRAY['123']::uuid[])",[owner]),{code:'22P02'});
    assert.equal((await pool.query('SELECT used_at FROM battle_teams')).rows[0].used_at,null);
  });
  await t.test('owned timestamp trigger operates and the canonical partial index excludes an actual deleted row',async()=>{
    await pool.query("UPDATE user_inventory_preferences SET primary_sort='catchTime',sort_order='asc',custom_groups=$2,updated_at='2000-01-01' WHERE user_id=$1",[owner,{keepers:['x']}]);
    assert.ok((await pool.query('SELECT updated_at FROM user_inventory_preferences WHERE user_id=$1',[owner])).rows[0].updated_at>new Date('2001-01-01'));
    await pool.query("UPDATE pokemon_instances SET deleted_at='2026-02-03' WHERE id=$1",[pokemon[1]]);
    await pool.query('SET enable_seqscan=off');
    const plan=JSON.stringify((await pool.query('EXPLAIN (FORMAT JSON) SELECT id,cp FROM pokemon_instances WHERE user_id=$1 AND deleted_at IS NULL ORDER BY cp DESC',[other])).rows);
    assert.match(plan,/idx_pokemon_user_cp/);assert.equal((await pool.query('SELECT id FROM pokemon_instances WHERE user_id=$1 AND deleted_at IS NULL',[other])).rowCount,0);
    await pool.query('RESET enable_seqscan');
  });
  await t.test('rerun keeps choices, exact deletion times, sequence state and function/trigger OIDs/enabled state',async()=>{
    await pool.query('ALTER TABLE user_inventory_preferences DISABLE TRIGGER trigger_update_inventory_preferences_timestamp');
    const objects=async()=>({fn:(await pool.query("SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname='update_inventory_preferences_timestamp'")).rows,triggers:(await pool.query("SELECT oid,tgenabled FROM pg_trigger WHERE tgrelid='user_inventory_preferences'::regclass AND NOT tgisinternal ORDER BY oid")).rows,sequence:(await pool.query('SELECT last_value,is_called FROM user_inventory_preferences_id_seq')).rows});
    const data=await snapshot(pool),state=await objects();await apply(pool,await repair());
    assert.deepEqual(await snapshot(pool),data);assert.deepEqual(await objects(),state);
  });
  await t.test('actual CLI records the immutable raw checksum separately from repaired execution and verifies reruns',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'minego-inventory-history-'));
    try{
      await fs.mkdir(path.join(dir,'repairs'));const raw=await read('database/pending/'+filename);await fs.writeFile(path.join(dir,filename),raw);
      const fixed=await repair();await fs.writeFile(path.join(dir,'repairs',filename),fixed);
      const manifest=JSON.parse(await read('database/pending/repairs.json'));await fs.writeFile(path.join(dir,'repairs.json'),JSON.stringify({schemaVersion:1,repairs:{'20260627_060000':manifest.repairs['20260627_060000']}}));
      const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
      const env={...process.env,DATABASE_URL:url.toString(),MINEGO_MIGRATIONS_DIR:dir};
      const cli=async command=>promisify(execFile)(process.execPath,[path.join(root,'database/migrate.js'),command],{cwd:root,env,timeout:15000});
      await cli('up');const history=(await pool.query('SELECT version,checksum,execution_checksum FROM schema_migrations')).rows;
      assert.equal(history.length,1);assert.equal(history[0].version,'20260627_060000');assert.equal(history[0].checksum,digest(raw));assert.equal(history[0].execution_checksum,digest(JSON.stringify({up:fixed.trim(),down:''})));assert.notEqual(history[0].execution_checksum,digest(raw));
      const data=await snapshot(pool);await cli('up');await cli('verify');assert.deepEqual(await snapshot(pool),data);
      await fs.appendFile(path.join(dir,filename),'\n-- modified immutable source');
      await assert.rejects(cli('verify'),/mismatched repair source/);
      assert.deepEqual((await pool.query('SELECT version,checksum,execution_checksum FROM schema_migrations')).rows,history);assert.deepEqual(await snapshot(pool),data);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
  });
}));

test('unsupported legacy layouts fail atomically without destroying their data',async t=>{
  for(const [label,sql,pattern]of [
    ['unknown deletion flags',"ALTER TABLE pokemon_instances ADD COLUMN is_deleted boolean DEFAULT true",/is_deleted requires explicit adoption/],
    ['unattributed global candy',"CREATE TABLE user_candies(user_id uuid PRIMARY KEY,amount integer); INSERT INTO user_candies SELECT id,73 FROM users",/global user_candies/],
    ['unknown tag column','ALTER TABLE pokemon_instances ADD COLUMN custom_tags integer DEFAULT 7',/field types/],
    ['unknown preferences',"CREATE TABLE user_inventory_preferences(id serial PRIMARY KEY,user_id text UNIQUE,primary_sort text); INSERT INTO user_inventory_preferences(user_id,primary_sort) SELECT id::text,'custom' FROM users",/preference schema/],
    ['noncanonical team identity',"DROP TABLE battle_teams; CREATE TABLE battle_teams(id serial PRIMARY KEY,user_id text,pokemon_ids text[]); INSERT INTO battle_teams(user_id,pokemon_ids) SELECT id::text,ARRAY['old'] FROM users",/canonical UUID battle teams/],
    ['custom timestamp function',"CREATE FUNCTION update_inventory_preferences_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated_at='2000-01-01'; RETURN NEW; END;$$",/timestamp function/],
    ['same-named index with different semantics','CREATE INDEX idx_pokemon_user_cp ON pokemon_instances(user_id,cp)',/index idx_pokemon_user_cp/]
  ])await t.test(label,async()=>fixture(async({pool})=>{
    await pool.query(sql);const data=await snapshot(pool),objects=(await pool.query('SELECT oid,relname FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY oid')).rows;
    await assert.rejects(apply(pool,await repair()),pattern);
    assert.deepEqual(await snapshot(pool),data);assert.deepEqual((await pool.query('SELECT oid,relname FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY oid')).rows,objects);
    if(label==='unattributed global candy')assert.ok((await pool.query('SELECT amount FROM user_candies')).rows.every(r=>r.amount===73));
  }));
});

test('a missing team table is provisioned with the actual earlier UUID gym contract',async()=>fixture(async({pool})=>{
  await apply(pool,await repair());
  assert.deepEqual((await pool.query("SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='battle_teams'::regclass AND attname IN('id','user_id','pokemon_ids') ORDER BY attname")).rows,[{attname:'id',type:'uuid'},{attname:'pokemon_ids',type:'uuid[]'},{attname:'user_id',type:'uuid'}]);
},{teams:false}));

async function legacyPreferences(pool,owner,other){
  const original=migrationStatements(await read('database/pending/'+filename));
  const definition=original.find(sql=>/CREATE TABLE IF NOT EXISTS user_inventory_preferences\b/.test(sql));
  assert.ok(definition);await pool.query(definition.replace('user_id VARCHAR(255)','user_id UUID'));
  await pool.query("INSERT INTO user_inventory_preferences(id,user_id,primary_sort,secondary_sort,sort_order,default_group_by,custom_groups,created_at,updated_at) VALUES(41,$1,'catchTime','type','asc','custom',$3,'2025-01-01','2025-02-03'),(42,$2,'cp','rarity','desc','rarity',$4,'2025-01-02','2025-02-04')",[owner,other,{keepers:['保留标签']},{rare:['other']}]);
  await pool.query("SELECT setval('user_inventory_preferences_id_seq',42,true)");
  await pool.query(original.find(sql=>/CREATE OR REPLACE FUNCTION update_inventory_preferences_timestamp\(/.test(sql)));
  await pool.query(original.find(sql=>/CREATE TRIGGER trigger_update_inventory_preferences_timestamp\b/.test(sql)));
}

test('first adoption preserves compatible preexisting preferences, timestamps, nullable protection and custom triggers',async()=>fixture(async({pool,owner,other,pokemon})=>{
  await legacyPreferences(pool,owner,other);
  await pool.query('ALTER TABLE user_inventory_preferences DISABLE TRIGGER trigger_update_inventory_preferences_timestamp');
  await pool.query('ALTER TABLE pokemon_instances ADD COLUMN is_locked boolean; ALTER TABLE pokemon_instances ADD COLUMN custom_tags text[]; ALTER TABLE pokemon_instances ADD COLUMN sort_priority integer; ALTER TABLE pokemon_instances ADD COLUMN deleted_at timestamp; ALTER TABLE battle_teams ADD COLUMN used_at timestamptz');
  await pool.query("UPDATE pokemon_instances SET custom_tags=ARRAY['old','保留'],sort_priority=17,deleted_at='2025-08-09' WHERE id=$1",[pokemon[0]]);
  await pool.query("UPDATE battle_teams SET used_at='2025-09-10T12:13:14Z'");
  await pool.query('CREATE TABLE retained_inventory_changes(id uuid)');
  await pool.query('CREATE FUNCTION retained_inventory_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO retained_inventory_changes VALUES(NEW.id); RETURN NEW; END; $$; CREATE TRIGGER retained_inventory_change AFTER UPDATE ON pokemon_instances FOR EACH ROW EXECUTE FUNCTION retained_inventory_change()');
  const state=async()=>({
    records:await snapshot(pool),
    sequence:(await pool.query('SELECT last_value,is_called FROM user_inventory_preferences_id_seq')).rows,
    functions:(await pool.query('SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY oid')).rows,
    triggers:(await pool.query("SELECT oid,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid IN('pokemon_instances'::regclass,'user_inventory_preferences'::regclass) AND NOT tgisinternal ORDER BY oid")).rows,
    references:(await pool.query("SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN('pokemon_instances'::regclass,'battle_teams'::regclass,'user_inventory_preferences'::regclass,'candy_inventory'::regclass) ORDER BY oid")).rows
  });
  const before=await state();await apply(pool,await repair());assert.deepEqual(await state(),before);
  assert.equal((await pool.query('SELECT * FROM retained_inventory_changes')).rowCount,0,'Upgrade must not replay user UPDATE triggers');
}));

test('compatible-looking tables with missing ownership/size or customized update behavior require explicit adoption',async t=>{
  for(const [label,mutate,pattern]of [
    ['team size guard',async p=>p.query('ALTER TABLE battle_teams DROP CONSTRAINT battle_teams_pokemon_ids_check'),/team ownership\/size constraints/],
    ['team owner FK',async p=>p.query('ALTER TABLE battle_teams DROP CONSTRAINT battle_teams_user_id_fkey'),/team ownership\/size constraints/],
    ['preference owner FK',async(p,o,x)=>{await legacyPreferences(p,o,x);await p.query('ALTER TABLE user_inventory_preferences DROP CONSTRAINT fk_user');},/preference ownership constraints/],
    ['column-only timestamp trigger',async(p,o,x)=>{await legacyPreferences(p,o,x);await p.query('DROP TRIGGER trigger_update_inventory_preferences_timestamp ON user_inventory_preferences; CREATE TRIGGER trigger_update_inventory_preferences_timestamp BEFORE UPDATE OF primary_sort ON user_inventory_preferences FOR EACH ROW EXECUTE FUNCTION update_inventory_preferences_timestamp()');},/timestamp trigger/]
  ])await t.test(label,async()=>fixture(async({pool,owner,other})=>{
    await mutate(pool,owner,other);
    const state=async()=>({data:await snapshot(pool),objects:(await pool.query('SELECT oid,relname FROM pg_class WHERE relnamespace=current_schema()::regnamespace ORDER BY oid')).rows,functions:(await pool.query('SELECT oid,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=current_schema()::regnamespace ORDER BY oid')).rows,triggers:(await pool.query('SELECT t.oid,tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=current_schema()::regnamespace AND NOT tgisinternal ORDER BY t.oid')).rows});
    const before=await state();await assert.rejects(apply(pool,await repair()),pattern);assert.deepEqual(await state(),before);
  }));
});
