# REQ-00439：熔断器事件告警系统集成

- **编号**：REQ-00439
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：backend/gateway/src/circuitBreakers.js、shared/alerting
- **创建时间**：2026-07-06 09:00
- **依赖需求**：无

## 1. 背景与问题

在代码审查中发现 `backend/gateway/src/circuitBreakers.js:70` 存在一个未实现的技术债：

```javascript
// TODO: Send alert to monitoring system
// alertManager.send({ service: name, event: 'circuit-open', data });
```

熔断器是系统稳定性的关键组件。当熔断器打开（OPEN）时，意味着某个微服务不可用，请求会被快速失败。这是严重的系统状态变化，需要立即通知运维团队。

**当前问题：**
- 熔断器事件仅记录日志，无主动告警
- 运维团队无法第一时间发现服务降级
- 错过黄金恢复时间窗口
- 缺少与现有告警系统的集成

**影响范围：**
- 熔断器打开（服务不可用）
- 熔断器半开（恢复测试中）
- 熔断器关闭（服务恢复）
- 三种状态变化都应触发告警通知

## 2. 目标

完成熔断器事件的告警系统完整集成，实现：

1. **主动告警**：熔断器状态变化时自动发送告警通知
2. **多渠道投递**：支持邮件、Slack、Webhook 等多种告警渠道
3. **告警分级**：根据事件严重程度选择不同告警级别
4. **告警聚合**：短时间内多个熔断器打开时合并告警，避免告警风暴
5. **可观测性增强**：在 Grafana 中展示告警历史和趋势

**预期收益：**
- MTTR（平均恢复时间）降低 30%+
- 运维团队响应时间缩短 50%+
- 避免因服务降级导致的用户投诉

## 3. 范围

**包含：**
- 创建 `shared/alerting` 模块
- 实现 AlertManager 类和告警策略
- 集成到熔断器事件监听器
- 添加告警配置（告警规则、接收者、静默规则）
- 单元测试和集成测试
- Grafana 告警仪表板配置
- 文档更新

**不包含：**
- 新的监控指标（已有 Prometheus 指标）
- 告警系统的持久化存储（使用现有日志系统）
- 复杂的告警路由规则（后续需求）

## 4. 详细需求

### 4.1 告警模块设计

创建 `backend/shared/alerting/index.js`：

```javascript
class AlertManager {
  constructor(config) {
    this.channels = [];  // 告警渠道列表
    this.rules = new Map();  // 告警规则
    this.silences = new Map();  // 静默规则
    this.aggregator = new AlertAggregator();  // 告警聚合器
  }

  async send(alert) {
    // 1. 检查静默规则
    // 2. 应用告警聚合
    // 3. 匹配告警规则
    // 4. 发送到各渠道
    // 5. 记录告警历史
  }

  addChannel(channel) { }
  setRule(name, rule) { }
  setSilence(pattern, duration) { }
}
```

### 4.2 告警渠道实现

支持以下告警渠道（按优先级）：

1. **日志告警**：写入日志文件，由日志聚合系统收集
2. **Webhook 告警**：POST 到配置的 URL（支持 OpsGenie、PagerDuty 等）
3. **Slack 告警**：通过 Slack Webhook 发送
4. **邮件告警**：SMTP 发送（备用渠道）

### 4.3 告警级别定义

| 级别 | 触发条件 | 通知方式 | 示例 |
|------|---------|---------|------|
| **Critical** | 熔断器打开 | 全渠道 + 立即通知 | payment-service 打开 |
| **Warning** | 熔断器半开 | 日志 + Webhook | catch-service 半开 |
| **Info** | 熔断器关闭 | 日志 | user-service 恢复 |

### 4.4 告警聚合策略

**场景**：短时间内多个服务熔断器打开

**策略**：
- 30 秒内同类型告警合并为一条
- 聚合告警包含所有受影响服务列表
- 聚合告警级别取最高级别

**实现**：
```javascript
class AlertAggregator {
  constructor(windowMs = 30000) {
    this.windowMs = windowMs;
    this.buffer = new Map();
  }

  add(alert) {
    // 相同级别的告警聚合
  }

  flush() {
    // 发送聚合后的告警
  }
}
```

### 4.5 熔断器集成

修改 `backend/gateway/src/circuitBreakers.js`：

```javascript
const alertManager = require('@pmg/shared/alerting');

cb.on('open', (name, data) => {
  // ... 现有日志和指标代码 ...
  
  // 发送告警（替代 TODO 注释）
  alertManager.send({
    level: 'critical',
    service: name,
    event: 'circuit-open',
    message: `熔断器打开: ${name} 服务不可用`,
    data: {
      failures: data.failures,
      threshold: serviceConfigs[name].failureThreshold,
      timestamp: new Date().toISOString()
    }
  });
});
```

### 4.6 配置管理

告警配置文件：`config/alerting.yml`

```yaml
channels:
  - type: webhook
    url: ${ALERT_WEBHOOK_URL}
    enabled: true
    
  - type: slack
    webhook_url: ${SLACK_WEBHOOK_URL}
    enabled: true
    
  - type: email
    recipients:
      - ops@example.com
    enabled: false

rules:
  circuit-breaker-open:
    level: critical
    channels: [webhook, slack]
    
  circuit-breaker-half-open:
    level: warning
    channels: [webhook]

silences:
  - pattern: 'social-service'
    duration: 300  # 非核心服务静默 5 分钟
```

### 4.7 API 接口

新增管理接口：

- `GET /api/admin/alerts/history` - 查询告警历史
- `GET /api/admin/alerts/silences` - 查询静默规则
- `POST /api/admin/alerts/silences` - 创建静默规则
- `DELETE /api/admin/alerts/silences/:id` - 删除静默规则

### 4.8 监控仪表板

在 Grafana 中添加告警面板：
- 告警历史图（时间序列）
- 按服务分组的告警计数
- 告警级别分布饼图
- 当前静默规则列表

## 5. 验收标准（可测试）

- [ ] AlertManager 类实现并通过单元测试
- [ ] 至少支持日志和 Webhook 两种告警渠道
- [ ] 熔断器打开事件触发 critical 级别告警
- [ ] 熔断器关闭事件触发 info 级别告警
- [ ] 告警聚合功能在 30 秒内合并同类型告警
- [ ] 配置文件支持环境变量注入（敏感信息）
- [ ] 管理接口支持查询告警历史
- [ ] Grafana 仪表板展示告警历史
- [ ] 集成测试覆盖端到端告警流程
- [ ] 文档更新（README、DEVELOPMENT.md）

## 6. 工作量估算

**L（Large）** - 约 8-12 小时

**理由：**
- 需要创建新的共享模块（2-3h）
- 集成熔断器和测试（3-4h）
- 配置管理和 API 接口（2h）
- Grafana 仪表板和文档（1-2h）

## 7. 优先级理由

**P1 理由：**

1. **技术债清理**：现有代码有明确的 TODO 标记，属于代码质量改进
2. **影响稳定性**：熔断器告警缺失直接影响 MTTR，是运维盲点
3. **基础设施**：告警是生产系统的基本能力，应该尽早完善
4. **代码健康**：清理技术债有助于团队代码质量文化

**不为 P0 的原因：**
- 当前系统已有日志和 Prometheus 指标
- 紧急情况下可以通过日志和监控发现问题
- 不属于阻塞性问题

**相关性：**
- 与 REQ-00039（缓存预热）、REQ-00071（自动扩缩容）等运维需求互补
- 属于可观测性体系的最后一环