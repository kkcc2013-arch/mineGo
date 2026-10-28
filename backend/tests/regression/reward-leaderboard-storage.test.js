'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Pool}=require('pg');
const request=require('supertest');
const {createRewardApp}=require('../../services/reward-service/src');
const {signAccess}=require('../../shared/auth');
const root=path.resolve(__dirname,'../../..');

test('actual reward leaderboard validates parameters and ranks real stored scores consistently',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'isolated PostGIS is required');
  const schema=`reward_rank_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  let queries=0;
  const db={query:(...args)=>{queries++;return pool.query(...args);}};
  const app=createRewardApp({db});
  const owner=crypto.randomUUID(),higher=crypto.randomUUID(),tie=crypto.randomUUID(),banned=crypto.randomUUID(),low=crypto.randomUUID();
  const token=signAccess({id:owner});
  const leaderboard=params=>request(app).get('/rewards/leaderboard').set('Authorization',`Bearer ${token}`).query(params||{});
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query(await fs.readFile(path.join(root,'database/seeds/V2__seed_data.sql'),'utf8'));
    for(const [id,name,xp,level,team,isBanned,catches] of [
      [owner,'Owner','10000000000000000',5,'VALOR',false,1],
      [higher,'Higher','10000000000000001',6,'MYSTIC',false,2],
      [tie,'Tie','10000000000000000',5,'VALOR',false,9],
      [banned,'Banned','10000000000000002',50,'VALOR',true,100],
      [low,'Low','0',1,'INSTINCT',false,0]
    ]){
      await pool.query('INSERT INTO users(id,nickname,xp,level,team,is_banned) VALUES($1,$2,$3,$4,$5,$6)',[id,name,xp,level,team,isBanned]);
      await pool.query("INSERT INTO user_achievements(user_id,achievement_id,current_value) VALUES($1,'catch_total',$2)",[id,catches]);
    }
    await pool.query('INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) VALUES($1,25,100,10,10,1,2,3)',[owner]);
    await t.test('authentication is required and user headers cannot replace JWT identity',async()=>{
      const before=queries;await request(app).get('/rewards/leaderboard').set('X-User-Id',owner).expect(401);
      await request(app).get('/rewards/leaderboard').set('Authorization','Bearer invalid').expect(401);assert.equal(queries,before);
    });
    await t.test('XP sorts exactly above Number safe range and ties share the same competition rank',async()=>{
      const response=await leaderboard().expect(200);const rows=response.body.data.leaderboard;
      assert.equal(rows.length,4);assert.equal(rows[0].id,higher);assert.equal(rows[0].rank,1);
      assert.equal(rows[0].xp,'10000000000000001');assert.equal(rows.find(r=>r.id===owner).xp,'10000000000000000');
      assert.equal(rows.find(r=>r.id===owner).rank,2);assert.equal(rows.find(r=>r.id===tie).rank,2);
      assert.equal(response.body.data.myRank,2);assert.equal(rows.find(r=>r.id===low).rank,4);
      assert.deepEqual(rows.filter(r=>r.rank===2).map(r=>r.id),[owner,tie].sort());
      assert.equal(queries,1,'top rows and caller rank use a single database statement');
    });
    await t.test('team scope is normalized and applies equally to the list and caller rank',async()=>{
      const response=await leaderboard({team:'valor'}).expect(200);
      assert.equal(response.body.data.leaderboard.length,2);assert.equal(response.body.data.myRank,1);
      assert.ok(response.body.data.leaderboard.every(row=>row.team==='VALOR'&&row.rank===1));
      const foreign=await leaderboard({team:'MYSTIC'}).expect(200);assert.equal(foreign.body.data.myRank,null);
      assert.deepEqual(foreign.body.data.leaderboard.map(row=>row.id),[higher]);
    });
    await t.test('level and catches use their real score rather than XP or owned Pokemon count',async()=>{
      const levels=await leaderboard({type:'level'}).expect(200);assert.equal(levels.body.data.leaderboard[0].id,higher);
      const catches=await leaderboard({type:'catches'}).expect(200);assert.equal(catches.body.data.leaderboard[0].id,tie);
      assert.equal(catches.body.data.leaderboard[0].catch_count,9);assert.equal(catches.body.data.leaderboard[0].pokemon_count,0);
      assert.equal(catches.body.data.myRank,3);assert.equal(catches.body.data.leaderboard.find(row=>row.id===owner).pokemon_count,1);
    });
    await t.test('banned and nonexistent caller identities have no eligible rank',async()=>{
      for(const id of [banned,crypto.randomUUID()]){
        const response=await request(app).get('/rewards/leaderboard').set('Authorization',`Bearer ${signAccess({id})}`).expect(200);
        assert.equal(response.body.data.myRank,null);assert.ok(response.body.data.leaderboard.every(row=>row.id!==banned));
      }
    });
    await t.test('SQL, arrays, nested objects, prototype names and invalid enums are rejected before SQL',async()=>{
      const before=queries;const snapshot=(await pool.query('SELECT id,xp,is_banned FROM users ORDER BY id')).rows;
      for(const params of [
        {team:"VALOR' OR true --"},{team:"VALOR'; DROP TABLE users;--"},{team:''},{team:['VALOR','MYSTIC']},{team:{value:'VALOR'}},
        {type:"xp; DROP TABLE users;--"},{type:'__proto__'},{type:'constructor'},{type:''},{type:['xp','level']},{type:{value:'xp'}}
      ])await leaderboard(params).expect(400);
      assert.equal(queries,before);assert.deepEqual((await pool.query('SELECT id,xp,is_banned FROM users ORDER BY id')).rows,snapshot);
    });
    await t.test('top100 is bounded while the caller below the page retains the full population rank',async()=>{
      await pool.query('UPDATE users SET xp=0 WHERE id=$1',[owner]);
      await pool.query("INSERT INTO users(id,nickname,xp,team) SELECT gen_random_uuid(),'rank-extra-'||n,100+n,'VALOR' FROM generate_series(1,105)n");
      const response=await leaderboard().expect(200);assert.equal(response.body.data.leaderboard.length,100);
      assert.ok(response.body.data.leaderboard.every(row=>row.id!==owner));assert.equal(response.body.data.myRank,108);
    });
    await t.test('an empty eligible scope returns an actual empty list and absent rank',async()=>{
      await pool.query('UPDATE users SET is_banned=true');const response=await leaderboard().expect(200);
      assert.deepEqual(response.body.data,{leaderboard:[],myRank:null});
    });
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
