'use strict';
// REQ-00082: real gameplay identity, risk telemetry, observed outcomes and statistics.
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const {Pool}=require('pg');
const {parseMigrationFile}=require('../../../database/migrate');const {migrationStatements}=require('../../../database/sqlStatements');
const {CatchRiskEngine,CatchSuccessRateAnalyzer}=require('../../shared/catchAnomalyDetector');
const root=path.resolve(__dirname,'../../..');const repair='database/pending/repairs/20260612_070000__add_catch_anomaly_detection_system.sql';
async function apply(pool,direction='up'){
  const sql=parseMigrationFile(await fs.readFile(path.join(root,repair),'utf8'));const c=await pool.connect();
  try{await c.query('BEGIN');for(const statement of migrationStatements(sql[direction]))await c.query(statement);await c.query('COMMIT');}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function fixture(fn){
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`catch_risk_${crypto.randomBytes(8).toString('hex')}`;const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const owner=crypto.randomUUID(),other=crypto.randomUUID(),wild=crypto.randomUUID(),session=crypto.randomUUID(),otherSession=crypto.randomUUID();
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query(await fs.readFile(path.join(root,'database/seeds/V2__seed_data.sql'),'utf8'));
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2),($3,$4)',[owner,'risk-owner',other,'risk-other']);
    await pool.query(`INSERT INTO wild_pokemon(id,species_id,lat,lng,location,cp,iv_attack,iv_defense,iv_hp,spawned_at,expires_at)
      VALUES($1,25,0,0,ST_GeogFromText('SRID=4326;POINT(0 0)'),100,1,1,1,'2020-01-01','2020-01-02')`,[wild]);
    await pool.query(`INSERT INTO catch_sessions(id,user_id,wild_pokemon_id,started_at,ended_at,result,balls_used,xp_earned)
      VALUES($1,$2,$3,'2020-01-01','2020-01-01 00:03','CAUGHT',2,200),($4,$5,$3,'2020-01-01','2020-01-01 00:04','FLED',1,0)`,[session,owner,wild,otherSession,other]);
    const {rows}=await pool.query(`INSERT INTO catch_throws(session_id,ball_type,throw_rating,is_curve,catch_prob,success,thrown_at)
      VALUES($1,'POKE_BALL','NICE',FALSE,0.25,FALSE,'2020-01-01 00:01'),($1,'GREAT_BALL','EXCELLENT',TRUE,0.75,TRUE,'2020-01-01 00:02'),
      ($2,'POKE_BALL','NICE',FALSE,0.25,FALSE,'2020-01-01 00:03') RETURNING id,session_id,success`,[session,otherSession]);
    const failed=rows.find(r=>r.session_id===session&&!r.success).id,success=rows.find(r=>r.success).id,foreign=rows.find(r=>r.session_id===otherSession).id;
    await fn({pool,schema,owner,other,wild,session,otherSession,failed,success,foreign,engine:new CatchRiskEngine({db:pool}),analyzer:new CatchSuccessRateAnalyzer({query:pool.query.bind(pool)})});
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
async function snapshot(pool){return {
  sessions:(await pool.query('SELECT * FROM catch_sessions ORDER BY id')).rows,
  throws:(await pool.query('SELECT * FROM catch_throws ORDER BY id')).rows,
  relations:(await pool.query("SELECT oid,relname FROM pg_class WHERE oid IN('catch_sessions'::regclass,'catch_throws'::regclass) ORDER BY oid")).rows,
  constraints:(await pool.query("SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN('catch_sessions'::regclass,'catch_throws'::regclass) ORDER BY oid")).rows
};}
async function totals(pool,user,pokemon){const {rows:[row]}=await pool.query('SELECT COALESCE(SUM(attempt_count),0)::int AS attempts,COALESCE(SUM(success_count),0)::int AS success FROM catch_success_stats WHERE user_id=$1 AND pokemon_id=$2',[user,pokemon]);return row;}
function decision(extra={}){return {riskScore:40,riskLevel:'medium',action:'warn',...extra};}

test('actual risk telemetry preserves gameplay storage, binds observed outcomes and commits counters durably',async t=>fixture(async f=>{
  const {pool,owner,other,wild,session,failed,success,foreign,engine,analyzer}=f;const before=await snapshot(pool);await pool.query('CREATE VIEW retained_catch_sessions AS SELECT id,user_id,result FROM catch_sessions');await apply(pool);
  const base={userId:owner,pokemonId:wild};let blockedId,failedId;
  await t.test('original session UUIDs/rows/throws/foreign keys/OIDs and dependent views are unchanged',async()=>{
    assert.deepEqual(await snapshot(pool),before);assert.equal((await pool.query('SELECT count(*)::int AS n FROM retained_catch_sessions')).rows[0].n,2);
  });
  await t.test('base rates remain configuration and do not masquerade as real user statistics',async()=>{
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM catch_base_rate_config')).rows[0].n,4);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM catch_success_stats')).rows[0].n,0);
  });
  await t.test('a blocked request with no observed throw stores real telemetry but no fabricated catch/time/probability',async()=>{
    blockedId=await engine.recordCatchSession({...base,auditId:crypto.randomUUID(),location:{lat:0,lng:0}},decision({action:'block',riskLevel:'high',riskScore:70}));
    const {rows:[row]}=await pool.query('SELECT * FROM catch_risk_attempts WHERE id=$1',[blockedId]);
    assert.equal(row.id,blockedId);assert.equal(row.session_id,blockedId);assert.equal(row.actual_result,null);assert.equal(row.catch_timestamp,null);assert.equal(row.expected_success_rate,null);
    assert.equal(row.location_lat,'0.0000000');assert.equal(row.location_lng,'0.0000000');assert.equal(row.ball_count_used,null);assert.equal(row.berries_used,null);assert.equal(row.data_integrity_score,null);
    const counters=(await pool.query('SELECT total_catches,total_attempts,risk_requests,blocked_count FROM user_catch_stats WHERE user_id=$1',[owner])).rows[0];assert.deepEqual(counters,{total_catches:0,total_attempts:0,risk_requests:1,blocked_count:1});
  });
  await t.test('database gameplay evidence determines the actual probability, ball, rarity, throw and time',async()=>{
    failedId=await engine.recordCatchSession({...base,throwId:failed,pokemonRarity:'fake',ballType:'master',throwType:'fake',curveball:true},decision({details:{successRate:{expectedRate:1}}}),'fail');
    const row=(await pool.query('SELECT game_session_id,expected_success_rate,ball_type,throw_type,curveball,pokemon_rarity,catch_timestamp::text AS time FROM catch_risk_attempts WHERE id=$1',[failedId])).rows[0];
    assert.equal(row.game_session_id,session);assert.equal(row.expected_success_rate,'0.2500');assert.equal(row.ball_type,'POKE_BALL');assert.equal(row.throw_type,'NICE');assert.equal(row.curveball,false);assert.equal(row.pokemon_rarity,'RARE');assert.equal(row.time,'2020-01-01 00:01:00');
  });
  await t.test('a confirmed success credits exactly one observed attempt and success',async()=>{
    await engine.recordCatchSession({...base,throwId:success},decision({action:'allow',riskLevel:'low',riskScore:0}),'success');
    assert.deepEqual((await pool.query('SELECT total_catches,total_attempts,risk_requests FROM user_catch_stats WHERE user_id=$1',[owner])).rows[0],{total_catches:1,total_attempts:2,risk_requests:3});
    assert.equal((await totals(pool,owner,wild)).attempts,2);assert.equal((await totals(pool,owner,wild)).success,1);
  });
  await t.test('late observation stays in its real gameplay hour and does not fabricate a recent success rate',async()=>{
    const {rows}=await pool.query("SELECT hour_timestamp AT TIME ZONE current_setting('TimeZone') AS hour FROM catch_success_stats");
    for(const row of rows)assert.equal(row.hour.getFullYear(),2020);
    assert.equal((await analyzer.getUserCatchStats(owner,wild)).attempts,0);
    assert.equal((await analyzer.getUserCatchStats(owner,wild)).actualRate,null);
  });
  await t.test('same durable audit ID replays once under concurrent requests',async()=>{
    const request={...base,auditId:crypto.randomUUID()};const ids=await Promise.all([engine.recordCatchSession(request,decision()),engine.recordCatchSession(request,decision())]);assert.deepEqual(ids,[request.auditId,request.auditId]);
    assert.equal((await pool.query('SELECT risk_requests FROM user_catch_stats WHERE user_id=$1',[owner])).rows[0].risk_requests,4);
  });
  await t.test('audit ID reuse with another payload or owner fails without incrementing counters',async()=>{
    await assert.rejects(engine.recordCatchSession({...base,auditId:blockedId},decision()),/identity conflicts/);
    await assert.rejects(engine.recordCatchSession({userId:other,pokemonId:wild,auditId:blockedId},decision()),/identity conflicts/);
    assert.equal((await pool.query('SELECT risk_requests FROM user_catch_stats WHERE user_id=$1',[owner])).rows[0].risk_requests,4);
  });
  await t.test('reusing observed throw evidence under a new ID cannot duplicate statistics',async()=>{
    await assert.rejects(engine.recordCatchSession({...base,throwId:success},decision(),'success'),/unique constraint/);
    assert.equal((await totals(pool,owner,wild)).attempts,2);
  });
  await t.test('missing, foreign and contradictory outcome evidence is rejected atomically',async()=>{
    await assert.rejects(engine.recordCatchSession(base,decision(),'success'),/requires actual gameplay throw evidence/);
    await assert.rejects(engine.recordCatchSession({...base,throwId:foreign},decision(),'fail'),/matching owned gameplay throw/);
    await assert.rejects(engine.recordCatchSession({...base,throwId:failed},decision(),'success'),/matching owned gameplay throw/);
    await assert.rejects(engine.recordCatchSession({...base,throwId:failed},decision(),'escape'),/matching owned gameplay throw/);
    await assert.rejects(engine.recordCatchSession({...base,throwId:crypto.randomUUID()},decision(),'fail'),/matching owned gameplay throw/);
    assert.equal((await pool.query('SELECT risk_requests FROM user_catch_stats WHERE user_id=$1',[owner])).rows[0].risk_requests,4);
  });
  await t.test('session link cannot point at a different user or Pokémon',async()=>{
    await assert.rejects(engine.recordCatchSession({...base,gameSessionId:f.otherSession},decision()),/different owner/);
    await assert.rejects(engine.recordCatchSession({...base,pokemonId:crypto.randomUUID(),gameSessionId:session},decision()),/different owner or Pokemon/);
  });
  await t.test('observed escape uses its real owned failed throw and leaves gameplay unchanged',async()=>{
    await engine.recordCatchSession({userId:other,pokemonId:wild,throwId:foreign},decision(),'escape');
    assert.equal((await pool.query('SELECT total_catches FROM user_catch_stats WHERE user_id=$1',[other])).rows[0].total_catches,0);assert.deepEqual(await snapshot(pool),before);
  });
  await t.test('malformed identities, scores, quantities and coordinates fail before storing records',async()=>{
    const n=(await pool.query('SELECT count(*)::int AS n FROM catch_risk_attempts')).rows[0].n;
    for(const fields of [{userId:'not-uuid'},{auditId:'no'},{ballCount:0},{ballCount:1.5},{ballCount:101},{berries:-1},{curveball:'false'},{location:{lat:91,lng:0}},{location:{lat:0}},{location:{lat:NaN,lng:0}}])await assert.rejects(engine.recordCatchSession({...base,...fields},decision()));
    for(const risk of [{riskScore:NaN},{riskScore:101},{riskLevel:'unknown'},{action:'maybe'}])await assert.rejects(engine.recordCatchSession(base,decision(risk)));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM catch_risk_attempts')).rows[0].n,n);
  });
  await t.test('counter failure rolls back telemetry and reports failure rather than a fictional saved ID',async()=>{
    await pool.query("CREATE FUNCTION reject_risk_counter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'counter unavailable'; END $$; CREATE TRIGGER reject_risk_counter BEFORE UPDATE ON user_catch_stats FOR EACH ROW EXECUTE FUNCTION reject_risk_counter()");
    const id=crypto.randomUUID();await assert.rejects(engine.recordCatchSession({...base,auditId:id},decision()),/counter unavailable/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM catch_risk_attempts WHERE id=$1',[id])).rows[0].n,0);
    await pool.query('DROP TRIGGER reject_risk_counter ON user_catch_stats; DROP FUNCTION reject_risk_counter()');
  });
  await t.test('audit rows cannot mutate independently of committed counters or evidence',async()=>{
    await assert.rejects(pool.query('UPDATE catch_risk_attempts SET actual_result=NULL WHERE id=$1',[failedId]),/records are immutable/);
  });
  await t.test('real telemetry refuses lossy rollback while original gameplay rows stay intact',async()=>{
    await assert.rejects(apply(pool,'down'),/Actual catch risk records\/configuration exist/);assert.deepEqual(await snapshot(pool),before);
  });
}));

test('actual hourly analyzer performs exact atomic counting and weighted probability aggregates',async t=>fixture(async({pool,owner,wild,analyzer})=>{
  await apply(pool);
  await t.test('empty observations are zero counts with unknown expected/anomaly values',async()=>{
    assert.deepEqual(await analyzer.getUserCatchStats(owner,wild),{attempts:0,success:0,actualRate:null,expectedRate:null,maxAnomalyScore:null});
  });
  await t.test('first observation is counted once rather than inserted then incremented twice',async()=>{
    const row=await analyzer.recordCatchStats(owner,wild,'rare','poke',true,0.1);assert.equal(row.attempt_count,1);assert.equal(row.success_count,1);assert.equal(row.actual_success_rate,'1.0000');
  });
  await t.test('concurrent observations aggregate into one dimension without lost updates',async()=>{
    await Promise.all(Array.from({length:20},(_,i)=>analyzer.recordCatchStats(owner,wild,'rare','poke',i<4,0.2)));
    const row=(await pool.query('SELECT * FROM catch_success_stats')).rows[0];assert.equal(row.attempt_count,21);assert.equal(row.success_count,5);assert.equal(row.expected_rate_sum,'4.1');assert.equal(row.actual_success_rate,'0.2381');
  });
  await t.test('ball/rarity dimensions stay separate and weighted expectation uses actual attempt counts',async()=>{
    await analyzer.recordCatchStats(owner,wild,'rare','great',false,0.9);const result=await analyzer.getUserCatchStats(owner,wild);
    assert.equal(result.attempts,22);assert.equal(result.success,5);assert.ok(Math.abs(result.expectedRate-5/22)<1e-14);assert.equal((await pool.query('SELECT count(*)::int AS n FROM catch_success_stats')).rows[0].n,2);
  });
  await t.test('interval input is bound and malformed/noninteger intervals cannot inject SQL',async()=>{
    for(const interval of [0,-1,8761,1.5,"1'; DROP TABLE users; --"])await assert.rejects(analyzer.getUserCatchStats(owner,wild,interval),/Invalid statistics interval/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,2);
  });
  await t.test('invalid probabilities and nonboolean results are rejected without changing counts',async()=>{
    for(const value of [NaN,Infinity,-0.1,1.1,'0.1'])await assert.rejects(analyzer.recordCatchStats(owner,wild,'rare','poke',true,value));
    await assert.rejects(analyzer.recordCatchStats(owner,wild,'rare','poke','true',0.2));assert.equal((await totals(pool,owner,wild)).attempts,22);
  });
  await t.test('storage errors propagate; outage is not interpreted as a clean catch history',async()=>{
    await pool.query('ALTER TABLE catch_success_stats RENAME TO unavailable_stats');await assert.rejects(analyzer.getUserCatchStats(owner,wild),/does not exist/);await pool.query('ALTER TABLE unavailable_stats RENAME TO catch_success_stats');
  });
}));

test('unused risk storage reverses without changing any original gameplay data or identity',async()=>fixture(async({pool})=>{
  const before=await snapshot(pool);await apply(pool);await apply(pool,'down');assert.deepEqual(await snapshot(pool),before);
  assert.equal((await pool.query("SELECT to_regclass('catch_risk_attempts') AS relation")).rows[0].relation,null);
}));
test('changed base-rate configuration cannot be silently discarded on down',async()=>fixture(async({pool})=>{
  await apply(pool);await pool.query("UPDATE catch_base_rate_config SET base_rate=0.5 WHERE pokemon_rarity='common'");await assert.rejects(apply(pool,'down'),/Actual catch risk records\/configuration exist/);
  assert.equal((await pool.query("SELECT base_rate FROM catch_base_rate_config WHERE pokemon_rarity='common'")).rows[0].base_rate,'0.5000');
}));
test('preexisting risk data requires explicit adoption rather than overwrite',async()=>fixture(async({pool})=>{
  const before=await snapshot(pool);await pool.query('CREATE TABLE catch_success_stats(id integer); INSERT INTO catch_success_stats VALUES(7)');
  await assert.rejects(apply(pool),/Existing catch risk storage/);assert.deepEqual(await snapshot(pool),before);assert.equal((await pool.query('SELECT id FROM catch_success_stats')).rows[0].id,7);
}));
test('a failure after hourly aggregation rolls back the observation and telemetry together',async()=>fixture(async({pool,engine,owner,wild,failed,analyzer})=>{
  await apply(pool);await pool.query("CREATE FUNCTION reject_insert_counter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'counter insert unavailable'; END $$; CREATE TRIGGER reject_insert_counter BEFORE INSERT ON user_catch_stats FOR EACH ROW EXECUTE FUNCTION reject_insert_counter()");
  await assert.rejects(engine.recordCatchSession({userId:owner,pokemonId:wild,throwId:failed},decision(),'fail'),/counter insert unavailable/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catch_risk_attempts')).rows[0].n,0);
  assert.equal((await analyzer.getUserCatchStats(owner,wild)).attempts,0);
}));
test('unobserved gameplay links preserve unknown outcome and do not inflate catch statistics',async()=>fixture(async({pool,engine,owner,wild,session})=>{
  await apply(pool);const id=await engine.recordCatchSession({userId:owner,pokemonId:wild,gameSessionId:session},decision());
  const row=(await pool.query('SELECT game_session_id,actual_result,catch_timestamp FROM catch_risk_attempts WHERE id=$1',[id])).rows[0];
  assert.equal(row.game_session_id,session);assert.equal(row.actual_result,null);assert.equal(row.catch_timestamp,null);
  assert.equal((await pool.query('SELECT total_attempts FROM user_catch_stats')).rows[0].total_attempts,0);
}));
test('changed owned storage identity makes reverse migration refuse rather than drop a replacement table',async()=>fixture(async({pool})=>{
  await apply(pool);await pool.query('ALTER TABLE catch_risk_attempts RENAME TO retained_original_risk; CREATE TABLE catch_risk_attempts(id integer); INSERT INTO catch_risk_attempts VALUES(7)');
  await assert.rejects(apply(pool,'down'),/Catch risk storage relation identity changed/);
  assert.equal((await pool.query('SELECT id FROM catch_risk_attempts')).rows[0].id,7);assert.ok((await pool.query("SELECT to_regclass('retained_original_risk') AS name")).rows[0].name);
}));
test('integer gameplay identity requires explicit mapping and never receives manufactured UUIDs',async()=>fixture(async({pool,owner,wild})=>{
  await pool.query('DROP TABLE catch_sessions CASCADE; CREATE TABLE catch_sessions(id integer PRIMARY KEY,user_id uuid,wild_pokemon_id uuid)');
  await pool.query('INSERT INTO catch_sessions VALUES(7,$1,$2)',[owner,wild]);await assert.rejects(apply(pool),/requires canonical UUID gameplay/);
  assert.equal((await pool.query('SELECT id FROM catch_sessions')).rows[0].id,7);
  assert.equal((await pool.query("SELECT to_regclass('catch_risk_storage_state') AS name")).rows[0].name,null);
}));
test('case variants of real UUID identities share canonical storage and statistics',async()=>fixture(async({pool,engine,owner,wild,session,failed,analyzer})=>{
  await apply(pool);await engine.recordCatchSession({userId:owner.toUpperCase(),pokemonId:wild.toUpperCase(),gameSessionId:session.toUpperCase(),throwId:failed.toUpperCase()},decision(),'fail');
  const row=(await pool.query('SELECT user_id,pokemon_id,game_session_id FROM catch_risk_attempts')).rows[0];
  assert.deepEqual(row,{user_id:owner,pokemon_id:wild,game_session_id:session});
  assert.equal((await totals(pool,owner,wild)).attempts,1);assert.equal((await analyzer.getUserCatchStats(owner.toUpperCase(),wild.toUpperCase())).attempts,0);
}));
test('out-of-order evidence cannot move the latest observed catch time backwards',async()=>fixture(async({pool,engine,owner,wild,failed,success})=>{
  await apply(pool);await engine.recordCatchSession({userId:owner,pokemonId:wild,throwId:success},decision(),'success');
  await engine.recordCatchSession({userId:owner,pokemonId:wild,throwId:failed},decision(),'fail');
  assert.equal((await pool.query('SELECT last_catch_at::text AS time FROM user_catch_stats')).rows[0].time,'2020-01-01 00:02:00');
}));
