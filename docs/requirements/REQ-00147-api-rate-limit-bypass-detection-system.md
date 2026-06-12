# REQ-00147：API 请求速率限制绕过检测与防护系统

- **编号**：REQ-00147
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、backend/shared/rateLimitMonitor.js、Redis、PostgreSQL
- **创建时间**：2026-06-12 07:15
- **依赖需求**：REQ-00002（结构化日志与 Prometheus 指标）、REQ-00098（自适应 API 限流）

## 1. 背景与问题

当前 mineGo 已实现自适应 API 限流系统（REQ-00098），但**限流绕过攻击仍存在风险**：

### 现实痛点
1. **IP 轮换绕过**：攻击者通过代理池、VPN 切换等方式绕过 IP 限流
2. **账号分摊请求**：使用多个账号分摊请求量，绕过用户级限流
3. **时间窗口边界攻击**：在限流窗口边界集中发送请求，利用窗口重置间隙
4. **限流状态篡改**：尝试修改 Redis 中的限流计数器
5. **分布式协调绕过**：多节点部署时，各节点限流状态不一致

### 数据现状
- 日均 API 请求：约 5000 万次
- 触发限流请求：约 50 万次（1%）
- 疑似绕过行为：约 5000 次/天（估算）

### 风险影响
- 恶意请求消耗服务器资源
- 影响正常用户体验
- 可能导致服务过载

## 2. 目标

建立 API 请求速率限制绕过检测与防护系统，**阻止 95%+ 的限流绕过行为**，同时保持正常用户无感知。

### 核心收益
1. **限流有效性保障**：确保限流机制不被绕过
2. **攻击行为识别**：自动识别并记录绕过尝试
3. **动态防护**：根据绕过模式自动调整防护策略
4. **运维可视化**：提供限流绕过监控仪表板

## 3. 范围

### 包含
- IP 轮换检测（短时间内多 IP 同账号）
- 账号分摊检测（同 IP 多账号协同请求）
- 时间窗口边界攻击检测
- 限流状态完整性验证
- 分布式限流状态同步监控
- 绕过行为自动封禁机制
- 监控告警与可视化

### 不包含
- 正常限流逻辑（已在 REQ-00098 实现）
- GPS 反作弊（已在 REQ-00010 实现）
- 设备检测（已在 REQ-00045 实现）

## 4. 详细需求

### 4.1 IP 轮换检测系统

```javascript
class IPRotationDetector {
  // 检测短时间内同一账号使用多个 IP
  async detectIPRotation(userId, currentIP) {
    const recentIPs = await this.getRecentIPs(userId, 3600); // 最近1小时
    const uniqueIPCount = new Set(recentIPs).size;
    
    // 风险评分
    let riskScore = 0;
    if (uniqueIPCount > 10) riskScore = 100; // 超过10个IP
    else if (uniqueIPCount > 5) riskScore = 70;
    else if (uniqueIPCount > 3) riskScore = 40;
    
    // 检查 IP 地理位置
    const geoSpread = await this.calculateGeoSpread(recentIPs);
    if (geoSpread > 1000) riskScore += 20; // 跨國 IP
    
    return {
      isRotation: uniqueIPCount > 3,
      riskScore: Math.min(100, riskScore),
      uniqueIPCount,
      geoSpread,
    };
  }
}
```

### 4.2 账号分摊检测系统

```javascript
class AccountDistributionDetector {
  // 检测同一 IP 下多账号协同请求
  async detectAccountDistribution(ip) {
    const accounts = await this.getAccountsByIP(ip, 300); // 最近5分钟
    
    if (accounts.length < 3) return { isDistribution: false };
    
    // 分析请求模式
    const patterns = await this.analyzeRequestPatterns(accounts);
    
    // 检测协同行为（请求时间高度相关）
    const correlation = this.calculateCorrelation(patterns);
    
    return {
      isDistribution: correlation > 0.8,
      riskScore: correlation * 100,
      accountCount: accounts.length,
      correlation,
    };
  }
}
```

### 4.3 时间窗口边界攻击检测

```javascript
class WindowBoundaryDetector {
  // 检测窗口边界集中请求
  async detectBoundaryAttack(userId, endpoint) {
    const windowSize = 60000; // 1分钟窗口
    const requests = await this.getRecentRequests(userId, endpoint, windowSize * 2);
    
    // 计算请求时间分布
    const distribution = this.calculateTimeDistribution(requests, windowSize);
    
    // 检测边界集中（窗口末尾 10% 时间内有 50%+ 请求）
    const boundaryRatio = distribution.boundaryCount / distribution.totalCount;
    
    return {
      isBoundaryAttack: boundaryRatio > 0.5,
      riskScore: boundaryRatio * 100,
      boundaryRatio,
    };
  }
}
```

### 4.4 限流状态完整性验证

```javascript
class RateLimitIntegrityValidator {
  // 验证 Redis 限流计数器完整性
  async validateRateLimitState(key, expectedCount) {
    const actualCount = await redis.get(key);
    
    // 检测异常
    const discrepancy = Math.abs(actualCount - expectedCount);
    if (discrepancy > expectedCount * 0.1) {
      // 超过 10% 误差，可能被篡改
      await this.alertTampering(key, actualCount, expectedCount);
      return { valid: false, tampered: true };
    }
    
    return { valid: true, tampered: false };
  }
}
```

### 4.5 API 端点设计

```
GET /api/v1/security/rate-limit-bypass/stats
  - 功能：获取限流绕过统计
  - 响应：{ totalAttempts, blockedAttempts, byType, topOffenders }

POST /api/v1/security/rate-limit-bypass/block
  - 功能：手动封禁绕过者
  - 请求体：{ userId, reason, duration }

GET /api/v1/security/rate-limit-bypass/report
  - 功能：生成绕过行为报告
  - 查询参数：startDate, endDate
```

### 4.6 Prometheus 指标

```javascript
const metrics = {
  bypassAttemptsTotal: new Counter({
    name: 'minego_ratelimit_bypass_attempts_total',
    help: 'Rate limit bypass attempts',
    labelNames: ['type', 'severity'],
  }),
  
  bypassBlockedTotal: new Counter({
    name: 'minego_ratelimit_bypass_blocked_total',
    help: 'Blocked bypass attempts',
    labelNames: ['type'],
  }),
  
  ipRotationScore: new Histogram({
    name: 'minego_ratelimit_ip_rotation_score',
    help: 'IP rotation risk score distribution',
    buckets: [0, 20, 40, 60, 80, 100],
  }),
};
```

## 5. 验收标准（可测试）

- [ ] IP 轮换检测模块已实现，支持检测短时间内多 IP 同账号
- [ ] 账号分摊检测模块已实现，支持检测同 IP 多账号协同请求
- [ ] 时间窗口边界攻击检测已实现
- [ ] 限流状态完整性验证已实现
- [ ] 3 个 API 端点已实现
- [ ] 数据库迁移文件已创建
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] Prometheus 指标已集成
- [ ] 审核文档已创建

## 6. 工作量估算

**M（Medium）** - 预计 1-2 天

理由：
- 检测逻辑相对独立
- 可复用现有限流基础设施
- 主要工作是模式识别和告警

## 7. 优先级理由

**P1** - 高优先级

理由：
1. **安全基础**：限流是 API 安全的基础，绕过会削弱所有安全措施
2. **资源保护**：绕过限流可能导致资源耗尽
3. **攻击入口**：限流绕过常是其他攻击的前兆
4. **现有缺口**：REQ-00098 已实现限流，但无绕过检测
