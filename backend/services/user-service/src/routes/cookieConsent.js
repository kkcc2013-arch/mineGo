/**
 * Cookie 同意管理 API 路由
 * REQ-00322: Cookie 同意管理与隐私偏好中心
 */

const express = require('express');
const router = express.Router();
const logger = require('../../../shared/logger');
const { auditLog, AuditActions } = require('../../../shared/auditLog');

let db;

/**
 * 初始化路由
 */
function initCookieConsentRoutes(database) {
  db = database;
}

/**
 * 获取 Cookie 同意状态
 * GET /api/v1/privacy/consent
 */
router.get('/consent', async (req, res) => {
  try {
    const userId = req.user?.id;
    const deviceId = req.headers['x-device-id'] || req.cookies?.device_id;

    let consent = null;

    if (userId) {
      const { rows } = await db.query(`
        SELECT * FROM cookie_consents 
        WHERE user_id = $1 
        ORDER BY consented_at DESC 
        LIMIT 1
      `, [userId]);
      consent = rows[0];
    } else if (deviceId) {
      const { rows } = await db.query(`
        SELECT * FROM cookie_consents 
        WHERE device_id = $1 
        ORDER BY consented_at DESC 
        LIMIT 1
      `, [deviceId]);
      consent = rows[0];
    }

    // 如果没有同意记录，返回默认值
    if (!consent) {
      return res.json({
        success: true,
        data: {
          hasConsent: false,
          categories: {
            necessary: true,  // 必要 Cookie 始终为 true
            functional: false,
            analytics: false,
            marketing: false,
            social: false,
            performance: false
          },
          consentVersion: '1.0'
        }
      });
    }

    // 检查是否过期
    const isExpired = consent.expires_at && new Date(consent.expires_at) < new Date();

    res.json({
      success: true,
      data: {
        hasConsent: !isExpired,
        categories: {
          necessary: true,
          ...consent.categories
        },
        consentedAt: consent.consented_at,
        consentVersion: consent.consent_version,
        source: consent.source,
        isExpired
      }
    });
  } catch (error) {
    logger.error('Failed to get consent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get consent'
    });
  }
});

/**
 * 提交 Cookie 同意
 * POST /api/v1/privacy/consent
 */
router.post('/consent', async (req, res) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');

    const userId = req.user?.id;
    const deviceId = req.headers['x-device-id'] || req.cookies?.device_id;
    const { categories, acceptAll = false, rejectAll = false } = req.body;

    // 处理快捷选项
    let finalCategories;
    if (acceptAll) {
      finalCategories = {
        necessary: true,
        functional: true,
        analytics: true,
        marketing: true,
        social: true,
        performance: true
      };
    } else if (rejectAll) {
      finalCategories = {
        necessary: true,  // 必要 Cookie 无法拒绝
        functional: false,
        analytics: false,
        marketing: false,
        social: false,
        performance: false
      };
    } else {
      finalCategories = {
        necessary: true,
        ...categories
      };
    }

    // 计算 IP 地址
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0] || 
                     req.connection?.remoteAddress ||
                     req.ip;
    
    // 插入同意记录
    const { rows } = await client.query(`
      INSERT INTO cookie_consents (
        user_id, device_id, categories, ip_address, 
        user_agent, source, consent_version, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP + INTERVAL '1 year')
      RETURNING id
    `, [
      userId,
      deviceId,
      JSON.stringify(finalCategories),
      ipAddress,
      req.headers['user-agent'],
      req.body.source || 'banner',
      '1.0'
    ]);

    const consentId = rows[0].id;

    // 记录审计日志
    await client.query(`
      INSERT INTO cookie_consent_audit_logs (
        consent_id, user_id, device_id, action, 
        new_categories, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      consentId,
      userId,
      deviceId,
      'created',
      JSON.stringify(finalCategories),
      ipAddress,
      req.headers['user-agent']
    ]);

    await client.query('COMMIT');

    // 审计日志
    if (userId) {
      await auditLog(db, {
        userId,
        action: AuditActions.PRIVACY_CONSENT_UPDATED,
        resourceType: 'cookie_consent',
        resourceId: consentId.toString(),
        newValues: finalCategories,
        ipAddress,
        userAgent: req.headers['user-agent']
      });
    }

    logger.info('Cookie consent recorded', {
      userId,
      deviceId,
      categories: finalCategories
    });

    res.json({
      success: true,
      data: {
        consentId,
        categories: finalCategories,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to record consent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to record consent'
    });
  } finally {
    client.release();
  }
});

/**
 * 更新 Cookie 同意
 * PUT /api/v1/privacy/consent
 */
router.put('/consent', async (req, res) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const { categories } = req.body;
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

    // 获取当前同意记录
    const { rows: currentRows } = await client.query(`
      SELECT id, categories FROM cookie_consents 
      WHERE user_id = $1 
      ORDER BY consented_at DESC 
      LIMIT 1
    `, [userId]);

    const currentConsent = currentRows[0];
    const previousCategories = currentConsent?.categories || {};

    // 更新同意记录
    const newCategories = {
      necessary: true,
      ...categories
    };

    const { rows } = await client.query(`
      UPDATE cookie_consents 
      SET categories = $1, consented_at = CURRENT_TIMESTAMP, ip_address = $2
      WHERE user_id = $3
      RETURNING id
    `, [JSON.stringify(newCategories), ipAddress, userId]);

    // 记录审计日志
    await client.query(`
      INSERT INTO cookie_consent_audit_logs (
        consent_id, user_id, action, previous_categories, 
        new_categories, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      rows[0].id,
      userId,
      'updated',
      JSON.stringify(previousCategories),
      JSON.stringify(newCategories),
      ipAddress,
      req.headers['user-agent']
    ]);

    await client.query('COMMIT');

    res.json({
      success: true,
      data: { categories: newCategories }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to update consent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update consent'
    });
  } finally {
    client.release();
  }
});

/**
 * 撤回 Cookie 同意
 * POST /api/v1/privacy/consent/withdraw
 */
router.post('/consent/withdraw', async (req, res) => {
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

    // 获取当前同意记录
    const { rows: currentRows } = await client.query(`
      SELECT id, categories FROM cookie_consents 
      WHERE user_id = $1 
      ORDER BY consented_at DESC 
      LIMIT 1
    `, [userId]);

    if (!currentRows[0]) {
      return res.status(404).json({
        success: false,
        error: 'No consent found'
      });
    }

    const previousCategories = currentRows[0].categories;

    // 更新为仅必要 Cookie
    const newCategories = {
      necessary: true,
      functional: false,
      analytics: false,
      marketing: false,
      social: false,
      performance: false
    };

    await client.query(`
      UPDATE cookie_consents 
      SET categories = $1, consented_at = CURRENT_TIMESTAMP
      WHERE user_id = $2
    `, [JSON.stringify(newCategories), userId]);

    // 记录审计日志
    await client.query(`
      INSERT INTO cookie_consent_audit_logs (
        consent_id, user_id, action, previous_categories, 
        new_categories, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      currentRows[0].id,
      userId,
      'withdrawn',
      JSON.stringify(previousCategories),
      JSON.stringify(newCategories),
      ipAddress,
      req.headers['user-agent']
    ]);

    await client.query('COMMIT');

    res.json({
      success: true,
      data: { categories: newCategories }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to withdraw consent:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to withdraw consent'
    });
  } finally {
    client.release();
  }
});

/**
 * 获取同意历史
 * GET /api/v1/privacy/consent/history
 */
router.get('/consent/history', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const { limit = 10 } = req.query;

    const { rows } = await db.query(`
      SELECT 
        action,
        previous_categories,
        new_categories,
        ip_address,
        created_at
      FROM cookie_consent_audit_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, parseInt(limit)]);

    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    logger.error('Failed to get consent history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get consent history'
    });
  }
});

/**
 * 管理员接口：获取 Cookie 定义
 * GET /api/v1/admin/privacy/cookie-definitions
 */
router.get('/admin/cookie-definitions', async (req, res) => {
  try {
    if (req.user?.role !== 'admin' && !req.user?.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { rows } = await db.query(`
      SELECT * FROM cookie_definitions
      WHERE is_active = true
      ORDER BY category, name
    `);

    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    logger.error('Failed to get cookie definitions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get cookie definitions'
    });
  }
});

/**
 * 管理员接口：获取同意统计
 * GET /api/v1/admin/privacy/consents/stats
 */
router.get('/admin/consents/stats', async (req, res) => {
  try {
    if (req.user?.role !== 'admin' && !req.user?.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { startDate, endDate } = req.query;

    const { rows } = await db.query(`
      SELECT * FROM cookie_consent_stats
      WHERE date >= $1 AND date <= $2
      ORDER BY date DESC
    `, [
      startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      endDate || new Date()
    ]);

    // 计算汇总
    const summary = {
      totalConsents: rows.reduce((sum, r) => sum + r.total_consents, 0),
      analyticsAcceptanceRate: 0,
      marketingAcceptanceRate: 0
    };

    if (summary.totalConsents > 0) {
      summary.analyticsAcceptanceRate = 
        rows.reduce((sum, r) => sum + r.analytics_accepted, 0) / summary.totalConsents;
      summary.marketingAcceptanceRate = 
        rows.reduce((sum, r) => sum + r.marketing_accepted, 0) / summary.totalConsents;
    }

    res.json({
      success: true,
      data: {
        dailyStats: rows,
        summary
      }
    });
  } catch (error) {
    logger.error('Failed to get consent stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get consent stats'
    });
  }
});

module.exports = {
  router,
  initCookieConsentRoutes
};
