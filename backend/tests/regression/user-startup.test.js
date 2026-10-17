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
  try{
    const initial=await fs.readFile(path.resolve(__dirname,'../../../database/migrations/V1__initial_schema.sql'),'utf8');
    await fixture.query(initial.match(/CREATE TYPE team_enum[^;]*;/)[0]);
    await fixture.query(initial.match(/CREATE TABLE users \([\s\S]*?\n\);/)[0]);
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
    await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});
