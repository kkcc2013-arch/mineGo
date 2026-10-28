'use strict';
const fs=require('node:fs');const path=require('node:path');const yaml=require('js-yaml');
const {globRegex,patternMatcher}=require('../cache/CoherentCache');
const KEY_FIELDS=Object.freeze({users:['id'],pokemon_species:['id'],pokemon_instances:['id','user_id','species_id'],candy_inventory:['user_id','species_id'],pokedex_entries:['user_id','species_id'],catch_records:['id','user_id'],gyms:['id'],gym_defenders:['id','gym_id','user_id','pokemon_id'],raids:['id','gym_id'],raid_participants:['id','raid_id','user_id'],friendships:['id','user_a','user_b'],friend_gifts:['id','sender_id','receiver_id'],pokemon_trades:['id','initiator_id','receiver_id','offered_pokemon','received_pokemon'],items:['id','item_id'],player_inventory:['id','user_id','item_id'],daily_quests:['id','user_id'],user_achievements:['user_id','achievement_id'],orders:['id','user_id']});
const clone=value=>JSON.parse(JSON.stringify(value));
const escapeGlob=value=>String(value).replace(/[\\*?\[\]]/g,'\\$&');
const escapeRegex=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const invalid=message=>Object.assign(new Error(message),{status:400,code:'INVALID_CACHE_RULE'});
function normalizeRule(rule,table){
  if(typeof rule==='string')rule={type:'glob',pattern:rule};
  if(!rule||Object.keys(rule).some(k=>!['type','pattern'].includes(k))||!['glob','regex'].includes(rule.type)||typeof rule.pattern!=='string'||rule.pattern.length>512)throw invalid('Invalid cache rule');
  const placeholders=[...rule.pattern.matchAll(/\{([a-z_]+)\}/g)].map(x=>x[1]);
  if(placeholders.some(field=>!KEY_FIELDS[table].includes(field)))throw invalid('Rule uses an unavailable identity field');
  const example=rule.pattern.replace(/\{([a-z_]+)\}/g,'identity');
  if(!/^(\^)?(?:api:|pokemon:|stamina:|user:|gym:|item:|items:|query:)/.test(example))throw invalid('Rule must target a supported data-cache prefix');
  try{patternMatcher({...rule,pattern:example});}catch(error){throw invalid(error.message);}
  return {type:rule.type,pattern:rule.pattern};
}
class ChangeToCacheMapper {
  constructor(document={version:1,customRules:{}},{file=path.join(__dirname,'cache-rules.yml')}={}){
    const baseline=yaml.load(fs.readFileSync(file,'utf8'),{schema:yaml.JSON_SCHEMA});
    if(baseline?.version!==1||!baseline.rules||Object.keys(baseline.rules).sort().join()!==Object.keys(KEY_FIELDS).sort().join())throw invalid('Canonical cache rules are incomplete');
    this.defaults={};for(const [table,rules]of Object.entries(baseline.rules))this.defaults[table]=rules.map(rule=>normalizeRule(rule,table));
    this.document=ChangeToCacheMapper.validate(document);this.mappingRules={};
    for(const table of Object.keys(KEY_FIELDS))this.mappingRules[table]=[...this.defaults[table],...(this.document.customRules[table]||[])];
  }
  static validate(document){
    if(!document||document.version!==1||!document.customRules||Array.isArray(document.customRules)||typeof document.customRules!=='object'||Object.keys(document).some(k=>!['version','customRules'].includes(k)))throw invalid('Invalid cache configuration');
    const customRules={};
    for(const [table,rules]of Object.entries(document.customRules)){
      if(!Object.hasOwn(KEY_FIELDS,table)||!Array.isArray(rules)||rules.length>32)throw invalid('Invalid canonical cache rule table');
      customRules[table]=rules.map(rule=>normalizeRule(rule,table));
    }
    return {version:1,customRules};
  }
  map(event){
    const table=event.table_name||event.table;
    if(!Object.hasOwn(KEY_FIELDS,table)||!['insert','update','delete'].includes(event.operation))throw invalid('Invalid canonical cache event');
    const results=new Map();
    for(const values of [event.old_keys||event.oldData||{},event.new_keys||event.data||{}]){
      if(!values||Array.isArray(values)||typeof values!=='object')throw invalid('Invalid event identities');
      for(const [key,value]of Object.entries(values))if(!KEY_FIELDS[table].includes(key)||value!==null&&(typeof value!=='string'||value.length>128))throw invalid('Invalid event identity');
      if(!Object.keys(values).length)continue;
      const primary=KEY_FIELDS[table].includes('id')?['id']:KEY_FIELDS[table];if(primary.some(key=>!values[key]))throw invalid('Event primary identity is missing');
      for(const rule of this.mappingRules[table]){
        let usable=true;
        const pattern=rule.pattern.replace(/\{([a-z_]+)\}/g,(_,key)=>{if(values[key]===null||values[key]===undefined){usable=false;return '';}return rule.type==='regex'?escapeRegex(values[key]):escapeGlob(values[key]);});
        if(usable){const resolved={type:rule.type,pattern};results.set(JSON.stringify(resolved),resolved);}
      }
    }
    return [...results.values()];
  }
  getMappingRules(){return clone({defaults:this.defaults,customRules:this.document.customRules});}
  getTableMapping(table){return clone(this.mappingRules[table]||[]);}
}
module.exports=ChangeToCacheMapper;
module.exports.KEY_FIELDS=KEY_FIELDS;
module.exports.escapeGlob=escapeGlob;
