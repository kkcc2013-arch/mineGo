# REQ-00328: API 密钥泄露检测与实时告警系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00328 |
| 标题 | API 密钥泄露检测与实时告警系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、user-service、admin-dashboard、backend/shared、infrastructure/k8s |
| 创建时间 | 2026-06-27 01:00 UTC |

## 需求描述

### 背景

API 密钥泄露是导致云服务账户被盗用、数据泄露的主要原因之一。在开发过程中，开发者可能无意中将 API 密钥、数据库凭证、OAuth token 等敏感信息提交到代码仓库、日志文件或 API 响应中。需要建立一套自动化的密钥泄露检测与告警系统，在泄露发生时立即响应。

### 目标

1. **实时检测**：监控 API 请求、响应、日志中的敏感信息泄露
2. **模式匹配**：支持多种密钥格式的自动识别（AWS、GCP、GitHub、JWT、数据库连接串等）
3. **分级告警**：根据泄露严重程度触发不同级别的告警和响应措施
4. **自动响应**：高危泄露时自动触发密钥轮换或服务熔断
5. **审计追踪**：记录所有泄露事件的完整上下文，便于后续分析

### 支持的密钥类型

| 类型 | 正则模式示例 | 风险等级 |
|------|-------------|----------|
| AWS Access Key | `AKIA[0-9A-Z]{16}` | Critical |
| AWS Secret Key | `[A-Za-z0-9/+=]{40}` | Critical |
| GitHub Token | `ghp_[a-zA-Z0-9]{36}` | High |
| GitHub OAuth | `gho_[a-zA-Z0-9]{36}` | High |
| JWT Token | `eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*` | High |
| Database URL | `postgres://[^:]+:[^@]+@[^/]+` | High |
| Stripe Key | `sk_live_[a-zA-Z0-9]{24}` | Critical |
| SendGrid Key | `SG\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*` | High |
| Firebase Key | `AIza[a-zA-Z0-9_-]{35}` | Medium |
| Private Key | `-----BEGIN (RSA|PRIVATE) KEY-----` | Critical |
| Generic Secret | `[Ss]ecret[Kk]ey['\"]?\s*[:=]\s*['\"][a-zA-Z0-9_-]{16,}` | Medium |

## 技术方案

### 1. 密钥泄露检测中间件

```javascript
// backend/shared/middleware/leakageDetector.js

const LEAKAGE_PATTERNS = {
  AWS_ACCESS_KEY: {
    pattern: /AKIA[0-9A-Z]{16}/g,
    type: 'aws_access_key',
    severity: 'critical',
    description: 'AWS Access Key ID detected'
  },
  AWS_SECRET_KEY: {
    pattern: /[A-Za-z0-9/+=]{40}/g,
    type: 'aws_secret_key',
    severity: 'critical',
    description: 'AWS Secret Key (potential) detected',
    context: /AKIA|aws|secret/i // 需要上下文确认
  },
  GITHUB_TOKEN: {
    pattern: /ghp_[a-zA-Z0-9]{36}/g,
    type: 'github_token',
    severity: 'high',
    description: 'GitHub Personal Access Token detected'
  },
  GITHUB_OAUTH: {
    pattern: /gho_[a-zA-Z0-9]{36}/g,
    type: 'github_oauth',
    severity: 'high',
    description: 'GitHub OAuth Token detected'
  },
  JWT_TOKEN: {
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    type: 'jwt_token',
    severity: 'high',
    description: 'JWT Token detected'
  },
  DATABASE_URL: {
    pattern: /(postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^\s"']+/gi,
    type: 'database_url',
    severity: 'critical',
    description: 'Database connection string with credentials detected'
  },
  STRIPE_KEY: {
    pattern: /sk_live_[a-zA-Z0-9]{24}/g,
    type: 'stripe_key',
    severity: 'critical',
    description: 'Stripe Live Secret Key detected'
  },
  SENDGRID_KEY: {
    pattern: /SG\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
    type: 'sendgrid_key',
    severity: 'high',
    description: 'SendGrid API Key detected'
  },
  FIREBASE_KEY: {
    pattern: /AIza[a-zA-Z0-9_-]{35}/g,
    type: 'firebase_key',
    severity: 'medium',
    description: 'Firebase API Key detected'
  },
  PRIVATE_KEY: {
    pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
    type: 'private_key',
    severity: 'critical',
    description: 'Private Key detected'
  },
  GENERIC_SECRET: {
    pattern: /['\"]?(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)['\"]?\s*[:=]\s*['\"][a-zA-Z0-9_-]{16,}['\"]?/gi,
    type: 'generic_secret',
    severity: 'medium',
    description: 'Generic secret/credential detected'
  }
};

const SEVERITY_LEVELS = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

class LeakageDetector {
  constructor(options = {}) {
    this.patterns = options.patterns || LEAKAGE_PATTERNS;
    this.excludePaths = options.excludePaths || [
      '/health',
      '/metrics',
      '/ready'
    ];
    this.sanitizeResponse = options.sanitizeResponse !== false;
    this.alertThreshold = options.alertThreshold || 'medium';
    this.maxBodySize = options.maxBodySize || 1024 * 1024; // 1MB
  }

  /**
   * 检测文本中的敏感信息泄露
   */
  detect(text, context = {}) {
    const findings = [];
    
    for (const [name, config] of Object.entries(this.patterns)) {
      const matches = text.matchAll(config.pattern);
      
      for (const match of matches) {
        // 检查上下文条件
        if (config.context) {
          const contextWindow = text.slice(
            Math.max(0, match.index - 100),
            Math.min(text.length, match.index + match[0].length + 100)
          );
          if (!config.context.test(contextWindow)) {
            continue;
          }
        }
        
        findings.push({
          type: config.type,
          severity: config.severity,
          description: config.description,
          match: this.maskSensitive(match[0]),
          position: {
            start: match.index,
            end: match.index + match[0].length
          },
          context: {
            requestId: context.requestId,
            path: context.path,
            method: context.method,
            userId: context.userId,
            timestamp: new Date().toISOString()
          }
        });
      }
    }
    
    return findings;
  }

  /**
   * 脱敏敏感信息
   */
  maskSensitive(value) {
    if (value.length <= 8) {
      return '*'.repeat(value.length);
    }
    return value.slice(0, 4) + '*'.repeat(value.length - 8) + value.slice(-4);
  }

  /**
   * Express 中间件
   */
  middleware() {
    return async (req, res, next) => {
      // 跳过排除路径
      if (this.excludePaths.some(path => req.path.startsWith(path))) {
        return next();
      }

      const context = {
        requestId: req.id,
        path: req.path,
        method: req.method,
        userId: req.user?.id
      };

      // 检测请求体
      if (req.body && typeof req.body === 'object') {
        const bodyStr = JSON.stringify(req.body);
        const requestFindings = this.detect(bodyStr, { ...context, source: 'request_body' });
        
        if (requestFindings.length > 0) {
          await this.handleFindings(requestFindings, req);
        }
      }

      // 拦截响应
      const originalSend = res.send.bind(res);
      const originalJson = res.json.bind(res);
      
      res.send = (body) => {
        this.checkResponse(body, context, req);
        return originalSend(body);
      };
      
      res.json = (body) => {
        this.checkResponse(JSON.stringify(body), context, req);
        return originalJson(body);
      };

      next();
    };
  }

  /**
   * 检查响应体
   */
  async checkResponse(body, context, req) {
    if (!body || typeof body !== 'string') return;
    
    if (body.length > this.maxBodySize) {
      // 对于大响应，采样检测
      body = body.slice(0, this.maxBodySize);
    }

    const findings = this.detect(body, { ...context, source: 'response_body' });
    
    if (findings.length > 0) {
      await this.handleFindings(findings, req);
    }
  }

  /**
   * 处理发现的泄露
   */
  async handleFindings(findings, req) {
    const criticalFindings = findings.filter(f => f.severity === 'critical');
    const highFindings = findings.filter(f => f.severity === 'high');
    
    // 记录审计日志
    for (const finding of findings) {
      await this.logLeakageEvent(finding, req);
    }

    // 触发告警
    if (criticalFindings.length > 0) {
      await this.triggerAlert({
        level: 'critical',
        findings: criticalFindings,
        requestId: req.id,
        userId: req.user?.id,
        path: req.path,
        timestamp: new Date().toISOString()
      });

      // 高危泄露：考虑自动响应
      await this.triggerAutoResponse(criticalFindings, req);
    } else if (highFindings.length > 0) {
      await this.triggerAlert({
        level: 'high',
        findings: highFindings,
        requestId: req.id,
        userId: req.user?.id,
        path: req.path,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 记录泄露事件到审计日志
   */
  async logLeakageEvent(finding, req) {
    const event = {
      type: 'SENSITIVE_DATA_LEAKAGE',
      detectionType: finding.type,
      severity: finding.severity,
      description: finding.description,
      maskedValue: finding.match,
      requestId: req.id,
      userId: req.user?.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      path: req.path,
      method: req.method,
      timestamp: new Date().toISOString()
    };

    // 发送到审计日志系统
    await auditLogger.log(event);
    
    // 发送到 Kafka 事件流
    await eventBus.publish('security.leakage.detected', event);
  }

  /**
   * 触发告警
   */
  async triggerAlert(alertData) {
    // 发送到告警系统
    await alertManager.sendAlert({
      name: 'API_KEY_LEAKAGE_DETECTED',
      ...alertData,
      channels: ['slack', 'email', 'pagerduty']
    });

    // Prometheus 指标
    leakageDetectionCounter.inc({
      severity: alertData.level,
      type: alertData.findings[0]?.type || 'unknown'
    });
  }

  /**
   * 触发自动响应
   */
  async triggerAutoResponse(findings, req) {
    const autoResponseConfig = await configStore.get('security.autoResponse');
    
    if (!autoResponseConfig?.enabled) return;

    for (const finding of findings) {
      switch (finding.type) {
        case 'aws_access_key':
        case 'aws_secret_key':
          // 触发 AWS 密钥轮换
          await keyRotationService.rotateKey({
            type: 'aws',
            reason: 'leakage_detected',
            requestId: req.id
          });
          break;

        case 'jwt_token':
          // 加入 JWT 黑名单
          await jwtBlacklist.add(finding.match);
          break;

        case 'stripe_key':
          // 通知支付团队
          await notificationService.notifyTeam('payment', {
            type: 'stripe_key_leakage',
            finding,
            requestId: req.id
          });
          break;

        case 'database_url':
          // 触发数据库密码轮换
          await keyRotationService.rotateKey({
            type: 'database',
            reason: 'leakage_detected',
            requestId: req.id
          });
          break;
      }
    }
  }
}

// Prometheus 指标
const leakageDetectionCounter = new Prometheus.Counter({
  name: 'leakage_detection_total',
  help: 'Total number of sensitive data leakage detections',
  labelNames: ['severity', 'type']
});

module.exports = { LeakageDetector, LEAKAGE_PATTERNS };
```

### 2. 告警管理器集成

```javascript
// backend/shared/alertManager.js (扩展现有告警系统)

class LeakageAlertHandler {
  constructor() {
    this.alertCooldown = new Map(); // 防止告警风暴
    this.cooldownMs = 5 * 60 * 1000; // 5分钟冷却
  }

  async handleLeakageAlert(alert) {
    const cooldownKey = `${alert.findings[0].type}:${alert.userId || 'anonymous'}`;
    
    // 检查冷却期
    if (this.alertCooldown.has(cooldownKey)) {
      const lastAlert = this.alertCooldown.get(cooldownKey);
      if (Date.now() - lastAlert < this.cooldownMs) {
        logger.info('Leakage alert in cooldown', { cooldownKey });
        return;
      }
    }

    // 发送 Slack 告警
    await this.sendSlackAlert(alert);
    
    // 发送邮件告警
    if (alert.level === 'critical') {
      await this.sendEmailAlert(alert);
    }

    // 发送 PagerDuty 告警
    if (alert.level === 'critical') {
      await this.sendPagerDutyAlert(alert);
    }

    // 更新冷却时间
    this.alertCooldown.set(cooldownKey, Date.now());
  }

  async sendSlackAlert(alert) {
    const severityEmoji = {
      critical: '🚨',
      high: '⚠️',
      medium: '⚡',
      low: '📝'
    };

    const message = {
      text: `${severityEmoji[alert.level]} 敏感数据泄露检测`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `${severityEmoji[alert.level]} API 密钥泄露告警`
          }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*严重级别:*\n${alert.level.toUpperCase()}` },
            { type: 'mrkdwn', text: `*检测类型:*\n${alert.findings.map(f => f.type).join(', ')}` },
            { type: 'mrkdwn', text: `*请求路径:*\n${alert.path}` },
            { type: 'mrkdwn', text: `*用户ID:*\n${alert.userId || 'Anonymous'}` },
            { type: 'mrkdwn', text: `*时间:*\n${alert.timestamp}` }
          ]
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '查看详情' },
              url: `${process.env.ADMIN_DASHBOARD_URL}/security/leakage/${alert.requestId}`
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '轮换密钥' },
              value: JSON.stringify({ requestId: alert.requestId, types: alert.findings.map(f => f.type) }),
              action_id: 'rotate_key'
            }
          ]
        }
      ]
    };

    await slackWebhook.send(message);
  }
}

module.exports = { LeakageAlertHandler };
```

### 3. Admin Dashboard 监控页面

```javascript
// admin-dashboard/src/pages/Security/LeakageMonitor.jsx

import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Modal, Descriptions, Timeline } from 'antd';

const LeakageMonitor = () => {
  const [leakages, setLeakages] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchLeakageData();
    const ws = new WebSocket(`${WS_URL}/security/leakage/stream`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setLeakages(prev => [data, ...prev].slice(0, 100));
    };
    return () => ws.close();
  }, []);

  const severityColors = {
    critical: 'red',
    high: 'orange',
    medium: 'gold',
    low: 'blue'
  };

  const columns = [
    {
      title: '检测时间',
      dataIndex: 'timestamp',
      key: 'timestamp',
      render: (text) => new Date(text).toLocaleString()
    },
    {
      title: '严重级别',
      dataIndex: 'severity',
      key: 'severity',
      render: (severity) => (
        <Tag color={severityColors[severity]}>{severity.toUpperCase()}</Tag>
      ),
      filters: [
        { text: 'Critical', value: 'critical' },
        { text: 'High', value: 'high' },
        { text: 'Medium', value: 'medium' },
        { text: 'Low', value: 'low' }
      ],
      onFilter: (value, record) => record.severity === value
    },
    {
      title: '密钥类型',
      dataIndex: 'detectionType',
      key: 'detectionType',
      render: (type) => type.replace(/_/g, ' ').toUpperCase()
    },
    {
      title: '请求路径',
      dataIndex: 'path',
      key: 'path',
      ellipsis: true
    },
    {
      title: '用户ID',
      dataIndex: 'userId',
      key: 'userId'
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Button type="link" onClick={() => showDetail(record)}>详情</Button>
      )
    }
  ];

  return (
    <div className="leakage-monitor">
      <Card title="泄露检测统计">
        <Row gutter={16}>
          <Col span={6}>
            <Statistic title="今日检测总数" value={stats.todayTotal || 0} />
          </Col>
          <Col span={6}>
            <Statistic 
              title="Critical 级别" 
              value={stats.criticalCount || 0} 
              valueStyle={{ color: '#cf1322' }}
            />
          </Col>
          <Col span={6}>
            <Statistic 
              title="High 级别" 
              value={stats.highCount || 0}
              valueStyle={{ color: '#fa8c16' }}
            />
          </Col>
          <Col span={6}>
            <Statistic title="已处理" value={stats.resolvedCount || 0} />
          </Col>
        </Row>
      </Card>

      <Card title="泄露事件列表" style={{ marginTop: 16 }}>
        <Table
          columns={columns}
          dataSource={leakages}
          loading={loading}
          rowKey="id"
          pagination={{ pageSize: 20 }}
        />
      </Card>
    </div>
  );
};

export default LeakageMonitor;
```

### 4. 数据库表结构

```sql
-- 数据库迁移文件
-- database/migrations/20260627010000_create_leakage_events.sql

CREATE TABLE leakage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id VARCHAR(64) NOT NULL,
  detection_type VARCHAR(64) NOT NULL,
  severity VARCHAR(16) NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  description TEXT,
  masked_value VARCHAR(128),
  user_id UUID REFERENCES users(id),
  ip_address INET,
  user_agent TEXT,
  request_path VARCHAR(512),
  request_method VARCHAR(8),
  request_body_sanitized TEXT, -- 脱敏后的请求体
  response_status INTEGER,
  source VARCHAR(32) CHECK (source IN ('request_body', 'response_body', 'log', 'header')),
  handled BOOLEAN DEFAULT FALSE,
  handled_by UUID REFERENCES users(id),
  handled_at TIMESTAMP,
  auto_response_triggered BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  
  -- 索引
  INDEX idx_leakage_events_created_at (created_at),
  INDEX idx_leakage_events_severity (severity),
  INDEX idx_leakage_events_type (detection_type),
  INDEX idx_leakage_events_user_id (user_id),
  INDEX idx_leakage_events_request_id (request_id)
);

-- 分区表（按月分区）
CREATE TABLE leakage_events_archive (LIKE leakage_events);

-- 自动归档策略（保留90天）
CREATE OR REPLACE FUNCTION archive_old_leakage_events()
RETURNS void AS $$
BEGIN
  INSERT INTO leakage_events_archive
  SELECT * FROM leakage_events
  WHERE created_at < NOW() - INTERVAL '90 days';
  
  DELETE FROM leakage_events
  WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;
```

### 5. Kubernetes 部署配置

```yaml
# infrastructure/k8s/base/leakage-detector.yaml

apiVersion: apps/v1
kind: Deployment
metadata:
  name: leakage-detector
  namespace: security
spec:
  replicas: 2
  selector:
    matchLabels:
      app: leakage-detector
  template:
    metadata:
      labels:
        app: leakage-detector
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      containers:
        - name: detector
          image: minego/leakage-detector:latest
          ports:
            - containerPort: 9090
              name: metrics
          env:
            - name: ALERT_SLACK_WEBHOOK
              valueFrom:
                secretKeyRef:
                  name: leakage-detector-secrets
                  key: slack-webhook
            - name: ALERT_EMAIL_RECIPIENTS
              value: "security@minego.com"
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /health
              port: 9090
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /ready
              port: 9090
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: leakage-detector
  namespace: security
spec:
  selector:
    app: leakage-detector
  ports:
    - port: 9090
      targetPort: 9090
      name: metrics
```

### 6. Prometheus 告警规则

```yaml
# infrastructure/k8s/monitoring/prometheus-rules-leakage.yaml

groups:
  - name: leakage_detection.rules
    interval: 30s
    rules:
      - alert: HighLeakageRate
        expr: rate(leakage_detection_total[5m]) > 0.1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "检测到高频敏感数据泄露"
          description: "过去5分钟内检测到 {{ $value | printf \"%.2f\" }} 次/秒的泄露事件"

      - alert: CriticalLeakageDetected
        expr: increase(leakage_detection_total{severity="critical"}[1m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "检测到 Critical 级别密钥泄露"
          description: "泄露类型: {{ $labels.type }}，请立即处理"

      - alert: AWSKeyLeakageDetected
        expr: increase(leakage_detection_total{type=~"aws.*"}[1m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "检测到 AWS 密钥泄露"
          description: "可能需要立即轮换 AWS 凭证"

      - alert: DatabaseCredentialLeakage
        expr: increase(leakage_detection_total{type="database_url"}[1m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "检测到数据库凭证泄露"
          description: "数据库连接串在响应中泄露，需要立即处理"
```

## 验收标准

- [ ] 密钥泄露检测中间件集成到 gateway 和所有微服务
- [ ] 支持至少 10 种常见密钥类型的模式识别
- [ ] Critical 级别泄露触发自动告警（Slack + Email + PagerDuty）
- [ ] 高危泄露自动触发密钥轮换或加入黑名单
- [ ] Admin Dashboard 泄露监控页面可查看实时和历史事件
- [ ] 审计日志记录完整上下文（请求ID、用户ID、路径、时间戳）
- [ ] Prometheus 指标暴露，支持 Grafana 可视化
- [ ] 告警规则配置完成，支持分级告警
- [ ] 数据库表结构创建完成，支持分区归档
- [ ] 单元测试覆盖率 > 85%
- [ ] 集成测试覆盖端到端泄露检测流程
- [ ] 文档更新：安全最佳实践、告警响应手册

## 影响范围

- **新增文件**：
  - `backend/shared/middleware/leakageDetector.js`
  - `backend/shared/alertManager.js`（扩展）
  - `admin-dashboard/src/pages/Security/LeakageMonitor.jsx`
  - `database/migrations/20260627010000_create_leakage_events.sql`
  - `infrastructure/k8s/base/leakage-detector.yaml`
  - `infrastructure/k8s/monitoring/prometheus-rules-leakage.yaml`

- **修改文件**：
  - `backend/gateway/src/server.js`（集成中间件）
  - 各微服务入口文件（集成中间件）
  - `backend/shared/eventBus.js`（新增事件类型）

## 参考

- [AWS Security Best Practices](https://docs.aws.amazon.com/general/latest/gr/aws-security-best-practices.html)
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [GitHub Token Scanning](https://docs.github.com/en/code-security/secret-scanning)
- [GitLab Secret Detection](https://docs.gitlab.com/ee/user/application_security/secret_detection/)
- [TruffleHog - Secrets Scanning Tool](https://github.com/trufflesecurity/trufflehog)
