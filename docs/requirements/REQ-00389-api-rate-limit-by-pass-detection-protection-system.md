# REQ-00389：API 请求速率限制绕过检测与防护系统

- **编号**：REQ-00389
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、backend/shared/RateLimitBypassDetector.js、backend/shared/RateLimitEnforcer.js、Redis、PostgreSQL、admin-dashboard
- **创建时间**：2026-06-30 16:00 UTC
- **依赖需求**：REQ-00098（自适应 API 限流系统已完成）、REQ-00367（动态配额系统已完成）

## 1. 背景与问题

当前项目已实现自适应 API 限流（REQ-00098）和动态配额分配系统（REQ-00367），但这些系统存在绕过风险：

1. **分布式请求绕过**：攻击者可通过多 IP、多设备、多账号分散请求，绕过单用户限流
2. **时间窗口操纵**：通过控制请求节奏，恰好卡在限流窗口边界发送请求
3. **低优先级接口滥用**：利用健康检查、静态资源等不受限接口发起大量请求
4. **限流配置探测**：通过逐步增加请求频率探测限流阈值并规避

## 2. 目标

构建智能的限流绕过检测与防护系统：
- 识别分布式/协同式绕过行为
- 动态调整限流策略响应绕过尝试
- 实现跨用户/跨 IP 的协同限流
- 提供绕过行为可视化与告警

## 3. 范围

- **包含**：
  - 请求模式异常检测（分布式、突发、边界试探）
  - 跨维度协同限流（用户+IP+设备+时间窗口）
  - 绕过行为智能响应（动态收紧、临时封禁）
  - 实时绕过告警与仪表板
  
- **不包含**：
  - 业务层面的作弊检测（已有 REQ-00010 GPS 伪造检测）
  - 攻击溯源与取证（属于安全审计系统）

## 4. 详细需求

### 4.1 RateLimitBypassDetector（绕过检测引擎）

```javascript
class RateLimitBypassDetector {
  // 检测维度
  detectionDimensions = {
    distributed: '分布式请求绕过检测',
    burst: '突发请求模式检测',
    boundaryProbing: '限流边界试探检测',
    lowPriorityAbuse: '低优先级接口滥用检测'
  };
  
  // 分布式绕过检测：识别来自不同源但行为一致的请求群组
  detectDistributedBypass(timeWindow = 60000) {
    // 分析同一时间窗口内，多个不同用户/IP/设备的请求模式
    // 检测是否存在协同行为（如相同请求路径、相近时间间隔）
  }
  
  // 边界试探检测：识别恰好卡在限流阈值边界的请求模式
  detectBoundaryProbing() {
    // 分析请求频率与限流阈值的差值分布
    // 识别"试探性"请求（如逐步增加频率直到被限）
  }
}
```

### 4.2 RateLimitEnforcer（协同限流执行器）

```javascript
class RateLimitEnforcer {
  // 跨维度协同限流
  enforceCoordinatedRateLimit(detectionResult) {
    // 根据检测结果，动态调整限流策略：
    // - 收紧检测到的用户群组限流阈值
    // - 对协同行为涉及的 IP 范围实施临时限流
    // - 添加设备指纹级别的限流规则
  }
  
  // 动态限流策略调整
  adjustRateLimitPolicy(target, adjustment) {
    // 支持策略调整：
    // - thresholdReduction: 降低阈值百分比
    // - windowExtension: 扩大检测窗口
    // - temporaryBlock: 临时封禁时长
  }
}
```

### 4.3 Redis 数据结构

```
# 绕过检测状态
bypass:detection:{timestamp}:{dimension} = {
  suspiciousTargets: [{userId, ip, deviceId, fingerprint}],
  patternSignature: "signature_hash",
  confidenceScore: 0.85
}

# 协同限流规则
ratelimit:coordinated:{groupSignature} = {
  members: ["userId1", "ip1", "deviceId1"],
  adjustedThreshold: 50,
  originalThreshold: 100,
  expiresAt: timestamp
}

# 绕过行为历史
bypass:history:{targetType}:{targetId} = [
  {dimension, detectedAt, actionTaken, expiresAt}
]
```

### 4.4 API 接口

| 路径 | 方法 | 功能 |
|------|------|------|
| `/admin/security/rate-limit-bypass/stats` | GET | 获取绕过检测统计 |
| `/admin/security/rate-limit-bypass/detections` | GET | 获取近期检测结果列表 |
| `/admin/security/rate-limit-bypass/rules` | GET/POST | 管理协同限流规则 |
| `/admin/security/rate-limit-bypass/whitelist` | GET/POST/DELETE | 管理白名单 |

### 4.5 Prometheus 指标

```
rate_limit_bypass_detections_total{dimension="distributed|burst|boundary|low_priority"}
rate_limit_bypass_actions_total{action="throttle|block|extend_window"}
rate_limit_coordinated_rules_active
rate_limit_bypass_confidence_score_avg
```

## 5. 验收标准（可测试）

- [ ] 分布式绕过检测能识别 ≥5 个协同源的请求群组，准确率 ≥85%
- [ ] 边界试探检测能在 3 个试探周期内识别并响应
- [ ] 协同限流能同时限制涉及的用户、IP、设备，限制生效时间 ≤5 秒
- [ ] 绕过检测误报率 ≤5%（正常高频用户不应被误判）
- [ ] 临时封禁支持自动过期与手动解除
- [ ] 提供 Grafana 仪表板展示绕过检测趋势与响应效果

## 6. 工作量估算

**L** - 涉及复杂的行为分析算法、跨维度数据关联、实时响应机制，预计需要：
- RateLimitBypassDetector：~500 行核心逻辑
- RateLimitEnforcer：~400 行执行逻辑
- Redis 数据结构设计 + 指标集成：~200 行
- 测试覆盖：~300 行
- 文档与仪表板配置：~2 小时

## 7. 优先级理由

P1 级别 - 现有限流系统存在明显的绕过风险，攻击者可通过分散请求轻易规避限制。此需求是安全加固的关键环节，直接影响系统的抗攻击能力和公平性保障。与 REQ-00098/REQ-00367 形成完整的安全限流体系。
