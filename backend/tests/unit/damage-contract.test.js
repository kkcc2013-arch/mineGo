'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {calculateDamage,estimateAverageDamage}=require('../../shared/damageCalculator');
const {getAllTypes,isValidType,getTypeMultiplier,getTypeEffectiveness}=require('../../shared/typeChart');
const base={power:100,attack:120,defense:100,attackType:'fire',attackerType1:'fire',defenderType1:'grass',weatherBoost:'sunny'};
test('actual damage formula applies STAB, type, weather and controlled real draw correctly',()=>{
  assert.equal(calculateDamage(base,()=>0).damage,147);
  assert.equal(calculateDamage(base,()=>0.5).damage,160);
  assert.equal(calculateDamage({...base,criticalHit:true},()=>0).damage,221);
  assert.deepEqual(estimateAverageDamage({...base,criticalHit:true}),{minDamage:221,maxDamage:260,avgDamage:240,effectiveness:'super_effective',typeMultiplier:2});
});
test('midpoint estimates are stable and actual draws remain bounded by the estimates',()=>{
  const estimate=estimateAverageDamage(base);
  for(let i=0;i<20;i++){
    assert.deepEqual(estimateAverageDamage(base),estimate);
    const result=calculateDamage(base);assert.ok(result.damage>=estimate.minDamage&&result.damage<=estimate.maxDamage);
  }
});
test('immune and zero-power moves produce zero estimates and no random draw',()=>{
  for(const params of [{...base,attackType:'normal',defenderType1:'ghost'},{...base,power:0}]){
    const result=calculateDamage(params,()=>{throw new Error('Unexpected draw for zero damage');});assert.equal(result.damage,0);
    const estimate=estimateAverageDamage(params);assert.deepEqual([estimate.minDamage,estimate.maxDamage,estimate.avgDamage],[0,0,0]);
  }
});
test('all18 own types are recognized; dual weaknesses and immunity follow declared matrix',()=>{
  assert.equal(getAllTypes().length,18);assert.ok(getAllTypes().every(isValidType));
  assert.equal(getTypeMultiplier('fire','grass','bug'),4);assert.equal(getTypeMultiplier('water','fire','rock'),4);
  assert.equal(getTypeMultiplier('ground','flying','electric'),0);
  for(const name of ['__proto__','constructor','toString','unknown',{},[],null]){assert.equal(isValidType(name),false);assert.deepEqual(getTypeEffectiveness(name),{});}
});
test('invalid numerics, types, weather, flags and random sources are rejected rather than clamped',()=>{
  for(const field of ['power','attack','defense'])for(const value of [-1,Infinity,NaN,'10',1e7])assert.throws(()=>calculateDamage({...base,[field]:value}),/Invalid/);
  for(const field of ['attack','defense'])assert.throws(()=>calculateDamage({...base,[field]:0}),/Invalid/);
  for(const field of ['attackType','attackerType1','defenderType1','defenderType2'])assert.throws(()=>calculateDamage({...base,[field]:'constructor'}),/Invalid/);
  for(const weatherBoost of [['sunny'],{},'constructor'])assert.throws(()=>calculateDamage({...base,weatherBoost}),/Invalid/);
  assert.throws(()=>calculateDamage({...base,criticalHit:1}),/Invalid/);
  for(const value of [-1,1,NaN,Infinity,'0.5'])assert.throws(()=>calculateDamage(base,()=>value),/Invalid/);
  for(const randomFactor of [0,1.1,NaN,'0.925'])assert.throws(()=>calculateDamage({...base,randomFactor}),/Invalid/);
});
