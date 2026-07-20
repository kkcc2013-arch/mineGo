# REQ-00609：RPO/RTO 实时监控与预警告警系统

- **编号**：REQ-00609
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/disasterRecovery, gateway, monitoring, alerting
- **创建时间**：2026-07-20 14:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目灾备系统已有 RPO/RTO 监控机制（`DisasterRecoveryEngine`），但存在以下问题：

1. **缺乏实时告警**：`checkRPO()` 和 `checkRTO()` 方法仅记录日志，未实现告警通知
2. **无预警机制**：只在 RPO/RTO 突破阈值后被动发现，无法提前预警
3. **告警渠道单一**：缺乏多渠道告警（企业微信、钉钉、邮件、短信）
4. **无告警升级策略**：缺乏根据严重程度自动升级告警的机制
5. **告警静默缺失**：维护窗口期或已知故障期间无法静默告警

代码证据：
```javascript
// backend/shared/disasterRecovery/DisasterRecoveryEngine.js
async checkRPO() {
  const pgRpo = await this.pgManager.getRPO();
  const redisRpo = await this.redisGeo.getRPO();
  // 仅记录日志，未发送告警
  logger.info({ pgRpo, redisRpo }, 'RPO 检查');
}

async checkRTO() {
  // 同样缺少告警机制
}
```

## 2. 目标

建立完善的 RPO/RTO 实时监控与预警系统，实现：
1. **实时监控**：每 30 秒检查 RPO/RTO 状态，实时更新监控指标
2. **提前预警**：RPO/RTO 达到阈值 80% 时触发预警，预留处理时间
3. **多渠道告警**：支持企业微信、钉钉、邮件、短信等多种通知渠道
4. **智能升级**：根据告警持续时间和严重程度自动升级
5. **告警静默**：支持维护窗口和已知故障的告警静默

预期收益：
- RPO/RTO 违规事件提前发现率 ≥ 90%
- 告警通知延迟 < 10 秒
- 减少误告警 ≥ 50%（通过预警和静默）
- 运维响应时间缩短 60%

## 3. 范围

### 包含
1. RPO/RTO 实时监控指标收集与暴露
2. 预警报警机制（阈值 80%、90%、100% 三级预警）
3. 多渠道告警通知系统（企业微信、钉钉、邮件、短信）
4. 告警升级策略配置与执行
5. 告警静默规则管理
6. Grafana RPO/RTO 监控仪表盘

### 不包含
- 灾备切换流程优化（已有需求覆盖）
- 数据库复制性能优化
- 跨区域网络优化
- 灾备演练自动化

## 4. 详细需求

### 4.1 RPO/RTO 实时监控指标

**核心模块**：`backend/shared/disasterRecovery/RpoRtoMetricsCollector.js`

功能要求：
- 收集 PostgreSQL 主从复制延迟（字节、时间）
- 收集 Redis 主从同步偏移量
- 计算 RPO（数据丢失量）和 RTO（恢复时间预估）
- 暴露 Prometheus 指标
- 记录历史数据供趋势分析

指标定义：
```javascript
// Prometheus 指标
const rpoRtoMetrics = {
  // RPO 指标（毫秒）
  rpo_current_ms: new Gauge({
    name: 'minego_disaster_recovery_rpo_current_ms',
    help: 'Current RPO in milliseconds',
    labelNames: ['component', 'region']
  }),
  
  // RPO 占目标百分比
  rpo_percentage: new Gauge({
    name: 'minego_disaster_recovery_rpo_percentage',
    help: 'RPO as percentage of target',
    labelNames: ['component', 'region']
  }),
  
  // RTO 指标（毫秒）
  rto_current_ms: new Gauge({
    name: 'minego_disaster_recovery_rto_current_ms',
    help: 'Current RTO in milliseconds',
    labelNames: ['component', 'region']
  }),
  
  // RTO 占目标百分比
  rto_percentage: new Gauge({
    name: 'minego_disaster_recovery_rto_percentage',
    help: 'RTO as percentage of target',
    labelNames: ['component', 'region']
  }),
  
  // 告警事件计数
  alerts_total: new Counter({
    name: 'minego_disaster_recovery_alerts_total',
    help: 'Total RPO/RTO alerts',
    labelNames: ['level', 'component', 'region']
  })
};
```

### 4.2 预警报警机制

**核心模块**：`backend/shared/disasterRecovery/RpoRtoAlertEngine.js`

预警级别定义：
| 级别 | RPO/RTO 百分比 | 状态 | 处理建议 |
|------|----------------|------|----------|
| Info | < 80% | 正常 | 无需处理 |
| Warning | 80% ~ 89% | 预警 | 关注并排查 |
| Critical | 90% ~ 99% | 严重 | 立即处理 |
| Emergency | ≥ 100% | 突破阈值 | 紧急响应 |

功能要求：
- 实时计算 RPO/RTO 百分比
- 根据阈值触发对应级别告警
- 去重机制：同一告警 5 分钟内不重复发送
- 聚合机制：同组件同级别的告警聚合发送

### 4.3 多渠道告警通知

**核心模块**：`backend/shared/alerting/RpoRtoNotifier.js`

支持的告警渠道：
1. **企业微信**：Webhook 机器人，Markdown 格式
2. **钉钉**：Webhook 机器人，支持 @指定人员
3. **邮件**：SMTP 发送，HTML 格式
4. **短信**：短信网关集成，紧急告警专用

告警消息格式：
```javascript
const alertMessage = {
  title: `【${level}】RPO/RTO 告警`,
  content: {
    component: 'PostgreSQL', // 或 'Redis'
    region: 'beijing → shanghai',
    currentRpo: '45s',
    rpoTarget: '60s',
    rpoPercentage: '75%',
    currentRto: '3m',
    rtoTarget: '5m',
    rtoPercentage: '60%',
    timestamp: '2026-07-20 14:00:00 UTC',
    trend: '↑ 上升', // 或 ↓ 下降 → 稳定
    impact: '可能影响数据安全',
    suggestion: '建议检查网络状况和复制延迟'
  }
};
```

### 4.4 告警升级策略

**核心模块**：`backend/shared/alerting/AlertEscalationPolicy.js`

升级规则：
```javascript
const escalationPolicy = {
  // Warning 级别
  warning: {
    duration: '15m',  // 持续 15 分钟
    action: 'notify_next_level'  // 升级到上一级领导
  },
  // Critical 级别
  critical: {
    duration: '5m',
    action: 'notify_all',  // 通知所有相关人员
    channels: ['wechat', 'dingtalk', 'sms']  // 启用所有渠道
  },
  // Emergency 级别
  emergency: {
    duration: '2m',
    action: 'auto_call',  // 自动拨打电话
    channels: ['wechat', 'dingtalk', 'email', 'sms', 'phone']
  }
};
```

### 4.5 告警静默规则

**核心模块**：`backend/shared/alerting/SilenceRuleManager.js`

静默规则配置：
```javascript
const silenceRule = {
  id: 'silence-001',
  name: '数据库维护窗口',
  matchers: [
    { key: 'component', value: 'PostgreSQL', isRegex: false },
    { key: 'region', value: 'beijing', isRegex: false }
  ],
  startTime: '2026-07-20T02:00:00Z',
  endTime: '2026-07-20T06:00:00Z',
  createdBy: 'admin@example.com',
  comment: '例行维护窗口',
  status: 'active'
};
```

### 4.6 数据库设计

**迁移文件**：`backend/migrations/20260720_140000_rpo_rto_monitoring_system.js`

表结构：
```sql
-- RPO/RTO 历史记录表
CREATE TABLE rpo_rto_history (
  id SERIAL PRIMARY KEY,
  component VARCHAR(50) NOT NULL,  -- PostgreSQL, Redis
  region VARCHAR(50) NOT NULL,
  rpo_ms BIGINT NOT NULL,
  rto_ms BIGINT NOT NULL,
  rpo_target_ms BIGINT NOT NULL,
  rto_target_ms BIGINT NOT NULL,
  rpo_percentage NUMERIC(5,2) NOT NULL,
  rto_percentage NUMERIC(5,2) NOT NULL,
  recorded_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_rpo_rto_history_time ON rpo_rto_history(recorded_at DESC);
CREATE INDEX idx_rpo_rto_history_component ON rpo_rto_history(component, region);

-- 告警事件表
CREATE TABLE rpo_rto_alerts (
  id SERIAL PRIMARY KEY,
  alert_id VARCHAR(100) UNIQUE NOT NULL,
  level VARCHAR(20) NOT NULL,  -- warning, critical, emergency
  component VARCHAR(50) NOT NULL,
  region VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  channels VARCHAR(100)[],  -- 发送的渠道列表
  status VARCHAR(20) DEFAULT 'firing',  -- firing, resolved
  fired_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  escalation_level INT DEFAULT 1
);
CREATE INDEX idx_rpo_rto_alerts_status ON rpo_rto_alerts(status, level);

-- 告警静默规则表
CREATE TABLE alert_silence_rules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  matchers JSONB NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  created_by VARCHAR(200) NOT NULL,
  comment TEXT,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_silence_rules_time ON alert_silence_rules(start_time, end_time);
CREATE INDEX idx_silence_rules_status ON alert_silence_rules(status);
```

### 4.7 Grafana 仪表盘

**文件**：`monitoring/grafana/dashboards/rpo-rto-monitoring.json`

面板设计：
1. **RPO 实时曲线**：PostgreSQL 和 Redis 的 RPO 趋势
2. **RTO 实时曲线**：预估恢复时间趋势
3. **RPO/RTO 百分比**：占目标阈值的百分比
4. **告警历史**：近期告警事件列表
5. **组件健康度**：各组件复制状态
6. **区域同步状态**：主从同步延迟对比

### 4.8 API 接口

**路由文件**：`backend/gateway/src/routes/admin/disasterRecovery.js`

```javascript
// GET /api/admin/disaster-recovery/rpo-rto/status
// 获取当前 RPO/RTO 状态

// GET /api/admin/disaster-recovery/rpo-rto/history
// 查询历史记录（支持时间范围查询）

// GET /api/admin/disaster-recovery/alerts
// 查询告警列表

// POST /api/admin/disaster-recovery/silence-rules
// 创建静默规则

// DELETE /api/admin/disaster-recovery/silence-rules/:id
// 删除静默规则
```

## 5. 验收标准（可测试）

- [ ] RPO/RTO 实时监控指标正确暴露到 Prometheus
- [ ] RPO 达到 80%、90%、100% 时分别触发 Warning、Critical、Emergency 告警
- [ ] RTO 达到 80%、90%、100% 时分别触发 Warning、Critical、Emergency 告警
- [ ] 告警通知通过企业微信/钉钉/邮件/短信成功发送
- [ ] 同一告警 5 分钟内不重复发送（去重机制生效）
- [ ] 告警升级策略按配置时间触发
- [ ] 静默规则生效期间不发送告警
- [ ] Grafana 仪表盘正确展示 RPO/RTO 趋势
- [ ] API 接口返回正确的数据
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 集成测试覆盖完整告警流程

## 6. 工作量估算

**M（Medium）**

理由：
- 核心模块清晰：指标收集、告警引擎、通知系统
- 可复用现有灾备监控基础设施
- 主要工作量在告警通知集成和仪表盘配置

预计工作量：3-4 个工作日

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **业务连续性保障**：RPO/RTO 是灾备的核心指标，直接关系到数据安全和业务连续性
2. **合规要求**：金融级应用要求严格监控 RPO/RTO
3. **降低故障影响**：提前预警可以预留处理时间，减少故障影响
4. **运维效率**：自动化告警减轻运维负担，提高响应速度

不设为 P0 的原因：
- 现有灾备系统基本功能已完善
- 不阻塞核心业务功能
- 可在后续迭代中完成
