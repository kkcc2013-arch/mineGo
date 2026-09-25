/**
 * 站内消息实时投递（REQ-00261 / REQ-00425）：WebSocket 推送 + LISTEN pmg_notifications 分发 + 系统推送降级
 *
 * - attach(server)：在服务的 HTTP server 上处理 /ws/messages 升级（noServer 模式，不影响同进程其他 WS 路径）；
 *   鉴权：?token=<access token>（或 Sec-WebSocket-Protocol: bearer,<token>），校验签名与登出黑名单；
 *   连接建立后下发 hello（未读数）并补推离线期间的未读消息（最多 20 条，since 参数可增量）；
 *   客户端可发 PING / READ {id}；30 秒心跳清理死连接。网关把 /ws/messages 的升级请求代理到 user-service（gym-service 的 /ws/notifications 是团战通知，与此无关）。
 * - startDispatcher()：notifications 表每插入一行都会 pg_notify；按投递计划（shared/notificationPolicy.planDelivery）
 *   在线则 WS 实时推送（免打扰时段 silent），离线且满足条件则走 APNs/FCM，未配置凭据时降级为仅站内并记录原因。
 */
'use strict';

const WebSocket = require('ws');
const { verifyAccess } = require('./auth');
const center = require('./notificationCenter');
const policy = require('./notificationPolicy');
const pushProviders = require('./pushProviders');
const { createLogger } = require('./logger');

const logger = createLogger('notification-realtime');
const sockets = new Map(); // userId -> Set<ws>

function defaultDb() { return require('./db'); }

let M = null;
function metrics() {
  if (M) return M;
  try {
    const promClient = require('prom-client');
    const { register } = require('./metrics');
    const get = (name, Ctor, opts) => register.getSingleMetric(name) || new Ctor({ name, registers: [register], ...opts });
    M = {
      conns: get('minego_notification_ws_connections', promClient.Gauge, { help: '通知 WebSocket 在线连接数' }),
      delivered: get('minego_notifications_delivered_total', promClient.Counter, { help: '通知投递', labelNames: ['channel', 'result'] }),
      latency: get('minego_notification_delivery_seconds', promClient.Histogram, {
        help: '消息创建到实时送达的延迟', buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 3, 10] }),
    };
  } catch {
    const noop = { inc() {}, dec() {}, set() {}, observe() {} };
    M = { conns: noop, delivered: noop, latency: noop };
  }
  return M;
}

function isOnline(userId) {
  const set = sockets.get(String(userId));
  return !!(set && [...set].some((ws) => ws.readyState === WebSocket.OPEN));
}

function sendToUser(userId, message) {
  const set = sockets.get(String(userId));
  if (!set) return 0;
  const data = JSON.stringify(message);
  let n = 0;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) { ws.send(data); n++; }
  }
  return n;
}

function connectionCount() {
  let n = 0;
  for (const s of sockets.values()) n += s.size;
  return n;
}

async function authenticate(req, url) {
  let token = url.searchParams.get('token');
  const proto = req.headers['sec-websocket-protocol'];
  if (!token && proto) {
    const parts = String(proto).split(',').map((s) => s.trim());
    const i = parts.indexOf('bearer');
    if (i >= 0 && parts[i + 1]) token = parts[i + 1];
  }
  if (!token) return null;
  let payload;
  try { payload = verifyAccess(token); } catch { return null; }
  if (payload.jti) {
    try {
      const { getJwtBlacklist } = require('./JwtBlacklist');
      if (await getJwtBlacklist().isBlacklisted(payload.jti)) return null;
    } catch { /* Redis 不可用时只校验签名 */ }
  }
  return payload;
}

async function userLang(q, userId) {
  const { rows } = await q.query('SELECT COALESCE(language, language_preference) AS lang FROM users WHERE id = $1', [userId]);
  return (rows[0] && rows[0].lang) || 'zh-CN';
}

/**
 * @param {import('http').Server} server
 */
function attach(server, { path = '/ws/messages', db = defaultDb() } = {}) {
  // 消息压缩（弱网/低带宽，REQ-00425 兼容性）：只压缩 >1KB 的消息
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: { threshold: 1024 } });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return; }
    if (url.pathname !== path) return; // 交给其他升级处理器
    authenticate(req, url).then((payload) => {
      if (!payload) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, payload, url));
    }).catch(() => socket.destroy());
  });

  wss.on('connection', async (ws, req, payload, url) => {
    const userId = String(payload.sub || payload.id);
    ws.userId = userId;
    ws.isAlive = true;
    if (!sockets.has(userId)) sockets.set(userId, new Set());
    sockets.get(userId).add(ws);
    metrics().conns.set(connectionCount());

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      try {
        if (msg.type === 'PING') ws.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
        else if (msg.type === 'READ' && msg.id) {
          await center.markRead(userId, msg.id, db);
          ws.send(JSON.stringify({ type: 'unread', unreadCount: (await center.unreadCount(userId, db, { skipMaterialize: true })).total }));
        }
      } catch (err) { ws.send(JSON.stringify({ type: 'error', message: err.message })); }
    });
    ws.on('close', () => {
      const set = sockets.get(userId);
      if (set) { set.delete(ws); if (!set.size) sockets.delete(userId); }
      metrics().conns.set(connectionCount());
    });

    // 上线：未读数 + 补推离线期间的未读消息
    try {
      const lang = url.searchParams.get('lang') || await userLang(db, userId);
      const since = url.searchParams.get('since');
      const unread = await center.unreadCount(userId, db);
      const pending = await center.list(userId, { status: 'unread', limit: 20, lang, since }, db);
      ws.send(JSON.stringify({ type: 'hello', userId, unreadCount: unread.total, byCategory: unread.byCategory }));
      for (const n of pending.notifications.reverse()) ws.send(JSON.stringify({ type: 'notification', replay: true, notification: n }));
    } catch (err) { logger.warn({ err: err.message, userId }, 'ws hello failed'); }
  });

  const hb = setInterval(() => {
    for (const set of sockets.values()) {
      for (const ws of set) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* 忽略 */ }
      }
    }
  }, 30000);
  hb.unref();
  wss.on('close', () => clearInterval(hb));
  logger.info({ path }, 'notification websocket attached');
  return wss;
}

async function recentPushCount(q, userId) {
  const { rows } = await q.query(
    `SELECT COUNT(*)::int AS n FROM notification_events
      WHERE user_id = $1 AND event_type = 'delivered' AND channel IN ('fcm', 'apns') AND occurred_at > NOW() - INTERVAL '1 hour'`, [userId]);
  return rows[0].n;
}

/** 按投递计划投递一条刚创建的消息 */
async function deliver({ id, userId, priority }, { db = defaultDb() } = {}) {
  const online = isOnline(userId);
  const prefs = await center.getPreferences(userId, db);
  const plan = policy.planDelivery({
    notification: { priority }, prefs, online, providers: pushProviders.status(),
    recentPushCount: online ? 0 : await recentPushCount(db, userId),
  });
  if (plan.ws) {
    const n = await center.getOne(userId, id, await userLang(db, userId), db);
    if (!n) return plan;
    const unread = await center.unreadCount(userId, db, { skipMaterialize: true });
    const sent = sendToUser(userId, { type: 'notification', silent: plan.silent, notification: n, unreadCount: unread.total });
    metrics().delivered.inc({ channel: 'ws', result: sent ? 'ok' : 'offline' });
    if (sent) {
      metrics().latency.observe(Math.max(0, (Date.now() - new Date(n.createdAt).getTime()) / 1000));
      await center.recordDelivery(db, { notificationId: id, userId, eventType: 'delivered', channel: 'ws',
        metadata: plan.silent ? { silent: true, reasons: plan.reasons } : null });
      await db.query(`UPDATE notifications SET channels = array_append(channels, 'ws') WHERE id = $1 AND NOT ('ws' = ANY(channels))`, [id]);
    }
    return plan;
  }
  if (plan.push) {
    const n = await center.getOne(userId, id, await userLang(db, userId), db);
    const { rows: [dev] } = await db.query('SELECT fcm_token, apns_token FROM user_push_preferences WHERE user_id = $1', [userId]);
    const token = plan.push === 'fcm' ? dev && dev.fcm_token : dev && dev.apns_token;
    try {
      await pushProviders.send(plan.push, token, { ...n, id });
      metrics().delivered.inc({ channel: plan.push, result: 'ok' });
      await center.recordDelivery(db, { notificationId: id, userId, eventType: 'delivered', channel: plan.push });
      await db.query(`UPDATE notifications SET channels = array_append(channels, $2) WHERE id = $1`, [id, plan.push]);
    } catch (err) {
      metrics().delivered.inc({ channel: plan.push, result: 'error' });
      await center.recordDelivery(db, { notificationId: id, userId, eventType: 'failed', channel: plan.push, metadata: { error: err.message } });
    }
    return plan;
  }
  // 仅站内：记录原因（未配置推送凭据 / 免打扰 / 低优先级 / 频率上限 / 无设备 / 关闭推送）
  await center.recordDelivery(db, { notificationId: id, userId, eventType: 'deferred', channel: 'in_app', metadata: { reasons: plan.reasons } });
  metrics().delivered.inc({ channel: 'in_app', result: plan.reasons[0] || 'in_app_only' });
  return plan;
}

function startDispatcher({ db = defaultDb() } = {}) {
  let stopped = false;
  let listener = null;
  const queue = [];
  let running = false;

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length && !stopped) {
        const n = queue.shift();
        try { await deliver(n, { db }); } catch (err) { logger.warn({ err: err.message, id: n.id }, 'deliver failed'); }
      }
    } finally { running = false; }
  }

  async function listen() {
    if (stopped) return;
    try {
      listener = await db.getPool().connect();
      listener.on('notification', (msg) => {
        if (msg.channel !== 'pmg_notifications') return;
        try { queue.push(JSON.parse(msg.payload)); setImmediate(pump); } catch { /* 忽略坏载荷 */ }
      });
      listener.on('error', (err) => { logger.warn({ err: err.message }, 'notification listener error'); reconnect(); });
      await listener.query('LISTEN pmg_notifications');
      logger.info('notification dispatcher listening');
    } catch (err) {
      logger.warn({ err: err.message }, 'notification listener connect failed, retry in 5s');
      reconnect();
    }
  }
  function reconnect() {
    if (listener) { try { listener.release(true); } catch { /* 已释放 */ } listener = null; }
    if (!stopped) setTimeout(listen, 5000).unref();
  }
  listen();
  return {
    stop() {
      stopped = true;
      if (listener) listener.query('UNLISTEN *').catch(() => {}).finally(() => { try { listener.release(); } catch { /* ignore */ } });
    },
  };
}

module.exports = { attach, startDispatcher, deliver, isOnline, sendToUser, connectionCount };
