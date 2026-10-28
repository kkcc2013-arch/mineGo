'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const speakeasy=require('speakeasy');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {counterFor,recoveryCodes}=require('../../shared/mfa/MFAStore');

test('TOTP matches the RFC6238 SHA1 reference cases including times beyond 2038',()=>{
 const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
 for(const [epoch,code]of [[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130']])assert.equal(counterFor(secret,code,epoch),Math.floor(epoch/30));
 assert.equal(counterFor(secret,speakeasy.totp({secret,encoding:'base32',time:0}),0),0);
});
test('original plus/minus two windows accept at least99percent of actual valid samples without coercing malformed factors',()=>{
 let samples=0,accepted=0;
 for(let i=0;i<100;i++){
  const secret=speakeasy.generateSecret({length:20}).base32;const time=2000000000+i*120;
  for(let drift=-2;drift<=2;drift++){
   const code=speakeasy.totp({secret,encoding:'base32',time:time+drift*30});samples++;if(counterFor(secret,code,time)!==null)accepted++;
  }
  for(const code of [null,123456,{},'12345','1234567','123456\n','١٢٣٤٥٦'])assert.equal(counterFor(secret,code,time),null);
 }
 assert.equal(samples,500);assert.ok(accepted/samples>=0.99);process.stdout.write(JSON.stringify({totpControlledWindowSamples:samples,accepted,acceptanceRate:accepted/samples,scope:'RFC and controlled time windows, not device/clock/network availability'})+'\n');
});
test('recovery sets have exactly eight unique cryptographic codes in the original four-plus-four format',()=>{
 for(let i=0;i<20;i++){const codes=recoveryCodes();assert.equal(codes.length,8);assert.equal(new Set(codes).size,8);assert.ok(codes.every(code=>/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(code)));}
});

test('production sync JWT boundaries cannot select development keys through a legacy KMS flag',()=>{
 const script="const a=require('./backend/shared/auth');a.verifyAccess(a.signAccess({sub:'fixture'}));process.stdout.write('production-keys-loaded');";
 const absent=spawnSync(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'../../..'),env:{...process.env,NODE_ENV:'production',KMS_ENABLED:'true',JWT_ACCESS_SECRET:'',JWT_REFRESH_SECRET:''},encoding:'utf8',timeout:5000});assert.notEqual(absent.status,0);assert.ok(!absent.stdout.includes('production-keys-loaded'));
 const configured=spawnSync(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'../../..'),env:{...process.env,NODE_ENV:'production',KMS_ENABLED:'true',JWT_ACCESS_SECRET:'fixture-explicit-production-access',JWT_REFRESH_SECRET:'fixture-explicit-production-refresh'},encoding:'utf8',timeout:5000});assert.equal(configured.status,0);assert.ok(configured.stdout.includes('production-keys-loaded'));
});
