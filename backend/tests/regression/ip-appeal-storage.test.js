'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const express=require('express');
const request=require('supertest');
const {Pool}=require('pg');
const Redis=require('ioredis');
const IpBanManager=require('../../shared/IpBanManager');
const {createIpAppealRouter}=require('../../services/user-service/src/routes/ipAppeal');
const {mountIpAppealProxy,prefixes}=require('../../gateway/src/routes/ipAppealProxy');
const {createIpBanMiddleware}=require('../../gateway/src/middleware/ipBan');
const {signAccess,errorHandler}=require('../../shared/auth');

test('real IP appeal storage and production gateway proxy with JWT, CIDR and ownership',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL);assert.ok(process.env.TEST_REDIS_URL);
  const schema=`appeal_test_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const redis=new Redis(process.env.TEST_REDIS_URL);
  const manager=new IpBanManager({db,redis,autoInitialize:false});
  let upstream,proxy;
  const first=crypto.randomUUID(),second=crypto.randomUUID();
  try{
    await db.query('CREATE TABLE users(id UUID PRIMARY KEY,nickname VARCHAR(30) NOT NULL)');
    await db.query('INSERT INTO users VALUES($1,$2),($3,$4)',[first,'first',second,'second']);
    await db.query(await fs.readFile(path.resolve(__dirname,'../../../database/pending/20261008_100000__ip_ban_index_compatibility.sql'),'utf8'));
    await manager.init();assert.equal(manager.initialized,true);
    const app=express();app.set('trust proxy','loopback');app.use(express.json());app.use('/ip-appeal',createIpAppealRouter(()=>manager));app.use(errorHandler);
    upstream=http.createServer(app);await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
    const gateway=express();gateway.use(express.json());gateway.use(createIpBanMiddleware(()=>manager));
    proxy=mountIpAppealProxy(gateway,`http://127.0.0.1:${upstream.address().port}`);
    gateway.get('/business',(req,res)=>res.json({allowed:true}));gateway.use(errorHandler);
    const auth=(method,url,user=first)=>request(gateway)[method](url).set('Authorization',`Bearer ${signAccess({sub:user})}`);
    await t.test('signed identity is checked before storage and every declared alias is reachable',async()=>{
      for(const prefix of prefixes){
        assert.equal((await request(gateway).get(prefix+'/check')).status,200);
        assert.equal((await request(gateway).get(prefix+'/status').set('Authorization','Bearer invalid')).status,401);
        assert.equal((await auth('get',prefix+'/status')).body.hasAppeal,false);
      }
      const unavailable=express();unavailable.use('/ip-appeal',createIpAppealRouter(()=>null));unavailable.use(errorHandler);
      assert.equal((await request(unavailable).get('/ip-appeal/status').set('Authorization','Bearer invalid')).status,401);
      assert.equal((await request(unavailable).get('/ip-appeal/check')).status,503);
    });
    await t.test('spoofed forwarding headers cannot choose a different appeal/client address',async()=>{
      const response=await request(gateway).get('/api/ip-appeal/check').set('X-Forwarded-For','203.0.113.88').set('X-Real-IP','203.0.113.89');
      assert.equal(response.body.ipAddress,'127.0.0.1');
    });
    await t.test('CIDR permanent bans enforce ordinary requests while appeals remain reachable',async()=>{
      await db.query("INSERT INTO ip_blacklist(ip_address,reason,severity) VALUES('127.0.0.0/8','test subnet ban','critical')");
      assert.equal((await manager.isBlocked('127.0.0.1')).blocked,true);
      assert.equal((await request(gateway).get('/business')).status,403);
      assert.equal((await request(gateway).get('/api/ip-appeal/check')).body.isBlocked,true);
    });
    await t.test('non-string and short reasons fail before an appeal is persisted',async()=>{
      for(const reason of [null,{},[],1,'short','x'.repeat(5001)])assert.equal((await auth('post','/api/ip-appeal').send({appealReason:reason})).status,400);
      assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM ip_ban_appeals')).rows[0].count,0);
    });
    await t.test('a signed submission persists once and status exposes only that verified user',async()=>{
      const response=await auth('post','/api/v1/users/ip-appeal').send({appealReason:'Please review this subnet ban.'});
      assert.equal(response.status,200);assert.equal(response.body.success,true);
      const row=(await db.query('SELECT * FROM ip_ban_appeals')).rows[0];assert.equal(row.user_id,first);assert.equal(row.ip_address,'127.0.0.1');
      assert.equal((await auth('get','/api/ip-appeal/status')).body.appeal.id,row.id);
      assert.equal((await auth('get','/api/ip-appeal/status',second)).body.hasAppeal,false);
      await db.query("UPDATE ip_ban_appeals SET status='rejected',reviewed_by=$2,review_note='Reviewed' WHERE id=$1",[row.id,second]);
      const reviewed=await auth('get','/api/ip-appeal/status');assert.equal(reviewed.body.appeal.reviewerName,'second');assert.equal(reviewed.body.appeal.reviewNote,'Reviewed');
    });
    await t.test('a CIDR whitelist overrides blacklist and an expired ban grants no authority',async()=>{
      await db.query("INSERT INTO ip_whitelist(ip_address) VALUES('127.0.0.0/8')");
      assert.equal((await request(gateway).get('/business')).status,200);
      assert.equal((await auth('post','/api/ip-appeal').send({appealReason:'This address is already whitelisted.'})).status,400);
      await db.query('DELETE FROM ip_whitelist');
      await db.query("UPDATE ip_blacklist SET expires_at=NOW()-INTERVAL '1 second'");
      assert.equal((await manager.isBlocked('127.0.0.1')).blocked,false);
    });
    await t.test('invalid or out-of-range risk caches cannot become authoritative risk scores',async()=>{
      await db.query("INSERT INTO ip_risk_scores(ip_address,risk_score) VALUES('127.0.0.1',42) ON CONFLICT(ip_address) DO UPDATE SET risk_score=42");
      for(const invalid of ['NaN','900','-4','12junk','  ','12.0']) {
        await redis.set('ipban:risk:127.0.0.1',invalid);assert.equal(await manager.getRiskScore('127.0.0.1'),42);
      }
    });
    await t.test('a failed status query releases its connection and storage outage cannot bypass enforcement',async()=>{
      const original=manager.db;let released=false;
      manager.db={connect:async()=>({query:async()=>{throw new Error('deliberate storage failure');},release:()=>{released=true;}})};
      try{
        assert.equal((await auth('get','/api/ip-appeal/status')).status,500);assert.equal(released,true);
        assert.equal((await request(gateway).get('/business')).status,503);
      }finally{manager.db=original;}
    });
  }finally{
    proxy?.close();if(upstream)await new Promise(r=>upstream.close(r));
    await manager.close();await redis.del('ipban:risk:127.0.0.1');await redis.quit();await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});
