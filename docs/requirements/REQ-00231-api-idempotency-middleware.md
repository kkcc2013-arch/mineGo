# REQ-00231：通用 API 幂等性中间件系统

- **编号**：REQ-00231
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/IdempotencyMiddleware.js、gateway、catch-service、gym-service、payment-service、Redis
- **创建时间**：2026-06-15 20:40
- **依赖需求**：REQ-00032（多渠道通知插件 - 已完成）、REQ-00039（缓存预热系统 - 已完成）

## 1. 背景与问题

### 当前现状
- 支付服务已实现幂等性机制（`payment-service/src/index.js`），使用 `idempotencyKey` 防止重复支付
- 其他关键操作（精灵捕捉、物品使用、道馆战斗等）缺少幂等性保护
- 网络重试、客户端重复提交、消息队列重复消费可能导致数据不一致
- REQ-00217（数据库查询请求合并与去重中间件）仅针对查询去重，不处理写入操作

### 核心问题
1. **数据一致性风险**：重复请求可能导致重复扣费、重复捕捉、积分重复发放
2. **资源浪费**：重复请求消耗数据库连接、网络带宽、计算资源
3. **用户体验差**：重复提交导致错误提示或数据异常
4. **缺少统一方案**：每个服务需要重复实现幂等性逻辑

## 2. 目标

构建通用 API 幂等性中间件系统，确保关键操作的幂等性：
- **防重复提交**：客户端重复提交请求时返回第一次的结果
- **网络重试安全**：网络超时后重试不会导致重复执行
- **消息队列幂等**：Kafka 消息重复消费时不会重复执行
- **统一接口**：一行代码启用幂等性保护
- **性能优化**：幂等性检查延迟 < 5ms（Redis 缓存）

## 3. 范围

### 包含
- 通用幂等性中间件（基于 Redis）
- 幂等性 Key 生成策略（自动生成 + 自定义）
- 幂等性结果缓存（成功结果缓存 24h）
- 幂等性配置系统（哪些接口需要幂等性保护）
- 幂等性监控指标（重复请求率、缓存命中率）
- 管理员 API（查询/清除幂等性缓存）
- 单元测试和集成测试

### 不包含
- 分布式事务幂等性（跨服务调用链）
- 数据库层面的去重约束
- 前端防抖节流（属于前端优化）

## 4. 详细需求

### 4.1 幂等性中间件核心功能

```javascript
// backend/shared/IdempotencyMiddleware.js

/**
 * 通用 API 幂等性中间件
 * 
 * 使用方式：
 * app.post('/api/catch', idempotency({ ttl: 86400 }), catchHandler);
 */

class IdempotencyMiddleware {
  constructor(options = {}) {
    this.redis = getRedis();
    this.ttl = options.ttl || 86400; // 默认 24 小时
    this.keyPrefix = options.keyPrefix || 'idempotency';
    this.keyGenerator = options.keyGenerator || this._defaultKeyGenerator;
  }

  /**
   * 生成幂等性 Key
   * 默认：userId + method + path + requestBody hash
   */
  _defaultKeyGenerator(req) {
    const userId = req.user?.id || 'anonymous';
    const method = req.method;
    const path = req.path;
    const bodyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body || {}))
      .digest('hex')
      .substring(0, 16);
    
    return `${this.keyPrefix}:${userId}:${method}:${path}:${bodyHash}`;
  }

  /**
   * 检查幂等性
   */
  async check(req) {
    const key = this.keyGenerator(req);
    const cached = await this.redis.get(key);
    
    if (cached) {
      return {
        isDuplicate: true,
        result: JSON.parse(cached),
        key
      };
    }
    
    return { isDuplicate: false, key };
  }

  /**
   * 保存幂等性结果
   */
  async save(key, result) {
    await this.redis.setex(key, this.ttl, JSON.stringify(result));
  }
}
```

### 4.2 中间件接口

```javascript
/**
 * 幂等性中间件工厂函数
 */
function idempotency(options = {}) {
  const middleware = new IdempotencyMiddleware(options);
  
  return async (req, res, next) => {
    // 检查幂等性
    const checkResult = await middleware.check(req);
    
    if (checkResult.isDuplicate) {
      // 记录重复请求
      metrics.idempotencyDuplicateTotal.inc({ path: req.path });
      
      // 返回缓存的结果
      return res.json({
        ...checkResult.result,
        _idempotent: true,
        _cachedAt: checkResult.result.timestamp
      });
    }
    
    // 拦截 res.json 以缓存结果
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      // 只缓存成功响应
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await middleware.save(checkResult.key, {
          ...body,
          timestamp: new Date().toISOString()
        });
      }
      return originalJson(body);
    };
    
    next();
  };
}
```

### 4.3 幂等性配置系统

```javascript
// backend/shared/idempotencyConfig.js

/**
 * 需要幂等性保护的接口配置
 */
const IDEMPOTENCY_CONFIG = {
  // 精灵捕捉
  'POST /api/catch': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'user+location+pokemon', // 特殊策略
    description: '防止重复捕捉同一只精灵'
  },
  
  // 物品使用
  'POST /api/inventory/use': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'user+itemId+timestamp',
    description: '防止重复使用物品'
  },
  
  // 道馆战斗
  'POST /api/gym/battle': {
    enabled: true,
    ttl: 3600,
    keyStrategy: 'user+gymId',
    description: '防止重复战斗'
  },
  
  // 好友操作
  'POST /api/friend/add': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'user+friendId',
    description: '防止重复添加好友'
  },
  
  // 支付（已有，保持兼容）
  'POST /api/payment/create': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'custom', // 使用客户端提供的 idempotencyKey
    description: '支付幂等性'
  }
};
```

### 4.4 Key 生成策略

```javascript
/**
 * 幂等性 Key 生成策略
 */
const KEY_STRATEGIES = {
  // 默认：用户 + 方法 + 路径 + 请求体哈希
  'default': (req) => {
    const userId = req.user?.id || 'anonymous';
    const bodyHash = hashBody(req.body);
    return `idempotency:${userId}:${req.method}:${req.path}:${bodyHash}`;
  },
  
  // 用户 + 位置 + 精灵（用于捕捉）
  'user+location+pokemon': (req) => {
    const userId = req.user?.id;
    const { locationId, pokemonId } = req.body;
    return `idempotency:${userId}:catch:${locationId}:${pokemonId}`;
  },
  
  // 用户 + 物品ID + 时间戳（精确到分钟）
  'user+itemId+timestamp': (req) => {
    const userId = req.user?.id;
    const { itemId } = req.body;
    const timestamp = Math.floor(Date.now() / 60000); // 分钟级
    return `idempotency:${userId}:use:${itemId}:${timestamp}`;
  },
  
  // 自定义（使用客户端提供的 key）
  'custom': (req) => {
    const key = req.headers['x-idempotency-key'] || req.body.idempotencyKey;
    if (!key) {
      throw new Error('Missing idempotency key');
    }
    return `idempotency:custom:${key}`;
  }
};
```

### 4.5 管理员 API

```javascript
// GET /api/admin/idempotency/stats - 幂等性统计
// GET /api/admin/idempotency/keys?userId=xxx - 查询用户的幂等性缓存
// DELETE /api/admin/idempotency/keys/:key - 清除指定幂等性缓存
// POST /api/admin/idempotency/clear - 批量清除过期缓存
```

### 4.6 监控指标

```javascript
// Prometheus 指标
const metrics = {
  // 重复请求总数
  idempotencyDuplicateTotal: new Counter({
    name: 'minego_idempotency_duplicate_total',
    help: 'Total duplicate requests detected',
    labelNames: ['path', 'method']
  }),
  
  // 缓存命中率
  idempotencyCacheHits: new Counter({
    name: 'minego_idempotency_cache_hits_total',
    help: 'Idempotency cache hits'
  }),
  
  // 缓存写入次数
  idempotencyCacheWrites: new Counter({
    name: 'minego_idempotency_cache_writes_total',
    help: 'Idempotency cache writes'
  }),
  
  // 幂等性检查延迟
  idempotencyCheckDuration: new Histogram({
    name: 'minego_idempotency_check_duration_seconds',
    help: 'Idempotency check duration',
    buckets: [0.001, 0.002, 0.005, 0.01, 0.025, 0.05]
  })
};
```

## 5. 验收标准（可测试）

- [ ] 幂等性中间件可通过一行代码启用：`app.post('/api/catch', idempotency(), handler)`
- [ ] 重复请求返回第一次的结果，包含 `_idempotent: true` 标记
- [ ] 幂等性检查延迟 < 5ms（P95）
- [ ] 支持 5 种 Key 生成策略：default, user+location+pokemon, user+itemId+timestamp, user+gymId, custom
- [ ] 成功结果缓存 24 小时（可配置）
- [ ] 提供管理员 API 查询/清除幂等性缓存
- [ ] Prometheus 指标正常采集：duplicate_total, cache_hits, cache_writes, check_duration
- [ ] 单元测试覆盖率 > 85%
- [ ] 集成测试验证真实场景（捕捉、战斗、支付）

## 6. 工作量估算

**M（中等）**

**理由**：
- 核心逻辑相对简单（Redis 缓存 + 中间件拦截）
- 需要设计多种 Key 生成策略
- 需要与现有服务集成（gateway、catch、gym、payment）
- 单元测试和集成测试工作量适中
- 预估工作量：2-3 天

## 7. 优先级理由

**P1（高优先级）**

**理由**：
1. **数据一致性关键**：防止重复捕捉、重复扣费等严重问题
2. **性能优化价值高**：减少重复请求的数据库查询和计算开销
3. **依赖已具备**：REQ-00032（Redis）、REQ-00039（缓存系统）已完成
4. **影响范围广**：几乎所有写操作都需要幂等性保护
5. **用户价值显著**：提升用户体验，避免因网络问题导致的操作失败

---

## 附录：技术实现要点

### A. Redis Key 设计

```
idempotency:{userId}:{method}:{path}:{bodyHash}
idempotency:{userId}:catch:{locationId}:{pokemonId}
idempotency:{userId}:use:{itemId}:{timestamp}
idempotency:{userId}:battle:{gymId}
idempotency:custom:{clientProvidedKey}
```

### B. 性能优化

- 使用 Redis Pipeline 批量检查
- 本地内存缓存热点 Key（LRU，10000 条）
- 异步写入缓存（不阻塞响应）

### C. 异常处理

- Redis 故障时降级：记录日志，放行请求
- Key 生成失败时：抛出错误，拒绝请求
- 缓存写入失败时：记录日志，不影响正常响应

### D. 安全考虑

- 敏感数据不缓存（密码、支付凭证）
- 幂等性缓存定期清理
- 管理员 API 需要权限验证
