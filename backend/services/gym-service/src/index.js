// gym-service/src/index.js
'use strict';
require('../../../shared/tracing').initTracing('gym-service'); // REQ-00042：须先于 express/http/pg/redis 加载，自动埋点才生效（未配置 OTEL_EXPORTER_OTLP_ENDPOINT 时不启用）
const express   = require('express');
const http      = require('http');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const cors      = require('cors');
const helmet    = require('helmet');
const { query } = require('../../../shared/db');
const { verifyAccess, errorHandler } = require('../../../shared/auth');
const { createLogger, requestLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { initNotificationWS, sendNotificationToUser } = require('../../../shared/NotificationWebSocket');
const seasonRoutes = require('./routes/season');
const { WebSocketServer: BattleWebSocketServer } = require('./websocket/WebSocketServer');
const raid = require('./battle/raid');
const battleDeps = require('./battle/deps');
const { BattleError } = require('./battle/engine');

const logger = createLogger('gym-service');
const SERVICE_NAME = 'gym-service';

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 8085;

app.use(helmet()); app.use(cors()); app.use(express.json({ limit: '256kb' }));

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'gym-service' }));

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.send(await metrics.register.metrics());
  } catch (err) {
    logger.error({ err }, 'Failed to generate metrics');
    res.status(500).json({ error: 'Metrics generation failed' });
  }
});

// ============================================================
// WEBSOCKET — 同一 HTTP 服务上有 /ws/raid 与 /ws/notifications 两个 WebSocket 端点。
// ws 库的 WebSocketServer({ server, path }) 会对路径不匹配的升级请求直接回 400，
// 两个实例共用一个 server 时互相中断对方的握手（原实现两个端点都连不上），因此这里统一分发 upgrade。
// ============================================================
const raidWss = new WebSocket.Server({ noServer: true });
const notificationUpgrades = new EventEmitter();
const raidRooms = new Map(); // raidId → Set<ws>
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '').split('?')[0];
  if (pathname === '/ws/raid') {
    raidWss.handleUpgrade(req, socket, head, (ws) => raidWss.emit('connection', ws, req));
  } else if (pathname === '/ws/notifications') {
    notificationUpgrades.emit('upgrade', req, socket, head);
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

function wsSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

raidWss.on('connection', async (ws, req) => {
  // ?token=...&raidId=...；只有已加入该 Raid 的玩家可以连接（4001 未登录 / 4003 未参加 / 4004 Raid 无效）
  const params = new URL(req.url, 'http://localhost').searchParams;
  const raidId = params.get('raidId');
  let userId;
  try {
    userId = verifyAccess(params.get('token')).sub;
  } catch {
    ws.close(4001, 'Unauthorized');
    return;
  }
  if (!UUID_RE.test(raidId || '')) { ws.close(4004, 'Invalid raid'); return; }
  try {
    const { rows: [p] } = await query('SELECT 1 FROM raid_participants WHERE raid_id = $1 AND user_id = $2', [raidId, userId]);
    if (!p) { ws.close(4003, 'Not a participant'); return; }
  } catch (err) {
    logger.error({ err }, 'raid ws participant check failed');
    ws.close(1011, 'Server error');
    return;
  }

  ws.userId = userId;
  ws.raidId = raidId;
  if (!raidRooms.has(raidId)) raidRooms.set(raidId, new Set());
  raidRooms.get(raidId).add(ws);
  metrics.websocketConnectionsActive.inc({ service: 'gym-service', room: 'raid' });
  wsSend(ws, { type: 'CONNECTED', raidId, userId });
  broadcastToRaid(raidId, { type: 'PLAYER_ONLINE', userId, online: raidRooms.get(raidId).size });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { wsSend(ws, { type: 'ERROR', code: 'BAD_MESSAGE', message: '消息格式错误' }); return; }
    if (!msg || msg.type !== 'ATTACK') return;
    try {
      // 客户端上报的 damage 字段被忽略：伤害由服务端计算
      const result = await raid.attack(ws.userId, ws.raidId, { moveId: msg.moveId, pokemonId: msg.pokemonId });
      wsSend(ws, { type: 'ATTACK_RESULT', requestId: msg.requestId, ...result });
    } catch (err) {
      if (err instanceof BattleError) {
        wsSend(ws, { type: 'ERROR', requestId: msg.requestId, code: err.code, message: err.message, details: err.details || {} });
      } else {
        logger.error({ err }, 'raid ws attack failed');
        wsSend(ws, { type: 'ERROR', requestId: msg.requestId, code: 'SERVER_ERROR', message: '服务器错误' });
      }
    }
  });

  ws.on('close', () => {
    raidRooms.get(raidId)?.delete(ws);
    if (raidRooms.get(raidId)?.size === 0) raidRooms.delete(raidId);
    metrics.websocketConnectionsActive.dec({ service: 'gym-service', room: 'raid' });
    broadcastToRaid(raidId, { type: 'PLAYER_OFFLINE', userId, online: raidRooms.get(raidId)?.size || 0 });
  });
});

function broadcastToRaid(raidId, data) {
  const room = raidRooms.get(raidId);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
      metrics.websocketMessagesTotal.inc({ service: 'gym-service', direction: 'out', type: data.type });
    }
  }
}
raid.setBroadcaster(broadcastToRaid);

// ============================================================
// REST ROUTES
// ============================================================
// 道馆（附近/详情/驻守）、道馆对战（E11，替换原查询不存在表的 routes/battle.js）、团战
app.use(require('./routes/gyms'));
app.use(require('./routes/gymBattle'));
app.use(require('./routes/raids'));
// E11 战斗扩展接口：能量/冷却/装备、连击、伤害缓存、技能推荐、AI 助手、回放分享、竞技联赛、客户端帧率上报
app.use('/battle', require('./routes/battleApi'));

// REQ-00092: 批量查询接口
const batchRouter = require('./routes/batch');
app.use('/batch', batchRouter);

// REQ-00146: 伤害计算与属性克制系统
const damageRoutes = require('./routes/damage');
app.use('/api/v1/gym/damage', damageRoutes);

// REQ-00043: 延迟任务队列处理器初始化
const { initRaidRewardHandler } = require('./handlers/raidRewardHandler');

// REQ-00109: 团队战斗系统路由
const teamBattleRoutes = require('./routes/teamBattle');
app.use('/api/teams', teamBattleRoutes);

// REQ-00269: 精灵锦标赛与竞技场赛季系统路由
app.use('/api/v1/gym/season', seasonRoutes);

app.use(errorHandler);

// ============================================================
// NOTIFICATION WEBSOCKET - REQ-00026（升级请求由上方统一分发）
// ============================================================
const notificationWss = initNotificationWS(notificationUpgrades, '/ws/notifications');

// Export for other services to use
module.exports.sendNotification = sendNotificationToUser;
module.exports.notificationWss = notificationWss;

// ============================================================
// BATTLE WEBSOCKET - REQ-00262（独立端口 WS_BATTLE_PORT，JWT 鉴权）
// ============================================================
let battleWsServer = null;

function initBattleWebSocket() {
  battleWsServer = new BattleWebSocketServer({
    port: process.env.WS_BATTLE_PORT || 8086,
    jwtSecret: process.env.JWT_SECRET,
  });
  battleWsServer.start();
  logger.info({ port: process.env.WS_BATTLE_PORT || 8086 }, 'Battle WebSocket server started');
  return battleWsServer;
}

// Export for testing
module.exports.battleWsServer = battleWsServer;
module.exports.initBattleWebSocket = initBattleWebSocket;

// ============================================================
// DELAY QUEUE INITIALIZATION - REQ-00043
// ============================================================
async function initializeDelayQueue() {
  try {
    await initRaidRewardHandler();
    logger.info('Raid reward delay queue handler initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize delay queue handlers');
  }
}

server.listen(PORT, () => {
  logger.info({ port: PORT }, '[gym-service] listening');
  // 战斗 WebSocket 先于依赖 Kafka 的延迟队列启动（Kafka 不可用时重试约 8 秒，不应拖住对战连接）
  initBattleWebSocket();
  initializeDelayQueue();
  battleDeps.warmup().catch((err) => logger.error({ err }, 'battle damage cache warmup failed'));
  raid.startScheduler();
  try { require('./battle/league').startScheduler(); } catch (err) { logger.error({ err }, 'league scheduler failed'); }
});
module.exports = app;
