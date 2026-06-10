// backend/services/user-service/src/routes/state.js
// User state API for game state persistence and sync
'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../../../shared/db');

/**
 * GET /users/me/state
 * Get user's complete state for sync
 */
router.get('/me/state', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ code: 1002, message: '未授权' });
    }

    // Get user basic info
    const userResult = await db.query(
      `SELECT 
        id, username, email, level, experience, 
        pokeball_count, greatball_count, ultraball_count, masterball_count,
        stardust, coins, team, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ code: 1004, message: '用户不存在' });
    }

    const user = userResult.rows[0];

    // Build state object
    const state = {
      // Auth
      isLoggedIn: true,
      currentUser: {
        id: user.id,
        username: user.username,
        email: user.email,
        level: user.level || 1,
        experience: user.experience || 0,
        team: user.team
      },

      // Inventory (server-authoritative)
      pokeballs: user.pokeball_count || 0,
      greatballs: user.greatball_count || 0,
      ultraballs: user.ultraball_count || 0,
      masterballs: user.masterball_count || 0,
      stardust: user.stardust || 0,
      coins: user.coins || 0,

      // Timestamps
      serverTime: Date.now(),
      lastUpdated: user.updated_at?.getTime() || Date.now()
    };

    res.json({
      code: 0,
      message: 'success',
      data: state
    });
  } catch (error) {
    console.error('[StateAPI] Get state error:', error);
    res.status(500).json({ code: 1500, message: '获取状态失败' });
  }
});

/**
 * GET /users/me/state/checksum
 * Get state checksum for quick sync check
 */
router.get('/me/state/checksum', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ code: 1002, message: '未授权' });
    }

    // Get only essential fields for checksum
    const result = await db.query(
      `SELECT 
        pokeball_count, greatball_count, ultraball_count, masterball_count,
        stardust, coins, level, experience, updated_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ code: 1004, message: '用户不存在' });
    }

    const user = result.rows[0];

    // Generate checksum from key values
    const checksumString = JSON.stringify({
      pokeballs: user.pokeball_count || 0,
      greatballs: user.greatball_count || 0,
      ultraballs: user.ultraball_count || 0,
      masterballs: user.masterball_count || 0,
      stardust: user.stardust || 0,
      coins: user.coins || 0,
      level: user.level || 1,
      experience: user.experience || 0,
      updated_at: user.updated_at?.getTime() || 0
    });

    const checksum = crypto
      .createHash('md5')
      .update(checksumString)
      .digest('hex');

    res.json({
      code: 0,
      message: 'success',
      data: {
        checksum,
        serverTime: Date.now(),
        lastUpdated: user.updated_at?.getTime() || Date.now()
      }
    });
  } catch (error) {
    console.error('[StateAPI] Get checksum error:', error);
    res.status(500).json({ code: 1500, message: '获取校验和失败' });
  }
});

/**
 * POST /users/me/state/ping
 * Simple ping endpoint for connectivity check
 */
router.post('/me/state/ping', async (req, res) => {
  try {
    const userId = req.user?.id;
    
    res.json({
      code: 0,
      message: 'success',
      data: {
        online: true,
        serverTime: Date.now(),
        authenticated: !!userId
      }
    });
  } catch (error) {
    res.status(500).json({ code: 1500, message: 'Ping failed' });
  }
});

/**
 * GET /users/me/storage/stats
 * Get server-side storage statistics for comparison
 */
router.get('/me/storage/stats', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ code: 1002, message: '未授权' });
    }

    // Get Pokemon count
    const pokemonCount = await db.query(
      'SELECT COUNT(*) FROM user_pokemon WHERE user_id = $1',
      [userId]
    );

    // Get friend count
    const friendCount = await db.query(
      'SELECT COUNT(*) FROM friendships WHERE (user_id = $1 OR friend_id = $1) AND status = $2',
      [userId, 'accepted']
    );

    // Get recent catch count (last 7 days)
    const recentCatches = await db.query(
      `SELECT COUNT(*) FROM catch_sessions 
       WHERE user_id = $1 AND success = true AND created_at > NOW() - INTERVAL '7 days'`,
      [userId]
    );

    res.json({
      code: 0,
      message: 'success',
      data: {
        pokemonCount: parseInt(pokemonCount.rows[0].count) || 0,
        friendCount: parseInt(friendCount.rows[0].count) || 0,
        recentCatches: parseInt(recentCatches.rows[0].count) || 0,
        serverTime: Date.now()
      }
    });
  } catch (error) {
    console.error('[StateAPI] Get storage stats error:', error);
    res.status(500).json({ code: 1500, message: '获取存储统计失败' });
  }
});

module.exports = router;
