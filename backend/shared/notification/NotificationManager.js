'use strict';
const {query}=require('../db');
const {preferenceTypes,typeEnabled,quietNow}=require('./contracts');
class NotificationManager {
  constructor(options={}){this.query=options.query||query;this.now=options.now||(()=>new Date());this.plugins=new Map();}
  registerPlugin(plugin){for(const method of ['getName','send','isEnabledForUser'])if(typeof plugin?.[method]!=='function')throw new Error(`Plugin must implement ${method}()`);const name=plugin.getName();if(typeof name!=='string'||!name.length)throw new Error('Invalid plugin name');this.plugins.set(name,plugin);}
  async getUserPreferences(userId){
    const {rows:[row]}=await this.query(`SELECT p.preferred_channels,p.notification_types,p.quiet_hours,n.rare_spawn,n.raid_started,n.friend_request,n.gift_received,
      n.quest_complete,n.gym_under_attack,n.gym_lost,COALESCE(to_jsonb(u)->>'timezone','UTC') AS timezone FROM users u
      LEFT JOIN user_push_preferences p ON p.user_id=u.id LEFT JOIN user_notification_preferences n ON n.user_id=u.id WHERE u.id=$1`,[userId]);
    if(!row)return null;return {channels:row.preferred_channels||['websocket','fcm','apns'],notificationTypes:preferenceTypes(row.notification_types,row),quietHours:row.quiet_hours||{enabled:false},timezone:row.timezone};
  }
  async isNotificationTypeEnabled(userId,type){const prefs=await this.getUserPreferences(userId);return prefs?typeEnabled(prefs.notificationTypes,type):false;}
  async isInQuietHours(userId){const prefs=await this.getUserPreferences(userId);return prefs?quietNow(prefs.quietHours,this.now(),prefs.timezone):false;}
  async checkUserOnline(userId){const plugin=this.plugins.get('websocket');return plugin?Boolean(await plugin.isUserOnline(userId)):false;}
  async send(userId,payload,options={}){
    // A storage outage must not bypass a recipient's switches or quiet hours.
    let preferences;try{preferences=await this.getUserPreferences(userId);}catch{return {success:false,error:'Preferences unavailable'};}
    if(!preferences)return {success:false,error:'No push preferences'};
    if(!typeEnabled(preferences.notificationTypes,payload.type))return {success:false,error:'Notification type disabled'};
    try{if(quietNow(preferences.quietHours,this.now(),preferences.timezone))return {success:false,error:'Quiet hours'};}catch{return {success:false,error:'Invalid quiet-hours configuration'};}
    const channels=[...preferences.channels];
    if(!options.skipOnline&&channels.includes('websocket')&&await this.checkUserOnline(userId)){channels.splice(channels.indexOf('websocket'),1);channels.unshift('websocket');}
    const errors=[];
    for(const channel of channels){const plugin=this.plugins.get(channel);if(!plugin||(channel==='websocket'&&options.skipOnline))continue;
      let result;try{if(!await plugin.isEnabledForUser(userId))continue;result=await plugin.send(userId,payload,options);}catch(error){result={success:false,error:error.message};}
      await this.logPush(userId,channel,payload,result);
      if(result.success)return result;errors.push(result.error||'Channel failed');
    }
    if(!errors.length)await this.logPushFailure(userId,payload);
    return {success:false,error:errors.length?errors.join('; '):'No available channels'};
  }
  async logPush(userId,channel,payload,result){
    await this.query(`INSERT INTO push_logs(user_id,channel,notification_type,title,body,payload,success,message_id,error_message) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [userId,channel,payload.type,payload.title,payload.body,JSON.stringify(payload.data||{}),result.success===true,result.messageId||null,result.error||null]);
  }
  async logPushFailure(userId,payload){return this.logPush(userId,'all',payload,{success:false,error:'No available channels'});}
  async sendBatch(userIds,payload,options={}){const results=await Promise.allSettled(userIds.map(id=>this.send(id,payload,options)));return {total:userIds.length,success:results.filter(r=>r.status==='fulfilled'&&r.value.success).length,failed:results.filter(r=>r.status==='rejected'||!r.value.success).length};}
  getRegisteredPlugins(){return [...this.plugins.keys()];}
}
let instance;
function getNotificationManager(){return instance||(instance=new NotificationManager());}
module.exports={NotificationManager,getNotificationManager};
