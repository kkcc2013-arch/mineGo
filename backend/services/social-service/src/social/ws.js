/**
 * 好友实时推送 WebSocket：/ws/friends?token=<accessToken>
 *
 * - 鉴权：access token + JWT 黑名单（与网关一致），失败返回 401 并断开
 * - 连接/心跳刷新在线状态（由离线变为在线时通知好友，受在线状态可见性约束）
 * - 订阅 Redis 频道 social:events（任一服务发布），推送给本实例上的目标用户连接
 * 客户端消息：{type:'PING'} → {type:'PONG'}；服务端消息：{type, payload, ts}
 */
'use strict';

const WebSocket = require('ws');
const { verifyAccess } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');
const { CHANNEL } = require('../../../../shared/social/socialEvents');
const m = require('./metrics');

const logger = createLogger('social-ws');

function initSocialWs(server, {
  path = '/ws/friends',
  friends = require('../friendService'),
  db = require('../../../../shared/db'),
  redisFactory = () => require('../../../../shared/redis').getRedis(),
  isBlacklisted = async (jti) => {
    if (!jti) return false;
    try { return await require('../../../../shared/JwtBlacklist').getJwtBlacklist().isBlacklisted(jti); } catch { return false; }
  },
  heartbeatMs = 30000,
} = {}) {
  const wss = new WebSocket.Server({ noServer: true });
  const rooms = new Map();

  function deliver(userId, message) {
    const set = rooms.get(userId);
    if (!set) return 0;
    let n = 0;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) { ws.send(message); n++; }
    }
    return n;
  }

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    let payload;
    try {
      payload = verifyAccess(url.searchParams.get('token') || '');
      if (await isBlacklisted(payload.jti)) throw new Error('revoked');
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, payload.sub));
  });

  wss.on('connection', async (ws, req, userId) => {
    ws.userId = userId;
    ws.isAlive = true;
    if (!rooms.has(userId)) rooms.set(userId, new Set());
    rooms.get(userId).add(ws);
    m.wsConnections.inc();

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg && msg.type === 'PING') {
        ws.isAlive = true;
        ws.send(JSON.stringify({ type: 'PONG', ts: new Date().toISOString() }));
        friends.touchPresence(userId).catch(() => {});
      }
    });
    ws.on('close', () => {
      const set = rooms.get(userId);
      if (set) { set.delete(ws); if (!set.size) rooms.delete(userId); }
      m.wsConnections.dec();
    });
    ws.on('error', (err) => logger.warn({ err: err.message, userId }, 'ws error'));

    let unread = 0;
    try {
      const { rows: [r] } = await db.query(
        'SELECT COUNT(*)::int AS n FROM interaction_reminders WHERE user_id = $1 AND NOT is_read', [userId]);
      unread = r.n;
    } catch { /* ignore */ }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'connected', payload: { userId, unreadReminders: unread }, ts: new Date().toISOString() }));
    }
    friends.touchPresence(userId).catch((err) => logger.warn({ err: err.message }, 'touch presence failed'));
  });

  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, heartbeatMs);
  if (hb.unref) hb.unref();

  let sub = null;
  try {
    sub = redisFactory().duplicate();
    sub.on('error', (err) => logger.warn({ err: err.message }, 'social ws redis subscriber error'));
    sub.subscribe(CHANNEL).catch((err) => logger.error({ err: err.message }, 'subscribe failed'));
    sub.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;
      let evt;
      try { evt = JSON.parse(raw); } catch { return; }
      const message = JSON.stringify({ type: evt.type, payload: evt.payload, ts: evt.ts });
      let sent = 0;
      for (const uid of evt.userIds || []) sent += deliver(uid, message);
      if (sent) m.wsMessages.inc({ type: evt.type }, sent);
    });
  } catch (err) {
    logger.error({ err: err.message }, 'social ws: redis unavailable, realtime push disabled');
  }

  logger.info({ path }, 'social WebSocket ready');
  return {
    wss,
    isConnected: (userId) => rooms.has(userId),
    connectionCount: () => wss.clients.size,
    close: () => {
      clearInterval(hb);
      if (sub) sub.disconnect();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

module.exports = { initSocialWs };
