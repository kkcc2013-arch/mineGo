'use strict';
// REQ-00160: actual genotype flags, current ownership, configuration and reversal.
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const {Pool}=require('pg');
const {parseMigrationFile}=require('../../../database/migrate');const {migrationStatements}=require('../../../database/sqlStatements');
const {generateWildIVs}=require('../../shared/specialIv');
const root=path.resolve(__dirname,'../../..');const source='database/pending/repairs/20260613_160000__add_special_iv_system.sql';
async function apply(pool,direction='up') {const parsed=parseMigrationFile(await fs.readFile(path.join(root,source),'utf8'));const c=await pool.connect();try{await c.query('BEGIN');for(const sql of migrationStatements(parsed[direction]))await c.query(sql);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function fixture(fn) {
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`special_iv_${crypto.randomBytes(8).toString('hex')}`;const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});const owner=crypto.randomUUID(),other=crypto.randomUUID();
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));await pool.query(await fs.readFile(path.join(root,'database/seeds/V2__seed_data.sql'),'utf8'));
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2),($3,$4)',[owner,'iv-owner',other,'iv-other']);
    const rows=[];for(const [iv,lucky] of [[0,false],[15,false],[12,true]]){
      const {rows:[row]}=await pool.query(`INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp,is_lucky,caught_at,created_at,updated_at)
        VALUES($1,25,100,10,10,$2,$2,$2,$3,'2020-01-01','2020-01-01','2020-01-02') RETURNING id`,[owner,iv,lucky]);rows.push(row.id);
      await pool.query(`INSERT INTO wild_pokemon(species_id,lat,lng,location,cp,iv_attack,iv_defense,iv_hp,spawned_at,expires_at)
        VALUES(25,0,0,ST_GeogFromText('SRID=4326;POINT(0 0)'),100,$1,$1,$1,'2020-01-01','2020-01-02')`,[iv]);
    }
    await fn({pool,schema,owner,other,zero:rows[0],perfect:rows[1],lucky:rows[2]});
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function snapshot(pool){return {
  instances:(await pool.query("SELECT to_jsonb(p)-'is_zero_iv'-'is_perfect_iv' AS row FROM pokemon_instances p ORDER BY id")).rows,
  wild:(await pool.query("SELECT to_jsonb(p)-'is_zero_iv'-'is_perfect_iv' AS row FROM wild_pokemon p ORDER BY id")).rows,
  relations:(await pool.query("SELECT oid,relname FROM pg_class WHERE oid IN('pokemon_instances'::regclass,'wild_pokemon'::regclass) ORDER BY oid")).rows,
  keys:(await pool.query("SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='pokemon_instances'::regclass ORDER BY oid")).rows
};}
async function compareCounts(pool){
  const {rows}=await pool.query(`WITH actual AS(SELECT user_id,count(*) FILTER(WHERE is_zero_iv)::int AS z,count(*) FILTER(WHERE is_perfect_iv)::int AS p,
    count(*) FILTER(WHERE is_lucky)::int AS l FROM pokemon_instances GROUP BY user_id)
    SELECT COALESCE(s.user_id,a.user_id) AS user_id,s.zero_iv_count AS z,s.perfect_iv_count AS p,s.lucky_count AS l,
    COALESCE(a.z,0) AS az,COALESCE(a.p,0) AS ap,COALESCE(a.l,0) AS al FROM user_special_iv_stats s FULL JOIN actual a USING(user_id)`);
  for(const row of rows)assert.deepEqual([row.z,row.p,row.l],[row.az,row.ap,row.al]);
}
test('special IV upgrade preserves actual values, flags genotype and maintains current-owner counts',async t=>fixture(async f=>{
  const {pool,owner,other,zero,perfect,lucky}=f;const before=await snapshot(pool);
  await pool.query('CREATE VIEW retained_iv AS SELECT id,user_id,iv_attack,is_lucky FROM pokemon_instances');
  await pool.query('CREATE TABLE retained_iv_ref(id uuid PRIMARY KEY REFERENCES pokemon_instances(id)); INSERT INTO retained_iv_ref SELECT id FROM pokemon_instances');
  await pool.query(`CREATE TABLE old_iv_events(id integer); CREATE FUNCTION old_iv_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=NOW(); INSERT INTO old_iv_events VALUES(1); RETURN NEW; END $$;
    CREATE TRIGGER old_iv_metadata BEFORE UPDATE ON pokemon_instances FOR EACH ROW EXECUTE FUNCTION old_iv_metadata()`);
  await pool.query(`CREATE TRIGGER disabled_iv_metadata BEFORE UPDATE ON pokemon_instances FOR EACH ROW EXECUTE FUNCTION old_iv_metadata(); ALTER TABLE pokemon_instances DISABLE TRIGGER disabled_iv_metadata`);
  const triggers=(await pool.query("SELECT oid,tgname,tgenabled FROM pg_trigger WHERE tgrelid='pokemon_instances'::regclass AND NOT tgisinternal ORDER BY oid")).rows;
  await apply(pool);
  await t.test('original UUIDs, values, lucky flags, dates, OIDs, keys, views and FK references survive',async()=>{assert.deepEqual(await snapshot(pool),before);assert.equal((await pool.query('SELECT count(*)::int AS n FROM retained_iv_ref')).rows[0].n,3);});
  await t.test('backfill derives historical zero/perfect flags without replaying old user triggers',async()=>{
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM old_iv_events')).rows[0].n,0);
    const current=(await pool.query("SELECT oid,tgname,tgenabled FROM pg_trigger WHERE oid=ANY($1::oid[]) ORDER BY oid",[triggers.map(t=>t.oid)])).rows;assert.deepEqual(current,triggers);
    assert.deepEqual((await pool.query('SELECT is_zero_iv,is_perfect_iv,is_lucky FROM pokemon_instances WHERE id=$1',[zero])).rows[0],{is_zero_iv:true,is_perfect_iv:false,is_lucky:false});
    await compareCounts(pool);
  });
  await t.test('spawn materialization uses real spawned_at and exact historical counts',async()=>{
    const row=(await pool.query('SELECT spawn_date::text AS day,zero_iv_count::int AS z,perfect_iv_count::int AS p,total_spawns::int AS total FROM special_iv_spawn_stats')).rows[0];assert.deepEqual(row,{day:'2020-01-01',z:1,p:1,total:3});
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='wild_pokemon' AND column_name='created_at'")).rows[0].n,0);
  });
  await t.test('new declared flags are overridden by actual genotype',async()=>{
    const {rows:[row]}=await pool.query(`INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp,is_zero_iv,is_perfect_iv)
      VALUES($1,25,100,10,10,1,2,3,TRUE,TRUE) RETURNING is_zero_iv,is_perfect_iv`,[owner]);assert.deepEqual(row,{is_zero_iv:false,is_perfect_iv:false});await compareCounts(pool);
  });
  await t.test('actual location-service INSERT persists and returns the real generated IV tuple and flags',async()=>{
    const src=await fs.readFile(path.join(root,'backend/services/location-service/src/index.js'),'utf8');
    const sql=src.match(/INSERT INTO wild_pokemon[\s\S]*?RETURNING[^\n]+/)[0].replace('${lng}','0').replace('${lat}','0');
    const generated=generateWildIVs({random:()=>0.0002});
    const {rows:[row]}=await pool.query(sql,[null,25,0,0,100,generated.iv_attack,generated.iv_defense,generated.iv_hp,false,false,'2020-01-02',generated.is_zero_iv,generated.is_perfect_iv]);
    assert.deepEqual([row.iv_attack,row.iv_defense,row.iv_hp,row.is_zero_iv,row.is_perfect_iv],[15,15,15,false,true]);
  });
  await t.test('genotype mutation updates both flags and cached counts',async()=>{
    await pool.query('UPDATE pokemon_instances SET iv_attack=1 WHERE id=$1',[zero]);assert.equal((await pool.query('SELECT is_zero_iv FROM pokemon_instances WHERE id=$1',[zero])).rows[0].is_zero_iv,false);await compareCounts(pool);
  });
  await t.test('ownership transfer updates former and current trainer counts',async()=>{await pool.query('UPDATE pokemon_instances SET user_id=$1 WHERE id=$2',[other,perfect]);await compareCounts(pool);});
  await t.test('lucky state changes update the same authoritative count',async()=>{await pool.query('UPDATE pokemon_instances SET is_lucky=FALSE WHERE id=$1',[lucky]);await compareCounts(pool);});
  await t.test('deleting a special record removes its owner count',async()=>{await pool.query('DELETE FROM retained_iv_ref WHERE id=$1',[perfect]);await pool.query('DELETE FROM pokemon_instances WHERE id=$1',[perfect]);await compareCounts(pool);});
  await t.test('parallel inserts retain exact counts without lost increments',async()=>{
    await Promise.all(Array.from({length:12},()=>pool.query('INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) VALUES($1,25,100,10,10,0,0,0)',[other])));await compareCounts(pool);
  });
  await t.test('opposite trainer transfers do not lock counters in opposite order',async()=>{
    const a=(await pool.query('SELECT id FROM pokemon_instances WHERE user_id=$1 LIMIT 1',[owner])).rows[0].id;
    const b=(await pool.query('SELECT id FROM pokemon_instances WHERE user_id=$1 LIMIT 1',[other])).rows[0].id;
    await Promise.all([pool.query('UPDATE pokemon_instances SET user_id=$1 WHERE id=$2',[other,a]),pool.query('UPDATE pokemon_instances SET user_id=$1 WHERE id=$2',[owner,b])]);await compareCounts(pool);
  });
  await t.test('failed transaction leaves genotype, owner and counters unchanged',async()=>{
    const rows=(await pool.query('SELECT * FROM user_special_iv_stats ORDER BY user_id')).rows;const c=await pool.connect();try{await c.query('BEGIN');await c.query('UPDATE pokemon_instances SET is_lucky=TRUE WHERE id=$1',[lucky]);await c.query('ROLLBACK');}finally{c.release();}assert.deepEqual((await pool.query('SELECT * FROM user_special_iv_stats ORDER BY user_id')).rows,rows);
  });
  await t.test('existing trade lucky-floor SQL updates real genotype and derived counts',async()=>{
    const src=await fs.readFile(path.join(root,'backend/services/social-service/src/routes/trade.js'),'utf8');
    const sql=src.match(/UPDATE pokemon_instances SET\s+iv_attack = GREATEST\([\s\S]*?WHERE id = \$1 OR id = \$2/)[0];await pool.query(sql,[zero,lucky]);
    for(const row of (await pool.query('SELECT iv_attack,iv_defense,iv_hp,is_lucky FROM pokemon_instances WHERE id=ANY($1::uuid[])',[[zero,lucky]])).rows){assert.ok(row.iv_attack>=12&&row.iv_defense>=12&&row.iv_hp>=12);assert.equal(row.is_lucky,true);}await compareCounts(pool);
  });
  await t.test('ordinary user deletion cascades do not resurrect a cache or fail its foreign key',async()=>{
    const user=crypto.randomUUID();await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[user,'iv-cascade']);await pool.query('INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) VALUES($1,25,100,10,10,15,15,15)',[user]);await pool.query('DELETE FROM users WHERE id=$1',[user]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_special_iv_stats WHERE user_id=$1',[user])).rows[0].n,0);
  });
  await t.test('used derived storage reverses while retaining every current original field and original triggers',async()=>{
    const current=await snapshot(pool);await apply(pool,'down');assert.deepEqual(await snapshot(pool),current);assert.equal((await pool.query("SELECT to_regclass('user_special_iv_stats') AS name")).rows[0].name,null);
    assert.deepEqual((await pool.query("SELECT oid,tgname,tgenabled FROM pg_trigger WHERE tgrelid='pokemon_instances'::regclass AND NOT tgisinternal ORDER BY oid")).rows,triggers);
  });
}));

test('existing game configuration values, metadata and relation identity are preserved',async()=>fixture(async({pool})=>{
  await pool.query('CREATE TABLE game_configs(key text PRIMARY KEY,value text NOT NULL,description text,updated_at timestamptz NOT NULL); INSERT INTO game_configs VALUES(\'lucky_pokemon_chance\',\'0.08\',\'operator setting\',\'2020-01-01\')');
  const before=(await pool.query('SELECT * FROM game_configs')).rows;const oid=(await pool.query("SELECT 'game_configs'::regclass::oid AS oid")).rows[0].oid;
  await apply(pool);assert.equal((await pool.query("SELECT value FROM game_configs WHERE key='lucky_pokemon_chance'")).rows[0].value,'0.08');
  await apply(pool,'down');assert.deepEqual((await pool.query('SELECT * FROM game_configs')).rows,before);assert.equal((await pool.query("SELECT 'game_configs'::regclass::oid AS oid")).rows[0].oid,oid);
}));
test('changed owned configuration refuses lossy reversal',async()=>fixture(async({pool})=>{
  await apply(pool);await pool.query("UPDATE game_configs SET value='0.2' WHERE key='zero_iv_chance'");await assert.rejects(apply(pool,'down'),/configuration changed/);assert.equal((await pool.query("SELECT value FROM game_configs WHERE key='zero_iv_chance'")).rows[0].value,'0.2');
}));
test('invalid historical genotype is rejected atomically without clamping original values',async()=>fixture(async({pool})=>{
  await pool.query('UPDATE wild_pokemon SET iv_attack=20');const before=await snapshot(pool);await assert.rejects(apply(pool),/Invalid existing IV values/);assert.deepEqual(await snapshot(pool),before);
}));
test('contradictory preexisting flags require explicit reconciliation',async()=>fixture(async({pool})=>{
  await pool.query('ALTER TABLE pokemon_instances ADD COLUMN is_zero_iv boolean DEFAULT FALSE');const before=await snapshot(pool);await assert.rejects(apply(pool),/flags contradict genotype/);assert.deepEqual(await snapshot(pool),before);
}));
test('owned relation identity cannot be replaced and silently dropped on reverse',async()=>fixture(async({pool})=>{
  await apply(pool);await pool.query('ALTER MATERIALIZED VIEW special_iv_spawn_stats RENAME TO retained_materialization; CREATE TABLE special_iv_spawn_stats(id integer); INSERT INTO special_iv_spawn_stats VALUES(7)');
  await assert.rejects(apply(pool,'down'),/Owned special IV relation identity changed/);assert.equal((await pool.query('SELECT id FROM special_iv_spawn_stats')).rows[0].id,7);
}));
test('a same-name configuration in another search-path schema is never adopted or modified',async()=>fixture(async({pool,schema})=>{
  const decoy=`iv_decoy_${crypto.randomBytes(8).toString('hex')}`;await pool.query(`CREATE SCHEMA ${decoy}; CREATE TABLE ${decoy}.game_configs(key text PRIMARY KEY,value text); INSERT INTO ${decoy}.game_configs VALUES('zero_iv_chance','operator decoy')`);
  const alternate=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},${decoy},public`});
  try{await apply(alternate);assert.equal((await alternate.query("SELECT value FROM game_configs WHERE key='zero_iv_chance'")).rows[0].value,'0.0001');assert.equal((await pool.query(`SELECT value FROM ${decoy}.game_configs`)).rows[0].value,'operator decoy');await apply(alternate,'down');assert.equal((await pool.query(`SELECT value FROM ${decoy}.game_configs`)).rows[0].value,'operator decoy');}
  finally{await alternate.end();await pool.query(`DROP SCHEMA ${decoy} CASCADE`);}
}));
test('custom cache fields and function behavior cannot be silently discarded on down',async t=>{
  await t.test('new nonderived cache data is preserved by refusing reversal',async()=>fixture(async({pool})=>{
    await apply(pool);await pool.query("ALTER TABLE user_special_iv_stats ADD COLUMN custom_note text; UPDATE user_special_iv_stats SET custom_note='operator data'");
    await assert.rejects(apply(pool,'down'),/cache structure changed/);assert.equal((await pool.query('SELECT custom_note FROM user_special_iv_stats LIMIT 1')).rows[0].custom_note,'operator data');
  }));
  await t.test('custom function definition is retained for explicit reconciliation',async()=>fixture(async({pool})=>{
    await apply(pool);await pool.query('CREATE OR REPLACE FUNCTION minego_derive_special_iv() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
    await assert.rejects(apply(pool,'down'),/Owned IV function changed/);
  }));
});
test('actual equipment migration uses valid active-template uniqueness and UUID lookup',async t=>fixture(async({pool,owner,zero,perfect})=>{
  const before=await snapshot(pool);const file='database/pending/repairs/20260614_081000__add_equipment_system.sql';
  const parsed=parseMigrationFile(await fs.readFile(path.join(root,file),'utf8'));const c=await pool.connect();try{await c.query('BEGIN');for(const statement of migrationStatements(parsed.up))await c.query(statement);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  const template=(await pool.query('SELECT id FROM equipment_templates ORDER BY id LIMIT 1')).rows[0].id;
  await t.test('original data remains and all four equipment tables/real seeds load',async()=>{
    assert.deepEqual(await snapshot(pool),before);
    for(const table of ['equipment_templates','equipment_sets','player_equipment','equipment_upgrades'])assert.ok((await pool.query('SELECT to_regclass($1) AS relation',[table])).rows[0].relation);
    const n=(await pool.query('SELECT count(*)::int AS n FROM equipment_templates')).rows[0].n;process.stdout.write(`Actual original equipment seed count: ${n}\n`);assert.ok(n>0);
  });
  await t.test('inactive copies coexist but duplicate active template on the same Pokemon is rejected',async()=>{
    await pool.query('INSERT INTO player_equipment(user_id,template_id,equipped_to_pokemon_id,is_equipped) VALUES($1,$2,$3,FALSE),($1,$2,$3,FALSE),($1,$2,$3,TRUE)',[owner,template,zero]);
    await assert.rejects(pool.query('INSERT INTO player_equipment(user_id,template_id,equipped_to_pokemon_id,is_equipped) VALUES($1,$2,$3,TRUE)',[owner,template,zero]),/uq_pokemon_equipment_type/);
    await pool.query('INSERT INTO player_equipment(user_id,template_id,equipped_to_pokemon_id,is_equipped) VALUES($1,$2,$3,TRUE)',[owner,template,perfect]);
  });
  await t.test('canonical UUID helper returns only actually active equipment with real calculated stats',async()=>{
    const {rows}=await pool.query('SELECT * FROM get_pokemon_equipment($1::uuid)',[zero]);assert.equal(rows.length,1);assert.equal(rows[0].template_id,template);assert.deepEqual(rows[0].current_stats,(await pool.query('SELECT calculate_equipment_stats($1,1::smallint) AS stats',[template])).rows[0].stats);
  });
  await t.test('canonical owner and Pokemon foreign keys reject fabricated identities',async()=>{
    await assert.rejects(pool.query('INSERT INTO player_equipment(user_id,template_id) VALUES($1,$2)',[crypto.randomUUID(),template]),/foreign key/);
    await assert.rejects(pool.query('INSERT INTO player_equipment(user_id,template_id,equipped_to_pokemon_id) VALUES($1,$2,$3)',[owner,template,crypto.randomUUID()]),/foreign key/);
  });
}));

test('production generator has exclusive category boundaries and handles ordinary bonuses',async t=>{
  const sequence=values=>{let i=0;return()=>values[i++];};
  await t.test('zero and perfect thresholds match the original explicit acceptance intervals',()=>{
    assert.equal(generateWildIVs({random:()=>0}).is_zero_iv,true);assert.equal(generateWildIVs({random:()=>0.0000999}).is_zero_iv,true);
    assert.equal(generateWildIVs({random:()=>0.0001}).is_perfect_iv,true);assert.equal(generateWildIVs({random:()=>0.0009999}).is_perfect_iv,true);
    assert.deepEqual(generateWildIVs({random:sequence([0.001,0.1,0.2,0.3])}),{iv_attack:1,iv_defense:3,iv_hp:4,is_zero_iv:false,is_perfect_iv:false});
  });
  await t.test('ordinary all-zero/all-perfect tuples are redrawn instead of inflating category rates',()=>{
    const a=generateWildIVs({random:sequence([0.5,0,0,0,0.99,0.99,0.99,0.1,0.2,0.3])});assert.deepEqual([a.iv_attack,a.iv_defense,a.iv_hp],[1,3,4]);
  });
  await t.test('ordinary bonuses cannot manufacture an extra perfect category',()=>{
    const a=generateWildIVs({ivBonus:0.2,random:sequence([0.5,0.99,0.99,0.99,0.1,0.2,0.3])});assert.deepEqual([a.iv_attack,a.iv_defense,a.iv_hp],[4,6,7]);assert.equal(a.is_perfect_iv,false);
  });
  await t.test('invalid random draws/configuration and pathological sources fail instead of hanging',()=>{
    for(const value of [-1,1,NaN,Infinity,'0.5'])assert.throws(()=>generateWildIVs({random:()=>value}),/Invalid random draw/);
    for(const value of [-1,1,NaN,'0'])assert.throws(()=>generateWildIVs({ivBonus:value}),/Invalid normal IV bonus/);
    let i=0;assert.throws(()=>generateWildIVs({random:()=>i++===0?0.5:0}),/failed to generate/);
  });
  await t.test('100000 real generator invocations record observed categories without fabricating numerical acceptance',()=>{
    const counts={zero:0,perfect:0,ordinary:0};for(let i=0;i<100000;i++){const p=generateWildIVs();if(p.is_zero_iv)counts.zero++;else if(p.is_perfect_iv)counts.perfect++;else counts.ordinary++;assert.equal(p.is_zero_iv,p.iv_attack===0&&p.iv_defense===0&&p.iv_hp===0);assert.equal(p.is_perfect_iv,p.iv_attack===15&&p.iv_defense===15&&p.iv_hp===15);}
    assert.equal(counts.zero+counts.perfect+counts.ordinary,100000);process.stdout.write(`Measured production IV generator, 100000 samples: ${JSON.stringify(counts)}\n`);
    // Frequency observations are retained as evidence. Full native-spawn/probability
    // acceptance needs its stated statistical protocol and is not replaced by this assertion.
  });
});
