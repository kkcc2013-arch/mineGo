'use strict';
const crypto=require('node:crypto');const {performance}=require('node:perf_hooks');const {Counter,Gauge,Histogram}=require('prom-client');
const PgCDCListener=require('./PgCDCListener');const ChangeToCacheMapper=require('./ChangeToCacheMapper');
const {createLogger}=require('../logger');const logger=createLogger('cache-invalidation-center');
class CacheInvalidationCenter {
  constructor(config={}){
    this.config=config;this.pool=config.pool||null;this.cache=config.cache?.instance||config.cache||require('../cache').instance;
    this.mapper=new ChangeToCacheMapper();this.listener=null;this.requested=false;this.draining=null;this.wake=null;this.poll=null;this.revision=null;this.degraded=true;this.again=false;this.ownsCache=false;this.cacheEpoch=null;
    this.stats={eventsApplied:0,failedAttempts:0,deletedKeys:0,batches:0};this.samples=[];
    const registry=config.registry||require('../metrics').register;
    const metric=(Type,name,help,labels=[])=>registry.getSingleMetric(name)||new Type({name,help,labelNames:labels,registers:[registry]});
    this.applied=metric(Counter,'minego_cdc_events_applied_total','Confirmed durable events applied',['table']);
    this.failures=metric(Counter,'minego_cdc_apply_failures_total','Failed durable invalidation attempts',['phase']);
    this.duration=metric(Histogram,'minego_cdc_apply_duration_seconds','Actual worker processing time, not database commit latency');
    this.pending=metric(Gauge,'minego_cdc_pending_events','Actual pending durable invalidation events');
    this.ready=metric(Gauge,'minego_cdc_ready','CDC listener/cache/backlog recovery readiness');
  }
  async start(){
    if(this.requested)return;
    this.requested=true;this.pool=this.pool||require('../db').getPool();
    try{
      const identity=(await this.pool.query('SELECT current_database() AS database,current_schema() AS schema')).rows[0];
      const schema=identity.schema;
      this.schema=schema;const namespace=this.config.namespace??process.env.CACHE_NAMESPACE??'mg2:'+crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,32)+':';
      if(this.cache.client&&(this.cache.namespace!==namespace||!this.cache.requireConsistency))throw new Error('Cache must use the canonical consistency namespace');
      this.ownsCache=!this.cache.client;await this.cache.init({...this.config.redis,namespace,requireConsistency:true});this.cache.setConsistencyReady(false);
      await this.pool.query("INSERT INTO cache_invalidation_settings(singleton,document) VALUES(TRUE,$1) ON CONFLICT(singleton) DO NOTHING",[{version:1,customRules:{}}]);
      this.listener=new PgCDCListener({pool:this.pool,...this.config.cdc});
      this.listener.on('change',()=>this.schedule());this.listener.on('rules',()=>this.schedule());
      this.listener.on('disconnect',()=>{this.degraded=true;this.cache.setConsistencyReady(false);this.ready.set(0);});
      this.listener.on('connected',()=>this.schedule());
      await this.listener.start();await this.drain();this.pollAgain();
    }catch(error){await this.stop();throw error;}
  }
  schedule(){if(!this.requested)return;if(this.draining){this.again=true;return;}if(this.wake)return;this.wake=setTimeout(()=>{this.wake=null;this.drain().catch(()=>{});},this.config.debounceMs??2);}
  pollAgain(){if(!this.requested)return;this.poll=setTimeout(async()=>{this.poll=null;try{await this.drain();}catch{}finally{this.pollAgain();}},this.config.pollMs??500);}
  failed(error,phase){this.degraded=true;this.cache.setConsistencyReady(false);this.ready.set(0);this.failures.inc({phase});logger.warn({code:error.code||'CDC_APPLY_FAILED',phase},'Cache invalidation requires recovery');}
  async drain(){
    if(this.draining){this.again=true;return this.draining;}
    if(!this.requested)return;
    clearTimeout(this.wake);this.wake=null;this.again=false;
    this.draining=(async()=>{
      for(let batch=0;batch<20&&this.requested;batch++){this.again=false;const count=await this.processBatch();if(count<50&&!this.again)break;}
      const result=await this.pool.query('SELECT count(*)::text AS count FROM cache_invalidation_outbox');const count=Number(result.rows[0].count);this.pending.set(count);
      if(this.requested&&count===0&&this.listener?.isListening&&this.cache.client?.status==='ready'&&this.cache.subscriptionReady&&this.cacheEpoch===this.cache.connectionEpoch){this.degraded=false;this.cache.setConsistencyReady(true);this.ready.set(1);}else if(this.degraded||!this.cache.client||this.cache.client.status!=='ready'||!this.cache.subscriptionReady||this.cacheEpoch!==this.cache.connectionEpoch){this.degraded=true;this.cache.setConsistencyReady(false);this.ready.set(0);}
    })().catch(error=>{this.failed(error,'database');throw error;}).finally(()=>{this.draining=null;if(this.requested&&this.again)this.schedule();});return this.draining;
  }
  async processBatch(){
    const client=await this.pool.connect();let events=[];const started=performance.now();
    try{
      await client.query('BEGIN');
      const settings=(await client.query('SELECT document,revision::text AS revision FROM cache_invalidation_settings WHERE singleton=TRUE FOR SHARE')).rows[0];
      if(!settings)throw new Error('Canonical cache settings are missing');
      const mapper=this.revision===settings.revision?this.mapper:new ChangeToCacheMapper(settings.document);
      events=(await client.query('SELECT * FROM cache_invalidation_outbox WHERE available_at<=CURRENT_TIMESTAMP ORDER BY created_at,event_id LIMIT 50 FOR UPDATE SKIP LOCKED')).rows;
      const patterns=new Map();for(const event of events)for(const rule of mapper.map(event))patterns.set(JSON.stringify(rule),rule);
      let deleted=0;
      try{
      if(this.revision!==settings.revision||this.cacheEpoch!==this.cache.connectionEpoch){const epoch=this.cache.connectionEpoch;await this.cache.invalidatePatternStrict('*');this.mapper=mapper;this.revision=settings.revision;this.cacheEpoch=epoch;}
        const rules=[...patterns.values()];
        for(let offset=0;offset<rules.length;offset+=100)deleted+=await this.cache.invalidatePatternsStrict(rules.slice(offset,offset+100));
      }catch(error){
        if(events.length)await client.query("UPDATE cache_invalidation_outbox SET attempts=attempts+1,available_at=clock_timestamp()+LEAST(30000,50*power(2,LEAST(attempts,9))) * INTERVAL '1 millisecond',last_error_code='REDIS_UNAVAILABLE' WHERE event_id=ANY($1::uuid[])",[events.map(e=>e.event_id)]);
        await client.query('COMMIT');this.stats.failedAttempts+=events.length;this.failed(error,'redis');return 0;
      }
      if(events.length)await client.query('DELETE FROM cache_invalidation_outbox WHERE event_id=ANY($1::uuid[])',[events.map(e=>e.event_id)]);
      await client.query('COMMIT');this.mapper=mapper;
      for(const event of events){this.stats.eventsApplied++;this.applied.inc({table:event.table_name});}
      if(events.length){this.stats.batches++;this.stats.deletedKeys+=deleted;const elapsed=performance.now()-started;this.samples.push(elapsed);if(this.samples.length>1000)this.samples.shift();this.duration.observe(elapsed/1000);logger.info({events:events.length,deletedKeys:deleted,durationMs:elapsed},'Cache invalidation batch committed');}
      return events.length;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  }
  async getRules(){const row=(await this.pool.query('SELECT document,revision::text AS revision FROM cache_invalidation_settings WHERE singleton=TRUE')).rows[0];return {...row,effective:new ChangeToCacheMapper(row.document).getMappingRules()};}
  async updateRules(document,expectedRevision){
    const validated=ChangeToCacheMapper.validate(document);if(!/^[1-9][0-9]*$/.test(String(expectedRevision))||BigInt(expectedRevision)>9223372036854775807n||typeof expectedRevision==='number'&&!Number.isSafeInteger(expectedRevision))throw Object.assign(new Error('Expected configuration revision is required'),{status:400});
    const c=await this.pool.connect();let revision;
    try{
      await c.query('BEGIN');const row=(await c.query('UPDATE cache_invalidation_settings SET document=$1,revision=revision+1,updated_at=clock_timestamp() WHERE singleton=TRUE AND revision=$2::bigint RETURNING revision::text AS revision',[validated,String(expectedRevision)])).rows[0];
      if(!row)throw Object.assign(new Error('Cache configuration revision changed'),{status:409});revision=row.revision;
      await c.query('SELECT pg_notify($1,$2)',[this.listener.rulesChannel,revision]);await c.query('COMMIT');
    }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
    await this.drain();if(BigInt(this.revision??0)<BigInt(revision))await this.drain();if(BigInt(this.revision??0)<BigInt(revision))throw Object.assign(new Error('Cache configuration is awaiting recovery'),{status:503});return {revision,document:validated};
  }
  async getStats(){const row=(await this.pool.query('SELECT count(*)::text AS count,COALESCE(max(attempts),0)::int AS max_attempts FROM cache_invalidation_outbox')).rows[0];return {...this.stats,scope:'process',applicationAttemptSuccessRate:this.stats.eventsApplied+this.stats.failedAttempts?this.stats.eventsApplied/(this.stats.eventsApplied+this.stats.failedAttempts):null,pendingEvents:row.count,maxRetryAttempts:row.max_attempts,ready:!this.degraded&&Boolean(this.listener?.isListening)&&this.cache.available(),workerDurationMs:this.samples.length?{max:Math.max(...this.samples),mean:this.samples.reduce((a,b)=>a+b,0)/this.samples.length}:null,cdc:this.listener?.getStats()??null};}
  async healthCheck(){const stats=await this.getStats();return {status:stats.ready?'healthy':'degraded',...stats};}
  async stop(){this.requested=false;clearTimeout(this.wake);clearTimeout(this.poll);this.wake=null;this.poll=null;this.cache.setConsistencyReady(false);this.ready.set(0);await this.listener?.stop();if(this.draining)await this.draining.catch(()=>{});if(this.ownsCache)await this.cache.close();}
}
module.exports=CacheInvalidationCenter;
