'use strict';

const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {Pool}=require('pg'),speakeasy=require('speakeasy');
const {migrationStatements}=require('../../../database/sqlStatements');
const run=require('node:util').promisify(require('node:child_process').execFile);
const {ensureStorageExtensions}=require('./storageSetup');
const root=path.resolve(__dirname,'../../..');

test('actual UUID erasure HTTP requests preserve legacy history, enforce owner/admin MFA and commit challenge/approval audit atomically',{timeout:120000},async t=>{
  assert.ok(process.env.TEST_DATABASE_URL&&process.env.TEST_REDIS_URL);
  const schema='erasure_http_'+crypto.randomBytes(8).toString('hex');
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});await ensureStorageExtensions(admin);await admin.query('CREATE SCHEMA '+schema);
  const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+schema+',public');
  const pool=new Pool({connectionString:url.toString(),max:3});
  const names=['NODE_ENV','DATABASE_URL','SERVICE_NAME','REDIS_URL','JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','AUDIT_KMS_KEY_ID','MASTER_ENCRYPTION_KEY','AUDIT_MASTER_KEYS_JSON','AUDIT_MASTER_KEY_ID','AUDIT_KEY_NAMESPACE','MFA_KMS_KEY_ID','MFA_MASTER_ENCRYPTION_KEY','MFA_MASTER_KEYS_JSON','MFA_MASTER_KEY_ID','MFA_KEY_NAMESPACE','ERASURE_SIGNING_PUBLIC_KEYS_JSON','ERASURE_RESOURCE_POLICY_JSON'];
  const before=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  delete process.env.ERASURE_RESOURCE_POLICY_JSON;
  const auditKey=crypto.randomBytes(32),mfaKey=crypto.randomBytes(32),signing=crypto.generateKeyPairSync('ed25519');
  const publicKeys=JSON.stringify({'owned-fixture-key':signing.publicKey.export({format:'pem',type:'spki'})});
  Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:url.toString(),SERVICE_NAME:schema,REDIS_URL:process.env.TEST_REDIS_URL,JWT_ACCESS_SECRET:'erasure-http-access-fixture',JWT_REFRESH_SECRET:'erasure-http-refresh-fixture',AUDIT_KMS_KEY_ID:'',MASTER_ENCRYPTION_KEY:auditKey.toString('hex'),AUDIT_MASTER_KEYS_JSON:'',AUDIT_MASTER_KEY_ID:'erasure-audit',AUDIT_KEY_NAMESPACE:schema,MFA_KMS_KEY_ID:'',MFA_MASTER_ENCRYPTION_KEY:mfaKey.toString('hex'),MFA_MASTER_KEYS_JSON:'',MFA_MASTER_KEY_ID:'erasure-mfa',MFA_KEY_NAMESPACE:schema,ERASURE_SIGNING_PUBLIC_KEYS_JSON:publicKeys});
  const express=require('express'),db=require('../../shared/db'),redis=require('../../shared/redis'),r=redis.getRedis();
  const audit=require('../../shared/auditLogEncrypted'),mfa=require('../../shared/mfaService');
  const {getErasureStore,closeErasureStore}=require('../../shared/erasure/ErasureRequestStore');
  const {RiskVerifier}=require('../../shared/riskVerifier'),{issueTokens}=require('../../services/user-service/src/authSessionTokens');
  const {signAccess,verifyAccess,errorHandler}=require('../../shared/auth');
  const owner=crypto.randomUUID(),other=crypto.randomUUID(),reviewer=crypto.randomUUID(),legacyConsentOwner=crypto.randomUUID();
  const profiles=new Map(),ownedKeys=new Set(),store=getErasureStore(),risk=new RiskVerifier();
  let server,base,requestId,otherId,certificateNumber;
  const reason='private owned erasure reason';
  async function call(method,route,body,actor=owner,proof,headers={}) {
    const token=profiles.get(actor)?.access;
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','User-Agent':'owned-erasure-agent',...(token?{Authorization:'Bearer '+token}:{}),...(proof?{'X-MFA-Token':proof}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  const proof=id=>profiles.get(id).proof;
  const count=async()=>Number((await pool.query('SELECT count(*) AS n FROM data_erasure_requests')).rows[0].n);
  async function login(id,role='user') {
    const initial=await issueTokens({id,nickname:'erasure actor'},{ip:'127.0.0.1',userAgent:'owned-erasure-agent'});profiles.set(id,{access:initial.accessToken});
    const setup=(await call('POST','/users/me/mfa/setup',{},id)).body.data;
    const now=(await pool.query('SELECT extract(epoch FROM clock_timestamp())::double precision AS now')).rows[0].now;
    assert.equal((await call('POST','/users/me/mfa/enable',{code:speakeasy.totp({secret:setup.secret,encoding:'base32',time:now})},id)).status,200);
    const challenge=await mfa.beginLogin(id);
    const session=await call('POST','/auth/mfa/verify',{challenge:challenge.challenge,code:setup.recoveryCodes[0]},id);assert.equal(session.status,200);
    let access=session.body.data.accessToken;
    if(role==='admin') {
      const claims=verifyAccess(access);delete claims.exp;
      access=signAccess({...claims,roles:['admin']});
    }
    profiles.set(id,{access,setup});
    const scope=role==='admin'?'erasure-admin':'delete-account';
    const verified=await call('POST','/users/me/mfa/step-up',{scope,code:setup.recoveryCodes[1]},id);assert.equal(verified.status,200);profiles.get(id).proof=verified.body.data.mfaToken;
    ownedKeys.add('sessions:user:'+id);ownedKeys.add('blacklist:user:'+id);for(const k of Object.values(risk.keys(id,'127.0.0.1')))ownedKeys.add(k);
  }
  const legacy=async()=>({rows:(await pool.query('SELECT to_jsonb(r)::text AS row FROM data_deletion_requests r ORDER BY id')).rows,consents:(await pool.query('SELECT to_jsonb(r)::text AS row FROM user_consents r WHERE user_id=$1 ORDER BY id',[legacyConsentOwner])).rows,sequence:(await pool.query('SELECT * FROM data_deletion_requests_id_seq')).rows,objects:(await pool.query("SELECT relname,oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname IN('data_deletion_requests','retained_deletion_history','retained_deletion_reference') ORDER BY oid")).rows});
  let oldHistory;
  try {
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query(await fs.readFile(path.join(root,'database/seeds/V2__seed_data.sql'),'utf8'));
    const original=migrationStatements(await fs.readFile(path.join(root,'database/pending/20260605_161000__add_gdpr_tables.sql'),'utf8'));
    for(const pattern of [/CREATE TABLE IF NOT EXISTS data_deletion_requests\b/,/CREATE TABLE IF NOT EXISTS user_consents\b/])await pool.query(original.find(sql=>pattern.test(sql)));
    await pool.query("INSERT INTO data_deletion_requests(user_id,status,confirmation_token,error_message) VALUES(77,'failed','retained legacy token','retained failure')");
    await pool.query('CREATE VIEW retained_deletion_history AS SELECT * FROM data_deletion_requests');
    await pool.query('CREATE TABLE retained_deletion_reference(id integer REFERENCES data_deletion_requests(id))');await pool.query('INSERT INTO retained_deletion_reference SELECT id FROM data_deletion_requests');
    await run(process.execPath,[path.join(root,'database/migrate.js'),'up'],{cwd:root,env:{...process.env,DATABASE_URL:url.toString()},maxBuffer:4000000});
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,87);
    await pool.query("INSERT INTO users(id,nickname) VALUES($1,'erasure owner'),($2,'erasure other'),($3,'erasure reviewer'),($4,'retained consent owner')",[owner,other,reviewer,legacyConsentOwner]);
    await pool.query("INSERT INTO user_consents(user_id,privacy_policy_version,terms_version,consented_at) VALUES($1,'legacy','legacy','2024-01-02'),($2,'current','current',clock_timestamp())",[legacyConsentOwner,owner]);
    await pool.query("INSERT INTO orders(user_id,idempotency_key,product_id,product_name,amount_fen,status) VALUES($1,$2,'coins_60','real owned financial history',600,'PAID')",[owner,crypto.randomUUID()]);
    await store.ready();await risk.ready();oldHistory=await legacy();
    const app=express();app.use(express.json());
    const mfaRoutes=require('../../services/user-service/src/routes/mfa');
    app.use('/users/me/mfa',mfaRoutes.createMfaRouter(mfa));app.use('/auth/mfa',mfaRoutes.createLoginRouter(mfa,{issueTokens}));
    app.use('/data-deletion',require('../../services/user-service/src/routes/dataDeletion').createErasureRouter({store,risk}));
    const gdpr=require('../../services/user-service/src/routes/gdpr');gdpr.initGDPRRoutes(db,null);app.use('/gdpr',gdpr.router);app.use(errorHandler);
    server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
    for(const [id,role]of [[owner,'user'],[other,'user'],[reviewer,'admin']])await login(id,role);
    await t.test('missing identity and client verification flags cannot bypass actual fresh-purpose MFA',async()=>{
      assert.equal((await call('POST','/gdpr/delete/confirm',{token:'retained legacy token'},null)).status,401);
      const refused=await call('POST','/data-deletion/requests',{},owner,null,{'x-verified-types':'mfa','x-mfa-enabled':'true'});assert.equal(refused.status,403);assert.equal(await count(),0);
    });
    await t.test('concurrent UUID requests commit once, store encrypted reason and never return a verification secret',async()=>{
      const outcomes=await Promise.all(Array.from({length:4},()=>call('POST','/data-deletion/requests',{reason},owner,proof(owner))));
      assert.equal(outcomes.filter(r=>r.status===201).length,1);assert.equal(outcomes.filter(r=>r.status===409).length,3);
      const result=outcomes.find(r=>r.status===201);requestId=result.body.data.id;assert.equal(result.body.data.verificationDelivery,'pending');assert.equal(result.headers.get('cache-control'),'no-store');
      assert.ok(!JSON.stringify(result.body).includes('verificationCode'));const stored=(await pool.query('SELECT * FROM data_erasure_requests WHERE id=$1',[requestId])).rows[0];assert.equal(stored.verification_digest,null);assert.ok(!stored.reason.includes(reason));assert.equal(JSON.parse(stored.reason).v,1);
      const own=await call('GET','/data-deletion/requests/'+requestId,undefined,owner);assert.equal(own.status,200);assert.equal(own.body.data.reason,reason);assert.equal(own.body.data.tasks.length,0);
    });
    await t.test('owner-scoped queries and strict pagination refuse another user and malformed identifiers',async()=>{
      for(const [method,route,body]of [['GET','/data-deletion/requests/'+requestId,undefined],['POST','/data-deletion/requests/'+requestId+'/verify',{verificationCode:'a'.repeat(32)}],['POST','/data-deletion/requests/'+requestId+'/cancel',{}]])assert.equal((await call(method,route,body,other,proof(other))).status,404);
      assert.equal((await call('GET','/data-deletion/requests?limit=5abc',undefined,owner)).status,400);assert.equal((await call('GET','/data-deletion/requests?offset=-1',undefined,owner)).status,400);assert.equal((await call('GET','/data-deletion/requests/not-a-uuid',undefined,owner)).status,400);
      assert.deepEqual((await call('GET','/data-deletion/requests',undefined,other)).body.data,[]);
    });
    await t.test('real prepared challenge is owner-bound, replaceable, one-use and absolute24hour limited',async()=>{
      const first=await store.issueVerification(requestId),second=await store.issueVerification(requestId);assert.equal(first.verificationCode.length,32);assert.notEqual(first.verificationCode,second.verificationCode);
      const row=(await pool.query('SELECT verification_digest,verification_expires_at,clock_timestamp() AS now FROM data_erasure_requests WHERE id=$1',[requestId])).rows[0];assert.equal(row.verification_digest.length,32);assert.ok(row.verification_expires_at-row.now>86399000&&row.verification_expires_at-row.now<=86400000);assert.ok(!row.verification_digest.toString('hex').includes(second.verificationCode));
      assert.equal((await call('POST','/data-deletion/requests/'+requestId+'/verify',{verificationCode:first.verificationCode},owner,proof(owner))).status,400);
      await pool.query("UPDATE data_erasure_requests SET request_type='partial',requested_data_types=ARRAY['pokemon'] WHERE id=$1",[requestId]);
      try{assert.equal((await call('POST','/data-deletion/requests/'+requestId+'/verify',{verificationCode:second.verificationCode},owner,proof(owner))).status,400);}finally{await pool.query("UPDATE data_erasure_requests SET request_type='full',requested_data_types=ARRAY['all'] WHERE id=$1",[requestId]);}
      await pool.query("UPDATE data_erasure_requests SET verification_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[requestId]);assert.equal((await call('POST','/data-deletion/requests/'+requestId+'/verify',{verificationCode:second.verificationCode},owner,proof(owner))).status,400);
      const fresh=await store.issueVerification(requestId);const response=await call('POST','/data-deletion/requests/'+requestId+'/verify',{verificationCode:fresh.verificationCode},owner,proof(owner));assert.equal(response.status,200);assert.equal(response.body.data.status,'verifying');assert.equal(response.body.data.approvalStatus,'pending');
      assert.equal((await call('POST','/data-deletion/requests/'+requestId+'/verify',{verificationCode:fresh.verificationCode},owner,proof(owner))).status,400);assert.equal((await pool.query('SELECT verification_digest FROM data_erasure_requests WHERE id=$1',[requestId])).rows[0].verification_digest,null);
    });
    await t.test('canonical admin role plus its own purpose proof is required to review financial history',async()=>{
      assert.equal((await call('GET','/data-deletion/admin/pending',undefined,owner,proof(owner))).status,403);
      assert.equal((await call('GET','/data-deletion/admin/pending',undefined,reviewer)).status,403);
      const list=await call('GET','/data-deletion/admin/pending',undefined,reviewer,proof(reviewer));assert.equal(list.status,200);assert.equal(list.body.data[0].id,requestId);assert.ok(!JSON.stringify(list.body).includes('verification_digest'));
      const decision=await call('POST','/data-deletion/admin/requests/'+requestId+'/approve',{},reviewer,proof(reviewer));assert.equal(decision.status,200);assert.equal(decision.body.data.approvalStatus,'manual_approved');
      assert.equal((await call('POST','/data-deletion/admin/requests/'+requestId+'/approve',{},reviewer,proof(reviewer))).status,409);
    });
    await t.test('resource review requires actual admin purpose proof and preserves the request and data',async()=>{
      const route='/data-deletion/admin/requests/'+requestId+'/plan';
      const metricBefore=(await store.metrics.reviewed.get()).values[0].value;
      assert.equal((await call('GET',route,undefined,null)).status,401);
      assert.equal((await call('GET',route,undefined,owner,proof(owner))).status,403);
      assert.equal((await call('GET',route,undefined,reviewer)).status,403);
      const before=(await pool.query('SELECT to_jsonb(r) AS row FROM data_erasure_requests r WHERE id=$1',[requestId])).rows;
      const planned=await call('GET',route,undefined,reviewer,proof(reviewer));assert.equal(planned.status,200);assert.equal(planned.headers.get('cache-control'),'no-store');
      assert.equal(planned.body.data.executionReady,false);assert.equal(planned.body.data.isolation,'repeatable read');assert.equal(planned.body.data.requestId,requestId);
      assert.equal(planned.body.data.resources.find(r=>r.name==='users').associatedRows,'1');assert.equal(planned.body.data.resources.find(r=>r.name==='orders').associatedRows,'1');
      assert.deepEqual((await pool.query('SELECT to_jsonb(r) AS row FROM data_erasure_requests r WHERE id=$1',[requestId])).rows,before);assert.equal((await pool.query('SELECT id FROM data_erasure_tasks WHERE request_id=$1',[requestId])).rowCount,0);
      assert.equal((await call('GET','/data-deletion/admin/requests/'+crypto.randomUUID()+'/plan',undefined,reviewer,proof(reviewer))).status,404);
      assert.equal((await call('GET','/data-deletion/admin/requests/no-uuid/plan',undefined,reviewer,proof(reviewer))).status,400);
      assert.equal((await store.metrics.reviewed.get()).values[0].value,metricBefore+1);
    });
    await t.test('unconfigured resource execution never reports a deletion or mutates user/game/history rows',async()=>{
      const beforeUsers=(await pool.query('SELECT id FROM users ORDER BY id')).rows;const response=await call('POST','/data-deletion/admin/requests/'+requestId+'/execute',{},reviewer,proof(reviewer));assert.equal(response.status,503);assert.equal(response.body.code,'ERASURE_RESOURCE_POLICY_REQUIRED');assert.deepEqual((await pool.query('SELECT id FROM users ORDER BY id')).rows,beforeUsers);assert.equal((await pool.query('SELECT status FROM data_erasure_requests WHERE id=$1',[requestId])).rows[0].status,'approved');
      const facade=new(require('../../shared/dataDeletionService').DataDeletionService)(db);try{await assert.rejects(facade.executeDeletion(requestId),error=>error.code==='ERASURE_RESOURCE_POLICY_REQUIRED');await assert.rejects(facade.getRequest(requestId),error=>error.code==='ERASURE_ID_INVALID');}finally{await facade.close();}
    });
    await t.test('owner cancellation is idempotent and preserves authenticated approval history',async()=>{
      const metricBefore=(await store.metrics.cancelled.get()).values[0].value;
      assert.equal((await call('POST','/data-deletion/requests/'+requestId+'/cancel',{},owner,proof(owner))).body.data.status,'cancelled');assert.equal((await call('POST','/data-deletion/requests/'+requestId+'/cancel',{},owner,proof(owner))).status,200);
      assert.equal((await store.metrics.cancelled.get()).values[0].value,metricBefore+1);
      const history=(await call('GET','/data-deletion/requests/'+requestId,undefined,owner)).body.data.history;assert.equal(history.filter(h=>h.action==='cancelled').length,1);assert.ok(history.some(h=>h.action==='approved'&&h.actor_type==='admin'));
    });
    await t.test('nonfinancial verified requests retain the original automatic30day grace interval',async()=>{
      const created=await call('POST','/data-deletion/requests',{},other,proof(other));assert.equal(created.status,201);otherId=created.body.data.id;
      const nonce=await store.issueVerification(otherId);const approved=await call('POST','/data-deletion/requests/'+otherId+'/verify',{verificationCode:nonce.verificationCode},other,proof(other));assert.equal(approved.status,200);assert.equal(approved.body.data.approvalStatus,'auto_approved');
      const seconds=Number((await pool.query('SELECT extract(epoch FROM(execute_after-approved_at)) AS n FROM data_erasure_requests WHERE id=$1',[otherId])).rows[0].n);assert.ok(seconds>=2592000&&seconds<2592000.01);
    });
    await t.test('request validation and rejection preserve private reasons behind actual authorization',async()=>{
      assert.equal((await call('POST','/data-deletion/requests',{requestType:'partial',dataTypes:['not-a-resource']},owner,proof(owner))).status,400);
      assert.equal((await call('POST','/data-deletion/requests',{requestType:'full',dataTypes:['pokemon']},owner,proof(owner))).status,400);
      const created=await call('POST','/data-deletion/requests',{reason:'second owned reason'},owner,proof(owner));requestId=created.body.data.id;
      assert.equal((await call('POST','/data-deletion/admin/requests/'+requestId+'/approve',{},reviewer,proof(reviewer))).status,409);
      const rejected=await call('POST','/data-deletion/admin/requests/'+requestId+'/reject',{reason:'private review reason'},reviewer,proof(reviewer));assert.equal(rejected.status,200);
      const raw=(await pool.query('SELECT rejection_reason FROM data_erasure_requests WHERE id=$1',[requestId])).rows[0];assert.ok(!raw.rejection_reason.includes('private review reason'));
      const detail=await call('GET','/data-deletion/requests/'+requestId,undefined,owner);assert.equal(detail.body.data.rejectionReason,'private review reason');
    });
    await t.test('authenticated legacy GDPR aliases use UUID workflow and never execute a token-only deletion',async()=>{
      assert.equal((await call('POST','/gdpr/delete/confirm',{token:'retained legacy token'},null)).status,401);
      const created=await call('DELETE','/gdpr/delete',{confirmation:'DELETE MY ACCOUNT'},owner,proof(owner));assert.equal(created.status,202);const id=created.body.data.id;
      const nonce=await store.issueVerification(id);assert.equal((await call('POST','/gdpr/delete/confirm',{requestId:id,token:nonce.verificationCode},other,proof(other))).status,404);
      const confirmed=await call('POST','/gdpr/delete/confirm',{requestId:id,token:nonce.verificationCode},owner,proof(owner));assert.equal(confirmed.body.data.status,'verifying');
      assert.equal((await call('GET','/gdpr/status',undefined,owner)).body.id,id);const withdrawal=await call('POST','/gdpr/withdraw',{},owner,proof(owner));assert.equal(withdrawal.status,202);assert.equal(withdrawal.body.data.id,id);assert.equal((await pool.query('SELECT withdrawn_at IS NOT NULL AS withdrawn FROM user_consents WHERE user_id=$1',[owner])).rows[0].withdrawn,true);
      await store.cancelRequest(owner,id);
    });
    await t.test('copied encrypted fields and unavailable audit cannot expose a reason or commit a new request',async()=>{
      const original=(await pool.query('SELECT reason FROM data_erasure_requests WHERE id=$1',[otherId])).rows[0].reason;
      const wrong=(await pool.query('SELECT reason FROM data_erasure_requests WHERE id=$1',[requestId])).rows[0].reason;
      await pool.query('UPDATE data_erasure_requests SET reason=$2 WHERE id=$1',[otherId,wrong]);try{assert.equal((await call('GET','/data-deletion/requests/'+otherId,undefined,other)).status,503);}finally{await pool.query('UPDATE data_erasure_requests SET reason=$2 WHERE id=$1',[otherId,original]);}
      const n=await count(),metricBefore=await store.metrics.created.get(),reviewBefore=await store.metrics.reviewed.get();await pool.query('ALTER TABLE audit_logs RENAME TO erasure_owned_audit_offline');try{await assert.rejects(store.createRequest(owner,{reason:'audit rollback'}),error=>error.code==='ERASURE_AUDIT_UNAVAILABLE');await assert.rejects(store.planRequest(otherId,reviewer),error=>error.code==='ERASURE_AUDIT_UNAVAILABLE');}finally{await pool.query('ALTER TABLE erasure_owned_audit_offline RENAME TO audit_logs');}assert.equal(await count(),n);assert.deepEqual(await store.metrics.created.get(),metricBefore);assert.deepEqual(await store.metrics.reviewed.get(),reviewBefore);
    });
    await t.test('certificate reads check owner and actual configured signature math against real fixture deletions',async()=>{
      const created=await store.createRequest(owner,{requestType:'partial',dataTypes:['pokemon']});const nonce=await store.issueVerification(created.id);await store.verifyRequest(owner,created.id,nonce.verificationCode);await store.decide(created.id,reviewer,'approve');
      await pool.query('INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) SELECT $1,25,100,10,10,1,2,3 FROM generate_series(1,2)',[owner]);await pool.query('INSERT INTO pokemon_instances(user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) VALUES($1,25,200,20,20,1,2,3)',[other]);
      const removed=await pool.query('DELETE FROM pokemon_instances WHERE user_id=$1 RETURNING id',[owner]);assert.equal(removed.rowCount,2);assert.equal((await pool.query('SELECT id FROM pokemon_instances WHERE user_id=$1',[other])).rowCount,1);
      await pool.query("INSERT INTO data_erasure_tasks(request_id,task_name,service_name,data_category,resource_code,plan_version,status,affected_rows,completed_at) VALUES($1,'owned actual removal','pokemon-service','pokemon','pokemon_instances','owned-fixture-v1','completed',$2,clock_timestamp())",[created.id,removed.rowCount]);
      await pool.query("UPDATE data_erasure_requests SET status='completed',processing_completed_at=clock_timestamp() WHERE id=$1",[created.id]);
      const payload=JSON.stringify({requestId:created.id,userId:owner,totalRecords:String(removed.rowCount),categories:{pokemon:String(removed.rowCount)},completedAt:new Date().toISOString()});const signature=crypto.sign(null,Buffer.from(payload),signing.privateKey).toString('hex');certificateNumber='owned-'+crypto.randomUUID();
      await pool.query("INSERT INTO data_erasure_certificates(request_id,user_id,certificate_number,deletion_summary,signed_payload,payload_digest,deleted_data_categories,total_records_deleted,signature,signature_algorithm,signing_key_id,retention_until) VALUES($1,$2,$3,$4::text::jsonb,$4,digest($4::text,'sha256'),ARRAY['pokemon'],$5,$6,'Ed25519','owned-fixture-key',clock_timestamp()+INTERVAL '1 day')",[created.id,owner,certificateNumber,payload,removed.rowCount,signature]);
      assert.equal((await call('GET','/data-deletion/certificates/'+certificateNumber,undefined,null)).status,401);assert.equal((await call('GET','/data-deletion/certificates/'+certificateNumber,undefined,other)).status,404);
      const receipt=await call('GET','/data-deletion/certificates/'+certificateNumber,undefined,owner);assert.equal(receipt.status,200);assert.equal(receipt.body.data.signatureVerified,true);assert.equal(receipt.body.data.signatureEncoding,'hex');assert.equal(receipt.body.data.payload.totalRecords,'2');
      process.env.ERASURE_SIGNING_PUBLIC_KEYS_JSON='{}';try{assert.equal((await call('GET','/data-deletion/certificates/'+certificateNumber,undefined,owner)).status,503);}finally{process.env.ERASURE_SIGNING_PUBLIC_KEYS_JSON=publicKeys;}
      await pool.query('UPDATE data_erasure_certificates SET signature=$2 WHERE certificate_number=$1',[certificateNumber,'ab'.repeat(64)]);try{assert.equal((await call('GET','/data-deletion/certificates/'+certificateNumber,undefined,owner)).status,503);}finally{await pool.query('UPDATE data_erasure_certificates SET signature=$2 WHERE certificate_number=$1',[certificateNumber,signature]);}
    });
    await t.test('legacy SERIAL requests, tokens, foreign consent history, sequence and references remain byte-identical',async()=>{assert.deepEqual(await legacy(),oldHistory);const rows=(await pool.query("SELECT details,encrypted_data FROM audit_logs WHERE action LIKE 'ERASURE_%'")).rows;assert.ok(rows.length>15);assert.ok(rows.every(row=>row.details===null&&Buffer.isBuffer(row.encrypted_data)));});
    await t.test('admin listing, private details, statistics and certificate views reflect actual rows',async()=>{
      const list=await call('GET','/data-deletion/admin/requests',undefined,reviewer,proof(reviewer));assert.equal(list.status,200);assert.ok(list.body.data.some(row=>row.subjectId===owner));
      const detail=await call('GET','/data-deletion/admin/requests/'+otherId,undefined,reviewer,proof(reviewer));assert.equal(detail.status,200);assert.equal(detail.body.data.subjectId,other);
      const statistics=await call('GET','/data-deletion/admin/statistics',undefined,reviewer,proof(reviewer));assert.equal(statistics.status,200);assert.equal(statistics.body.data.reduce((n,row)=>n+row.count,0),await count());
      const certificate=await call('GET','/data-deletion/admin/certificates/'+certificateNumber,undefined,reviewer,proof(reviewer));assert.equal(certificate.status,200);assert.equal(certificate.body.data.signatureVerified,true);
    });
    await t.test('consent withdrawal cannot silently reuse a partial request as full erasure',async()=>{
      const partial=await store.createRequest(owner,{requestType:'partial',dataTypes:['pokemon']});
      const consent=(await pool.query("INSERT INTO user_consents(user_id,privacy_policy_version,terms_version,consented_at) VALUES($1,'again','again',clock_timestamp()) RETURNING id",[owner])).rows[0].id;
      await assert.rejects(store.withdrawConsent(owner),error=>error.code==='ERASURE_ACTIVE_PARTIAL_REQUEST_EXISTS');
      assert.equal((await pool.query('SELECT withdrawn_at FROM user_consents WHERE id=$1',[consent])).rows[0].withdrawn_at,null);
      await store.cancelRequest(owner,partial.id);const full=await store.withdrawConsent(owner);assert.equal(full.requestType,'full');assert.notEqual(full.id,partial.id);assert.ok((await pool.query('SELECT withdrawn_at FROM user_consents WHERE id=$1',[consent])).rows[0].withdrawn_at);
    });
    await require('./erasure-task-scenarios')(t,{store,pool,db,owner,other,reviewer,call,proof});
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    for(const key of ownedKeys)await r.del(key).catch(()=>{});
    await closeErasureStore();await mfa.closeMFA();await audit.closeAuditEncryption();await db.closePools();await redis.closeRedis();
    for(const [k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    auditKey.fill(0);mfaKey.fill(0);await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
  }
});
