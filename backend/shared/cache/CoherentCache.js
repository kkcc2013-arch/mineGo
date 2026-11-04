'use strict';
const Redis=require('ioredis');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {createLogger}=require('../logger');
const metrics=require('../metrics');
const logger=createLogger('coherent-cache');
const FENCE='__minego_cache_fence__:';
const READ=`local token=redis.call('GET',KEYS[2]); if not token then token=ARGV[1];redis.call('SET',KEYS[2],token,'PX',ARGV[2]);end;return {redis.call('GET',KEYS[1]),token}`;
const WRITE=`if ARGV[3]~='' and redis.call('GET',KEYS[2])~=ARGV[3] then return 0 end;if tonumber(ARGV[2])>0 then redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]);else redis.call('SET',KEYS[1],ARGV[1]);end;return 1`;
const INVALIDATE=`local count=0;for i,key in ipairs(KEYS) do redis.call('SET',ARGV[1]..key,ARGV[2],'PX',ARGV[3]);count=count+redis.call('DEL',key);end;redis.call('PUBLISH',ARGV[4],ARGV[5]);return count`;
function globRegex(pattern){
  if(typeof pattern!=='string'||pattern.length>4096)throw new Error('Invalid cache glob');
  let source='',wildcards=0;const literal=c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for(let i=0;i<pattern.length;i++){
    const c=pattern[i];
    if(c==='\\'){if(++i>=pattern.length)throw new Error('Invalid cache glob escape');source+=literal(pattern[i]);}
    else if(c==='*'){if(++wildcards>2)throw new Error('Too many cache glob wildcards');source+='[\\s\\S]*';}else if(c==='?')throw new Error('Use escaped question marks in cache globs');
    else if(c==='['||c===']')throw new Error('Use escaped cache glob brackets');else source+=literal(c);
  }
  return new RegExp('^'+source+'$');
}
// Configuration regexes intentionally use a bounded regular-language subset:
// anchored literals and at most two .* tokens, with escaped literals supported.
function patternMatcher(spec){
  if(typeof spec==='string')return globRegex(spec);
  if(!spec||typeof spec.pattern!=='string'||spec.pattern.length>4096)throw new Error('Invalid cache pattern');
  if(spec.type==='glob')return globRegex(spec.pattern);
  if(spec.type!=='regex'||!spec.pattern.startsWith('^')||!spec.pattern.endsWith('$'))throw new Error('Regex rules must be anchored');
  const body=spec.pattern.slice(1,-1);let wildcards=0;
  for(let i=0;i<body.length;i++){
    if(body[i]==='\\'){if(++i>=body.length||/[A-Za-z0-9]/.test(body[i]))throw new Error('Only escaped regex literals are supported');continue;}
    if(body.slice(i,i+2)==='.*'){wildcards++;i++;continue;}
    if(/[.*+?^${}()|[\]\\]/.test(body[i]))throw new Error('Unsupported cache regex operator');
  }
  if(wildcards>2)throw new Error('Too many cache regex wildcards');return new RegExp(spec.pattern);
}
class CoherentCache {
  constructor({namespace='',requireConsistency=false}={}){
    this.namespace=namespace;this.requireConsistency=requireConsistency;this.consistent=!requireConsistency;
    this.memory=new Map();this.localFences=new Map();this.epoch=0;this.client=null;this.subscriber=null;this.subscriptionReady=false;this.initializing=null;this.pending=new Set();this.connectionEpoch=0;this.storagePrefix='cache2:'+crypto.createHash('sha256').update(namespace).digest('hex').slice(0,32)+':';
    this.stats={hits:{memory:0,redis:0},misses:0,sets:0,deletes:0};this.leaseMs=600000;this.maxMemory=1000;
  }
  init(config={}){
    if(this.initializing)return this.initializing;
    const {namespace=this.namespace,requireConsistency=this.requireConsistency,...redisOptions}=config;
    if(!/^[A-Za-z0-9_:-]{0,80}$/.test(namespace))throw new Error('Invalid cache namespace');
    if(namespace!==this.namespace){this.memory.clear();this.localFences.clear();this.epoch++;}
    this.namespace=namespace;this.storagePrefix='cache2:'+crypto.createHash('sha256').update(namespace).digest('hex').slice(0,32)+':';this.requireConsistency=requireConsistency;this.consistent=!requireConsistency;this.closing=false;
    const options={host:process.env.REDIS_HOST||'localhost',port:Number(process.env.REDIS_PORT||6379),password:process.env.REDIS_PASSWORD,db:Number(process.env.REDIS_CACHE_DB??1),lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:1,commandTimeout:500,connectTimeout:1500,retryStrategy:times=>Math.min(times*50,500),...redisOptions};
    const url=process.env.REDIS_URL;
    this.client=url?new Redis(url,options):new Redis(options);
    this.subscriber=this.client.duplicate();
    this.channel='minego_cache_l1:'+options.db+':'+crypto.createHash('sha256').update(namespace).digest('hex').slice(0,24);
    const unavailable=(error,subscriptionLost=false)=>{this.connectionEpoch++;if(subscriptionLost)this.subscriptionReady=false;this.consistent=!this.requireConsistency;this.memory.clear();this.epoch++;if(!this.closing)logger.warn({code:error?.code||'CACHE_UNAVAILABLE'},'Cache connection unavailable');};
    this.client.on('error',error=>unavailable(error));this.client.on('close',()=>unavailable());this.subscriber.on('error',error=>unavailable(error,true));this.subscriber.on('close',()=>unavailable(undefined,true));
    this.subscriber.on('message',(channel,payload)=>{
      if(channel!==this.channel)return;
      try{const message=JSON.parse(payload);if(!Array.isArray(message.patterns)||message.patterns.length>100)throw Error('Invalid cache message');for(const pattern of message.patterns)this.invalidateLocal(pattern);}catch{logger.warn({code:'INVALID_INVALIDATION_MESSAGE'},'Invalid cache invalidation message');}
    });
    const subscribe=async()=>{this.subscriptionReady=false;this.memory.clear();this.epoch++;await this.subscriber.subscribe(this.channel);this.subscriptionReady=true;};
    let first=true;
    this.subscriber.on('ready',()=>{if(first){first=false;return;}subscribe().catch(unavailable);});
    this.initializing=(async()=>{await this.client.connect();await this.subscriber.connect();await subscribe();return this;})();
    return this.initializing;
  }
  setConsistencyReady(ready){this.consistent=Boolean(ready);if(!ready){this.memory.clear();this.epoch++;}}
  available(){return !this.requireConsistency||(this.consistent&&this.subscriptionReady&&this.client?.status==='ready');}
  cleanup(){const now=Date.now();for(const [key,entry]of this.memory)if(entry.expireAt<=now)this.memory.delete(key);for(const [key,entry]of this.localFences)if(entry.expireAt<=now)this.localFences.delete(key);while(this.memory.size>this.maxMemory)this.memory.delete(this.memory.keys().next().value);}
  remember(key,value,ttl,token){this.cleanup();this.memory.set(key,{value,token,expireAt:Date.now()+Math.min(ttl>0?ttl*1000:60000,60000),size:Buffer.byteLength(JSON.stringify(value))});this.cleanup();}
  observe(operation,layer,started,hit){
    try{
      const service=process.env.SERVICE_NAME||'shared';
      if(operation==='get'){
        if(hit)metrics.recordCacheHit(service,layer);else{metrics.recordCacheMiss(service,layer);metrics.cacheMissesTotal?.inc({layer:layer==='none'?'redis':layer});}
      }
      const elapsed=performance.now()-started;
      metrics.cacheLatency?.observe({operation,layer},elapsed/1000);
      metrics.cacheOperationDuration?.observe({service,cache_name:layer,operation},elapsed);
      metrics.cacheSize?.set({layer:'memory'},[...this.memory.values()].reduce((sum,e)=>sum+e.size,0));
    }catch{logger.warn({code:'CACHE_METRIC_FAILED'},'Cache metric update failed');}
  }
  async readForFill(key){
    const started=performance.now();
    if(typeof key!=='string'||key.length>4096)throw new Error('Invalid cache key');
    if(!this.available()){this.stats.misses++;this.observe('get','none',started,false);return {value:null,hit:false,disabled:true,token:null};}
    this.cleanup();const local=this.memory.get(key);if(local){this.stats.hits.memory++;this.observe('get','memory',started,true);return {value:local.value,hit:true,token:local.token};}
    if(this.client){
      const epoch=this.epoch;
      try{
        const [raw,token]=await this.client.eval(READ,2,this.storagePrefix+key,FENCE+this.storagePrefix+key,crypto.randomUUID(),this.leaseMs);
        if(!this.available()||epoch!==this.epoch)return {value:null,hit:false,disabled:true,token:null};
        if(raw!==null){const value=JSON.parse(raw);this.stats.hits.redis++;this.observe('get','redis',started,true);const remaining=await this.client.pttl(this.storagePrefix+key);if(epoch===this.epoch&&this.available())this.remember(key,value,remaining>0?remaining/1000:60,token);return {value,hit:true,token};}
        this.stats.misses++;this.observe('get','redis',started,false);return {value:null,hit:false,token};
      }catch(error){if(this.requireConsistency)this.setConsistencyReady(false);logger.warn({code:error.code||'CACHE_READ_FAILED'},'Cache read failed');return {value:null,hit:false,disabled:true,token:null};}
    }
    let fence=this.localFences.get(key);if(!fence){fence={token:crypto.randomUUID(),expireAt:Date.now()+this.leaseMs};this.localFences.set(key,fence);}
    this.stats.misses++;this.observe('get','memory',started,false);return {value:null,hit:false,token:fence.token};
  }
  async get(key){return (await this.readForFill(key)).value;}
  async set(key,value,ttl,options={}){
    const started=performance.now();
    if(!Number.isInteger(ttl)||ttl<=0){if(!options.allowNoTTL)throw new Error('Cache key must have a valid TTL');ttl=0;}
    if(!this.available())return false;
    if(this.requireConsistency&&key.startsWith('api:')&&!options.token)return false;
    const epoch=this.epoch,token=options.token||'';
    if(this.client){
      const written=await this.client.eval(WRITE,2,this.storagePrefix+key,FENCE+this.storagePrefix+key,JSON.stringify(value),ttl,token);
      if(!written)return false;
    }else if(token&&this.localFences.get(key)?.token!==token)return false;
    if(epoch===this.epoch&&this.available())this.remember(key,value,ttl,token);
    this.stats.sets++;this.observe('set','both',started);return true;
  }
  async load(key,fetcher,ttl){const entry=await this.readForFill(key);if(entry.hit)return entry.value;const value=await fetcher();if(!entry.disabled)await this.set(key,value,ttl,{token:entry.token});return value;}
  track(promise){this.pending.add(promise);promise.finally(()=>this.pending.delete(promise)).catch(()=>{});return promise;}
  invalidateLocal(pattern){
    const regex=patternMatcher(pattern);this.epoch++;let count=0;
    for(const key of this.memory.keys())if(regex.test(key)){this.memory.delete(key);count++;}
    for(const key of this.localFences.keys())if(regex.test(key))this.localFences.set(key,{token:crypto.randomUUID(),expireAt:Date.now()+this.leaseMs});
    return count;
  }
  async scan(pattern,fn){let cursor='0';do{const result=await this.client.scan(cursor,'MATCH',pattern,'COUNT',100);cursor=result[0];if(result[1].length)await fn(result[1]);}while(cursor!=='0');}
  async invalidatePatternStrict(pattern){return this.invalidatePatternsStrict([pattern]);}
  async invalidatePatternsStrict(patterns){
    const started=performance.now();
    if(!Array.isArray(patterns)||!patterns.length||patterns.length>100)throw new Error('Invalid cache invalidation batch');
    const matchers=patterns.map(patternMatcher),matches=key=>matchers.some(matcher=>matcher.test(key));
    const only=patterns.length===1?patterns[0]:null;
    const scanPattern=only&&(typeof only==='string'||only.type==='glob')?(typeof only==='string'?only:only.pattern):'*';
    if(!this.client||this.client.status!=='ready')throw Object.assign(new Error('Cache connection unavailable'),{code:'CACHE_UNAVAILABLE'});
    const payload=JSON.stringify({patterns});
    let deleted=0;
    const apply=async keys=>{
      for(let offset=0;offset<keys.length;offset+=100){
        const batch=keys.slice(offset,offset+100);
        deleted+=Number(await this.client.eval(INVALIDATE,batch.length,...batch,FENCE,crypto.randomUUID(),this.leaseMs,this.channel,payload));
      }
    };
    // A whole source batch scans the owned data/fill prefixes once, rather than
    // making two complete scans for every overlapping entity rule.
    await this.scan(this.storagePrefix+scanPattern,keys=>apply(keys.filter(key=>matches(key.slice(this.storagePrefix.length)))));
    await this.scan(FENCE+this.storagePrefix+scanPattern,keys=>apply(keys.map(key=>key.slice(FENCE.length)).filter(key=>matches(key.slice(this.storagePrefix.length)))));
    for(const pattern of patterns)this.invalidateLocal(pattern);
    await this.client.publish(this.channel,payload);
    this.stats.deletes+=deleted;this.observe('delete','both',started);return deleted;
  }
  async delPattern(pattern){
    try{if(this.client)return await this.invalidatePatternStrict(pattern);return this.invalidateLocal(pattern);}catch(error){logger.warn({code:error.code||'CACHE_DELETE_FAILED'},'Cache invalidation failed');return 0;}
  }
  async del(key){return this.delPattern(key.replace(/[\\*?\[\]]/g,'\\$&'));}
  async exists(key){return (await this.readForFill(key)).hit;}
  async ttl(key){const entry=this.memory.get(key);if(entry&&entry.expireAt>Date.now())return Math.floor((entry.expireAt-Date.now())/1000);if(this.client)try{return await this.client.ttl(this.storagePrefix+key);}catch{}return -2;}
  getStats(){this.cleanup();const hits=this.stats.hits.memory+this.stats.hits.redis,total=hits+this.stats.misses;return {memory:{size:this.memory.size,bytes:[...this.memory.values()].reduce((n,e)=>n+e.size,0),hits:this.stats.hits.memory},redis:{hits:this.stats.hits.redis},total:{hits,misses:this.stats.misses,sets:this.stats.sets,deletes:this.stats.deletes,hitRate:total?hits/total:0}};}
  resetStats(){this.stats={hits:{memory:0,redis:0},misses:0,sets:0,deletes:0};}
  async flush(){this.memory.clear();return this.delPattern('api:*');}
  async close(){
    this.closing=true;this.setConsistencyReady(false);this.subscriptionReady=false;await Promise.allSettled([...this.pending]);
    const clients=[this.subscriber,this.client].filter(Boolean);await Promise.allSettled(clients.map(async client=>{try{if(client.status==='ready')await client.quit();}finally{client.disconnect();}}));
    this.client=null;this.subscriber=null;this.initializing=null;this.memory.clear();this.localFences.clear();
  }
}
module.exports={CoherentCache,globRegex,patternMatcher};
