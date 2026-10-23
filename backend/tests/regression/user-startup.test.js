'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {Pool} = require('pg');
const {Kafka} = require('kafkajs');
const {performance} = require('node:perf_hooks');
const http = require('node:http');
const express = require('express');
const {mountIpAppealProxy} = require('../../gateway/src/routes/ipAppealProxy');
const {ensureUuidExtension} = require('./storageSetup');
const {parseMigrationFile}=require('../../../database/migrate');
const {migrationStatements}=require('../../../database/sqlStatements');


test('real user-service entry point starts against isolated PostgreSQL, Redis and Kafka and shuts down', {timeout:90000}, async () => {
  for(const variable of ['TEST_DATABASE_URL','TEST_REDIS_URL','TEST_KAFKA_BROKERS'])assert.ok(process.env[variable],`${variable} is required`);
  // Provision the isolated broker's required topics, as production infrastructure must.
  const kafkaAdmin=new Kafka({clientId:'user-startup-fixture',brokers:process.env.TEST_KAFKA_BROKERS.split(',')}).admin();
  try {
    await kafkaAdmin.connect();
    const existing=new Set(await kafkaAdmin.listTopics());
    const topics=['pokemon.rare_spawn','raid.started','friend.request_created','social.gift_sent',
      'reward.quest_completed','gym.under_attack','gym.lost','title.unlocked'].filter(topic=>!existing.has(topic));
    if(topics.length)await kafkaAdmin.createTopics({waitForLeaders:true,topics:topics.map(topic=>({topic,numPartitions:1,replicationFactor:1}))});
  } finally { await kafkaAdmin.disconnect(); }
  const schema=`user_start_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  await ensureUuidExtension(admin);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  let child;
  let appealGateway, appealProxy;
  let logs='';
  const userId=crypto.randomUUID();
  const auditMaster=crypto.randomBytes(32);
  const mfaMaster=crypto.randomBytes(32);
  const auditNamespace='native-privacy-fixture';
  try{
    const initial=await fs.readFile(path.resolve(__dirname,'../../../database/migrations/V1__initial_schema.sql'),'utf8');
    await fixture.query(initial.match(/CREATE TYPE team_enum[^;]*;/)[0]);
    await fixture.query(initial.match(/CREATE TABLE users \([\s\S]*?\n\);/)[0]);
    await fixture.query(initial.match(/CREATE TABLE audit_logs \([\s\S]*?\n\);/)[0]);
    for(const file of ['20260608_194800__add_sensitive_data_protection_tables.sql','repairs/20260608_200000__add_sensitive_data_audit_tables.sql','20261006_150000__privacy_preference_defaults_and_policy_fields.sql','20260610_000000__add_mfa_system.sql','20261020_120000__mfa_verification_state.sql']){
      const migration=parseMigrationFile(await fs.readFile(path.resolve(__dirname,'../../../database/pending',file),'utf8'));
      for(const statement of migrationStatements(migration.up))await fixture.query(statement);
    }
    const policy=new(require('../../shared/privacyPreferences').PrivacyPolicyService)({query:fixture.query.bind(fixture)});
    await policy.createPolicyVersion('native-v1','2020-01-01',[],'fixture zh','fixture en','fixture ja');
    await fixture.query('INSERT INTO users(id,nickname) VALUES ($1,$2)',[userId,'startup-player']);
    await fixture.query(await fs.readFile(path.resolve(__dirname,'../../../database/pending/20261007_120000__title_identity_compatibility.sql'),'utf8'));
    await fixture.query(await fs.readFile(path.resolve(__dirname,'../../../database/pending/20261008_100000__ip_ban_index_compatibility.sql'),'utf8'));
    for(const file of ['repairs/20260605_200000__add_notification_system_tables.sql','20260607_000000__add_push_notification_preferences.sql','20261008_160000__notification_history_contract.sql','repairs/20260611_020000__add_message_center_indexes.sql']){
      const parsed=parseMigrationFile(await fs.readFile(path.resolve(__dirname,'../../../database/pending',file),'utf8'));
      for(const statement of migrationStatements(parsed.up))await fixture.query(statement);
    }

    const redis=new URL(process.env.TEST_REDIS_URL);
    const database=new URL(process.env.TEST_DATABASE_URL);database.searchParams.set('options',`-c search_path=${schema},public`);
    const runner=`const service=require('./services/user-service/src/index');
      service.start().then(()=>process.send({ready:true,port:service.server.address().port})).catch(()=>{});
      process.on('message',async message=>{if(message==='stop'){try{await service.shutdown();process.send({stopped:true});process.disconnect();}catch(err){process.send({failed:err.message});process.exitCode=1;process.disconnect();}}});`;
    child=spawn(process.execPath,['-e',runner],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,
      EVENT_BUS_CLIENT_ID:'native-user-'+schema,DATABASE_URL:database.toString(),REDIS_HOST:redis.hostname,REDIS_PORT:redis.port||'6379',
      KAFKA_BROKERS:process.env.TEST_KAFKA_BROKERS,PORT:'0',LOG_LEVEL:'error',
      NODE_ENV:'test',AUDIT_MASTER_KEY_ID:'native-fixture',MASTER_ENCRYPTION_KEY:auditMaster.toString('hex'),AUDIT_MASTER_KEYS_JSON:'',AUDIT_KMS_KEY_ID:'',AUDIT_KEY_NAMESPACE:auditNamespace,
      MFA_MASTER_ENCRYPTION_KEY:mfaMaster.toString('hex'),MFA_MASTER_KEY_ID:'native-mfa',MFA_MASTER_KEYS_JSON:'',MFA_KMS_KEY_ID:'',MFA_KEY_NAMESPACE:'native-mfa',
      JWT_ACCESS_SECRET:'user-startup-test-access',JWT_REFRESH_SECRET:'user-startup-test-refresh'
    },stdio:['ignore','pipe','pipe','ipc']});
    child.stdout.on('data',chunk=>{logs=(logs+chunk).slice(-16000);});child.stderr.on('data',chunk=>{logs=(logs+chunk).slice(-16000);});
    const ready=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`User startup timeout: ${logs}`)),60000);
      const exit=code=>{clearTimeout(timer);reject(new Error(`User startup exited ${code}: ${logs}`));};
      child.once('exit',exit);
      child.on('message',message=>{if(message.ready){clearTimeout(timer);child.removeListener('exit',exit);resolve(message);}});
    });
    const base=`http://127.0.0.1:${ready.port}`;
    const health=await fetch(base+'/health');const report=await health.json();
    assert.ok([200,503].includes(health.status));assert.equal(report.checks.database.status,'healthy');
    assert.equal(report.checks.redis.status,'healthy');assert.equal(report.checks.kafka.status,'healthy');
    assert.equal((await fetch(base+'/health/live')).status,200);
    assert.equal((await fetch(base+'/ip-appeal/check')).status,200);
    assert.equal((await fetch(base+'/ip-appeal/status',{headers:{Authorization:'Bearer invalid'}})).status,401);
    assert.equal((await fetch(base+'/gdpr/export')).status,401);
    assert.equal((await fetch(base+'/data-deletion/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    assert.equal((await fetch(base+'/users/titles')).status,200);
    assert.equal((await fetch(base+'/users/titles/leaderboard')).status,200);
    assert.equal((await fetch(base+'/users/me/titles')).status,401);
    // Sign with the same explicit test key used by the child, not the parent's defaults.
    const token=require('jsonwebtoken').sign({sub:userId},'user-startup-test-access');
    const headers={Authorization:`Bearer ${token}`};
    assert.equal((await fetch(base+'/users/me/titles',{headers})).status,200);
    const accept=await fetch(base+'/privacy/policy/accept',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});assert.equal(accept.status,200);
    const change=await fetch(base+'/privacy/preferences',{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({marketing:true})});assert.equal(change.status,200);
    const {EnvironmentKeyProvider}=require('../../shared/audit/KeyProviders');
    const {EncryptedAuditStore}=require('../../shared/audit/EncryptedAuditStore');
    const provider=new EnvironmentKeyProvider({keys:{'native-fixture':auditMaster},activeKeyId:'native-fixture',nodeEnv:'test'});
    const audit=new EncryptedAuditStore({pool:fixture,provider,namespace:auditNamespace,nodeEnv:'test'});
    try{
      const history=await audit.queryDecryptedAuditLogs({userId});
      assert.ok(history.some(row=>row.action==='privacy_policy_accept'&&row.data.actionData.version==='native-v1'));
      assert.ok(history.some(row=>row.action==='privacy_preference_change'&&row.data.actionData.category==='marketing'&&row.data.actionData.collectable===true&&typeof row.data.ipAddress==='string'&&typeof row.data.userAgent==='string'));
      for(const row of(await fixture.query('SELECT details,ip_address,user_agent,encryption_auth_tag FROM audit_logs WHERE user_id=$1',[userId])).rows){assert.equal(row.details,null);assert.equal(row.ip_address,null);assert.equal(row.user_agent,null);assert.equal(row.encryption_auth_tag.length,32);}
    }finally{await audit.close();provider.close();}
    const history=await fetch(base+'/gdpr/audit-logs',{headers});assert.equal(history.status,200);
    const visible=await history.json();assert.ok(visible.length>=2);assert.ok(visible.every(row=>row.encrypted&&row.detailsUnavailable));assert.ok(visible.every(row=>!Object.hasOwn(row,'encrypted_data')&&!Object.hasOwn(row,'details')));
    assert.equal((await fetch(base+'/gdpr/audit-logs?limit=5abc',{headers})).status,400);
    assert.equal((await fetch(base+'/gdpr/audit-logs')).status,401);
    await fixture.query("ALTER TABLE audit_logs ADD CONSTRAINT native_audit_refusal CHECK(action<>'privacy_preference_change') NOT VALID");
    const failed=await fetch(base+'/privacy/preferences',{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({marketing:false})});assert.equal(failed.status,500);
    assert.equal((await fixture.query("SELECT collectable FROM user_privacy_preferences WHERE user_id=$1 AND category='marketing'",[userId])).rows[0].collectable,true);
    assert.ok(!logs.includes(auditMaster.toString('hex')));
    const mfaSetupResponse=await fetch(base+'/users/me/mfa/setup',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});assert.equal(mfaSetupResponse.status,200);const mfaSetup=(await mfaSetupResponse.json()).data;
    const totp=require('speakeasy').totp({secret:mfaSetup.secret,encoding:'base32',time:(await fixture.query('SELECT extract(epoch FROM clock_timestamp())::double precision AS now')).rows[0].now});
    assert.equal((await fetch(base+'/users/me/mfa/enable',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({code:totp})})).status,200);
    assert.equal((await fetch(base+'/auth/mfa/status',{headers})).status,200);
    assert.equal((await fetch(base+'/users/me/mfa/recovery-codes',{headers})).status,403);
    const proofResponse=await fetch(base+'/users/me/mfa/step-up',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({code:mfaSetup.recoveryCodes[0],scope:'mfa-manage'})});assert.equal(proofResponse.status,200);const mfaProof=(await proofResponse.json()).data.mfaToken;
    const recovery=await fetch(base+'/users/me/mfa/recovery-codes',{headers:{...headers,'x-mfa-token':mfaProof}});assert.equal(recovery.status,200);assert.equal((await recovery.json()).data.remaining,7);assert.ok(!logs.includes(mfaMaster.toString('hex')));assert.ok(!logs.includes(mfaSetup.secret));
    const readerToken=require('jsonwebtoken').sign({sub:userId,roles:['admin'],permissions:['audit:decrypt']},'user-startup-test-access');
    const readerHeaders={Authorization:'Bearer '+readerToken,'x-audit-reason':'native audit review','x-request-id':'native-audit-context'};
    const readerProofResponse=await fetch(base+'/users/me/mfa/step-up',{method:'POST',headers:{...readerHeaders,'Content-Type':'application/json'},body:JSON.stringify({code:mfaSetup.recoveryCodes[1],scope:'audit-read'})});assert.equal(readerProofResponse.status,200);readerHeaders['x-mfa-token']=(await readerProofResponse.json()).data.mfaToken;
    const target=(await fixture.query("SELECT id::text FROM audit_logs WHERE action='privacy_policy_accept' LIMIT 1")).rows[0].id;
    assert.equal((await fetch(base+'/admin/audit-logs/'+target+'/decrypt',{headers})).status,403);
    const readAudit=await fetch(base+'/admin/audit-logs/'+target+'/decrypt',{headers:readerHeaders});assert.equal(readAudit.status,200);assert.equal(readAudit.headers.get('cache-control'),'no-store');assert.equal((await readAudit.json()).data.data.actionData.version,'native-v1');
    assert.equal((await fixture.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='admin_audit_decrypt'")).rows[0].n,1);
    const receipt=(await fixture.query("SELECT id::text FROM audit_logs WHERE action='admin_audit_decrypt' LIMIT 1")).rows[0].id;
    const receiptRead=await fetch(base+'/admin/audit-logs/'+receipt+'/decrypt',{headers:readerHeaders});assert.equal(receiptRead.status,200);assert.equal((await receiptRead.json()).data.data.requestId,'native-audit-context');
    await fixture.query("INSERT INTO ip_blacklist(ip_address,reason,severity) VALUES('127.0.0.0/8','startup appeal test','critical')");
    const gatewayApp=express();gatewayApp.use(express.json());appealProxy=mountIpAppealProxy(gatewayApp,base);
    appealGateway=http.createServer(gatewayApp);await new Promise(resolve=>appealGateway.listen(0,'127.0.0.1',resolve));
    const appealBase=`http://127.0.0.1:${appealGateway.address().port}`;
    const appeal=await fetch(appealBase+'/api/v1/users/ip-appeal',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({appealReason:'Please review this startup fixture ban.'})});
    assert.equal(appeal.status,200);
    const appealBody=await appeal.json();
    const ownStatus=await fetch(appealBase+'/api/ip-appeal/status',{headers});assert.equal(ownStatus.status,200);
    assert.equal((await ownStatus.json()).appeal.id,appealBody.appealId);
    assert.equal((await fixture.query('SELECT user_id FROM ip_ban_appeals WHERE id=$1',[appealBody.appealId])).rows[0].user_id,userId);

    const durations=[];
    for(let i=0;i<50;i++){const start=performance.now();const response=await fetch(base+'/users/me/titles',{headers});await response.json();assert.equal(response.status,200);durations.push(performance.now()-start);}
    durations.sort((a,b)=>a-b);
    console.log(JSON.stringify({titleHttpLatencyMs:{samples:durations.length,median:durations[25],p95:durations[47],maximum:durations[49]},scope:'isolated local service and database, warm sequential HTTP reads'}));
    assert.ok(durations[47]<50,'Local warm p95 title-query target must stay below 50ms');
    const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Service did not terminate after shutdown')),15000);child.once('exit',(code,signal)=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(`Shutdown failed ${code}/${signal}: ${logs}`));});});
    const shutdownStart=performance.now();child.send('stop');await closed;child=null;
    console.log(JSON.stringify({shutdownElapsedMs:performance.now()-shutdownStart}));
    await assert.rejects(fetch(base+'/health/live'));
  }finally{
    appealProxy?.close();if(appealGateway)await new Promise(resolve=>appealGateway.close(resolve));
    if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;}
    auditMaster.fill(0);mfaMaster.fill(0);
    await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});
