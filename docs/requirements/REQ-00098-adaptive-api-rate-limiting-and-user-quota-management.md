# REQ-00098：自适应 API 限流与用户配额管理系统

- **编号**：REQ-00098
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared、Redis、PostgreSQL
- **创建时间**：2026-06-11 00:00
- **依赖需求**：REQ-00002（结构化日志与 Prometheus 指标集成）、REQ-00010（反作弊系统）

## 1. 背景与问题

当前 mineGo 网关使用简单的全局限流策略（每分钟 200 次请求/全局），存在以下问题：

1. **缺乏用户级配额管理**：所有用户共享同一个限流阈值，无法区分普通用户和 VIP 用户，VIP 用户应享有更高的 API 配额
2. **缺乏自适应策略**：固定阈值无法根据系统负载动态调整，在高峰期可能导致系统过载，在低峰期浪费配额资源
3. **缺乏 API 分级保护**：核心 API（如支付、捕捉）应与普通 API（如查询精灵列表）采用不同的限流策略，避免非核心 API 挤占核心资源
4. **缺乏配额查询与管理能力**：用户无法查询剩余配额，管理员无法动态调整配额策略，缺乏配额使用统计和告警
5. **缺乏反作弊联动**：可疑用户应降低配额，正常用户可享受更高配额，限流策略未与反作弊系统（REQ-00010）联动

根据代码分析，当前限流配置位于：
- `backend/gateway/src/index.js`：全局固定限流（200 次/分钟）
- `backend/shared/plugins/builtins/RateLimitPlugin.js`：基础限流插件，支持 Redis 存储

## 2. 目标

构建完整的自适应 API 限流与用户配额管理系统，实现：

1. **用户级配额管理**：支持按用户等级（免费/VIP/SVIP）分配不同配额，配额可动态调整
2. **自适应限流策略**：根据系统负载（CPU、内存、响应时间）动态调整限流阈值，保护系统稳定性
3. **API 分级保护**：核心 API（支付、捕捉、道馆战斗）采用严格限流，普通 API 采用宽松限流
4. **配额查询与管理**：提供 API 供用户查询剩余配额，管理员可动态调整策略
5. **反作弊联动**：可疑用户自动降低配额，正常用户可享受配额加成
6. **监控与告警**：完整的 Prometheus 指标和告警规则

## 3. 范围

### 包含

- 用户配额模型设计与数据库迁移（用户等级、配额配置、使用记录）
- 自适应限流核心算法（基于系统负载动态调整阈值）
- API 分级限流策略（核心 API vs 普通 API）
- 配额查询 API（用户查询剩余配额）
- 配额管理 API（管理员调整策略）
- 反作弊联动机制（可疑用户降级）
- Redis 分布式限流（支持多实例）
- Prometheus 指标与告警规则
- 单元测试与集成测试

### 不包含

- 支付系统集成（已有 REQ-00003 支付幂等性）
- 具体的用户等级升级逻辑（属于 user-service 业务）
- 前端 UI 实现（由 game-client 团队负责）

## 4. 详细需求

### 4.1 数据库设计

#### 用户配额表 `user_quotas`
```sql
CREATE TABLE user_quotas (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  quota_level VARCHAR(20) NOT NULL DEFAULT 'free', -- free, vip, svip
  daily_limit INTEGER NOT NULL DEFAULT 1000,
  hourly_limit INTEGER NOT NULL DEFAULT 100,
  minute_limit INTEGER NOT NULL DEFAULT 20,
  used_today INTEGER NOT NULL DEFAULT 0,
  used_this_hour INTEGER NOT NULL DEFAULT 0,
  used_this_minute INTEGER NOT NULL DEFAULT 0,
  quota_multiplier DECIMAL(3,2) DEFAULT 1.00, -- 配额加成系数（0.5-2.0）
  last_reset_date DATE NOT NULL DEFAULT CURRENT_DATE,
  last_reset_hour INTEGER NOT NULL DEFAULT EXTRACT(HOUR FROM NOW()),
  last_reset_minute INTEGER NOT NULL DEFAULT EXTRACT(MINUTE FROM NOW()),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_user_quotas_user_id ON user_quotas(user_id);
CREATE INDEX idx_user_quotas_level ON user_quotas(quota_level);
```

#### API 分级配置表 `api_tier_configs`
```sql
CREATE TABLE api_tier_configs (
  id SERIAL PRIMARY KEY,
  api_pattern VARCHAR(255) NOT NULL, -- API 路径模式，如 /api/v2/catch/*
  tier VARCHAR(20) NOT NULL, -- critical, important, normal
  base_limit_per_minute INTEGER NOT NULL, -- 基础每分钟限制
  burst_limit INTEGER NOT NULL, -- 突发流量限制
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 种子数据
INSERT INTO api_tier_configs (api_pattern, tier, base_limit_per_minute, burst_limit) VALUES
  ('/api/v2/payment/*', 'critical', 10, 15),
  ('/api/v2/catch/*', 'critical', 30, 50),
  ('/api/v2/gym/battle/*', 'critical', 20, 30),
  ('/api/v2/pokemon/*', 'important', 60, 100),
  ('/api/v2/social/*', 'important', 60, 100),
  ('/api/v2/location/*', 'normal', 120, 200),
  ('/api/v2/user/*', 'normal', 120, 200);
```

### 4.2 自适应限流算法

```javascript
// backend/shared/AdaptiveRateLimiter.js

class AdaptiveRateLimiter {
  constructor(config) {
    this.config = config;
    this.baseLimit = config.baseLimit;
    this.currentLimit = config.baseLimit;
    this.systemLoadFactor = 1.0; // 系统负载因子（0.5-2.0）
    
    // 系统指标阈值
    this.thresholds = {
      cpu: { low: 0.5, medium: 0.7, high: 0.9 },
      memory: { low: 0.6, medium: 0.8, high: 0.9 },
      responseTime: { low: 200, medium: 500, high: 1000 } // ms
    };
  }

  // 根据系统负载动态调整限流阈值
  async adjustLimit(systemMetrics) {
    const { cpu, memory, avgResponseTime } = systemMetrics;
    
    // 计算负载分数（0-100）
    const cpuScore = this.calculateLoadScore(cpu, this.thresholds.cpu);
    const memoryScore = this.calculateLoadScore(memory, this.thresholds.memory);
    const responseScore = this.calculateLoadScore(avgResponseTime, this.thresholds.responseTime);
    
    const avgScore = (cpuScore + memoryScore + responseScore) / 3;
    
    // 根据负载分数调整因子
    if (avgScore >= 80) {
      this.systemLoadFactor = 0.5; // 高负载：降低 50% 限流
    } else if (avgScore >= 60) {
      this.systemLoadFactor = 0.7; // 中高负载：降低 30%
    } else if (avgScore >= 40) {
      this.systemLoadFactor = 1.0; // 正常负载：保持基础限流
    } else {
      this.systemLoadFactor = 1.5; // 低负载：提升 50% 限流
    }
    
    this.currentLimit = Math.floor(this.baseLimit * this.systemLoadFactor);
    
    return {
      baseLimit: this.baseLimit,
      currentLimit: this.currentLimit,
      loadFactor: this.systemLoadFactor,
      loadScore: avgScore
    };
  }
}
```

### 4.3 配额查询 API

**GET /api/v2/user/quota**
```json
// Response
{
  "userId": 12345,
  "quotaLevel": "vip",
  "limits": {
    "daily": 2000,
    "hourly": 200,
    "minute": 40
  },
  "used": {
    "today": 523,
    "thisHour": 67,
    "thisMinute": 8
  },
  "remaining": {
    "daily": 1477,
    "hourly": 133,
    "minute": 32
  },
  "resetIn": {
    "daily": "14h 23m",
    "hourly": "23m 15s",
    "minute": "45s"
  },
  "quotaMultiplier": 1.2
}
```

### 4.4 配额管理 API（管理员）

**POST /api/admin/quota/config**
```json
// Request
{
  "quotaLevel": "vip",
  "dailyLimit": 3000,
  "hourlyLimit": 300,
  "minuteLimit": 60
}

// Response
{
  "success": true,
  "message": "Quota config updated",
  "config": { ... }
}
```

**POST /api/admin/quota/user/:userId/adjust**
```json
// Request
{
  "quotaMultiplier": 0.5, // 降低可疑用户配额
  "reason": "异常行为检测",
  "duration": "7d" // 持续时间
}

// Response
{
  "success": true,
  "userId": 12345,
  "newMultiplier": 0.5,
  "expiresAt": "2026-06-18T00:00:00Z"
}
```

### 4.5 反作弊联动

```javascript
// 在反作弊系统检测到异常时，自动降低用户配额
async function handleAnomalyDetection(userId, anomalyScore) {
  if (anomalyScore > 80) {
    // 高风险：降低配额到 30%
    await quotaManager.adjustUserQuota(userId, {
      quotaMultiplier: 0.3,
      reason: '高风险异常行为',
      duration: '30d'
    });
  } else if (anomalyScore > 60) {
    // 中风险：降低配额到 50%
    await quotaManager.adjustUserQuota(userId, {
      quotaMultiplier: 0.5,
      reason: '中风险异常行为',
      duration: '14d'
    });
  }
}
```

### 4.6 Prometheus 指标

```
# 用户配额使用指标
quota_usage_total{user_id, quota_level, period="daily|hourly|minute"}
quota_remaining_total{user_id, quota_level, period="daily|hourly|minute"}
quota_limit_total{user_id, quota_level, period="daily|hourly|minute"}

# 限流触发指标
rate_limit_hits_total{api_pattern, tier, user_level}
rate_limit_blocked_total{api_pattern, tier, user_level}

# 自适应限流指标
adaptive_rate_limit_current{api_pattern}
adaptive_rate_limit_base{api_pattern}
adaptive_rate_limit_factor{api_pattern}
system_load_score{api_pattern}

# 配额调整指标
quota_adjustments_total{user_id, reason, action="increase|decrease"}
```

### 4.7 API 端点列表

1. **GET /api/v2/user/quota** - 查询用户剩余配额
2. **GET /api/v2/user/quota/history** - 查询配额使用历史
3. **POST /api/admin/quota/config** - 更新配额配置
4. **GET /api/admin/quota/config** - 查询配额配置
5. **POST /api/admin/quota/user/:userId/adjust** - 调整用户配额
6. **GET /api/admin/quota/stats** - 查询配额使用统计
7. **POST /api/admin/rate-limit/adjust** - 手动调整自适应限流参数
8. **GET /api/admin/rate-limit/status** - 查询当前限流状态

## 5. 验收标准（可测试）

- [ ] 用户配额表和 API 分级配置表已创建并通过迁移脚本部署
- [ ] 自适应限流算法能够根据 CPU/内存/响应时间动态调整限流阈值，调整范围在 0.5-1.5 倍之间
- [ ] API 分级限流生效：核心 API（支付/捕捉/战斗）限流严格，普通 API 限流宽松
- [ ] 用户可通过 `/api/v2/user/quota` 查询剩余配额，响应时间 < 50ms
- [ ] 管理员可通过 API 动态调整配额配置，调整后立即生效
- [ ] 反作弊系统检测到异常行为时，自动降低用户配额（配额系数降至 0.3-0.5）
- [ ] 所有限流相关操作记录到审计日志
- [ ] Prometheus 指标正确暴露，Grafana 仪表板可展示配额使用趋势
- [ ] 单元测试覆盖率 ≥ 85%，集成测试覆盖核心场景
- [ ] Redis 分布式限流支持多实例部署，配额数据一致性保证
- [ ] 系统高负载（CPU > 90%）时，限流阈值自动降低至 50%，保护系统稳定

## 6. 工作量估算

**L (Large)** - 预计 5-7 个工作日

理由：
- 数据库设计相对简单（0.5 天）
- 自适应限流算法核心实现（1 天）
- 用户配额管理模块（1 天）
- API 分级限流策略（1 天）
- 反作弊联动集成（0.5 天）
- 配额查询与管理 API（1 天）
- Prometheus 指标与告警（0.5 天）
- 单元测试与集成测试（1 天）
- 文档与审核（0.5 天）

## 7. 优先级理由

**P1（高优先级）** 理由：

1. **系统稳定性保障**：当前固定限流策略在高并发场景下可能导致系统过载，自适应限流是生产环境必备能力
2. **用户体验优化**：用户级配额管理可提升 VIP 用户满意度，同时防止滥用
3. **核心 API 保护**：支付、捕捉等核心 API 需要严格的限流保护，避免被非核心请求挤占资源
4. **反作弊能力增强**：限流与反作弊系统联动，可快速响应可疑行为，降低作弊风险
5. **可观测性提升**：完整的配额监控和告警能力，有助于运维团队及时发现和处理异常
6. **依赖关系**：不依赖其他未完成需求，可立即启动开发

该需求对"项目可用"的贡献：
- 提升系统稳定性（避免过载）
- 提升安全合规能力（反作弊联动）
- 提升用户体验（VIP 配额管理）
- 提升可观测性（完整监控指标）
