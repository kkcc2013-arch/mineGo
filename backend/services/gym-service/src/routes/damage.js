'use strict';
const express = require('express');
const Joi = require('joi');
const { simulateDamage } = require('../damageEngine');
const { WEATHER_BOOST_MAP } = require('../../../../shared/damageCalculator');
const { TYPE_CHART, getTypeMultiplier, getAllTypes, isValidType, getEffectivenessText } = require('../../../../shared/typeChart');
const { requireAuth, successResp, AppError } = require('../../../../shared/auth');
const { query } = require('../../../../shared/db');

const moveId = Joi.string().pattern(/^[A-Za-z][A-Za-z0-9_]{0,31}$/);
const simulationSchema = Joi.object({
  attacker: Joi.object({ species_id:Joi.number().integer().min(1).max(32767).required(), attack:Joi.number().min(1).max(1e6).required(), fast_move:moveId, charged_move:moveId }).oxor('fast_move','charged_move').required(),
  defender: Joi.object({ species_id:Joi.number().integer().min(1).max(32767).required(), defense:Joi.number().min(1).max(1e6).required() }).required(),
  weather: Joi.string().valid(...Object.keys(WEATHER_BOOST_MAP)).allow(null)
});

function createDamageRouter(queryFn = query) {
  const router = express.Router();
  router.post('/simulate', requireAuth, async (req,res,next) => {
    try {
      const {error,value} = simulationSchema.validate(req.body,{convert:false});
      if(error) throw new AppError(3001,'Invalid damage simulation parameters',400);
      const {attacker,defender,weather} = value;
      const {rows} = await queryFn('SELECT id,name_en,type1,type2 FROM pokemon_species WHERE id=ANY($1::smallint[])',[ [attacker.species_id,defender.species_id] ]);
      const attackerSpecies = rows.find(row=>row.id===attacker.species_id);
      const defenderSpecies = rows.find(row=>row.id===defender.species_id);
      if(!attackerSpecies) throw new AppError(3004,'Attacker species not found',404);
      if(!defenderSpecies) throw new AppError(3005,'Defender species not found',404);
      const id = (attacker.charged_move ?? attacker.fast_move ?? 'TACKLE').toUpperCase();
      const {rows:[move]} = await queryFn('SELECT id,name_en,type,category,power FROM moves WHERE id=$1',[id]);
      if(!move) throw new AppError(3010,'Move not found',404);
      if(move.category !== (attacker.charged_move ? 'CHARGE' : 'FAST')) throw new AppError(3011,'Move does not match the requested slot',400);
      const data = simulateDamage({attackerSpecies,defenderSpecies,move,attack:attacker.attack,defense:defender.defense,weather:weather ?? null});
      res.json({...successResp(data),damage_multiplier:data.damageMultiplier});
    } catch(error) { next(error); }
  });
  router.get('/typechart',(_req,res)=>res.json(successResp({types:getAllTypes(),chart:TYPE_CHART,totalTypes:getAllTypes().length})));
  router.get('/effectiveness',(req,res,next)=>{
    try {
      const {attackType,defenderType1,defenderType2} = req.query;
      if(!isValidType(attackType) || !isValidType(defenderType1) || (defenderType2 !== undefined && !isValidType(defenderType2))) throw new AppError(3007,'Invalid Pokemon type',400);
      const multiplier = getTypeMultiplier(attackType,defenderType1,defenderType2 ?? null);
      res.json(successResp({attackType,defenderType1,defenderType2:defenderType2 ?? null,multiplier,description:getEffectivenessText(multiplier)}));
    } catch(error) { next(error); }
  });
  router.get('/weather',(_req,res)=>res.json(successResp({weatherBoosts:WEATHER_BOOST_MAP,description:'Weather boosts matching move types by20%'})));
  return router;
}
module.exports = createDamageRouter();
module.exports.createDamageRouter = createDamageRouter;
