# REQ-00303: 敏感操作审计日志与操作追溯系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00303 |
| 标题 | 敏感操作审计日志与操作追溯系统 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、user-service、payment-service、social-service、pokemon-service、admin-dashboard、backend/shared、database/migrations |
| 创建时间 | 2026-06-23 08:00 |

## 需求描述

### 背景与问题

当前系统存在以下审计合规问题：

1. **敏感操作无审计追踪**：用户登录、支付、精灵交易、账号修改等敏感操作缺乏完整的审计日志
2. **无法追溯操作来源**：缺少操作者 IP、设备、时间戳等关键信息，安全事件无法追溯
3. **合规性不足**：GDPR、PCI-DSS、COPPA 等法规要求敏感操作必须有完整审计记录
4. **审计日志分散**：各服务独立记录日志，缺乏统一查询和分析能力
5. **日志可能被篡改**：审计日志与业务日志混合存储，存在被删除或篡改风险
6. **缺少告警机制**：异常敏感操作（如批量删除、异常登录）无实时告警

这些问题可能导致：
- 安全事件无法追溯定责
- 无法满足金融级合规审计要求
- 数据泄露无法及时发现和定位
- 监管审查不合格风险

### 目标

构建完整的敏感操作审计系统，实现：

1. **全链路审计**：覆盖登录、支付、交易、账号管理等所有敏感操作
2. **不可篡改存储**：审计日志独立存储，支持防篡改校验
3. **实时分析告警**：异常敏感操作实时告警
4. **合规报告生成**：支持 GDPR、PCI-DSS 审计报告自动生成
5. **高效查询追溯**：支持多维度查询和可视化追溯

## 技术方案

### 1. 审计事件定义与分类

```javascript
// backend/shared/audit/AuditEventTypes.js

const AuditEventCategory = {
  AUTHENTICATION: 'AUTHENTICATION',     // 认证相关
  PAYMENT: 'PAYMENT',                   // 支付相关
  DATA_ACCESS: 'DATA_ACCESS',           // 数据访问
  DATA_MODIFICATION: 'DATA_MODIFICATION', // 数据修改
  ADMIN_OPERATION: 'ADMIN_OPERATION',   // 管理员操作
  COMPLIANCE: 'COMPLIANCE',             // 合规相关
};

const AuditEventType = {
  // 认证类
  USER_LOGIN: { category: 'AUTHENTICATION', severity: 'MEDIUM', description: '用户登录' },
  USER_LOGOUT: { category: 'AUTHENTICATION', severity: 'LOW', description: '用户登出' },
  LOGIN_FAILED: { category: 'AUTHENTICATION', severity: 'HIGH', description: '登录失败' },
  MFA_ENABLED: { category: 'AUTHENTICATION', severity: 'MEDIUM', description: '启用多因素认证' },
  MFA_DISABLED: { category: 'AUTHENTICATION', severity: 'HIGH', description: '禁用多因素认证' },
  PASSWORD_CHANGED: { category: 'AUTHENTICATION', severity: 'HIGH', description: '密码修改' },
  PASSWORD_RESET: { category: 'AUTHENTICATION', severity: 'MEDIUM', description: '密码重置' },
  
  // 支付类
  PAYMENT_INITIATED: { category: 'PAYMENT', severity: 'HIGH', description: '发起支付' },
  PAYMENT_COMPLETED: { category: 'PAYMENT', severity: 'HIGH', description: '支付完成' },
  PAYMENT_FAILED: { category: 'PAYMENT', severity: 'HIGH', description: '支付失败' },
  PAYMENT_REFUNDED: { category: 'PAYMENT', severity: 'HIGH', description: '支付退款' },
  SUBSCRIPTION_CREATED: { category: 'PAYMENT', severity: 'MEDIUM', description: '创建订阅' },
  SUBSCRIPTION_CANCELLED: { category: 'PAYMENT', severity: 'MEDIUM', description: '取消订阅' },
  
  // 数据访问类
  POKEMON_VIEWED: { category: 'DATA_ACCESS', severity: 'LOW', description: '查看精灵详情' },
  USER_PROFILE_VIEWED: { category: 'DATA_ACCESS', severity: 'LOW', description: '查看用户资料' },
  SENSITIVE_DATA_EXPORTED: { category: 'DATA_ACCESS', severity: 'HIGH', description: '导出敏感数据' },
  
  // 数据修改类
  POKEMON_TRADED: { category: 'DATA_MODIFICATION', severity: 'HIGH', description: '精灵交易' },
  POKEMON_RELEASED: { category: 'DATA_MODIFICATION', severity: 'MEDIUM', description: '精灵放生' },
  USER_PROFILE_UPDATED: { category: 'DATA_MODIFICATION', severity: 'MEDIUM', description: '更新用户资料' },
  EMAIL_CHANGED: { category: 'DATA_MODIFICATION', severity: 'HIGH', description: '邮箱修改' },
  PHONE_CHANGED: { category: 'DATA_MODIFICATION', severity: 'HIGH', description: '手机号修改' },
  ACCOUNT_DELETED: { category: 'DATA_MODIFICATION', severity: 'CRITICAL', description: '账号删除' },
  
  // 管理员操作类
  ADMIN_USER_BANNED: { category: 'ADMIN_OPERATION', severity: 'CRITICAL', description: '封禁用户' },
  ADMIN_USER_UNBANNED: { category: 'ADMIN_OPERATION', severity: 'HIGH', description: '解封用户' },
  ADMIN_DATA_ACCESSED: { category: 'ADMIN_OPERATION', severity: 'HIGH', description: '管理员访问数据' },
  ADMIN_CONFIG_CHANGED: { category: 'ADMIN_OPERATION', severity: 'CRITICAL', description: '系统配置修改' },
  ADMIN_PERMISSION_GRANTED: { category: 'ADMIN_OPERATION', severity: 'CRITICAL', description: '授权管理权限' },
  
  // 合规类
  GDPR_DATA_EXPORT: { category: 'COMPLIANCE', severity: 'HIGH', description: 'GDPR 数据导出请求' },
  GDPR_DATA_DELETE: { category: 'COMPLIANCE', severity: 'CRITICAL', description: 'GDPR 数据删除请求' },
  CONSENT_GRANTED: { category: 'COMPLIANCE', severity: 'MEDIUM', description: '用户授权同意' },
  CONSENT_REVOKED: { category: 'COMPLIANCE', severity: 'MEDIUM', description: '用户撤销授权' },
};

const AuditSeverity = {
  LOW: 'LOW',           // 低风险操作，保留 90 天
  MEDIUM: 'MEDIUM',     // 中等风险，保留 1 年
  HIGH: 'HIGH',         // 高风险，保留 3 年
  CRITICAL: 'CRITICAL', // 关键操作，永久保留
};

module.exports = { AuditEventCategory, AuditEventType, AuditSeverity };
```

### 2. 审计日志中间件

```javascript
// backend/shared/audit/AuditLogger.js

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { AuditEventType, AuditSeverity } = require('./AuditEventTypes');
const AuditLog = require('../models/AuditLog');
const { kafkaProducer } = require('../kafka');
const { hashChain } = require('./HashChain');

class AuditLogger {
  constructor() {
    this.previousHash = null;
    this.initialized = false;
  }
  
  /**
   * 记录审计日志
   */
  async log(eventType, context, metadata = {}) {
    const eventConfig = AuditEventType[eventType];
    if (!eventConfig) {
      throw new Error(`Unknown audit event type: ${eventType}`);
    }
    
    const auditEntry = {
      // 基本信息
      id: uuidv4(),
      eventType,
      category: eventConfig.category,
      severity: eventConfig.severity,
      description: eventConfig.description,
      
      // 操作者信息
      actor: {
        userId: context.userId || null,
        userType: context.userType || 'USER', // USER, ADMIN, SYSTEM
        ip: context.ip || this.extractIp(context.req),
        userAgent: context.userAgent || context.req?.headers?.['user-agent'],
        deviceId: context.deviceId,
        sessionId: context.sessionId,
      },
      
      // 目标信息
      target: {
        type: metadata.targetType || null,
        id: metadata.targetId || null,
        beforeState: metadata.beforeState || null,
        afterState: metadata.afterState || null,
      },
      
      // 操作详情
      details: {
        action: metadata.action || eventType,
        reason: metadata.reason || null,
        amount: metadata.amount || null,
        currency: metadata.currency || null,
        additionalData: metadata.additionalData || {},
      },
      
      // 环境信息
      environment: {
        service: process.env.SERVICE_NAME,
        version: process.env.SERVICE_VERSION,
        timestamp: new Date().toISOString(),
        requestId: context.requestId || context.req?.id,
      },
      
      // 完整性校验
      integrity: {
        previousHash: this.previousHash,
        currentHash: null, // 后续计算
        signature: null,   // 后续签名
      },
    };
    
    // 计算哈希链（防篡改）
    auditEntry.integrity.currentHash = this.calculateHash(auditEntry);
    auditEntry.integrity.signature = await this.signEntry(auditEntry);
    
    // 更新链
    this.previousHash = auditEntry.integrity.currentHash;
    
    // 持久化存储
    await this.persist(auditEntry);
    
    // 发送到 Kafka 用于实时分析
    await this.publishToKafka(auditEntry);
    
    // 检查是否需要告警
    if (eventConfig.severity === 'HIGH' || eventConfig.severity === 'CRITICAL') {
      await this.checkAndAlert(auditEntry);
    }
    
    return auditEntry;
  }
  
  /**
   * 计算哈希值
   */
  calculateHash(entry) {
    const data = JSON.stringify({
      id: entry.id,
      eventType: entry.eventType,
      actor: entry.actor,
      target: entry.target,
      timestamp: entry.environment.timestamp,
      previousHash: entry.integrity.previousHash,
    });
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * 数字签名（使用私钥）
   */
  async signEntry(entry) {
    const privateKey = process.env.AUDIT_SIGNING_KEY;
    if (!privateKey) return null;
    
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(entry.integrity.currentHash);
    return sign.sign(privateKey, 'base64');
  }
  
  /**
   * 持久化到数据库
   */
  async persist(entry) {
    try {
      await AuditLog.create({
        id: entry.id,
        event_type: entry.eventType,
        category: entry.category,
        severity: entry.severity,
        description: entry.description,
        actor_user_id: entry.actor.userId,
        actor_user_type: entry.actor.userType,
        actor_ip: entry.actor.ip,
        actor_user_agent: entry.actor.userAgent,
        actor_device_id: entry.actor.deviceId,
        actor_session_id: entry.actor.sessionId,
        target_type: entry.target.type,
        target_id: entry.target.id,
        before_state: entry.target.beforeState,
        after_state: entry.target.afterState,
        action: entry.details.action,
        reason: entry.details.reason,
        amount: entry.details.amount,
        currency: entry.details.currency,
        additional_data: entry.details.additionalData,
        service: entry.environment.service,
        service_version: entry.environment.version,
        timestamp: entry.environment.timestamp,
        request_id: entry.environment.requestId,
        previous_hash: entry.integrity.previousHash,
        current_hash: entry.integrity.currentHash,
        signature: entry.integrity.signature,
      });
    } catch (error) {
      console.error('Failed to persist audit log:', error);
      // 降级：写入本地文件
      this.writeToFile(entry);
    }
  }
  
  /**
   * 发布到 Kafka
   */
  async publishToKafka(entry) {
    await kafkaProducer.send({
      topic: 'audit-events',
      messages: [{
        key: entry.id,
        value: JSON.stringify(entry),
        headers: {
          eventType: entry.eventType,
          severity: entry.severity,
          category: entry.category,
        },
      }],
    });
  }
  
  /**
   * 检查并触发告警
   */
  async checkAndAlert(entry) {
    const alertRules = await this.getAlertRules(entry.eventType);
    
    for (const rule of alertRules) {
      if (await this.matchesRule(entry, rule)) {
        await this.sendAlert(entry, rule);
      }
    }
  }
  
  extractIp(req) {
    if (!req) return null;
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.ip;
  }
  
  writeToFile(entry) {
    // 紧急降级写入本地文件
    const fs = require('fs');
    const path = require('path');
    const logFile = path.join('/var/log/minego', 'audit-fallback.log');
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  }
}

// 单例模式
const auditLogger = new AuditLogger();
module.exports = auditLogger;
```

### 3. 审计日志中间件集成

```javascript
// backend/shared/audit/AuditMiddleware.js

const auditLogger = require('./AuditLogger');
const { AuditEventType } = require('./AuditEventTypes');

/**
 * 审计日志中间件
 * 自动记录敏感 API 调用
 */
function auditMiddleware(sensitiveRoutes = {}) {
  return async (req, res, next) => {
    // 检查是否为敏感路由
    const routeKey = `${req.method}:${req.route?.path || req.path}`;
    const auditConfig = sensitiveRoutes[routeKey];
    
    if (!auditConfig) {
      return next();
    }
    
    // 保存原始方法
    const originalEnd = res.end;
    const originalJson = res.json;
    
    // 拦截响应
    res.json = async function(data) {
      // 记录审计日志
      try {
        await auditLogger.log(auditConfig.eventType, {
          req,
          userId: req.user?.id,
          userType: req.user?.role === 'ADMIN' ? 'ADMIN' : 'USER',
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          deviceId: req.headers['x-device-id'],
          sessionId: req.sessionId,
          requestId: req.id,
        }, {
          targetType: auditConfig.targetType,
          targetId: req.params.id || req.body.id,
          beforeState: req.beforeState, // 需要在路由处理中设置
          afterState: data,
          action: auditConfig.action,
          ...auditConfig.extraMetadata?.(req, data),
        });
      } catch (error) {
        console.error('Audit logging failed:', error);
      }
      
      return originalJson.call(this, data);
    };
    
    next();
  };
}

// 敏感路由配置
const sensitiveRoutesConfig = {
  // 认证相关
  'POST:/api/v1/auth/login': { eventType: 'USER_LOGIN', targetType: 'USER' },
  'POST:/api/v1/auth/logout': { eventType: 'USER_LOGOUT', targetType: 'USER' },
  'POST:/api/v1/auth/change-password': { eventType: 'PASSWORD_CHANGED', targetType: 'USER' },
  
  // 支付相关
  'POST:/api/v1/payments/create': { eventType: 'PAYMENT_INITIATED', targetType: 'PAYMENT' },
  'POST:/api/v1/payments/refund': { eventType: 'PAYMENT_REFUNDED', targetType: 'PAYMENT' },
  
  // 账号管理
  'PUT:/api/v1/users/profile': { eventType: 'USER_PROFILE_UPDATED', targetType: 'USER' },
  'PUT:/api/v1/users/email': { eventType: 'EMAIL_CHANGED', targetType: 'USER' },
  'DELETE:/api/v1/users/account': { eventType: 'ACCOUNT_DELETED', targetType: 'USER' },
  
  // 精灵交易
  'POST:/api/v1/trades/create': { eventType: 'POKEMON_TRADED', targetType: 'TRADE' },
  
  // GDPR
  'POST:/api/v1/gdpr/export': { eventType: 'GDPR_DATA_EXPORT', targetType: 'GDPR_REQUEST' },
  'POST:/api/v1/gdpr/delete': { eventType: 'GDPR_DATA_DELETE', targetType: 'GDPR_REQUEST' },
};

module.exports = { auditMiddleware, sensitiveRoutesConfig };
```

### 4. 数据库表结构

```sql
-- database/migrations/20260623080000_create_audit_logs.sql

-- 主审计日志表
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    description TEXT,
    
    -- 操作者信息
    actor_user_id UUID,
    actor_user_type VARCHAR(20),
    actor_ip INET,
    actor_user_agent TEXT,
    actor_device_id VARCHAR(100),
    actor_session_id VARCHAR(100),
    
    -- 目标信息
    target_type VARCHAR(50),
    target_id UUID,
    before_state JSONB,
    after_state JSONB,
    
    -- 操作详情
    action VARCHAR(100),
    reason TEXT,
    amount DECIMAL(18, 2),
    currency VARCHAR(10),
    additional_data JSONB,
    
    -- 环境信息
    service VARCHAR(50),
    service_version VARCHAR(20),
    timestamp TIMESTAMPTZ NOT NULL,
    request_id VARCHAR(100),
    
    -- 完整性校验
    previous_hash VARCHAR(64),
    current_hash VARCHAR(64) NOT NULL,
    signature TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引优化
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_logs_actor_user_id ON audit_logs(actor_user_id);
CREATE INDEX idx_audit_logs_event_type ON audit_logs(event_type);
CREATE INDEX idx_audit_logs_category ON audit_logs(category);
CREATE INDEX idx_audit_logs_severity ON audit_logs(severity);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_type, target_id);
CREATE INDEX idx_audit_logs_actor_ip ON audit_logs(actor_ip);
CREATE INDEX idx_audit_logs_hash ON audit_logs(current_hash);

-- 分区表（按月分区，便于数据归档）
CREATE TABLE audit_logs_archive (LIKE audit_logs INCLUDING ALL);

-- 审计告警规则表
CREATE TABLE audit_alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    event_types TEXT[], -- 匹配的事件类型
    conditions JSONB,   -- 告警条件
    severity_threshold VARCHAR(20),
    notification_channels TEXT[], -- ['email', 'slack', 'webhook']
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 审计报告生成记录
CREATE TABLE audit_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_type VARCHAR(50) NOT NULL, -- GDPR, PCI_DSS, CUSTOM
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    generated_by UUID,
    file_path TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 视图：审计日志统计
CREATE VIEW v_audit_statistics AS
SELECT 
    DATE_TRUNC('day', timestamp) AS date,
    category,
    severity,
    COUNT(*) AS event_count,
    COUNT(DISTINCT actor_user_id) AS unique_actors,
    COUNT(DISTINCT actor_ip) AS unique_ips
FROM audit_logs
GROUP BY DATE_TRUNC('day', timestamp), category, severity;
```

### 5. 实时告警服务

```javascript
// backend/jobs/auditAlertWorker.js

const { KafkaConsumer } = require('../shared/kafka');
const AuditAlertRule = require('../shared/models/AuditAlertRule');
const auditLogger = require('../shared/audit/AuditLogger');

class AuditAlertWorker {
  constructor() {
    this.consumer = new KafkaConsumer('audit-alerts', ['audit-events']);
    this.alertCache = new Map(); // 频率控制
  }
  
  async start() {
    await this.consumer.connect();
    
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const auditEvent = JSON.parse(message.value.toString());
        await this.processEvent(auditEvent);
      },
    });
  }
  
  async processEvent(event) {
    const rules = await this.getActiveRules();
    
    for (const rule of rules) {
      if (this.matchesRule(event, rule)) {
        await this.evaluateAndAlert(event, rule);
      }
    }
  }
  
  matchesRule(event, rule) {
    // 检查事件类型
    if (rule.event_types?.length > 0) {
      if (!rule.event_types.includes(event.eventType)) {
        return false;
      }
    }
    
    // 检查严重级别
    if (rule.severity_threshold) {
      const severityOrder = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      if (severityOrder.indexOf(event.severity) < severityOrder.indexOf(rule.severity_threshold)) {
        return false;
      }
    }
    
    return true;
  }
  
  async evaluateAndAlert(event, rule) {
    const conditions = rule.conditions || {};
    
    // 频率检测：短时间内多次相同操作
    if (conditions.frequencyCheck) {
      const window = conditions.frequencyCheck.windowMinutes || 5;
      const threshold = conditions.frequencyCheck.threshold || 10;
      
      const cacheKey = `${event.eventType}:${event.actor.userId || event.actor.ip}`;
      const count = this.alertCache.get(cacheKey) || 0;
      
      if (count >= threshold) {
        await this.sendAlert(event, rule, {
          reason: 'FREQUENCY_EXCEEDED',
          count,
          threshold,
        });
      } else {
        this.alertCache.set(cacheKey, count + 1);
        setTimeout(() => this.alertCache.delete(cacheKey), window * 60 * 1000);
      }
    }
    
    // 异常时间检测
    if (conditions.offHoursCheck) {
      const hour = new Date(event.environment.timestamp).getUTCHours();
      const workHoursStart = conditions.offHoursCheck.workHoursStart || 9;
      const workHoursEnd = conditions.offHoursCheck.workHoursEnd || 18;
      
      if (hour < workHoursStart || hour >= workHoursEnd) {
        await this.sendAlert(event, rule, {
          reason: 'OFF_HOURS_OPERATION',
          eventHour: hour,
        });
      }
    }
    
    // 敏感操作直接告警
    if (event.severity === 'CRITICAL') {
      await this.sendAlert(event, rule, {
        reason: 'CRITICAL_OPERATION',
      });
    }
  }
  
  async sendAlert(event, rule, context) {
    const alert = {
      eventId: event.id,
      eventType: event.eventType,
      severity: event.severity,
      actor: event.actor,
      timestamp: event.environment.timestamp,
      context,
      rule: {
        id: rule.id,
        name: rule.name,
      },
    };
    
    // 发送到各渠道
    for (const channel of rule.notification_channels) {
      switch (channel) {
        case 'slack':
          await this.sendToSlack(alert);
          break;
        case 'email':
          await this.sendEmail(alert);
          break;
        case 'webhook':
          await this.sendWebhook(alert);
          break;
      }
    }
    
    // 记录告警发送
    await auditLogger.log('ALERT_SENT', {
      userId: null,
      userType: 'SYSTEM',
    }, {
      targetType: 'AUDIT_ALERT',
      targetId: event.id,
      additionalData: alert,
    });
  }
  
  async sendToSlack(alert) {
    const webhookUrl = process.env.SLACK_AUDIT_WEBHOOK;
    const payload = {
      text: `🚨 审计告警：${alert.eventType}`,
      attachments: [{
        color: alert.severity === 'CRITICAL' ? 'danger' : 'warning',
        fields: [
          { title: '事件类型', value: alert.eventType, short: true },
          { title: '严重级别', value: alert.severity, short: true },
          { title: '操作者', value: alert.actor.userId || alert.actor.ip, short: true },
          { title: '时间', value: alert.timestamp, short: true },
          { title: '触发原因', value: alert.context.reason, short: false },
        ],
      }],
    };
    
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}

module.exports = AuditAlertWorker;
```

### 6. 审计查询 API

```javascript
// backend/services/admin-dashboard/routes/auditRoutes.js

const express = require('express');
const router = express.Router();
const AuditLog = require('../../../shared/models/AuditLog');
const { requireAdmin, requirePermission } = require('../../../shared/middleware/auth');

/**
 * 查询审计日志
 * GET /api/v1/admin/audit/logs
 */
router.get('/logs', requireAdmin, async (req, res) => {
  const {
    startDate,
    endDate,
    eventType,
    category,
    severity,
    userId,
    ip,
    targetType,
    targetId,
    page = 1,
    limit = 50,
  } = req.query;
  
  const query = {};
  
  if (startDate && endDate) {
    query.timestamp = { $gte: new Date(startDate), $lte: new Date(endDate) };
  }
  
  if (eventType) query.event_type = eventType;
  if (category) query.category = category;
  if (severity) query.severity = severity;
  if (userId) query.actor_user_id = userId;
  if (ip) query.actor_ip = ip;
  if (targetType) query.target_type = targetType;
  if (targetId) query.target_id = targetId;
  
  const logs = await AuditLog.findAll(query, {
    offset: (page - 1) * limit,
    limit: parseInt(limit),
    order: [['timestamp', 'DESC']],
  });
  
  const total = await AuditLog.count(query);
  
  res.json({
    success: true,
    data: logs,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

/**
 * 获取审计统计
 * GET /api/v1/admin/audit/statistics
 */
router.get('/statistics', requireAdmin, async (req, res) => {
  const { startDate, endDate, groupBy = 'day' } = req.query;
  
  const stats = await AuditLog.getStatistics({
    startDate,
    endDate,
    groupBy,
  });
  
  res.json({
    success: true,
    data: stats,
  });
});

/**
 * 验证日志完整性
 * POST /api/v1/admin/audit/verify-integrity
 */
router.post('/verify-integrity', requireAdmin, async (req, res) => {
  const { logIds } = req.body;
  
  const logs = await AuditLog.findAll({ id: logIds });
  const results = [];
  
  let previousHash = null;
  for (const log of logs) {
    const isValid = await log.verifyIntegrity(previousHash);
    results.push({
      id: log.id,
      eventType: log.event_type,
      timestamp: log.timestamp,
      isValid,
      hashMatch: log.current_hash === log.calculateExpectedHash(),
      signatureValid: log.verifySignature(),
    });
    previousHash = log.current_hash;
  }
  
  res.json({
    success: true,
    data: results,
    summary: {
      total: results.length,
      valid: results.filter(r => r.isValid).length,
      invalid: results.filter(r => !r.isValid).length,
    },
  });
});

/**
 * 生成合规报告
 * POST /api/v1/admin/audit/reports/generate
 */
router.post('/reports/generate', requirePermission('audit:report'), async (req, res) => {
  const { reportType, startDate, endDate } = req.body;
  
  const report = await AuditLog.generateComplianceReport(reportType, {
    startDate: new Date(startDate),
    endDate: new Date(endDate),
  });
  
  res.json({
    success: true,
    data: report,
  });
});

/**
 * 追溯用户操作链
 * GET /api/v1/admin/audit/trace/:userId
 */
router.get('/trace/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { includeRelated } = req.query;
  
  const trace = await AuditLog.traceUserOperations(userId, {
    includeRelated: includeRelated === 'true',
  });
  
  res.json({
    success: true,
    data: trace,
  });
});

module.exports = router;
```

### 7. GDPR 合规报告生成

```javascript
// backend/shared/audit/GDPRReportGenerator.js

const PDFDocument = require('pdfkit');
const AuditLog = require('../models/AuditLog');

class GDPRReportGenerator {
  async generateReport(userId, options = {}) {
    const { startDate, endDate } = options;
    
    // 获取用户所有审计记录
    const logs = await AuditLog.findAll({
      actor_user_id: userId,
      timestamp: {
        $gte: startDate ? new Date(startDate) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        $lte: endDate ? new Date(endDate) : new Date(),
      },
    }, {
      order: [['timestamp', 'ASC']],
    });
    
    // 分类统计
    const statistics = {
      totalEvents: logs.length,
      byCategory: {},
      bySeverity: {},
      dataAccesses: [],
      dataModifications: [],
      consentRecords: [],
    };
    
    logs.forEach(log => {
      // 按类别统计
      statistics.byCategory[log.category] = (statistics.byCategory[log.category] || 0) + 1;
      
      // 按严重级别统计
      statistics.bySeverity[log.severity] = (statistics.bySeverity[log.severity] || 0) + 1;
      
      // 数据访问记录
      if (log.category === 'DATA_ACCESS') {
        statistics.dataAccesses.push({
          type: log.target_type,
          timestamp: log.timestamp,
          ip: log.actor_ip,
        });
      }
      
      // 数据修改记录
      if (log.category === 'DATA_MODIFICATION') {
        statistics.dataModifications.push({
          action: log.action,
          target: log.target_type,
          before: log.before_state,
          after: log.after_state,
          timestamp: log.timestamp,
        });
      }
      
      // 授权记录
      if (log.event_type === 'CONSENT_GRANTED' || log.event_type === 'CONSENT_REVOKED') {
        statistics.consentRecords.push({
          type: log.event_type,
          details: log.additional_data,
          timestamp: log.timestamp,
        });
      }
    });
    
    // 生成 PDF 报告
    const pdfBuffer = await this.generatePDF(userId, statistics, logs);
    
    return {
      userId,
      generatedAt: new Date().toISOString(),
      period: { startDate, endDate },
      statistics,
      pdfBuffer,
    };
  }
  
  async generatePDF(userId, statistics, logs) {
    return new Promise((resolve) => {
      const doc = new PDFDocument();
      const chunks = [];
      
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      
      // 标题
      doc.fontSize(20).text('GDPR 数据处理活动报告', { align: 'center' });
      doc.moveDown();
      
      // 用户信息
      doc.fontSize(14).text(`用户 ID: ${userId}`);
      doc.text(`生成时间: ${new Date().toISOString()}`);
      doc.moveDown();
      
      // 统计摘要
      doc.fontSize(16).text('统计摘要', { underline: true });
      doc.fontSize(12).text(`总事件数: ${statistics.totalEvents}`);
      
      doc.text('\n按类别分布:');
      Object.entries(statistics.byCategory).forEach(([cat, count]) => {
        doc.text(`  - ${cat}: ${count}`);
      });
      
      doc.text('\n按严重级别分布:');
      Object.entries(statistics.bySeverity).forEach(([sev, count]) => {
        doc.text(`  - ${sev}: ${count}`);
      });
      
      // 数据访问记录
      if (statistics.dataAccesses.length > 0) {
        doc.moveDown();
        doc.fontSize(16).text('数据访问记录', { underline: true });
        statistics.dataAccesses.slice(0, 50).forEach(access => {
          doc.fontSize(10).text(
            `${access.timestamp} - ${access.type} (IP: ${access.ip})`
          );
        });
      }
      
      // 数据修改记录
      if (statistics.dataModifications.length > 0) {
        doc.moveDown();
        doc.fontSize(16).text('数据修改记录', { underline: true });
        statistics.dataModifications.slice(0, 50).forEach(mod => {
          doc.fontSize(10).text(
            `${mod.timestamp} - ${mod.action} on ${mod.target}`
          );
        });
      }
      
      // 授权记录
      if (statistics.consentRecords.length > 0) {
        doc.moveDown();
        doc.fontSize(16).text('授权记录', { underline: true });
        statistics.consentRecords.forEach(consent => {
          doc.fontSize(10).text(`${consent.timestamp} - ${consent.type}`);
        });
      }
      
      doc.end();
    });
  }
}

module.exports = new GDPRReportGenerator();
```

## 验收标准

- [ ] 审计日志中间件部署到所有微服务
- [ ] 所有敏感操作（登录、支付、交易、账号管理）有审计记录
- [ ] 审计日志存储在独立数据库表，支持分区归档
- [ ] 审计日志具有哈希链完整性保护，支持篡改检测
- [ ] 实时告警服务监控 HIGH/CRITICAL 级别事件
- [ ] 管理后台支持审计日志查询、统计、追溯
- [ ] 支持 GDPR 合规报告自动生成（PDF 格式）
- [ ] 审计日志保留策略：LOW 90天、MEDIUM 1年、HIGH 3年、CRITICAL 永久
- [ ] 审计日志查询响应时间 < 500ms（100 万条记录内）
- [ ] 日志写入不影响业务 API 性能（P99 延迟增加 < 10ms）

## 影响范围

### 新增文件
- `backend/shared/audit/AuditEventTypes.js` - 审计事件定义
- `backend/shared/audit/AuditLogger.js` - 审计日志核心类
- `backend/shared/audit/AuditMiddleware.js` - 中间件集成
- `backend/shared/audit/GDPRReportGenerator.js` - GDPR 报告生成
- `backend/jobs/auditAlertWorker.js` - 实时告警服务
- `database/migrations/20260623080000_create_audit_logs.sql` - 数据库迁移

### 修改文件
- `gateway/src/index.js` - 集成审计中间件
- `backend/services/admin-dashboard/routes/auditRoutes.js` - 审计查询 API
- `backend/shared/models/AuditLog.js` - 审计日志模型
- `infrastructure/k8s/monitoring/prometheus-rules.yml` - 添加审计相关告警

### 配置变更
- 新增环境变量：`AUDIT_SIGNING_KEY`（审计签名私钥）
- 新增 Slack Webhook：`SLACK_AUDIT_WEBHOOK`
- Kafka Topic：`audit-events`

## 参考

- [GDPR Article 30 - Records of processing activities](https://gdpr-info.eu/art-30-gdpr/)
- [PCI DSS Requirement 10 - Track and monitor all access](https://www.pcisecuritystandards.org/)
- [NIST SP 800-92 - Guide to Computer Security Log Management](https://csrc.nist.gov/publications/detail/sp/800-92/final)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
