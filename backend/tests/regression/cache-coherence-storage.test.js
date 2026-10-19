'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {CoherentCache}=require('../../shared/cache/CoherentCache');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await delay(5);}throw new Error('Actual distributed cache deadline exceeded');}

test('actual Redis and independent L1 instances fence fills, broadcast invalidation and preserve unrelated data',async t=>{
  assert.ok(process.env.TEST_REDIS_URL,'owned isolated Redis required');const url=new URL(process.env.TEST_REDIS_URL);
  const namespace='coherence_'+crypto.randomBytes(8).toString('hex')+':';
  const first=new CoherentCache({namespace,requireConsistency:true}),second=new CoherentCache({namespace,requireConsistency:true}),other=new CoherentCache({namespace:namespace+'other:',requireConsistency:true});
  const config={host:url.hostname,port:Number(url.port||6379),db:14};
  try{
    await first.init(config);await second.init(config);await other.init(config);
    first.setConsistencyReady(true);second.setConsistencyReady(true);other.setConsistencyReady(true);
    const owner=crypto.randomUUID(),foreign=crypto.randomUUID();
    const key=`api:profile:/v1/users/${owner}/profile:user:${owner}`,foreignKey=`api:profile:/v1/users/${foreign}/profile:user:${foreign}`;
    const fill=async(cache,k,v)=>{const entry=await cache.readForFill(k);assert.ok(!entry.disabled);return cache.set(k,v,60,{token:entry.token});};
    await t.test('actual Redis-backed values populate independent L1 caches',async()=>{
      assert.equal(await fill(first,key,{revision:'old'}),true);assert.deepEqual(await second.get(key),{revision:'old'});assert.ok(second.memory.has(key));assert.equal(await second.exists(key),true);assert.ok(await second.ttl(key)>0);
      await fill(first,foreignKey,{revision:'unrelated'});await fill(other,key,{revision:'other namespace'});
    });
    await t.test('strict deletion reaches Redis and the other L1 without deleting another owner or namespace',async()=>{
      assert.equal(await first.invalidatePatternStrict(`api:profile:*user:${owner}`),1);await until(()=>!second.memory.has(key));assert.equal(await second.get(key),null);assert.deepEqual(await first.get(foreignKey),{revision:'unrelated'});assert.deepEqual(await other.get(key),{revision:'other namespace'});
    });
    await t.test('an earlier in-flight miss cannot repopulate a key after invalidation',async()=>{
      const stale=await first.readForFill(key);assert.equal(stale.hit,false);
      await second.invalidatePatternStrict(`api:profile:*user:${owner}`);
      assert.equal(await first.set(key,{revision:'stale late response'},60,{token:stale.token}),false);assert.equal(await first.get(key),null);
      const current=await first.readForFill(key);assert.equal(await first.set(key,{revision:'current'},60,{token:current.token}),true);assert.deepEqual(await second.get(key),{revision:'current'});
    });
    await t.test('escaped literal wildcard IDs remain literal and never broaden deletion',async()=>{
      const unusual='api:items:item[ab]*?:literal',near='api:items:itemaXYZ:literal';await fill(first,unusual,{literal:true});await fill(first,near,{retained:true});
      assert.equal(await first.invalidatePatternStrict('api:items:item\\[ab\\]\\*\\?:literal'),1);assert.equal(await first.get(unusual),null);assert.deepEqual(await first.get(near),{retained:true});
    });
    await t.test('invalidation arriving during a genuine Redis read bypasses that fill instead of treating it as a hit',async()=>{
      const raced='api:read-race:value';await fill(first,raced,{retained:true});first.memory.delete(raced);
      const actualEval=first.client.eval;
      let release,readCompleted;
      const held=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{readCompleted=resolve;});
      first.client.eval=async function(...args){const result=await actualEval.apply(this,args);readCompleted();await held;return result;};
      const pending=first.readForFill(raced);const before=first.epoch;
      try{
        await started;await second.invalidatePatternStrict('api:unrelated:*');await until(()=>first.epoch>before);
        release();const entry=await pending;assert.equal(entry.disabled,true);assert.equal(entry.hit,false);assert.equal(entry.value,null);assert.equal(first.memory.has(raced),false);
      }finally{first.client.eval=actualEval;release();await pending;}
      assert.deepEqual(await first.get(raced),{retained:true});
    });
    await t.test('bulk matching iterates real SCAN pages and invalidates all actual keys',async()=>{
      for(let i=0;i<230;i++)await fill(first,'api:bulk:'+i,{i});assert.equal(await first.invalidatePatternStrict('api:bulk:*'),230);
      let remaining=0;await first.scan(first.storagePrefix+'api:bulk:*',keys=>{remaining+=keys.length;});assert.equal(remaining,0);
    });
    await t.test('consistency-unready reads bypass L1 and unversioned API writes are refused',async()=>{
      assert.equal(await first.set(key,{unsafe:true},60),false);first.setConsistencyReady(false);assert.equal(await first.get(foreignKey),null);assert.equal((await first.readForFill(key)).disabled,true);first.setConsistencyReady(true);assert.deepEqual(await first.get(foreignKey),{revision:'unrelated'});
    });
    await t.test('valid cached null, TTL policy, load helper and stats expose actual results',async()=>{
      await assert.rejects(first.set('api:bad-ttl',{},0),/TTL/);
      await fill(first,'api:null',null);assert.equal(await second.exists('api:null'),true);
      assert.equal(await first.load('api:load',async()=>({fresh:true}),60).then(v=>v.fresh),true);
      assert.equal(await first.load('api:load',async()=>{throw Error('cached fetch must not execute');},60).then(v=>v.fresh),true);
      const stats=first.getStats();assert.ok(stats.memory.size>0);assert.equal(stats.total.deletes,232);assert.ok(stats.total.hitRate>=0);first.resetStats();assert.equal(first.getStats().total.sets,0);
    });
    await first.flush();await other.flush();
  }finally{await Promise.allSettled([first.close(),second.close(),other.close()]);}
});
