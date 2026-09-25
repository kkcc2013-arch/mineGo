// social-service/src/index.js
'use strict';
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const { errorHandler } = require('../../../shared/auth');
const { createLogger, requestLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { getEventBus } = require('../../../shared/EventBus');
const tradeRoutes = require('./routes/trade');
const guildRoutes = require('./routes/guild');
const leaderboardRouter = require('./routes/leaderboard'); // REQ-00121, REQ-00074
const pvpRoutes = require('./routes/pvp'); // REQ-00128
const friendsRouter = require('./routes/friends'); // REQ-00048 / REQ-00388
const privacyRouter = require('./routes/privacy'); // REQ-00228
const { initSocialWs } = require('./social/ws'); // 好友实时推送 /ws/friends
const { startFriendJobs } = require('./social/jobs');
const marketplaceRouter = require('./routes/marketplace'); // REQ-00104
const { startLeaderboardJobs, initializeLeaderboards } = require('./jobs/leaderboardJobs'); // REQ-00074
const { registerLeaderboardHandlers } = require('./handlers/leaderboardHandler'); // REQ-00074

const logger = createLogger('social-service');
const SERVICE_NAME = 'social-service';

const app  = express();
const PORT = process.env.PORT || 8086;
app.use(helmet()); app.use(cors()); app.use(express.json());

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'social-service' }));

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

// 好友接口统一由 routes/friends.js 提供（REQ-00048/00228/00388）。原先这里的内联 /friends 路由读写 V1
// friendships/friend_gifts 旧结构并遮挡了路由器中的同名接口，已移除；旧接口路径（/friends/add、/friends/gifts、
// /friends/gifts/:id/open、/friends/:id/gift）在路由器中保留兼容实现。

// ── Trade Routes ──────────────────────────────────────────────
app.use('/trades', tradeRoutes);

// ── PVP Routes (REQ-00128) ─────────────────────────────────────
app.use('/pvp', pvpRoutes);

// ── Guild Routes ──────────────────────────────────────────────
app.use('/guild', guildRoutes);

// REQ-00121: 玩家排行榜系统路由
app.use('/leaderboard', leaderboardRouter);

// 好友系统路由（REQ-00048 / REQ-00388）
app.use('/friends', friendsRouter);

// 隐私设置与好友权限（REQ-00228）
app.use('/privacy', privacyRouter);

// REQ-00104: 市场系统路由
app.use('/marketplace', marketplaceRouter);

// REQ-00092: 批量查询接口
const batchRouter = require('./routes/batch');
app.use('/batch', batchRouter);

app.use(errorHandler);

// REQ-00074: 启动排行榜定时任务
startLeaderboardJobs();
initializeLeaderboards().catch(err => logger.error({ err }, 'Leaderboard init failed'));

// REQ-00074: 注册排行榜事件监听器
const eventBus = getEventBus();
registerLeaderboardHandlers(eventBus);

// 好友请求/礼物过期、排行榜刷新、提醒生成
startFriendJobs();

const server = app.listen(PORT, () => logger.info({ port: PORT }, 'social-service started'));
initSocialWs(server);
module.exports = app;
