'use strict';

const assert=require('node:assert/strict'),crypto=require('node:crypto'),{Pool}=require('pg');
const {ErasureTaskRunner,RESOURCES}=require('../../shared/erasure/ErasureTaskRunner');
const {ErasureProcessor}=require('../../jobs/dataDeletionProcessor');
const table=name=>'"'+name.replaceAll('"','""')+'"';

module.exports=async function taskScenarios(t,{store,pool,db,owner,other,reviewer,call,proof}) {
  const runner=new ErasureTaskRunner({store}),role='erasure_task_'+crypto.randomBytes(8).toString('hex');
  const resources=['user_inventory_preferences','user_notification_preferences','user_push_preferences','user_share_preferences','user_weather_preferences','user_auto_backup_config'];
  assert.deepEqual(RESOURCES.map(r=>r.code),resources);
  let policy,requestId,tasks,restricted,restrictedStore,restrictedPool,roleCreated=false;
  const key='ERASURE_RESOURCE_POLICY_JSON',before=process.env[key],workers=new Set();
  const metric=async(counter,resource)=>((await counter.get()).values.find(v=>v.labels.resource===resource)?.value||0);
  const rows=async(name,id)=>Number((await pool.query('SELECT count(*) AS n FROM '+table(name)+' WHERE user_id=$1',[id])).rows[0].n);
  async function fresh() {const id=crypto.randomUUID();await pool.query("INSERT INTO users(id,nickname) VALUES($1,$2)",[id,'task-'+id.slice(0,20)]);return id;}
  async function approved(id,full=false,{due=true}={}) {
    const request=await store.createRequest(id,full?{}:{requestType:'partial',dataTypes:['preferences']});
    const challenge=await store.issueVerification(request.id);const verified=await store.verifyRequest(id,request.id,challenge.verificationCode);
    if(verified.status==='verifying')await store.decide(request.id,reviewer,'approve');
    if(due)await pool.query("UPDATE data_erasure_requests SET execute_after=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[request.id]);
    return request.id;
  }
  try {
    const active=(await store.list(owner)).find(r=>['pending','verifying','approved'].includes(r.status));if(active)await store.cancelRequest(owner,active.id);
    requestId=await approved(owner);
    const inventory=await store.planRequest(requestId,reviewer);
    policy={version:'owned-fixture-v1',policyReference:'sandbox regression approval for these registered preference operations only; not production legal policy',catalogSha256:inventory.catalogSha256,resources};
    for(const name of resources)await pool.query('INSERT INTO '+table(name)+'(user_id) VALUES($1),($2) ON CONFLICT DO NOTHING',[owner,other]);
    await t.test('task routes require admin purpose proof and server policy, never caller SQL or an empty plan',async()=>{
      const route='/data-deletion/admin/requests/'+requestId+'/tasks';
      assert.equal((await call('POST',route,{},null)).status,401);assert.equal((await call('POST',route,{},owner,proof(owner))).status,403);assert.equal((await call('POST',route,{},reviewer)).status,403);
      assert.equal((await call('POST',route,{},reviewer,proof(reviewer))).body.code,'ERASURE_RESOURCE_POLICY_REQUIRED');
      assert.equal((await call('POST',route,{queryTemplate:'DELETE FROM users',tableName:'users'},reviewer,proof(reviewer))).status,400);
      for(const invalid of ['{',JSON.stringify({...policy,resources:['users; DROP TABLE users']})]){process.env[key]=invalid;await assert.rejects(runner.prepare(requestId,reviewer),e=>e.code==='ERASURE_RESOURCE_POLICY_REQUIRED');}
      process.env[key]=JSON.stringify({...policy,catalogSha256:'0'.repeat(64)});await assert.rejects(runner.prepare(requestId,reviewer),e=>e.code==='ERASURE_POLICY_SCHEMA_MISMATCH');
      process.env[key]=JSON.stringify(policy);
      const pending=await store.createRequest(await fresh());await assert.rejects(runner.prepare(pending.id,reviewer),e=>e.code==='ERASURE_STATE_CONFLICT');
      const unsupported=await store.createRequest(await fresh(),{requestType:'partial',dataTypes:['pokemon']});const code=await store.issueVerification(unsupported.id);await store.verifyRequest((await pool.query('SELECT user_id FROM data_erasure_requests WHERE id=$1',[unsupported.id])).rows[0].user_id,unsupported.id,code.verificationCode);await assert.rejects(runner.prepare(unsupported.id,reviewer),e=>e.code==='ERASURE_RESOURCE_OPERATORS_REQUIRED');
      const planned=await call('POST',route,{},reviewer,proof(reviewer));assert.equal(planned.status,200);assert.equal(planned.body.data.tasks.length,6);assert.equal(planned.body.data.completionReady,false);tasks=planned.body.data.tasks;
      process.env[key]=JSON.stringify({resources:[...resources].reverse(),catalogSha256:policy.catalogSha256,policyReference:policy.policyReference,version:policy.version});
      assert.deepEqual((await runner.prepare(requestId,reviewer)).tasks.map(t=>t.id),tasks.map(t=>t.id));
      process.env[key]=JSON.stringify(policy);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM data_erasure_tasks WHERE request_id=$1',[requestId])).rows[0].n,6);
    });
    await t.test('due time, task dependencies, policy intent and immutable registered resource contracts gate deletion',async()=>{
      const future=await approved(await fresh(),false,{due:false}),prepared=await runner.prepare(future,reviewer);
      await assert.rejects(runner.executeTask(future,prepared.tasks[0].id,reviewer),e=>e.code==='ERASURE_NOT_DUE');
      await assert.rejects(runner.executeTask(requestId,tasks[1].id,reviewer),e=>e.code==='ERASURE_TASK_DEPENDENCY_PENDING');
      await assert.rejects(runner.executeTask(requestId,crypto.randomUUID(),reviewer),e=>e.code==='ERASURE_TASK_NOT_FOUND');
      await pool.query("UPDATE data_erasure_requests SET requested_data_types=ARRAY['preferences','pokemon'] WHERE id=$1",[requestId]);
      try{await assert.rejects(runner.executeTask(requestId,tasks[0].id,reviewer),e=>e.code==='ERASURE_TASK_PLAN_MISMATCH');}finally{await pool.query("UPDATE data_erasure_requests SET requested_data_types=ARRAY['preferences'] WHERE id=$1",[requestId]);}
      await pool.query("UPDATE data_erasure_tasks SET resource_code='users' WHERE id=$1",[tasks[0].id]);
      try{await assert.rejects(runner.executeTask(requestId,tasks[0].id,reviewer),e=>e.code==='ERASURE_TASK_PLAN_MISMATCH');}finally{await pool.query('UPDATE data_erasure_tasks SET resource_code=$2 WHERE id=$1',[tasks[0].id,resources[0]]);}
      await pool.query('UPDATE data_erasure_tasks SET depends_on=ARRAY[$2::uuid] WHERE id=$1',[tasks[0].id,prepared.tasks[0].id]);
      try{await assert.rejects(runner.executeTask(requestId,tasks[0].id,reviewer),e=>e.code==='ERASURE_TASK_PLAN_MISMATCH');}finally{await pool.query("UPDATE data_erasure_tasks SET depends_on=ARRAY[]::uuid[] WHERE id=$1",[tasks[0].id]);}
      await pool.query('CREATE TRIGGER erasure_delete_guard BEFORE DELETE ON user_share_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()');
      try {
        await assert.rejects(runner.executeTask(requestId,tasks[0].id,reviewer),e=>e.code==='ERASURE_POLICY_SCHEMA_MISMATCH');
        const changed=await store.planRequest(requestId,reviewer);process.env[key]=JSON.stringify({...policy,catalogSha256:changed.catalogSha256});
        await assert.rejects(runner.executeTask(requestId,tasks[0].id,reviewer),e=>e.code==='ERASURE_RESOURCE_CONTRACT_REVIEW_REQUIRED');
      }finally{await pool.query('DROP TRIGGER erasure_delete_guard ON user_share_preferences');process.env[key]=JSON.stringify(policy);}
      assert.equal(await rows(resources[0],owner),1);assert.equal((await pool.query('SELECT retry_count FROM data_erasure_tasks WHERE id=$1',[tasks[0].id])).rows[0].retry_count,0);
    });
    await t.test('real DELETE privilege failure rolls back rows and durably bounds retries under the same task lock',async()=>{
      await pool.query('CREATE ROLE '+role+' NOLOGIN');roleCreated=true;
      const schema=(await pool.query('SELECT current_schema() AS name')).rows[0].name;
      await pool.query('GRANT USAGE ON SCHEMA '+table(schema)+' TO '+role);await pool.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA '+table(schema)+' TO '+role);await pool.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA '+table(schema)+' TO '+role);
      const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema+',public -c role='+role);
      restrictedPool=new Pool({connectionString:url.toString(),max:2});
      restrictedStore=new(require('../../shared/erasure/ErasureRequestStore').ErasureRequestStore)({database:restrictedPool});restricted=new ErasureTaskRunner({store:restrictedStore});
      await pool.query('REVOKE DELETE ON user_inventory_preferences FROM '+role);
      const failures=await metric(runner.metrics.failed,resources[0]);
      const retrier=new ErasureProcessor({runner:restricted});workers.add(retrier);
      for(let retry=0;retry<2;retry++) {
        if(retry===0)await assert.rejects(restricted.executeTask(requestId,tasks[0].id,reviewer),e=>e.code==='ERASURE_TASK_EXECUTION_FAILED');
        else {assert.equal((await retrier.runDue()).selected,0);const retried=await retrier.runDue({retryOnly:true});assert.equal(retried.selected,1);assert.equal(retried.failed,1);}
        const row=(await pool.query('SELECT * FROM data_erasure_tasks WHERE id=$1',[tasks[0].id])).rows[0];assert.equal(row.status,'failed');assert.equal(row.retry_count,retry);assert.equal(row.affected_rows,null);assert.equal(row.error_message,'ERASURE_TASK_EXECUTION_FAILED');assert.equal(await rows(resources[0],owner),1);
      }
      assert.equal(await metric(runner.metrics.failed,resources[0]),failures+2);
      await pool.query('GRANT DELETE ON user_inventory_preferences TO '+role);
      const completed=await metric(runner.metrics.completed,resources[0]);
      const concurrent=await Promise.allSettled([restricted.executeTask(requestId,tasks[0].id,reviewer),runner.executeTask(requestId,tasks[0].id,reviewer)]);
      const result=concurrent.find(r=>r.status==='fulfilled')?.value;assert.ok(result);assert.ok(concurrent.every(r=>r.status==='fulfilled'||r.reason.code==='40001'));assert.equal(result.task.affectedRows,'1');assert.equal(result.task.retryCount,2);
      assert.equal(await rows(resources[0],owner),0);assert.equal(await rows(resources[0],other),1);assert.equal(await metric(runner.metrics.completed,resources[0]),completed+1);
      const duplicate=await runner.executeTask(requestId,tasks[0].id,reviewer);assert.deepEqual(duplicate.task,result.task);assert.equal(await metric(runner.metrics.completed,resources[0]),completed+1);
      assert.equal((await pool.query('SELECT retry_count FROM data_erasure_requests WHERE id=$1',[requestId])).rows[0].retry_count,2);
    });
    await t.test('actual HTTP bulk execution records six real resource counts but cannot certify an incomplete overall erasure',async()=>{
      const retained=(await pool.query('SELECT to_jsonb(u) AS row FROM users u ORDER BY id')).rows;
      const response=await call('POST','/data-deletion/admin/requests/'+requestId+'/execute',{},reviewer,proof(reviewer));assert.equal(response.status,202);assert.equal(response.body.data.status,'processing');assert.equal(response.body.data.completionReady,false);assert.ok(response.body.data.tasks.every(t=>t.status==='completed'&&t.affectedRows==='1'));
      for(const name of resources){assert.equal(await rows(name,owner),0);assert.equal(await rows(name,other),1);}
      assert.deepEqual((await pool.query('SELECT to_jsonb(u) AS row FROM users u ORDER BY id')).rows,retained);
      assert.equal((await pool.query('SELECT id FROM orders WHERE user_id=$1',[owner])).rowCount,1);
      const row=(await pool.query('SELECT status,processing_completed_at FROM data_erasure_requests WHERE id=$1',[requestId])).rows[0];assert.equal(row.status,'processing');assert.equal(row.processing_completed_at,null);assert.equal((await pool.query('SELECT id FROM data_erasure_certificates WHERE request_id=$1',[requestId])).rowCount,0);
    });
    await t.test('an unavailable encrypted audit rolls back the real delete, task state, request transition and success counters',async()=>{
      const id=await fresh();await pool.query('INSERT INTO user_inventory_preferences(user_id) VALUES($1)',[id]);const request=await approved(id),prepared=await runner.prepare(request,reviewer),task=prepared.tasks[0];
      const count=await metric(runner.metrics.completed,resources[0]);await pool.query('REVOKE INSERT ON audit_logs FROM '+role);
      try{await assert.rejects(restricted.executeTask(request,task.id,reviewer),e=>e.code==='ERASURE_AUDIT_UNAVAILABLE');}finally{await pool.query('GRANT INSERT ON audit_logs TO '+role);}
      assert.equal(await rows(resources[0],id),1);assert.equal((await pool.query('SELECT status FROM data_erasure_tasks WHERE id=$1',[task.id])).rows[0].status,'pending');assert.equal((await pool.query('SELECT status FROM data_erasure_requests WHERE id=$1',[request])).rows[0].status,'approved');assert.equal(await metric(runner.metrics.completed,resources[0]),count);
      const response=await call('POST','/data-deletion/admin/requests/'+request+'/tasks/'+task.id+'/execute',{},reviewer,proof(reviewer));assert.equal(response.status,202);assert.equal(response.body.data.task.affectedRows,'1');await runner.executeRequest(request,reviewer);
    });
    await t.test('initial failure plus three retries exhausts the request without deleting data or allowing an unbounded retry',async()=>{
      const id=await fresh();await pool.query('INSERT INTO user_inventory_preferences(user_id) VALUES($1)',[id]);const request=await approved(id),prepared=await runner.prepare(request,reviewer),task=prepared.tasks[0];
      await pool.query('REVOKE DELETE ON user_inventory_preferences FROM '+role);
      try{for(let retry=0;retry<=3;retry++){await assert.rejects(restricted.executeTask(request,task.id,reviewer),e=>e.code==='ERASURE_TASK_EXECUTION_FAILED');assert.equal((await pool.query('SELECT retry_count FROM data_erasure_tasks WHERE id=$1',[task.id])).rows[0].retry_count,retry);}await assert.rejects(restricted.executeTask(request,task.id,reviewer),e=>e.code==='ERASURE_STATE_CONFLICT');}
      finally{await pool.query('GRANT DELETE ON user_inventory_preferences TO '+role);}
      assert.equal((await pool.query('SELECT status FROM data_erasure_requests WHERE id=$1',[request])).rows[0].status,'failed');assert.equal(await rows(resources[0],id),1);
    });
    await t.test('real cron lifecycle deduplicates starts, skips future/exhausted work and drains a live row-lock wait before closing',async()=>{
      const id=await fresh();for(const name of resources)await pool.query('INSERT INTO '+table(name)+'(user_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);const request=await approved(id,true);
      const cron=require('node-cron'),before=cron.getTasks().size,worker=new ErasureProcessor({runner});workers.add(worker);
      assert.throws(()=>new ErasureProcessor({runner,batchSize:0}),TypeError);
      const jobs=require('../../jobs');assert.deepEqual(await jobs.startErasureJobs({ERASURE_WORKER_ENABLED:'false'}),{enabled:false});await assert.rejects(jobs.startErasureJobs({ERASURE_WORKER_ENABLED:'invalid'}),TypeError);
      await Promise.all([worker.start(),worker.start()]);assert.equal(worker.jobs.length,2);assert.equal(cron.getTasks().size,before+2);
      const locker=await pool.connect();let running,stopping;
      try {
        await locker.query('BEGIN');await locker.query('SELECT user_id FROM user_inventory_preferences WHERE user_id=$1 FOR UPDATE',[id]);
        running=worker.runDue();
        const deadline=Date.now()+10000;let blocked=false;
        while(Date.now()<deadline) {const waiting=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%DELETE FROM%user_inventory_preferences%'")).rowCount;if(waiting){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
        assert.equal(blocked,true,'actual resource DELETE must be waiting on our owned row lock');assert.deepEqual(await worker.runDue(),{overlap:true});
        const ddl=await pool.connect();
        try {
          await ddl.query('BEGIN');await ddl.query("SET LOCAL lock_timeout='200ms'");
          await assert.rejects(ddl.query('CREATE TRIGGER erasure_racing_delete BEFORE DELETE ON user_inventory_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()'),e=>e.code==='55P03');
        }finally{await ddl.query('ROLLBACK');ddl.release();}
        assert.equal((await pool.query("SELECT 1 FROM pg_trigger WHERE tgrelid='user_inventory_preferences'::regclass AND tgname='erasure_racing_delete'")).rowCount,0);
        let closed=false;stopping=worker.stop().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
      }finally{await locker.query('ROLLBACK');locker.release();}
      const result=await running;await stopping;assert.equal(result.requestsCompleted,0);assert.ok(result.completionBlocked>=1);assert.equal(worker.active.size,0);assert.equal(cron.getTasks().size,before);
      assert.equal((await pool.query('SELECT status FROM data_erasure_requests WHERE id=$1',[request])).rows[0].status,'processing');for(const name of resources)assert.equal(await rows(name,id),0);
      await worker.stop();await assert.rejects(worker.runDue(),e=>e.code==='ERASURE_WORKER_CLOSED');await assert.rejects(worker.start(),e=>e.code==='ERASURE_WORKER_CLOSED');
      const globalJobs=require('../../jobs/dataDeletionProcessor');const ownedProcessor=globalJobs.init(db);assert.throws(()=>globalJobs.init(db));await globalJobs.start();assert.equal(cron.getTasks().size,before+2);await globalJobs.processScheduledDeletions();await globalJobs.retryFailedTasks();await ownedProcessor.jobs[0].execute();await globalJobs.stop();assert.equal(cron.getTasks().size,before);await jobs.startErasureJobs({ERASURE_WORKER_ENABLED:'true'});assert.equal(cron.getTasks().size,before+2);await jobs.stopErasureJobs();assert.equal(cron.getTasks().size,before);
    });
    await t.test('actual scheduler storage failure rejects manual execution, catches its cron callback and releases only its own timers',async()=>{
      const cron=require('node-cron'),before=cron.getTasks().size,worker=new ErasureProcessor({runner:restricted});workers.add(worker);
      await worker.start();assert.equal(cron.getTasks().size,before+2);
      await pool.query('REVOKE SELECT ON data_erasure_requests FROM '+role);
      try{await assert.rejects(worker.runDue(),e=>e.code==='42501');await worker.jobs[0].execute();assert.equal(worker.active.size,0);}
      finally{await pool.query('GRANT SELECT ON data_erasure_requests TO '+role);await worker.stop();}
      assert.equal(cron.getTasks().size,before);
      delete process.env[key];try{await assert.rejects(require('../../jobs').startErasureJobs({ERASURE_WORKER_ENABLED:'true'}),e=>e.code==='ERASURE_RESOURCE_POLICY_REQUIRED');}finally{process.env[key]=JSON.stringify(policy);await require('../../jobs').stopErasureJobs();}
      assert.equal(cron.getTasks().size,before);
    });
  }finally {
    await Promise.allSettled([...workers].map(w=>w.stop()));
    if(restrictedStore)await restrictedStore.close();if(restrictedPool)await restrictedPool.end();
    await require('../../jobs').stopErasureJobs();
    if(roleCreated){await pool.query('DROP OWNED BY '+role);await pool.query('DROP ROLE '+role);}
    if(before===undefined)delete process.env[key];else process.env[key]=before;
  }
};
