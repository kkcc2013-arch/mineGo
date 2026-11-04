'use strict';

const cron=require('node-cron');
const logger=require('../shared/logger');
const {getErasureTaskRunner}=require('../shared/erasure/ErasureTaskRunner');
const {AppError}=require('../shared/auth');

class ErasureProcessor {
  constructor({runner=getErasureTaskRunner(),batchSize=10,ownsStore=false}={}) {
    if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>50)throw new TypeError('Invalid erasure batch size');
    this.runner=runner;this.batchSize=batchSize;this.ownsStore=ownsStore;this.jobs=[];this.active=new Set();this.closed=false;this.busy=false;
  }
  async runDue({retryOnly=false}={}) {
    if(typeof retryOnly!=='boolean')throw new TypeError('Invalid erasure retry selection');
    if(this.closed)throw new AppError('ERASURE_WORKER_CLOSED','ERASURE_WORKER_CLOSED',503);
    if(this.busy)return {overlap:true};
    this.busy=true;
    const operation=(async()=>{
      const rows=(await this.runner.store.database.query(`SELECT r.id FROM data_erasure_requests r
        WHERE r.status IN('approved','processing') AND r.execute_after<=clock_timestamp()
        AND (($2::boolean AND r.status='processing' AND EXISTS(SELECT 1 FROM data_erasure_tasks t
          WHERE t.request_id=r.id AND t.status='failed' AND t.retry_count<LEAST(t.max_retries,r.max_retries)))
          OR (NOT $2::boolean AND NOT EXISTS(SELECT 1 FROM data_erasure_tasks t WHERE t.request_id=r.id AND t.status='failed')
            AND (NOT EXISTS(SELECT 1 FROM data_erasure_tasks t WHERE t.request_id=r.id)
              OR EXISTS(SELECT 1 FROM data_erasure_tasks t WHERE t.request_id=r.id AND t.status='pending'))))
        ORDER BY r.execute_after,r.id LIMIT $1`,[this.batchSize,retryOnly])).rows;
      const result={selected:rows.length,tasksCompletedObserved:0,completionBlocked:0,failed:0,requestsCompleted:0};
      for(const row of rows) {
        if(this.closed)break;
        try {const progress=await this.runner.executeRequest(row.id);result.tasksCompletedObserved+=progress.tasks.filter(t=>t.status==='completed').length;result.completionBlocked++;}
        catch(error){result.failed++;logger.warn('Erasure request requires retry or review',{requestId:row.id,code:error instanceof AppError?error.code:'ERASURE_WORKER_FAILED'});}
      }
      return result;
    })();
    this.active.add(operation);
    try{return await operation;}finally{this.active.delete(operation);this.busy=false;}
  }
  async start() {
    if(this.closed)throw new AppError('ERASURE_WORKER_CLOSED','ERASURE_WORKER_CLOSED',503);
    if(this.jobs.length)return;
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      await this.runner.ready();
      if(this.closed)throw new AppError('ERASURE_WORKER_CLOSED','ERASURE_WORKER_CLOSED',503);
      for(const [name,expression,retryOnly] of [['erasure-due','0 * * * *',false],['erasure-retry','0 */6 * * *',true]]) {
        const tick=()=>this.runDue({retryOnly}).catch(error=>logger.error('Erasure worker tick failed',{code:error instanceof AppError?error.code:'ERASURE_WORKER_FAILED'}));
        this.jobs.push(cron.schedule(expression,tick,{name,noOverlap:true,timezone:'UTC'}));
      }
    })();
    try{return await this.starting;}finally{this.starting=null;}
  }
  async stop() {
    if(this.stopping)return this.stopping;
    this.closed=true;
    this.stopping=(async()=>{
      const destroyed=await Promise.allSettled(this.jobs.splice(0).map(async job=>job.destroy()));
      await Promise.allSettled([...this.active,...(this.starting?[this.starting]:[])]);
      if(this.ownsStore)await this.runner.store.close();
      const failures=destroyed.filter(r=>r.status==='rejected').map(r=>r.reason);
      if(failures.length)throw new AggregateError(failures,'Erasure schedules did not all stop');
    })();
    return this.stopping;
  }
}
let processor;
function init(database) {
  if(processor)throw new Error('Erasure processor is already initialized');
  if(database){const {ErasureRequestStore}=require('../shared/erasure/ErasureRequestStore'),{ErasureTaskRunner}=require('../shared/erasure/ErasureTaskRunner');processor=new ErasureProcessor({runner:new ErasureTaskRunner({store:new ErasureRequestStore({database})}),ownsStore:true});}
  else processor=new ErasureProcessor();
  return processor;
}
const instance=()=>processor||init();
const start=()=>instance().start();
const processScheduledDeletions=()=>instance().runDue();
const retryFailedTasks=()=>instance().runDue({retryOnly:true});
async function stop(){if(processor){const current=processor;processor=null;await current.stop();}require('../shared/erasure/ErasureTaskRunner').resetErasureTaskRunner();}
module.exports={ErasureProcessor,init,start,stop,processScheduledDeletions,retryFailedTasks};
