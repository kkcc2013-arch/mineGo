'use strict';
const express=require('express');const Joi=require('joi');
const defaultService=require('../moveService');
const {requireAuth,AppError,errorHandler}=require('../../../../shared/auth');
const {getAllTypes}=require('../../../../shared/typeChart');
const uuid=Joi.string().pattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
const code=Joi.string().pattern(/^[A-Z][A-Z0-9_]{0,31}$/);
const listSchema=Joi.object({type:Joi.string().uppercase().valid(...getAllTypes().map(s=>s.toUpperCase())),category:Joi.string().uppercase().valid('FAST','CHARGE'),limit:Joi.number().integer().min(1).max(100).default(50),offset:Joi.number().integer().min(0).max(1e6).default(0)});
function checked(schema,value,convert=false){const result=schema.validate(value,{convert});if(result.error)throw new AppError('INVALID_REQUEST','Invalid move parameters',400);return result.value;}
function mapError(error){
  if(error instanceof AppError)return error;
  if(/not found|not owned/.test(error.message))return new AppError('NOT_FOUND',error.message,404);
  if(/already knows|slot is full|cannot learn|Elite TM|not in|currently equipped|No move specified/.test(error.message))return new AppError('INVALID_REQUEST',error.message,400);
  return error;
}
function createMoveRouter(service=defaultService){
  const router=express.Router();
  const handle=fn=>async(req,res,next)=>{try{res.json({success:true,...await fn(req)});}catch(error){next(mapError(error));}};
  router.get('/moves',handle(req=>service.getMoves(checked(listSchema,req.query,true))));
  router.get('/moves/:id',handle(async req=>{const id=checked(code,req.params.id.toUpperCase());const move=await service.getMoveById(id);if(!move)throw new AppError('NOT_FOUND','Move not found',404);return {move};}));
  router.get('/pokemon/my/:id/moves',requireAuth,handle(req=>service.getPokemonMoves(req.user.id,checked(uuid,req.params.id))));
  router.post('/pokemon/my/:id/moves/learn',requireAuth,handle(req=>{
    const id=checked(uuid,req.params.id);const body=checked(Joi.object({tmId:code.required(),forgetMoveId:code.allow(null)}),req.body);
    return service.learnMove(req.user.id,id,body.tmId,body.forgetMoveId);
  }));
  router.post('/pokemon/my/:id/moves/switch',requireAuth,handle(req=>{
    const id=checked(uuid,req.params.id);const body=checked(Joi.object({fastMoveId:code,chargeMoveId:code}).or('fastMoveId','chargeMoveId'),req.body);
    return service.switchMove(req.user.id,id,body.fastMoveId,body.chargeMoveId);
  }));
  router.post('/pokemon/my/:id/moves/forget',requireAuth,handle(req=>{
    const id=checked(uuid,req.params.id);const body=checked(Joi.object({moveId:code.required()}),req.body);
    return service.forgetMove(req.user.id,id,body.moveId);
  }));
  router.get('/pokemon/:speciesId/learnset',handle(req=>service.getSpeciesLearnset(checked(Joi.number().integer().min(1).max(32767),req.params.speciesId,true))));
  router.get('/tm/my',requireAuth,handle(req=>service.getTMInventory(req.user.id)));
  router.post('/tm/use',requireAuth,handle(req=>{
    const body=checked(Joi.object({pokemonId:uuid.required(),tmId:code.required(),forgetMoveId:code.allow(null)}),req.body);
    return service.learnMove(req.user.id,body.pokemonId,body.tmId,body.forgetMoveId);
  }));
  router.use(errorHandler);return router;
}
module.exports=createMoveRouter();module.exports.createMoveRouter=createMoveRouter;
