'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {Pool} = require('pg');
const {Kafka} = require('kafkajs');
const http = require('node:http');
const {performance} = require('node:perf_hooks');

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
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  let user,gateway,failed;
  const player=crypto.randomUUID();const adminId=crypto.randomUUID();
  const accessKey='gateway-startup-access-only';
  try{
    const initial=await migration('migrations/V1__initial_schema.sql');
    await fixture.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await fixture.query(initial.match(/CREATE TYPE team_enum[^;]*;/)[0]);
    await fixture.query(initial.match(/CREATE TABLE users \([\s\S]*?\n\);/)[0]);
    await fixture.query('INSERT INTO users(id,nickname) VALUES ($1,$2),($3,$4)',[player,'gateway-player',adminId,'gateway-admin']);
    await fixture.query(await migration('pending/20261007_120000__title_identity_compatibility.sql'));
    const database=new URL(process.env.TEST_DATABASE_URL);database.searchParams.set('options',`-c search_path=${schema},public`);
    const redis=new URL(process.env.TEST_REDIS_URL);
    const env={DATABASE_URL:database.toString(),REDIS_HOST:redis.hostname,REDIS_PORT:redis.port||'6379',
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
    const userPort=await freePort();const userBase=`http://127.0.0.1:${userPort}`;
    user=launch('services/user-service/src/index.js',{...env,PORT:String(userPort),USER_SERVICE_TRUST_PROXY:'loopback'});
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
    assert.equal((await fetch(base+'/admin/cache/warmup/status')).status,401);
    assert.equal((await fetch(base+'/admin/cache/warmup/status',{headers})).status,403);
    const warmup=await fetch(base+'/admin/cache/warmup/status',{headers:{Authorization:`Bearer ${adminToken}`}});assert.equal(warmup.status,200);
    // This fixture contains real user/title/IP tables only. Missing game data
    // must remain visible as warmup failures, never be reported as acceptance.
    const status=await warmup.json();assert.ok(status.data.failedCount>0||status.data.isWarming);
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
    const userShutdownStart=performance.now();await terminate(user,'SIGINT');user=null;
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
      scope:'actual native gateway/user processes, isolated PostgreSQL user/title/IP schema, Redis and Kafka; other registry targets alias the actual user fixture'}));
  }finally{
    await Promise.all([cleanupProcess(user),cleanupProcess(gateway),cleanupProcess(failed)]);
    await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});
