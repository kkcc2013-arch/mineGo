'use strict';

const crypto = require('node:crypto');
const {AppError} = require('../auth');
const {providerFromEnvironment} = require('../audit/KeyProviders');
const {seal, open} = require('../audit/cryptoPrimitives');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = ['pending','verifying','approved','processing'];
const STATES = [...ACTIVE,'completed','rejected','cancelled','failed'];
const fail = (code, status=400) => new AppError(code,code,status);
function identity(value) {if(typeof value!=='string'||!UUID.test(value))throw fail('ERASURE_ID_INVALID');return value.toLowerCase();}
function text(value, required=false) {if(value===null&&!required)return null;if(typeof value!=='string'||value.length>1000||!value.trim())throw fail('ERASURE_INPUT_INVALID');return value.trim();}
function page({limit=20,offset=0}={}) {const l=Number(limit),o=Number(offset);if(!Number.isSafeInteger(l)||l<1||l>50||!Number.isSafeInteger(o)||o<0||o>1000000)throw fail('ERASURE_PAGE_INVALID');return {limit:l,offset:o};}
function view(row) {return {id:row.id,requestId:row.id,requestType:row.request_type,status:row.status,approvalStatus:row.approval_status,dataTypes:row.requested_data_types,createdAt:row.created_at,verifiedAt:row.verified_at,approvedAt:row.approved_at,executeAfter:row.execute_after,completedAt:row.processing_completed_at,verificationDelivery:row.verified_at?'verified':row.verification_digest?'prepared':'pending'};}
const challengeDigest = (row, code) => crypto.createHash('sha256').update(JSON.stringify([row.id,row.user_id,row.request_type,[...row.requested_data_types].sort(),code])).digest();

class ErasureRequestStore {
  constructor({database,provider,env=process.env}={}) {
    this.database=database||require('../db');this.provider=provider;this.ownsProvider=!provider;this.env=env;this.operations=new Set();this.closed=false;
    const metrics=require('../metrics'),Counter=require('prom-client').Counter;
    const counter=(name,labels=[])=>{const existing=metrics.register.getSingleMetric(name);if(existing){if(!(existing instanceof Counter)||JSON.stringify(existing.labelNames)!==JSON.stringify(labels))throw fail('ERASURE_METRICS_CONFLICT',503);return existing;}return metrics.counter(name,name,labels);};
    this.metrics={created:counter('data_deletion_requests_created_total',['request_type']),verified:counter('data_deletion_requests_verified_total'),approved:counter('data_deletion_requests_approved_total',['approval_type']),rejected:counter('data_deletion_requests_rejected_total'),cancelled:counter('data_deletion_requests_cancelled_total'),prepared:counter('data_deletion_verification_prepared_total')};
  }
  async ready(client=this.database) {
    if(this.closed)throw fail('ERASURE_STORE_CLOSED',503);
    const location=(await client.query('SELECT current_database() AS database,current_schema() AS schema')).rows[0];
    for(const name of ['users','orders','data_erasure_requests','data_erasure_tasks','data_erasure_categories','data_erasure_approval_history','data_erasure_certificates']) {
      const relation=(await client.query('SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)',[name])).rows[0];
      if(relation?.nspname!==location.schema)throw fail('ERASURE_SCHEMA_INVALID',503);
    }
    await client.query('SELECT live_user_id,verification_digest,execute_after FROM data_erasure_requests LIMIT 0');
    this.namespace=crypto.createHash('sha256').update(JSON.stringify([location.database,location.schema])).digest('hex');
    if(!this.provider)this.provider=providerFromEnvironment(this.env);
    if(this.env.NODE_ENV==='production'&&this.provider.kind!=='aws-kms')throw fail('ERASURE_KEY_CONFIGURATION',503);
  }
  async transaction(work) {
    if(this.closed)throw fail('ERASURE_STORE_CLOSED',503);
    const pool=typeof this.database.getPool==='function'?this.database.getPool():this.database;
    const task=require('../TransactionManager').getManager(pool).execute(async client=>{
      if(!this.namespace)await this.ready(client);
      return work(client);
    },{isolationLevel:'READ COMMITTED',timeout:10000,maxRetries:0,retryOnDeadlock:false,transactionName:'erasure-requests'});
    this.operations.add(task);try{return await task;}finally{this.operations.delete(task);}
  }
  context(row,field) {return {purpose:'minego-erasure-fields-v1',namespace:this.namespace,requestId:row.id,subject:crypto.createHash('sha256').update(row.user_id).digest('hex'),field};}
  async encrypt(row,field,value) {
    if(value===null)return null;
    const context=this.context(row,field),generated=await this.provider.generate(context),bytes=Buffer.from(value);
    try{return JSON.stringify({v:1,wrapped:generated.wrapped,...seal(bytes,generated.key,context)});}finally{bytes.fill(0);generated.key.fill(0);}
  }
  async decrypt(row,field,value) {
    if(value===null)return null;
    let envelope;try{envelope=JSON.parse(value);}catch{throw fail('ERASURE_FIELD_REVIEW_REQUIRED',503);}
    if(envelope?.v!==1)throw fail('ERASURE_FIELD_REVIEW_REQUIRED',503);
    const context=this.context(row,field),key=await this.provider.unwrap(envelope.wrapped,context);
    try{const bytes=open(envelope,key,context);try{return bytes.toString('utf8');}finally{bytes.fill(0);}}finally{key.fill(0);}
  }
  async record(client,action,row,actor=row.user_id,details={}) {
    if(!await require('../auditLog').auditLog({transactionClient:client,userId:actor,service:'user-service',action,resourceType:'data-erasure-request',resourceId:row.id,details:{requestId:row.id,subject:row.user_id,...details}}))throw fail('ERASURE_AUDIT_UNAVAILABLE',503);
  }
  async lockUsers(client,ids) {
    const unique=[...new Set(ids.map(identity))].sort();
    const rows=(await client.query('SELECT id,is_banned FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE',[unique])).rows;
    if(rows.length!==unique.length||rows.some(row=>row.is_banned))throw fail('ERASURE_SUBJECT_BLOCKED',403);
  }
  async locked(client,id,owner,actor) {
    identity(id);if(owner)identity(owner);
    const found=(await client.query('SELECT user_id FROM data_erasure_requests WHERE id=$1 AND ($2::uuid IS NULL OR user_id=$2)',[id,owner||null])).rows[0];
    if(!found)throw fail('ERASURE_REQUEST_NOT_FOUND',404);
    await this.lockUsers(client,[found.user_id,...(actor?[actor]:[])]);
    return (await client.query('SELECT *,verification_expires_at>clock_timestamp() AS challenge_live FROM data_erasure_requests WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,found.user_id])).rows[0];
  }
  async history(client,row,action,actor,type,previous,next) {await client.query('INSERT INTO data_erasure_approval_history(request_id,action,actor_id,actor_type,previous_status,new_status) VALUES($1,$2,$3,$4,$5,$6)',[row.id,action,actor,type,previous,next]);}
  async createRequest(owner,{requestType='full',reason=null,dataTypes=['all']}={}, {withdrawConsent=false}={}) {
    identity(owner);reason=text(reason);
    if(!['full','partial'].includes(requestType)||!Array.isArray(dataTypes)||dataTypes.length<1||dataTypes.length>8||dataTypes.some(v=>typeof v!=='string')||new Set(dataTypes).size!==dataTypes.length)throw fail('ERASURE_INPUT_INVALID');
    if(requestType==='full'&&(dataTypes.length!==1||dataTypes[0]!=='all')||requestType==='partial'&&dataTypes.includes('all'))throw fail('ERASURE_INPUT_INVALID');
    let created=false;
    const result=await this.transaction(async client=>{
      await this.lockUsers(client,[owner]);
      let withdrawn=0;
      if(withdrawConsent) {
        const contract=(await client.query("SELECT n.nspname,a.atttypid='uuid'::regtype AS owned_uuid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='user_id' AND NOT a.attisdropped WHERE c.oid=to_regclass('user_consents') AND n.nspname=current_schema()")).rows[0];
        if(!contract?.owned_uuid)throw fail('ERASURE_CONSENT_ADOPTION_REQUIRED',503);
        withdrawn=(await client.query("UPDATE user_consents SET withdrawn_at=clock_timestamp() AT TIME ZONE 'UTC' WHERE user_id=$1 AND withdrawn_at IS NULL",[owner])).rowCount;
      }
      const existing=(await client.query('SELECT * FROM data_erasure_requests WHERE user_id=$1 AND status=ANY($2::text[])',[owner,ACTIVE])).rows[0];
      if(existing) {
        if(!withdrawConsent)throw fail('ERASURE_ACTIVE_REQUEST_EXISTS',409);
        if(existing.request_type!=='full')throw fail('ERASURE_ACTIVE_PARTIAL_REQUEST_EXISTS',409);
        await this.record(client,'ERASURE_CONSENT_WITHDRAWN',existing,owner,{affectedConsentRows:withdrawn});return view(existing);
      }
      if(requestType==='partial') {
        const categories=await client.query('SELECT category_code FROM data_erasure_categories WHERE category_code=ANY($1::text[]) AND is_deletable=TRUE',[dataTypes]);
        if(categories.rowCount!==dataTypes.length)throw fail('ERASURE_CATEGORY_INVALID');
      }
      const row={id:crypto.randomUUID(),user_id:owner};
      const encrypted=await this.encrypt(row,'reason',reason);
      const inserted=(await client.query('INSERT INTO data_erasure_requests(id,user_id,live_user_id,request_type,reason,requested_data_types) VALUES($1,$2,$2,$3,$4,$5) RETURNING *',[row.id,owner,requestType,encrypted,dataTypes])).rows[0];
      created=true;
      await this.history(client,inserted,'requested',owner,'system',null,'pending');
      await this.record(client,'ERASURE_REQUEST_CREATED',inserted,owner,{requestType,dataTypes});
      if(withdrawConsent)await this.record(client,'ERASURE_CONSENT_WITHDRAWN',inserted,owner,{affectedConsentRows:withdrawn});
      return view(inserted);
    });
    if(created)this.metrics.created.inc({request_type:result.requestType});return result;
  }
  async withdrawConsent(owner) {return this.createRequest(owner,{reason:'consent_withdrawn'},{withdrawConsent:true});}
  // Internal delivery preparation only. No HTTP route returns this nonce, and
  // preparation is not a claim that a notification provider delivered it.
  async issueVerification(requestId) {

    const result=await this.transaction(async client=>{
      const row=await this.locked(client,identity(requestId));
      if(row.status!=='pending'||row.verified_at)throw fail('ERASURE_STATE_CONFLICT',409);
      const code=crypto.randomBytes(16).toString('hex');
      const issued=(await client.query("UPDATE data_erasure_requests SET verification_digest=$2,verification_expires_at=clock_timestamp()+INTERVAL '24 hours' WHERE id=$1 RETURNING verification_expires_at",[row.id,challengeDigest(row,code)])).rows[0];
      await this.record(client,'ERASURE_VERIFICATION_PREPARED',row,row.user_id);
      return {requestId:row.id,userId:row.user_id,verificationCode:code,expiresAt:issued.verification_expires_at};
    });
    this.metrics.prepared.inc();return result;
  }
  async verifyRequest(owner,id,code) {
    identity(owner);identity(id);if(typeof code!=='string'||!/^[0-9a-f]{32}$/.test(code))throw fail('ERASURE_VERIFICATION_INVALID',400);

    const result=await this.transaction(async client=>{
      const row=await this.locked(client,id,owner);
      if(row.status!=='pending'||row.verified_at||!row.challenge_live||!Buffer.isBuffer(row.verification_digest)||!crypto.timingSafeEqual(challengeDigest(row,code),row.verification_digest))throw fail('ERASURE_VERIFICATION_INVALID',400);
      await client.query("UPDATE data_erasure_requests SET verified_at=clock_timestamp(),verification_digest=NULL,verification_expires_at=NULL,status='verifying' WHERE id=$1",[id]);
      await this.history(client,row,'verified',owner,'system','pending','verifying');
      const financial=(await client.query('SELECT 1 FROM orders WHERE user_id=$1 LIMIT 1',[owner])).rowCount>0;
      if(!financial) {
        await client.query("UPDATE data_erasure_requests SET status='approved',approval_status='auto_approved',approved_at=clock_timestamp(),execute_after=clock_timestamp()+INTERVAL '30 days' WHERE id=$1",[id]);
        await this.history(client,row,'approved',null,'auto','verifying','approved');
      }
      const current=(await client.query('SELECT * FROM data_erasure_requests WHERE id=$1',[id])).rows[0];
      await this.record(client,'ERASURE_REQUEST_VERIFIED',current,owner,{decision:financial?'manual_review':'auto_approved',gracePeriodDays:financial?null:30});
      return view(current);
    });
    this.metrics.verified.inc();if(result.approvalStatus==='auto_approved')this.metrics.approved.inc({approval_type:'auto'});return result;
  }
  async cancelRequest(owner,id) {
    let changed=false;
    const result=await this.transaction(async client=>{
      const row=await this.locked(client,identity(id),identity(owner));
      if(row.status==='cancelled')return view(row);
      if(!['pending','verifying','approved'].includes(row.status))throw fail('ERASURE_STATE_CONFLICT',409);
      const updated=(await client.query("UPDATE data_erasure_requests SET status='cancelled',verification_digest=NULL,verification_expires_at=NULL WHERE id=$1 RETURNING *",[id])).rows[0];
      changed=true;
      await this.history(client,row,'cancelled',owner,'system',row.status,'cancelled');await this.record(client,'ERASURE_REQUEST_CANCELLED',updated,owner);return view(updated);
    });
    if(changed)this.metrics.cancelled.inc();return result;
  }
  async decide(id,admin,decision,reason=null) {
    identity(id);identity(admin);if(!['approve','reject'].includes(decision))throw fail('ERASURE_INPUT_INVALID');reason=decision==='reject'?text(reason,true):null;

    const result=await this.transaction(async client=>{
      const row=await this.locked(client,id,null,admin);
      if(decision==='approve'&&(row.status!=='verifying'||!row.verified_at)||decision==='reject'&&!['pending','verifying'].includes(row.status))throw fail('ERASURE_STATE_CONFLICT',409);
      const sealed=await this.encrypt(row,'rejection_reason',reason);
      const updated=decision==='approve'?(await client.query("UPDATE data_erasure_requests SET status='approved',approval_status='manual_approved',approved_by=$2,approved_at=clock_timestamp(),execute_after=clock_timestamp() WHERE id=$1 RETURNING *",[id,admin])).rows[0]:
        (await client.query("UPDATE data_erasure_requests SET status='rejected',approval_status='rejected',rejection_reason=$2,verification_digest=NULL,verification_expires_at=NULL WHERE id=$1 RETURNING *",[id,sealed])).rows[0];
      await this.history(client,row,decision==='approve'?'approved':'rejected',admin,'admin',row.status,updated.status);await this.record(client,'ERASURE_REQUEST_'+(decision==='approve'?'APPROVED':'REJECTED'),updated,admin);return view(updated);
    });
    if(decision==='approve')this.metrics.approved.inc({approval_type:'manual'});else this.metrics.rejected.inc();return result;
  }
  async list(owner,{status,...options}={}) {
    if(owner!==null)identity(owner);if(status!==undefined&&!STATES.includes(status))throw fail('ERASURE_STATE_INVALID');const p=page(options);
    return this.transaction(async client=>(await client.query('SELECT * FROM data_erasure_requests WHERE ($1::uuid IS NULL OR user_id=$1) AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4',[owner||null,status||null,p.limit,p.offset])).rows.map(row=>({...view(row),...(owner?{}:{subjectId:row.user_id})})));
  }
  async detail(owner,id,{admin=false}={}) {
    identity(owner);identity(id);
    return this.transaction(async client=>{
      const row=(await client.query('SELECT * FROM data_erasure_requests WHERE id=$1 AND ($2::uuid IS NULL OR user_id=$2)',[id,admin?null:owner])).rows[0];
      if(!row)throw fail('ERASURE_REQUEST_NOT_FOUND',404);
      const tasks=(await client.query('SELECT id,data_category,resource_code,service_name,status,affected_rows,started_at,completed_at,duration_ms FROM data_erasure_tasks WHERE request_id=$1 ORDER BY created_at,id',[id])).rows;
      const history=(await client.query('SELECT action,actor_type,previous_status,new_status,created_at FROM data_erasure_approval_history WHERE request_id=$1 ORDER BY created_at,id',[id])).rows;
      const result={...view(row),...(admin?{subjectId:row.user_id}:{}),reason:await this.decrypt(row,'reason',row.reason),rejectionReason:await this.decrypt(row,'rejection_reason',row.rejection_reason),tasks,history};
      await this.record(client,'ERASURE_REQUEST_READ',row,owner||row.live_user_id,{administrative:admin});return result;
    });
  }
  async certificate(owner,number,{admin=false}={}) {
    identity(owner);if(typeof number!=='string'||!/^[A-Za-z0-9_-]{1,50}$/.test(number))throw fail('ERASURE_CERTIFICATE_INVALID');
    return this.transaction(async client=>{
      const row=(await client.query('SELECT * FROM data_erasure_certificates WHERE certificate_number=$1 AND ($2::uuid IS NULL OR user_id=$2)',[number,admin?null:owner])).rows[0];
      if(!row)throw fail('ERASURE_CERTIFICATE_NOT_FOUND',404);
      let keys;try{keys=JSON.parse(this.env.ERASURE_SIGNING_PUBLIC_KEYS_JSON||'{}');}catch{throw fail('ERASURE_CERTIFICATE_KEY_REQUIRED',503);}
      const pem=keys?.[row.signing_key_id];if(!keys||Array.isArray(keys)||typeof pem!=='string'||pem.includes('PRIVATE KEY'))throw fail('ERASURE_CERTIFICATE_KEY_REQUIRED',503);
      const key=crypto.createPublicKey(pem),algorithm=row.signature_algorithm==='Ed25519'?null:'RSA-SHA256';
      const encoding=/^[a-f0-9]+$/i.test(row.signature)&&row.signature.length%2===0?'hex':'base64';
      const signature=Buffer.from(row.signature,encoding);
      if(signature.toString(encoding).toLowerCase()!==row.signature.toLowerCase()||key.type!=='public'||row.signature_algorithm==='Ed25519'&&key.asymmetricKeyType!=='ed25519'||row.signature_algorithm==='RSA-SHA256'&&key.asymmetricKeyType!=='rsa'||!crypto.verify(algorithm,Buffer.from(row.signed_payload),key,signature))throw fail('ERASURE_CERTIFICATE_SIGNATURE_INVALID',503);
      await this.record(client,'ERASURE_CERTIFICATE_READ',{id:row.request_id,user_id:row.user_id},owner);
      return {certificateNumber:row.certificate_number,requestId:row.request_id,payload:JSON.parse(row.signed_payload),signature:row.signature,signatureEncoding:encoding,signatureAlgorithm:row.signature_algorithm,signingKeyId:row.signing_key_id,signatureVerified:true,retentionUntil:row.retention_until};
    });
  }
  async statistics() {return this.transaction(async client=>(await client.query('SELECT status,count(*)::int AS count FROM data_erasure_requests GROUP BY status ORDER BY status')).rows);}
  async close() {if(this.closePromise)return this.closePromise;this.closed=true;this.closePromise=(async()=>{await Promise.allSettled([...this.operations]);if(this.ownsProvider)this.provider?.close();})();return this.closePromise;}
}
let store;
const getErasureStore=()=>store||(store=new ErasureRequestStore());
async function closeErasureStore(){if(store){const current=store;store=null;await current.close();}}
module.exports={ErasureRequestStore,getErasureStore,closeErasureStore,identity,page,view};
