'use strict';
// Diagnostic only: real entry-point HTTP observations; failed/bounded shutdown is not acceptance.
const path=require('node:path');const root=path.resolve(__dirname,'../../..');
const {Pool}=require('pg');
const {spawn}=require('node:child_process');const crypto=require('node:crypto');const fs=require('node:fs/promises');
const jwt=require('jsonwebtoken');
if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL must identify isolated PostGIS');
const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
(async()=>{const schema='gym_damage_probe_'+crypto.randomBytes(8).toString('hex');await admin.query('CREATE SCHEMA '+schema);
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema+',public'});let child;let terminal;let logs='';let result;
try{await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));await pool.query(await fs.readFile(path.join(root,'database/seeds/V2__seed_data.sql'),'utf8'));await pool.query(await fs.readFile(path.join(root,'database/pending/20260605_180000__add_moves_and_tm_system.sql'),'utf8'));
const owner=crypto.randomUUID();await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[owner,'native-damage-probe']);
const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+schema+',public');
const observer="const http=require('node:http');const original=http.Server.prototype.listen;let reported=false;http.Server.prototype.listen=function(...args){const s=original.apply(this,args);s.once('listening',()=>{if(!reported){reported=true;process.send({port:s.address().port});}});return s;};require("+JSON.stringify(path.join(root,'backend/services/gym-service/src/index.js'))+");";
child=spawn(process.execPath,['-e',observer],{env:{...process.env,DATABASE_URL:url.toString(),REDIS_URL:'redis://localhost:56379',REDIS_HOST:'localhost',REDIS_PORT:'56379',KAFKA_BROKERS:'localhost:9092',PORT:'0',WS_BATTLE_PORT:'0',LOG_LEVEL:'error',JWT_ACCESS_SECRET:'native-damage-probe-access',JWT_REFRESH_SECRET:'native-damage-probe-refresh',UV_THREADPOOL_SIZE:'2'},stdio:['ignore','pipe','pipe','ipc']});
terminal=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.stdout.on('data',b=>logs=(logs+b).slice(-2000));child.stderr.on('data',b=>logs=(logs+b).slice(-2000));
const port=await Promise.race([new Promise(resolve=>child.once('message',m=>resolve(m.port))),terminal.then(r=>{throw new Error('Entry point exited '+JSON.stringify(r));}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('No listener observation within5s')),5000);t.unref();})]);
const token=jwt.sign({sub:owner},'native-damage-probe-access',{algorithm:'HS256',expiresIn:'5m'});
const response=await fetch('http://127.0.0.1:'+port+'/api/v1/gym/battle/simulate',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({attacker:{species_id:6,attack:150,fast_move:'ember'},defender:{species_id:9,defense:120}}),signal:AbortSignal.timeout(3000)});const data=await response.json();result={nativeHttpStatus:response.status,damageMultiplier:data.damage_multiplier,moveId:data.data?.move?.id};
}catch(e){result={nativeProbe:'failed',reason:e.message,logs:logs.slice(-1200)};}
finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([terminal,new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await terminal;result.forceKilled=true;}}if(terminal)result.terminal=await terminal;await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();console.log(JSON.stringify(result));if(result.nativeHttpStatus!==200||result.forceKilled||result.nativeProbe==='failed')process.exitCode=1;}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
