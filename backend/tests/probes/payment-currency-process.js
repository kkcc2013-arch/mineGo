'use strict';
// Diagnostic: real entry-point observations; bounded or failed shutdown is not acceptance.
const {Pool}=require('pg');const {spawn}=require('node:child_process');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const jwt=require('jsonwebtoken');
const {migrationStatements}=require('../../../database/sqlStatements');
const root=path.resolve(__dirname,'../../..');
if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL must identify isolated PostGIS');
(async()=>{
  const schema='payment_currency_probe_'+crypto.randomBytes(8).toString('hex');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});await admin.query('CREATE SCHEMA '+schema);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1,options:'-c search_path='+schema+',public'});
  let child,terminal,result,logs='';
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    const client=await pool.connect();try{await client.query('BEGIN');for(const sql of migrationStatements(await fs.readFile(path.join(root,'database/pending/repairs/20260624_133000__add_multi_currency_support.sql'),'utf8')))await client.query(sql);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    const owner=crypto.randomUUID();await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[owner,'native-currency-owner']);
    const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+schema+',public');
    const observer="const http=require('node:http');const original=http.Server.prototype.listen;http.Server.prototype.listen=function(...args){const s=original.apply(this,args);s.once('listening',()=>process.send({port:s.address().port}));return s;};require("+JSON.stringify(path.join(root,'backend/services/payment-service/src/index.js'))+");";
    child=spawn(process.execPath,['-e',observer],{env:{...process.env,NODE_ENV:'production',DATABASE_URL:url.toString(),REDIS_URL:'redis://localhost:56379',REDIS_HOST:'localhost',REDIS_PORT:'56379',KAFKA_BROKERS:'localhost:9092',PORT:'0',LOG_LEVEL:'error',JWT_ACCESS_SECRET:'native-currency-access-fixture',JWT_REFRESH_SECRET:'native-currency-refresh-fixture',WECHAT_SECRET:'native-currency-channel-fixture',ALIPAY_SECRET:'native-currency-channel-fixture',APPLE_SHARED_SECRET:'native-currency-channel-fixture',OER_API_KEY:'',FIXER_API_KEY:'',EXCHANGE_RATE_API_KEY:'',UV_THREADPOOL_SIZE:'2'},stdio:['ignore','pipe','pipe','ipc']});
    terminal=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.stdout.on('data',b=>logs=(logs+b).slice(-2000));child.stderr.on('data',b=>logs=(logs+b).slice(-2000));
    const port=await Promise.race([new Promise(resolve=>child.once('message',m=>resolve(m.port))),terminal.then(r=>{throw new Error('Entry point exited '+JSON.stringify(r));}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('No listener within5s observation')),5000);timer.unref();})]);
    const token=jwt.sign({sub:owner},'native-currency-access-fixture',{expiresIn:'5m'});
    const base='http://127.0.0.1:'+port;
    const call=async(route,options={})=>{const response=await fetch(base+route,{...options,signal:AbortSignal.timeout(3000)});return {status:response.status,data:await response.json()};};
    const catalog=await call('/api/v1/currencies'),price=await call('/currency/prices/coins_60?currency=CNY');
    const preference=await call('/api/v1/currencies/preference',{headers:{Authorization:'Bearer '+token}});
    const conversion=await call('/api/v1/currencies/convert',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:'1.005',from:'USD',to:'USD'})});
    result={catalogStatus:catalog.status,currencies:catalog.data.data?.count,priceStatus:price.status,priceExact:price.data.data?.amountExact,preferenceStatus:preference.status,conversionStatus:conversion.status,conversionExact:conversion.data.data?.converted.amountExact};
  }catch(e){result={nativeProbe:'failed',reason:e.message,logs:logs.slice(-1200)};}
  finally{
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([terminal,new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await terminal;result.forceKilled=true;}}
    if(terminal)result.terminal=await terminal;await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
    console.log(JSON.stringify(result));if(result.catalogStatus!==200||result.preferenceStatus!==200||result.conversionStatus!==200||result.currencies!==20||result.forceKilled||result.nativeProbe==='failed')process.exitCode=1;
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
