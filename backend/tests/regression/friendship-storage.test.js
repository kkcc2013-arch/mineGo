'use strict';
// REQ-00067/00079: actual UUID bond preservation, affinity projection and history.
const {test}=require('node:test');const assert=require('node:assert/strict');
const crypto=require('node:crypto');const fs=require('node:fs/promises');const path=require('node:path');
const {Pool}=require('pg');const {parseMigrationFile}=require('../../../database/migrate');
const {migrationStatements}=require('../../../database/sqlStatements');
const root=path.resolve(__dirname,'../../..');
const bridge='database/pending/20261008_170000__friendship_identity_bridge.sql';
async function apply(pool,file,direction='up'){
  const parsed=parseMigrationFile(await fs.readFile(path.join(root,file),'utf8'));const c=await pool.connect();
  try{await c.query('BEGIN');for(const statement of migrationStatements(parsed[direction]))await c.query(statement);await c.query('COMMIT');}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function fixture(fn){
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`friendship_${crypto.randomBytes(8).toString('hex')}`;const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  try{await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query(await fs.readFile(path.join(root,'database/seeds/V2__seed_data.sql'),'utf8'));
    await apply(pool,'database/pending/20260609_223000__add_friendship_system.sql');
    const owner=crypto.randomUUID(),other=crypto.randomUUID(),pokemon=crypto.randomUUID();
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2),($3,$4)',[owner,'bond-owner',other,'bond-former-owner']);
    await pool.query(`INSERT INTO pokemon_instances(id,user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp,caught_at)
      VALUES($1,$2,133,100,10,10,1,1,1,'2020-01-01')`,[pokemon,owner]);
    const {rows}=await pool.query(`INSERT INTO pokemon_friendship(pokemon_id,user_id,friendship_value,friendship_level,mood,
      total_interactions,created_at,updated_at,last_interaction_at) VALUES($1,$2,155,6,'happy',8,'2020-02-02','2020-03-03','2020-03-03'),
      ($1,$3,50,1,'neutral',2,'2019-01-01','2019-02-02','2019-02-02') RETURNING id,user_id`,[pokemon,owner,other]);
    const id=rows.find(r=>r.user_id===owner).id;
    await fn({pool,schema,owner,other,pokemon,id});
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function snapshot(pool){return {
  rows:(await pool.query('SELECT id,pokemon_id,user_id,friendship_value,friendship_level,mood,mood_expiry,last_interaction_at,total_interactions,created_at,updated_at FROM pokemon_friendship ORDER BY id')).rows,
  oid:(await pool.query("SELECT 'pokemon_friendship'::regclass::oid AS oid")).rows[0].oid,
  keys:(await pool.query("SELECT oid,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='pokemon_friendship'::regclass ORDER BY oid")).rows,
  updateFunction:(await pool.query("SELECT 'update_friendship_updated_at()'::regprocedure::oid AS oid,pg_get_functiondef('update_friendship_updated_at()'::regprocedure) AS definition")).rows[0],
  triggers:(await pool.query("SELECT oid,tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='pokemon_friendship'::regclass AND NOT tgisinternal ORDER BY oid")).rows,
  log:(await pool.query("SELECT 'log_friendship_change()'::regprocedure::oid AS oid,pg_get_functiondef('log_friendship_change()'::regprocedure) AS definition")).rows[0],
  trigger:(await pool.query("SELECT oid,tgenabled FROM pg_trigger WHERE tgrelid='pokemon_friendship'::regclass AND tgname='trigger_log_friendship_change'")).rows[0]
};}

test('actual friendship bridge retains UUID trainer bonds and all original storage contracts',async t=>fixture(async f=>{
  const {pool,pokemon,owner,other,id}=f;await pool.query('ALTER TABLE pokemon_friendship DISABLE TRIGGER trigger_update_friendship_updated_at');const before=await snapshot(pool);
  await pool.query('CREATE VIEW historical_bond AS SELECT id,pokemon_id,user_id,friendship_level FROM pokemon_friendship');
  await pool.query('CREATE TABLE bond_reference(id uuid PRIMARY KEY REFERENCES pokemon_friendship(id)); INSERT INTO bond_reference SELECT id FROM pokemon_friendship');
  await apply(pool,bridge);await apply(pool,'database/pending/repairs/20260611_131000__add_friendship_system.sql');
  await t.test('original UUID rows, values, numeric levels, keys, relation and trigger identities survive',async()=>{
    const after=await snapshot(pool);assert.deepEqual(after.rows,before.rows);assert.equal(after.oid,before.oid);
    for(const key of before.keys)assert.deepEqual(after.keys.find(k=>k.oid===key.oid),key);
    assert.deepEqual(after.trigger,before.trigger);assert.deepEqual(after.triggers,before.triggers);assert.deepEqual(after.updateFunction,before.updateFunction);assert.equal(after.log.oid,before.log.oid);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM historical_bond')).rows[0].n,2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bond_reference')).rows[0].n,2);
  });
  await t.test('same Pokémon keeps distinct current and historic trainer bonds without invented dates',async()=>{
    const {rows}=await pool.query('SELECT * FROM pokemon_affinity WHERE pokemon_instance_id=$1 ORDER BY friendship_value',[pokemon]);
    assert.deepEqual(rows.map(r=>[r.user_id,r.friendship_value,r.friendship_level,r.bond_level]),[[other,50,'normal',1],[owner,155,'close',6]]);
    for(const row of rows){assert.equal(row.first_obtained_at,null);assert.equal(row.days_with_trainer,null);}
  });
  await t.test('generated UUID identity and named affinity cannot diverge from canonical fields',async()=>{
    await assert.rejects(pool.query('UPDATE pokemon_friendship SET pokemon_instance_id=$1 WHERE id=$2',[crypto.randomUUID(),id]),/can only be updated to DEFAULT/);
    await assert.rejects(pool.query("UPDATE pokemon_friendship SET affinity_level='stranger' WHERE id=$1",[id]),/can only be updated to DEFAULT/);
  });
  await t.test('positive and negative deltas record actual before/after history without invalid interaction entries',async()=>{
    await pool.query('UPDATE pokemon_friendship SET friendship_value=160 WHERE id=$1',[id]);
    await pool.query('UPDATE pokemon_friendship SET friendship_value=155 WHERE id=$1',[id]);
    const {rows}=await pool.query('SELECT friendship_id,pokemon_instance_id,user_id,change_amount,before_value,after_value,source FROM friendship_history ORDER BY id');
    assert.deepEqual(rows,[{friendship_id:id,pokemon_instance_id:pokemon,user_id:owner,change_amount:5,before_value:155,after_value:160,source:'system_update'},
      {friendship_id:id,pokemon_instance_id:pokemon,user_id:owner,change_amount:-5,before_value:160,after_value:155,source:'system_update'}]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM friendship_interactions')).rows[0].n,0);
  });
  await t.test('five real interaction types retain positive-only constraints and their original history',async()=>{
    for(const type of ['feed','play','pet','train','walk'])await pool.query('INSERT INTO friendship_interactions(pokemon_id,user_id,interaction_type,friendship_gain,mood_change) VALUES($1,$2,$3,1,$4)',[pokemon,owner,type,'happy']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM friendship_interactions')).rows[0].n,5);
    await assert.rejects(pool.query("INSERT INTO friendship_interactions(pokemon_id,user_id,interaction_type,friendship_gain) VALUES($1,$2,'system_update',1)",[pokemon,owner]),/check constraint/);
  });
  await t.test('all 256 affinity values map to the specified five ranges while numeric level remains preserved',async()=>{
    const check=pool.connect();const c=await check;try{await c.query('BEGIN');
      for(let value=0;value<=255;value++){
        const {rows:[row]}=await c.query('UPDATE pokemon_friendship SET friendship_value=$1 WHERE id=$2 RETURNING affinity_level,friendship_level',[value,id]);
        assert.equal(row.affinity_level,value>=200?'beloved':value>=150?'close':value>=100?'friendly':value>=50?'normal':'stranger');assert.equal(row.friendship_level,6);
      }
    }finally{await c.query('ROLLBACK');c.release();}
  });
  await t.test('existing value range, walking limit and FK constraints reject invalid writes',async()=>{
    for(const value of [-1,256])await assert.rejects(pool.query('UPDATE pokemon_friendship SET friendship_value=$1 WHERE id=$2',[value,id]),/check constraint/);
    for(const value of [-1,11])await assert.rejects(pool.query('UPDATE pokemon_friendship SET daily_walking_bonus=$1 WHERE id=$2',[value,id]),/check constraint/);
    await assert.rejects(pool.query('INSERT INTO pokemon_friendship(pokemon_id,user_id) VALUES($1,$2)',[crypto.randomUUID(),owner]),/foreign key/);
    assert.equal((await pool.query('SELECT friendship_value FROM pokemon_friendship WHERE id=$1',[id])).rows[0].friendship_value,155);
  });
  await t.test('rolled-back application write leaves neither value change nor phantom history',async()=>{
    const oldCount=(await pool.query('SELECT count(*)::int AS n FROM friendship_history')).rows[0].n;const c=await pool.connect();
    try{await c.query('BEGIN');await c.query('UPDATE pokemon_friendship SET friendship_value=200 WHERE id=$1',[id]);await c.query('ROLLBACK');}finally{c.release();}
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM friendship_history')).rows[0].n,oldCount);
    assert.equal((await pool.query('SELECT friendship_value FROM pokemon_friendship WHERE id=$1',[id])).rows[0].friendship_value,155);
  });
  await t.test('concurrent increments retain both real deltas and a continuous history chain',async()=>{
    await Promise.all([pool.query('UPDATE pokemon_friendship SET friendship_value=friendship_value+1 WHERE id=$1',[id]),pool.query('UPDATE pokemon_friendship SET friendship_value=friendship_value+1 WHERE id=$1',[id])]);
    assert.equal((await pool.query('SELECT friendship_value FROM pokemon_friendship WHERE id=$1',[id])).rows[0].friendship_value,157);
    const {rows}=await pool.query('SELECT before_value,after_value FROM friendship_history WHERE friendship_id=$1 ORDER BY id DESC LIMIT 2',[id]);assert.deepEqual(rows,[{before_value:156,after_value:157},{before_value:155,after_value:156}]);
  });
  await t.test('history delta cannot misrepresent the actual before/after value',async()=>{
    await assert.rejects(pool.query(`INSERT INTO friendship_history(friendship_id,pokemon_instance_id,user_id,change_type,change_amount,before_value,after_value,source)
      VALUES($1,$2,$3,'bad',20,50,51,'bad')`,[id,pokemon,owner]),/check constraint/);
  });
  await t.test('actual canonical species IDs accept evolution rules, missing targets fail FK without fabricated catalog data',async()=>{
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM friendship_evolution_rules')).rows[0].n,0);
    await pool.query('INSERT INTO friendship_evolution_rules(species_id,evolution_species_id) VALUES(133,25)');
    await assert.rejects(pool.query('INSERT INTO friendship_evolution_rules(species_id,evolution_species_id) VALUES(133,196)'),/foreign key/);
  });
  await t.test('history or metadata blocks lossy bridge rollback atomically',async()=>{
    await assert.rejects(apply(pool,bridge,'down'),/Actual friendship history\/metadata exists/);
    assert.equal((await pool.query("SELECT 'pokemon_friendship'::regclass::oid AS oid")).rows[0].oid,before.oid);
    assert.ok((await pool.query('SELECT count(*)::int AS n FROM friendship_history')).rows[0].n>0);
  });
}));

test('unused friendship bridge reverses to exact original rows/function/trigger while preserving dependent views and FKs',async()=>fixture(async({pool})=>{
  await pool.query('ALTER TABLE pokemon_friendship DISABLE TRIGGER trigger_log_friendship_change');
  const before=await snapshot(pool);await pool.query('CREATE VIEW retained_bond AS SELECT id,user_id,friendship_level FROM pokemon_friendship');
  await apply(pool,bridge);assert.deepEqual((await snapshot(pool)).trigger,before.trigger);
  await apply(pool,bridge,'down');assert.deepEqual(await snapshot(pool),before);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM retained_bond')).rows[0].n,2);
  assert.equal((await pool.query("SELECT to_regclass('friendship_history') AS history,to_regclass('pokemon_affinity') AS projection")).rows[0].history,null);
}));

test('metadata alone prevents lossy rollback even without history',async()=>fixture(async({pool,id})=>{
  await apply(pool,bridge);await pool.query('UPDATE pokemon_friendship SET daily_walking_bonus=1 WHERE id=$1',[id]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM friendship_history')).rows[0].n,0);
  await assert.rejects(apply(pool,bridge,'down'),/Actual friendship history\/metadata exists/);
  assert.equal((await pool.query('SELECT daily_walking_bonus FROM pokemon_friendship WHERE id=$1',[id])).rows[0].daily_walking_bonus,1);
}));

test('unsupported bridge collisions and integer identity schemas fail without altering original data',async t=>{
  await t.test('existing history requires explicit reconciliation',async()=>fixture(async({pool})=>{
    const before=await snapshot(pool);await pool.query('CREATE TABLE friendship_history(id integer); INSERT INTO friendship_history VALUES(7)');
    await assert.rejects(apply(pool,bridge),/Existing friendship bridge objects/);assert.deepEqual(await snapshot(pool),before);
    assert.equal((await pool.query('SELECT id FROM friendship_history')).rows[0].id,7);
    assert.equal((await pool.query("SELECT to_regclass('friendship_identity_bridge_state') AS state")).rows[0].state,null);
  }));
  await t.test('integer instance identity never receives a fabricated UUID mapping',async()=>fixture(async({pool})=>{
    await pool.query('ALTER TABLE pokemon_friendship ADD COLUMN pokemon_instance_id integer');const before=await snapshot(pool);
    await assert.rejects(apply(pool,bridge),/Existing friendship bridge objects/);assert.deepEqual(await snapshot(pool),before);
  }));
  await t.test('actual integer row and instance IDs are rejected without arbitrary casts',async()=>fixture(async({pool})=>{
    await pool.query('DROP TABLE pokemon_friendship; CREATE TABLE pokemon_friendship(id integer PRIMARY KEY,pokemon_id integer,user_id uuid,friendship_value smallint,friendship_level smallint)');
    await pool.query('INSERT INTO pokemon_friendship VALUES(7,123,$1,50,1)',[crypto.randomUUID()]);
    const before=(await pool.query('SELECT * FROM pokemon_friendship')).rows;
    await assert.rejects(apply(pool,bridge),/Unsupported friendship identity\/column/);
    assert.deepEqual((await pool.query('SELECT * FROM pokemon_friendship')).rows,before);
  }));
  await t.test('custom log behavior is not silently replaced by the bridge',async()=>fixture(async({pool})=>{
    await pool.query("CREATE OR REPLACE FUNCTION log_friendship_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
    const before=await snapshot(pool);await assert.rejects(apply(pool,bridge),/Custom friendship logging/);
    assert.deepEqual(await snapshot(pool),before);
  }));
});
