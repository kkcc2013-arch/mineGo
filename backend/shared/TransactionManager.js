'use strict';
const {createLogger}=require('./logger');
const metrics=require('./transactionMetrics');
const logger=createLogger('transaction-manager');
const {randomUUID}=require('node:crypto');
const ISOLATION_LEVELS=Object.freeze({'READ COMMITTED':'READ COMMITTED','REPEATABLE READ':'REPEATABLE READ','SERIALIZABLE':'SERIALIZABLE'});
const {ERROR_CODES,isDeadlockError,parseDeadlockDetail,logDeadlock}=require('./pgDeadlock');
const {splitStatements}=require('../../database/sqlStatements');
const DEFAULT_CONFIG={defaultIsolationLevel:'READ COMMITTED',defaultTimeout:30000,defaultMaxRetries:3,retryDelayBase:100,maxRetryDelay:2000,cleanupTimeout:1000};
const activeByService=new Map();const managers=new WeakMap();
const isTimeoutError=e=>!!e&&(e.code==='57014'||/timeout/i.test(typeof e.message==='string'?e.message:''));
function integer(value,min,max,label){if(!Number.isInteger(value)||value<min||value>max)throw new TypeError('Invalid '+label);return value;}
function calculateRetryDelay(count,base=100,max=2000,random=Math.random){integer(count,0,10,'retry count');integer(base,0,60000,'retry base');integer(max,0,60000,'retry maximum');const draw=random();if(!Number.isFinite(draw)||draw<0||draw>1)throw new TypeError('Invalid random sample');return Math.min(max,base*2**count*(0.75+draw*0.5));}
function leadingSQL(text){
  let i=0;
  while(i<text.length){
    if(/\s/.test(text[i])){i++;continue;}
    if(text.startsWith('--',i)){const end=text.indexOf('\n',i+2);i=end<0?text.length:end+1;continue;}
    if(text.startsWith('/*',i)){let depth=1;i+=2;while(i<text.length&&depth){if(text.startsWith('/*',i)){depth++;i+=2;}else if(text.startsWith('*/',i)){depth--;i+=2;}else i++;}continue;}
    break;
  }
  return text.slice(i);
}
function rejectTransactionControl(args){
  const text=typeof args[0]==='string'?args[0]:args[0]?.text;
  if(typeof text!=='string')throw new TypeError('Managed queries require SQL text');
  const statements=text.includes(';')?splitStatements(text):[text];
  for(const statement of statements){const start=leadingSQL(statement);if(/^(?:BEGIN|COMMIT|END|ABORT|START\s+TRANSACTION|PREPARE\s+TRANSACTION|SET\s+TRANSACTION)\b/i.test(start)||/^ROLLBACK\b/i.test(start)&&!/^ROLLBACK\s+(?:(?:WORK|TRANSACTION)\s+)?TO\b/i.test(start))throw new Error('Transaction control is owned by the manager');}
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function timeoutError(ms){const e=new Error(`Transaction timeout after ${ms}ms`);e.code='57014';return e;}
function record(fn){try{fn();}catch{logger.error({event:'transaction_metric_failure'},'Transaction instrumentation failed');}}
class TransactionManager{
  constructor(pool,config={}){
    if(!pool||typeof pool.connect!=='function'||typeof pool.query!=='function')throw new TypeError('A transaction pool is required');
    this.pool=pool;this.config={...DEFAULT_CONFIG,...config};this.service=process.env.SERVICE_NAME||'default';this.activeTransactions=new Map();
    this._options({});integer(this.config.retryDelayBase,0,60000,'retry base');integer(this.config.maxRetryDelay,0,60000,'retry maximum');integer(this.config.cleanupTimeout,1,60000,'cleanup timeout');
  }
  _options(options){
    const result={isolationLevel:options.isolationLevel??this.config.defaultIsolationLevel,timeout:options.timeout??this.config.defaultTimeout,maxRetries:options.maxRetries??this.config.defaultMaxRetries,retryOnDeadlock:options.retryOnDeadlock??true,transactionName:options.transactionName??'unknown',enableMetrics:options.enableMetrics??true,retryDelay:options.retryDelay??this.config.retryDelayBase};
    if(typeof result.isolationLevel!=='string'||!Object.hasOwn(ISOLATION_LEVELS,result.isolationLevel))throw new TypeError('Invalid isolation level');
    integer(result.timeout,1,600000,'transaction timeout');integer(result.maxRetries,0,10,'retry count');integer(result.retryDelay,0,60000,'retry base');
    if(typeof result.retryOnDeadlock!=='boolean'||typeof result.enableMetrics!=='boolean'||typeof result.transactionName!=='string'||result.transactionName.length>255)throw new TypeError('Invalid transaction options');return result;
  }
  async execute(fn,options={}){
    if(typeof fn!=='function')throw new TypeError('Transaction callback must be a function');
    const o=this._options(options),started=performance.now(),deadline=started+o.timeout,labels={service:this.service,isolation_level:o.isolationLevel};
    if(o.enableMetrics)record(()=>metrics.started.inc(labels));
    try{for(let retry=0;;retry++){
      try{
        const result=await this._executeWithTimeout(fn,{...o,retryIndex:retry},deadline);
        if(o.enableMetrics)record(()=>{metrics.total.inc({...labels,status:'success'});metrics.completed.inc(labels);});return result;
      }catch(thrown){
        const error=thrown instanceof Error?thrown:new Error('Transaction callback failed',{cause:thrown});
        if(o.enableMetrics)record(()=>metrics.failed.inc({...labels,error_type:error.commitOutcomeUnknown?'unknown_commit':error.code==='40P01'?'deadlock':error.code==='40001'?'serialization':isTimeoutError(error)?'timeout':'other'}));
        const contention=isDeadlockError(error),willRetry=contention&&o.retryOnDeadlock&&retry<o.maxRetries&&performance.now()<deadline;
        if(contention)await this._logDeadlockEvent(error,o.transactionName,retry+(willRetry?1:0),{isolationLevel:o.isolationLevel,willRetry},deadline);
        if(willRetry){
          logger.warn({event:'transaction_retry',code:error.code,retry:retry+1,name:o.transactionName},'Retrying aborted database transaction');
          await sleep(Math.min(calculateRetryDelay(retry,o.retryDelay,this.config.maxRetryDelay),Math.max(0,deadline-performance.now())));continue;
        }
        const status=error.commitOutcomeUnknown?'unknown_commit':isTimeoutError(error)?'timeout':contention&&retry===o.maxRetries?'max_retries_exceeded':'rollback';
        if(o.enableMetrics)record(()=>metrics.total.inc({...labels,status}));throw error;
      }
    }}finally{if(o.enableMetrics)record(()=>metrics.duration.observe(labels,(performance.now()-started)/1000));}
  }
  async _executeWithTimeout(fn,o,deadline){
    let client,timer,onClientError,onClientEnd;
    let closed=false,aborted=false,timedOut=false,controlInFlight=0,commitStarted=false,begun=false,destroy=false;
    const queries=new Set(),id='minego-tx-'+randomUUID(),startTime=Date.now();
    const labels={service:this.service,isolation_level:o.isolationLevel};
    let expired;
    const expiry=()=>expired||(expired=timeoutError(o.timeout));
    const remaining=()=>Math.max(0,deadline-performance.now());
    const ensureActive=()=>{if(aborted||remaining()<=0)throw expiry();};
    ensureActive();

    // One operation races one abort signal. Every continuation checks ownership
    // before starting more work, including a checkout that completes after expiry.
    let rejectAbort;
    const abortSignal=new Promise((_,reject)=>{rejectAbort=reject;});
    const abort=error=>{aborted=true;closed=true;rejectAbort(error);};
    timer=setTimeout(()=>{timedOut=true;abort(expiry());},remaining());
    const control=async text=>{controlInFlight++;try{return await client.query(text);}finally{controlInFlight--;}};
    const activate=delta=>{
      activeByService.set(this.service,(activeByService.get(this.service)||0)+delta);
      if(o.enableMetrics)record(()=>metrics.active.set({service:this.service},activeByService.get(this.service)));
    };
    const operation=(async()=>{
      const candidate=await this.pool.connect();
      if(aborted||remaining()<=0){candidate.release();throw expiry();}
      client=candidate;
      onClientError=error=>{destroy=true;abort(error);};
      onClientEnd=()=>client.removeListener('error',onClientError);
      if(typeof client.on==='function'){client.on('error',onClientError);client.once('end',onClientEnd);}
      this.activeTransactions.set(id,{name:o.transactionName,isolationLevel:o.isolationLevel,startTime});
      activate(1);
      if(o.enableMetrics)record(()=>{
        metrics.attempts.inc(labels);
        if(o.retryIndex>0){metrics.retries.inc(labels);metrics.legacyRetries.inc(labels);}
      });
      ensureActive();
      begun=true;
      await control(`BEGIN ISOLATION LEVEL ${o.isolationLevel}; SET LOCAL statement_timeout='${Math.max(1,Math.floor(remaining()))}ms'; SET LOCAL application_name='${id}'`);
      ensureActive();
      const managed={processID:client.processID,query:(...args)=>{
        if(closed||remaining()<=0){const rejected=Promise.reject(expiry());rejected.catch(()=>{});return rejected;}
        if(args.some(a=>typeof a==='function'))throw new TypeError('Managed queries must use promises');
        rejectTransactionControl(args);
        const promise=client.query(...args);
        queries.add(promise);
        promise.then(()=>queries.delete(promise),()=>queries.delete(promise));
        return promise;
      }};
      const result=await fn(managed);
      closed=true;
      if(queries.size)await Promise.all([...queries]);
      ensureActive();
      commitStarted=true;
      const committed=await control('COMMIT');
      if(committed.command!=='COMMIT'){
        const error=new Error('Transaction was aborted instead of committed');
        error.code='25P02';throw error;
      }
      begun=false;
      return result;
    })();
    // A callback or queued query may finish after an abort; observe its rejection.
    operation.catch(()=>{});
    try{
      return await Promise.race([operation,abortSignal]);
    }catch(error){
      aborted=true;closed=true;
      if(commitStarted && error && !['40P01','40001','25P02'].includes(error.code) && (error===expired || error.severity!=='ERROR')){
        error.commitOutcomeUnknown=true;destroy=true;
      }
      if(timedOut&&(controlInFlight>0||queries.size>0)){
        destroy=true;if(commitStarted)error.commitOutcomeUnknown=true;
      }else if(client&&begun){
        let cleanupTimer;
        try{
          await Promise.race([control('ROLLBACK'),new Promise((_,reject)=>{
            cleanupTimer=setTimeout(()=>reject(new Error('Rollback cleanup timeout')),this.config.cleanupTimeout);
          })]);
        }catch{destroy=true;}finally{clearTimeout(cleanupTimer);}
      }
      throw error;
    }finally{
      closed=true;clearTimeout(timer);
      if(client){
        this.activeTransactions.delete(id);activate(-1);
        if(!destroy&&typeof client.removeListener==='function'){
          client.removeListener('error',onClientError);client.removeListener('end',onClientEnd);
        }
        client.release(destroy);
        if(destroy&&timedOut){
          let cancelTimer;
          try{
            await Promise.race([
              this.pool.query('SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND application_name=$2 AND usename=current_user AND datname=current_database()',[client.processID,id]),
              new Promise((_,reject)=>{cancelTimer=setTimeout(()=>reject(new Error('Owned cancellation timeout')),this.config.cleanupTimeout);})
            ]);
          }catch{logger.error({event:'owned_transaction_cancel_failed'},'Could not confirm owned transaction cancellation');}
          finally{clearTimeout(cancelTimer);}
        }
      }
    }
  }
  async _logDeadlockEvent(error,name,retry,context,deadline){
    const options=this._options({timeout:Math.max(1,Math.min(this.config.cleanupTimeout,Math.floor(deadline-performance.now()))),transactionName:'deadlock_audit',enableMetrics:false,maxRetries:0,retryOnDeadlock:false});
    try{const detail=parseDeadlockDetail(error);await this._executeWithTimeout(c=>logDeadlock(c,{code:error.code,message:error.message,detail:error.detail,processes:detail?.processes??[]},{...context,transactionName:name,retryCount:retry}),options,Math.min(deadline,performance.now()+options.timeout));}
    catch{logger.error({event:'deadlock_log_failure',code:error.code},'Could not persist transaction contention evidence');}
  }

  getActiveTransactions(){return [...this.activeTransactions].map(([id,tx])=>({id,...tx,duration:Date.now()-tx.startTime}));}
  getActiveTransactionCount(){return this.activeTransactions.size;}
}
function getManager(pool){let manager=managers.get(pool);if(!manager){manager=new TransactionManager(pool);managers.set(pool,manager);}return manager;}
module.exports={TransactionManager,getManager,ISOLATION_LEVELS,ERROR_CODES,isDeadlockError,isTimeoutError,parseDeadlockDetail,calculateRetryDelay};
