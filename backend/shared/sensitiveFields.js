'use strict';

// One classification source for existing response filtering and privileged reads.
const SENSITIVITY_LEVELS={
  P0:['password','payment_token','card_number','cvv','card_cvv','ssn','id_card_number'],
  P1:['email','phone','real_name','address','billing_address','shipping_address','full_name'],
  P2:['birthday','gender','location_history','ip_address','device_id','last_login_ip'],
  P3:['user_id','username','avatar','nickname','display_name']
};
const normalize=key=>key.toLowerCase().replace(/[^a-z0-9]/g,'');
const credentials=new Set([...SENSITIVITY_LEVELS.P0,'password_hash','access_token','refresh_token','token','secret','secret_encrypted','encrypted_key','master_key','private_key','api_key','signing_key','authorization','cookie','mfa_token','otpauth_url','qr_code_data_url','__proto__','prototype','constructor'].map(normalize));
function redactP0(value,depth=0){
  if(depth>64)throw new RangeError('Sensitive payload depth exceeded');
  if(value===null||typeof value!=='object')return value;
  if(value instanceof Date)return value.toISOString();
  if(Array.isArray(value))return value.map(item=>redactP0(item,depth+1));
  return Object.fromEntries(Object.entries(value).filter(([key])=>!credentials.has(normalize(key))).map(([key,item])=>[key,redactP0(item,depth+1)]));
}
module.exports={SENSITIVITY_LEVELS,redactP0};
