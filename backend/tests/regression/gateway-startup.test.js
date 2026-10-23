'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {Pool} = require('pg');
const {Kafka} = require('kafkajs');
const WebSocket=require('ws');
const http = require('node:http');
const {performance} = require('node:perf_hooks');
const {ensureUuidExtension} = require('./storageSetup');
const {parseMigrationFile}=require('../../../database/migrate');
const {migrationStatements}=require('../../../database/sqlStatements');


const root=path.resolve(__dirname,'../..');
const migration=name=>fs.readFile(path.resolve(root,'../database',name),'utf8');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function deadline(promise,ms,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message())),ms);})]);}finally{clearTimeout(timer);}}
async function freePort(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function launch(entry,env){
  const child=spawn(process.execPath,[entry],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let output='';const log=chunk=>{output=(output+chunk).slice(-24000);};child.stdout.on('data',log);child.stderr.on('data',log);
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  return {child,exited,logs:()=>output};
}
async function waitForHttp(process,base){
  for(let attempt=0;attempt<200;attempt++){
    if(process.child.exitCode!==null||process.child.signalCode)throw new Error(`Process exited before listening: ${process.logs()}`);
    try{const response=await fetch(base+'/health/live',{signal:AbortSignal.timeout(500)});if(response.status===200)return;}catch{}
    await delay(100);
  }
  throw new Error(`Process startup timeout: ${process.logs()}`);
}
async function terminate(process,signal='SIGTERM'){
  if(!process||process.child.exitCode!==null||process.child.signalCode)return;
  process.child.kill(signal);
  const result=await deadline(process.exited,15000,()=>`Process failed to terminate: ${process.logs()}`);
  assert.deepEqual(result,{code:0,signal:null});
}
async function cleanupProcess(process){
  if(process&&process.child.exitCode===null&&!process.child.signalCode){process.child.kill('SIGKILL');await process.exited;}
}

test('native gateway and user processes enforce IP appeals, report dependencies and terminate on signals', {timeout:120000}, async()=>{
  for(const name of ['TEST_DATABASE_URL','TEST_REDIS_URL','TEST_KAFKA_BROKERS'])assert.ok(process.env[name],`${name} is required`);
  const kafka=new Kafka({clientId:'gateway-startup-fixture',brokers:process.env.TEST_KAFKA_BROKERS.split(',')}).admin();
  try{
    await kafka.connect();const existing=new Set(await kafka.listTopics());
    const names=['pokemon.rare_spawn','raid.started','friend.request_created','social.gift_sent','reward.quest_completed','gym.under_attack','gym.lost','title.unlocked'];
    const topics=names.filter(name=>!existing.has(name)).map(topic=>({topic,numPartitions:1,replicationFactor:1}));
    if(topics.length)await kafka.createTopics({waitForLeaders:true,topics});
  }finally{await kafka.disconnect();}
  const schema=`gateway_start_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await ensureUuidExtension(admin);await admin.query(`CREATE SCHEMA ${schema}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  let user,gateway,gatewaySecond,failed;
  let notificationSocket,notificationProducer;
  const player=crypto.randomUUID();const adminId=crypto.randomUUID();
  const accessKey='gateway-startup-access-only';
  const auditMaster=crypto.randomBytes(32),mfaMaster=crypto.randomBytes(32);
  try{
    const initial=await migration('migrations/V1__initial_schema.sql');
    await fixture.query('CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');
    await fixture.query(initial);
    await fixture.query(await migration('seeds/V2__seed_data.sql'));
    await fixture.query('INSERT INTO users(id,nickname) VALUES ($1,$2),($3,$4)',[player,'gateway-player',adminId,'gateway-admin']);
    await fixture.query(await migration('pending/20261007_120000__title_identity_compatibility.sql'));
    // Full authentic V1/V2 storage, canonical partitions and durable CDC.
    for(const file of ['20260608_194800__add_sensitive_data_protection_tables.sql','repairs/20260608_200000__add_sensitive_data_audit_tables.sql','20260610_000000__add_mfa_system.sql','20261020_120000__mfa_verification_state.sql','20261008_140000__audit_partition_conversion.sql','repairs/20260610_100000__add_table_partitioning_system.sql','repairs/20260619_000000__add_table_partitioning.sql','repairs/20260707_060000__complete_partition_management.sql','20261008_130000__item_catalog_prerequisite.sql','repairs/20260609_124500__add_item_inventory_system.sql','repairs/20260707_100000__cdc_triggers_for_cache_invalidation.sql']){
      const parsed=parseMigrationFile(await migration('pending/'+file));
      for(const statement of migrationStatements(parsed.up))await fixture.query(statement);
    }

    const database=new URL(process.env.TEST_DATABASE_URL);database.searchParams.set('options',`-c search_path=${schema},public`);
    const redis=new URL(process.env.TEST_REDIS_URL);
    const env={EVENT_BUS_CLIENT_ID:'native-gateway-user-'+schema,DATABASE_URL:database.toString(),REDIS_HOST:redis.hostname,REDIS_PORT:redis.port||'6379',
      KAFKA_BROKERS:process.env.TEST_KAFKA_BROKERS,LOG_LEVEL:'error',JWT_ACCESS_SECRET:accessKey,JWT_REFRESH_SECRET:'gateway-startup-refresh-only'};
    // A missing access-control migration must stop the actual CLI before listening,
    // release its subscription/storage handles, and naturally exit with failure.
    const failedPort=await freePort();failed=launch('gateway/src/index.js',{...env,PORT:String(failedPort)});
    const startupFailure=await deadline(failed.exited,15000,()=>`Failed startup leaked resources: ${failed.logs()}`);
    assert.deepEqual(startupFailure,{code:1,signal:null});
    assert.match(failed.logs(),/ip_blacklist/);
    await assert.rejects(fetch(`http://127.0.0.1:${failedPort}/health/live`));
    failed=null;
    await fixture.query(await migration('pending/20261008_100000__ip_ban_index_compatibility.sql'));
    for(const file of ['repairs/20260605_200000__add_notification_system_tables.sql','20260607_000000__add_push_notification_preferences.sql','20261008_160000__notification_history_contract.sql','repairs/20260611_020000__add_message_center_indexes.sql']){
      const parsed=parseMigrationFile(await fs.readFile(path.resolve(__dirname,'../../../database/pending',file),'utf8'));
      for(const statement of migrationStatements(parsed.up))await fixture.query(statement);
    }

    const userPort=await freePort();const userBase=`http://127.0.0.1:${userPort}`;
    user=launch('services/user-service/src/index.js',{...env,PORT:String(userPort),USER_SERVICE_TRUST_PROXY:'loopback',MASTER_ENCRYPTION_KEY:auditMaster.toString('hex'),AUDIT_MASTER_KEY_ID:'gateway-user-audit',AUDIT_MASTER_KEYS_JSON:'',AUDIT_KMS_KEY_ID:'',AUDIT_KEY_NAMESPACE:'gateway-user-audit',MFA_MASTER_ENCRYPTION_KEY:mfaMaster.toString('hex'),MFA_MASTER_KEY_ID:'gateway-user-mfa',MFA_MASTER_KEYS_JSON:'',MFA_KMS_KEY_ID:'',MFA_KEY_NAMESPACE:'gateway-user-mfa'});
    await waitForHttp(user,userBase);
    const gatewayPort=await freePort();const base=`http://127.0.0.1:${gatewayPort}`;
    gateway=launch('gateway/src/index.js',{...env,PORT:String(gatewayPort),USER_SERVICE_URL:userBase,
      LOCATION_SERVICE_URL:userBase,POKEMON_SERVICE_URL:userBase,CATCH_SERVICE_URL:userBase,GYM_SERVICE_URL:userBase,
      SOCIAL_SERVICE_URL:userBase,REWARD_SERVICE_URL:userBase,PAYMENT_SERVICE_URL:userBase});
    await waitForHttp(gateway,base);
    // All targets intentionally share this actual healthy user process. This
    // proves registry/readiness plumbing, not acceptance of the other services.
    const ready=await fetch(base+'/health/ready');assert.equal(ready.status,200);
    const report=await ready.json();assert.equal(report.status,'ready');
    for(const check of ['database','redis','ipAccessControl','user'])assert.equal(report.checks[check].status,'healthy');
    assert.deepEqual(report.services.map(service=>service.name),['user','location','pokemon','catch','gym','social','reward','payment']);
    assert.ok(report.services.every(service=>service.status==='up'));
    assert.equal((await fetch(base+'/metrics')).status,200);
    const token=require('jsonwebtoken').sign({sub:player},accessKey);
    const adminToken=require('jsonwebtoken').sign({sub:adminId,roles:['admin']},accessKey);
    const headers={Authorization:`Bearer ${token}`};
    assert.equal((await fetch(base+'/api/partitions/overview')).status,401);
    assert.equal((await fetch(base+'/api/partitions/overview',{headers})).status,403);
    const partitionHeaders={Authorization:`Bearer ${adminToken}`};
    const partitions=await fetch(base+'/api/partitions/overview',{headers:partitionHeaders});assert.equal(partitions.status,200);
    const partitionReport=(await partitions.json()).data;assert.equal(Object.keys(partitionReport).length,5);
    for(const table of Object.values(partitionReport)){assert.equal(table.health.missingRanges,0);assert.equal(table.totalRows,'0');}
    assert.equal((await fetch(base+'/api/partitions/audit_logs/create',{method:'POST',headers:{...partitionHeaders,'Content-Type':'application/json'},body:'{"months":3}'})).status,200);
    assert.equal((await fetch(base+'/api/partitions/audit_logs/create',{method:'POST',headers:partitionHeaders})).status,200);
    const partitionMetrics=await (await fetch(base+'/metrics')).text();assert.match(partitionMetrics,/minego_partition_management_duration_seconds_count/);

    for(const path of ['/api/v1/auth/mfa/status','/api/v2/auth/mfa/status','/api/auth/mfa/status','/v1/auth/mfa/status','/api/v1/users/me/mfa','/api/v2/users/me/mfa','/api/users/me/mfa','/v1/users/me/mfa']){const response=await fetch(base+path,{headers});assert.equal(response.status,200,path);assert.equal((await response.json()).data.enabled,false);}
    const enroll=await fetch(base+'/api/v1/users/me/mfa/setup',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});assert.equal(enroll.status,200);const mfaSetup=(await enroll.json()).data;assert.equal(enroll.headers.get('cache-control'),'no-store');
    const totp=require('speakeasy').totp({secret:mfaSetup.secret,encoding:'base32',time:(await fixture.query('SELECT extract(epoch FROM clock_timestamp())::double precision AS now')).rows[0].now});
    assert.equal((await fetch(base+'/api/v1/users/me/mfa/enable',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({code:totp})})).status,200);
    assert.equal((await fetch(base+'/api/v1/users/me/mfa/recovery-codes',{headers})).status,403);
    const verified=await fetch(base+'/api/v1/users/me/mfa/step-up',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({code:mfaSetup.recoveryCodes[0],scope:'mfa-manage'})});assert.equal(verified.status,200);const proof=(await verified.json()).data.mfaToken;
    assert.equal((await fetch(base+'/api/v1/users/me/mfa/recovery-codes',{headers:{...headers,'x-mfa-token':proof}})).status,200);assert.ok(!user.logs().includes(mfaMaster.toString('hex')));assert.ok(!user.logs().includes(mfaSetup.secret));
    const preflight=await fetch(base+'/api/admin/audit-logs',{method:'OPTIONS',headers:{Origin:'https://admin.example.invalid','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization,x-mfa-token,x-audit-reason'}});assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers'),/X-MFA-Token/);assert.match(preflight.headers.get('access-control-allow-headers'),/X-Audit-Reason/);
    const readerToken=require('jsonwebtoken').sign({sub:player,roles:['admin'],permissions:['audit:decrypt']},accessKey);
    const readerHeaders={Authorization:'Bearer '+readerToken,'x-audit-reason':'native gateway audit review'};
    const proofResponse=await fetch(base+'/api/v1/users/me/mfa/step-up',{method:'POST',headers:{...readerHeaders,'Content-Type':'application/json'},body:JSON.stringify({code:mfaSetup.recoveryCodes[1],scope:'audit-read'})});assert.equal(proofResponse.status,200);readerHeaders['x-mfa-token']=(await proofResponse.json()).data.mfaToken;
    const target=(await fixture.query("SELECT id::text FROM audit_logs WHERE action='mfa_setup' LIMIT 1")).rows[0].id;
    for(const prefix of ['/api','/api/v1','/api/v2','/v1']){
      assert.equal((await fetch(base+prefix+'/admin/audit-logs/'+target+'/decrypt',{headers})).status,403);
      const response=await fetch(base+prefix+'/admin/audit-logs/'+target+'/decrypt',{headers:readerHeaders});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).data.action,'mfa_setup');
      assert.equal((await fetch(base+prefix+'/admin/sensitive-access-logs?user_id='+player,{headers:readerHeaders})).status,200);
    }
    assert.ok(!user.logs().includes(mfaSetup.secret));assert.ok(!gateway.logs().includes(mfaSetup.secret));
    // Start a second actual OS gateway process against the same durable journal
    // and Redis namespace; each has its own listener, worker and L1 Map.
    const secondPort=await freePort();const secondBase=`http://127.0.0.1:${secondPort}`;
    gatewaySecond=launch('gateway/src/index.js',{...env,PORT:String(secondPort),USER_SERVICE_URL:userBase});
    await waitForHttp(gatewaySecond,secondBase);
    const control='/api/admin/cache-invalidation';
    assert.equal((await fetch(base+control+'/rules')).status,401);
    assert.equal((await fetch(base+control+'/rules',{headers})).status,403);
    const rules=await fetch(base+control+'/rules',{headers:partitionHeaders});assert.equal(rules.status,200);
    const rulesBody=(await rules.json()).data;assert.equal(Object.keys(rulesBody.effective.defaults).length,18);
    const configResponse=await fetch(base+control+'/rules',{method:'POST',headers:{...partitionHeaders,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:rulesBody.revision,document:{version:1,customRules:{users:['query:native:*user:{id}']}}})});
    assert.equal(configResponse.status,200);
    const invalidConfig=await fetch(base+control+'/rules',{method:'POST',headers:{...partitionHeaders,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:(await configResponse.json()).data.revision,document:{version:1,customRules:{users:['*']}}})});
    assert.equal(invalidConfig.status,400);
    for(const [body,status]of [['{',400],['{\"oversized\":\"'+'x'.repeat(65536)+'\"}',413]])assert.equal((await fetch(base+control+'/rules',{method:'POST',headers:{...partitionHeaders,'Content-Type':'application/json'},body})).status,status);
    const profilePath=`/v1/users/${player}/profile`;
    const readProfile=async(origin,auth=headers,path=profilePath)=>{const response=await fetch(origin+path,{headers:auth});const text=await response.text();if(response.status!==200)await delay(200);assert.equal(response.status,200,text+' ORIGIN '+origin+' GATEWAY '+gateway.logs().slice(-4000)+' SECOND '+(gatewaySecond?gatewaySecond.logs().slice(-10000):'absent'));return {cache:response.headers.get('X-Cache'),body:JSON.parse(text)};};
    const expectHit=async origin=>{
      for(let i=0;i<100;i++){const response=await readProfile(origin);if(response.cache==='HIT')return response;await delay(5);}
      throw new Error(`Actual streaming proxy never populated cache: ${gateway.logs()}`);
    };
    assert.equal((await readProfile(base)).body.data.nickname,'gateway-player');
    assert.equal((await expectHit(base)).body.data.nickname,'gateway-player');
    assert.equal((await expectHit(secondBase)).body.data.nickname,'gateway-player');
    const otherProfile=await readProfile(base,headers,`/v1/users/${adminId}/profile`);
    assert.equal(otherProfile.body.data.id,adminId);assert.equal(otherProfile.body.data.nickname,'gateway-admin');
    assert.equal(otherProfile.body.data.coins,undefined);
    assert.equal((await readProfile(base,partitionHeaders)).cache,'MISS','Different verified viewers cannot share private cache keys');
    const commitStarted=performance.now();await fixture.query("UPDATE users SET nickname='gateway-player-updated' WHERE id=$1",[player]);
    let coherent=false;
    for(let i=0;i<100;i++){
      const first=await readProfile(base);const second=await readProfile(secondBase);
      if(first.body.data.nickname==='gateway-player-updated'&&second.body.data.nickname==='gateway-player-updated'){coherent=true;break;}
      await delay(5);
    }
    assert.ok(coherent,'Committed source update must clear both native gateway caches');
    console.log(JSON.stringify({nativeTwoGatewayCacheRecoveryMs:performance.now()-commitStarted,scope:'real user-service HTTP bytes, two independent OS gateways, PostgreSQL CDC, Redis and independent L1 caches; functional fixture, not capacity acceptance'}));
    // Public profiles join Pokemon counts: a direct instance INSERT must also
    // invalidate a profile viewed by somebody other than its owner.
    await readProfile(base,partitionHeaders);await expectHit(base);
    const countPokemon=crypto.randomUUID();await fixture.query('INSERT INTO pokemon_instances(id,user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) VALUES($1,$2,1,10,10,10,1,1,1)',[countPokemon,player]);
    let countUpdated=false;
    for(let i=0;i<100;i++){if((await readProfile(base,partitionHeaders)).body.data.pokemon_count===1){countUpdated=true;break;}await delay(5);}
    assert.ok(countUpdated,'Joined Pokemon count must invalidate public-profile views');
    assert.equal((await fetch(base+`/v1/users/${adminId}/stats`,{headers})).status,403);
    const ownStats=await fetch(base+`/v1/users/${player}/stats`,{headers});const statsBody=await ownStats.text();assert.equal(ownStats.status,200,statsBody+' '+gateway.logs().slice(-4000));assert.equal(JSON.parse(statsBody).data.id,player);
    assert.equal((await fetch(base+control+'/metrics',{headers:partitionHeaders})).status,200);
    const cdcMetrics=await (await fetch(base+'/metrics')).text();assert.match(cdcMetrics,/minego_cdc_events_applied_total/);assert.match(cdcMetrics,/minego_cdc_apply_duration_seconds/);
    await terminate(gatewaySecond);gatewaySecond=null;

    assert.equal((await fetch(base+'/admin/cache/warmup/status')).status,401);
    assert.equal((await fetch(base+'/admin/cache/warmup/status',{headers})).status,403);
    const warmup=await fetch(base+'/admin/cache/warmup/status',{headers:{Authorization:`Bearer ${adminToken}`}});assert.equal(warmup.status,200);
    // This fixture contains authentic V1/V2, user/title/IP, partition and CDC tables. Other missing game data
    // must remain visible as warmup failures, never be reported as acceptance.
    const status=await warmup.json();assert.ok(status.data.failedCount>0||status.data.isWarming);

    // Exercise all eight message-center operations on the actual entry point.
    const created=(await fixture.query("INSERT INTO notification_history(user_id,type,data,title,body) VALUES($1,'SYSTEM','{}','native message','native body') RETURNING id",[player])).rows[0].id;
    const list=await fetch(base+'/api/notifications',{headers});assert.equal(list.status,200);assert.equal((await list.json()).data.notifications[0].id,created);
    assert.equal((await fetch(base+'/api/notifications/unread-count',{headers})).status,200);
    assert.equal((await fetch(base+'/api/notifications/stats',{headers})).status,200);
    assert.equal((await fetch(base+'/api/notifications/preferences',{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({notificationTypes:{rare_spawn:true}})})).status,200);
    assert.equal((await fetch(base+`/api/notifications/${created}/read`,{method:'PATCH',headers})).status,200);
    assert.equal((await fetch(base+'/api/notifications/batch-read',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"all":true}'})).status,200);
    const deleted=(await fixture.query("INSERT INTO notification_history(user_id,type,data) VALUES($1,'SYSTEM','{}') RETURNING id",[player])).rows[0].id;
    assert.equal((await fetch(base+`/api/notifications/${deleted}`,{method:'DELETE',headers})).status,200);
    assert.equal((await fetch(base+'/api/notifications/clear-read',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,200);
    notificationSocket=new WebSocket(base.replace('http','ws')+`/ws/notifications?token=${token}`);
    await deadline(new Promise((resolve,reject)=>{notificationSocket.once('open',resolve);notificationSocket.once('error',reject);}),5000,()=>`Native notification upgrade failed: ${gateway.logs()} ${user.logs()}`);
    const received=deadline(new Promise(resolve=>notificationSocket.once('message',data=>resolve(JSON.parse(data)))),10000,()=>`Real Kafka notification did not arrive: ${user.logs()}`);
    notificationProducer=new Kafka({clientId:'native-notification-producer-'+schema,brokers:process.env.TEST_KAFKA_BROKERS.split(',')}).producer();await notificationProducer.connect();
    const eventId=crypto.randomUUID();const event={id:eventId,data:{speciesId:4,speciesName:'native Charmander',lat:0,lng:121,rarity:4,nearbyUsers:[player],distances:{[player]:120}}};
    await notificationProducer.send({topic:'pokemon.rare_spawn',messages:[{key:player,value:JSON.stringify(event)}]});
    const frame=await received;assert.equal(frame.type,'NOTIFICATION');assert.equal(frame.payload.eventType,'RARE_SPAWN');assert.equal(frame.payload.recipientId,player);
    assert.equal((await fixture.query('SELECT count(*)::int AS n FROM notification_history WHERE user_id=$1 AND source_event_id=$2',[player,eventId])).rows[0].n,1);
    await notificationProducer.send({topic:'pokemon.rare_spawn',messages:[{key:player,value:JSON.stringify(event)}]});
    await fetch(base+'/api/notifications/preferences',{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({notificationTypes:{gym_lost:true}})});
    for(const [topic,type,data] of [
      ['raid.started','RAID_STARTED',{raidId:'fixture-raid',gymId:'fixture-gym',bossName:'Boss',gymName:'Gym',nearbyUsers:[player]}],
      ['friend.request_created','FRIEND_REQUEST',{toUserId:player,fromUserId:adminId,fromUserName:'Fixture friend'}],
      ['social.gift_sent','GIFT_RECEIVED',{toUserId:player,fromUserId:adminId,fromUserName:'Fixture friend',giftId:'gift'}],
      ['reward.quest_completed','QUEST_COMPLETE',{userId:player,questId:'quest',questName:'Fixture quest',rewards:{coins:1}}],
      ['gym.under_attack','GYM_UNDER_ATTACK',{gymId:'gym',gymName:'Gym',attackerTeam:'MYSTIC',defenderUserIds:[player]}],
      ['gym.lost','GYM_LOST',{gymId:'gym',gymName:'Gym',newTeam:'MYSTIC',previousDefenderUserIds:[player]}]
    ]){
      const incoming=deadline(new Promise(resolve=>{const listen=buffer=>{const message=JSON.parse(buffer);if(message.payload?.eventType===type){notificationSocket.removeListener('message',listen);resolve(message);}};notificationSocket.on('message',listen);}),10000,()=>`Native ${type} did not arrive: ${user.logs()}`);
      await notificationProducer.send({topic,messages:[{key:player,value:JSON.stringify({id:crypto.randomUUID(),data})}]});assert.equal((await incoming).payload.eventType,type);
    }
    await notificationProducer.disconnect();notificationProducer=null;
    await fixture.query("INSERT INTO ip_blacklist(ip_address,reason,severity) VALUES('127.0.0.0/8','native gateway test','critical')");
    assert.equal((await fetch(base+'/v1/users/me',{headers:{...headers,'X-Forwarded-For':'198.51.100.7'}})).status,403);
    // Routes formerly mounted before access control must also be blocked.
    assert.equal((await fetch(base+'/api/v1/autoscaling/status')).status,403);
    assert.equal((await fetch(base+'/api/ip-appeal/check',{headers:{'X-Forwarded-For':'198.51.100.7','X-Real-IP':'198.51.100.8'}})).status,200);
    assert.equal((await fetch(base+'/users/ip-appeal/status',{headers:{Authorization:'Bearer invalid'}})).status,401);
    const appeal=await fetch(base+'/api/v1/users/ip-appeal',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-Forwarded-For':'198.51.100.7'},body:JSON.stringify({appealReason:'Review the actual gateway IP fixture ban.'})});
    assert.equal(appeal.status,200);const appealBody=await appeal.json();
    const own=await fetch(base+'/api/v2/ip-appeal/status',{headers});assert.equal(own.status,200);assert.equal((await own.json()).appeal.id,appealBody.appealId);
    const stored=await fixture.query('SELECT host(ip_address) AS ip,user_id FROM ip_ban_appeals WHERE id=$1',[appealBody.appealId]);
    assert.equal(stored.rows[0].ip,'127.0.0.1');assert.equal(stored.rows[0].user_id,player);
    assert.equal((await fetch(base+'/health/live')).status,200);
    await fixture.query('ALTER TABLE ip_blacklist RENAME TO ip_blacklist_outage_fixture');
    try{
      const unavailable=await fetch(base+'/health/ready');assert.equal(unavailable.status,503);
      assert.equal((await unavailable.json()).checks.ipAccessControl.status,'unhealthy');
      assert.equal((await fetch(base+'/v1/users/me',{headers})).status,503);
      assert.equal((await fetch(base+'/health/live')).status,200);
    }finally{await fixture.query('ALTER TABLE ip_blacklist_outage_fixture RENAME TO ip_blacklist');}
    // Loss of the real downstream marks readiness unavailable with preserved
    // names; liveness stays reachable during a dependency outage.
    const socketClosed=deadline(new Promise(resolve=>notificationSocket.once('close',resolve)),15000,()=>`Notification upgrade leaked during shutdown`);
    const userShutdownStart=performance.now();await terminate(user,'SIGINT');user=null;await socketClosed;notificationSocket=null;
    const degraded=await fetch(base+'/health/ready');assert.equal(degraded.status,503);
    const degradedBody=await degraded.json();assert.equal(degradedBody.status,'not_ready');
    assert.equal(degradedBody.services.find(service=>service.name==='user').status,'down');
    assert.equal((await fetch(base+'/health/live')).status,200);
    const gatewayShutdownStart=performance.now();await terminate(gateway);const shutdownMs=performance.now()-gatewayShutdownStart;
    assert.doesNotMatch(gateway.logs(),/Unhandled error event/);gateway=null;
    await assert.rejects(fetch(base+'/health/live'));
    // URL configuration also works when conflicting host/port variables exist.
    // Both business-event reads and the cache must use the configured endpoint.
    const urlPort=await freePort();const urlBase=`http://127.0.0.1:${urlPort}`;
    gateway=launch('gateway/src/index.js',{...env,PORT:String(urlPort),REDIS_URL:process.env.TEST_REDIS_URL,REDIS_HOST:'127.0.0.1',REDIS_PORT:'1'});
    await waitForHttp(gateway,urlBase);
    const urlReport=await (await fetch(urlBase+'/health/ready')).json();
    assert.equal(urlReport.checks.redis.status,'healthy');assert.equal(urlReport.checks.database.status,'healthy');
    assert.equal(urlReport.status,'not_ready');
    let limited=false;
    for(let attempt=0;attempt<201;attempt++){
      const response=await fetch(urlBase+'/health/live',{headers:{'X-Forwarded-For':`198.51.100.${attempt%250+1}`}});
      if(response.status===429){limited=true;break;}
      assert.equal(response.status,200);
    }
    assert.ok(limited,'Forging a different forwarding header must not bypass the global IP limit');
    await terminate(gateway);assert.doesNotMatch(gateway.logs(),/Unhandled error event|Redis cache error/);gateway=null;
    console.log(JSON.stringify({gatewaySignalShutdownMs:shutdownMs,userSignalShutdownElapsedMs:gatewayShutdownStart-userShutdownStart,
      scope:'actual native gateway/user processes, isolated PostgreSQL V1/V2/user/title/IP/partition/CDC schema, Redis and Kafka; other registry targets alias the actual user fixture'}));
  }finally{
    if(notificationSocket)notificationSocket.terminate();if(notificationProducer)await notificationProducer.disconnect();
    await Promise.all([cleanupProcess(user),cleanupProcess(gateway),cleanupProcess(gatewaySecond),cleanupProcess(failed)]);
    auditMaster.fill(0);mfaMaster.fill(0);
    await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});
