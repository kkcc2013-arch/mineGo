'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');const {Pool}=require('pg');const speakeasy=require('speakeasy');
const {parseMigrationFile}=require('../../../database/migrate');const {migrationStatements}=require('../../../database/sqlStatements');
const root=path.resolve(__dirname,'../../..');

test('actual MFA HTTP/auth modules enforce enrolled factors, scoped proofs and login/refresh epochs with real PostgreSQL and Redis',async t=>{
 assert.ok(process.env.TEST_DATABASE_URL&&process.env.TEST_REDIS_URL,'owned PostgreSQL and Redis required');
 const schema='mfa_http_'+crypto.randomBytes(8).toString('hex'),admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});await admin.query('CREATE SCHEMA '+schema);
 const source=new URL(process.env.TEST_DATABASE_URL);source.searchParams.set('options','-c search_path='+schema+',public');const pool=new Pool({connectionString:source.toString(),max:3});
 const envKeys=['NODE_ENV','SERVICE_NAME','DATABASE_URL','REDIS_URL','JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','AUDIT_KMS_KEY_ID','MASTER_ENCRYPTION_KEY','AUDIT_MASTER_KEYS_JSON','AUDIT_MASTER_KEY_ID','AUDIT_KEY_NAMESPACE','MFA_KMS_KEY_ID','MFA_MASTER_ENCRYPTION_KEY','MFA_MASTER_KEYS_JSON','MFA_MASTER_KEY_ID','MFA_KEY_NAMESPACE','SMS_DEV_MODE'];const old=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
 const auditMaster=crypto.randomBytes(32),mfaMaster=crypto.randomBytes(32);
 Object.assign(process.env,{NODE_ENV:'test',SERVICE_NAME:'mfa-http-fixture',DATABASE_URL:source.toString(),REDIS_URL:process.env.TEST_REDIS_URL,JWT_ACCESS_SECRET:'mfa-http-access-fixture-only',JWT_REFRESH_SECRET:'mfa-http-refresh-fixture-only',AUDIT_KMS_KEY_ID:'',MASTER_ENCRYPTION_KEY:auditMaster.toString('hex'),AUDIT_MASTER_KEYS_JSON:'',AUDIT_MASTER_KEY_ID:'mfa-http-audit',AUDIT_KEY_NAMESPACE:'mfa-http-audit',MFA_KMS_KEY_ID:'',MFA_MASTER_ENCRYPTION_KEY:mfaMaster.toString('hex'),MFA_MASTER_KEYS_JSON:'',MFA_MASTER_KEY_ID:'mfa-http',MFA_KEY_NAMESPACE:'mfa-http',SMS_DEV_MODE:''});
 const express=require('express');const {signAccess,verifyAccess,verifyRefresh,requireAdmin,errorHandler}=require('../../shared/auth');const mfa=require('../../shared/mfaService');const audit=require('../../shared/auditLogEncrypted');const db=require('../../shared/db');const redis=require('../../shared/redis');const r=redis.getRedis();
 const owner=crypto.randomUUID(),victim=crypto.randomUUID();const phone='139'+String(crypto.randomInt(0,100000000)).padStart(8,'0');let server,base,access,initialRefresh,setup,managementProof,adminProof,adminAccess,secondRefresh,regenerated;const revocations=[];
 async function call(method,url,body,token,proof){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(token)headers.Authorization='Bearer '+token;if(proof)headers['x-mfa-token']=proof;const response=await fetch(base+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,headers:response.headers,body:await response.json()};}
 const otp=async secret=>speakeasy.totp({secret,encoding:'base32',time:(await pool.query('SELECT extract(epoch FROM clock_timestamp())::double precision AS now')).rows[0].now});
 try{
  await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
  for(const file of ['20260608_194800__add_sensitive_data_protection_tables.sql','repairs/20260608_200000__add_sensitive_data_audit_tables.sql','20260610_000000__add_mfa_system.sql','20261020_120000__mfa_verification_state.sql']){
   const source=parseMigrationFile(await fs.readFile(path.join(root,'database/pending',file),'utf8'));const client=await pool.connect();try{await client.query('BEGIN');for(const statement of migrationStatements(source.up))await client.query(statement);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  await pool.query("INSERT INTO users(id,nickname,phone) VALUES($1,'mfa-http-owner',$3),($2,'mfa-http-victim',NULL)",[owner,victim,phone]);
  const app=express();app.use(express.json());const router=require('../../services/user-service/src/routes/mfa');const {mfaRequired,sensitiveOperationRequired}=require('../../gateway/src/middleware/mfaRequired');
  app.use('/auth',require('../../services/user-service/src/routes/auth'));app.use('/users/me/mfa',router);app.use('/auth/mfa',router.createLoginRouter(undefined,{issueTokens:require('../../services/user-service/src/authSessionTokens').issueTokens}));
  app.get('/optional',mfaRequired({mandatory:false}),(req,res)=>res.json({allowed:true}));
  app.get('/operation',sensitiveOperationRequired('change-password'),(req,res)=>res.json({serverVerified:req.mfaVerified}));
  app.get('/protected',require('../../shared/auth').requireAuth,requireAdmin,mfaRequired({scope:'audit-read'}),(req,res)=>res.json({serverVerified:req.mfaVerified}));
  app.use(errorHandler);server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  await t.test('management is authenticated and primary login can issue a real session only once per SMS code',async()=>{
   assert.equal((await call('GET','/users/me/mfa/status')).status,401);assert.equal((await call('GET','/auth/mfa/status',undefined,'test_token')).status,401);
   assert.equal((await call('POST','/auth/sms-code',{phone,scene:'login'})).status,503);
   await r.set('sms:code:'+phone+':login','123456','EX',300);
   const attempts=await Promise.all([call('POST','/auth/login',{phone,smsCode:'123456'}),call('POST','/auth/login',{phone,smsCode:'123456'})]);assert.equal(attempts.filter(row=>row.status===200).length,1);assert.equal(attempts.filter(row=>row.status===400).length,1);
   const data=attempts.find(row=>row.status===200).body.data;access=data.accessToken;initialRefresh=data.refreshToken;assert.equal(verifyAccess(access).sub,owner);assert.equal(verifyAccess(access).exp,data.tokenExpireAt);assert.equal(verifyRefresh(initialRefresh).sub,owner);
   assert.ok(await r.hget('sessions:user:'+owner,data.jti));
  });
  await t.test('Redis command errors cannot produce a successful login response with an unregistered session',async()=>{
   const otherPhone='138'+phone.slice(3);await pool.query('UPDATE users SET phone=$2 WHERE id=$1',[victim,otherPhone]);
   await r.set('blacklist:user:'+victim,'owned-wrong-type-fixture','EX',60);await r.set('sms:code:'+otherPhone+':login','112233','EX',300);
   try{const result=await call('POST','/auth/login',{phone:otherPhone,smsCode:'112233'});assert.equal(result.status,503);assert.ok(!result.body.data?.accessToken);}
   finally{await r.del('blacklist:user:'+victim,'sessions:user:'+victim,'sms:code:'+otherPhone+':login');}
  });
  await t.test('explicit optional policy reads enrolled server state and rejects missing identities rather than trusting claims',async()=>{
   await mfa.ready();const unconfigured=signAccess({sub:victim,mfaEnabled:true});assert.equal((await call('GET','/optional',undefined,unconfigured)).status,200);
   assert.equal((await call('GET','/optional',undefined,signAccess({sub:crypto.randomUUID()}))).status,503);
  });
  await t.test('setup reads canonical identity and never enrolls a body-selected victim or requires an email claim',async()=>{
   const response=await call('POST','/users/me/mfa/setup',{userId:victim,email:'forged@example.invalid'},access);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');setup=response.body.data;assert.equal(setup.recoveryCodes.length,8);assert.match(setup.otpauthUrl,/mfa-http-owner/);assert.ok(!setup.otpauthUrl.includes('forged'));
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_mfa WHERE user_id=$1',[victim])).rows[0].n,0);assert.equal((await call('POST','/users/me/mfa/enable',{code:await otp(setup.secret)},access)).status,200);
  });
  await t.test('missing or false MFA claims cannot bypass server state and recovery status needs a bound proof',async()=>{
   assert.equal((await call('GET','/users/me/mfa/recovery-codes',undefined,access)).status,403);
   const falseClaim=signAccess({sub:owner,mfaEnabled:false});assert.equal((await call('GET','/users/me/mfa/recovery-codes',undefined,falseClaim)).status,403);
   const verified=await call('POST','/users/me/mfa/step-up',{code:setup.recoveryCodes[0],scope:'mfa-manage'},access);assert.equal(verified.status,200);managementProof=verified.body.data.mfaToken;assert.equal(managementProof.length,43);
   const status=await call('GET','/users/me/mfa/recovery-codes',undefined,access,managementProof);assert.equal(status.status,200);assert.equal(status.body.data.remaining,7);
   assert.equal((await call('GET','/users/me/mfa/recovery-codes',undefined,falseClaim,managementProof)).status,403);
   assert.equal((await call('GET','/users/me/mfa/recovery-codes',undefined,access,require('jsonwebtoken').sign({type:'mfa',userId:owner},'minego-secret'))).status,403);
  });
  await t.test('actual protected middleware combines verified roles, scoped MFA and revocation',async()=>{
   const jti=crypto.randomUUID();adminAccess=signAccess({sub:owner,roles:['admin'],jti,mfaEnabled:false});
   assert.equal((await call('GET','/protected',undefined,access,managementProof)).status,403);assert.equal((await call('GET','/protected',undefined,adminAccess)).status,403);
   const proof=await call('POST','/users/me/mfa/step-up',{code:setup.recoveryCodes[1],scope:'audit-read'},adminAccess);assert.equal(proof.status,200);adminProof=proof.body.data.mfaToken;
   const result=await call('GET','/protected',undefined,adminAccess,adminProof);assert.equal(result.status,200);assert.equal(result.body.serverVerified,true);
   await r.set('blacklist:token:'+jti,'1','EX',300);revocations.push('blacklist:token:'+jti);assert.equal((await call('GET','/protected',undefined,adminAccess,adminProof)).status,401);assert.equal((await call('GET','/users/me/mfa/status',undefined,adminAccess)).status,401);assert.equal((await call('POST','/users/me/mfa/step-up',{code:setup.recoveryCodes[2],scope:'audit-read'},adminAccess)).status,401);await r.del('blacklist:token:'+jti);
  });
  await t.test('a real proof-storage outage fails closed without exposing SQL or accepting an old JWT proof',async()=>{
   await pool.query('ALTER TABLE mfa_auth_proofs RENAME TO mfa_auth_proofs_owned_offline');
   try{const result=await call('GET','/protected',undefined,adminAccess,adminProof);assert.equal(result.status,503);assert.deepEqual(result.body,{error:'MFA_UNAVAILABLE'});}
   finally{await pool.query('ALTER TABLE mfa_auth_proofs_owned_offline RENAME TO mfa_auth_proofs');}
  });
  await t.test('enabled primary login returns only a challenge; arbitrary userId and replay cannot issue access tokens',async()=>{
   await r.set('sms:code:'+phone+':login','654321','EX',300);const login=await call('POST','/auth/login',{phone,smsCode:'654321'});assert.equal(login.status,200);assert.equal(login.body.data.mfaRequired,true);assert.ok(!login.body.data.accessToken);assert.ok(!login.body.data.refreshToken);
   const challenge=login.body.data.tempToken;assert.equal(challenge.length,43);assert.equal((await call('POST','/auth/mfa/verify',{userId:owner,code:setup.recoveryCodes[2]})).status,400);
   const verified=await call('POST','/auth/mfa/verify',{challenge,code:setup.recoveryCodes[2]});assert.equal(verified.status,200);assert.equal(verifyAccess(verified.body.data.accessToken).sub,owner);assert.ok(verifyAccess(verified.body.data.accessToken).mfa_epoch);assert.ok((await pool.query('SELECT last_login_at FROM users WHERE id=$1',[owner])).rows[0].last_login_at);secondRefresh=verified.body.data.refreshToken;
   assert.equal((await call('POST','/auth/mfa/verify',{challenge,code:setup.recoveryCodes[2]})).status,401);assert.equal((await call('POST','/auth/refresh',{refreshToken:initialRefresh})).status,401);
   assert.equal((await call('POST','/auth/refresh',{refreshToken:secondRefresh})).status,200);
   const refreshJti=verifyRefresh(secondRefresh).jti;const key='blacklist:token:'+refreshJti;revocations.push(key);await r.set(key,'1','EX',300);
   try{assert.equal((await call('POST','/auth/refresh',{refreshToken:secondRefresh})).status,401);}finally{await r.del(key);}

  });
  await t.test('rotating recovery material revokes old proofs and refresh epochs; disabling needs a fresh factor',async()=>{
   const response=await call('POST','/users/me/mfa/recovery-codes/regenerate',{code:setup.recoveryCodes[3]},access);assert.equal(response.status,200);regenerated=response.body.data.recoveryCodes;assert.equal(regenerated.length,8);
   assert.equal((await call('GET','/protected',undefined,adminAccess,adminProof)).status,403);assert.equal((await call('POST','/auth/refresh',{refreshToken:secondRefresh})).status,401);
   assert.equal((await call('POST','/users/me/mfa/disable',{code:setup.recoveryCodes[4]},access)).status,401);assert.equal((await call('POST','/users/me/mfa/disable',{code:regenerated[0]},access)).status,200);
   assert.equal((await call('GET','/operation',undefined,access)).status,403);
   const status=await call('GET','/users/me/mfa/status',undefined,access);assert.equal(status.status,200);assert.equal(status.body.data.enabled,false);
   const metrics=await require('../../shared/metrics').register.metrics();assert.match(metrics,/mfa_setup_total\{status="success"\} 1/);assert.match(metrics,/mfa_enabled_users_gauge 0/);assert.match(metrics,/mfa_verification_total\{type="recovery",status="success"\}/);
  });
 }finally{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  for(const key of ['sms:code:'+phone+':login','sms:lock:'+phone,'sms:daily:'+phone,'sessions:user:'+owner,'blacklist:user:'+owner,...revocations])await r.del(key).catch(()=>{});
  await mfa.closeMFA();await audit.closeAuditEncryption();await db.closePools();await redis.closeRedis();auditMaster.fill(0);mfaMaster.fill(0);
  for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
 }
});
