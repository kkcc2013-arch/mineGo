'use strict';
const {Router}=require('express');
const {query}=require('../../../../shared/db');
const {requireAuth,AppError,successResp}=require('../../../../shared/auth');
const {notificationService,integer}=require('../notificationService');
const {NOTIFICATION_TYPES}=require('../../../../shared/notification/contracts');
function createNotificationRouter(service=notificationService,dbQuery=query){
  const router=Router();router.use(requireAuth);
  const action=(method,path,fn)=>router[method](path,async(req,res,next)=>{try{res.json(successResp(await fn(req)));}catch(error){next(error);}});
  action('get','/preferences',req=>service.getPreferences(req.user.id));
  action('post','/preferences',req=>service.updatePreferences(req.user.id,req.body));
  action('put','/preferences',req=>service.updatePreferences(req.user.id,req.body));
  function tokenField(platform){if(!['ios','android'].includes(platform))throw new AppError('INVALID_REQUEST','Invalid device platform',400);return platform==='ios'?'apns_token':'fcm_token';}
  action('post','/device-token',async req=>{
    const field=tokenField(req.body.platform);const token=req.body.token;
    if(typeof token!=='string'||!token.trim()||token.length>4096||/\s/.test(token))throw new AppError('INVALID_REQUEST','Invalid device token',400);
    await dbQuery(`INSERT INTO user_push_preferences(user_id,${field}) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET ${field}=EXCLUDED.${field},updated_at=NOW()`,[req.user.id,token]);return {registered:true};
  });
  action('delete','/device-token',async req=>{const field=tokenField(req.body.platform);await dbQuery(`UPDATE user_push_preferences SET ${field}=NULL,updated_at=NOW() WHERE user_id=$1`,[req.user.id]);return {removed:true};});
  action('get','/logs',async req=>(await dbQuery('SELECT channel,notification_type,title,body,success,error_message,created_at FROM push_logs WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2',[req.user.id,integer(req.query.limit??50,'limit',{max:100})])).rows);
  return router;
}
function createLegacyPreferenceRouter(service=notificationService){
  const router=Router();router.use(requireAuth);
  const keys={rareSpawn:'rare_spawn',raidStarted:'raid_started',friendRequest:'friend_request',giftReceived:'gift_received',questComplete:'quest_complete',gymUnderAttack:'gym_under_attack',gymLost:'gym_lost'};
  router.get('/',async(req,res,next)=>{try{const prefs=await service.getPreferences(req.user.id);res.json(successResp({...Object.fromEntries(Object.entries(keys).map(([camel,key])=>[camel,prefs.notificationTypes[key]])),soundEnabled:prefs.soundEnabled,vibrationEnabled:prefs.vibrationEnabled}));}catch(error){next(error);}});
  router.put('/',async(req,res,next)=>{try{
    if(!req.body||Array.isArray(req.body)||Object.keys(req.body).some(key=>!Object.hasOwn(keys,key)&&!['soundEnabled','vibrationEnabled'].includes(key)))throw new AppError('INVALID_REQUEST','Invalid legacy preference fields',400);
    const notificationTypes=Object.fromEntries(Object.entries(req.body).filter(([key])=>Object.hasOwn(keys,key)).map(([key,value])=>[keys[key],value]));const input={notificationTypes};
    for(const key of ['soundEnabled','vibrationEnabled'])if(req.body[key]!==undefined)input[key]=req.body[key];
    if(!Object.keys(req.body).length)throw new AppError('INVALID_REQUEST','Empty preference update',400);
    res.json(successResp(await service.updatePreferences(req.user.id,input)));
  }catch(error){next(error);}});
  return router;
}
module.exports=createNotificationRouter();Object.assign(module.exports,{createNotificationRouter,createLegacyPreferenceRouter,NOTIFICATION_TYPES,createNotification:notificationService.createNotification.bind(notificationService)});
