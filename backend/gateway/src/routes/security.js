'use strict';
/**
 * 安全相关路由
 * REQ-00111: API 安全响应头与 CSP 强化系统
 */

const express = require('express');
const { createLogger } = require('@pmg/shared/logger');
const metrics = require('@pmg/shared/metrics');

const router = express.Router();
const logger = createLogger('security-routes');

// CSP 违规计数器
const cspViolationCounter = new metrics.Counter({
  name: 'security_csp_violations_total',
  help: 'Total number of CSP violations',
  labelNames: ['directive', 'blocked_uri']
});

// 安全事件计数器
const securityEventCounter = new metrics.Counter({
  name: 'security_events_total',
  help: 'Total number of security events',
  labelNames: ['event_type', 'severity']
});

/**
 * CSP 违规报告端点
 * POST /api/v1/security/csp-report
 */
router.post('/csp-report',
  express.json({ type: 'application/csp-report' }),
  async (req, res) => {
    try {
      const report = req.body['csp-report'];

      if (!report) {
        return res.status(400).json({ error: 'Invalid CSP report' });
      }

      const {
        'document-uri': documentUri,
        'violated-directive': violatedDirective,
        'blocked-uri': blockedUri,
        'original-policy': originalPolicy,
        'source-file': sourceFile,
        'line-number': lineNumber,
        'column-number': columnNumber
      } = report;

      // 记录日志
      logger.warn('CSP violation reported', {
        documentUri,
        violatedDirective,
        blockedUri,
        sourceFile,
        lineNumber,
        columnNumber,
        userAgent: req.headers['user-agent'],
        ip: req.ip
      });

      // Prometheus 指标
      cspViolationCounter.inc({
        directive: violatedDirective || 'unknown',
        blocked_uri: blockedUri ? new URL(blockedUri).hostname : 'inline'
      });

      // 如果有数据库连接，记录到数据库
      if (req.app.locals.db) {
        try {
          await req.app.locals.db.query(`
            INSERT INTO csp_violation_reports
            (document_uri, violated_directive, blocked_uri, user_agent, ip_address, user_id)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            documentUri,
            violatedDirective,
            blockedUri,
            req.headers['user-agent'],
            req.ip,
            req.user?.id || null
          ]);
        } catch (dbErr) {
          logger.error('Failed to save CSP report to database', { err: dbErr });
        }
      }

      res.status(204).send();
    } catch (err) {
      logger.error('Error processing CSP report', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * 记录安全事件
 * POST /api/v1/security/events
 */
router.post('/events',
  express.json(),
  async (req, res) => {
    try {
      const { eventType, severity = 'medium', details = {} } = req.body;

      const validEventTypes = [
        'CSRF_FAILURE',
        'ORIGIN_MISMATCH',
        'REFERER_INVALID',
        'CSP_VIOLATION',
        'XSS_ATTEMPT',
        'SQL_INJECTION_ATTEMPT',
        'RATE_LIMIT_EXCEEDED',
        'AUTH_FAILURE',
        'SUSPICIOUS_ACTIVITY'
      ];

      const validSeverities = ['low', 'medium', 'high', 'critical'];

      if (!validEventTypes.includes(eventType)) {
        return res.status(400).json({ error: 'Invalid event type' });
      }

      if (!validSeverities.includes(severity)) {
        return res.status(400).json({ error: 'Invalid severity' });
      }

      // 记录日志
      logger.info('Security event recorded', {
        eventType,
        severity,
        details,
        userId: req.user?.id,
        ip: req.ip,
        userAgent: req.headers['user-agent']
      });

      // Prometheus 指标
      securityEventCounter.inc({
        event_type: eventType,
        severity
      });

      // 保存到数据库
      if (req.app.locals.db) {
        try {
          await req.app.locals.db.query(`
            INSERT INTO security_events
            (event_type, user_id, ip_address, user_agent, details, severity)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            eventType,
            req.user?.id || null,
            req.ip,
            req.headers['user-agent'],
            JSON.stringify(details),
            severity
          ]);
        } catch (dbErr) {
          logger.error('Failed to save security event to database', { err: dbErr });
        }
      }

      res.status(201).json({ success: true });
    } catch (err) {
      logger.error('Error recording security event', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * 获取安全事件统计
 * GET /api/v1/security/stats
 */
router.get('/stats', async (req, res) => {
  try {
    const { period = '24h' } = req.query;

    let interval;
    switch (period) {
      case '1h':
        interval = '1 hour';
        break;
      case '24h':
        interval = '24 hours';
        break;
      case '7d':
        interval = '7 days';
        break;
      case '30d':
        interval = '30 days';
        break;
      default:
        interval = '24 hours';
    }

    if (!req.app.locals.db) {
      return res.json({
        message: 'Database not available',
        period
      });
    }

    // 按事件类型统计
    const typeStats = await req.app.locals.db.query(`
      SELECT event_type, COUNT(*) as count
      FROM security_events
      WHERE created_at > NOW() - INTERVAL '${interval}'
      GROUP BY event_type
      ORDER BY count DESC
    `);

    // 按严重程度统计
    const severityStats = await req.app.locals.db.query(`
      SELECT severity, COUNT(*) as count
      FROM security_events
      WHERE created_at > NOW() - INTERVAL '${interval}'
      GROUP BY severity
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
        END
    `);

    // CSP 违规统计
    const cspStats = await req.app.locals.db.query(`
      SELECT violated_directive, COUNT(*) as count
      FROM csp_violation_reports
      WHERE created_at > NOW() - INTERVAL '${interval}'
      GROUP BY violated_directive
      ORDER BY count DESC
      LIMIT 10
    `);

    res.json({
      period,
      eventsByType: typeStats.rows,
      eventsBySeverity: severityStats.rows,
      cspViolations: cspStats.rows
    });
  } catch (err) {
    logger.error('Error getting security stats', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 获取 CSRF 令牌
 * GET /api/v1/security/csrf-token
 */
router.get('/csrf-token', (req, res) => {
  res.json({
    token: req.csrfToken || null,
    cookieName: 'XSRF-TOKEN',
    headerName: 'X-XSRF-TOKEN'
  });
});

/**
 * 安全头检查（用于调试）
 * GET /api/v1/security/check
 */
router.get('/check', (req, res) => {
  const headers = {
    'Content-Security-Policy': res.getHeader('Content-Security-Policy'),
    'X-Content-Type-Options': res.getHeader('X-Content-Type-Options'),
    'X-Frame-Options': res.getHeader('X-Frame-Options'),
    'X-XSS-Protection': res.getHeader('X-XSS-Protection'),
    'Strict-Transport-Security': res.getHeader('Strict-Transport-Security'),
    'Referrer-Policy': res.getHeader('Referrer-Policy'),
    'Permissions-Policy': res.getHeader('Permissions-Policy'),
    'Cross-Origin-Resource-Policy': res.getHeader('Cross-Origin-Resource-Policy'),
    'Cross-Origin-Opener-Policy': res.getHeader('Cross-Origin-Opener-Policy')
  };

  // 检查安全头完整性
  const issues = [];
  if (!headers['X-Content-Type-Options']) {
    issues.push('Missing X-Content-Type-Options');
  }
  if (!headers['X-Frame-Options']) {
    issues.push('Missing X-Frame-Options');
  }
  if (!headers['X-XSS-Protection']) {
    issues.push('Missing X-XSS-Protection');
  }

  res.json({
    headers,
    issues,
    score: Math.max(0, 100 - issues.length * 10)
  });
});

module.exports = router;
