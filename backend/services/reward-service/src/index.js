// reward-service/src/index.js
'use strict';
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const { query, transaction } = require('../../../shared/db');
const { grantRewards } = require('./rewardGrant');
const { gameDate, previousGameDate } = require('../../../shared/gameTime');
const { getRedis } = require('../../../shared/redis');
const { requireAuth, requireAdmin, AppError, successResp, errorHandler } = require('../../../shared/auth');
const { createLogger, requestLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');

// Import event routes (REQ-00141)
const eventsRouter = require('./routes/events');

const logger = createLogger('reward-service');
const SERVICE_NAME = 'reward-service';

const app  = express();
const PORT = process.env.PORT || 8087;
app.use(helmet()); app.use(cors()); app.use(express.json());

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'reward-service' }));

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

// ── Daily login reward ────────────────────────────────────────
const DAILY_LOGIN_REWARDS = [
  { day: 1,  pokeballs: 5,  stardust: 500,  xp: 100  },
  { day: 2,  pokeballs: 5,  stardust: 500,  xp: 100  },
  { day: 3,  pokeballs: 10, stardust: 1000, xp: 200, greatballs: 1 },
  { day: 4,  pokeballs: 5,  stardust: 500,  xp: 100  },
  { day: 5,  pokeballs: 5,  stardust: 500,  xp: 100  },
  { day: 6,  pokeballs: 10, stardust: 1000, xp: 200, greatballs: 2 },
  { day: 7,  pokeballs: 20, stardust: 3000, xp: 500, greatballs: 3, ultraballs: 1 },
];

// ── GET /rewards/daily  — check today's login reward status ──
app.get('/rewards/daily', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const redis  = getRedis();
    const key    = `daily:login:${userId}`;
    const data   = await redis.get(key);

    const existing = data ? JSON.parse(data) : null;
    const today    = gameDate();

    if (existing && existing.date === today) {
      return res.json(successResp({ claimed: true, streak: existing.streak, reward: existing.reward }));
    }

    // Calculate streak
    let streak = 1;
    if (existing) {
      const yesterday = previousGameDate();
      streak = existing.date === yesterday ? (existing.streak % 7) + 1 : 1;
    }

    const reward = DAILY_LOGIN_REWARDS[(streak - 1) % 7];
    res.json(successResp({ claimed: false, streak, reward }));
  } catch (err) { next(err); }
});

// ── POST /rewards/daily/claim ─────────────────────────────────
app.post('/rewards/daily/claim', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const redis  = getRedis();
    const key    = `daily:login:${userId}`;
    const today  = gameDate();
    const data   = await redis.get(key);
    const existing = data ? JSON.parse(data) : null;

    if (existing && existing.date === today) {
      throw new AppError(2020, '今日签到奖励已领取', 400);
    }

    // Calculate streak
    let streak = 1;
    if (existing) {
      const yesterday = previousGameDate();
      streak = existing.date === yesterday ? (existing.streak % 7) + 1 : 1;
    }

    const reward = DAILY_LOGIN_REWARDS[(streak - 1) % 7];

    // 先原子占位再发奖：原实现 GET → 发奖 → SETEX，并发请求会重复发奖
    const claimKey = `daily:login:claim:${userId}:${today}`;
    const claimed = await redis.set(claimKey, '1', 'EX', 172800, 'NX');
    if (!claimed) throw new AppError(2020, '今日签到奖励已领取', 400);

    try {
    await transaction(async (client) => {
      // Award items
      await client.query(`
        UPDATE users SET
          pokeball_count  = pokeball_count  + $2,
          greatball_count = greatball_count + $3,
          ultraball_count = ultraball_count + $4,
          stardust        = stardust        + $5,
          xp              = xp              + $6
        WHERE id = $1
      `, [userId,
          reward.pokeballs  || 0,
          reward.greatballs || 0,
          reward.ultraballs || 0,
          reward.stardust   || 0,
          reward.xp         || 0]);
    });
    } catch (e) {
      await redis.del(claimKey); // 发奖失败释放占位，允许重试
      throw e;
    }

    // Persist streak in Redis (48h TTL gives 1-day leeway)
    await redis.setex(key, 172800, JSON.stringify({ date: today, streak, reward }));

    res.json(successResp({ streak, reward }, `第 ${streak} 天签到成功！`));
  } catch (err) { next(err); }
});

// ── 训练师升级奖励 ───────────────────────────────────────────
// 升级由数据库触发器根据经验自动完成并写入 trainer_level_ups（见 20260925_020000 迁移），这里负责查询与发放奖励
app.get('/rewards/level-ups', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const [ups, me] = await Promise.all([
      query(`SELECT id, from_level, to_level, rewards, claimed_at, created_at
               FROM trainer_level_ups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]),
      query(`SELECT u.level, u.xp,
                    (SELECT total_xp FROM trainer_levels WHERE level = u.level) AS level_xp,
                    (SELECT total_xp FROM trainer_levels WHERE level = u.level + 1) AS next_level_xp
               FROM users u WHERE u.id = $1`, [userId]),
    ]);
    const u = me.rows[0] || {};
    res.json(successResp({
      level: u.level,
      xp: Number(u.xp || 0),
      currentLevelXp: u.level_xp == null ? null : Number(u.level_xp),
      nextLevelXp: u.next_level_xp == null ? null : Number(u.next_level_xp),
      unclaimed: ups.rows.filter((r) => !r.claimed_at),
      history: ups.rows,
    }));
  } catch (err) { next(err); }
});

app.post('/rewards/level-ups/claim', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const result = await transaction(async (client) => {
      // 条件更新抢占：并发领取只有一个请求能拿到未领取记录
      const { rows } = await client.query(
        `UPDATE trainer_level_ups SET claimed_at = NOW()
          WHERE user_id = $1 AND claimed_at IS NULL
          RETURNING id, to_level, rewards`, [userId]);
      if (!rows.length) throw new AppError(2024, '没有待领取的升级奖励', 400);
      const merged = {};
      for (const r of rows) {
        for (const [k, v] of Object.entries(r.rewards || {})) merged[k] = (merged[k] || 0) + Number(v);
      }
      const grant = await grantRewards(client, userId, merged);
      return { levels: rows.map((r) => r.to_level), rewards: merged, level: grant.level };
    });
    res.json(successResp(result, '升级奖励已发放'));
  } catch (err) { next(err); }
});

// ── GET /rewards/quests  — today's quest status ──────────────
app.get('/rewards/quests', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    // Upsert today's quest
    await query(`
      INSERT INTO daily_quests (user_id, quest_date)
      VALUES ($1, $2::date)
      ON CONFLICT (user_id, quest_date) DO NOTHING
    `, [userId, gameDate()]);

    const { rows: [quest] } = await query(`
      SELECT * FROM daily_quests WHERE user_id=$1 AND quest_date=$2::date
    `, [userId, gameDate()]);

    // Enrich with progress %
    const progress = {
      catch: Math.min(100, Math.round(quest.catch_current / quest.catch_target * 100)),
      spin:  Math.min(100, Math.round(quest.spin_current  / quest.spin_target  * 100)),
      walk:  Math.min(100, Math.round(Number(quest.walk_current_km) / Number(quest.walk_target_km) * 100)),
    };
    const allDone = quest.catch_current >= quest.catch_target &&
                    quest.spin_current  >= quest.spin_target  &&
                    Number(quest.walk_current_km) >= Number(quest.walk_target_km);

    res.json(successResp({ ...quest, progress, allDone }));
  } catch (err) { next(err); }
});

// ── POST /rewards/quests/claim  — claim completed quest ──────
app.post('/rewards/quests/claim', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { rows: [quest] } = await query(`
      SELECT * FROM daily_quests WHERE user_id=$1 AND quest_date=$2::date
    `, [userId, gameDate()]);

    if (!quest) throw new AppError(2021, '今日任务不存在', 404);
    if (quest.reward_claimed) throw new AppError(2022, '今日任务奖励已领取', 400);

    const allDone = quest.catch_current >= quest.catch_target &&
                    quest.spin_current  >= quest.spin_target  &&
                    Number(quest.walk_current_km) >= Number(quest.walk_target_km);

    if (!allDone) throw new AppError(2023, '今日任务尚未全部完成', 400);

    // Quest completion reward
    const reward = { pokeballs: 10, stardust: 1000, xp: 500, coins: 5 };

    await transaction(async (client) => {
      // 条件更新抢占领奖资格：原实现在事务外检查 reward_claimed，并发请求可重复领取
      const gate = await client.query(`
        UPDATE daily_quests SET reward_claimed=true, completed_at=NOW()
        WHERE user_id=$1 AND quest_date=$2::date AND reward_claimed=false
      `, [userId, gameDate()]);
      if (gate.rowCount === 0) throw new AppError(2022, '今日任务奖励已领取', 400);

      await client.query(`
        UPDATE users SET
          pokeball_count = pokeball_count + $2,
          stardust       = stardust       + $3,
          xp             = xp             + $4,
          coins          = coins          + $5
        WHERE id=$1
      `, [userId, reward.pokeballs, reward.stardust, reward.xp, reward.coins]);
    });

    res.json(successResp({ reward }, '任务奖励已领取！'));
  } catch (err) { next(err); }
});

// ── GET /rewards/leaderboard  — global rankings ──────────────
app.get('/rewards/leaderboard', requireAuth, async (req, res, next) => {
  try {
    const { type = 'xp', team } = req.query;

    const validTypes = { xp: 'u.xp', level: 'u.level', catches: 'u.xp' }; // simplified
    const orderCol   = validTypes[type] || 'u.xp';
    // team 走白名单 + 参数化（原实现把查询串直接拼进 SQL，存在注入）
    const VALID_TEAMS = ['VALOR', 'MYSTIC', 'INSTINCT']; // team_enum
    const teamValue = team ? String(team).toUpperCase() : null;
    if (teamValue && !VALID_TEAMS.includes(teamValue)) throw new AppError(1001, 'team 参数无效', 400);
    const teamFilter = teamValue ? 'AND u.team = $1' : '';

    const { rows } = await query(`
      SELECT
        ROW_NUMBER() OVER (ORDER BY ${orderCol} DESC) AS rank,
        u.id, u.nickname, u.avatar_url, u.level, u.team,
        u.xp,
        (SELECT COUNT(*)::int FROM pokemon_instances WHERE user_id=u.id) AS pokemon_count
      FROM users u
      WHERE u.is_banned = false ${teamFilter}
      ORDER BY ${orderCol} DESC
      LIMIT 100
    `, teamValue ? [teamValue] : []);

    // Find current user's rank
    const { rows: [myRank] } = await query(`
      SELECT COUNT(*)::int + 1 AS rank
      FROM users u WHERE ${orderCol} > (SELECT ${orderCol} FROM users u WHERE u.id=$1)
        AND u.is_banned=false
    `, [req.user.sub]);

    res.json(successResp({ leaderboard: rows, myRank: myRank?.rank || null }));
  } catch (err) { next(err); }
});

// ── POST /rewards/achievements/check  — 管理员给成就加进度 ─────────
// 成就进度正常由业务表触发器 + shared/achievementEngine 推进；此接口仅供运维/管理员补发（REQ-00076）
app.post('/rewards/achievements/check', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { achievementId } = req.body;
    const increment = Number(req.body.increment ?? 1);
    if (!Number.isInteger(increment) || increment < 1 || increment > 100) {
      throw new AppError(1001, 'increment 无效', 400);
    }
    const userId = req.body.userId || req.user.sub;
    if (!/^[0-9a-f-]{36}$/i.test(String(userId))) throw new AppError(1001, 'userId 无效', 400);
    const r = await require('../../../shared/achievementEngine').grantProgress(userId, String(achievementId || ''), increment);
    if (!r) return res.json(successResp({ updated: false }));
    res.json(successResp({ updated: true, progress: r.progress, target: r.target, completed: r.completed, completedNow: r.completedNow }));
  } catch (err) { next(err); }
});

// ── GET /rewards/season  — current season info ───────────────
app.get('/rewards/season', requireAuth, async (req, res, next) => {
  try {
    // In prod: fetch from DB/config. Here we return static season data.
    const season = {
      number: 1,
      name:   '起源之章',
      theme:  '探索新世界，发现第一只传说精灵',
      startDate: '2025-05-01',
      endDate:   '2025-07-31',
      daysRemaining: Math.max(0, Math.floor((new Date('2025-07-31') - new Date()) / 86400000)),
      newPokemon: [
        { id: 152, name: '菊草叶（预告）', available: false },
        { id: 155, name: '火球鼠（预告）', available: false },
      ],
      bonuses: [
        '捕捉 XP ×1.5',
        '补给站获得道具 +1',
        '好友交换星尘折扣 -10%',
      ],
      freeTierRewards: [
        { level: 1,  reward: '精灵球 ×10' },
        { level: 5,  reward: '超级球 ×5' },
        { level: 10, reward: '皮卡丘闪光快照' },
        { level: 20, reward: '高级球 ×3' },
        { level: 30, reward: '传说突破通行证 ×1' },
      ],
      premiumTierRewards: [
        { level: 1,  reward: '高级球 ×5' },
        { level: 5,  reward: '闪光精灵遭遇率 ×2' },
        { level: 10, reward: '赛季专属皮卡丘服装' },
      ],
    };
    res.json(successResp(season));
  } catch (err) { next(err); }
});

// ── Event Routes (REQ-00141: 游戏活动系统路由挂载) ──────────────
app.use('/events', eventsRouter);

app.use(errorHandler);
app.listen(PORT, () => logger.info({ port: PORT }, 'reward-service started'));
module.exports = app;
