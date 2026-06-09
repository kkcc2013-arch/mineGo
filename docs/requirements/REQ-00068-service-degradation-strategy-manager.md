# REQ-00068：服务降级策略与优雅降级管理器

- **编号**：REQ-00068
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared、infrastructure/k8s
- **创建时间**：2026-06-09 22:05
- **依赖需求**：REQ-00014（服务熔断与降级机制）

## 1. 背景与问题

当前系统已实现熔断器（REQ-00014），但降级策略缺乏统一管理框架：

1. **降级策略分散**：各服务的降级逻辑硬编码在各自代码中，缺乏统一配置入口
2. **降级粒度粗糙**：目前只支持服务级降级，无法按接口、用户等级、区域等维度精细化降级
3. **降级状态不可见**：运维无法实时了解当前系统处于什么降级状态，降级决策缺乏可视化
4. **恢复机制缺失**：降级后缺乏自动恢复探测和渐进式恢复机制
5. **降级策略静态**：无法根据系统负载动态调整降级阈值和策略

## 2. 目标

构建完整的降级策略管理框架：
- 统一的降级策略配置中心，支持动态热更新
- 多维度降级粒度（全局/服务/接口/用户等级/区域）
- 降级状态实时可视化与告警
- 自动恢复探测与渐进式恢复机制
- 降级决策审计日志与回滚能力

## 3. 范围

### 包含
- 降级策略管理器（DegradationManager）
- 多级降级策略配置（全局/服务/接口/用户等级）
- 降级状态监控与告警
- 自动恢复探测机制
- 降级管理 API（启停、查询、配置）
- 降级决策审计日志

### 不包含
- 具体业务逻辑的降级实现（由各服务自行实现接口）
- 第三方服务降级（外部支付、地图服务等需单独处理）

## 4. 详细需求

### 4.1 降级策略配置

```javascript
// 降级策略配置结构
const degradationConfig = {
  // 全局降级策略
  global: {
    enabled: true,
    triggerConditions: {
      cpuUsage: 85,          // CPU 使用率阈值
      memoryUsage: 90,       // 内存使用率阈值
      errorRate: 0.05,       // 错误率阈值
      latencyP99: 3000,      // P99 延迟阈值(ms)
      activeConnections: 10000  // 活跃连接数阈值
    },
    actions: ['disable_non_essential', 'rate_limit_strict']
  },
  
  // 服务级降级策略
  services: {
    'social-service': {
      priority: 3,  // 优先级：1=核心，2=重要，3=非核心
      degradationLevels: {
        level1: {  // 轻度降级
          trigger: { errorRate: 0.02 },
          actions: ['cache_only', 'disable_realtime_updates']
        },
        level2: {  // 中度降级
          trigger: { errorRate: 0.05, latencyP99: 2000 },
          actions: ['read_only', 'disable_notifications']
        },
        level3: {  // 重度降级
          trigger: { errorRate: 0.1 },
          actions: ['service_unavailable', 'fallback_response']
        }
      }
    },
    'reward-service': {
      priority: 2,
      degradationLevels: {
        level1: {
          trigger: { latencyP99: 1500 },
          actions: ['disable_leaderboard', 'batch_rewards']
        },
        level2: {
          trigger: { errorRate: 0.03 },
          actions: ['essential_rewards_only', 'delayed_processing']
        }
      }
    }
  },
  
  // 接口级降级策略
  endpoints: {
    '/api/social/friends': {
      degradation: {
        cacheOnly: true,
        fallbackData: 'cached_friends_list',
        ttl: 300
      }
    },
    '/api/reward/leaderboard': {
      degradation: {
        disable: true,
        fallbackResponse: { message: '排行榜暂时不可用' }
      }
    }
  },
  
  // 用户等级降级策略
  userTiers: {
    vip: { priority: 1, exemptFromDegradation: true },
    premium: { priority: 2, degradationDelay: 60 },
    free: { priority: 3, degradationDelay: 0 }
  }
};
```

### 4.2 降级管理器核心实现

```javascript
// backend/shared/DegradationManager.js
class DegradationManager {
  constructor(config) {
    this.config = config;
    this.redis = config.redis;
    this.db = config.db;
    this.currentDegradationState = new Map();  // 服务 -> 降级级别
    this.degradationHistory = [];
    this.recoveryProbes = new Map();
    
    // 定时检测降级条件
    this.startHealthMonitoring();
  }
  
  /**
   * 检查服务是否需要降级
   */
  async checkDegradationNeeded(serviceName) {
    const serviceConfig = this.config.services[serviceName];
    if (!serviceConfig) return null;
    
    // 获取服务健康指标
    const metrics = await this.getServiceMetrics(serviceName);
    
    // 检查各级降级条件
    for (const [level, levelConfig] of Object.entries(serviceConfig.degradationLevels)) {
      if (this.shouldTriggerDegradation(metrics, levelConfig.trigger)) {
        return {
          service: serviceName,
          level,
          metrics,
          actions: levelConfig.actions
        };
      }
    }
    
    return null;
  }
  
  /**
   * 执行降级
   */
  async executeDegradation(degradationInfo) {
    const { service, level, actions, metrics } = degradationInfo;
    const currentLevel = this.currentDegradationState.get(service);
    
    // 避免重复降级
    if (currentLevel === level) return;
    
    // 记录降级历史
    this.degradationHistory.push({
      service,
      previousLevel: currentLevel,
      newLevel: level,
      metrics,
      timestamp: new Date()
    });
    
    // 更新状态
    this.currentDegradationState.set(service, level);
    
    // 广播降级事件
    await this.broadcastDegradationEvent(service, level, actions);
    
    // 启动恢复探测
    this.startRecoveryProbe(service);
    
    // 记录审计日志
    await this.logDegradationAction(service, level, metrics);
    
    return true;
  }
  
  /**
   * 恢复探测
   */
  startRecoveryProbe(serviceName) {
    if (this.recoveryProbes.has(serviceName)) return;
    
    const probeInterval = setInterval(async () => {
      const degradationNeeded = await this.checkDegradationNeeded(serviceName);
      
      if (!degradationNeeded) {
        await this.attemptRecovery(serviceName);
      }
    }, 30000);  // 每30秒探测一次
    
    this.recoveryProbes.set(serviceName, probeInterval);
  }
  
  /**
   * 尝试恢复
   */
  async attemptRecovery(serviceName) {
    const currentLevel = this.currentDegradationState.get(serviceName);
    
    if (!currentLevel || currentLevel === 'normal') {
      clearInterval(this.recoveryProbes.get(serviceName));
      this.recoveryProbes.delete(serviceName);
      return;
    }
    
    // 渐进式恢复：先恢复到上一级
    const serviceConfig = this.config.services[serviceName];
    const levels = Object.keys(serviceConfig.degradationLevels);
    const currentIndex = levels.indexOf(currentLevel);
    
    if (currentIndex > 0) {
      const previousLevel = levels[currentIndex - 1];
      await this.executeDegradation({
        service: serviceName,
        level: previousLevel,
        actions: serviceConfig.degradationLevels[previousLevel].actions,
        metrics: {}
      });
    } else {
      // 完全恢复
      this.currentDegradationState.set(serviceName, 'normal');
      await this.broadcastRecoveryEvent(serviceName);
      
      clearInterval(this.recoveryProbes.get(serviceName));
      this.recoveryProbes.delete(serviceName);
    }
  }
}
```

### 4.3 降级中间件

```javascript
// backend/shared/middleware/degradationMiddleware.js
const degradationManager = require('../DegradationManager');

function createDegradationMiddleware(serviceName) {
  return async (req, res, next) => {
    const state = degradationManager.getServiceState(serviceName);
    
    // 检查用户等级豁免
    if (req.user?.tier === 'vip' && state.level !== 'normal') {
      // VIP 用户不受降级影响
      return next();
    }
    
    // 应用降级策略
    if (state.level !== 'normal') {
      const endpointConfig = degradationManager.getEndpointConfig(req.path);
      
      if (endpointConfig?.degradation?.disable) {
        return res.status(503).json({
          error: 'SERVICE_DEGRADED',
          message: endpointConfig.degradation.fallbackResponse?.message || '服务暂时降级中',
          degraded: true
        });
      }
      
      if (endpointConfig?.degradation?.cacheOnly) {
        // 从缓存返回数据
        const cached = await degradationManager.getFallbackData(
          endpointConfig.degradation.fallbackData,
          req.user.id
        );
        if (cached) {
          return res.json({ data: cached, degraded: true, cached: true });
        }
      }
    }
    
    next();
  };
}
```

### 4.4 降级管理 API

```javascript
// backend/gateway/src/routes/degradation.js
router.get('/degradation/status', async (req, res) => {
  const status = degradationManager.getAllServicesStatus();
  res.json({ success: true, data: status });
});

router.post('/degradation/:service/enable', adminOnly, async (req, res) => {
  const { service } = req.params;
  const { level, reason } = req.body;
  await degradationManager.manualDegradation(service, level, reason);
  res.json({ success: true });
});

router.post('/degradation/:service/recover', adminOnly, async (req, res) => {
  const { service } = req.params;
  await degradationManager.forceRecover(service);
  res.json({ success: true });
});

router.get('/degradation/history', async (req, res) => {
  const history = degradationManager.getDegradationHistory();
  res.json({ success: true, data: history });
});
```

## 5. 验收标准（可测试）

- [ ] 降级策略可通过配置文件/Redis 热更新，无需重启服务
- [ ] 支持 3 级降级粒度：全局、服务、接口
- [ ] 降级触发条件满足时，5秒内自动执行降级
- [ ] VIP 用户在服务降级时仍可正常使用（豁免机制生效）
- [ ] 降级状态可通过 API 查询，返回所有服务当前降级级别
- [ ] 降级后自动启动恢复探测，条件满足时渐进式恢复
- [ ] 降级动作记录审计日志，包含时间、服务、级别、触发指标
- [ ] 手动降级/恢复操作立即生效，无需等待自动检测
- [ ] Prometheus 指标正确记录降级事件（degradation_events_total、current_degradation_level）
- [ ] 单元测试覆盖率 ≥ 85%

## 6. 工作量估算

**L**（Large）
- 核心降级管理器开发（3天）
- 中间件与 API 开发（1天）
- 前端降级状态展示（1天）
- 测试与文档（1天）

## 7. 优先级理由

系统已具备熔断能力（REQ-00014），但缺乏完整的降级策略管理框架。在大流量场景下，精细化降级能力对保障核心业务可用性至关重要，属于高可用基础设施的关键组件。
