/**
 * 分享记录 API 路由
 * REQ-00153: 游戏内截图分享与社交传播系统
 */

const express = require('express');
const router = express.Router();
const db = require('../../../shared/db');
const { getRedisClient } = require('../../../shared/cache');
const logger = require('../../../shared/logger')('share-routes');
const metrics = require('../../../shared/metrics');

// 分享场景枚举
const SHARE_SCENES = {
  CATCH: 'catch',
  ACHIEVEMENT: 'achievement',
  BATTLE: 'battle',
  POKEDEX: 'pokedex',
  FRIEND: 'friend',
  CUSTOM: 'custom'
};

// 分享平台枚举
const SHARE_PLATFORMS = {
  WECHAT: 'wechat',
  WEIBO: 'weibo',
  TWITTER: 'twitter',
  FACEBOOK: 'facebook',
  SYSTEM: 'system'
};

/**
 * POST /api/v1/share/record
 * 记录分享事件
 */
router.post('/record', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { scene, platform, success, content, imageUrl } = req.body;

    // 验证场景
    if (!Object.values(SHARE_SCENES).includes(scene)) {
      return res.status(400).json({ error: 'Invalid scene' });
    }

    // 验证平台
    if (!Object.values(SHARE_PLATFORMS).includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    // 插入分享记录
    const result = await db.query(`
      INSERT INTO share_records (
        user_id, scene, platform, success,
        content_title, content_description,
        image_url, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, created_at
    `, [
      userId,
      scene,
      platform,
      success,
      content?.title || null,
      content?.description || null,
      imageUrl || null,
      req.ip,
      req.get('user-agent')
    ]);

    // 更新 Prometheus 指标
    metrics.shareTotal?.labels(scene, platform, success ? 'success' : 'fail').inc();

    // 更新 Redis 缓存统计
    const redis = getRedisClient();
    const today = new Date().toISOString().split('T')[0];
    await redis.hincrby(`share:stats:${today}`, `${scene}:${platform}`, 1);
    await redis.expire(`share:stats:${today}`, 86400 * 30); // 30 天过期

    logger.info('Share recorded', {
      userId,
      scene,
      platform,
      success,
      shareId: result.rows[0].id
    });

    res.json({
      success: true,
      shareId: result.rows[0].id,
      createdAt: result.rows[0].created_at
    });

  } catch (error) {
    logger.error('Failed to record share', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/share/track
 * 追踪分享事件（轻量级，无需认证）
 */
router.post('/track', async (req, res) => {
  try {
    const { platform, success, scene } = req.body;

    // 更新 Prometheus 指标
    if (scene && platform) {
      metrics.shareTotal?.labels(scene, platform, success ? 'success' : 'fail').inc();
    }

    // 更新 Redis 统计
    const redis = getRedisClient();
    const today = new Date().toISOString().split('T')[0];
    const key = scene ? `${scene}:${platform}` : `unknown:${platform}`;
    await redis.hincrby(`share:stats:${today}`, key, 1);

    res.json({ success: true });

  } catch (error) {
    // 静默失败
    res.json({ success: true });
  }
});

/**
 * GET /api/v1/share/history
 * 获取用户分享历史
 */
router.get('/history', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { limit = 20, offset = 0, scene } = req.query;

    let query = `
      SELECT id, scene, platform, success, 
             content_title, content_description,
             image_url, created_at
      FROM share_records
      WHERE user_id = $1
    `;
    const params = [userId];
    let paramIndex = 2;

    if (scene) {
      query += ` AND scene = $${paramIndex}`;
      params.push(scene);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // 获取总数
    const countResult = await db.query(`
      SELECT COUNT(*) as total FROM share_records WHERE user_id = $1
    `, [userId]);

    res.json({
      shares: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

  } catch (error) {
    logger.error('Failed to get share history', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/share/stats
 * 获取分享统计
 */
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { period = '7d' } = req.query;

    // 计算时间范围
    let startDate;
    switch (period) {
      case '1d':
        startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    }

    // 按场景统计
    const sceneStats = await db.query(`
      SELECT scene, COUNT(*) as count, 
             SUM(CASE WHEN success THEN 1 ELSE 0 END) as success_count
      FROM share_records
      WHERE user_id = $1 AND created_at >= $2
      GROUP BY scene
      ORDER BY count DESC
    `, [userId, startDate]);

    // 按平台统计
    const platformStats = await db.query(`
      SELECT platform, COUNT(*) as count,
             SUM(CASE WHEN success THEN 1 ELSE 0 END) as success_count
      FROM share_records
      WHERE user_id = $1 AND created_at >= $2
      GROUP BY platform
      ORDER BY count DESC
    `, [userId, startDate]);

    // 总计
    const totalStats = await db.query(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN success THEN 1 ELSE 0 END) as success_total
      FROM share_records
      WHERE user_id = $1 AND created_at >= $2
    `, [userId, startDate]);

    const total = parseInt(totalStats.rows[0].total);
    const successTotal = parseInt(totalStats.rows[0].success_total);

    res.json({
      period,
      startDate: startDate.toISOString(),
      total,
      successTotal,
      successRate: total > 0 ? successTotal / total : 0,
      byScene: sceneStats.rows.map(r => ({
        scene: r.scene,
        count: parseInt(r.count),
        successCount: parseInt(r.success_count),
        successRate: parseInt(r.count) > 0 ? parseInt(r.success_count) / parseInt(r.count) : 0
      })),
      byPlatform: platformStats.rows.map(r => ({
        platform: r.platform,
        count: parseInt(r.count),
        successCount: parseInt(r.success_count),
        successRate: parseInt(r.count) > 0 ? parseInt(r.success_count) / parseInt(r.count) : 0
      }))
    });

  } catch (error) {
    logger.error('Failed to get share stats', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/share/trending
 * 获取热门分享内容（公开）
 */
router.get('/trending', async (req, res) => {
  try {
    const { scene, limit = 10 } = req.query;

    let query = `
      SELECT scene, content_title, COUNT(*) as share_count
      FROM share_records
      WHERE success = true
        AND created_at >= NOW() - INTERVAL '7 days'
        AND content_title IS NOT NULL
    `;
    const params = [];

    if (scene) {
      query += ` AND scene = $1`;
      params.push(scene);
    }

    query += `
      GROUP BY scene, content_title
      ORDER BY share_count DESC
      LIMIT $${params.length + 1}
    `;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    res.json({
      trending: result.rows.map(r => ({
        scene: r.scene,
        title: r.content_title,
        shareCount: parseInt(r.share_count)
      }))
    });

  } catch (error) {
    logger.error('Failed to get trending shares', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/share/clickback
 * 记录分享链接点击回溯
 */
router.post('/clickback', async (req, res) => {
  try {
    const { shareId, referrer } = req.body;

    if (!shareId) {
      return res.status(400).json({ error: 'Missing shareId' });
    }

    // 更新点击计数
    await db.query(`
      UPDATE share_records 
      SET click_count = COALESCE(click_count, 0) + 1,
          last_click_at = NOW()
      WHERE id = $1
    `, [shareId]);

    // 记录点击来源
    if (referrer) {
      const redis = getRedisClient();
      await redis.hincrby('share:clickback:stats', referrer, 1);
    }

    res.json({ success: true });

  } catch (error) {
    logger.error('Failed to record clickback', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
