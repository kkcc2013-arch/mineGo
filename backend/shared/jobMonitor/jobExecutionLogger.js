'use strict';
// REQ-00669 (legacy REQ-00538): durable execution history on canonical storage.
const {createLogger}=require('../logger');
const logger=createLogger('job-execution-logger');
const STATUSES=new Set(['idle','running','success','failed','timeout']);
const TERMINAL=new Set(['success','failed','timeout']);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const timestamp=value=>{
  if(value===null||value===undefined||value==='')throw fail('A valid timestamp is required');
  const date=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(date.getTime()))throw fail('A valid timestamp is required');
  // Existing columns are TIMESTAMP WITHOUT TIME ZONE. New records use UTC wall
  // time consistently; never reinterpret or rewrite historical rows.
  return date.toISOString().slice(0,-1);
};
function text(value,name,max,optional=false){if(optional&&(value===null||value===undefined))return null;if(typeof value!=='string'||!value.length||value.length>max)throw fail('Invalid '+name);return value;}
function integer(value,name,min=0,max=2147483647){if(!Number.isSafeInteger(value)||value<min||value>max)throw fail('Invalid '+name);return value;}
const fields=`id,job_id,job_name,category,status,start_time AT TIME ZONE 'UTC' AS start_time,end_time AT TIME ZONE 'UTC' AS end_time,duration_ms,error_message,error_stack,metadata,created_at AT TIME ZONE 'UTC' AS created_at`;
class JobExecutionLogger {
  constructor(options={}){
    this.pool=options.pool||null;this.ownsPool=Boolean(options.pool)&&options.ownsPool===true;
    this.retentionDays=integer(options.retentionDays??90,'retention days',90,3650);
    this.isInitialized=false;this.initializing=null;this.closed=false;
  }
  async initialize(){
    if(this.closed)throw fail('Job history logger is closed',503);
    if(this.isInitialized)return;if(this.initializing)return this.initializing;
    this.pool=this.pool||require('../db').getPool();
    this.initializing=(async()=>{await this.pool.query('SELECT '+fields+' FROM job_execution_logs LIMIT 0');this.isInitialized=true;})().finally(()=>{this.initializing=null;});
    return this.initializing;
  }
  async query(sql,values=[]){await this.initialize();return this.pool.query(sql,values);}
  async log(data){
    if(!data||typeof data!=='object')throw fail('Execution data is required');
    const jobId=text(data.jobId,'job ID',100),jobName=text(data.jobName,'job name',200,true),category=text(data.category,'category',50,true);
    if(!STATUSES.has(data.status))throw fail('Invalid execution status');
    const start=timestamp(data.startTime),end=data.endTime===undefined||data.endTime===null?null:timestamp(data.endTime);
    if(end&&end<start)throw fail('Execution cannot finish before it starts');
    let duration=data.durationMs??(end?new Date(end+'Z')-new Date(start+'Z'):null);
    if(duration!==null)duration=integer(duration,'duration');
    let metadata=null;if(data.metadata!==undefined&&data.metadata!==null){try{metadata=JSON.stringify(data.metadata);}catch{throw fail('Invalid execution metadata');}if(metadata===undefined)throw fail('Invalid execution metadata');}
    const result=await this.query(`INSERT INTO job_execution_logs(job_id,job_name,category,status,start_time,end_time,duration_ms,error_message,error_stack,metadata,created_at) VALUES($1,$2,$3,$4,$5::timestamp,$6::timestamp,$7,$8,$9,$10::jsonb,clock_timestamp() AT TIME ZONE 'UTC') RETURNING id`,[jobId,jobName,category,data.status,start,end,duration,data.errorMessage??null,data.errorStack??null,metadata]);
    return result.rows[0].id;
  }
  async logStart(jobId,jobName,category,startTime=new Date()){return this.log({jobId,jobName,category,status:'running',startTime,metadata:{action:'started'}});}
  async logEnd(jobId,logId,status,endTime=new Date(),error=null){
    text(jobId,'job ID',100);integer(logId,'log ID',1);if(!TERMINAL.has(status))throw fail('A terminal execution status is required');const end=timestamp(endTime);
    const result=await this.query(`UPDATE job_execution_logs SET status=$1,end_time=$3::timestamp,duration_ms=(EXTRACT(EPOCH FROM ($3::timestamp-start_time))*1000)::integer,error_message=$4,error_stack=$5 WHERE id=$6 AND job_id=$2 AND status='running' AND start_time<=$3::timestamp RETURNING `+fields,[status,jobId,end,error?.message??null,error?.stack??null,logId]);
    if(result.rowCount)return result.rows[0];
    const existing=(await this.query('SELECT '+fields+' FROM job_execution_logs WHERE id=$1 AND job_id=$2',[logId,jobId])).rows[0];
    if(!existing)throw fail('Execution not found',404);
    if(existing.status===status&&existing.end_time)return existing;
    if(existing.status!=='running')throw fail('Execution is already finalized',409);
    throw fail('Execution cannot finish before it starts');
  }
  async getLogStartTime(logId,jobId){
    integer(logId,'log ID',1);const values=[logId];let where='id=$1';if(jobId!==undefined){text(jobId,'job ID',100);values.push(jobId);where+=' AND job_id=$2';}
    return (await this.query("SELECT start_time AT TIME ZONE 'UTC' AS start_time FROM job_execution_logs WHERE "+where,values)).rows[0]?.start_time;
  }
  period(period={},days=7){const start=timestamp(period.startDate??new Date(Date.now()-days*86400000)),end=timestamp(period.endDate??new Date());if(end<start)throw fail('Invalid history interval');return [start,end];}
  async getHistory(jobId,options={}){
    text(jobId,'job ID',100);const limit=integer(options.limit??100,'history limit',1,1000),offset=integer(options.offset??0,'history offset');const values=[jobId];let where='job_id=$1';
    if(options.status!==undefined&&options.status!==null){if(!STATUSES.has(options.status))throw fail('Invalid execution status');values.push(options.status);where+=' AND status=$'+values.length;}
    if(options.startDate!==undefined&&options.startDate!==null){values.push(timestamp(options.startDate));where+=' AND start_time>=$'+values.length+'::timestamp';}
    if(options.endDate!==undefined&&options.endDate!==null){values.push(timestamp(options.endDate));where+=' AND start_time<=$'+values.length+'::timestamp';}
    if(options.startDate&&options.endDate&&timestamp(options.startDate)>timestamp(options.endDate))throw fail('Invalid history interval');
    values.push(limit,offset);return (await this.query('SELECT '+fields+' FROM job_execution_logs WHERE '+where+' ORDER BY start_time DESC,id DESC LIMIT $'+(values.length-1)+' OFFSET $'+values.length,values)).rows;
  }
  async getRecentFailures(jobId,count=10){return this.getHistory(jobId,{status:'failed',limit:integer(count,'failure count',1,1000)});}
  async getAllRecentLogs(limit=50){integer(limit,'history limit',1,1000);return (await this.query('SELECT '+fields+' FROM job_execution_logs ORDER BY start_time DESC,id DESC LIMIT $1',[limit])).rows;}
  async getStatistics(jobId,period={}){
    text(jobId,'job ID',100);const [start,end]=this.period(period);
    return (await this.query(`SELECT COUNT(*) AS total_runs,COUNT(*) FILTER(WHERE status='success') AS success_count,COUNT(*) FILTER(WHERE status='failed') AS failure_count,COUNT(*) FILTER(WHERE status='timeout') AS timeout_count,AVG(duration_ms) AS avg_duration_ms,MIN(duration_ms) AS min_duration_ms,MAX(duration_ms) AS max_duration_ms,COUNT(*) FILTER(WHERE status='success')::float/NULLIF(COUNT(*),0)::float AS success_rate FROM job_execution_logs WHERE job_id=$1 AND start_time>=$2::timestamp AND start_time<=$3::timestamp`,[jobId,start,end])).rows[0];
  }
  async getAllJobsStatistics(period={}){
    const [start,end]=this.period(period,1);return (await this.query(`SELECT job_id,job_name,category,COUNT(*) AS total_runs,COUNT(*) FILTER(WHERE status='success') AS success_count,COUNT(*) FILTER(WHERE status='failed') AS failure_count,COUNT(*) FILTER(WHERE status='running') AS running_count,AVG(duration_ms) AS avg_duration_ms,COUNT(*) FILTER(WHERE status='success')::float/NULLIF(COUNT(*),0)::float AS success_rate FROM job_execution_logs WHERE start_time>=$1::timestamp AND start_time<=$2::timestamp GROUP BY job_id,job_name,category ORDER BY job_id`,[start,end])).rows;
  }
  async cleanupOldLogs(){
    const cutoff=timestamp(new Date(Date.now()-this.retentionDays*86400000));
    const result=await this.query("DELETE FROM job_execution_logs WHERE created_at<$1::timestamp AND end_time<$1::timestamp AND status IN('success','failed','timeout') RETURNING id",[cutoff]);
    logger.info({deletedCount:result.rowCount,retentionDays:this.retentionDays},'Old completed job records removed');return result.rowCount;
  }
  async getFailureDistribution(jobId,period={}){
    text(jobId,'job ID',100);const [start,end]=this.period(period,30);return (await this.query("SELECT error_message,COUNT(*) AS count FROM job_execution_logs WHERE job_id=$1 AND status='failed' AND start_time>=$2::timestamp AND start_time<=$3::timestamp GROUP BY error_message ORDER BY count DESC,error_message LIMIT 10",[jobId,start,end])).rows;
  }
  async close(){this.closed=true;if(this.initializing)await this.initializing.catch(()=>{});if(this.ownsPool&&this.pool)await this.pool.end();this.isInitialized=false;}
}
module.exports={JobExecutionLogger};
