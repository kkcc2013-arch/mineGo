// user-service/src/routes/user.js
'use strict';
const express = require('express');
const { z }   = require('zod');
const { query } = require('../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');

const router = express.Router();
router.use(requireAuth);

// ── GET /users/me ─────────────────────────────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT
        u.id, u.nickname, u.avatar_url, u.team, u.level, u.xp,
        u.stardust, u.coins, u.premium_coins,
        u.pokeball_count, u.greatball_count, u.ultraball_count, u.masterball_count,
        u.total_distance_km, u.last_login_at, u.created_at,
        (SELECT COUNT(*)::int FROM pokemon_instances WHERE user_id = u.id) AS pokemon_count,
        (SELECT COUNT(*)::int FROM pokedex_entries WHERE user_id = u.id AND caught_count > 0) AS pokedex_caught,
        (SELECT COUNT(*)::int FROM friendships WHERE user_a = u.id OR user_b = u.id) AS friend_count
      FROM users u WHERE u.id = $1
    `, [req.user.sub]);

    if (!rows[0]) throw new AppError(2003, '用户不存在', 404);
    res.json(successResp(rows[0]));
  } catch (err) { next(err); }
});

// ── PATCH /users/me ───────────────────────────────────────────
router.patch('/me', async (req, res, next) => {
  try {
    const schema = z.object({
      nickname:   z.string().min(2).max(30).optional(),
      avatar_url: z.string().url().optional(),
    });
    const data = schema.parse(req.body);

    if (data.nickname) {
      const dup = await query('SELECT id FROM users WHERE nickname=$1 AND id<>$2', [data.nickname, req.user.sub]);
      if (dup.rows.length > 0) throw new AppError(2002, '昵称已被使用', 409);
    }

    const fields = Object.keys(data);
    if (fields.length === 0) return res.json(successResp(null, '无需更新'));

    const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values    = [...Object.values(data), req.user.sub];
    await query(`UPDATE users SET ${setClause} WHERE id = $${fields.length + 1}`, values);

    res.json(successResp(null, '更新成功'));
  } catch (err) { next(err); }
});

// ── POST /users/team ──────────────────────────────────────────
router.post('/team', async (req, res, next) => {
  try {
    const { team } = z.object({ team: z.enum(['VALOR','MYSTIC','INSTINCT']) }).parse(req.body);
    const { rows: [user] } = await query(
      'SELECT team, team_changed_at FROM users WHERE id = $1', [req.user.sub]
    );

    if (user.team === team) throw new AppError(2005, '已在该队伍', 400);

    // Check 30-day cooldown
    if (user.team && user.team_changed_at) {
      const daysSince = (Date.now() - new Date(user.team_changed_at).getTime()) / 86400000;
      if (daysSince < 30) throw new AppError(2006, `还需 ${Math.ceil(30 - daysSince)} 天才能换队伍`, 400);
    }

    await query(
      'UPDATE users SET team=$1, team_changed_at=NOW() WHERE id=$2',
      [team, req.user.sub]
    );
    res.json(successResp({ team }, '加入队伍成功'));
  } catch (err) { next(err); }
});

// ── GET /users/:id (public profile) ──────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT id, nickname, avatar_url, team, level,
             (SELECT COUNT(*)::int FROM pokemon_instances WHERE user_id = u.id) AS pokemon_count
      FROM users u WHERE id = $1
    `, [req.params.id]);
    if (!rows[0]) throw new AppError(2003, '用户不存在', 404);
    res.json(successResp(rows[0]));
  } catch (err) { next(err); }
});

// ── GET /users/me/inventory ───────────────────────────────────
router.get('/me/inventory', async (req, res, next) => {
  try {
    const { rows: [inv] } = await query(`
      SELECT pokeball_count, greatball_count, ultraball_count, masterball_count,
             stardust, coins, premium_coins
      FROM users WHERE id = $1
    `, [req.user.sub]);
    res.json(successResp(inv));
  } catch (err) { next(err); }
});

// ── GET /users/me/quests (today's daily quest) ────────────────
router.get('/me/quests', async (req, res, next) => {
  try {
    // Ensure today's quest exists
    await query(`
      INSERT INTO daily_quests (user_id)
      VALUES ($1)
      ON CONFLICT (user_id, quest_date) DO NOTHING
    `, [req.user.sub]);

    const { rows: [quest] } = await query(`
      SELECT * FROM daily_quests
      WHERE user_id=$1 AND quest_date = CURRENT_DATE
    `, [req.user.sub]);
    res.json(successResp(quest));
  } catch (err) { next(err); }
});

// ── GET /users/me/achievements ────────────────────────────────
router.get('/me/achievements', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT ad.id, ad.name_zh, ad.category, ad.tiers,
             COALESCE(ua.current_value, 0) AS current_value,
             COALESCE(ua.current_tier, 0) AS current_tier,
             ua.unlocked_at
      FROM achievement_definitions ad
      LEFT JOIN user_achievements ua ON ua.achievement_id = ad.id AND ua.user_id = $1
      ORDER BY ad.category, ad.id
    `, [req.user.sub]);
    res.json(successResp(rows));
  } catch (err) { next(err); }
});

module.exports = router;
