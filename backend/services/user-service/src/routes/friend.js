// user-service/src/routes/friend.js
'use strict';
const express = require('express');
const { query } = require('../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');

const router = express.Router();
router.use(requireAuth);

// GET /friends  — list my friends (proxied through user-service for profile enrichment)
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { rows } = await query(`
      SELECT
        CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END AS friend_id,
        u.nickname, u.avatar_url, u.level, u.team,
        f.level AS friendship_level,
        f.interaction_days,
        f.last_interaction_at,
        u.last_login_at
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END
      WHERE f.user_a=$1 OR f.user_b=$1
      ORDER BY f.last_interaction_at DESC
      LIMIT 200
    `, [userId]);
    res.json(successResp(rows));
  } catch (err) { next(err); }
});

// GET /friends/search?q=nickname
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) throw new AppError(1001, '搜索词至少2个字符', 400);
    const { rows } = await query(`
      SELECT id, nickname, avatar_url, level, team
      FROM users
      WHERE nickname ILIKE $1 AND id != $2
      LIMIT 20
    `, [`%${q}%`, req.user.sub]);
    res.json(successResp(rows));
  } catch (err) { next(err); }
});

// GET /friends/code  — get my friend code (just userId for simplicity)
router.get('/code', async (req, res, next) => {
  try {
    res.json(successResp({ friendCode: req.user.sub }));
  } catch (err) { next(err); }
});

module.exports = router;
