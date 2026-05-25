// reward-service/src/index.js
'use strict';
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const { query, transaction } = require('../../shared/db');
const { getRedis } = require('../../shared/redis');
const { requireAuth, AppError, successResp, errorHandler } = require('../../shared/auth');

const app  = express();
const PORT = process.env.PORT || 8087;
app.use(helmet()); app.use(cors()); app.use(express.json());
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'reward-service' }));

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
    const today    = new Date().toISOString().slice(0, 10);

    if (existing && existing.date === today) {
      return res.json(successResp({ claimed: true, streak: existing.streak, reward: existing.reward }));
    }

    // Calculate streak
    let streak = 1;
    if (existing) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
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
    const today  = new Date().toISOString().slice(0, 10);
    const data   = await redis.get(key);
    const existing = data ? JSON.parse(data) : null;

    if (existing && existing.date === today) {
      throw new AppError(2020, '今日签到奖励已领取', 400);
    }

    // Calculate streak
    let streak = 1;
    if (existing) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      streak = existing.date === yesterday ? (existing.streak % 7) + 1 : 1;
    }

    const reward = DAILY_LOGIN_REWARDS[(streak - 1) % 7];

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

    // Persist streak in Redis (48h TTL gives 1-day leeway)
    await redis.setex(key, 172800, JSON.stringify({ date: today, streak, reward }));

    res.json(successResp({ streak, reward }, `第 ${streak} 天签到成功！`));
  } catch (err) { next(err); }
});

// ── GET /rewards/quests  — today's quest status ──────────────
app.get('/rewards/quests', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    // Upsert today's quest
    await query(`
      INSERT INTO daily_quests (user_id, quest_date)
      VALUES ($1, CURRENT_DATE)
      ON CONFLICT (user_id, quest_date) DO NOTHING
    `, [userId]);

    const { rows: [quest] } = await query(`
      SELECT * FROM daily_quests WHERE user_id=$1 AND quest_date=CURRENT_DATE
    `, [userId]);

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
      SELECT * FROM daily_quests WHERE user_id=$1 AND quest_date=CURRENT_DATE
    `, [userId]);

    if (!quest) throw new AppError(2021, '今日任务不存在', 404);
    if (quest.reward_claimed) throw new AppError(2022, '今日任务奖励已领取', 400);

    const allDone = quest.catch_current >= quest.catch_target &&
                    quest.spin_current  >= quest.spin_target  &&
                    Number(quest.walk_current_km) >= Number(quest.walk_target_km);

    if (!allDone) throw new AppError(2023, '今日任务尚未全部完成', 400);

    // Quest completion reward
    const reward = { pokeballs: 10, stardust: 1000, xp: 500, coins: 5 };

    await transaction(async (client) => {
      await client.query(`
        UPDATE users SET
          pokeball_count = pokeball_count + $2,
          stardust       = stardust       + $3,
          xp             = xp             + $4,
          coins          = coins          + $5
        WHERE id=$1
      `, [userId, reward.pokeballs, reward.stardust, reward.xp, reward.coins]);

      await client.query(`
        UPDATE daily_quests SET reward_claimed=true, completed_at=NOW()
        WHERE user_id=$1 AND quest_date=CURRENT_DATE
      `, [userId]);
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
    const teamFilter = team ? `AND u.team = '${team.toUpperCase()}'` : '';

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
    `);

    // Find current user's rank
    const { rows: [myRank] } = await query(`
      SELECT COUNT(*)::int + 1 AS rank
      FROM users WHERE ${orderCol} > (SELECT ${orderCol} FROM users WHERE id=$1)
        AND is_banned=false
    `, [req.user.sub]);

    res.json(successResp({ leaderboard: rows, myRank: myRank?.rank || null }));
  } catch (err) { next(err); }
});

// ── POST /rewards/achievements/check  — check & unlock ───────
// Called internally by other services after state changes
app.post('/rewards/achievements/check', requireAuth, async (req, res, next) => {
  try {
    const { achievementId, increment = 1 } = req.body;
    const userId = req.user.sub;

    const { rows: [def] } = await query(
      'SELECT * FROM achievement_definitions WHERE id=$1', [achievementId]
    );
    if (!def) return res.json(successResp({ updated: false }));

    const { rows: [ua] } = await query(`
      INSERT INTO user_achievements (user_id, achievement_id, current_value)
      VALUES ($1,$2,$3)
      ON CONFLICT (user_id, achievement_id)
      DO UPDATE SET current_value=user_achievements.current_value+$3, updated_at=NOW()
      RETURNING current_value, current_tier
    `, [userId, achievementId, increment]);

    // Check if new tier unlocked
    const tiers  = Array.isArray(def.tiers) ? def.tiers : JSON.parse(def.tiers);
    const curVal  = ua.current_value;
    const curTier = ua.current_tier || 0;
    let newTier   = curTier;

    for (const t of tiers) {
      if (curVal >= t.target && t.tier > curTier) newTier = t.tier;
    }

    if (newTier > curTier) {
      await query(`
        UPDATE user_achievements
        SET current_tier=$1, unlocked_at=COALESCE(unlocked_at, NOW())
        WHERE user_id=$2 AND achievement_id=$3
      `, [newTier, userId, achievementId]);
      res.json(successResp({ updated: true, newTier, achievement: def.name_zh }));
    } else {
      res.json(successResp({ updated: false }));
    }
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

app.use(errorHandler);
app.listen(PORT, () => console.log(`[reward-service] listening on :${PORT}`));
module.exports = app;
