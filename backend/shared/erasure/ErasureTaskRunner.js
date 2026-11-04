'use strict';

const crypto=require('node:crypto');
const {AppError}=require('../auth');
const {identity,getErasureStore}=require('./ErasureRequestStore');
const {ErasureResourcePlanner}=require('./ErasureResourcePlanner');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const fail=(code,status=503)=>new AppError(code,code,status);
const VERSION='owned-preference-delete-v1';
// Fixed reviewed operations, never identifiers/SQL supplied by request or task rows.
// More resources, external stores and final certification are still required.
const RESOURCES=Object.freeze([
  'user_inventory_preferences','user_notification_preferences','user_push_preferences',
  'user_share_preferences','user_weather_preferences','user_auto_backup_config'
].map(table=>Object.freeze({code:table,table,category:'preferences',service:'user-service'})));

class ErasureTaskRunner {
  constructor({store=getErasureStore(),env=process.env}={}) {
    this.store=store;this.env=env;
    const metrics=require('../metrics'),Counter=require('prom-client').Counter;
    const counter=name=>{const existing=metrics.register.getSingleMetric(name);if(existing){if(!(existing instanceof Counter)||JSON.stringify(existing.labelNames)!=='["resource"]')throw fail('ERASURE_METRICS_CONFLICT');return existing;}return metrics.counter(name,name,['resource']);};
    this.metrics={completed:counter('data_deletion_tasks_completed_total'),rows:counter('data_deletion_task_rows_deleted_total'),failed:counter('data_deletion_task_failures_total')};
  }
  policy() {
    let p;try{p=JSON.parse(this.env.ERASURE_RESOURCE_POLICY_JSON||'null');}catch{throw fail('ERASURE_RESOURCE_POLICY_REQUIRED');}
    if(!p||Array.isArray(p)||Object.keys(p).sort().join(',')!=='catalogSha256,policyReference,resources,version'||
      typeof p.version!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(p.version)||
      typeof p.policyReference!=='string'||!p.policyReference.trim()||p.policyReference.length>500||
      typeof p.catalogSha256!=='string'||!/^[0-9a-f]{64}$/.test(p.catalogSha256)||
      !Array.isArray(p.resources)||JSON.stringify([...p.resources].sort())!==JSON.stringify(RESOURCES.map(r=>r.code).sort()))throw fail('ERASURE_RESOURCE_POLICY_REQUIRED');
    return {version:p.version,policyReference:p.policyReference.trim(),catalogSha256:p.catalogSha256,resources:[...p.resources].sort()};
  }
  async lockResources(client) {
    const schema=(await client.query('SELECT current_schema() AS name')).rows[0].name;
    for(const r of [...RESOURCES].sort((a,b)=>a.table.localeCompare(b.table))) {
      const table=(await client.query('SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2',[schema,r.table])).rows[0];
      if(table?.relkind!=='r')throw fail('ERASURE_RESOURCE_CONTRACT_REVIEW_REQUIRED');
      // Allows ordinary writers, blocks target DDL/new triggers/FKs until commit.
      await client.query(`LOCK TABLE ${quote(schema)}.${quote(r.table)} IN ROW EXCLUSIVE MODE`);
    }
  }
  async context(client,row) {
    const policy=this.policy(),inventory=await new ErasureResourcePlanner().inspect(client,row);
    if(inventory.catalogSha256!==policy.catalogSha256)throw fail('ERASURE_POLICY_SCHEMA_MISMATCH');
    const selected=RESOURCES.filter(r=>row.request_type==='full'||row.requested_data_types.includes(r.category));
    if(!selected.length)throw fail('ERASURE_RESOURCE_OPERATORS_REQUIRED');
    for(const resource of selected) {
      const actual=inventory.resources.find(r=>r.name===resource.table);
      const owner=inventory.columns.find(c=>c.relation===resource.table&&c.name==='user_id');
      if(!actual||actual.kind!=='r'||actual.parents.length||actual.incomingReferences.length||actual.associatedRows===null||owner?.type!=='uuid'||
        !inventory.foreignKeys.some(fk=>fk.source_schema==='@local'&&fk.source===resource.table&&fk.target_schema==='@local'&&fk.target==='users'&&fk.validated&&JSON.stringify(fk.source_columns)==='["user_id"]'&&JSON.stringify(fk.target_columns)==='["id"]')||
        inventory.triggers.some(t=>t.relation===resource.table&&(Number(t.event_mask)&8))||
        inventory.rules.some(r=>r.relation===resource.table))throw fail('ERASURE_RESOURCE_CONTRACT_REVIEW_REQUIRED');
    }
    const planVersion='tasks-v1:'+hash({operator:VERSION,policy,namespace:inventory.namespace,id:row.id,subject:row.user_id,type:row.request_type,categories:[...row.requested_data_types].sort(),verifiedAt:row.verified_at,approval:row.approval_status,approvedAt:row.approved_at,executeAfter:row.execute_after});
    return {selected,planVersion,policy};
  }
  state(row,{due=false}={}) {
    if(!['approved','processing'].includes(row.status)||!row.verified_at||!row.approved_at||!['auto_approved','manual_approved'].includes(row.approval_status))throw fail('ERASURE_STATE_CONFLICT',409);
    if(due&&!row.due)throw fail('ERASURE_NOT_DUE',409);
  }
  async locked(client,id,actor) {
    const row=await this.store.locked(client,id,null,actor);
    row.due=(await client.query('SELECT execute_after<=clock_timestamp() AS due FROM data_erasure_requests WHERE id=$1',[id])).rows[0].due;
    return row;
  }
  async tasks(client,row,context,{create=false,actor=null}={}) {
    let tasks=(await client.query('SELECT * FROM data_erasure_tasks WHERE request_id=$1 ORDER BY created_at,id FOR UPDATE',[row.id])).rows;
    if(!tasks.length&&create) {
      let previous=[];
      for(const r of context.selected) {
        const task=(await client.query("INSERT INTO data_erasure_tasks(request_id,task_name,service_name,data_category,resource_code,plan_version,depends_on) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[row.id,'Erase owned '+r.code,r.service,r.category,r.code,context.planVersion,previous])).rows[0];
        previous=[task.id];tasks.push(task);
      }
      await this.store.record(client,'ERASURE_TASKS_PREPARED',row,actor,{planVersion:context.planVersion,resources:context.selected.map(r=>r.code),policyReference:context.policy.policyReference,completionReady:false});
    }
    const byCode=new Map(tasks.map(t=>[t.resource_code,t]));
    if(tasks.length!==context.selected.length||byCode.size!==tasks.length)throw fail('ERASURE_TASK_PLAN_MISMATCH');
    for(let i=0;i<context.selected.length;i++) {
      const r=context.selected[i],task=byCode.get(r.code),dependencies=i?[byCode.get(context.selected[i-1].code)?.id]:[];
      if(!task||task.plan_version!==context.planVersion||task.data_category!==r.category||task.service_name!==r.service||JSON.stringify(task.depends_on)!==JSON.stringify(dependencies))throw fail('ERASURE_TASK_PLAN_MISMATCH');
    }
    return context.selected.map(r=>byCode.get(r.code));
  }
  project(task) {return {id:task.id,resource:task.resource_code,category:task.data_category,status:task.status,affectedRows:task.affected_rows,retryCount:task.retry_count,maxRetries:task.max_retries,dependsOn:task.depends_on};}
  async ready() {
    this.policy();
    return this.store.transaction(async client=>{
      await this.lockResources(client);
      const probe={id:crypto.randomUUID(),user_id:crypto.randomUUID(),request_type:'full',requested_data_types:['all'],verified_at:null,approved_at:null,approval_status:'pending',execute_after:null};
      await this.context(client,probe);
    },{isolationLevel:'REPEATABLE READ'});
  }
  async prepare(requestId,actor=null) {
    identity(requestId);if(actor!==null)identity(actor);this.policy();
    return this.store.transaction(async client=>{
      await this.lockResources(client);
      const row=await this.locked(client,requestId,actor);this.state(row);
      const context=await this.context(client,row),tasks=await this.tasks(client,row,context,{create:true,actor});
      return {requestId:row.id,status:row.status,planVersion:context.planVersion,tasks:tasks.map(t=>this.project(t)),completionReady:false,remaining:'complete_resource_and_external_storage_coverage_and_certification'};
    },{isolationLevel:'REPEATABLE READ'});
  }
  async executeTask(requestId,taskId,actor=null) {
    identity(requestId);identity(taskId);if(actor!==null)identity(actor);this.policy();
    const result=await this.store.transaction(async client=>{
      await this.lockResources(client);
      const row=await this.locked(client,requestId,actor);this.state(row,{due:true});
      const context=await this.context(client,row),tasks=await this.tasks(client,row,context),task=tasks.find(t=>t.id===taskId);
      if(!task)throw fail('ERASURE_TASK_NOT_FOUND',404);
      if(task.status==='completed')return {requestId,status:row.status,task:this.project(task),completionReady:false,changed:false};
      if(!['pending','failed'].includes(task.status))throw fail('ERASURE_TASK_STATE_CONFLICT',409);
      if(task.status==='failed'&&task.retry_count>=Math.min(task.max_retries,row.max_retries))throw fail('ERASURE_RETRIES_EXHAUSTED',409);
      if(task.depends_on.some(id=>!tasks.some(t=>t.id===id&&t.status==='completed')))throw fail('ERASURE_TASK_DEPENDENCY_PENDING',409);
      const resource=context.selected.find(r=>r.code===task.resource_code),retry=task.retry_count+(task.status==='failed'?1:0);
      await client.query("UPDATE data_erasure_requests SET status='processing',processing_started_at=COALESCE(processing_started_at,clock_timestamp()),processing_error=NULL,retry_count=GREATEST(retry_count,$2) WHERE id=$1",[requestId,retry]);
      // Keep owner/request/task locks across a failed delete and its failure
      // receipt. A separate failure transaction would race another worker.
      await client.query('SAVEPOINT erasure_resource_operation');
      try {
        await client.query("UPDATE data_erasure_tasks SET status='running',started_at=clock_timestamp(),completed_at=NULL,error_message=NULL,retry_count=$2 WHERE id=$1",[taskId,retry]);
        const schema=(await client.query('SELECT current_schema() AS name')).rows[0].name;
        const removed=await client.query(`DELETE FROM ${quote(schema)}.${quote(resource.table)} WHERE user_id=$1`,[row.user_id]);
        const completed=(await client.query("UPDATE data_erasure_tasks SET status='completed',affected_rows=$2,completed_at=clock_timestamp(),duration_ms=GREATEST(0,floor(extract(epoch FROM(clock_timestamp()-started_at))*1000)) WHERE id=$1 RETURNING *",[taskId,removed.rowCount])).rows[0];
        await this.store.record(client,'ERASURE_TASK_COMPLETED',row,actor,{taskId,resource:resource.code,affectedRows:removed.rowCount,retryCount:retry,policyReference:context.policy.policyReference,completionReady:false});
        await client.query('RELEASE SAVEPOINT erasure_resource_operation');
        return {requestId,status:'processing',task:this.project(completed),completionReady:false,changed:true};
      }catch(error) {
        if(error.code==='ERASURE_AUDIT_UNAVAILABLE')throw error;
        await client.query('ROLLBACK TO SAVEPOINT erasure_resource_operation');
        const exhausted=retry>=Math.min(task.max_retries,row.max_retries);
        const failed=(await client.query("UPDATE data_erasure_tasks SET status='failed',retry_count=$2,error_message='ERASURE_TASK_EXECUTION_FAILED',affected_rows=NULL,completed_at=NULL WHERE id=$1 RETURNING *",[taskId,retry])).rows[0];
        await client.query("UPDATE data_erasure_requests SET status=$2,processing_error='ERASURE_TASK_EXECUTION_FAILED',retry_count=GREATEST(retry_count,$3) WHERE id=$1",[requestId,exhausted?'failed':'processing',retry]);
        await this.store.record(client,'ERASURE_TASK_FAILED',row,actor,{taskId,resource:resource.code,retryCount:retry,exhausted,errorCode:'ERASURE_TASK_EXECUTION_FAILED'});
        await client.query('RELEASE SAVEPOINT erasure_resource_operation');
        return {requestId,status:exhausted?'failed':'processing',task:this.project(failed),completionReady:false,changed:false,failed:true};
      }
    },{isolationLevel:'REPEATABLE READ'});
    if(result.failed){this.metrics.failed.inc({resource:result.task.resource});throw fail('ERASURE_TASK_EXECUTION_FAILED');}
    if(result.changed){this.metrics.completed.inc({resource:result.task.resource});this.metrics.rows.inc({resource:result.task.resource},Number(result.task.affectedRows));}
    const {changed,...view}=result;return view;
  }
  async executeRequest(requestId,actor=null) {
    const prepared=await this.prepare(requestId,actor),results=[];
    for(const task of prepared.tasks)results.push(await this.executeTask(requestId,task.id,actor));
    return {requestId,status:'processing',tasks:results.map(r=>r.task),completionReady:false,remaining:prepared.remaining};
  }
}
let runner;
const getErasureTaskRunner=()=>runner||(runner=new ErasureTaskRunner());
function resetErasureTaskRunner(){runner=null;}
module.exports={ErasureTaskRunner,getErasureTaskRunner,resetErasureTaskRunner,RESOURCES};
