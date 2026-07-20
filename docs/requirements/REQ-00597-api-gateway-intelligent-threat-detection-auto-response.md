# REQ-00597：API 网关智能威胁检测与自动响应系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00597 |
| 标题 | API 网关智能威胁检测与自动响应系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway, user-service, backend/shared/threatDetection, Redis, Kafka |
| 创建时间 | 2026-07-19 05:48 |
| 依赖需求 | REQ-00548 (API 请求签名验证)，REQ-00291 (密钥管理系统) |

## 1. 背景与问题

当前 mineGo 网关已有基础的安全防护（IP 黑名单、请求签名验证、熔断限流），但这些防护主要依赖静态规则和人工配置。面对以下安全挑战，现有系统存在明显不足：

1. **新型攻击模式识别滞后**：规则更新依赖人工分析，无法快速响应新型攻击手法（如慢速攻击、分布式低频攻击）
2. **误报率较高**：基于单一阈值的异常检测容易将正常流量误判为恶意请求，影响用户体验
3. **响应被动且延迟**：安全事件需要人工介入分析，缺乏自动化的实时威胁响应能力
4. **缺少攻击溯源能力**：难以关联分析跨服务、跨时间的攻击行为，无法形成完整的安全态势视图

## 2. 目标

构建一个基于机器学习的智能威胁检测与自动响应系统，实现：

- **智能威胁识别**：基于行为分析的异常检测，准确识别 DDoS、暴力破解、数据爬取等攻击模式
- **自适应响应**：根据威胁等级自动采取不同强度的防护措施（验证码、限流、临时封禁）
- **误报自学习**：基于反馈机制持续优化检测模型，降低误报率至 < 1%
- **实时态势感知**：提供安全威胁仪表板，展示攻击趋势、来源分布、影响范围

## 3. 范围

### 包含
- 威胁检测引擎（基于 Isolation Forest + 规则引擎）
- 实时特征提取管道（请求频率、路径熵值、行为序列）
- 自动响应执行器（验证码触发、动态限流、IP 封禁）
- 反馈学习机制（标注接口 + 模型热更新）
- 安全态势仪表板（Grafana 集成）
- Prometheus 指标暴露

### 不包含
- Web Application Firewall (WAF) 规则管理（已有 Nginx WAF）
- 容器运行时安全监控（未来需求）
- 渗透测试自动化框架（已有 REQ-00576）

## 4. 详细需求

### 4.1 威胁检测引擎

#### 4.1.1 特征提取
提取以下实时特征（时间窗口：60秒滑动窗口）：

```javascript
// 特征定义
const features = {
  // 基础统计
  requestRate: 'number',        // 请求数/秒
  uniquePaths: 'number',        // 唯一路径数
  uniqueUserAgents: 'number',   // 唯一 UA 数
  
  // 行为特征
  pathEntropy: 'number',        // 路径熵值 (0-1)
  httpMethodVariance: 'number', // HTTP 方法方差
  errorRate: 'number',          // 错误响应比例
  
  // 时间序列特征
  requestInterval: {            // 请求间隔统计
    mean: 'number',
    std: 'number',
    skewness: 'number'
  },
  
  // 会话特征
  sessionAge: 'number',         // 会话年龄（秒）
  authAttempts: 'number',       // 认证尝试次数
  sensitiveApiHits: 'number'    // 敏感 API 调用次数
};
```

#### 4.1.2 检测模型
- 主模型：Isolation Forest（sklearn 或 onnx runtime）
- 辅助模型：规则引擎（JSON 配置）
- 推理延迟：< 10ms / 请求

#### 4.1.3 威胁等级分类

| 分数范围 | 等级 | 说明 | 颜色 |
|---------|------|------|------|
| 0-30 | normal | 正常流量 | green |
| 31-50 | suspicious | 可疑行为，需观察 | yellow |
| 51-70 | threat | 威胁，需要响应 | orange |
| 71-100 | critical | 严重威胁，立即阻断 | red |

### 4.2 自动响应执行器

#### 4.2.1 响应策略

```javascript
const responseActions = {
  suspicious: [
    'log_enhanced',              // 增强日志记录
    'rate_limit_dynamic',        // 动态限流（系数 1.5x）
    'challenge_captcha_soft'     // 软验证码（低频触发）
  ],
  
  threat: [
    'challenge_captcha_hard',    // 强制验证码
    'rate_limit_aggressive',     // 激进限流（系数 3x）
    'session_flag',              // 标记会话
    'alert_notify'               // 告警通知
  ],
  
  critical: [
    'ip_temp_ban',               // IP 临时封禁（15分钟）
    'session_revoke',            // 撤销会话
    'alert_escalate',            // 升级告警
    'block_request'              // 拒绝请求
  ]
};
```

#### 4.2.2 响应执行接口

```http
POST /api/v1/threat/response
Content-Type: application/json

{
  "threatId": "threat-uuid",
  "sourceIp": "192.168.1.100",
  "sessionId": "session-uuid",
  "action": "ip_temp_ban",
  "duration": 900,
  "reason": "Anomalous request pattern detected",
  "threatScore": 82,
  "metadata": {
    "featureSnapshot": { ... }
  }
}
```

### 4.3 反馈学习机制

#### 4.3.1 标注接口

```http
POST /api/v1/threat/feedback
Content-Type: application/json

{
  "threatId": "threat-uuid",
  "label": "false_positive" | "true_positive" | "unknown",
  "comment": "Optional analyst comment",
  "reviewerId": "admin-user-id"
}
```

#### 4.3.2 模型热更新
- 每日自动训练（使用最近7天数据 + 反馈标注）
- A/B 测试新模型（10% 流量）
- 模型版本管理（Git LFS）
- 回滚机制（性能下降自动回滚）

### 4.4 Prometheus 指标

```promql
# 威胁检测指标
minego_threat_detected_total{level="suspicious|threat|critical"} 10
minego_threat_response_actions_total{action="ip_temp_ban|challenge_captcha"} 5
minego_threat_false_positive_rate 0.008

# 模型性能指标
minego_threat_model_inference_latency_ms{p50,p95,p99} 5
minego_threat_model_accuracy 0.95
```

### 4.5 数据库表结构

```sql
-- 威胁事件表
CREATE TABLE threat_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_id VARCHAR(64) UNIQUE NOT NULL,
  source_ip INET NOT NULL,
  user_id UUID,
  session_id VARCHAR(128),
  threat_score INT NOT NULL,
  threat_level VARCHAR(20) NOT NULL,
  features JSONB NOT NULL,
  actions_taken JSONB DEFAULT '[]',
  feedback_label VARCHAR(20),
  feedback_comment TEXT,
  feedback_by UUID,
  feedback_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

CREATE INDEX idx_threat_events_source_ip ON threat_events(source_ip);
CREATE INDEX idx_threat_events_created_at ON threat_events(created_at);
CREATE INDEX idx_threat_events_threat_level ON threat_events(threat_level);

-- IP 封禁记录表
CREATE TABLE ip_bans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address INET UNIQUE NOT NULL,
  reason TEXT NOT NULL,
  threat_id UUID REFERENCES threat_events(id),
  banned_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  banned_by VARCHAR(50) DEFAULT 'auto',
  unbanned_at TIMESTAMP,
  unbanned_by VARCHAR(50)
);

CREATE INDEX idx_ip_bans_ip ON ip_bans(ip_address);
CREATE INDEX idx_ip_bans_expires ON ip_bans(expires_at);
```

## 5. 验收标准

- [ ] 系统能在 10ms 内完成威胁评分计算
- [ ] 检测准确率 ≥ 95%，误报率 ≤ 1%
- [ ] 支持至少 5 种自动响应动作
- [ ] Grafana 仪表板能实时展示威胁态势（刷新间隔 ≤ 10s）
- [ ] 反馈标注后模型能在 24h 内完成热更新
- [ ] 支持威胁事件查询 API（按 IP、时间、等级过滤）
- [ ] 所有响应动作有审计日志

## 6. 工作量估算

**L（大型）**

- 威胁检测引擎开发：3 天
- 特征提取管道：2 天
- 响应执行器：2 天
- 反馈学习机制：2 天
- 数据库迁移与 API：1 天
- 测试与文档：2 天

总计：约 10-12 人日

## 7. 优先级理由

P1 理由：

1. **安全基础建设**：当前已有静态防护，缺少智能化层，这是安全体系的关键补齐
2. **误报影响用户**：现有规则的误报可能导致正常用户被限流，智能检测可显著降低此风险
3. **响应时效性**：自动化响应可将威胁处置时间从小时级缩短到秒级
4. **合规要求**：等保 2.0 要求具备入侵防范和恶意代码防范能力，本需求直接支撑合规

对"项目可用"的贡献：保障生产环境稳定运行，防范恶意攻击导致的服务不可用或数据泄露。