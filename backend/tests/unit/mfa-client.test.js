'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');

test('actual browser API client preserves MFA boundaries and identity across asynchronous responses',async t=>{
 const names=['window','localStorage','fetch'];const original=Object.fromEntries(names.map(key=>[key,global[key]]));
 const entries=new Map();const storage={getItem:key=>entries.get(key)||null,setItem:(key,value)=>entries.set(key,String(value)),removeItem:key=>entries.delete(key)};
 global.window=new EventTarget();window.PMG_CONFIG={apiBase:'http://fixture.invalid/v1'};global.localStorage=storage;
 const source=await fs.readFile(path.resolve(__dirname,'../../../frontend/game-client/src/api/client.js'),'utf8');const {api}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 const challenge={code:0,data:{mfaRequired:true,tempToken:'A'.repeat(43),expiresAt:new Date(Date.now()+300000).toISOString()}};
 try{
  await t.test('primary challenge stays only in memory and never installs missing tokens',async()=>{
   global.fetch=async()=>response(challenge);const result=await api.login('13900000000','123456');assert.equal(result.mfaRequired,true);assert.equal(api.mfaPending,true);assert.equal(api.hasSession,false);assert.deepEqual([...entries],[]);assert.ok(!JSON.stringify(result).includes('A'.repeat(43)));
  });
  await t.test('failed factors are sent once without automatic refresh or one-time retry',async()=>{
   const calls=[];global.fetch=async(url,opts)=>{calls.push([url,opts]);return response({error:'MFA_INVALID_FACTOR'},401);};
   await assert.rejects(api.completeMfaLogin('123456'),error=>error.code==='MFA_INVALID_FACTOR');assert.equal(calls.length,1);assert.match(calls[0][0],/auth\/mfa\/verify$/);assert.equal(calls[0][1].cache,'no-store');assert.equal(calls[0][1].headers.has('Authorization'),false);assert.equal(api.hasSession,false);assert.equal(api.mfaPending,true);
  });
  await t.test('concurrent completion shares one real request and accepts the MFA success envelope',async()=>{
   let release,calls=0;global.fetch=async()=>{calls++;await new Promise(resolve=>{release=resolve;});return response({success:true,data:{accessToken:'fixture-access',refreshToken:'fixture-refresh'}});};
   const first=api.completeMfaLogin('ABCD-1234',true),second=api.completeMfaLogin('ABCD-1234',true);assert.equal(first,second);release();await first;assert.equal(calls,1);assert.equal(api.mfaPending,false);assert.equal(entries.get('pmg_access_token'),'fixture-access');
  });
  await t.test('queued or malformed login envelopes cannot enter an authenticated state',async()=>{
   global.fetch=async()=>response({code:0,data:{queued:true}});await assert.rejects(api.login('13900000000','123456'),error=>error.code==='AUTH_RESPONSE_INVALID');assert.equal(api.hasSession,false);assert.deepEqual([...entries],[]);
  });
  await t.test('late primary responses cannot restore a cancelled login',async()=>{
   let release;global.fetch=async()=>{await new Promise(resolve=>{release=resolve;});return response(challenge);};const pending=api.login('13900000000','123456');api.cancelMfaLogin();release();await assert.rejects(pending,error=>error.code==='AUTH_CANCELLED');assert.equal(api.mfaPending,false);assert.equal(api.hasSession,false);
  });
  await t.test('refresh keeps both new tokens and cannot overwrite a later identity',async()=>{
   api.setTokens('old-access','old-refresh');global.fetch=async()=>response({code:0,data:{accessToken:'new-access',refreshToken:'new-refresh'}});await api.refreshAccessToken();assert.equal(entries.get('pmg_refresh_token'),'new-refresh');
   let release;global.fetch=async url=>{if(url.endsWith('/refresh')){await new Promise(resolve=>{release=resolve;});return response({code:0,data:{accessToken:'stale-access',refreshToken:'stale-refresh'}});}return response({code:0,data:{accessToken:'other-access',refreshToken:'other-refresh'}});};
   const oldRefresh=api.refreshAccessToken();await api.login('13900000000','123456');release();await assert.rejects(oldRefresh,error=>error.code==='AUTH_CANCELLED');assert.equal(entries.get('pmg_access_token'),'other-access');assert.equal(entries.get('pmg_refresh_token'),'other-refresh');
  });
  await t.test('private results from an ended session cannot surface in a later account',async()=>{
   let release;global.fetch=async()=>{await new Promise(resolve=>{release=resolve;});return response({code:0,data:{nickname:'old-account'}});};const pending=api.getMe();api.clearTokens();release();await assert.rejects(pending,error=>error.code==='AUTH_CANCELLED');
  });
  await t.test('session cancellation while a response body is decoding withholds private results',async()=>{
   api.setTokens('body-access','body-refresh');let release,started;const decoding=new Promise(resolve=>{started=resolve;});global.fetch=async()=>({status:200,ok:true,json:async()=>{started();await new Promise(resolve=>{release=resolve;});return{code:0,data:{nickname:'old-body-account'}};}});const pending=api.getMe();await decoding;api.clearTokens();release();await assert.rejects(pending,error=>error.code==='AUTH_CANCELLED');
  });
  await t.test('payment order intents reuse the same header and body key and never automatically refresh or replay',async()=>{
   api.setTokens('payment-access','payment-refresh');const key=crypto.randomUUID(),calls=[];global.fetch=async(url,opts)=>{calls.push([url,opts]);return response({code:0,data:{orderId:'owned-order'}},201);};await api.createOrder('coins_60','WECHAT',key);assert.equal(calls[0][1].headers.get('X-Idempotency-Key'),key);assert.equal(JSON.parse(calls[0][1].body).idempotencyKey,key);
   global.fetch=async(url,opts)=>{calls.push([url,opts]);return response({code:1002,message:'expired'},401);};await assert.rejects(api.createOrder('coins_60','WECHAT',key));assert.equal(calls.length,2);assert.ok(calls.every(([url])=>url.endsWith('/payment/orders')));
  });
  await t.test('failed storage cannot leave a half-installed token pair',()=>{
   global.localStorage={...storage,setItem:(key,value)=>{if(key==='pmg_refresh_token')throw new Error('owned quota fixture');storage.setItem(key,value);}};
   try{assert.throws(()=>api.setTokens('half-access','half-refresh'),error=>error.code==='AUTH_STORAGE_UNAVAILABLE');assert.deepEqual([...entries],[]);assert.equal(api.hasSession,false);}finally{global.localStorage=storage;}
  });
 }finally{api.clearTokens({notify:false});for(const [key,value]of Object.entries(original)){if(value===undefined)delete global[key];else global[key]=value;}}
});
