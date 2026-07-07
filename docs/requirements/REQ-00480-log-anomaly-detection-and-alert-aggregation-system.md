# REQ-00480：日志异常检测与智能告警聚合系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00480 |
| 标题 | 日志异常检测与智能告警聚合系统 |
| 类别 | 可观测性/监控 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway/shared/logger、backend/shared/alerting、backend/jobs/analytics |
| 创建时间 | 2026-07-07 10:00 UTC |
| 依赖需求 | REQ-00060-log-aggregation-and-analysis-system（已完成）、REQ-00061-alert-notification-system（已完成） |

## 1. 背景与问题

mineGo 项目已建立完善的日志系统（Pino + OpenTelemetry）和告警系统，但缺乏智能化的日志异常检测和告警降噪能力：

### 1.1 当前痛点
1. **告警风暴**：系统故障时产生大量重复告警，淹没关键信息，导致运维疲劳
2. **异常发现滞后**：依赖人工查看日志，新类型异常无法及时发现
3. **告警缺乏上下文**：单个告警缺少关联信息，排查问题需要手动聚合
4. **日志噪音多**：大量 INFO 级别日志中隐藏着重要异常信息
5. **缺少趋势预警**：无法识别错误率上升趋势，直到用户投诉才发现问题

### 1.2 代码现状
```javascript
// backend/shared/logger.js - 当前日志系统
const logger = pino({ level: 'info' }); // 仅记录日志，无异常检测

// backend/shared/alerting.js - 当前告警系统
class Alerting {
  sendAlert(level, message) { // 直接发送，无聚合降噪
    this.slack.send(message);
  }
}

// 缺失：
// - 日志模式分析
// - 异常检测算法
// - 告警聚合与降噪
// - 智能分组与去重
```

## 2. 目标

建立智能化的日志异常检测与告警聚合系统：

1. **实时异常检测**：基于历史基线自动检测日志异常模式
2. **智能告警聚合**：相同根因的告警自动聚合，减少告警数量 70%+
3. **噪音过滤**：识别并抑制非关键告警，聚焦高优先级问题
4. **趋势预警**：提前识别错误率上升趋势，在用户影响前发出预警
5. **上下文丰富**：告警自动附带相关日志片段和统计数据

## 3. 范围

### 包含
- 日志流实时分析引擎
- 异常检测算法（基于统计和机器学习）
- 告警聚合与降噪系统
- 智能分组与去重逻辑
- 告警静默与抑制规则
- 趋势分析与预警
- 告警仪表板（Grafana 集成）

### 不包含
- 分布式追踪（REQ-00148 已实现）
- Metrics 监控（Prometheus 已集成）
- 日志收集（Loki 已部署）
- 基础告警通道（Slack/Email 已实现）

## 4. 详细需求

### 4.1 日志异常检测引擎

```javascript
// backend/shared/anomaly/LogAnomalyDetector.js

const { createLogger } = require('../logger');
const EventEmitter = require('events');

const logger = createLogger('log-anomaly-detector');

class LogAnomalyDetector extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // 历史基线窗口
      baselineWindow: config.baselineWindow || 3600000, // 1 小时
      // 异常阈值倍数（标准差）
      anomalyThreshold: config.anomalyThreshold || 3,
      // 检测间隔
      checkInterval: config.checkInterval || 60000, // 1 分钟
      // 最小样本数
      minSamples: config.minSamples || 10,
      // 支持的日志级别
      levels: ['error', 'warn', 'fatal']
    };
    
    // 统计窗口：按服务 + 日志级别 + 消息模式分组
    this.windows = new Map();
    // 异常模式库
    this.patterns = new Map();
  }
  
  /**
   * 处理日志条目
   */
  processLog(logEntry) {
    const { service, level, msg, timestamp } = logEntry;
    
    if (!this.config.levels.includes(level)) {
      return; // 仅处理错误级别日志
    }
    
    // 生成消息模式（泛化参数）
    const pattern = this.extractPattern(msg);
    const key = `${service}:${level}:${pattern}`;
    
    // 更新统计窗口
    this.updateWindow(key, timestamp);
    
    // 检测异常
    this.detectAnomaly(key, logEntry);
  }
  
  /**
   * 提取日志模式（泛化动态参数）
   */
  extractPattern(message) {
    if (!message || typeof message !== 'string') return 'unknown';
    
    return message
      // 泛化 UUID
      .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '{uuid}')
      // 泛化数字 ID
      .replace(/\b\d{4,}\b/g, '{id}')
      // 泛化 IP 地址
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '{ip}')
      // 泛化邮箱
      .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, '{email}')
      // 泛化 URL
      .replace(/https?:\/\/[^\s]+/gi, '{url}')
      // 泛化时间戳
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '{timestamp}')
      // 泛化 JSON
      .replace(/\{[^}]+\}/g, '{json}')
      // 截断长消息
      .substring(0, 200);
  }
  
  /**
   * 更新统计窗口
   */
  updateWindow(key, timestamp) {
    if (!this.windows.has(key)) {
      this.windows.set(key, {
        samples: [],
        lastUpdate: timestamp
      });
    }
    
    const window = this.windows.get(key);
    window.samples.push(timestamp);
    window.lastUpdate = timestamp;
    
    // 清理过期样本
    const cutoff = timestamp - this.config.baselineWindow;
    window.samples = window.samples.filter(ts => ts > cutoff);
  }
  
  /**
   * 检测异常
   */
  detectAnomaly(key, logEntry) {
    const window = this.windows.get(key);
    
    if (window.samples.length < this.config.minSamples) {
      return; // 样本数不足
    }
    
    // 计算当前频率（每分钟次数）
    const recentCount = window.samples.filter(
      ts => ts > Date.now() - 60000
    ).length;
    
    // 计算历史基线
    const baseline = this.calculateBaseline(window.samples);
    
    // 异常判断：超过阈值倍标准差
    const threshold = baseline.mean + this.config.anomalyThreshold * baseline.stddev;
    
    if (recentCount > threshold && recentCount > baseline.mean * 2) {
      const anomaly = {
        key,
        pattern: key.split(':')[2],
        service: logEntry.service,
        level: logEntry.level,
        currentRate: recentCount,
        baselineMean: baseline.mean.toFixed(2),
        baselineStddev: baseline.stddev.toFixed(2),
        threshold: threshold.toFixed(2),
        ratio: (recentCount / baseline.mean).toFixed(2),
        firstOccurrence: logEntry,
        detectedAt: new Date().toISOString()
      };
      
      // 发出异常事件
      this.emit('anomaly', anomaly);
      logger.warn({ anomaly }, 'Log anomaly detected');
    }
  }
  
  /**
   * 计算基线统计
   */
  calculateBaseline(samples) {
    // 按分钟桶统计
    const buckets = new Map();
    samples.forEach(ts => {
      const minute = Math.floor(ts / 60000) * 60000;
      buckets.set(minute, (buckets.get(minute) || 0) + 1);
    });
    
    const counts = Array.from(buckets.values());
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / counts.length;
    const stddev = Math.sqrt(variance);
    
    return { mean, stddev, samples: counts.length };
  }
  
  /**
   * 启动定时检测
   */
  startPeriodicCheck() {
    this.timer = setInterval(() => {
      const now = Date.now();
      
      // 检查所有窗口的趋势
      for (const [key, window] of this.windows.entries()) {
        // 检查是否有新的错误爆发
        const recentCount = window.samples.filter(
          ts => ts > now - 300000 // 最近 5 分钟
        ).length;
        
        const olderCount = window.samples.filter(
          ts => ts > now - 600000 && ts <= now - 300000 // 5-10 分钟前
        ).length;
        
        if (recentCount > olderCount * 2 && olderCount > 0) {
          this.emit('trend-alert', {
            key,
            trend: 'increasing',
            recentRate: recentCount,
            previousRate: olderCount,
            changeRatio: (recentCount / olderCount).toFixed(2)
          });
        }
      }
    }, this.config.checkInterval);
    
    logger.info('Periodic anomaly check started');
  }
  
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}

module.exports = LogAnomalyDetector;
```

### 4.2 告警聚合与降噪系统

```javascript
// backend/shared/alerting/AlertAggregator.js

const { createLogger } = require('../logger');
const crypto = require('crypto');

const logger = createLogger('alert-aggregator');

class AlertAggregator {
  constructor(config = {}) {
    this.config = {
      // 聚合时间窗口
      aggregationWindow: config.aggregationWindow || 300000, // 5 分钟
      // 最大聚合数量
      maxAggregated: config.maxAggregated || 100,
      // 相同根因判断阈值
      similarityThreshold: config.similarityThreshold || 0.8,
      // 静默时长
      silenceDuration: config.silenceDuration || 1800000, // 30 分钟
      // 支持的告警级别
      levels: ['critical', 'warning', 'info']
    };
    
    // 活跃告警窗口：fingerprint -> alerts
    this.activeAlerts = new Map();
    // 静默规则
    this.silenceRules = new Map();
    // 抑制规则
    this.inhibitRules = [];
  }
  
  /**
   * 处理告警
   */
  processAlert(alert) {
    // 生成告警指纹
    const fingerprint = this.generateFingerprint(alert);
    
    // 检查静默规则
    if (this.isSilenced(fingerprint)) {
      logger.debug({ fingerprint }, 'Alert silenced');
      return { status: 'silenced', fingerprint };
    }
    
    // 检查抑制规则
    if (this.isInhibited(alert)) {
      logger.debug({ alert }, 'Alert inhibited');
      return { status: 'inhibited', reason: 'inhibition_rule' };
    }
    
    // 尝试聚合到现有窗口
    const aggregated = this.aggregateAlert(fingerprint, alert);
    
    if (aggregated.isNew) {
      // 新告警，启动定时发送
      this.scheduleAggregatedAlert(fingerprint);
      return { status: 'new', fingerprint, alert };
    } else {
      // 已聚合
      return { 
        status: 'aggregated', 
        fingerprint, 
        count: aggregated.count 
      };
    }
  }
  
  /**
   * 生成告警指纹
   */
  generateFingerprint(alert) {
    // 使用关键字段生成唯一标识
    const key = [
      alert.service || 'unknown',
      alert.level || 'info',
      alert.type || 'generic',
      this.extractPattern(alert.message || '')
    ].join(':');
    
    return crypto.createHash('md5').update(key).digest('hex');
  }
  
  /**
   * 提取消息模式
   */
  extractPattern(message) {
    return message
      .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '{uuid}')
      .replace(/\b\d{4,}\b/g, '{id}')
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '{ip}')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '{timestamp}')
      .substring(0, 100);
  }
  
  /**
   * 聚合告警
   */
  aggregateAlert(fingerprint, alert) {
    if (!this.activeAlerts.has(fingerprint)) {
      // 新告警
      this.activeAlerts.set(fingerprint, {
        alerts: [alert],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        count: 1,
        status: 'pending'
      });
      
      return { isNew: true, count: 1 };
    }
    
    // 聚合到现有窗口
    const bucket = this.activeAlerts.get(fingerprint);
    bucket.alerts.push(alert);
    bucket.lastSeen = Date.now();
    bucket.count++;
    
    // 限制最大聚合数量
    if (bucket.alerts.length > this.config.maxAggregated) {
      bucket.alerts = bucket.alerts.slice(-this.config.maxAggregated);
    }
    
    return { isNew: false, count: bucket.count };
  }
  
  /**
   * 调度聚合告警发送
   */
  scheduleAggregatedAlert(fingerprint) {
    setTimeout(() => {
      this.sendAggregatedAlert(fingerprint);
    }, this.config.aggregationWindow);
  }
  
  /**
   * 发送聚合告警
   */
  async sendAggregatedAlert(fingerprint) {
    const bucket = this.activeAlerts.get(fingerprint);
    
    if (!bucket || bucket.status === 'sent') {
      return;
    }
    
    // 标记为已发送
    bucket.status = 'sent';
    
    // 构建聚合告警
    const aggregatedAlert = {
      fingerprint,
      service: bucket.alerts[0].service,
      level: this.calculateAggregatedLevel(bucket),
      type: bucket.alerts[0].type,
      message: this.generateAggregatedMessage(bucket),
      count: bucket.count,
      firstSeen: new Date(bucket.firstSeen).toISOString(),
      lastSeen: new Date(bucket.lastSeen).toISOString(),
      duration: bucket.lastSeen - bucket.firstSeen,
      samples: bucket.alerts.slice(0, 3), // 包含前 3 个样本
      metadata: {
        aggregated: true,
        pattern: this.extractPattern(bucket.alerts[0].message || '')
      }
    };
    
    // 发送到告警通道
    await this.deliverAlert(aggregatedAlert);
    
    // 设置静默期
    this.setSilence(fingerprint, this.config.silenceDuration);
    
    // 清理窗口
    setTimeout(() => {
      this.activeAlerts.delete(fingerprint);
    }, this.config.aggregationWindow * 2);
    
    logger.info({ 
      fingerprint, 
      count: bucket.count,
      level: aggregatedAlert.level 
    }, 'Aggregated alert sent');
  }
  
  /**
   * 计算聚合后的告警级别
   */
  calculateAggregatedLevel(bucket) {
    const levels = { critical: 0, warning: 1, info: 2 };
    let maxLevel = 'info';
    
    for (const alert of bucket.alerts) {
      if (levels[alert.level] < levels[maxLevel]) {
        maxLevel = alert.level;
      }
    }
    
    // 频繁告警提升级别
    if (bucket.count >= 50 && maxLevel === 'info') {
      return 'warning';
    }
    if (bucket.count >= 100 && maxLevel === 'warning') {
      return 'critical';
    }
    
    return maxLevel;
  }
  
  /**
   * 生成聚合消息
   */
  generateAggregatedMessage(bucket) {
    const firstAlert = bucket.alerts[0];
    const pattern = this.extractPattern(firstAlert.message || '');
    
    return `[聚合告警] ${firstAlert.service} - ${pattern} ` +
           `(发生 ${bucket.count} 次, 持续 ${Math.round(bucket.duration / 1000)} 秒)`;
  }
  
  /**
   * 发送告警
   */
  async deliverAlert(alert) {
    // 集成到现有告警系统
    const { Alerting } = require('../alerting');
    const alerting = new Alerting();
    
    await alerting.sendAlert(alert.level, alert.message, {
      ...alert,
      channel: '#ops-alerts'
    });
  }
  
  /**
   * 设置静默规则
   */
  setSilence(fingerprint, duration) {
    this.silenceRules.set(fingerprint, {
      until: Date.now() + duration,
      reason: 'auto_silence'
    });
    
    logger.info({ fingerprint, duration }, 'Silence rule set');
  }
  
  /**
   * 检查是否静默
   */
  isSilenced(fingerprint) {
    const rule = this.silenceRules.get(fingerprint);
    
    if (!rule) return false;
    
    if (Date.now() > rule.until) {
      this.silenceRules.delete(fingerprint);
      return false;
    }
    
    return true;
  }
  
  /**
   * 添加抑制规则
   */
  addInhibitRule(source, target, equals) {
    this.inhibitRules.push({
      source,
      target,
      equals,
      addedAt: Date.now()
    });
  }
  
  /**
   * 检查是否抑制
   */
  isInhibited(alert) {
    for (const rule of this.inhibitRules) {
      const sourceMatch = this.matchLabels(alert, rule.source);
      if (sourceMatch) {
        // 检查是否存在匹配 target 的活跃告警
        for (const [fp, bucket] of this.activeAlerts) {
          if (this.matchLabels(bucket.alerts[0], rule.target)) {
            return true;
          }
        }
      }
    }
    return false;
  }
  
  /**
   * 匹配标签
   */
  matchLabels(alert, labels) {
    return Object.entries(labels).every(
      ([key, value]) => alert[key] === value
    );
  }
  
  /**
   * 获取统计信息
   */
  getStats() {
    return {
      activeAlerts: this.activeAlerts.size,
      silencedRules: this.silenceRules.size,
      inhibitRules: this.inhibitRules.length,
      aggregated: Array.from(this.activeAlerts.entries())
        .map(([fp, bucket]) => ({
          fingerprint: fp.substring(0, 8),
          count: bucket.count,
          level: this.calculateAggregatedLevel(bucket),
          firstSeen: new Date(bucket.firstSeen).toISOString()
        }))
    };
  }
}

module.exports = AlertAggregator;
```

### 4.3 日志集成中间件

```javascript
// backend/shared/middleware/LogAnomalyMiddleware.js

const { createLogger } = require('../logger');
const LogAnomalyDetector = require('../anomaly/LogAnomalyDetector');
const AlertAggregator = require('../alerting/AlertAggregator');

const logger = createLogger('log-anomaly-middleware');

class LogAnomalyMiddleware {
  constructor() {
    this.detector = new LogAnomalyDetector();
    this.aggregator = new AlertAggregator();
    
    // 连接异常检测和告警聚合
    this.detector.on('anomaly', async (anomaly) => {
      await this.handleAnomaly(anomaly);
    });
    
    this.detector.on('trend-alert', async (trend) => {
      await this.handleTrendAlert(trend);
    });
    
    // 启动定时检测
    this.detector.startPeriodicCheck();
  }
  
  /**
   * 处理异常
   */
  async handleAnomaly(anomaly) {
    const alert = {
      service: anomaly.service,
      level: anomaly.level === 'fatal' ? 'critical' : 'warning',
      type: 'log_anomaly',
      message: `检测到异常日志模式：${anomaly.pattern}`,
      metadata: {
        currentRate: anomaly.currentRate,
        baseline: anomaly.baselineMean,
        ratio: anomaly.ratio,
        pattern: anomaly.pattern
      }
    };
    
    const result = this.aggregator.processAlert(alert);
    
    logger.info({ anomaly, result }, 'Log anomaly processed');
  }
  
  /**
   * 处理趋势预警
   */
  async handleTrendAlert(trend) {
    const alert = {
      service: trend.key.split(':')[0],
      level: 'warning',
      type: 'error_trend',
      message: `错误率上升趋势：${trend.changeRatio}x`,
      metadata: trend
    };
    
    await this.aggregator.processAlert(alert);
  }
  
  /**
   * 拦截日志
   */
  interceptLog(logEntry) {
    // 传递给异常检测器
    this.detector.processLog(logEntry);
  }
  
  /**
   * 获取状态
   */
  getStatus() {
    return {
      detector: {
        windows: this.detector.windows.size,
        patterns: this.detector.patterns.size
      },
      aggregator: this.aggregator.getStats()
    };
  }
}

// 单例实例
let instance;

function getLogAnomalyMiddleware() {
  if (!instance) {
    instance = new LogAnomalyMiddleware();
  }
  return instance;
}

module.exports = {
  LogAnomalyMiddleware,
  getLogAnomalyMiddleware
};
```

### 4.4 修改日志器集成

```javascript
// backend/shared/logger.js - 添加异常检测集成

const originalCreateLogger = require('./logger-original');
const { getLogAnomalyMiddleware } = require('./middleware/LogAnomalyMiddleware');

function createLogger(serviceName) {
  const logger = originalCreateLogger(serviceName);
  
  // 拦截错误级别日志
  const originalError = logger.error;
  const originalWarn = logger.warn;
  const originalFatal = logger.fatal;
  
  const middleware = getLogAnomalyMiddleware();
  
  logger.error = function(...args) {
    const logEntry = {
      service: serviceName,
      level: 'error',
      msg: args[0],
      timestamp: Date.now()
    };
    middleware.interceptLog(logEntry);
    return originalError.apply(this, args);
  };
  
  logger.warn = function(...args) {
    const logEntry = {
      service: serviceName,
      level: 'warn',
      msg: args[0],
      timestamp: Date.now()
    };
    middleware.interceptLog(logEntry);
    return originalWarn.apply(this, args);
  };
  
  logger.fatal = function(...args) {
    const logEntry = {
      service: serviceName,
      level: 'fatal',
      msg: args[0],
      timestamp: Date.now()
    };
    middleware.interceptLog(logEntry);
    return originalFatal.apply(this, args);
  };
  
  return logger;
}

module.exports = { createLogger };
```

### 4.5 API 端点

```javascript
// backend/gateway/src/routes/anomaly.js

const express = require('express');
const router = express.Router();
const { getLogAnomalyMiddleware } = require('../../shared/middleware/LogAnomalyMiddleware');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/**
 * 获取异常统计
 * GET /api/v1/anomaly/stats
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const middleware = getLogAnomalyMiddleware();
    const status = middleware.getStatus();
    
    res.json({
      timestamp: new Date().toISOString(),
      ...status
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get anomaly stats' });
  }
});

/**
 * 获取聚合告警列表
 * GET /api/v1/anomaly/alerts
 */
router.get('/alerts', requireAdmin, async (req, res) => {
  try {
    const middleware = getLogAnomalyMiddleware();
    const stats = middleware.aggregator.getStats();
    
    res.json({
      alerts: stats.aggregated,
      silenced: stats.silencedRules
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get alerts' });
  }
});

/**
 * 手动静默告警
 * POST /api/v1/anomaly/silence
 */
router.post('/silence', requireAdmin, async (req, res) => {
  try {
    const { fingerprint, duration } = req.body;
    const middleware = getLogAnomalyMiddleware();
    
    middleware.aggregator.setSilence(fingerprint, duration || 1800000);
    
    res.json({ 
      success: true,
      fingerprint,
      duration: duration || 1800000,
      until: new Date(Date.now() + (duration || 1800000)).toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to set silence rule' });
  }
});

module.exports = router;
```

### 4.6 Grafana Dashboard 配置

```json
{
  "dashboard": {
    "title": "mineGo - 日志异常与告警聚合",
    "panels": [
      {
        "title": "活跃告警数量",
        "type": "stat",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "minego_active_alerts_count",
            "legendFormat": "{{service}}"
          }
        ]
      },
      {
        "title": "告警聚合率",
        "type": "gauge",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "minego_alert_aggregation_ratio * 100",
            "legendFormat": "聚合率 %"
          }
        ]
      },
      {
        "title": "异常检测事件",
        "type": "graph",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "rate(minego_anomaly_detected_total[5m])",
            "legendFormat": "{{service}} - {{pattern}}"
          }
        ]
      },
      {
        "title": "告警静默规则",
        "type": "table",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "minego_silence_rules",
            "format": "table"
          }
        ]
      },
      {
        "title": "Top 错误模式",
        "type": "pie",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "topk(10, sum by (pattern) (minego_error_pattern_count))",
            "legendFormat": "{{pattern}}"
          }
        ]
      }
    ]
  }
}
```

## 5. 验收标准（可测试）

- [ ] **日志异常检测**：能自动检测到日志频率异常，检测延迟 < 1 分钟
- [ ] **模式提取**：能正确泛化动态参数，生成稳定的日志模式
- [ ] **告警聚合**：相同根因的告警自动聚合，聚合率 ≥ 70%
- [ ] **噪音过滤**：静默规则有效抑制重复告警
- [ ] **趋势预警**：能提前识别错误率上升趋势，提前量 ≥ 5 分钟
- [ ] **上下文丰富**：聚合告警包含样本日志和统计数据
- [ ] **API 端点**：提供状态查询、静默设置等管理接口
- [ ] **Grafana 集成**：Dashboard 正确展示异常和告警数据
- [ ] **性能影响**：日志处理延迟增加 < 10ms
- [ ] **单元测试**：核心模块测试覆盖率 ≥ 80%

## 6. 工作量估算

**M (Medium)**

理由：
- 需要实现 3 个核心模块（异常检测、告警聚合、集成中间件）
- 日志拦截和模式提取算法需要精细设计
- 与现有日志系统和告警系统集成
- Grafana Dashboard 配置
- 预估开发时间：5-7 人天

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **运维效率**：减少告警噪音 70%+，大幅提升运维效率
2. **问题发现**：自动化异常检测，缩短问题发现时间
3. **用户体验**：提前预警减少用户影响
4. **成本优化**：减少告警噪音可降低告警通道成本
5. **基础能力**：智能告警是成熟可观测性系统的标配

相比 P0（安全、稳定），此需求属于运维效率提升，但 P1 的成本收益比非常高。
