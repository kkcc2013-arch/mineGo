'use strict';
const express=require('express');
const Joi=require('joi');
const exchangeRateService=require('../../../../shared/exchangeRateService');
const formatter=require('../../../../shared/currencyFormatter');
const db=require('../../../../shared/db');
const {requireAuth,requireAdmin,successResp,AppError}=require('../../../../shared/auth');

const code=Joi.string().valid(...formatter.getSupportedCurrencies());
const product=Joi.string().pattern(/^[A-Za-z0-9_-]{1,100}$/);
const amount=Joi.alternatives().try(Joi.number().min(0).max(1e12),Joi.string().pattern(/^\d{1,13}(?:\.\d{1,10})?$/));
function validated(schema,value){const result=schema.validate(value,{convert:false});if(result.error)throw new AppError(400,'Invalid currency parameters',400);return result.value;}
function handler(fn){return async(req,res,next)=>{try{await fn(req,res);}catch(error){
  if(error instanceof AppError)return next(error);
  if(/Unsupported currency|Invalid (conversion|lock|rate)|safe display range|Authenticated owner/.test(error.message))return next(new AppError(400,'Invalid currency parameters',400));
  if(/Failed to fetch exchange rate|Durable quote|Rate lock not found/.test(error.message))return next(new AppError(503,'Exchange quote unavailable',503));
  next(error);
}};}
function createCurrencyRouter(service=exchangeRateService,database=db){
  const router=express.Router();
  router.get('/',handler(async(_req,res)=>{const currencies=await service.getSupportedCurrencies();res.json(successResp({currencies,count:currencies.length}));}));
  router.get('/rates',handler(async(req,res)=>{
    const {from='USD',to}=validated(Joi.object({from:code,to:Joi.string().pattern(/^[A-Z]{3}(,[A-Z]{3}){0,19}$/).required()}),req.query);
    const targets=to.split(',');for(const currency of targets)validated(code,currency);
    res.json(successResp({base:from,rates:await service.getRates(from,targets),timestamp:new Date().toISOString()}));
  }));
  router.post('/convert',(req,res,next)=>req.body?.lockRate===true?requireAuth(req,res,next):next(),handler(async(req,res)=>{
    const {amount:original,from,to,lockRate=false}=validated(Joi.object({amount:amount.required(),from:code.required(),to:code.required(),lockRate:Joi.boolean()}),req.body);
    const lock=lockRate?await service.lockRate(from,to,15,req.user.sub):null;
    const converted=await service.convert(original,from,to,{lockId:lock?.lockId,userId:req.user?.sub});
    res.json(successResp({original:{amount:Number(original),currency:from,formatted:formatter.format(Number(original),from)},
      converted:{amount:converted.convertedAmount,amountExact:converted.amountExact,currency:to,formatted:formatter.format(converted.convertedAmount,to)},
      rate:converted.rate,rateLock:lock?{lockId:lock.lockId,expiresAt:lock.expiresAt}:null,timestamp:new Date().toISOString()}));
  }));
  router.get('/prices/:productId',handler(async(req,res)=>{
    const id=validated(product,req.params.productId),{currency='USD'}=validated(Joi.object({currency:code}),req.query);
    const {rows:[local]}=await database.query('SELECT price,original_price,updated_at FROM product_prices WHERE product_id=$1 AND currency_code=$2',[id,currency]);
    if(local)return res.json(successResp({productId:id,currency,price:Number(local.price),amountExact:local.price,originalPrice:local.original_price==null?null:Number(local.original_price),formatted:formatter.format(Number(local.price),currency),source:'localized'}));
    const {rows:[base]}=await database.query("SELECT price FROM product_prices WHERE product_id=$1 AND currency_code='USD'",[id]);
    if(!base)throw new AppError(404,'Product not found',404);
    const converted=await service.convert(base.price,'USD',currency);
    res.json(successResp({productId:id,currency,price:converted.convertedAmount,amountExact:converted.amountExact,rate:converted.rate,formatted:formatter.format(converted.convertedAmount,currency),source:'converted',basePrice:{amount:Number(base.price),currency:'USD'}}));
  }));
  router.post('/lock-rate',requireAuth,handler(async(req,res)=>{
    const {from,to,durationMinutes=15}=validated(Joi.object({from:code.required(),to:code.required(),durationMinutes:Joi.number().integer().min(1).max(15)}),req.body);
    const lock=await service.lockRate(from,to,durationMinutes,req.user.sub);res.json(successResp({lockId:lock.lockId,rate:lock.lockedRate,expiresAt:lock.expiresAt}));
  }));
  router.post('/preference',requireAuth,handler(async(req,res)=>{
    const {currency,autoDetect=true}=validated(Joi.object({currency:code.required(),autoDetect:Joi.boolean()}),req.body);
    const {rowCount}=await database.query('UPDATE users SET preferred_currency=$1,currency_auto_detect=$2,updated_at=NOW() WHERE id=$3',[currency,autoDetect,req.user.sub]);
    if(!rowCount)throw new AppError(404,'User not found',404);res.json(successResp({currency,autoDetect}));
  }));
  router.get('/preference',requireAuth,handler(async(req,res)=>{
    const {rows:[user]}=await database.query('SELECT preferred_currency,currency_auto_detect FROM users WHERE id=$1',[req.user.sub]);
    if(!user)throw new AppError(404,'User not found',404);res.json(successResp({currency:user.preferred_currency,autoDetect:user.currency_auto_detect}));
  }));
  const detect=handler(async(req,res)=>{const {country}=validated(Joi.object({country:Joi.string().pattern(/^[A-Za-z]{2}$/).required()}),req.method==='GET'?req.query:req.body);res.json(successResp({country,currency:formatter.detectCurrency(country)}));});
  router.get('/detect',detect);router.post('/detect',detect);
  router.post('/admin/refresh-rates',requireAuth,requireAdmin,handler(async(_req,res)=>{const result=await service.refreshAllRates();res.json(successResp({refreshed:result.successCount,failed:result.failureCount}));}));
  router.post('/admin/cleanup-locks',requireAuth,requireAdmin,handler(async(_req,res)=>res.json(successResp({cleaned:await service.cleanupExpiredLocks()}))));
  router.post('/admin/set-price',requireAuth,requireAdmin,handler(async(req,res)=>{
    const {productId,currency,price,originalPrice=null}=validated(Joi.object({productId:product.required(),currency:code.required(),price:Joi.number().positive().max(1e12).required(),originalPrice:Joi.number().positive().max(1e12).allow(null)}),req.body);
    const places=formatter.getConfig(currency).decimalPlaces;
    if(!/^\d+(?:\.\d+)?$/.test(String(price)) || (String(price).split('.')[1]?.length??0)>places || originalPrice!==null&&(!/^\d+(?:\.\d+)?$/.test(String(originalPrice))||(String(originalPrice).split('.')[1]?.length??0)>places))throw new AppError(400,'Price exceeds currency precision',400);
    await database.query(`INSERT INTO product_prices(product_id,currency_code,price,original_price,updated_at) VALUES($1,$2,$3,$4,NOW())
      ON CONFLICT(product_id,currency_code) DO UPDATE SET price=EXCLUDED.price,original_price=EXCLUDED.original_price,updated_at=NOW()`,[productId,currency,price,originalPrice]);
    res.json(successResp({productId,currency,price,originalPrice}));
  }));
  return router;
}
module.exports=createCurrencyRouter();
module.exports.createCurrencyRouter=createCurrencyRouter;
