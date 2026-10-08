'use strict';
// REQ-00099: actual Chromium widget against actual PostgreSQL/service/routes.
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');const express=require('express');const {Pool}=require('pg');
const root=path.resolve(__dirname,'../../..');const {chromium}=require(path.join(root,'frontend/game-client/node_modules/@playwright/test'));
const {parseMigrationFile}=require('../../../database/migrate');const {migrationStatements}=require('../../../database/sqlStatements');
const {NotificationService}=require('../../services/user-service/src/notificationService');const {NotificationManager}=require('../../shared/notification/NotificationManager');
const {createMessageCenterRouter}=require('../../services/user-service/src/routes/messageCenter');const {createNotificationRouter}=require('../../services/user-service/src/routes/notifications');const {signAccess,errorHandler}=require('../../shared/auth');
const transport=require('../../shared/NotificationWebSocket');const Plugin=require('../../shared/notification/plugins/WebSocketPlugin');
async function apply(pool,file){const parsed=parseMigrationFile(await fs.readFile(path.join(root,'database/pending',file),'utf8'));for(const sql of migrationStatements(parsed.up))await pool.query(sql);}

test('actual browser renders stored messages safely, marks numeric IDs and keeps user cache separate',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`notif_browser_${crypto.randomBytes(8).toString('hex')}`;const user=crypto.randomUUID(),other=crypto.randomUUID();
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const manager=new NotificationManager({query:pool.query.bind(pool)});const service=new NotificationService({db:{query:pool.query.bind(pool),getClient:()=>pool.connect()},manager});
  let browser,server,wss;
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2),($3,$4)',[user,'browser-owner',other,'browser-other']);
    for(const file of ['repairs/20260605_200000__add_notification_system_tables.sql','20260607_000000__add_push_notification_preferences.sql','20261008_160000__notification_history_contract.sql','repairs/20260611_020000__add_message_center_indexes.sql'])await apply(pool,file);
    const malicious='<img src=x onerror="window.notificationInjected=true">';
    const item=await service.createNotification(user,'RARE_SPAWN',{speciesName:malicious,title:malicious,body:malicious,lat:0,lng:121,distance:0});
    const app=express();app.use(express.json());for(const prefix of ['/notifications','/api/notifications']){app.use(prefix,createNotificationRouter(service,pool.query.bind(pool)));app.use(prefix,createMessageCenterRouter(service));}
    app.use('/client',express.static(path.join(root,'frontend/game-client/src')));app.use('/i18n',express.static(path.join(root,'frontend/game-client/src/i18n')));
    const token=signAccess({sub:user});app.get('/fixture',(_,res)=>res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/client/components/MessageCenter.css"></head><body><nav id="navbar"></nav><script src="/client/components/MessageCenter.js"></script><script>
      const api={};for(const method of ['get','post','put','patch','delete'])api[method]=async(url,body)=>{const options={method:method.toUpperCase(),headers:{Authorization:'Bearer '+${JSON.stringify(token)}}};if(method==='get'&&body?.params)url+='?'+new URLSearchParams(body.params);else if(body!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}const response=await fetch(url,options);if(!response.ok)throw Error('HTTP '+response.status);return response.json();};
      window.navigation=[];window.api=api;window.owner=${JSON.stringify(user)};window.center=new MessageCenter({apiClient:api,userId:owner,onNavigate:(...args)=>navigation.push(args)});window.center.createNavbarBadge(document.getElementById('navbar'));
    </script></body></html>`));app.use(errorHandler);
    server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    wss=transport.initNotificationWS(server);manager.registerPlugin(new Plugin(wss,transport));
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});const context=await browser.newContext();const page=await context.newPage();
    await page.goto(base+'/fixture');await page.evaluate(()=>window.center.ready);
    await t.test('actual DOM shows text without executing stored markup',async()=>{
      await page.evaluate(()=>window.center.open());assert.equal(await page.locator('.notification-title').textContent(),malicious);assert.equal(await page.locator('.notification-card img').count(),0);assert.equal(await page.evaluate(()=>Boolean(window.notificationInjected)),false);
    });
    await t.test('numeric card clicks call actual read API and persist the receipt',async()=>{
      await page.locator(`.notification-card[data-id="${item.id}"] .notification-title`).click();await page.waitForFunction(id=>window.center.notifications.find(row=>row.id===id)?.isRead,item.id);
      assert.equal((await pool.query('SELECT read FROM notification_history WHERE id=$1',[item.id])).rows[0].read,true);
    });
    await t.test('zero latitude is a valid real navigation target',async()=>{
      await page.locator(`.notification-card[data-id="${item.id}"] .action-btn[data-action="navigate"]`).click();await page.waitForFunction(()=>window.navigation.length>0);assert.deepEqual(await page.evaluate(()=>window.navigation[0]),['map',{lat:0,lng:121}]);await page.evaluate(()=>window.center.open());
    });
    await t.test('real realtime manager connects, keeps server identity and updates the badge through document events',async()=>{
      await page.evaluate(async({base,token})=>{window.PMG_CONFIG={wsBase:base.replace('http','ws')};const {NotificationManager}=await import('/client/game/NotificationManager.js');window.realtime=new NotificationManager(window.api);await window.realtime.init(window.owner,token);}, {base,token});
      await page.waitForFunction(()=>window.realtime._ws?.readyState===WebSocket.OPEN);
      const live=await service.createNotification(user,'SYSTEM',{title:'浏览器实时消息',body:'真实服务数据'});await page.waitForFunction(id=>window.realtime.getHistory().some(row=>row.id===id),live.id);await page.waitForFunction(()=>window.center.unreadCount===1);
      assert.equal(await page.evaluate(()=>window.realtime.getHistory()[0].id),live.id);assert.equal(await page.locator('.navbar-message-badge').textContent(),'1');
    });
    await t.test('offline view reads only its own actual IndexedDB records',async()=>{
      await page.waitForFunction(()=>window.center.notifications.some(row=>row.title==='浏览器实时消息'));
      await context.setOffline(true);await page.evaluate(()=>window.center.loadNotifications());assert.ok((await page.locator('.notification-title').allTextContents()).includes('浏览器实时消息'));await context.setOffline(false);
    });
    await t.test('offline category tabs filter the same owned cache instead of showing unrelated messages',async()=>{
      await context.setOffline(true);await page.evaluate(()=>window.center.switchTab('system'));assert.ok((await page.locator('.notification-title').allTextContents()).every(text=>text==='浏览器实时消息'));
      await page.evaluate(()=>window.center.switchTab('all'));await context.setOffline(false);
    });
    await t.test('another user cannot inherit a previous user cache during an offline session',async()=>{
      await page.evaluate(async uid=>{window.center.destroy();window.center=new MessageCenter({apiClient:{get:async()=>{throw Error('offline');}},userId:uid});await window.center.ready;await window.center.open();},other);
      assert.equal(await page.locator('.notification-card').count(),0);
    });
    await t.test('realtime text is escaped and history storage is bound to its recipient',async()=>{
      await page.evaluate(()=>window.realtime._handleNotification({id:98765,recipientId:window.owner,eventType:'SYSTEM',title:'<img src=x onerror="window.notificationInjected=true">',body:'<script>window.notificationInjected=true</script>',data:{},timestamp:new Date().toISOString()}));
      assert.equal(await page.locator('.notification-toast img').count(),0);assert.equal(await page.evaluate(()=>Boolean(window.notificationInjected)),false);
      assert.equal(await page.evaluate(()=>localStorage.getItem('pmg_notification_history')),null);assert.ok(await page.evaluate(()=>localStorage.getItem(`pmg_notification_history:${window.owner}`)));
    });
    await t.test('failed realtime read requests preserve unread local state',async()=>{
      const preserved=await page.evaluate(async()=>{const record=window.realtime.getHistory().find(row=>row.id===98765);window.realtime._api={put:async()=>{throw Error('offline');}};const success=await window.realtime.markAsRead(record.id);return {success,read:record.read};});assert.equal(preserved.success,false);assert.equal(preserved.read,false);
    });
    if(process.env.NOTIFICATION_CLIENT_SCREENSHOT){await page.screenshot({path:process.env.NOTIFICATION_CLIENT_SCREENSHOT,fullPage:true});}
    await context.close();
  }finally{if(browser)await browser.close();if(wss){for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(resolve));}if(server?.listening)await new Promise(resolve=>server.close(resolve));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
