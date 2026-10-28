'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {Pool} = require('pg');
const Redis = require('ioredis');
const express = require('express');
const request = require('supertest');
const {TitleServiceClass, titleMetrics} = require('../../services/user-service/src/titleService');
const {createTitleRouter} = require('../../services/user-service/src/routes/titles');
const {signAccess,errorHandler} = require('../../shared/auth');
const {register} = require('../../shared/metrics');

test('actual title routes and storage with UUID identities, concurrent updates and expiry', async t => {
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
  assert.ok(process.env.TEST_REDIS_URL,'TEST_REDIS_URL is required');
  const schema=`title_test_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const cache=new Redis(process.env.TEST_REDIS_URL);
  const db={query:pool.query.bind(pool),getClient:()=>pool.connect()};
  const service=new TitleServiceClass({db,cache});
  const app=express();app.use(express.json());app.use('/users',createTitleRouter(service));app.use(errorHandler);
  const userId=crypto.randomUUID(),secondId=crypto.randomUUID();
  const token=signAccess({sub:userId}),adminToken=signAccess({sub:userId,roles:['admin']});
  const signed=(method,url,identity=token)=>request(app)[method](url).set('Authorization',`Bearer ${identity}`);
  const source=await fs.readFile(path.resolve(__dirname,'../../../database/pending/20261007_120000__title_identity_compatibility.sql'),'utf8');
  try {
    await pool.query('CREATE TABLE users (id UUID PRIMARY KEY,nickname VARCHAR(30) UNIQUE NOT NULL,avatar_url VARCHAR(500))');
    await pool.query('INSERT INTO users (id,nickname) VALUES ($1,$2),($3,$4)',[userId,'player',secondId,'other']);
    await t.test('migration creates 20 definitions and constraints and can be rerun without overwriting data',async()=>{
      await pool.query(source);await pool.query(source);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM title_definitions')).rows[0].count,20);
      const identity=(await pool.query("SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='user_titles'::regclass AND attname='user_id'")).rows[0];
      assert.equal(identity.type,'uuid');
      await service.initialize();assert.equal(service.titleDefinitions.size,20);assert.equal(service.initialized,true);
      await assert.rejects(pool.query("INSERT INTO user_titles (user_id,title_id,source_type) VALUES ($1,'novice_trainer','test')",[crypto.randomUUID()]),e=>e.code==='23503');
    });
    await t.test('signed users cannot self-grant rewards or run expiry jobs',async()=>{
      assert.equal((await request(app).get('/users/me/titles')).status,401);
      assert.equal((await signed('post','/users/me/titles/pokemon_master/unlock').send({})).status,403);
      assert.equal((await signed('post','/users/titles/process-expired').send({})).status,403);
      assert.equal((await signed('post','/users/titles/process-expired',signAccess({sub:userId,isAdmin:true}))).status,403);
    });
    await t.test('admin grant is stored once under concurrent calls and uses typed errors',async()=>{
      const results=await Promise.all(Array.from({length:8},()=>service.unlockTitle(userId,'novice_trainer','achievement','first_catch')));
      assert.equal(results.filter(r=>!r.alreadyUnlocked).length,1);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM user_titles WHERE user_id=$1',[userId])).rows[0].count,1);
      assert.equal((await signed('post','/users/me/titles/pokemon_master/unlock',adminToken).send({sourceType:'admin'})).status,200);
      assert.equal((await signed('post','/users/me/titles/unknown/unlock',adminToken).send({})).status,404);
    });
    await t.test('activation, favorite, public views, filters and stats use real owned records',async()=>{
      assert.equal((await signed('put','/users/me/titles/novice_trainer/activate')).status,200);
      assert.equal((await signed('put','/users/me/titles/pokemon_master/favorite').send({isFavorite:true})).status,200);
      assert.equal((await signed('put','/users/me/titles/pokemon_master/favorite').send({isFavorite:'true'})).status,400);
      assert.equal((await signed('put','/users/me/titles/unknown/favorite').send({})).status,404);
      const titles=(await signed('get','/users/me/titles?rarity=legendary')).body.data.titles;
      assert.equal(titles.length,1);assert.equal(titles[0].titleId,'pokemon_master');assert.equal(titles[0].isFavorite,true);
      assert.equal((await request(app).get(`/users/${userId}/titles`)).body.data.titles.length,2);
      assert.equal((await request(app).get(`/users/${userId}/titles/active`)).body.data.title.titleId,'novice_trainer');
      assert.equal((await signed('get','/users/me/titles/stats')).body.data.stats.total_titles,2);
      assert.deepEqual(await service.getUserStatBonuses(userId),{});
      assert.equal((await signed('put','/users/me/titles/champion/activate')).status,403);
    });
    await t.test('parallel title switches leave exactly one active title and invalidate old snapshots',async()=>{
      await cache.set(`user:active_title:${userId}`,JSON.stringify({titleId:'old'}));
      await cache.set(`user:stat_bonuses:${userId}`,JSON.stringify({catch_rate:999}));
      await Promise.all(Array.from({length:10},(_,i)=>service.setActiveTitle(userId,i%2?'novice_trainer':'pokemon_master')));
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM user_titles WHERE user_id=$1 AND is_active=true',[userId])).rows[0].count,1);
      assert.equal(await cache.get(`user:active_title:${userId}`),null);
      assert.equal(await cache.get(`user:stat_bonuses:${userId}`),null);
      await service.setActiveTitle(userId,'pokemon_master');
      assert.equal((await service.getUserStatBonuses(userId)).catch_rate,0.1);
      await assert.rejects(pool.query("UPDATE user_titles SET is_active=true WHERE user_id=$1 AND title_id='novice_trainer'",[userId]),e=>e.code==='23505');
    });
    await t.test('a failure between activation updates rolls back and retains the prior active title',async()=>{
      const original=service.db;
      service.db={...db,getClient:async()=>{
        const client=await pool.connect();return {release:()=>client.release(),query:(sql,args)=>{
          if(sql==='UPDATE user_titles SET is_active=true WHERE user_id=$1 AND title_id=$2')return Promise.reject(new Error('deliberate activation failure'));
          return client.query(sql,args);
        }};
      }};
      try{await assert.rejects(service.setActiveTitle(userId,'novice_trainer'),/deliberate activation failure/);}finally{service.db=original;}
      assert.equal((await service.getActiveTitle(userId)).titleId,'pokemon_master');
    });
    await t.test('expired titles never provide bonuses or appear in active/statistics views',async()=>{
      await pool.query("UPDATE user_titles SET expires_at=NOW()-INTERVAL '1 minute' WHERE user_id=$1 AND title_id='pokemon_master'",[userId]);
      assert.equal(await service.getActiveTitle(userId),null);assert.deepEqual(await service.getUserStatBonuses(userId),{});
      assert.equal((await service.getUserTitles(userId)).length,1);
      assert.equal((await service.getUserTitles(userId,{includeExpired:true})).length,2);
      assert.equal((await service.getUserTitleStats(userId)).legendary_count,0);
      assert.equal((await signed('put','/users/me/titles/pokemon_master/activate')).status,403);
      assert.equal((await signed('post','/users/titles/process-expired',adminToken)).body.data.expiredCount,1);
      assert.equal(await service.processExpiredTitles(),0);
    });
    await t.test('leaderboard/shop static paths precede the title parameter and enforce numeric limits',async()=>{
      const leaderboard=await request(app).get('/users/titles/leaderboard?limit=1');assert.equal(leaderboard.status,200);
      assert.equal(leaderboard.body.data.leaderboard[0].nickname,'player');
      assert.equal((await request(app).get('/users/titles/leaderboard?limit=1junk')).status,400);
      assert.equal((await request(app).get('/users/titles/leaderboard?limit=0')).status,400);
      assert.equal((await request(app).get('/users/titles/unknown')).status,404);
      assert.equal((await request(app).get('/users/titles')).body.data.titles.length,20);
      assert.equal((await signed('get','/users/titles/shop')).status,200);
      assert.equal((await signed('get','/users/titles/shop?page=0')).status,400);
    });
    await t.test('server-side achievement/event/rank grants are idempotent and definitions can reload',async()=>{
      assert.equal((await service.unlockTitleByAchievement(secondId,'first_catch')).length,1);
      assert.equal((await service.unlockTitleByAchievement(secondId,'first_catch')).length,0);
      assert.equal((await service.unlockTitleByEvent(secondId,'summer_2026')).length,1);
      assert.equal((await service.unlockTitleByRank(secondId,25)).length,3);
      assert.throws(()=>service.unlockTitleByRank(secondId,0),/Invalid rank/);
      await service.reload();assert.equal(service.getAllTitleDefinitions({category:'rank'}).length,5);
      assert.equal(service.getAllTitleDefinitions({rarity:'mythic'}).length,1);
    });
    await t.test('cache outage cannot turn a committed title switch into a failed mutation',async()=>{
      const prior=service.cache;service.cache={del:async()=>{throw new Error('cache unavailable');}};
      try{await service.setActiveTitle(userId,'novice_trainer');}finally{service.cache=prior;}
      assert.equal((await service.getActiveTitle(userId)).titleId,'novice_trainer');
    });
    await t.test('metrics reflect successful grants/activations/expiry and actual leaderboard access',async()=>{
      const metrics=await register.metrics();
      for(const name of ['minego_titles_unlocked_total','minego_titles_activated_total','minego_titles_expired_total','minego_title_leaderboard_views_total'])assert.ok(metrics.includes(name));
      assert.ok((await titleMetrics.expired.get()).values[0].value>=1);
    });
    await t.test('legacy BIGINT users receive matching title identities; mismatched identities fail safely',async()=>{
      const other=`${schema}_legacy`;await admin.query(`CREATE SCHEMA ${other}`);
      const legacy=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${other},public`});
      try{
        await legacy.query('CREATE TABLE users(id BIGINT PRIMARY KEY,nickname VARCHAR(30),avatar_url VARCHAR(500))');
        await legacy.query(source);
        assert.equal((await legacy.query("SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='user_titles'::regclass AND attname='user_id'")).rows[0].type,'bigint');
        await legacy.query('DROP VIEW user_title_stats');await legacy.query('DROP TABLE user_titles');
        await legacy.query('CREATE TABLE user_titles(user_id UUID,title_id VARCHAR(50))');
        await assert.rejects(legacy.query(source),/explicit identity mapping/);
      }finally{await legacy.end();await admin.query(`DROP SCHEMA ${other} CASCADE`);}
    });
  }finally{
    await cache.del(`user:active_title:${userId}`,`user:stat_bonuses:${userId}`,`user:active_title:${secondId}`,`user:stat_bonuses:${secondId}`);
    await cache.quit();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});
