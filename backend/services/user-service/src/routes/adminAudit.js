'use strict';

const express = require('express');
const {requireAuth} = require('../../../../shared/auth');
const {mfaRequired} = require('../../../../gateway/src/middleware/mfaRequired');
const encrypted = require('../../../../shared/auditLogEncrypted');
const {AuditCryptoError,fail} = require('../../../../shared/audit/cryptoPrimitives');
const {getManager} = require('../../../../shared/TransactionManager');

function requireAuditPermission(req,res,next) {
  // Signed capabilities distinguish L2 access from a generic/L1 admin session.
  if (!Array.isArray(req.user.roles) || !req.user.roles.includes('admin') ||
      !Array.isArray(req.user.permissions) || !req.user.permissions.includes('audit:decrypt')) {
    return res.status(403).json({error:'AUDIT_PERMISSION_REQUIRED'});
  }
  next();
}
function reasonFor(req) {
  const reason=req.headers['x-audit-reason'];
  if(typeof reason!=='string'||reason.trim().length<3||reason.length>1024)throw fail('AUDIT_REASON_REQUIRED',400);
  return reason.trim();
}
function createAdminAuditRouter({sensitive=false}={}) {
  const router=express.Router();
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use(requireAuth,requireAuditPermission,mfaRequired({scope:'audit-read'}));
  const respond=operation=>async(req,res)=>{
    try{
      const reason=reasonFor(req);
      const result=await getManager(require('../../../../shared/db').getPool()).execute(client=>
        encrypted.useAuditStore({transactionClient:client},async store=>{
          const result=require('../../../../shared/sensitiveFields').redactP0(await operation(store,req));
          if(Buffer.byteLength(JSON.stringify(result))>8*1024*1024)throw fail('AUDIT_RESPONSE_LIMIT',413);
          await store.writeEncryptedAuditLog({
            userId:req.user.sub||req.user.id,action:'admin_audit_decrypt',
            resourceType:sensitive?'sensitive_access_logs':'audit_logs',resourceId:req.params.id||null,
            actionData:{reason,readIds:result.items?result.items.map(row=>row.id):[result.id],
              query:result.items?req.query:null,nextCursor:result.nextCursor||null},
            ipAddress:req.ip,userAgent:req.headers['user-agent']||null,requestId:req.id||req.requestId||req.reqId||null,
            service:'user-service'
          });
          return result;
        }),{timeout:10000,maxRetries:0,retryOnDeadlock:false,transactionName:'admin-audit-read'});
      res.json({success:true,data:result,p0FieldsRemoved:true});
    }catch(error){
      const known=error instanceof AuditCryptoError;
      res.status(known?error.status:503).json({error:known?error.code:'AUDIT_UNAVAILABLE'});
    }
  };
  if(sensitive){
    router.get('/',respond(async(store,req)=>{
      const allowed=['user_id','accessed_by','start_date','end_date','limit'];
      if(Object.keys(req.query).some(key=>!allowed.includes(key))||Object.values(req.query).some(value=>typeof value!=='string'))throw fail('AUDIT_FILTER_INVALID',400);
      const limit=req.query.limit===undefined?50:Number(req.query.limit);
      if(req.query.limit!==undefined&&!/^[1-9][0-9]*$/.test(req.query.limit)||!Number.isSafeInteger(limit)||limit<1||limit>50)throw fail('AUDIT_LIMIT_INVALID',400);
      const filters={userId:req.query.user_id};
      if(req.query.accessed_by!==undefined)filters.accessedBy=req.query.accessed_by;
      for(const [key,dest]of [['start_date','startDate'],['end_date','endDate']])if(req.query[key]!==undefined){
        if(!require('zod').z.string().datetime({offset:true}).safeParse(req.query[key]).success)throw fail('AUDIT_DATE_INVALID',400);
        filters[dest]=req.query[key];
      }
      const rows=await store.querySensitiveDataAccessLogs(filters,limit+1);
      if(rows.some(row=>row.error))throw fail('AUDIT_READ_INCOMPLETE',409);
      return {items:rows.slice(0,limit),hasMore:rows.length>limit};
    }));
  }else{
    router.get('/:id/decrypt',respond((store,req)=>{
      if(Object.keys(req.query).length)throw fail('AUDIT_FILTER_INVALID',400);
      return store.readEncryptedAuditLog(req.params.id);
    }));
    router.get('/',respond((store,req)=>store.queryAuditPage(req.query)));
  }
  return router;
}
module.exports=createAdminAuditRouter();
module.exports.createAdminAuditRouter=createAdminAuditRouter;
