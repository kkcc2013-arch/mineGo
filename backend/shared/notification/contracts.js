'use strict';
const definitions={
  RARE_SPAWN:{key:'rare_spawn',label:'稀有精灵',icon:'🐉',category:'pokemon'},
  RAID_STARTED:{key:'raid_started',label:'Raid 战斗',icon:'⚔️',category:'raid'},
  FRIEND_REQUEST:{key:'friend_request',label:'好友请求',icon:'👥',category:'friend'},
  GIFT_RECEIVED:{key:'gift_received',label:'礼物接收',icon:'🎁',category:'friend'},
  QUEST_COMPLETE:{key:'quest_complete',label:'任务完成',icon:'✅',category:'reward'},
  GYM_UNDER_ATTACK:{key:'gym_under_attack',label:'道馆受到攻击',icon:'🛡️',category:'raid'},
  GYM_LOST:{key:'gym_lost',label:'道馆失守',icon:'🏟️',category:'raid'},
  SYSTEM:{key:'system',label:'系统通知',icon:'📢',category:'system'},
  TRADE_REQUEST:{key:'trade_request',label:'交易请求',icon:'🔄',category:'friend'}
};
const NOTIFICATION_TYPES=Object.freeze(Object.fromEntries(Object.keys(definitions).map(type=>[type,type])));
const aliases=new Map(Object.entries(definitions).flatMap(([type,info])=>[[type.toLowerCase(),type],[info.key.replaceAll('_',''),type]]));
for(const [alias,type] of Object.entries({gym_raid:'RAID_STARTED',reward:'QUEST_COMPLETE'}))aliases.set(alias,type);
function normalizeType(value){return typeof value==='string'?aliases.get(value.toLowerCase())||null:null;}
const defaults=Object.freeze(Object.fromEntries(Object.entries(definitions).map(([type,info])=>[info.key,type!=='GYM_LOST'])));
const legacyColumns=Object.freeze({rare_spawn:'rare_spawn',raid_started:'raid_started',friend_request:'friend_request',gift_received:'gift_received',quest_complete:'quest_complete',gym_under_attack:'gym_under_attack',gym_lost:'gym_lost'});
function preferenceTypes(raw={},legacy={}){
  const result={...defaults};for(const key of Object.keys(legacyColumns))if(typeof legacy[key]==='boolean')result[key]=legacy[key];
  // Family keys are older aliases. An explicit exact key takes precedence.
  for(const exact of [false,true])for(const [key,value] of Object.entries(raw||{})){
    const type=normalizeType(key);if(!type||typeof value!=='boolean')continue;
    if((key.toLowerCase()===definitions[type].key)!==exact)continue;result[definitions[type].key]=value;
  }
  return result;
}
function typeEnabled(preferences,type){const canonical=normalizeType(type);return canonical?preferences[definitions[canonical].key]===true:false;}
function quietNow(settings,now=new Date(),timeZone='UTC'){
  if(!settings||settings.enabled!==true)return false;
  const {start,end}=settings;if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(end))throw new Error('Invalid stored quiet hours');
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:settings.timeZone||timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const time=parts.find(p=>p.type==='hour').value+':'+parts.find(p=>p.type==='minute').value;
  return start<end?time>=start&&time<end:time>=start||time<end;
}
function textFor(type,data={}){
  const info=definitions[type]||{label:'通知'};
  const name=value=>typeof value==='string'?value:'';
  const title=name(data.title)||info.label;let body=name(data.body);
  if(!body)switch(type){
    case 'RARE_SPAWN':body=[name(data.speciesName),Number.isFinite(data.distance)?`距离 ${data.distance} 米`:''].filter(Boolean).join('，');break;
    case 'RAID_STARTED':body=[name(data.gymName),name(data.bossName)].filter(Boolean).join(' · ');break;
    case 'FRIEND_REQUEST':body=name(data.fromUserName)?`${data.fromUserName} 请求添加好友`:'';break;
    case 'GIFT_RECEIVED':body=name(data.fromUserName)?`${data.fromUserName} 送来了礼物`:'';break;
    case 'QUEST_COMPLETE':body=name(data.questName);break;
    case 'GYM_UNDER_ATTACK':case 'GYM_LOST':body=name(data.gymName);break;
    default:break;
  }
  return {title,body};
}
module.exports={definitions,NOTIFICATION_TYPES,normalizeType,defaults,legacyColumns,preferenceTypes,typeEnabled,quietNow,textFor};
