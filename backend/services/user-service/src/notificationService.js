'use strict';
// REQ-00026/REQ-00099/REQ-00120: one canonical history and preference contract.
const db=require('../../../shared/db');
const {AppError}=require('../../../shared/auth');
const {getNotificationManager}=require('../../../shared/notification/NotificationManager');
const {definitions,normalizeType,defaults,legacyColumns,preferenceTypes,textFor}=require('../../../shared/notification/contracts');
const {register,Counter}=require('../../../shared/metrics');
const metric=(name,help)=>register.getSingleMetric(name)||new Counter({name,help,registers:[register]});
const metrics={read:metric('minego_message_center_notifications_marked_read_total','Stored notifications changed to read'),deleted:metric('minego_message_center_notifications_deleted_total','Deleted owned notifications')};
function error(message,status=400){return new AppError(status===404?'NOT_FOUND':'INVALID_REQUEST',message,status);}
function integer(value,name,{min=1,max=2147483647}={}){if(!['string','number'].includes(typeof value)||!/^\d+$/.test(String(value)))throw error(`Invalid ${name}`);const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw error(`Invalid ${name}`);return n;}
function object(value,name){if(!value||typeof value!=='object'||Array.isArray(value))throw error(`Invalid ${name}`);return value;}
function timeAgo(value){if(!value)return '时间未知';const seconds=Math.floor((Date.now()-new Date(value).getTime())/1000);if(!Number.isFinite(seconds))return '时间未知';if(seconds<60)return '刚刚';if(seconds<3600)return `${Math.floor(seconds/60)} 分钟前`;if(seconds<86400)return `${Math.floor(seconds/3600)} 小时前`;if(seconds<604800)return `${Math.floor(seconds/86400)} 天前`;return new Date(value).toLocaleDateString('zh-CN');}
function format(row){const info=definitions[row.notification_type]||{icon:'📬',label:'通知',category:'system'};const copy=textFor(row.notification_type,row.data);return {id:row.id,type:row.notification_type,icon:info.icon,typeLabel:info.label,category:info.category,title:row.title??copy.title,body:row.body??copy.body,data:row.data||{},isRead:row.read===true,readAt:row.read_at,createdAt:row.created_at,timeAgo:timeAgo(row.created_at)};}
class NotificationService {
  constructor(options={}){this.db=options.db||{query:db.query,getClient:()=>db.getPool().connect()};this.manager=options.manager||getNotificationManager();}
  async transaction(fn){const client=await this.db.getClient();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
  async getPreferences(userId){
    const {rows:[row]}=await this.db.query(`SELECT p.preferred_channels,p.notification_types,p.quiet_hours,p.fcm_token IS NOT NULL AS has_fcm,p.apns_token IS NOT NULL AS has_apns,
      n.rare_spawn,n.raid_started,n.friend_request,n.gift_received,n.quest_complete,n.gym_under_attack,n.gym_lost,n.sound_enabled,n.vibration_enabled
      FROM users u LEFT JOIN user_push_preferences p ON p.user_id=u.id LEFT JOIN user_notification_preferences n ON n.user_id=u.id WHERE u.id=$1`,[userId]);
    if(!row)throw error('User not found',404);
    return {preferredChannels:row.preferred_channels||['websocket','fcm','apns'],notificationTypes:preferenceTypes(row.notification_types,row),quietHours:row.quiet_hours||{enabled:false,start:'22:00',end:'08:00'},hasFcmToken:row.has_fcm,hasApnsToken:row.has_apns,soundEnabled:row.sound_enabled??true,vibrationEnabled:row.vibration_enabled??true};
  }
  async updatePreferences(userId,input){
    object(input,'preferences');const allowed=['preferredChannels','notificationTypes','quietHours','soundEnabled','vibrationEnabled'];if(Object.keys(input).some(k=>!allowed.includes(k))||!Object.keys(input).length)throw error('Invalid preference fields');
    const changes={};if(input.notificationTypes!==undefined){for(const [key,value] of Object.entries(object(input.notificationTypes,'notification types'))){const type=normalizeType(key);if(!type||typeof value!=='boolean')throw error('Invalid notification type switch');changes[definitions[type].key]=value;}}
    if(input.preferredChannels!==undefined&&(!Array.isArray(input.preferredChannels)||input.preferredChannels.some(x=>!['websocket','fcm','apns'].includes(x))||new Set(input.preferredChannels).size!==input.preferredChannels.length))throw error('Invalid preferred channels');
    if(input.quietHours!==undefined){const q=object(input.quietHours,'quiet hours');if(typeof q.enabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(q.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(q.end)||q.start===q.end||Object.keys(q).some(k=>!['enabled','start','end','timeZone'].includes(k)))throw error('Invalid quiet hours');if(q.timeZone!==undefined){try{new Intl.DateTimeFormat('en',{timeZone:q.timeZone});}catch{throw error('Invalid quiet-hours time zone');}}}
    for(const key of ['soundEnabled','vibrationEnabled'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw error(`Invalid ${key}`);
    return this.transaction(async client=>{
      const owner=await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);if(!owner.rowCount)throw error('User not found',404);
      await client.query('INSERT INTO user_notification_preferences(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING',[userId]);
      await client.query('INSERT INTO user_push_preferences(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING',[userId]);
      const {rows:[legacy]}=await client.query('SELECT * FROM user_notification_preferences WHERE user_id=$1',[userId]);
      const {rows:[push]}=await client.query('SELECT * FROM user_push_preferences WHERE user_id=$1',[userId]);
      const merged={...preferenceTypes(push.notification_types,legacy),...changes};
      await client.query('UPDATE user_push_preferences SET notification_types=notification_types||$2::jsonb,preferred_channels=$3,quiet_hours=$4,updated_at=NOW() WHERE user_id=$1',[userId,JSON.stringify(merged),input.preferredChannels??push.preferred_channels,JSON.stringify(input.quietHours??push.quiet_hours)]);
      const columns=Object.keys(legacyColumns);await client.query(`UPDATE user_notification_preferences SET ${columns.map((column,i)=>`${column}=$${i+2}`).join(',')},sound_enabled=$9,vibration_enabled=$10 WHERE user_id=$1`,[userId,...columns.map(column=>merged[column]),input.soundEnabled??legacy.sound_enabled,input.vibrationEnabled??legacy.vibration_enabled]);
      return {updated:true};
    });
  }
  async createNotification(userId,type,data,options={}){
    const canonical=normalizeType(type);if(!canonical)throw error('Invalid notification type');object(data,'notification data');
    const prefs=await this.getPreferences(userId);if(!prefs.notificationTypes[definitions[canonical].key])return {created:false,suppressed:true};
    const eventId=options.eventId??null;if(eventId!==null&&(typeof eventId!=='string'||!eventId.length||eventId.length>200))throw error('Invalid notification event identity');
    const copy=textFor(canonical,data);
    const stored=await this.transaction(async client=>{
      // Serialize retention with new records for the same recipient.
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
      if(eventId){
        const receipt=await client.query('SELECT notification_id FROM notification_event_receipts WHERE user_id=$1 AND notification_type=$2 AND source_event_id=$3',[userId,canonical,eventId]);
        if(receipt.rowCount){const existing=receipt.rows[0].notification_id?await client.query('SELECT * FROM notification_history WHERE id=$1 AND user_id=$2',[receipt.rows[0].notification_id,userId]):{rows:[]};return {row:existing.rows[0],created:false};}
      }
      const inserted=await client.query(`INSERT INTO notification_history(user_id,type,data,title,body,source_event_id) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(user_id,notification_type,source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING RETURNING *`,[userId,canonical,JSON.stringify(data),copy.title,copy.body,eventId]);
      if(!inserted.rowCount){const {rows:[existing]}=await client.query('SELECT * FROM notification_history WHERE user_id=$1 AND notification_type=$2 AND source_event_id=$3',[userId,canonical,eventId]);return {row:existing,created:false};}
      if(eventId)await client.query('INSERT INTO notification_event_receipts(user_id,notification_type,source_event_id,notification_id) VALUES($1,$2,$3,$4)',[userId,canonical,eventId,inserted.rows[0].id]);
      await client.query(`DELETE FROM notification_history WHERE user_id=$1 AND id IN(SELECT id FROM notification_history WHERE user_id=$1 ORDER BY created_at DESC NULLS LAST,id DESC OFFSET 50)`,[userId]);
      return {row:inserted.rows[0],created:true};
    });
    if(!stored.created)return {...(stored.row?format(stored.row):{id:null}),created:false,delivered:false};
    const delivery=await this.manager.send(userId,{id:stored.row.id,recipientId:userId,type:canonical,eventType:canonical,...copy,data,timestamp:stored.row.created_at});
    return {...format(stored.row),created:true,delivered:delivery.success,deliveryError:delivery.error};
  }
  async list(userId,options={}){
    const status=options.status??'all';if(!['all','read','unread'].includes(status))throw error('Invalid notification status');
    const page=integer(options.page??1,'page');const limit=integer(options.limit??20,'limit',{max:100});const offset=(page-1)*limit;
    const conditions=['user_id=$1'];const args=[userId];if(status==='read')conditions.push('read IS TRUE');if(status==='unread')conditions.push('read IS NOT TRUE');
    if(options.type&&options.type!=='all'){const direct=normalizeType(options.type);const types=direct?[direct]:Object.entries(definitions).filter(([,info])=>info.category===options.type).map(([type])=>type);if(!types.length)throw error('Invalid notification filter');args.push(types);conditions.push(`notification_type=ANY($${args.length}::text[])`);}
    const where=conditions.join(' AND ');const length=args.length;
    const {rows:[result]}=await this.db.query(`WITH filtered AS(SELECT * FROM notification_history WHERE ${where})
      SELECT (SELECT COALESCE(jsonb_agg(page_rows ORDER BY created_at DESC,id DESC),'[]'::jsonb) FROM(SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $${length+1} OFFSET $${length+2}) page_rows) AS notifications,
        (SELECT count(*)::int FROM filtered) AS total,(SELECT count(*)::int FROM notification_history WHERE user_id=$1 AND read IS NOT TRUE) AS unread`,[...args,limit,offset]);
    return {ownerId:userId,notifications:result.notifications.map(format),pagination:{total:result.total,page,limit,totalPages:Math.ceil(result.total/limit)},unreadCount:result.unread};
  }
  async unreadCount(userId){const {rows}=await this.db.query('SELECT notification_type,count(*)::int AS count FROM notification_history WHERE user_id=$1 AND read IS NOT TRUE GROUP BY notification_type',[userId]);return {total:rows.reduce((sum,row)=>sum+row.count,0),byType:Object.fromEntries(rows.map(row=>[row.notification_type,row.count]))};}
  async markRead(userId,id){id=integer(id,'notification ID');const changed=await this.transaction(async client=>{const {rows:[row]}=await client.query('SELECT read,read_at FROM notification_history WHERE user_id=$1 AND id=$2 FOR UPDATE',[userId,id]);if(!row)throw error('Notification not found',404);await client.query('UPDATE notification_history SET read=TRUE,read_at=COALESCE(read_at,NOW()) WHERE user_id=$1 AND id=$2',[userId,id]);return row.read!==true;});if(changed)metrics.read.inc();return {isRead:true};}
  async batchRead(userId,input){object(input,'read selection');const {ids,all}=input;let values=[userId];let selection='';if(all===true){if(ids!==undefined)throw error('Provide ids or all');}else{if(!Array.isArray(ids)||!ids.length||ids.length>1000)throw error('Invalid notification IDs');values.push([...new Set(ids.map(id=>integer(id,'notification ID')))]);selection=' AND id=ANY($2::integer[])';}
    const result=await this.db.query(`UPDATE notification_history SET read=TRUE,read_at=COALESCE(read_at,NOW()) WHERE user_id=$1 AND read IS NOT TRUE${selection}`,values);metrics.read.inc(result.rowCount);return {updatedCount:result.rowCount};}
  async remove(userId,id){const result=await this.db.query('DELETE FROM notification_history WHERE user_id=$1 AND id=$2',[userId,integer(id,'notification ID')]);if(!result.rowCount)throw error('Notification not found',404);metrics.deleted.inc();return null;}
  async clearAll(userId){const result=await this.db.query('DELETE FROM notification_history WHERE user_id=$1',[userId]);metrics.deleted.inc(result.rowCount);return {deletedCount:result.rowCount};}
  async clearRead(userId,input={}){object(input,'clear selection');const values=[userId];let before='';if(input.beforeDate!==undefined){if(typeof input.beforeDate!=='string'||!/^\d{4}-\d\d-\d\dT/.test(input.beforeDate)||!Number.isFinite(Date.parse(input.beforeDate)))throw error('Invalid beforeDate');values.push(input.beforeDate);before=' AND created_at<$2';}const result=await this.db.query(`DELETE FROM notification_history WHERE user_id=$1 AND read IS TRUE${before}`,values);metrics.deleted.inc(result.rowCount);return {deletedCount:result.rowCount};}
  async stats(userId){
    const {rows}=await this.db.query(`SELECT notification_type,count(*)::int AS total,count(*) FILTER(WHERE read IS NOT TRUE)::int AS unread,count(*) FILTER(WHERE read IS TRUE)::int AS read,max(created_at) AS last FROM notification_history WHERE user_id=$1 GROUP BY notification_type`,[userId]);
    const counts=Object.fromEntries(rows.map(row=>[row.notification_type,row.total]));
    const last=rows.map(row=>row.last).filter(Boolean).sort((a,b)=>new Date(b)-new Date(a))[0]||null;
    return {total:rows.reduce((n,r)=>n+r.total,0),unread:rows.reduce((n,r)=>n+r.unread,0),read:rows.reduce((n,r)=>n+r.read,0),byType:{rareSpawn:counts.RARE_SPAWN||0,raid:counts.RAID_STARTED||0,friendRequest:counts.FRIEND_REQUEST||0,quest:counts.QUEST_COMPLETE||0,system:counts.SYSTEM||0},countsByType:counts,lastNotificationAt:last};
  }

}
const notificationService=new NotificationService();
module.exports={NotificationService,notificationService,format,integer};
