'use strict';

const express = require('express');
const {requireAuth,requireAdmin,AppError} = require('../../../../shared/auth');
const {RiskVerifier} = require('../../../../shared/riskVerifier');
const {getErasureStore,identity} = require('../../../../shared/erasure/ErasureRequestStore');
const ownerPolicy = () => ({operation:'user.account.delete',scope:'delete-account',mandatory:true});
const readPolicy = () => ({operation:'user.erasure.read',scope:'delete-account',mandatory:false});
const adminPolicy = () => ({operation:'admin.erasure.review',scope:'erasure-admin',mandatory:true});
function respond(fn) {
  return async (req,res) => {
    res.set('Cache-Control','no-store');
    try {await fn(req,res);} catch(error) {
      const known=error instanceof AppError;
      res.status(known?error.httpStatus:503).json({success:false,code:known?error.code:'ERASURE_UNAVAILABLE',message:known?error.code:'ERASURE_UNAVAILABLE'});
    }
  };
}
function input(req) {
  const body=req.body;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['requestType','reason','dataTypes'].includes(k)))throw new AppError('ERASURE_INPUT_INVALID','ERASURE_INPUT_INVALID',400);
  return body;
}
function createErasureRouter({store=getErasureStore(),risk=new RiskVerifier()}={}) {
  const router=express.Router();
  router.use(requireAuth,risk.middleware());
  router.post('/requests',risk.middleware(ownerPolicy),respond(async(req,res)=>res.status(201).json({success:true,data:await store.createRequest(req.user.sub,input(req))})));
  router.post('/requests/:id/verify',risk.middleware(ownerPolicy),respond(async(req,res)=>res.json({success:true,data:await store.verifyRequest(req.user.sub,req.params.id,req.body?.verificationCode)})));
  router.post('/requests/:id/cancel',risk.middleware(ownerPolicy),respond(async(req,res)=>res.json({success:true,data:await store.cancelRequest(req.user.sub,req.params.id)})));
  router.get('/requests',risk.middleware(readPolicy),respond(async(req,res)=>res.json({success:true,data:await store.list(req.user.sub,req.query)})));
  router.get('/requests/:id',risk.middleware(readPolicy),respond(async(req,res)=>res.json({success:true,data:await store.detail(req.user.sub,req.params.id)})));
  router.get('/certificates/:certificateNumber',risk.middleware(readPolicy),respond(async(req,res)=>res.json({success:true,data:await store.certificate(req.user.sub,req.params.certificateNumber)})));
  router.use('/admin',requireAdmin,risk.middleware(adminPolicy));
  router.get('/admin/pending',respond(async(req,res)=>res.json({success:true,data:await store.list(null,{...req.query,status:'verifying'})})));
  router.get('/admin/requests',respond(async(req,res)=>res.json({success:true,data:await store.list(null,req.query)})));
  router.get('/admin/statistics',respond(async(req,res)=>res.json({success:true,data:await store.statistics()})));
  router.get('/admin/requests/:id',respond(async(req,res)=>res.json({success:true,data:await store.detail(req.user.sub,req.params.id,{admin:true})})));
  router.get('/admin/requests/:id/plan',respond(async(req,res)=>res.json({success:true,data:await store.planRequest(req.params.id,req.user.sub)})));
  router.post('/admin/requests/:id/approve',respond(async(req,res)=>res.json({success:true,data:await store.decide(req.params.id,req.user.sub,'approve')})));
  router.post('/admin/requests/:id/reject',respond(async(req,res)=>res.json({success:true,data:await store.decide(req.params.id,req.user.sub,'reject',req.body?.reason)})));
  router.post('/admin/requests/:id/execute',respond(async(req,res)=>{
    identity(req.params.id);await store.detail(req.user.sub,req.params.id,{admin:true});
    throw new AppError('ERASURE_RESOURCE_PLAN_REQUIRED','ERASURE_RESOURCE_PLAN_REQUIRED',503);
  }));
  router.get('/admin/certificates/:certificateNumber',respond(async(req,res)=>res.json({success:true,data:await store.certificate(req.user.sub,req.params.certificateNumber,{admin:true})})));
  return router;
}
const router=createErasureRouter();
function initDataDeletionRoutes(){return router;}
module.exports={router,initDataDeletionRoutes,createErasureRouter,ownerPolicy,readPolicy,respond};
