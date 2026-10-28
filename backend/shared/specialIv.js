'use strict';
// REQ-00160: exclusive zero/perfect generation, including ordinary IV bonuses.
function generateWildIVs({ivBonus=0,random=Math.random}={}) {
  if(typeof ivBonus!=='number'||!Number.isFinite(ivBonus)||ivBonus<0||ivBonus>=1)throw new Error('Invalid normal IV bonus');
  if(typeof random!=='function')throw new Error('Invalid random source');
  const draw=()=>{const value=random();if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>=1)throw new Error('Invalid random draw');return value;};
  const roll=draw();
  if(roll<0.0001)return {iv_attack:0,iv_defense:0,iv_hp:0,is_zero_iv:true,is_perfect_iv:false};
  if(roll<0.001)return {iv_attack:15,iv_defense:15,iv_hp:15,is_zero_iv:false,is_perfect_iv:true};
  const boost=Math.floor(ivBonus*15);
  for(let attempt=0;attempt<128;attempt++) {
    const values=Array.from({length:3},()=>Math.min(15,Math.floor(draw()*16)+boost));
    // Natural/boosted extremes would inflate the explicitly required 0.01%/0.09%
    // categories. Normal draws retain their distribution conditional on this rule.
    if(values.every(v=>v===0)||values.every(v=>v===15))continue;
    return {iv_attack:values[0],iv_defense:values[1],iv_hp:values[2],is_zero_iv:false,is_perfect_iv:false};
  }
  throw new Error('Random source failed to generate an ordinary IV tuple');
}
module.exports={generateWildIVs};
