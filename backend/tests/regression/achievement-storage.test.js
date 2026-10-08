'use strict';
// REQ-00076: actual V1/modern SQL, production service and authenticated routes.
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const {Pool}=require('pg');
const express=require('express');const request=require('supertest');
const {parseMigrationFile}=require('../../../database/migrate');const {migrationStatements}=require('../../../database/sqlStatements');
const {AchievementServiceClass}=require('../../services/pokemon-service/src/achievementService');
const {createAchievementRouter}=require('../../services/pokemon-service/src/routes/achievements');
const {createUserRouter}=require('../../services/user-service/src/routes/user');
const {signAccess,errorHandler}=require('../../shared/auth');
const {ServiceLauncher}=require('../../shared/ServiceLauncher');
const root=path.resolve(__dirname,'../../..');const source='database/pending/20261008_150000__achievement_catalog_bridge.sql';
async function apply(pool,file,direction='up'){
  const parsed=parseMigrationFile(await fs.readFile(path.join(root,file),'utf8'));const client=await pool.connect();
  try{await client.query('BEGIN');for(const sql of migrationStatements(parsed[direction]))await client.query(sql);await client.query('COMMIT');}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

test('actual achievement bridge and service preserve tiered progress and commit modern rewards once',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`achievement_${crypto.randomBytes(8).toString('hex')}`;const owner=crypto.randomUUID();const other=crypto.randomUUID();
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const service=new AchievementServiceClass({db:{query:pool.query.bind(pool),getClient:()=>pool.connect()}});
  const app=express();app.use(express.json());app.use('/achievements',createAchievementRouter(service));app.use('/users',createUserRouter(pool.query.bind(pool)));const launcher=new ServiceLauncher({serviceName:'pokemon-service',port:0});app.get('/metrics',launcher.metricsEndpoint.bind(launcher));app.use(errorHandler);
  const token=signAccess({id:owner});const foreignToken=signAccess({id:other});
  let original,legacySnapshot;
  const definition=async id=>(await pool.query('SELECT * FROM achievements WHERE achievement_id=$1',[id])).rows[0];
  const progress=async id=>(await pool.query('SELECT * FROM user_achievements WHERE user_id=$1 AND achievement_id=$2',[owner,id])).rows[0];
  const coins=async()=> (await pool.query('SELECT coins FROM users WHERE id=$1',[owner])).rows[0].coins;
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query(await fs.readFile(path.join(root,'database/seeds/V2__seed_data.sql'),'utf8'));
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2),($3,$4)',[owner,'achievement-owner',other,'achievement-other']);
    await pool.query("INSERT INTO user_achievements(user_id,achievement_id,current_value,current_tier,unlocked_at,updated_at) VALUES($1,'catch_total',117,2,'2020-01-01','2021-01-01')",[owner]);
    original=(await pool.query("SELECT 'user_achievements'::regclass::oid AS oid")).rows[0].oid;
    legacySnapshot=(await pool.query("SELECT user_id,achievement_id,current_value,current_tier,unlocked_at,updated_at FROM user_achievements WHERE user_id=$1",[owner])).rows;
    await t.test('the existing user route still reads the unmodified V1 schema',async()=>{
      const response=await request(app).get('/users/me/achievements').set('Authorization',`Bearer ${token}`).expect(200);
      assert.equal(response.body.data.find(row=>row.id==='catch_total').current_value,117);
    });
    await apply(pool,source);
    await apply(pool,'database/pending/20261007_120000__title_identity_compatibility.sql');
    await apply(pool,'database/pending/repairs/20260611_000000__add_achievement_system_tables.sql');
    await apply(pool,'database/pending/20261008_130000__item_catalog_prerequisite.sql');
    await apply(pool,'database/pending/repairs/20260609_124500__add_item_inventory_system.sql');
    await t.test('all existing progress fields, composite PK, relation identity and original definition FK survive',async()=>{
      assert.equal((await pool.query("SELECT 'user_achievements'::regclass::oid AS oid")).rows[0].oid,original);
      assert.deepEqual((await pool.query("SELECT user_id,achievement_id,current_value,current_tier,unlocked_at,updated_at FROM user_achievements WHERE user_id=$1 AND achievement_id='catch_total'",[owner])).rows,legacySnapshot);
      const constraints=(await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='user_achievements'::regclass")).rows.map(row=>row.definition);
      assert.ok(constraints.includes('PRIMARY KEY (user_id, achievement_id)'));
      assert.ok(constraints.some(value=>value.includes('REFERENCES achievement_definitions(id)')));
      const row=await progress('catch_total');assert.equal(row.progress,'117');assert.equal(row.target,'1000');assert.equal(row.created_at,null);assert.equal(row.completed_at,null);assert.equal(row.modern_achievement_id,null);
    });
    await t.test('legacy catch/reward upserts still advance the exact original counter and tiers',async()=>{
      await pool.query("INSERT INTO user_achievements(user_id,achievement_id,current_value) VALUES($1,'catch_total',1) ON CONFLICT(user_id,achievement_id) DO UPDATE SET current_value=user_achievements.current_value+1",[owner]);
      const row=await progress('catch_total');assert.equal(row.current_value,118);assert.equal(row.progress,'118');assert.equal(row.current_tier,2);
    });
    await t.test('all seeded modern definitions have explicitly linked definition records',async()=>{
      const modern=(await pool.query('SELECT count(*)::int AS n FROM achievements')).rows[0].n;assert.equal(modern,31);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM achievement_definitions WHERE is_modern')).rows[0].n,modern);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM achievement_definitions WHERE NOT is_modern')).rows[0].n,8);
    });
    await t.test('a collision cannot overwrite an existing tiered definition',async()=>{
      const snapshot=(await pool.query("SELECT * FROM achievement_definitions WHERE id='catch_total'")).rows;
      await assert.rejects(pool.query("INSERT INTO achievements(achievement_id,category,name,description,rarity,trigger_conditions,rewards) VALUES('catch_total','catch','{}','{}','common','{\"type\":\"catch_count\",\"target\":1}','{}')"),/collides/);
      assert.deepEqual((await pool.query("SELECT * FROM achievement_definitions WHERE id='catch_total'")).rows,snapshot);
    });
    await t.test('definition edits retain the linked identity and immutable IDs',async()=>{
      await pool.query("UPDATE achievements SET name='{\"zh\":\"修改名称\"}' WHERE achievement_id='first_breed'");
      assert.equal((await pool.query("SELECT name_zh FROM achievement_definitions WHERE id='first_breed'")).rows[0].name_zh,'修改名称');
      await assert.rejects(pool.query("UPDATE achievements SET achievement_id='changed_id' WHERE achievement_id='first_breed'"),/immutable/);
    });
    await t.test('a new modern owner uses UUID FKs and cannot target a nonexistent owner',async()=>{
      await assert.rejects(pool.query("INSERT INTO user_achievements(user_id,achievement_id) VALUES($1,'first_breed')",[crypto.randomUUID()]),/foreign key/);
    });
    await t.test('modern progress cannot be written through the tiered counter',async()=>{
      await assert.rejects(pool.query("INSERT INTO user_achievements(user_id,achievement_id,current_value) VALUES($1,'first_breed',1)",[owner]),/exact progress counter/);
    });
    await t.test('partial progress contributes zero completion points',async()=>{
      const result=await service.updateProgress(owner,await definition('catch_master_100'),{count:1});assert.equal(result.progress,1);assert.equal(result.completed,false);
      const overview=await service.getProgressOverview(owner);assert.equal(overview.total_points,0);assert.equal(overview.achievements_completed,0);
    });
    await t.test('concurrent increments do not lose progress or concatenate numeric strings',async()=>{
      await Promise.all(Array.from({length:10},()=>service.updateProgress(owner,{achievement_id:'catch_master_100',trigger_conditions:{type:'catch_count',target:100}},{count:1})));
      assert.equal((await progress('catch_master_100')).progress,'11');
    });
    await t.test('fractional distance remains exact through repeated updates',async()=>{
      const def=await definition('walker_10km');await service.updateProgress(owner,def,{distance:0.25});await service.updateProgress(owner,def,{distance:0.5});
      const row=await progress('walker_10km');assert.equal(row.progress,'0.75');assert.equal(row.current_value,0);
    });
    await t.test('decimal tenths use PostgreSQL numeric arithmetic without binary accumulation artifacts',async()=>{
      const def=await definition('walker_10km');await service.updateProgress(owner,def,{distance:0.1});await service.updateProgress(owner,def,{distance:0.2});
      assert.equal((await progress('walker_10km')).progress,'1.05');
    });
    await t.test('a zero count and losing battle do not unlock achievements',async()=>{
      await service.updateProgress(owner,await definition('first_battle'),{win:false});assert.equal((await progress('first_battle')).completed,false);
      await service.updateProgress(owner,await definition('catch_master_100'),{count:0});assert.equal((await progress('catch_master_100')).progress,'11');
    });
    await t.test('negative, nonnumeric and nonfinite event increments are rejected',async()=>{
      for(const count of [-1,'2',NaN,Infinity])await assert.rejects(service.updateProgress(owner,await definition('catch_master_100'),{count}),/Invalid/);
      assert.equal((await progress('catch_master_100')).progress,'11');
    });
    await t.test('filtered events do not create unrelated progress records',async()=>{
      const def={...(await definition('shiny_hunter')),trigger_conditions:{type:'shiny_catch',target:1,filters:{is_shiny:true}}};
      assert.equal((await service.updateProgress(owner,def,{is_shiny:false})).filtered,true);assert.equal(await progress('shiny_hunter'),undefined);
    });
    await t.test('concurrent completions count points and category totals only once',async()=>{
      const def=await definition('first_battle');const results=await Promise.all([service.updateProgress(owner,def,{win:true}),service.updateProgress(owner,def,{win:true})]);
      assert.equal(results.filter(row=>row.completed).length,1);const overview=await service.getProgressOverview(owner);assert.equal(overview.total_points,10);assert.equal(overview.achievements_completed,1);assert.deepEqual(overview.category_progress,{catch:0,explore:0,battle:1});
    });
    await t.test('a completed modern badge has an actual one-tier projection and cannot lose earned progress',async()=>{
      const row=await progress('first_battle');assert.equal(row.current_tier,1);assert.ok(row.unlocked_at);
      await assert.rejects(pool.query("UPDATE user_achievements SET progress=0 WHERE user_id=$1 AND achievement_id='first_battle'",[owner]),/Completed achievement progress is immutable/);
      assert.equal((await progress('catch_total')).current_tier,2);
    });
    await t.test('earned progress cannot be deleted by deleting its definition',async()=>{
      await assert.rejects(pool.query("DELETE FROM achievements WHERE achievement_id='first_battle'"),/foreign key/);assert.ok(await progress('first_battle'));
    });
    await t.test('uncompleted and legacy badges cannot claim modern rewards',async()=>{
      await assert.rejects(service.claimRewards(owner,'walker_10km'),/not completed/);await assert.rejects(service.claimRewards(owner,'catch_total'),/not found/);assert.equal(await coins(),0);
    });
    await t.test('concurrent claims actually credit coins exactly once',async()=>{
      const results=await Promise.allSettled([service.claimRewards(owner,'first_battle'),service.claimRewards(owner,'first_battle')]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(await coins(),100);assert.equal((await progress('first_battle')).rewards_claimed,true);
    });
    await t.test('claim state and claimed progress cannot be reset',async()=>{
      await assert.rejects(pool.query("UPDATE user_achievements SET rewards_claimed=FALSE WHERE user_id=$1 AND achievement_id='first_battle'",[owner]),/immutable/);
      await assert.rejects(pool.query("UPDATE user_achievements SET progress=0 WHERE user_id=$1 AND achievement_id='first_battle'",[owner]),/immutable/);assert.equal(await coins(),100);
    });
    await t.test('ball rewards credit the canonical gameplay counter once',async()=>{
      await service.updateProgress(owner,await definition('first_catch'),{count:1});await service.claimRewards(owner,'first_catch');
      assert.equal((await pool.query('SELECT pokeball_count FROM users WHERE id=$1',[owner])).rows[0].pokeball_count,60);assert.equal(await coins(),200);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM player_inventory WHERE user_id=$1 AND item_id='POKE_BALL'",[owner])).rows[0].n,0);
    });
    await t.test('nonball rewards use actual inventory catalog and valid stacks',async()=>{
      await pool.query("INSERT INTO achievements(achievement_id,category,name,description,rarity,trigger_conditions,rewards) VALUES('stack_reward','catch','{}','{}','common','{\"type\":\"catch_count\",\"target\":1}','{\"items\":[{\"item_id\":\"rare_candy\",\"count\":120}]}')");
      // The real category default is50: increase this isolated owner's real limit.
      await pool.query('INSERT INTO inventory_capacity(user_id,special_slots) VALUES($1,200)',[owner]);
      await service.updateProgress(owner,await definition('stack_reward'),{count:1});await service.claimRewards(owner,'stack_reward');
      assert.deepEqual((await pool.query("SELECT quantity FROM player_inventory WHERE user_id=$1 AND item_id='RARE_CANDY' ORDER BY quantity DESC",[owner])).rows,[{quantity:99},{quantity:21}]);
    });
    await t.test('missing reward resources roll back coins, inventory and claim marker',async()=>{
      await pool.query("INSERT INTO achievements(achievement_id,category,name,description,rarity,trigger_conditions,rewards) VALUES('missing_reward','catch','{}','{}','common','{\"type\":\"catch_count\",\"target\":1}','{\"coins\":40,\"items\":[{\"item_id\":\"not_existing\",\"count\":1}]}')");
      await service.updateProgress(owner,await definition('missing_reward'),{count:1});const before=await coins();await assert.rejects(service.claimRewards(owner,'missing_reward'),/unavailable/);
      assert.equal(await coins(),before);assert.equal((await progress('missing_reward')).rewards_claimed,false);
    });
    await t.test('unknown reward types cannot produce a fake successful claim',async()=>{
      await pool.query("UPDATE achievements SET rewards='{\"pokemon\":123}' WHERE achievement_id='missing_reward'");await assert.rejects(service.claimRewards(owner,'missing_reward'),/Unsupported/);assert.equal((await progress('missing_reward')).rewards_claimed,false);
    });
    await t.test('rollback refuses to discard modern definitions or earned records',async()=>{
      const snapshot=(await pool.query('SELECT * FROM user_achievements ORDER BY achievement_id')).rows;
      await assert.rejects(apply(pool,source,'down'),/Modern achievement data exists/);assert.deepEqual((await pool.query('SELECT * FROM user_achievements ORDER BY achievement_id')).rows,snapshot);
    });
    await t.test('anonymous achievement list and claims require authentication',async()=>{
      await request(app).get('/achievements/my').expect(401);await request(app).post('/achievements/first_battle/claim').expect(401);
    });
    await t.test('real list exposes numeric progress and category filtering',async()=>{
      const response=await request(app).get('/achievements/my?category=explore').set('Authorization',`Bearer ${token}`).expect(200);
      assert.ok(response.body.data.every(row=>row.category==='explore'));assert.equal(response.body.data.find(row=>row.achievement_id==='walker_10km').progress,1.05);
    });
    await t.test('static leaderboard and categories are reachable before ID detail',async()=>{
      const response=await request(app).get('/achievements/leaderboard').expect(200);assert.equal(response.body.data[0].nickname,'achievement-owner');
      await request(app).get('/achievements/leaderboard/global').expect(200);const categories=await request(app).get('/achievements/categories').expect(200);assert.equal(categories.body.data.length,5);
    });
    await t.test('invalid categories and pagination are rejected',async()=>{
      await request(app).get('/achievements/my?category=invalid').set('Authorization',`Bearer ${token}`).expect(400);
      for(const query of ['limit=1000','limit=bad','offset=-1','offset=1.5'])await request(app).get('/achievements/leaderboard?'+query).expect(400);
    });
    await t.test('another signed user cannot see or claim this owner progress',async()=>{
      const response=await request(app).get('/achievements/my/progress').set('Authorization',`Bearer ${foreignToken}`).expect(200);assert.equal(response.body.data.total_points,0);
      await request(app).post('/achievements/first_catch/claim').set('Authorization',`Bearer ${foreignToken}`).expect(404);assert.equal(await coins(),200);
    });
    await t.test('claim endpoint reports a real duplicate instead of granting again',async()=>{
      await request(app).post('/achievements/first_battle/claim').set('Authorization',`Bearer ${token}`).expect(400);assert.equal(await coins(),200);
    });
    await t.test('hidden achievements become visible only after completion',async()=>{
      let response=await request(app).get('/achievements/my').set('Authorization',`Bearer ${token}`).expect(200);assert.ok(!response.body.data.some(row=>row.achievement_id==='lucky_encounter'));
      await service.updateProgress(owner,await definition('lucky_encounter'),{is_lucky:true});response=await request(app).get('/achievements/my').set('Authorization',`Bearer ${token}`).expect(200);assert.ok(response.body.data.find(row=>row.achievement_id==='lucky_encounter').completed);
    });
    await t.test('canonical title reward is granted in the same transaction',async()=>{
      await pool.query("INSERT INTO achievements(achievement_id,category,name,description,rarity,trigger_conditions,rewards) VALUES('first_title','catch','{}','{}','common','{\"type\":\"catch_count\",\"target\":1}','{\"title\":\"real_title\"}')");
      await pool.query("INSERT INTO title_definitions(title_id,name,description,category,rarity,unlock_type,unlock_criteria) VALUES('real_title','{}','{}','achievement','common','achievement','{\"achievement_id\":\"first_title\"}')");
      await service.updateProgress(owner,await definition('first_title'),{count:1});await service.claimRewards(owner,'first_title');assert.equal((await service.getUserTitles(owner))[0].title_id,'real_title');
    });
    await t.test('title listing/activation/cancellation and ownership checks use real storage',async()=>{
      await request(app).get('/achievements/titles').set('Authorization',`Bearer ${token}`).expect(200);
      await request(app).post('/achievements/titles/real_title/activate').set('Authorization',`Bearer ${foreignToken}`).expect(404);
      await request(app).post('/achievements/titles/real_title/activate').set('Authorization',`Bearer ${token}`).expect(200);
      assert.equal((await service.getUserTitles(owner))[0].is_active,true);
      await request(app).delete('/achievements/titles/active').set('Authorization',`Bearer ${token}`).expect(200);assert.equal((await service.getUserTitles(owner))[0].is_active,false);
    });
    await t.test('the actual existing user route shows preserved counters and exact modern fractional progress',async()=>{
      const response=await request(app).get('/users/me/achievements').set('Authorization',`Bearer ${token}`).expect(200);
      assert.equal(response.body.data.find(row=>row.id==='catch_total').current_value,118);
      assert.equal(response.body.data.find(row=>row.id==='walker_10km').current_value,1.05);
    });
    await t.test('subject tokens and conflicting legacy ID claims use the verified subject',async()=>{
      for(const payload of [{sub:owner},{sub:owner,id:other}]){
        const response=await request(app).get('/users/me/achievements').set('Authorization',`Bearer ${signAccess(payload)}`).expect(200);
        assert.equal(response.body.data.find(row=>row.id==='catch_total').current_value,118);
      }
    });
    await t.test('the actual launcher metrics endpoint exposes only committed completion and claim counters',async()=>{
      const response=await request(app).get('/metrics').expect(200);
      assert.match(response.text,/minego_achievement_unlocks_total\{category="battle"\} 1/);
      assert.match(response.text,/minego_achievement_reward_claims_total 4/);
      assert.match(response.text,/minego_achievement_progress_update_duration_seconds_count [1-9]/);
    });
    await t.test('snapshot remains accurate after different completed categories',async()=>{
      const overview=await service.getProgressOverview(owner);const actual=(await pool.query('SELECT sum(a.points)::int AS points,count(*)::int AS n FROM user_achievements ua JOIN achievements a ON a.achievement_id=ua.modern_achievement_id WHERE ua.user_id=$1 AND ua.completed',[owner])).rows[0];
      assert.equal(overview.total_points,actual.points);assert.equal(overview.achievements_completed,actual.n);
    });
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test('an unused achievement bridge reverses without changing original tiered rows',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');const schema=`ach_reverse_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query(await fs.readFile(path.join(root,'database/seeds/V2__seed_data.sql'),'utf8'));
    const user=crypto.randomUUID();await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[user,'bridge-reverse']);await pool.query("INSERT INTO user_achievements(user_id,achievement_id,current_value,current_tier) VALUES($1,'catch_total',40,1)",[user]);
    const original=(await pool.query('SELECT * FROM user_achievements')).rows;await apply(pool,source);await apply(pool,source,'down');assert.deepEqual((await pool.query('SELECT * FROM user_achievements')).rows,original);
    assert.equal((await pool.query("SELECT to_regclass('achievements') AS relation")).rows[0].relation,null);
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
