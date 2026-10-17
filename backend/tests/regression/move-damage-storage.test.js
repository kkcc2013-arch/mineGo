'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const {Pool}=require('pg');
const express=require('express');const request=require('supertest');const {promisify}=require('node:util');const {execFile}=require('node:child_process');
const {parseMigrationFile}=require('../../../database/migrate');const {migrationStatements}=require('../../../database/sqlStatements');
const {MoveService}=require('../../services/pokemon-service/src/moveService');
const {createDamageRouter}=require('../../services/gym-service/src/routes/damage');
const {createMoveRouter}=require('../../services/pokemon-service/src/routes/moves');
const {signAccess,errorHandler}=require('../../shared/auth');
const root=path.resolve(__dirname,'../../..');const repair='database/pending/repairs/20260615_221000__add_damage_system.sql';
async function apply(pool,direction='up'){
  const parsed=parseMigrationFile(await fs.readFile(path.join(root,repair),'utf8'));const c=await pool.connect();
  try{await c.query('BEGIN');for(const sql of migrationStatements(parsed[direction]))await c.query(sql);await c.query('COMMIT');}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function fixture(fn){
  assert.ok(process.env.TEST_DATABASE_URL,'isolated PostGIS is required');
  const schema=`move_damage_${crypto.randomBytes(8).toString('hex')}`;const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});const owner=crypto.randomUUID();
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query(await fs.readFile(path.join(root,'database/seeds/V2__seed_data.sql'),'utf8'));
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[owner,'move-owner']);
    await pool.query(await fs.readFile(path.join(root,'database/pending/20260605_180000__add_moves_and_tm_system.sql'),'utf8'));
    const db={query:pool.query.bind(pool),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};const service=new MoveService({db});
    await fn({pool,owner,service});
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function snapshot(pool){return {
  moves:(await pool.query("SELECT to_jsonb(m)-'name'-'energy_cost' AS row FROM moves m ORDER BY id")).rows,
  tm:(await pool.query('SELECT * FROM technical_machines ORDER BY id')).rows,
  learnset:(await pool.query('SELECT * FROM pokemon_moves ORDER BY species_id,move_id')).rows,
  keys:(await pool.query("SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE confrelid='moves'::regclass OR conrelid='moves'::regclass ORDER BY oid")).rows,
  oid:(await pool.query("SELECT 'moves'::regclass::oid AS oid")).rows[0].oid
};}
test('canonical moves survive damage upgrade and derived aliases remain tied to live energy',async t=>fixture(async({pool,service,owner})=>{
  await pool.query("UPDATE moves SET power=17,energy_delta=12,duration_ms=1234 WHERE id='EMBER'");
  await pool.query('CREATE VIEW retained_move_catalog AS SELECT id,power,energy_delta FROM moves');
  const before=await snapshot(pool);await apply(pool);
  await t.test('all original IDs, localized names, power/energy/type/dates/FKs/TMs/learnsets and OID survive',async()=>assert.deepEqual(await snapshot(pool),before));
  await t.test('all24 proposed original values are retained as configuration, not overwritten catalog data',async()=>{
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM damage_move_defaults')).rows[0].n,24);
    assert.equal((await pool.query("SELECT power FROM damage_move_defaults WHERE move_name='ember'")).rows[0].power,40);
    assert.equal((await service.getMoveById('EMBER')).power,17);
    assert.equal((await pool.query('SELECT power FROM retained_move_catalog WHERE id=$1',['EMBER'])).rows[0].power,17);
  });
  await t.test('real MoveService keeps uppercase type/category filtering and reads the actual catalog',async()=>{
    const result=await service.getMoves({type:'fire',category:'fast',limit:100});assert.ok(result.total>0);
    assert.ok(result.moves.every(row=>row.type==='FIRE'&&row.category==='FAST'));assert.equal(result.moves.find(row=>row.id==='EMBER').duration_ms,1234);
    assert.equal((await service.getMoves({limit:100})).total,before.moves.length);assert.ok(before.moves.length>=50);
  });
  await t.test('read-only name and consumed-energy projections update from real delta including integer minimum',async()=>{
    const row=await service.getMoveById('EMBER');assert.equal(row.name,'ember');assert.equal(row.energy_cost,'0');
    await pool.query("UPDATE moves SET energy_delta=-2147483648 WHERE id='EMBER'");assert.equal((await service.getMoveById('EMBER')).energy_cost,'2147483648');
    await assert.rejects(pool.query("UPDATE moves SET energy_cost=3 WHERE id='EMBER'"),error=>error.code==='428C9');
    await pool.query("UPDATE moves SET energy_delta=12 WHERE id='EMBER'");
  });
  await t.test('current Pokemon and TM references retain canonical identity rather than lowercase duplicates',async()=>{
    await pool.query("INSERT INTO tm_inventory(user_id,tm_id,quantity) VALUES($1,'TM04',2)",[owner]);
    assert.equal((await pool.query('SELECT tm.move_id FROM tm_inventory i JOIN technical_machines tm ON i.tm_id=tm.id WHERE user_id=$1',[owner])).rows[0].move_id,'EMBER');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM moves WHERE id='ember'")).rows[0].n,0);
  });
  await t.test('actual owned Pokemon move details read the unchanged learning pool',async()=>{
    const {rows:[pokemon]}=await pool.query(`INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp,fast_move,charge_move,learned_fast_moves,learned_charge_moves)
      VALUES($1,25,100,10,10,1,2,3,'QUICK_ATTACK','THUNDER',ARRAY['QUICK_ATTACK'],ARRAY['THUNDER']) RETURNING id`,[owner]);
    const result=await service.getPokemonMoves(owner,pokemon.id);assert.equal(result.currentFastMove,'QUICK_ATTACK');
    assert.equal(result.learnedFastMoves[0].id,'QUICK_ATTACK');assert.ok(result.availableMoves.some(row=>row.move_id==='THUNDERBOLT'));
    await assert.rejects(service.getPokemonMoves(crypto.randomUUID(),pokemon.id),/not owned/);
  });
  await t.test('reverse removes only owned projections/configuration and preserves updated original data',async()=>{
    const current=await snapshot(pool);await apply(pool,'down');assert.deepEqual(await snapshot(pool),current);
    assert.equal((await pool.query("SELECT to_regclass('damage_move_defaults') AS name")).rows[0].name,null);
  });
}));
test('actual learning transactions consume a TM once and roll back failed grants',async t=>fixture(async({pool,service,owner})=>{
  await apply(pool);
  const create=async()=> (await pool.query(`INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp,fast_move,charge_move,learned_fast_moves,learned_charge_moves)
    VALUES($1,25,100,10,10,1,2,3,'QUICK_ATTACK','THUNDER',ARRAY['QUICK_ATTACK'],ARRAY['THUNDER']) RETURNING id`,[owner])).rows[0].id;
  const first=await create(),second=await create();
  await t.test('simultaneous requests for different Pokemon cannot spend one TM twice',async()=>{
    await pool.query("INSERT INTO tm_inventory(user_id,tm_id,quantity) VALUES($1,'TM13',1)",[owner]);
    const results=await Promise.allSettled([service.learnMove(owner,first,'TM13'),service.learnMove(owner,second,'TM13')]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pokemon_instances WHERE user_id=$1 AND 'THUNDERBOLT'=ANY(learned_charge_moves)",[owner])).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tm_inventory WHERE user_id=$1 AND tm_id='TM13'",[owner])).rows[0].n,0);
  });
  const third=await create();
  await t.test('resource mutation failure rolls back both learned move and inventory quantity',async()=>{
    await pool.query("INSERT INTO tm_inventory(user_id,tm_id,quantity) VALUES($1,'TM13',2)",[owner]);
    await pool.query("CREATE FUNCTION fail_tm_cost() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated TM failure'; END; $$; CREATE TRIGGER fail_tm_cost BEFORE UPDATE ON tm_inventory FOR EACH ROW EXECUTE FUNCTION fail_tm_cost()");
    await assert.rejects(service.learnMove(owner,third,'TM13'),/isolated TM failure/);
    assert.deepEqual((await pool.query('SELECT learned_charge_moves FROM pokemon_instances WHERE id=$1',[third])).rows[0].learned_charge_moves,['THUNDER']);
    assert.equal((await pool.query("SELECT quantity FROM tm_inventory WHERE user_id=$1 AND tm_id='TM13'",[owner])).rows[0].quantity,2);
    await pool.query('DROP TRIGGER fail_tm_cost ON tm_inventory; DROP FUNCTION fail_tm_cost()');
  });
  await t.test('equipped moves cannot be forgotten; switching and forgetting serialize on actual owner/instance',async()=>{
    await service.learnMove(owner,third,'TM13');await service.switchMove(owner,third,null,'THUNDERBOLT');
    await assert.rejects(service.forgetMove(owner,third,'THUNDERBOLT'),/currently equipped/);
    await service.switchMove(owner,third,null,'THUNDER');await service.forgetMove(owner,third,'THUNDERBOLT');
    assert.deepEqual((await pool.query('SELECT learned_charge_moves FROM pokemon_instances WHERE id=$1',[third])).rows[0].learned_charge_moves,['THUNDER']);
    await assert.rejects(service.switchMove(crypto.randomUUID(),third,'QUICK_ATTACK'),/not owned/);
  });
}));
test('mounted production move API preserves UUID identity, actual ownership and inventory operations',async t=>fixture(async({pool,service,owner})=>{
  await apply(pool);const app=express();app.use(express.json());app.use('/',createMoveRouter(service));
  const {rows:[p]}=await pool.query(`INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp,fast_move,charge_move,learned_fast_moves,learned_charge_moves)
    VALUES($1,25,100,10,10,1,2,3,'QUICK_ATTACK','THUNDER',ARRAY['QUICK_ATTACK'],ARRAY['THUNDER']) RETURNING id`,[owner]);
  const auth=(method,url)=>request(app)[method](url).set('Authorization',`Bearer ${signAccess({id:owner})}`);
  const base=`/pokemon/my/${p.id}/moves`;
  await t.test('actual list/detail/learnset and private UUID move reads work',async()=>{
    assert.ok((await request(app).get('/moves').expect(200)).body.total>=50);
    assert.equal((await request(app).get('/moves/ember').expect(200)).body.move.id,'EMBER');
    await request(app).get('/pokemon/25/learnset').expect(200);
    assert.equal((await auth('get',base).expect(200)).body.pokemonId,p.id);
    await request(app).get(base).expect(401);
    await request(app).get(base).set('Authorization',`Bearer ${signAccess({id:crypto.randomUUID()})}`).expect(404);
  });
  await t.test('learning, inventory, switching and forgetting mutate actual UUID records',async()=>{
    await pool.query("INSERT INTO tm_inventory(user_id,tm_id,quantity) VALUES($1,'TM13',2)",[owner]);
    await auth('get','/tm/my').expect(200);
    await auth('post',base+'/learn').send({tmId:'TM13'}).expect(200);
    await auth('post',base+'/switch').send({chargeMoveId:'THUNDERBOLT'}).expect(200);
    await auth('post',base+'/forget').send({moveId:'THUNDERBOLT'}).expect(400);
    await auth('post',base+'/switch').send({chargeMoveId:'THUNDER'}).expect(200);
    await auth('post',base+'/forget').send({moveId:'THUNDERBOLT'}).expect(200);
    await auth('post','/tm/use').send({pokemonId:p.id,tmId:'TM13'}).expect(200);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM tm_inventory WHERE user_id=$1 AND tm_id='TM13'",[owner])).rows[0].n,0);
  });
  await t.test('numeric/truncated instance IDs and malformed query/body values do not become UUIDs or SQL',async()=>{
    await auth('get','/pokemon/my/123/moves').expect(400);
    await auth('post','/tm/use').send({pokemonId:123,tmId:'TM13'}).expect(400);
    await request(app).get('/moves').query({limit:-1}).expect(400);
    await request(app).get('/moves').query({type:['FIRE','WATER']}).expect(400);
    await auth('post',base+'/learn').send({tmId:['TM13']}).expect(400);
    await auth('post',base+'/switch').send({chargeMoveId:'THUNDER',userId:crypto.randomUUID()}).expect(400);
    const source=await fs.readFile(path.join(root,'backend/services/pokemon-service/src/index.js'),'utf8');assert.ok(source.includes("app.use('/', require('./routes/moves'))"));
  });
}));
test('unknown alias, ambiguous identity and changed owned defaults/index refuse lossy changes',async t=>{
  for(const [label,sql,stage,pattern] of [
    ['writable old name',"ALTER TABLE moves ADD COLUMN name text DEFAULT 'operator name'",'up',/moves.name/],
    ['writable old cost','ALTER TABLE moves ADD COLUMN energy_cost integer DEFAULT 99','up',/moves.energy_cost/],
    ['ambiguous canonical ID',"INSERT INTO moves(id,name_zh,name_en,type,category,energy_delta,duration_ms,cooldown_ms) VALUES('ember','custom','Custom','FIRE','FAST',0,1,1)",'up',/unique/],
    ['modified defaults',"UPDATE damage_move_defaults SET power=99 WHERE move_name='ember'",'down',/defaults changed/],
    ['modified projection comment',"COMMENT ON COLUMN moves.name IS 'operator comment'",'down',/alias changed/],
    ['replacement index','DROP INDEX damage_catalog_name_identity; CREATE UNIQUE INDEX damage_catalog_name_identity ON moves(name)','down',/identity changed/]
  ])await t.test(label,async()=>fixture(async({pool})=>{
    if(stage==='down')await apply(pool);await pool.query(sql);const before=await snapshot(pool);
    const rows=(await pool.query('SELECT to_jsonb(m) AS row FROM moves m ORDER BY id')).rows;
    const profiles=stage==='down'?(await pool.query('SELECT * FROM damage_move_defaults ORDER BY move_name')).rows:null;
    await assert.rejects(apply(pool,stage),pattern);assert.deepEqual(await snapshot(pool),before);
    assert.deepEqual((await pool.query('SELECT to_jsonb(m) AS row FROM moves m ORDER BY id')).rows,rows);
    if(profiles)assert.deepEqual((await pool.query('SELECT * FROM damage_move_defaults ORDER BY move_name')).rows,profiles);
  }));
});
test('existing exact generated aliases remain operator-owned through upgrade and reversal',async()=>fixture(async({pool})=>{
  await pool.query('ALTER TABLE moves ADD COLUMN name text GENERATED ALWAYS AS(lower(id)) STORED; ALTER TABLE moves ADD COLUMN energy_cost bigint GENERATED ALWAYS AS(GREATEST(0::bigint,-energy_delta::bigint)) STORED');
  await pool.query("COMMENT ON COLUMN moves.name IS 'operator derived name'; CREATE VIEW operator_move_alias AS SELECT id,name,energy_cost FROM moves");
  const rows=(await pool.query('SELECT * FROM operator_move_alias ORDER BY id')).rows;
  await apply(pool);await apply(pool,'down');assert.deepEqual((await pool.query('SELECT * FROM operator_move_alias ORDER BY id')).rows,rows);
  assert.equal((await pool.query("SELECT col_description('moves'::regclass,attnum) AS comment FROM pg_attribute WHERE attrelid='moves'::regclass AND attname='name'")).rows[0].comment,'operator derived name');
}));
test('a real view depending on owned aliases prevents reversal without removing dependencies',async()=>fixture(async({pool})=>{
  await apply(pool);await pool.query('CREATE VIEW retained_damage_alias AS SELECT id,name,energy_cost FROM moves');
  const before=(await pool.query('SELECT * FROM retained_damage_alias ORDER BY id')).rows;
  await assert.rejects(apply(pool,'down'),error=>error.code==='2BP01');
  assert.deepEqual((await pool.query('SELECT * FROM retained_damage_alias ORDER BY id')).rows,before);
  assert.ok((await pool.query("SELECT to_regclass('damage_catalog_name_identity') AS name")).rows[0].name);
}));
test('production damage routes use real species/moves with authenticated simulation and deterministic averages',async t=>fixture(async({pool})=>{
  await apply(pool);const app=express();app.use(express.json());app.use(['/api/v1/gym/damage','/api/v1/gym/battle'],createDamageRouter(pool.query.bind(pool)));app.use(errorHandler);
  const token=signAccess({id:crypto.randomUUID()});const body={attacker:{species_id:6,attack:150,fast_move:'ember'},defender:{species_id:9,defense:120}};
  const simulate=data=>request(app).post('/api/v1/gym/battle/simulate').set('Authorization',`Bearer ${token}`).send(data);
  await t.test('anonymous/forged requests fail and valid existing canonical data supplies damage',async()=>{
    await request(app).post('/api/v1/gym/battle/simulate').set('X-User-Id','forged').send(body).expect(401);
    const response=await simulate(body).expect(200);assert.equal(response.body.damage_multiplier,0.5);
    assert.equal(response.body.data.move.id,'EMBER');assert.equal(response.body.data.move.power,10);assert.ok(response.body.data.damage>0);
    assert.equal(response.body.data.hasStab,true);assert.equal(response.body.data.defender.name,'Blastoise');
  });
  await t.test('both mounted aliases read operator values; averages do not draw new random damage',async()=>{
    await pool.query("UPDATE moves SET power=22 WHERE id='EMBER'");const results=[];
    for(let i=0;i<5;i++)results.push((await simulate(body).expect(200)).body.data);
    assert.ok(results.every(row=>row.move.power===22));assert.ok(results.every(row=>JSON.stringify(row.averageDamage)===JSON.stringify(results[0].averageDamage)));
    await request(app).post('/api/v1/gym/damage/simulate').set('Authorization',`Bearer ${token}`).send(body).expect(200);
  });
  await t.test('missing moves/species do not become fake fallback data and slot category is enforced',async()=>{
    await simulate({...body,attacker:{...body.attacker,fast_move:'missing_move'}}).expect(404);
    await simulate({...body,defender:{species_id:30000,defense:120}}).expect(404);
    await simulate({...body,attacker:{...body.attacker,fast_move:'HYDRO_PUMP'}}).expect(400);
    await simulate({...body,attacker:{species_id:6,attack:150,charged_move:'HYDRO_PUMP'}}).expect(200);
  });
  await t.test('zero power and actual immune dual-type species yield zero estimates without crashing',async()=>{
    await pool.query("UPDATE moves SET power=0 WHERE id='EMBER'");let response=await simulate(body).expect(200);assert.equal(response.body.data.damage,0);assert.equal(response.body.data.averageDamage.avgDamage,0);
    response=await simulate({attacker:{species_id:25,attack:100,fast_move:'quick_attack'},defender:{species_id:94,defense:100}}).expect(200);
    assert.equal(response.body.data.isImmune,true);assert.deepEqual([response.body.data.damage,...['minDamage','maxDamage','avgDamage'].map(k=>response.body.data.averageDamage[k])],[0,0,0,0]);
  });
  await t.test('invalid numbers, strings, prototype types, arrays and weather are rejected',async()=>{
    for(const attack of [0,-1,'150',1e7])await simulate({...body,attacker:{...body.attacker,attack}}).expect(400);
    await simulate({...body,weather:'__proto__'}).expect(400);await simulate({...body,attacker:[body.attacker]}).expect(400);
    await request(app).get('/api/v1/gym/damage/effectiveness').query({attackType:'constructor',defenderType1:'water'}).expect(400);
    await request(app).get('/api/v1/gym/damage/effectiveness').query({attackType:['fire','water'],defenderType1:'water'}).expect(400);
  });
  await t.test('all static endpoints and exact documented curl path are reachable',async()=>{
    assert.equal((await request(app).get('/api/v1/gym/damage/typechart').expect(200)).body.data.totalTypes,18);
    await request(app).get('/api/v1/gym/damage/weather').expect(200);
    const response=await request(app).get('/api/v1/gym/damage/effectiveness').query({attackType:'fire',defenderType1:'grass',defenderType2:'bug'}).expect(200);assert.equal(response.body.data.multiplier,4);
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    try{const {stdout}=await promisify(execFile)('curl',['-sf','--max-time','5','-H',`Authorization: Bearer ${token}`,'-H','Content-Type: application/json','-d',JSON.stringify(body),`http://127.0.0.1:${server.address().port}/api/v1/gym/battle/simulate`]);assert.equal(JSON.parse(stdout).damage_multiplier,0.5);}
    finally{await new Promise(resolve=>server.close(resolve));}
    const source=await fs.readFile(path.join(root,'backend/services/gym-service/src/index.js'),'utf8');assert.ok(source.includes("app.use(['/api/v1/gym/damage', '/api/v1/gym/battle'], damageRoutes)"));
  });
}));
