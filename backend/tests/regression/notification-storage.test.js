'use strict';
// REQ-00026/00032/00099/00120: real stored history, production routes and WebSockets.
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');const {Pool}=require('pg');const express=require('express');const request=require('supertest');const WebSocket=require('ws');
const {parseMigrationFile}=require('../../../database/migrate');const {migrationStatements}=require('../../../database/sqlStatements');
const {NotificationService}=require('../../services/user-service/src/notificationService');
const {NotificationManager}=require('../../shared/notification/NotificationManager');
const {createMessageCenterRouter}=require('../../services/user-service/src/routes/messageCenter');
const {createNotificationRouter,createLegacyPreferenceRouter}=require('../../services/user-service/src/routes/notifications');
const transport=require('../../shared/NotificationWebSocket');const WebSocketPlugin=require('../../shared/notification/plugins/WebSocketPlugin');
const {mountNotificationProxy}=require('../../gateway/src/routes/notificationProxy');
const {signAccess,errorHandler}=require('../../shared/auth');const {ServiceLauncher}=require('../../shared/ServiceLauncher');
const {quietNow}=require('../../shared/notification/contracts');
const {initNotificationHandlers}=require('../../services/user-service/src/handlers/notificationHandler');const root=path.resolve(__dirname,'../../..');
const source='database/pending/20261008_160000__notification_history_contract.sql';
async function apply(pool,file,direction='up'){const parsed=parseMigrationFile(await fs.readFile(path.join(root,file),'utf8'));const c=await pool.connect();try{await c.query('BEGIN');for(const sql of migrationStatements(parsed[direction]))await c.query(sql);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
function deadline(promise,ms=3000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Notification fixture timeout')),ms);})]).finally(()=>clearTimeout(timer));}
async function socket(url){const ws=new WebSocket(url);await deadline(new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);}));return ws;}
async function rejectedSocket(url){const ws=new WebSocket(url);return deadline(new Promise(resolve=>{ws.on('error',()=>{});ws.once('unexpected-response',(_,response)=>{response.resume();ws.terminate();resolve(response.statusCode);});}));}
async function closeWS(wss){if(!wss)return;for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));}

test('actual notification history, preference writes, signed message APIs and live recipient delivery',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`notification_${crypto.randomBytes(8).toString('hex')}`;const owner=crypto.randomUUID(),other=crypto.randomUUID();
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const manager=new NotificationManager({query:pool.query.bind(pool)});const service=new NotificationService({db:{query:pool.query.bind(pool),getClient:()=>pool.connect()},manager});
  const app=express();app.use(express.json());app.use('/notifications',createNotificationRouter(service,pool.query.bind(pool)));app.use('/notifications',createMessageCenterRouter(service));app.use('/users/me/notification-preferences',createLegacyPreferenceRouter(service));
  const launcher=new ServiceLauncher({serviceName:'user-service',port:0});app.get('/metrics',launcher.metricsEndpoint.bind(launcher));app.use(errorHandler);
  const server=http.createServer(app);let wss,proxyServer,proxy,ws;const token=signAccess({sub:owner}),otherToken=signAccess({id:other});const headers={Authorization:`Bearer ${token}`};let legacyId,oldRows,originalOid;
  const count=async(user=owner)=>(await pool.query('SELECT count(*)::int AS n FROM notification_history WHERE user_id=$1',[user])).rows[0].n;
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2),($3,$4)',[owner,'notification-owner',other,'notification-other']);
    await apply(pool,'database/pending/repairs/20260605_200000__add_notification_system_tables.sql');
    await apply(pool,'database/pending/20260607_000000__add_push_notification_preferences.sql');
    legacyId=(await pool.query("INSERT INTO notification_history(user_id,type,data,read,created_at) VALUES($1,'rare_spawn','{\"title\":\"旧标题\",\"body\":\"旧正文\",\"speciesName\":\"原名字\"}',TRUE,'2020-01-01') RETURNING id",[owner])).rows[0].id;
    oldRows=(await pool.query('SELECT id,user_id,type,data,read,created_at FROM notification_history ORDER BY id')).rows;
    originalOid=(await pool.query("SELECT 'notification_history'::regclass::oid AS oid")).rows[0].oid;
    await apply(pool,source);await apply(pool,'database/pending/repairs/20260611_020000__add_message_center_indexes.sql');
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    wss=transport.initNotificationWS(server);manager.registerPlugin(new WebSocketPlugin(wss,transport));
    await t.test('upgrade preserves original IDs, sequence, type/data, read flag, timestamps and storage',async()=>{
      assert.equal((await pool.query("SELECT 'notification_history'::regclass::oid AS oid")).rows[0].oid,originalOid);
      assert.deepEqual((await pool.query('SELECT id,user_id,type,data,read,created_at FROM notification_history ORDER BY id')).rows,oldRows);
      const row=(await pool.query('SELECT * FROM notification_history WHERE id=$1',[legacyId])).rows[0];assert.equal(row.notification_type,'RARE_SPAWN');assert.equal(row.title,'旧标题');assert.equal(row.body,'旧正文');assert.equal(row.read_at,null);
    });
    await t.test('history type aliases are derived from original values and cannot drift',async()=>{
      await assert.rejects(pool.query("UPDATE notification_history SET notification_type='SYSTEM' WHERE id=$1",[legacyId]),/can only be updated to DEFAULT/);
      assert.equal((await pool.query('SELECT notification_type FROM notification_history WHERE id=$1',[legacyId])).rows[0].notification_type,'RARE_SPAWN');
    });
    await t.test('existing cold preference GET returns actual defaults without disclosing device tokens',async()=>{
      const response=await request(app).get('/notifications/preferences').set(headers).expect(200);assert.equal(response.body.data.notificationTypes.rare_spawn,true);assert.equal(response.body.data.notificationTypes.gym_lost,false);assert.equal(response.body.data.hasFcmToken,false);
    });
    await t.test('first preference save persists requested booleans and merges other settings',async()=>{
      await pool.query('DELETE FROM user_push_preferences WHERE user_id=$1',[owner]);
      await request(app).patch('/notifications/preferences').set(headers).send({notificationTypes:{rare_spawn:false}}).expect(200);
      const result=await service.getPreferences(owner);assert.equal(result.notificationTypes.rare_spawn,false);assert.equal(result.notificationTypes.friend_request,true);
      assert.equal((await pool.query('SELECT rare_spawn FROM user_notification_preferences WHERE user_id=$1',[owner])).rows[0].rare_spawn,false);
    });
    await t.test('legacy camel case and modern family preferences share one effective policy',async()=>{
      await request(app).put('/users/me/notification-preferences').set(headers).send({rareSpawn:true,raidStarted:false,soundEnabled:false}).expect(200);
      assert.equal(await manager.isNotificationTypeEnabled(owner,'RAID_STARTED'),false);
      await request(app).post('/notifications/preferences').set(headers).send({notificationTypes:{gym_raid:true}}).expect(200);
      assert.equal(await manager.isNotificationTypeEnabled(owner,'RAID_STARTED'),true);assert.equal((await service.getPreferences(owner)).soundEnabled,false);
    });
    await t.test('partial concurrent saves retain independent switches and channels',async()=>{
      await Promise.all([service.updatePreferences(owner,{notificationTypes:{friend_request:false}}),service.updatePreferences(owner,{preferredChannels:['websocket']})]);
      const result=await service.getPreferences(owner);assert.equal(result.notificationTypes.friend_request,false);assert.deepEqual(result.preferredChannels,['websocket']);
      await service.updatePreferences(owner,{notificationTypes:{friend_request:true}});
    });
    await t.test('invalid booleans, types, arrays, channels and quiet times fail before writes',async()=>{
      const old=await service.getPreferences(owner);
      for(const body of [{notificationTypes:[]},{notificationTypes:{friend_request:'false'}},{notificationTypes:{unknown:true}},{preferredChannels:['unknown']},{preferredChannels:['websocket','websocket']},{quietHours:{enabled:'true',start:'22:00',end:'08:00'}},{quietHours:{enabled:true,start:'24:00',end:'08:00'}},{quietHours:{enabled:true,start:'22:00',end:'22:00'}},{quietHours:{enabled:true,start:'22:00',end:'08:00',timeZone:'invalid/timezone'}}])await request(app).patch('/notifications/preferences').set(headers).send(body).expect(400);
      assert.deepEqual(await service.getPreferences(owner),old);
    });
    await t.test('device registration and removal validate platform and preserve recipient ownership',async()=>{
      await request(app).post('/notifications/device-token').set(headers).send({platform:'android',token:'fixture-token'}).expect(200);
      await request(app).delete('/notifications/device-token').set(headers).send({platform:'wrong'}).expect(400);
      assert.equal((await pool.query('SELECT fcm_token FROM user_push_preferences WHERE user_id=$1',[owner])).rows[0].fcm_token,'fixture-token');
      await request(app).delete('/notifications/device-token').set({Authorization:`Bearer ${otherToken}`}).send({platform:'android'}).expect(200);
      assert.equal((await pool.query('SELECT fcm_token FROM user_push_preferences WHERE user_id=$1',[owner])).rows[0].fcm_token,'fixture-token');
      await request(app).delete('/notifications/device-token').set(headers).send({platform:'android'}).expect(200);
    });
    await t.test('anonymous HTTP and unsigned websocket connections are rejected',async()=>{
      await request(app).get('/notifications').expect(401);await request(app).get('/notifications/preferences').expect(401);assert.equal(await rejectedSocket(base.replace('http','ws')+'/ws/notifications?token=invalid'),401);
    });
    await t.test('valid subject connection is authenticated before upgrade and is registered once',async()=>{
      ws=await socket(base.replace('http','ws')+`/ws/notifications?token=${token}`);assert.equal(transport.isUserConnected(owner),true);assert.equal(transport.isUserConnected(other),false);
    });
    let liveId;
    await t.test('actual creator saves real numeric identity and delivers the documented private websocket frame',async()=>{
      const message=deadline(new Promise(resolve=>ws.once('message',data=>resolve(JSON.parse(data)))));
      const result=await service.createNotification(owner,'RARE_SPAWN',{speciesName:'小火龙',distance:120,lat:31,lng:121},{eventId:'first-owned-event'});liveId=result.id;
      const frame=await message;assert.equal(frame.type,'NOTIFICATION');assert.equal(frame.payload.eventType,'RARE_SPAWN');assert.equal(frame.payload.id,liveId);assert.equal(result.delivered,true);assert.ok(liveId>legacyId);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_logs WHERE user_id=$1 AND success',[owner])).rows[0].n,1);
    });
    await t.test('replayed event does not reset read state, duplicate history or send another toast',async()=>{
      await service.markRead(owner,liveId);const before=await count();const first=(await pool.query('SELECT read_at FROM notification_history WHERE id=$1',[liveId])).rows[0].read_at;
      const result=await service.createNotification(owner,'rareSpawn',{speciesName:'replayed'},{eventId:'first-owned-event'});assert.equal(result.created,false);assert.equal(result.id,liveId);assert.equal(await count(),before);
      assert.equal((await pool.query('SELECT read_at FROM notification_history WHERE id=$1',[liveId])).rows[0].read_at.getTime(),first.getTime());
    });
    await t.test('concurrent duplicate event creators have one stored identity',async()=>{
      const results=await Promise.all([service.createNotification(owner,'SYSTEM',{title:'once'},{eventId:'concurrent-event'}),service.createNotification(owner,'system',{title:'once'},{eventId:'concurrent-event'})]);assert.equal(results.filter(row=>row.created).length,1);assert.equal(results[0].id,results[1].id);
    });
    await t.test('disabled event types neither deliver nor add history',async()=>{
      await service.updatePreferences(owner,{notificationTypes:{RARE_SPAWN:false}});const before=await count();const result=await service.createNotification(owner,'RARE_SPAWN',{speciesName:'disabled'});assert.equal(result.suppressed,true);assert.equal(await count(),before);await service.updatePreferences(owner,{notificationTypes:{rare_spawn:true}});
    });
    await t.test('quiet hours are durable and pause realtime delivery while preserving history',async()=>{
      await service.updatePreferences(owner,{quietHours:{enabled:true,start:'00:00',end:'23:59',timeZone:'UTC'}});
      const now=manager.now;manager.now=()=>new Date('2026-10-08T12:00:00Z');try{const result=await service.createNotification(owner,'SYSTEM',{title:'quiet'});assert.equal(result.created,true);assert.equal(result.delivered,false);assert.equal(result.deliveryError,'Quiet hours');}finally{manager.now=now;}
      const prefs=await service.getPreferences(owner);assert.equal(prefs.quietHours.enabled,true);await service.updatePreferences(owner,{quietHours:{enabled:false,start:'22:00',end:'08:00'}});
    });
    await t.test('quiet-hour timezone and midnight boundaries are correct',async()=>{
      const q={enabled:true,start:'22:00',end:'08:00',timeZone:'Asia/Shanghai'};assert.equal(quietNow(q,new Date('2026-10-08T14:00:00Z')),true);assert.equal(quietNow(q,new Date('2026-10-09T00:00:00Z')),false);assert.equal(quietNow(q,new Date('2026-10-08T12:00:00Z')),false);
    });
    await t.test('an unread count immediately sees new writes, without a stale Redis response',async()=>{
      const before=await service.unreadCount(owner);await service.createNotification(owner,'SYSTEM',{title:'new count'});const response=await request(app).get('/notifications/unread-count').set(headers).expect(200);assert.equal(response.body.data.total,before.total+1);
    });
    await t.test('actual list preserves historical text and filters aliases/categories with stable pagination',async()=>{
      const response=await request(app).get('/notifications?type=RARE_SPAWN&status=read&page=1&limit=1').set(headers).expect(200);assert.equal(response.body.data.pagination.total,2);assert.equal(response.body.data.notifications.length,1);assert.equal(response.body.data.notifications[0].id,liveId);
      const all=await service.list(owner,{type:'pokemon'});assert.ok(all.notifications.some(row=>row.id===legacyId&&row.title==='旧标题'));assert.ok(all.notifications.every(row=>row.type==='RARE_SPAWN'));
      const empty=await service.list(owner,{page:1000});assert.equal(empty.notifications.length,0);assert.equal(empty.pagination.total,await count());
    });
    await t.test('invalid IDs, filters and pagination cannot target records',async()=>{
      for(const path of ['?status=wrong','?type=unknown','?page=0','?limit=101','?page=1.5'])await request(app).get('/notifications'+path).set(headers).expect(400);
      await request(app).patch('/notifications/not-numeric/read').set(headers).expect(400);await request(app).post('/notifications/batch-read').set(headers).send({ids:[[liveId]]}).expect(400);
    });
    await t.test('another signed user cannot list, read or delete owner history',async()=>{
      const auth={Authorization:`Bearer ${otherToken}`};const listed=await request(app).get('/notifications').set(auth).expect(200);assert.equal(listed.body.data.pagination.total,0);
      await request(app).patch(`/notifications/${liveId}/read`).set(auth).expect(404);await request(app).delete(`/notifications/${liveId}`).set(auth).expect(404);
    });
    await t.test('single read is idempotent and retains the original receipt timestamp',async()=>{
      const before=(await pool.query('SELECT read_at FROM notification_history WHERE id=$1',[liveId])).rows[0].read_at;
      await request(app).patch(`/notifications/${liveId}/read`).set(headers).expect(200);assert.equal((await pool.query('SELECT read_at FROM notification_history WHERE id=$1',[liveId])).rows[0].read_at.getTime(),before.getTime());
    });
    await t.test('batch reads constrain all IDs to their owner and do not double count',async()=>{
      const foreign=(await pool.query("INSERT INTO notification_history(user_id,type,data) VALUES($1,'SYSTEM','{}') RETURNING id",[other])).rows[0].id;
      const target=(await service.createNotification(owner,'SYSTEM',{title:'batch'})).id;
      const result=await request(app).post('/notifications/batch-read').set(headers).send({ids:[target,target,foreign]}).expect(200);assert.equal(result.body.data.updatedCount,1);
      assert.equal((await pool.query('SELECT read FROM notification_history WHERE id=$1',[foreign])).rows[0].read,false);
      const repeated=await request(app).post('/notifications/batch-read').set(headers).send({ids:[target]}).expect(200);assert.equal(repeated.body.data.updatedCount,0);
    });
    await t.test('mark-all, stats and owned deletion agree with actual rows',async()=>{
      await request(app).post('/notifications/batch-read').set(headers).send({all:true}).expect(200);const stats=await request(app).get('/notifications/stats').set(headers).expect(200);assert.equal(stats.body.data.unread,0);assert.equal(stats.body.data.read,await count());
      const target=(await service.createNotification(owner,'SYSTEM',{title:'delete'})).id;await request(app).delete(`/notifications/${target}`).set(headers).expect(200);await request(app).delete(`/notifications/${target}`).set(headers).expect(404);
    });
    await t.test('clear-read respects date and owner boundaries',async()=>{
      await request(app).post('/notifications/clear-read').set(headers).send({beforeDate:'bad-date'}).expect(400);
      const foreignCount=await count(other);const cleared=await request(app).post('/notifications/clear-read').set(headers).send({beforeDate:'2021-01-01T00:00:00Z'}).expect(200);assert.equal(cleared.body.data.deletedCount,1);assert.equal(await count(other),foreignCount);
    });
    await t.test('a deleted event remains acknowledged and cannot be resurrected by replay',async()=>{
      const result=await service.createNotification(owner,'SYSTEM',{title:'delete replay'},{eventId:'deleted-event'});await service.remove(owner,result.id);const before=await count();
      const replay=await service.createNotification(owner,'SYSTEM',{title:'replayed'},{eventId:'deleted-event'});assert.equal(replay.created,false);assert.equal(replay.id,null);assert.equal(await count(),before);
      await assert.rejects(apply(pool,source,'down'),/event receipts exist/);
    });
    await t.test('actual typed SQL helper functions work with UUID owners and integer IDs',async()=>{
      const id=(await service.createNotification(owner,'SYSTEM',{title:'helper'})).id;
      assert.equal((await pool.query('SELECT mark_notifications_read($1::uuid,$2::integer[],FALSE) AS n',[owner,[id]])).rows[0].n,1);
      assert.equal((await pool.query('SELECT mark_notifications_read($1::uuid,$2::integer[],FALSE) AS n',[other,[id]])).rows[0].n,0);
    });
    await t.test('producer retention removes only the recipients oldest rows, preserving other users',async()=>{
      const foreignCount=await count(other);await pool.query("INSERT INTO notification_history(user_id,type,data,created_at) SELECT $1,'SYSTEM','{}',NOW()-seq*INTERVAL '1 minute' FROM generate_series(1,70) seq",[owner]);
      const result=await service.createNotification(owner,'SYSTEM',{title:'retention survivor'});assert.equal(await count(),50);assert.equal(await count(other),foreignCount);assert.equal((await pool.query('SELECT count(*)::int AS n FROM notification_history WHERE id=$1',[result.id])).rows[0].n,1);
    });
    await t.test('the actual old cleanup helper retains fifty records for each recipient',async()=>{
      await pool.query("INSERT INTO notification_history(user_id,type,data,created_at) SELECT $1,'SYSTEM','{}',NOW()-seq*INTERVAL '1 minute' FROM generate_series(1,70) seq",[other]);
      await pool.query('SELECT cleanup_old_notifications()');assert.equal(await count(owner),50);assert.equal(await count(other),50);
    });
    await t.test('actual rare-spawn handler rejects common, distant and unknown-distance recipients',async()=>{
      const handlers=new Map();await initNotificationHandlers({subscribe:async(topic,handler)=>handlers.set(topic,handler)},{createNotification:service.createNotification.bind(service)});
      const handle=handlers.get('pokemon.rare_spawn');const before=await count();
      for(const data of [{rarity:3,distances:{[owner]:100}},{rarity:4,distances:{[owner]:501}},{rarity:4,distances:{}}])await handle({id:crypto.randomUUID(),data:{nearbyUsers:[owner],speciesName:'boundary',...data}});
      assert.equal(await count(),before);
      const accepted=crypto.randomUUID();await handle({id:accepted,data:{nearbyUsers:[owner],speciesName:'boundary',rarity:'EPIC',distances:{[owner]:500}}});
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM notification_history WHERE user_id=$1 AND source_event_id=$2',[owner,accepted])).rows[0].n,1);
    });
    await t.test('real HTTP proxy aliases preserve bodies, queries and ownership',async()=>{
      const gateway=express();gateway.use(express.json());proxy=mountNotificationProxy(gateway,base);proxyServer=http.createServer(gateway);proxy.attach(proxyServer);await new Promise(resolve=>proxyServer.listen(0,'127.0.0.1',resolve));
      for(const prefix of ['/api/notifications','/api/v1/notifications','/api/v2/notifications','/v1/notifications']){const response=await request(proxyServer).get(prefix+'?limit=3').set(headers).expect(200);assert.equal(response.body.data.notifications.length,3);}
      await request(proxyServer).patch('/api/notifications/preferences').set(headers).send({notificationTypes:{friend_request:false}}).expect(200);assert.equal((await service.getPreferences(owner)).notificationTypes.friend_request,false);
    });
    await t.test('actual websocket proxy carries authenticated recipient messages and closes active sockets',async()=>{
      const gatewayUrl=`ws://127.0.0.1:${proxyServer.address().port}/ws/notifications?token=${token}`;const proxied=await socket(gatewayUrl);
      const incoming=deadline(new Promise(resolve=>proxied.once('message',data=>resolve(JSON.parse(data)))));await service.createNotification(owner,'SYSTEM',{title:'through proxy'});assert.equal((await incoming).payload.title,'through proxy');
      const closed=deadline(new Promise(resolve=>proxied.once('close',resolve)));proxy.close();await closed;
    });
    await t.test('the real launcher metrics endpoint exposes actual committed read/delete operations',async()=>{
      const response=await request(app).get('/metrics').expect(200);assert.match(response.text,/minego_message_center_notifications_marked_read_total [1-9]/);assert.match(response.text,/minego_message_center_notifications_deleted_total [1-9]/);
    });
  }finally{if(ws)ws.terminate();if(proxy)proxy.close();await closeWS(wss);if(proxyServer?.listening)await new Promise(resolve=>proxyServer.close(resolve));if(server.listening)await new Promise(resolve=>server.close(resolve));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test('notification contract rejects reversal that would lose new text, receipts or event identity',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');const schema=`notification_down_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));await apply(pool,'database/pending/repairs/20260605_200000__add_notification_system_tables.sql');
    const user=crypto.randomUUID();await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[user,'notification-reverse']);await apply(pool,source);
    const row=(await pool.query("INSERT INTO notification_history(user_id,type,data,title,body,read,read_at,source_event_id) VALUES($1,'SYSTEM','{\"original\":true}','new title','new body',TRUE,'2026-10-08','event-kept') RETURNING id",[user])).rows[0];
    await assert.rejects(apply(pool,source,'down'),/Modern notification metadata exists/);
    const saved=(await pool.query('SELECT * FROM notification_history WHERE id=$1',[row.id])).rows[0];assert.equal(saved.title,'new title');assert.equal(saved.body,'new body');assert.equal(saved.source_event_id,'event-kept');assert.ok(saved.read_at);assert.deepEqual(saved.data,{original:true});

  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});


test('an unused notification contract reverses to the exact original table and data',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');const schema=`notif_empty_down_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));await apply(pool,'database/pending/repairs/20260605_200000__add_notification_system_tables.sql');
    const user=crypto.randomUUID();await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[user,'empty-reverse']);await pool.query("INSERT INTO notification_history(user_id,type,data) VALUES($1,'SYSTEM','{\"title\":\"preserved\"}')",[user]);
    const rows=(await pool.query('SELECT * FROM notification_history')).rows;await apply(pool,source);await apply(pool,source,'down');assert.deepEqual((await pool.query('SELECT * FROM notification_history')).rows,rows);
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
