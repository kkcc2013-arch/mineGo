'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const http=require('node:http');
const express=require('express');
const cache=require('../../shared/cache');
const {cacheMiddleware,defaultKeyGenerator}=require('../../shared/cacheMiddleware');
const {requireAuth,signAccess}=require('../../shared/auth');
const {createProxyMiddleware}=require('../../gateway/src/proxy');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function listening(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;}
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await delay(5);}throw new Error('Real HTTP cache deadline exceeded');}

test('actual streaming proxy and Express JSON responses use fenced, private, bounded HTTP cache fills',async t=>{
  assert.ok(process.env.TEST_REDIS_URL,'owned Redis required');
  const redis=new URL(process.env.TEST_REDIS_URL);
  const namespace='cache_http_'+crypto.randomBytes(8).toString('hex')+':';
  let version=1,requests=0,slowStarted,releaseSlow;
  const started=new Promise(resolve=>{slowStarted=resolve;});
  const release=new Promise(resolve=>{releaseSlow=resolve;});
  const upstream=http.createServer(async(req,res)=>{
    requests++;const url=new URL(req.url,'http://localhost');
    const body={version,path:url.pathname,query:[...url.searchParams],upstreamEncoding:req.headers['accept-encoding']};
    const mode=url.searchParams.get('mode');
    res.statusCode=mode==='error'?500:200;
    res.setHeader('Content-Type','application/json');
    if(mode==='cookie')res.setHeader('Set-Cookie','fixture-private=1');
    if(mode==='no-store')res.setHeader('Cache-Control','private, no-store');
    if(mode==='vary')res.setHeader('Vary','X-Private-Variant');
    if(mode==='slow'){slowStarted();await release;}
    if(mode==='large')body.blob='x'.repeat(1024*1024+1);
    const bytes=JSON.stringify(body);res.write(bytes.slice(0,12));res.end(bytes.slice(12));
  });
  let server,proxy;
  const owner=crypto.randomUUID(),other=crypto.randomUUID();
  const headers={Authorization:'Bearer '+signAccess({sub:owner,id:other}),'Accept-Language':'zh-CN','Accept-Encoding':'gzip'};
  try{
    await cache.init({host:redis.hostname,port:Number(redis.port||6379),db:12,namespace,requireConsistency:true});cache.setConsistencyReady(true);
    const target=await listening(upstream);const app=express();app.use(requireAuth);
    app.get('/local/:id',cacheMiddleware({cacheUserData:true,ttl:60}),(_req,res)=>res.status(201).set('Content-Language','zh-CN').json({local:++requests}));
    proxy=createProxyMiddleware({target,pathRewrite:{'^/fixture/':'/upstream/'}});
    app.get('/fixture/:id',cacheMiddleware({keyPrefix:'api:http:',cacheUserData:true,ttl:60}),proxy);
    server=http.createServer(app);const base=await listening(server);
    const get=async(path,auth=headers)=>{const response=await fetch(base+path,{headers:auth});return {response,body:await response.json()};};
    const path='/fixture/'+owner;
    await t.test('streamed identity JSON populates real Redis and preserves status, body and safe headers',async()=>{
      const first=await get(path);assert.equal(first.response.headers.get('X-Cache'),'MISS');assert.equal(first.body.upstreamEncoding,'identity');
      await until(()=>cache.instance.pending.size===0);
      const second=await get(path);assert.equal(second.response.headers.get('X-Cache'),'HIT');assert.deepEqual(second.body,first.body);assert.equal(requests,1);
      const local=await get('/local/value');assert.equal(local.response.status,201);await until(()=>cache.instance.pending.size===0);
      const localHit=await get('/local/value');assert.equal(localHit.response.status,201);assert.equal(localHit.response.headers.get('Content-Language'),'zh-CN');assert.equal(localHit.response.headers.get('X-Cache'),'HIT');assert.deepEqual(localHit.body,local.body);
    });
    await t.test('verified subject, full target, language and structured query have distinct keys',async()=>{
      for(const [uri,auth]of [[path,{...headers,Authorization:'Bearer '+signAccess({sub:other})}],[path,{...headers,'Accept-Language':'en-US'}],['/fixture/'+other,headers],[path+'?x=a%26y%3Db',headers],[path+'?x=a&y=b',headers],[path+'?x[]=a&x[]=b',headers],[path+'?x=a,b',headers]])assert.equal((await get(uri,auth)).response.headers.get('X-Cache'),'MISS');
      const req={originalUrl:'/fixture/'+owner.toUpperCase(),path:'/ignored',query:{z:{b:2,a:1},q:['a','b']},user:{sub:owner,id:other},headers:{}};
      const key=defaultKeyGenerator(req);assert.ok(key.includes('user:'+owner));assert.ok(!key.includes('user:'+other));assert.equal(key,defaultKeyGenerator({...req,originalUrl:'/fixture/'+owner,query:{q:['a','b'],z:{a:1,b:2}}}));
      assert.notEqual(key,defaultKeyGenerator({...req,query:{z:'[object Object]',q:'a,b'}}));
      assert.ok(!defaultKeyGenerator({...req,query:{private:'fixture-private-value'}}).includes('fixture-private-value'));
    });
    await t.test('late streamed replies cannot repopulate after a completed invalidation',async()=>{
      const pending=get(path+'?mode=slow');await started;
      await cache.invalidatePatternStrict('api:http:*');version=2;releaseSlow();
      assert.equal((await pending).body.version,1);await until(()=>cache.instance.pending.size===0);
      const fresh=await get(path+'?mode=slow');assert.equal(fresh.response.headers.get('X-Cache'),'MISS');assert.equal(fresh.body.version,2);
    });
    await t.test('failed, cookie-setting, no-store, unknown-vary and oversized responses are never cached',async()=>{
      for(const mode of ['error','cookie','no-store','vary','large']){
        const before=requests;await get(path+'?mode='+mode);await until(()=>cache.instance.pending.size===0);
        const again=await get(path+'?mode='+mode);assert.equal(again.response.headers.get('X-Cache'),'MISS',mode);assert.equal(requests,before+2,mode);
      }
      cache.setConsistencyReady(false);assert.equal((await get(path)).response.headers.get('X-Cache'),'BYPASS');
    });
  }finally{
    releaseSlow();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}proxy?.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await cache.close();
  }
});
