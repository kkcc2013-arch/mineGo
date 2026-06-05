# REQ-00014：服务熔断与降级机制

- **编号**：REQ-00014
- **类别**：容灾/高可用
- **优先级**：P0
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared
- **创建时间**：2026-06-05 09:30
- **依赖需求**：REQ-00002（结构化日志）、REQ-00005（Prometheus 指标）

## 1. 背景与问题

当前 mineGo 缺少服务熔断和降级机制，存在以下风险：

### 1.1 级联故障风险

典型场景：reward-service 故障导致整个系统不可用

```
用户捕捉精灵 → catch-service → reward-service (超时)
                                    ↓
                            等待 30s 超时
                                    ↓
                            线程池耗尽
                                    ↓
                        catch-service 无响应
                                    ↓
                        所有捕捉请求失败
```

**当前状态**：
- 无熔断器：故障服务持续被调用，资源耗尽
- 无降级策略：核心功能和非核心功能同等对待
- 无自动恢复：服务恢复后无法自动恢复调用

### 1.2 故障影响分析

| 服务故障 | 当前影响 | 期望影响 |
|---------|---------|---------|
| user-service | 无法登录、无法捕捉 | 无法登录，但已登录用户可继续游戏 |
| location-service | 无法捕捉 | 降级为粗略定位，继续捕捉 |
| reward-service | 捕捉卡死 | 捕捉成功，奖励稍后补发 |
| social-service | 捕捉卡死 | 捕捉成功，通知稍后发送 |
| payment-service | 支付失败 | 支付失败（核心，不应降级） |

## 2. 目标

建立完整的服务容错体系：

1. **熔断器**：自动熔断故障服务，快速失败，保护系统资源
2. **降级策略**：非核心服务故障时降级处理，核心功能不受影响
3. **自动恢复**：服务恢复后自动尝试恢复调用
4. **监控告警**：熔断事件触发告警，及时响应
5. **配置化**：熔断阈值、降级策略可配置，灵活调整

## 3. 范围

### 包含
- 熔断器实现（Circuit Breaker 模式）
- 降级策略框架
- Gateway 统一熔断中间件
- 关键场景降级逻辑（捕捉、道馆、支付）
- 熔断状态监控和告警

### 不包含
- 限流（已有 express-rate-limit）
- 服务重试（在 REQ-00013 事件驱动中处理）
- 分布式熔断器状态同步（单机熔断器足够）

## 4. 详细需求

### 4.1 熔断器实现

#### 4.1.1 CircuitBreaker 类
```javascript
// backend/shared/CircuitBreaker.js
const { EventEmitter } = require('events');

class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.failureThreshold = options.failureThreshold || 5;  // 失败阈值
    this.successThreshold = options.successThreshold || 2;  // 成功阈值（半开状态）
    this.timeout = options.timeout || 60000;  // 熔断超时时间
    
    this.failures = 0;
    this.successes = 0;
    this.state = 'CLOSED';  // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = Date.now();
    
    this.name = options.name || 'circuit-breaker';
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error(`Circuit breaker [${this.name}] is OPEN`);
      }
      this.state = 'HALF_OPEN';
      this.emit('half-open', this.name);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.failures = 0;
    
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.state = 'CLOSED';
        this.successes = 0;
        this.emit('close', this.name);
      }
    }
  }

  onFailure() {
    this.failures++;
    this.successes = 0;
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
      this.emit('open', this.name);
    }
  }

  getStats() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      nextAttempt: this.nextAttempt
    };
  }
}

module.exports = { CircuitBreaker };
```

### 4.2 降级策略框架

#### 4.2.1 FallbackStrategy 类
```javascript
// backend/shared/FallbackStrategy.js
class FallbackStrategy {
  constructor(options = {}) {
    this.name = options.name || 'default-fallback';
    this.handler = options.handler || this.defaultHandler;
  }

  async defaultHandler(ctx, err) {
    logger.warn({ strategy: this.name, err }, 'Fallback triggered');
    return { success: false, fallback: true, message: 'Service temporarily unavailable' };
  }

  async execute(ctx, err) {
    return this.handler(ctx, err);
  }
}

// 预定义降级策略
const FallbackStrategies = {
  // 返回空数据
  emptyData: new FallbackStrategy({
    name: 'empty-data',
    handler: async () => ({ success: true, data: [] })
  }),
  
  // 返回缓存数据
  cachedData: new FallbackStrategy({
    name: 'cached-data',
    handler: async (ctx) => {
      const cached = await cache.get(ctx.cacheKey);
      return cached || { success: false, fallback: true };
    }
  }),
  
  // 返回默认值
  defaultValue: new FallbackStrategy({
    name: 'default-value',
    handler: async (ctx) => ({ success: true, ...ctx.defaultValue })
  }),
  
  // 记录并稍后重试
  retryLater: new FallbackStrategy({
    name: 'retry-later',
    handler: async (ctx, err) => {
      await eventBus.publish('retry.queue', { ctx, error: err.message });
      return { success: true, message: 'Request queued for retry' };
    }
  })
};
```

### 4.3 Gateway 熔断中间件

#### 4.3.1 服务熔断配置
```javascript
// backend/gateway/src/circuitBreakers.js
const { CircuitBreaker } = require('../../shared');

const circuitBreakers = {
  'user-service': new CircuitBreaker({
    name: 'user-service',
    failureThreshold: 5,
    timeout: 30000
  }),
  
  'location-service': new CircuitBreaker({
    name: 'location-service',
    failureThreshold: 10,
    timeout: 20000
  }),
  
  'reward-service': new CircuitBreaker({
    name: 'reward-service',
    failureThreshold: 3,
    timeout: 60000
  }),
  
  'social-service': new CircuitBreaker({
    name: 'social-service',
    failureThreshold: 3,
    timeout: 60000
  }),
  
  // payment-service 不熔断（核心服务）
};

// 监听熔断事件
Object.values(circuitBreakers).forEach(cb => {
  cb.on('open', (name) => {
    logger.error({ service: name }, 'Circuit breaker OPEN');
    metrics.circuitBreakerStatus.set({ service: name, state: 'open' }, 1);
    // 发送告警
    alertManager.send({ service: name, event: 'circuit-open' });
  });
  
  cb.on('close', (name) => {
    logger.info({ service: name }, 'Circuit breaker CLOSED');
    metrics.circuitBreakerStatus.set({ service: name, state: 'closed' }, 0);
  });
});
```

#### 4.3.2 熔断中间件
```javascript
// backend/gateway/src/middleware/circuitBreakerMiddleware.js
function circuitBreakerMiddleware(serviceName) {
  const cb = circuitBreakers[serviceName];
  const fallback = fallbackStrategies[serviceName];
  
  return async (req, res, next) => {
    if (!cb) {
      return next();  // 无熔断器，直接调用
    }
    
    try {
      await cb.execute(async () => {
        await next();
      });
    } catch (err) {
      if (err.message.includes('Circuit breaker') && err.message.includes('OPEN')) {
        // 熔断器打开，执行降级
        const result = await fallback.execute(req.context, err);
        return res.json(result);
      }
      
      throw err;
    }
  };
}
```

### 4.4 关键场景降级逻辑

#### 4.4.1 捕捉场景降级
```javascript
// backend/gateway/src/routes/catch.js
router.post('/catch',
  circuitBreakerMiddleware('location-service'),
  async (req, res) => {
    try {
      // 尝试精确位置验证
      const location = await locationService.verify(req.body.location);
      req.context.location = location;
    } catch (err) {
      // 降级：使用粗略位置
      logger.warn('Location service unavailable, using coarse location');
      req.context.location = { lat: req.body.lat, lng: req.body.lng, accuracy: 'low' };
    }
    
    // 捕捉逻辑（核心，不降级）
    const result = await catchService.execute(req.context);
    
    // 奖励（非核心，可降级）
    try {
      await circuitBreakers['reward-service'].execute(async () => {
        await rewardService.grant(req.user.id, result);
      });
    } catch (err) {
      // 降级：稍后补发奖励
      await eventBus.publish('reward.retry', { userId: req.user.id, result });
      result.rewardStatus = 'pending';
    }
    
    res.json(result);
  }
);
```

#### 4.4.2 降级策略配置
```javascript
// backend/gateway/src/fallbackStrategies.js
const fallbackStrategies = {
  'user-service': FallbackStrategies.cachedData,
  
  'location-service': new FallbackStrategy({
    name: 'location-coarse',
    handler: async (ctx) => ({
      success: true,
      location: { lat: ctx.lat, lng: ctx.lng, accuracy: 'low' },
      degraded: true
    })
  }),
  
  'reward-service': FallbackStrategies.retryLater,
  'social-service': FallbackStrategies.retryLater
};
```

### 4.5 监控和告警

#### 4.5.1 Prometheus 指标
```javascript
// backend/shared/metrics.js (扩展)
const circuitBreakerStatus = new Gauge({
  name: 'circuit_breaker_status',
  help: 'Circuit breaker status (0=closed, 1=open, 2=half-open)',
  labelNames: ['service', 'state']
});

const circuitBreakerFailures = new Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['service']
});
```

#### 4.5.2 熔断状态 API
```javascript
// backend/gateway/src/routes/admin.js
router.get('/circuit-breakers', (req, res) => {
  const stats = {};
  
  for (const [name, cb] of Object.entries(circuitBreakers)) {
    stats[name] = cb.getStats();
  }
  
  res.json(stats);
});

router.post('/circuit-breakers/:service/reset', (req, res) => {
  const cb = circuitBreakers[req.params.service];
  if (!cb) {
    return res.status(404).json({ error: 'Service not found' });
  }
  
  cb.state = 'CLOSED';
  cb.failures = 0;
  cb.successes = 0;
  
  res.json({ success: true, stats: cb.getStats() });
});
```

## 5. 验收标准（可测试）

- [ ] CircuitBreaker 类已实现，支持 CLOSED/OPEN/HALF_OPEN 三种状态
- [ ] Gateway 已集成熔断中间件，配置了所有非核心服务的熔断器
- [ ] 熔断器在失败 5 次后自动打开，60 秒后尝试半开
- [ ] 半开状态成功 2 次后自动关闭
- [ ] 捕捉场景降级逻辑正常：location-service 故障时使用粗略定位
- [ ] 奖励降级逻辑正常：reward-service 故障时稍后补发
- [ ] 熔断事件触发告警（Prometheus 指标 + 日志）
- [ ] `/admin/circuit-breakers` API 可查看所有熔断器状态
- [ ] `/admin/circuit-breakers/:service/reset` 可手动重置熔断器
- [ ] 单元测试覆盖率 ≥ 90%（CircuitBreaker）
- [ ] 集成测试验证熔断和降级正常工作
- [ ] 性能测试：熔断器开销 < 1ms

## 6. 工作量估算

**L (Large)**

- CircuitBreaker 实现：1 天
- 降级策略框架：0.5 天
- Gateway 集成：1 天
- 关键场景降级逻辑：1 天
- 监控和告警：0.5 天
- 测试和验证：1 天

**总计：5 天**

## 7. 优先级理由

**P0** 理由：

1. **生产必备**：没有熔断机制，单点故障可能导致整个系统不可用
2. **影响核心功能**：当前 reward-service 故障会导致捕捉功能完全不可用
3. **快速见效**：熔断机制可立即提升系统稳定性
4. **故障隔离**：防止级联故障，保护核心服务
5. **运维友好**：自动故障恢复，减少人工干预

这是生产环境的基本要求，必须优先实施。
