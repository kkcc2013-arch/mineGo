'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Pool}=require('pg');
const {Registry}=require('prom-client');
const speakeasy=require('speakeasy');
const {parseMigrationFile}=require('../../../database/migrate');
const {migrationStatements}=require('../../../database/sqlStatements');
const {MFAStore,counterFor}=require('../../shared/mfa/MFAStore');
const {EnvironmentKeyProvider}=require('../../shared/audit/KeyProviders');
const encryptedAudit=require('../../shared/auditLogEncrypted');
const root=path.resolve(__dirname,'../../..');
async function apply(pool,file,direction='up'){const source=parseMigrationFile(await fs.readFile(path.join(root,'database/pending',file),'utf8'));const client=await pool.connect();try{await client.query('BEGIN');for(const statement of migrationStatements(source[direction]))await client.query(statement);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
const fails=code=>error=>error.code===code;

test('actual canonical MFA factors enforce durable lockout, replay prevention and session-scoped server proofs',async t=>{
 assert.ok(process.env.TEST_DATABASE_URL,'owned PostGIS required');
 const schema='mfa_runtime_'+crypto.randomBytes(8).toString('hex');const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema+',public',application_name:schema,max:3});
 const envBefore={};for(const key of ['NODE_ENV','MASTER_ENCRYPTION_KEY','AUDIT_MASTER_KEYS_JSON','AUDIT_MASTER_KEY_ID','AUDIT_KMS_KEY_ID','AUDIT_KEY_NAMESPACE'])envBefore[key]=process.env[key];
 const auditMaster=crypto.randomBytes(32),mfaMaster=crypto.randomBytes(32);
 process.env.NODE_ENV='test';process.env.MASTER_ENCRYPTION_KEY=auditMaster.toString('hex');process.env.AUDIT_MASTER_KEY_ID='mfa-audit-fixture';process.env.AUDIT_MASTER_KEYS_JSON='';process.env.AUDIT_KMS_KEY_ID='';process.env.AUDIT_KEY_NAMESPACE='mfa-fixture-audit';await encryptedAudit.closeAuditEncryption();
 const provider=new EnvironmentKeyProvider({keys:{mfa:mfaMaster},activeKeyId:'mfa',nodeEnv:'test'});const store=new MFAStore({pool,provider,env:{NODE_ENV:'test'},namespace:'mfa-fixture',registry:new Registry()});const other=new MFAStore({pool,provider,env:{NODE_ENV:'test'},namespace:'mfa-fixture',registry:new Registry()});
 const owner=crypto.randomUUID(),second=crypto.randomUUID(),third=crypto.randomUUID(),fourth=crypto.randomUUID();let setup,sessionProof;
 const session=crypto.randomBytes(32).toString('hex');
 const code=async secret=>speakeasy.totp({secret,encoding:'base32',time:(await pool.query('SELECT extract(epoch FROM clock_timestamp())::double precision AS now')).rows[0].now,step:30,digits:6});
 try{
  await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
  for(const file of ['20260608_194800__add_sensitive_data_protection_tables.sql','repairs/20260608_200000__add_sensitive_data_audit_tables.sql','20260610_000000__add_mfa_system.sql','20261020_120000__mfa_verification_state.sql'])await apply(pool,file);
  await pool.query("INSERT INTO users(id,nickname) VALUES($1,'mfa-owner'),($2,'mfa-second'),($3,'mfa-third'),($4,'mfa-fourth')",[owner,second,third,fourth]);
  await t.test('empty reversal retains canonical users and factor tables before a fresh installation',async()=>{
   await apply(pool,'20261020_120000__mfa_verification_state.sql','down');
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,4);
   assert.equal((await pool.query("SELECT to_regclass('mfa_security_state') AS state,to_regclass('user_mfa') AS profile")).rows[0].state,null);
   assert.ok((await pool.query("SELECT to_regclass('user_mfa') AS profile")).rows[0].profile);
   await apply(pool,'20261020_120000__mfa_verification_state.sql');
  });
  await t.test('enrollment retains complete authenticated secret envelope and only eight unique recovery hashes',async()=>{
   setup=await store.setup(owner);assert.match(setup.secret,/^[A-Z2-7]{32}$/);assert.match(setup.qrCodeDataUrl,/^data:image\/png;base64,/);assert.match(setup.otpauthUrl,/issuer=mineGo/);assert.equal(setup.recoveryCodes.length,8);assert.equal(new Set(setup.recoveryCodes).size,8);
   const profile=(await pool.query('SELECT * FROM user_mfa WHERE user_id=$1',[owner])).rows[0];assert.ok(!profile.secret_encrypted.includes(setup.secret));assert.ok(!profile.secret_encrypted.includes(mfaMaster.toString('hex')));assert.equal(JSON.parse(profile.secret_encrypted).tag.length,32);
   const hashes=(await pool.query('SELECT code_hash,is_used FROM mfa_recovery_codes WHERE user_id=$1',[owner])).rows;assert.equal(hashes.length,8);assert.ok(hashes.every(row=>/^[0-9a-f]{64}$/.test(row.code_hash)&&!row.is_used));assert.ok(!JSON.stringify(hashes).includes(setup.recoveryCodes[0]));
  });
  await t.test('actual current TOTP enables once; replay cannot mint a step-up proof',async()=>{
   const token=await code(setup.secret);assert.equal((await store.enable(owner,token)).ok,true);assert.equal((await store.status(owner)).enabled,true);
   await assert.rejects(other.verify(owner,token,{binding:session,scope:'audit-read'}),fails('MFA_INVALID_FACTOR'));
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM mfa_auth_proofs')).rows[0].n,0);
  });
  await t.test('two real clients cannot consume the same recovery code twice',async()=>{
   const outcomes=await Promise.allSettled([store.verify(owner,setup.recoveryCodes[0],{binding:session,scope:'audit-read'}),other.verify(owner,setup.recoveryCodes[0],{binding:session,scope:'audit-read'})]);
   assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);assert.equal(outcomes.filter(row=>row.status==='rejected').length,1);sessionProof=outcomes.find(row=>row.status==='fulfilled').value;
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id=$1 AND is_used',[owner])).rows[0].n,1);
   assert.equal((await store.status(owner)).recoveryCodes.remaining,7);
  });
  await t.test('opaque proof is bound to server state, exact session/scope/subject and actual five-minute expiry',async()=>{
   assert.equal(sessionProof.token.length,43);assert.equal(await other.verifyProof(owner,sessionProof.token,{binding:session,scope:'audit-read'}),true);
   for(const [who,bind,scope]of [[second,session,'audit-read'],[owner,crypto.randomBytes(32).toString('hex'),'audit-read'],[owner,session,'mfa-manage']])assert.equal(await store.verifyProof(who,sessionProof.token,{binding:bind,scope}),false);
   assert.equal(await store.verifyProof(owner,'fake-jwt-mfa-claim',{binding:session,scope:'audit-read'}),false);
   const row=(await pool.query('SELECT proof_hash,extract(epoch FROM(expires_at-created_at))::int AS seconds FROM mfa_auth_proofs')).rows[0];assert.equal(row.seconds,300);assert.ok(!row.proof_hash.includes(sessionProof.token));
   await pool.query("UPDATE mfa_auth_proofs SET consumed_at=clock_timestamp() WHERE proof_hash=$1",[row.proof_hash]);assert.equal(await store.verifyProof(owner,sessionProof.token,{binding:session,scope:'audit-read'}),false);
  });
  await t.test('fifth failed attempt locks for the original fifteen minutes; early correct factors remain denied',async()=>{
   const pending=await store.setup(second);let invalid='000000';const now=(await pool.query('SELECT extract(epoch FROM clock_timestamp())::double precision AS now')).rows[0].now;while(counterFor(pending.secret,invalid,now)!==null)invalid=String(Number(invalid)+1).padStart(6,'0');
   for(let i=0;i<5;i++)await assert.rejects(store.enable(second,invalid),fails('MFA_INVALID_FACTOR'));
   const state=(await pool.query('SELECT failed_attempts,extract(epoch FROM(locked_until-clock_timestamp()))::double precision AS remaining FROM mfa_security_state WHERE user_id=$1',[second])).rows[0];assert.equal(state.failed_attempts,5);assert.ok(state.remaining>895&&state.remaining<=900);
   await assert.rejects(other.enable(second,await code(pending.secret)),fails('MFA_LOCKED'));
   await assert.rejects(other.setup(second),fails('MFA_LOCKED'));
   assert.equal((await pool.query('SELECT failed_attempts FROM mfa_security_state WHERE user_id=$1',[second])).rows[0].failed_attempts,5);
   // Owned fixture expiry exercises the boundary; no claim of waiting 15 real minutes.
   await pool.query("UPDATE mfa_security_state SET locked_until=clock_timestamp()-INTERVAL '1 second' WHERE user_id=$1",[second]);assert.equal((await store.enable(second,await code(pending.secret))).ok,true);
  });
  await t.test('audit storage refusal rolls enrollment back instead of committing a failed setup response',async()=>{
   await pool.query("ALTER TABLE audit_logs ADD CONSTRAINT refuse_mfa_audit CHECK(action<>'mfa_setup') NOT VALID");
   try{await assert.rejects(store.setup(third),fails('MFA_AUDIT_UNAVAILABLE'));assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_mfa WHERE user_id=$1',[third])).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id=$1',[third])).rows[0].n,0);}finally{await pool.query('ALTER TABLE audit_logs DROP CONSTRAINT refuse_mfa_audit');}
  });
  await t.test('regeneration invalidates old proofs/codes and disable requires a fresh real factor',async()=>{
   const old=await store.verify(owner,setup.recoveryCodes[1],{binding:session,scope:'mfa-manage'});assert.equal(await other.verifyProof(owner,old.token,{binding:session,scope:'mfa-manage'}),true);
   const refreshed=await store.regenerate(owner,setup.recoveryCodes[2]);assert.equal(refreshed.recoveryCodes.length,8);assert.equal(await store.verifyProof(owner,old.token,{binding:session,scope:'mfa-manage'}),false);
   await assert.rejects(store.verify(owner,setup.recoveryCodes[3],{binding:session,scope:'mfa-manage'}),fails('MFA_INVALID_FACTOR'));
   const secret=(await pool.query('SELECT * FROM user_mfa WHERE user_id=$1',[owner])).rows[0],state=(await pool.query('SELECT * FROM mfa_security_state WHERE user_id=$1',[owner])).rows[0];assert.equal(await store.decryptSecret(secret,state),setup.secret);
   assert.equal((await store.disable(owner,refreshed.recoveryCodes[0])).ok,true);assert.equal((await store.status(owner)).enabled,false);assert.equal((await store.status(owner)).recoveryCodes.remaining,0);
   await assert.rejects(store.enable(owner,await code(setup.secret)),fails('MFA_SETUP_REQUIRED'));
  });
  await t.test('login challenge is durable and can only be consumed once after an actual factor succeeds',async()=>{
   const enrolled=await store.setup(fourth);await store.enable(fourth,await code(enrolled.secret));
   const challenge=await store.beginLogin(fourth);assert.equal(challenge.required,true);assert.equal(challenge.challenge.length,43);
   const attempts=await Promise.allSettled([store.completeLogin(challenge.challenge,enrolled.recoveryCodes[0]),other.completeLogin(challenge.challenge,enrolled.recoveryCodes[0])]);assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1);assert.equal(attempts.filter(row=>row.status==='rejected').length,1);
   const result=attempts.find(row=>row.status==='fulfilled').value;assert.equal(result.user.id,fourth);assert.equal(result.user.nickname,'mfa-fourth');assert.ok(result.credentialEpoch);
   await assert.rejects(store.completeLogin('forged-jwt',enrolled.recoveryCodes[1]),fails('MFA_CHALLENGE_INVALID'));
   assert.equal((await store.beginLogin(owner)).required,false);
  });
  await t.test('a real held user lock cannot outlive the whole-operation deadline or approve a factor',async()=>{
   const holding=await pool.connect();const bounded=new MFAStore({pool,provider,env:{NODE_ENV:'test'},namespace:'mfa-fixture',registry:new Registry(),timeout:200});
   try{
    await holding.query('BEGIN');await holding.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[second]);
    const before=(await pool.query('SELECT count(*)::int AS n FROM mfa_auth_proofs')).rows[0].n,start=performance.now();
    await assert.rejects(bounded.verify(second,'123456',{binding:session,scope:'audit-read'}),error=>error.code==='57014');assert.ok(performance.now()-start<2000);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mfa_auth_proofs')).rows[0].n,before);
   }finally{await holding.query('ROLLBACK');holding.release();await bounded.close();}
  });
  await t.test('close drains an actual in-flight operation and leaves caller resources usable',async()=>{
   const holding=await pool.connect(),closing=new MFAStore({pool,provider,env:{NODE_ENV:'test'},namespace:'mfa-fixture',registry:new Registry(),timeout:3000});
   await holding.query('BEGIN');await holding.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[owner]);
   const attempt=closing.verify(owner,'123456',{binding:session,scope:'audit-read'});const outcome=assert.rejects(attempt,fails('MFA_NOT_ENABLED'));
   try{
    let waiting=false;for(let i=0;i<100;i++){const row=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'",[schema])).rows[0];if(row){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(waiting,'observe actual blocked query before closing');
    let finished=false;const drained=closing.close().then(()=>{finished=true;});await Promise.resolve();assert.equal(finished,false);
    await holding.query('ROLLBACK');await outcome;await drained;await closing.close();assert.equal(finished,true);await assert.rejects(closing.status(owner),fails('MFA_STORE_CLOSED'));assert.equal((await pool.query('SELECT 1 AS alive')).rows[0].alive,1);
   }finally{await holding.query('ROLLBACK');holding.release();await closing.close();await outcome;}
  });
  await t.test('legacy enabled ciphertext stays unchanged and cannot masquerade as a verified new profile',async()=>{
   await pool.query("INSERT INTO user_mfa(user_id,secret_encrypted,secret_iv,is_enabled) VALUES($1,'legacy-unknown-cipher','legacy-unknown-iv',TRUE)",[third]);
   await assert.rejects(store.verify(third,'123456',{binding:session,scope:'audit-read'}),fails('MFA_LEGACY_PROFILE_REVIEW'));
   assert.equal((await pool.query('SELECT secret_encrypted FROM user_mfa WHERE user_id=$1',[third])).rows[0].secret_encrypted,'legacy-unknown-cipher');assert.equal((await store.status(third)).requiresMigration,true);
  });
  await t.test('populated reversal refuses to erase epochs, proofs or legacy ciphertext',async()=>{
   const before=(await pool.query('SELECT * FROM mfa_security_state ORDER BY user_id')).rows;
   const proofs=(await pool.query('SELECT * FROM mfa_auth_proofs ORDER BY proof_hash')).rows;
   await assert.rejects(apply(pool,'20261020_120000__mfa_verification_state.sql','down'),/Retain MFA replay and authentication history/);
   assert.deepEqual((await pool.query('SELECT * FROM mfa_security_state ORDER BY user_id')).rows,before);
   assert.deepEqual((await pool.query('SELECT * FROM mfa_auth_proofs ORDER BY proof_hash')).rows,proofs);
   assert.equal((await pool.query('SELECT secret_encrypted FROM user_mfa WHERE user_id=$1',[third])).rows[0].secret_encrypted,'legacy-unknown-cipher');
  });
 }finally{
  await store.close();await other.close();provider.close();await encryptedAudit.closeAuditEncryption();auditMaster.fill(0);mfaMaster.fill(0);
  for(const [key,value]of Object.entries(envBefore)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
 }
});

test('new MFA state refuses fallback-schema profiles and incompatible subject identities without adopting them',async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'owned PostGIS required');
 const suffix=crypto.randomBytes(8).toString('hex'),legacy='mfa_shadow_'+suffix,local='mfa_local_'+suffix;
 const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});let client;
 try{
  await admin.query('CREATE SCHEMA '+legacy);await admin.query('CREATE SCHEMA '+local);
  client=await admin.connect();await client.query('SET search_path TO '+legacy+',public');
  for(const name of ['users','user_mfa','mfa_recovery_codes','mfa_verification_logs'])await client.query('CREATE TABLE '+name+'(user_id uuid,note text)');
  await client.query("INSERT INTO user_mfa VALUES($1,'retained-shadow')",[crypto.randomUUID()]);
  const parsed=parseMigrationFile(await fs.readFile(path.join(root,'database/pending/20261020_120000__mfa_verification_state.sql'),'utf8'));
  const attempt=async()=>{await client.query('BEGIN');try{for(const statement of migrationStatements(parsed.up))await client.query(statement);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}};
  await client.query('SET search_path TO '+local+','+legacy+',public');
  await assert.rejects(attempt(),/MFA canonical relation requires explicit adoption/);
  assert.equal((await client.query("SELECT to_regclass('mfa_security_state') AS state")).rows[0].state,null);
  for(const name of ['users','user_mfa','mfa_recovery_codes','mfa_verification_logs'])await client.query('CREATE TABLE '+local+'.'+name+'(user_id integer,note text)');
  await assert.rejects(attempt(),/MFA requires canonical UUID subjects/);
  assert.equal((await client.query('SELECT note FROM '+legacy+'.user_mfa')).rows[0].note,'retained-shadow');
  assert.equal((await client.query("SELECT to_regclass('mfa_security_state') AS state")).rows[0].state,null);
 }finally{if(client)client.release();await admin.query('DROP SCHEMA '+local+' CASCADE');await admin.query('DROP SCHEMA '+legacy+' CASCADE');await admin.end();}
});
