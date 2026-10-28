'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {Pool} = require('pg');
const speakeasy = require('speakeasy');
const {parseMigrationFile} = require('../../../database/migrate');
const {migrationStatements} = require('../../../database/sqlStatements');
const {ensureStorageExtensions} = require('./storageSetup');
const root = path.resolve(__dirname, '../../..');

test('actual payment risk boundary uses registered sessions, canonical cross-service MFA and encrypted traced decisions', {timeout: 120000}, async t => {
  assert.ok(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);
  const schema = 'risk_' + crypto.randomBytes(8).toString('hex');
  const admin = new Pool({connectionString: process.env.TEST_DATABASE_URL, max: 1});
  await ensureStorageExtensions(admin);
  await admin.query('CREATE SCHEMA ' + schema);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', '-c search_path=' + schema + ',public');
  const pool = new Pool({connectionString: url.toString(), max: 3});
  const keys = ['NODE_ENV','DATABASE_URL','SERVICE_NAME','REDIS_URL','JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','AUDIT_KMS_KEY_ID','MASTER_ENCRYPTION_KEY','AUDIT_MASTER_KEYS_JSON','AUDIT_MASTER_KEY_ID','AUDIT_KEY_NAMESPACE','MFA_KMS_KEY_ID','MFA_MASTER_ENCRYPTION_KEY','MFA_MASTER_KEYS_JSON','MFA_MASTER_KEY_ID','MFA_KEY_NAMESPACE'];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const auditKey = crypto.randomBytes(32), mfaKey = crypto.randomBytes(32), channelSecret = crypto.randomBytes(32).toString('hex');
  Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:url.toString(), SERVICE_NAME:schema, REDIS_URL:process.env.TEST_REDIS_URL,
    JWT_ACCESS_SECRET:'owned-risk-access-fixture', JWT_REFRESH_SECRET:'owned-risk-refresh-fixture', AUDIT_KMS_KEY_ID:'', MASTER_ENCRYPTION_KEY:auditKey.toString('hex'), AUDIT_MASTER_KEYS_JSON:'', AUDIT_MASTER_KEY_ID:'risk-audit', AUDIT_KEY_NAMESPACE:schema,
    MFA_KMS_KEY_ID:'', MFA_MASTER_ENCRYPTION_KEY:mfaKey.toString('hex'), MFA_MASTER_KEYS_JSON:'', MFA_MASTER_KEY_ID:'risk-mfa', MFA_KEY_NAMESPACE:schema});
  const express = require('express');
  const db = require('../../shared/db'), redis = require('../../shared/redis'), r = redis.getRedis();
  const mfa = require('../../shared/mfaService'), audit = require('../../shared/auditLogEncrypted');
  const {RiskVerifier, factorsFor, paymentPolicy} = require('../../shared/riskVerifier');
  const {issueTokens} = require('../../services/user-service/src/authSessionTokens');
  const {signAccess, verifyAccess, errorHandler} = require('../../shared/auth');
  const {createPaymentRouter} = require('../../services/payment-service/src/routes/payment');
  const {PaymentStore} = require('../../services/payment-service/src/payment/PaymentStore');
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  const phone = '139' + String(crypto.randomInt(10000000,99999999));
  const ownedKeys = new Set(['sms:code:' + phone + ':login']);
  let payment, user, closed, access, initial, authenticated, setup, normalProof, largeProof, risk;
  const authHeaders = token => ({Authorization: 'Bearer ' + token, 'User-Agent':'owned-risk-agent'});
  async function start(app) {const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return {server, base:'http://127.0.0.1:' + server.address().port};}
  async function request(target, route, {method='POST', body, token=access, headers={}}={}) {
    const response = await fetch(target.base + route, {method, headers:{...authHeaders(token), 'Content-Type':'application/json', ...headers}, body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status, body:await response.json(), headers:response.headers};
  }
  async function purchase({token=access, headers={}, productId='coins_60', quantity=1}={}) {
    const key = crypto.randomUUID();
    ownedKeys.add('payment:create:' + verifyAccess(token).sub + ':' + key);
    return request(payment, '/payment/orders', {token, headers:{'X-Idempotency-Key':key, ...headers}, body:{productId, channel:'WECHAT', quantity}});
  }
  async function stepUp(scope, code) {return request(user, '/users/me/mfa/step-up', {body:{scope, code}});}
  const rowCount = async () => (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
  async function sessionValue(token=access) {const c=verifyAccess(token); return {c, value:JSON.parse(await r.hget('sessions:user:'+c.sub,c.jti))};}
  try {
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    for (const file of ['20260608_194800__add_sensitive_data_protection_tables.sql','repairs/20260608_200000__add_sensitive_data_audit_tables.sql','20260607_211500__add_age_verification_coppa_tables.sql','20261025_120000__payment_order_integrity.sql','20260610_000000__add_mfa_system.sql','20261020_120000__mfa_verification_state.sql']) {
      const migration = parseMigrationFile(await fs.readFile(path.join(root,'database/pending',file),'utf8'));
      await pool.query('BEGIN'); try {for(const sql of migrationStatements(migration.up)) await pool.query(sql); await pool.query('COMMIT');} catch(error) {await pool.query('ROLLBACK');throw error;}
    }
    await pool.query("INSERT INTO users(id,nickname,phone) VALUES($1,'risk owner',$2),($3,'risk other',NULL)",[owner,phone,other]);
    const store = new PaymentStore(); await store.ready();
    risk = new RiskVerifier(); await risk.ready();
    const app = express(); app.use('/payment',createPaymentRouter({store,risk,secrets:{WECHAT:channelSecret,ALIPAY:channelSecret,APPLE:channelSecret}})); app.use(errorHandler); payment=await start(app);
    const userApp = express(); userApp.use(express.json());
    userApp.use('/auth',require('../../services/user-service/src/routes/auth'));
    userApp.use('/auth/mfa',require('../../services/user-service/src/routes/mfa').createLoginRouter(mfa,{issueTokens}));
    userApp.use('/users/me/mfa',require('../../services/user-service/src/routes/mfa').createMfaRouter(mfa)); userApp.use(errorHandler); user=await start(userApp);
    initial=await issueTokens({id:owner,nickname:'risk owner'},{ip:'127.0.0.1',userAgent:'owned-risk-agent'}); access=initial.accessToken;
    for(const id of [owner,other]) {ownedKeys.add('sessions:user:'+id);ownedKeys.add('blacklist:user:'+id);for(const k of Object.values(risk.keys(id,'127.0.0.1')))ownedKeys.add(k);}
    await t.test('five factors retain 30/25/20/15/10 bounds and server price policy cannot accept invalid amounts',()=>{
      assert.deepEqual(factorsFor({trustedDevice:true,sameAddress:true,requests:1,failures:0,ageSeconds:0}),{factors:{device_trust:0,location_risk:0,behavior_risk:0,history_risk:0,session_age:0},score:0,level:'low'});
      assert.equal(factorsFor({trustedDevice:false,sameAddress:false,requests:121,failures:3,ageSeconds:43201}).score,100);
      assert.equal(factorsFor({trustedDevice:false,sameAddress:true,requests:61,failures:1,ageSeconds:301}).score,48);
      assert.equal(factorsFor({trustedDevice:false,sameAddress:false,requests:1,failures:0,ageSeconds:3601}).level,'high');
      assert.throws(()=>factorsFor({trustedDevice:true,sameAddress:true,requests:NaN,failures:0,ageSeconds:0}),/RISK_CONTEXT_INVALID/);
      for(const value of [0,-1,Infinity,1.1])assert.throws(()=>paymentPolicy(value),/RISK_POLICY_INVALID/);
      assert.equal(paymentPolicy(9999).mandatory,false);assert.equal(paymentPolicy(10000).mandatory,true);
    });
    await t.test('registered current low-risk session reaches the actual payment store',async()=>{const result=await purchase();assert.equal(result.status,201);assert.equal(result.body.data.amountFen,600);});
    await t.test('signature-only, absent, malformed and revoked server sessions cannot read or create orders',async()=>{
      const count=await rowCount();const bare=signAccess({sub:owner});assert.equal((await request(payment,'/payment/orders',{token:bare,method:'GET'})).status,401);
      const unknown=signAccess({sub:owner,jti:crypto.randomUUID()});assert.equal((await purchase({token:unknown})).status,401);
      const {c,value}=await sessionValue();const key='sessions:user:'+owner;
      await r.hset(key,c.jti,'{malformed');assert.equal((await purchase()).status,401);await r.hset(key,c.jti,JSON.stringify(value));
      const revocation='blacklist:token:'+c.jti;ownedKeys.add(revocation);await r.set(revocation,'1','EX',300);assert.equal((await purchase()).status,401);await r.del(revocation);
      assert.equal(await rowCount(),count);
    });
    await t.test('changed address and caller verification/risk claims cannot bypass required enrollment',async()=>{
      const {c,value}=await sessionValue();await r.hset('sessions:user:'+owner,c.jti,JSON.stringify({...value,ip:'198.51.100.9'}));
      try {const result=await purchase({headers:{'x-verified-types':'mfa,sms','x-risk-score':'0','x-device-id':'trusted','x-mfa-token':'forged'}});assert.equal(result.status,403);assert.equal(result.body.code,'MFA_ENROLLMENT_REQUIRED');assert.equal(result.body.data.scope,'payment-purchase');assert.ok(result.body.data.riskScore>=50);} finally {await r.hset('sessions:user:'+owner,c.jti,JSON.stringify(value));}
    });
    await t.test('server-priced large purchase requires MFA and cannot create an order before verification',async()=>{const count=await rowCount();const result=await purchase({quantity:20});assert.equal(result.status,403);assert.equal(result.body.data.scope,'large-transaction');assert.equal(await rowCount(),count);});
    await t.test('actual user enrollment and MFA login issue a registered epoch-bound access session',async()=>{
      const response=await request(user,'/users/me/mfa/setup',{body:{}});assert.equal(response.status,200);setup=response.body.data;
      const now=(await pool.query('SELECT extract(epoch FROM clock_timestamp())::double precision AS now')).rows[0].now;
      assert.equal((await request(user,'/users/me/mfa/enable',{body:{code:speakeasy.totp({secret:setup.secret,encoding:'base32',time:now})}})).status,200);
      assert.equal((await purchase()).status,401);
      await r.set('sms:code:'+phone+':login','654321','EX',300);
      const challenge=await request(user,'/auth/login',{body:{phone,smsCode:'654321'}});assert.equal(challenge.body.data.mfaRequired,true);
      const verified=await request(user,'/auth/mfa/verify',{body:{challenge:challenge.body.data.tempToken,code:setup.recoveryCodes[0]}});assert.equal(verified.status,200);authenticated=verified.body.data;access=authenticated.accessToken;
      const {c,value}=await sessionValue();assert.equal(value.mfaEpoch,c.mfa_epoch);assert.equal(value.mfaAuthenticated,true);assert.equal(value.ip,'127.0.0.1');assert.equal(value.userAgent,'owned-risk-agent');
    });
    await t.test('proof minted by the actual user HTTP route is accepted only for the correct payment purpose',async()=>{
      assert.equal((await purchase({quantity:20})).body.code,'MFA_PROOF_REQUIRED');
      const normal=await stepUp('payment-purchase',setup.recoveryCodes[1]);assert.equal(normal.status,200);normalProof=normal.body.data.mfaToken;
      assert.equal((await purchase({quantity:20,headers:{'x-mfa-token':normalProof}})).status,403);
      const large=await stepUp('large-transaction',setup.recoveryCodes[2]);assert.equal(large.status,200);largeProof=large.body.data.mfaToken;
      assert.equal((await purchase({quantity:20,headers:{'x-mfa-token':largeProof}})).status,201);
    });
    await t.test('new context requires fresh purpose proof; forged headers cannot substitute for it',async()=>{
      const {c,value}=await sessionValue();await r.hset('sessions:user:'+owner,c.jti,JSON.stringify({...value,ip:'198.51.100.9'}));
      try {
        const headers={'User-Agent':'changed-agent','x-verified-types':'mfa','x-mfa-enabled':'true'};
        const refused=await purchase({headers});assert.equal(refused.status,403);assert.equal(refused.body.data.scope,'payment-purchase');
        assert.equal((await purchase({headers:{...headers,'x-mfa-token':normalProof}})).status,201);
      } finally {await r.hset('sessions:user:'+owner,c.jti,JSON.stringify(value));}
    });
    await t.test('refreshed session cannot reuse proof bound to another bearer token',async()=>{
      const refreshed=await request(user,'/auth/refresh',{body:{refreshToken:authenticated.refreshToken}});assert.equal(refreshed.status,200);
      const renewed=await sessionValue(refreshed.body.data.accessToken);assert.equal(renewed.value.mfaAuthenticated,true);
      assert.equal((await purchase({token:refreshed.body.data.accessToken,quantity:20,headers:{'x-mfa-token':largeProof}})).status,403);
    });
    await t.test('registered MFA epoch alone cannot upgrade a primary-only session or refresh it',async()=>{
      const {value}=await sessionValue();const claims=verifyAccess(access);const jti=crypto.randomUUID();
      const primary=signAccess({sub:owner,jti,mfa_epoch:claims.mfa_epoch});const issued=verifyAccess(primary);
      const refresh=require('../../shared/auth').signRefresh({sub:owner,jti,mfa_epoch:claims.mfa_epoch});
      const refreshExpiresAt=require('../../shared/auth').verifyRefresh(refresh).exp;
      await r.hset('sessions:user:'+owner,jti,JSON.stringify({...value,jti,createdAt:issued.iat,expiresAt:issued.exp,refreshExpiresAt,mfaAuthenticated:false}));
      assert.equal((await purchase({token:primary})).status,401);
      assert.equal((await request(user,'/auth/refresh',{body:{refreshToken:refresh}})).status,401);
    });
    await t.test('expired access metadata does not shorten a still-valid registered refresh token',async()=>{
      const renewed=await request(user,'/auth/refresh',{body:{refreshToken:authenticated.refreshToken}});assert.equal(renewed.status,200);
      const {c,value}=await sessionValue(renewed.body.data.accessToken);assert.ok(value.refreshExpiresAt>value.expiresAt);
      await r.hset('sessions:user:'+owner,c.jti,JSON.stringify({...value,expiresAt:Math.floor(Date.now()/1000)-1}));
      assert.equal((await request(user,'/auth/refresh',{body:{refreshToken:renewed.body.data.refreshToken}})).status,200);
    });
    await t.test('actual proof expiration is enforced before business execution',async()=>{
      const hash=crypto.createHash('sha256').update(largeProof).digest('hex');const times=(await pool.query('SELECT created_at,expires_at FROM mfa_auth_proofs WHERE proof_hash=$1',[hash])).rows[0];
      await pool.query("UPDATE mfa_auth_proofs SET created_at=clock_timestamp()-INTERVAL '6 minutes',expires_at=clock_timestamp()-INTERVAL '1 minute' WHERE proof_hash=$1",[hash]);
      try {const count=await rowCount();assert.equal((await purchase({quantity:20,headers:{'x-mfa-token':largeProof}})).status,403);assert.equal(await rowCount(),count);} finally {await pool.query('UPDATE mfa_auth_proofs SET created_at=$2,expires_at=$3 WHERE proof_hash=$1',[hash,times.created_at,times.expires_at]);}
    });
    await t.test('critical server history and rate context block even a valid proof',async()=>{
      const owned=risk.keys(owner,'127.0.0.1');const clock=await r.time();const now=Number(clock[0])*1000+Math.floor(Number(clock[1])/1000);
      const {c,value}=await sessionValue();await r.hset('sessions:user:'+owner,c.jti,JSON.stringify({...value,ip:'198.51.100.9'}));
      for(let n=0;n<121;n++)await r.zadd(owned.ip,now,'owned-rate-'+n);
      for(let n=0;n<3;n++)await r.zadd(owned.failures,now,'owned-failure-'+n);
      try {const count=await rowCount();const result=await purchase({headers:{'User-Agent':'changed-agent','x-mfa-token':normalProof}});assert.equal(result.status,403);assert.equal(result.body.code,'RISK_LIMIT_EXCEEDED');assert.equal(result.body.data.mfaRequired,false);assert.equal(await rowCount(),count);} finally {await r.hset('sessions:user:'+owner,c.jti,JSON.stringify(value));await r.del(owned.ip,owned.user,owned.failures);}
    });
    await t.test('encrypted decisions retain trace identity without raw session, factor secrets or keys in plaintext',async()=>{
      const rows=(await pool.query("SELECT id::text,entity_id,details,encrypted_data FROM audit_logs WHERE action='SENSITIVE_OPERATION_EVALUATED' ORDER BY id")).rows;assert.ok(rows.length>=10);assert.ok(rows.every(row=>row.details===null&&Buffer.isBuffer(row.encrypted_data)));
      const read=await audit.readEncryptedAuditLog(rows[0].id);assert.equal(read.data.actionData.traceId,rows[0].entity_id);assert.equal(read.data.actionData.operation,'payment.purchase.normal');assert.equal(read.data.actionData.decision,'allow');
      for(const secret of [access,normalProof,largeProof,setup.secret,auditKey.toString('hex'),mfaKey.toString('hex')])assert.ok(!JSON.stringify(read).includes(secret));
    });
    await t.test('missing canonical state or unavailable encrypted audit refuses before creating an order',async()=>{
      const count=await rowCount();await pool.query('ALTER TABLE mfa_security_state RENAME TO risk_owned_state_offline');
      try {assert.equal((await purchase()).status,503);} finally {await pool.query('ALTER TABLE risk_owned_state_offline RENAME TO mfa_security_state');}
      await pool.query('ALTER TABLE audit_logs RENAME TO risk_owned_audit_offline');
      try {assert.equal((await purchase()).body.code,'RISK_AUDIT_UNAVAILABLE');} finally {await pool.query('ALTER TABLE risk_owned_audit_offline RENAME TO audit_logs');}
      assert.equal(await rowCount(),count);
    });
    await t.test('disabling factors changes epoch and invalidates earlier access plus its proof',async()=>{
      assert.equal((await request(user,'/users/me/mfa/disable',{body:{code:setup.recoveryCodes[3]}})).status,200);
      assert.equal((await purchase({quantity:20,headers:{'x-mfa-token':largeProof}})).status,401);
    });
  } finally {
    for(const endpoint of [payment,user])if(endpoint){endpoint.server.closeAllConnections();await new Promise(resolve=>endpoint.server.close(resolve));}
    if(closed)await closed.quit();
    for(const key of ownedKeys)await r.del(key).catch(()=>{});
    await mfa.closeMFA();await audit.closeAuditEncryption();await db.closePools();await redis.closeRedis();
    for(const [k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    auditKey.fill(0);mfaKey.fill(0);await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
  }
});
