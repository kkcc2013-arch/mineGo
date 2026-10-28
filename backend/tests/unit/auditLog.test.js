'use strict';
const crypto=require('node:crypto');
jest.mock('../../shared/logger',()=>({info:jest.fn(),error:jest.fn()}));
jest.mock('../../shared/auditLogEncrypted',()=>({useAuditStore:jest.fn()}));
const logger=require('../../shared/logger');
const encrypted=require('../../shared/auditLogEncrypted');
const {auditLog,getUserAuditLogs,getSystemAuditLogs,auditMiddleware}=require('../../shared/auditLog');
const {Pool}=require('pg');
const express=require('express');
const request=require('supertest');
const owner=crypto.randomUUID();
let store;
beforeEach(()=>{
 jest.resetAllMocks();store={writeEncryptedAuditLog:jest.fn().mockResolvedValue('9007199254740994'),initialize:jest.fn().mockResolvedValue(),pool:{query:jest.fn().mockResolvedValue({rows:[]})}};
 encrypted.useAuditStore.mockImplementation(async(options,operation)=>operation(store));
});

test('common writes delegate private values only to durable crypto and log a safe receipt',async()=>{
 const details={email:'fixture-private@example.invalid',token:'fixture-private-secret'};
 const transactionClient={query:async()=>{}};
 expect(await auditLog({userId:owner,action:'privacy',details,transactionClient,req:{ip:'192.0.2.20',id:'request-fixture',headers:{'user-agent':'fixture-private-agent','x-forwarded-for':'untrusted-forwarded'}},service:'user-service',resourceType:'user',resourceId:owner})).toBe(true);
 expect(encrypted.useAuditStore).toHaveBeenCalledWith({pool:undefined,transactionClient},expect.any(Function));
 expect(store.writeEncryptedAuditLog).toHaveBeenCalledWith(expect.objectContaining({actionData:details,ipAddress:'192.0.2.20',userAgent:'fixture-private-agent',requestId:'request-fixture'}));
 expect(logger.info).toHaveBeenCalledWith({code:'AUDIT_WRITE_PERSISTED',auditId:'9007199254740994'},'Audit record persisted');
 expect(JSON.stringify(logger.info.mock.calls)).not.toContain('fixture-private');
});

test('missing optional values still persist through the default store; untrusted forwarding is not an IP source',async()=>{
 expect(await auditLog({action:'anonymous',req:{headers:{'x-forwarded-for':'fixture-private-spoof'}}})).toBe(true);
 expect(store.writeEncryptedAuditLog).toHaveBeenCalledWith(expect.objectContaining({actionData:{},userId:undefined,ipAddress:null,userAgent:null,requestId:null,service:'unknown'}));
});

test('provider refusal and invalid call/database shapes return false without secret-bearing exception logs',async()=>{
 store.writeEncryptedAuditLog.mockRejectedValue(new Error('fixture-private-database-detail'));
 expect(await auditLog({userId:owner,action:'refused',details:{private:'fixture-private'}})).toBe(false);
 for(const value of [null,[],{},'position-call']){
  if(value&&typeof value==='object'&&!Array.isArray(value))store.writeEncryptedAuditLog.mockRejectedValue(new Error('invalid'));
  expect(await auditLog(value)).toBe(false);
 }
 expect(await auditLog({action:'x',db:{query:()=>{}}})).toBe(false);
 expect(await auditLog({action:'x',db:{getPool:()=>undefined}})).toBe(false);
 expect(await auditLog({action:'x',db:{},transactionClient:{query:()=>{}}})).toBe(false);
 expect(await auditLog('action',owner,{})).toBe(false);
 expect(JSON.stringify(logger.error.mock.calls)).not.toContain('fixture-private');
 expect(logger.error).toHaveBeenCalledWith({code:'AUDIT_WRITE_FAILED'},'Audit persistence failed');
});

test('explicit supported pool adapters are passed through without connection acquisition or ownership changes',async()=>{
 const pool=new Pool({max:1});
 try{
  for(const db of [pool,{getPool:()=>pool},{pool}]){
   expect(await auditLog({userId:owner,action:'adapter',db})).toBe(true);
   expect(encrypted.useAuditStore.mock.calls.at(-1)[0].pool).toBe(pool);
  }
  const adapter={getClient:jest.fn(),query:jest.fn()};expect(await auditLog({action:'adapter',db:adapter})).toBe(true);
  expect(adapter.getClient).not.toHaveBeenCalled();
 }finally{await pool.end();}
});

test('metadata queries use bounded canonical filters and never select payload, wrapping keys or legacy plaintext',async()=>{
 store.pool.query.mockResolvedValue({rows:[{id:'1',user_id:owner,action:'privacy',encrypted:true}]});
 const rows=await getUserAuditLogs(owner,{limit:5,action:'privacy',startDate:'2020-01-01',endDate:'2030-01-01'});
 expect(rows).toEqual([{id:'1',user_id:owner,action:'privacy',encrypted:true,detailsUnavailable:true}]);
 const [sql,args]=store.pool.query.mock.calls[0];
 expect(sql).toContain('WHERE user_id=$1 AND action=$2 AND timestamp>=$3::timestamptz AND timestamp<=$4::timestamptz');
 expect(sql).not.toMatch(/SELECT \*|SELECT[^]*?\bdetails\b/);expect(args).toEqual([owner,'privacy','2020-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z',5]);
 await getSystemAuditLogs();expect(store.pool.query.mock.calls.at(-1)[0]).not.toContain(' WHERE ');
 await getSystemAuditLogs({userId:owner,action:'privacy'});
});

test('query validation rejects unsafe subjects, filters, ranges and limits before touching storage',async()=>{
 for(const options of [{limit:0},{limit:1001},{limit:'2'},{action:''},{action:'x'.repeat(101)},{startDate:'invalid'},{startDate:'2030-01-01',endDate:'2020-01-01'},{service:'user-service'},{unexpected:true},null,[]])await expect(getSystemAuditLogs(options)).rejects.toBeDefined();
 for(const [id,options]of [[null,{}],['invalid',{}],[owner,{userId:owner}],[owner,null],[owner,[]]])await expect(getUserAuditLogs(id,options)).rejects.toBeDefined();
 expect(encrypted.useAuditStore).not.toHaveBeenCalled();
});

function appWith({fail=false,identity=true,details}={}){
 const app=express();app.locals.db={getClient:async()=>{},query:async()=>{}};
 if(fail)store.writeEncryptedAuditLog.mockRejectedValue(new Error('fixture-private-provider'));
 app.use((req,res,next)=>{if(identity)req.user={sub:owner};next();});
 app.use(auditMiddleware('fixture',details));
 app.get('/',(req,res)=>{res.cookie('private-session','fixture-private-cookie');res.json({value:'fixture-private-body'});});return app;
}
test('real HTTP middleware persists before a successful JSON response',async()=>{
 const response=await request(appWith({details:async()=>({private:'fixture-private-detail'})})).get('/');expect(response.status).toBe(200);expect(response.body.value).toBe('fixture-private-body');expect(store.writeEncryptedAuditLog).toHaveBeenCalledTimes(1);
});
test('real HTTP refusal removes private response headers and withholds its body',async()=>{
 const response=await request(appWith({fail:true})).get('/');expect(response.status).toBe(503);expect(response.body).toEqual({error:'AUDIT_WRITE_FAILED'});expect(response.headers['set-cookie']).toBeUndefined();expect(response.headers.etag).toBeUndefined();expect(response.headers['cache-control']).toBe('no-store');
});
test('anonymous actions are durably audited and detail-provider failures withhold the response',async()=>{
 expect((await request(appWith({identity:false})).get('/')).status).toBe(200);expect(store.writeEncryptedAuditLog.mock.calls[0][0].userId).toBeUndefined();
 const response=await request(appWith({details:async()=>{throw new Error('fixture-private-detail-failure');}})).get('/');expect(response.status).toBe(503);expect(response.body).toEqual({error:'AUDIT_WRITE_FAILED'});
});
