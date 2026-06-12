// social-service/src/index.js
'use strict';
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../../../shared/db');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../shared/auth');
const { createLogger, requestLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const tradeRoutes = require('./routes/trade');
const guildRoutes = require('./routes/guild');
const leaderboardRouter = require('./routes/leaderboard'); // REQ-00121
const pvpRoutes = require('./routes/pvp'); // REQ-00128
const friendsRouter = require('./routes/friends'); // REQ-00134

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

// ── GET /friends ──────────────────────────────────────────────
app.get('/friends', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { rows } = await query(`
      SELECT
        CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END AS friend_id,
        u.nickname, u.avatar_url, u.level, u.team,
        f.level AS friendship_level, f.interaction_days, f.last_interaction_at,
        (SELECT COUNT(*)::int FROM friend_gifts
         WHERE receiver_id=$1
           AND sender_id=CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END
           AND opened=false) AS unopened_gifts
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END
      WHERE f.user_a=$1 OR f.user_b=$1
      ORDER BY f.last_interaction_at DESC
    `, [userId]);
    res.json(successResp(rows));
  } catch (err) { next(err); }
});

// ── POST /friends/add ─────────────────────────────────────────
app.post('/friends/add', requireAuth, async (req, res, next) => {
  try {
    const { friendCode } = req.body; // friendCode = userId for simplicity
    const userId = req.user.sub;
    if (!friendCode) throw new AppError(1001, 'friendCode 必填', 400);
    if (friendCode === userId) throw new AppError(2010, '不能添加自己为好友', 400);

    // Find target user
    const { rows: [target] } = await query(
      'SELECT id, nickname FROM users WHERE id=$1', [friendCode]
    );
    if (!target) throw new AppError(2003, '用户不存在', 404);

    // Check friend limit (200)
    const { rows: [cnt] } = await query(`
      SELECT COUNT(*)::int AS n FROM friendships WHERE user_a=$1 OR user_b=$1
    `, [userId]);
    if (cnt.n >= 200) throw new AppError(2011, '好友数量已达上限（200人）', 400);

    // Canonical order: smaller UUID first
    const [userA, userB] = userId < friendCode ? [userId, friendCode] : [friendCode, userId];

    try {
      await query(`
        INSERT INTO friendships (user_a, user_b) VALUES ($1, $2)
      `, [userA, userB]);
    } catch (e) {
      if (e.code === '23505') throw new AppError(2012, '你们已经是好友了', 409);
      throw e;
    }

    res.status(201).json(successResp({ friendId: friendCode, nickname: target.nickname }, '好友添加成功'));
  } catch (err) { next(err); }
});

// ── DELETE /friends/:id ───────────────────────────────────────
app.delete('/friends/:id', requireAuth, async (req, res, next) => {
  try {
    const userId   = req.user.sub;
    const friendId = req.params.id;
    const [userA, userB] = userId < friendId ? [userId, friendId] : [friendId, userId];

    await query('DELETE FROM friendships WHERE user_a=$1 AND user_b=$2', [userA, userB]);
    res.json(successResp(null, '已删除好友'));
  } catch (err) { next(err); }
});

// ── GET /friends/gifts ────────────────────────────────────────
app.get('/friends/gifts', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT fg.id, fg.sender_id, u.nickname AS sender_name,
             fg.postcard_url, fg.items, fg.opened, fg.sent_at,
             ps.name AS pokestop_name
      FROM friend_gifts fg
      JOIN users u ON u.id = fg.sender_id
      LEFT JOIN pokestops ps ON ps.id = fg.pokestop_id
      WHERE fg.receiver_id=$1
      ORDER BY fg.opened ASC, fg.sent_at DESC
      LIMIT 50
    `, [req.user.sub]);
    res.json(successResp(rows));
  } catch (err) { next(err); }
});

// ── POST /friends/:id/gift ────────────────────────────────────
app.post('/friends/:id/gift', requireAuth, async (req, res, next) => {
  try {
    const senderId   = req.user.sub;
    const receiverId = req.params.id;

    // Check daily gift limit (20/day)
    const { rows: [sent] } = await query(`
      SELECT COUNT(*)::int AS n FROM friend_gifts
      WHERE sender_id=$1 AND sent_at > NOW()-INTERVAL '24 hours'
    `, [senderId]);
    if (sent.n >= 20) throw new AppError(2013, '今日礼物发送次数已达上限（20个）', 400);

    // Must be friends
    const [userA, userB] = senderId < receiverId ? [senderId, receiverId] : [receiverId, senderId];
    const { rows: [fs] } = await query(
      'SELECT id, level FROM friendships WHERE user_a=$1 AND user_b=$2', [userA, userB]
    );
    if (!fs) throw new AppError(2009, '你们还不是好友', 400);

    // Gift contents based on friendship level
    const items = generateGiftItems(fs.level);

    await query(`
      INSERT INTO friend_gifts (sender_id, receiver_id, items)
      VALUES ($1,$2,$3)
    `, [senderId, receiverId, JSON.stringify(items)]);

    // Update friendship interaction
    await query(`
      UPDATE friendships SET last_interaction_at=NOW(),
        interaction_days = interaction_days + 1,
        level = CASE
          WHEN interaction_days >= 90 THEN 'BEST'
          WHEN interaction_days >= 30 THEN 'ULTRA'
          WHEN interaction_days >= 7  THEN 'GREAT'
          ELSE 'GOOD'
        END
      WHERE user_a=$1 AND user_b=$2
    `, [userA, userB]);

    res.json(successResp({ items }, '礼物发送成功'));
  } catch (err) { next(err); }
});

// ── POST /friends/gifts/:id/open ──────────────────────────────
app.post('/friends/gifts/:id/open', requireAuth, async (req, res, next) => {
  try {
    const { rows: [gift] } = await query(`
      SELECT * FROM friend_gifts WHERE id=$1 AND receiver_id=$2
    `, [req.params.id, req.user.sub]);

    if (!gift) throw new AppError(2014, '礼物不存在', 404);
    if (gift.opened) throw new AppError(2015, '礼物已经打开过了', 400);

    const items = Array.isArray(gift.items) ? gift.items : JSON.parse(gift.items);

    await transaction(async (client) => {
      await client.query('UPDATE friend_gifts SET opened=true, opened_at=NOW() WHERE id=$1', [gift.id]);

      // Apply items to user
      for (const item of items) {
        if (item.type === 'POKE_BALL')  await client.query('UPDATE users SET pokeball_count=pokeball_count+$1 WHERE id=$2', [item.qty, req.user.sub]);
        if (item.type === 'GREAT_BALL') await client.query('UPDATE users SET greatball_count=greatball_count+$1 WHERE id=$2', [item.qty, req.user.sub]);
        if (item.type === 'STARDUST')   await client.query('UPDATE users SET stardust=stardust+$1 WHERE id=$2', [item.qty, req.user.sub]);
      }
    });

    res.json(successResp({ items }, '礼物已打开'));
  } catch (err) { next(err); }
});

function generateGiftItems(friendLevel) {
  const base = [{ type: 'POKE_BALL', qty: 2 + Math.floor(Math.random() * 3) }];
  if (Math.random() < 0.4) base.push({ type: 'STARDUST', qty: 100 });
  if (friendLevel === 'ULTRA' || friendLevel === 'BEST') {
    base.push({ type: 'GREAT_BALL', qty: 1 });
    if (Math.random() < 0.3) base.push({ type: 'STARDUST', qty: 200 });
  }
  if (friendLevel === 'BEST' && Math.random() < 0.15) {
    base.push({ type: 'ULTRA_BALL', qty: 1 });
  }
  return base;
}

// ── Trade Routes ──────────────────────────────────────────────
app.use('/trades', tradeRoutes);

// ── PVP Routes (REQ-00128) ─────────────────────────────────────
app.use('/pvp', pvpRoutes);

// ── Guild Routes ──────────────────────────────────────────────
app.use('/guild', guildRoutes);

// REQ-00121: 玩家排行榜系统路由
app.use('/leaderboard', leaderboardRouter);

// REQ-00134: 好友系统路由
app.use('/friends', friendsRouter);

app.use(errorHandler);
app.listen(PORT, () => logger.info({ port: PORT }, 'social-service started'));
module.exports = app;
