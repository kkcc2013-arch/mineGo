'use strict';
// REQ-00099/REQ-00120: authenticated operations on actual numeric history IDs.
const {Router}=require('express');
const {requireAuth,successResp,errorHandler}=require('../../../../shared/auth');
const {notificationService}=require('../notificationService');
function createMessageCenterRouter(service=notificationService){
  const router=Router();router.use(requireAuth);
  const action=(method,path,fn)=>router[method](path,async(req,res,next)=>{try{res.json(successResp(await fn(req)));}catch(error){next(error);}});
  action('get','/',req=>service.list(req.user.id,req.query));
  action('delete','/',req=>service.clearAll(req.user.id));
  action('get','/unread-count',req=>service.unreadCount(req.user.id));
  action('get','/stats',req=>service.stats(req.user.id));
  action('patch','/preferences',req=>service.updatePreferences(req.user.id,req.body));
  action('post','/batch-read',req=>service.batchRead(req.user.id,req.body));
  action('post','/clear-read',req=>service.clearRead(req.user.id,req.body));
  action('put','/read-all',req=>service.batchRead(req.user.id,{all:true}));
  action('put','/:id/read',req=>service.markRead(req.user.id,req.params.id));
  action('patch','/:id/read',req=>service.markRead(req.user.id,req.params.id));
  action('delete','/:id',req=>service.remove(req.user.id,req.params.id));
  router.use(errorHandler);return router;
}
module.exports=createMessageCenterRouter();module.exports.createMessageCenterRouter=createMessageCenterRouter;
