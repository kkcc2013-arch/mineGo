# REQ-00031：API 响应缓存层与缓存失效策略

- **编号**：REQ-00031
- **类别**：技术债/重构
- **优先级**：P2
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、backend/shared、Redis
- **创建时间**：2026-06-05 23:05 UTC
- **依赖需求**：REQ-00001（Redis GEO 缓存）

## 1. 背景与问题

mineGo 项目目前缺乏统一的 API 响应缓存机制，导致重复计算和数据库查询：

### 1.1 当前问题

1. **重复查询**：精灵图鉴、道具列表等静态数据每次请求都查询数据库
2. **无缓存策略**：用户资料、好友列表等频繁访问数据无缓存
3. **缓存分散**：只有 location-service 使用 Redis GEO 缓存，其他服务未统一
4. **无失效机制**：缺少统一的缓存失效策略和 TTL 管理
5. **缓存穿透**：无空值缓存，恶意请求可能穿透到数据库

### 1.2 性能影响分析

| API 端点 | 当前延迟 | 缓存后预期 | 调用频率 |
|---------|---------|-----------|---------|
| GET /pokemon/pokedex | 120ms | 5ms | 高 |
| GET /users/:id/profile | 80ms | 10ms | 高 |
| GET /friends | 95ms | 15ms | 中 |
| GET /items | 60ms | 5ms | 中 |
| GET /gyms/nearby | 150ms | 20ms | 高 |

### 1.3 与 REQ-00001 的关系

REQ-00001 实现了 Redis GEO 缓存用于附近精灵查询，本需求将缓存机制扩展到所有适合缓存的 API。

## 2. 目标

建立统一的 API 响应缓存层：

1. **缓存中间件**：统一的 Express 缓存中间件
2. **多级缓存**：内存缓存 + Redis 缓存双层架构
3. **智能失效**：基于事件、时间、手动三种失效策略
4. **缓存预热**：服务启动时预热热点数据
5. **监控指标**：缓存命中率、延迟、大小监控

## 3. 范围

### 包含
- backend/shared/cache.js（核心缓存模块）
- backend/shared/cacheMiddleware.js（Express 中间件）
- backend/shared/cacheInvalidation.js（失效策略）
- Gateway 集成缓存中间件
- 各服务热点 API 缓存配置
- Prometheus 缓存指标

### 不包含
- 浏览器端缓存（HTTP 缓存头已有）
- CDN 缓存（基础设施层面）
- 分布式缓存一致性（当前规模不需要）

## 4. 详细需求

### 4.1 核心缓存模块 (cache.js)

```javascript
// backend/shared/cache.js

const Redis = require('ioredis');
const { createLogger } = require('./logger');

const logger = createLogger('cache');

// 内存缓存层（L1）
const memoryCache = new Map();
const MEMORY_TTL = 60000; // 1 分钟
const MAX_MEMORY_SIZE = 1000;

// Redis 缓存层（L2）
let redisClient;

/**
 * 初始化缓存模块
 */
function init(redisConfig) {
  redisClient = new Redis(redisConfig);
  
  // 定期清理内存缓存
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryCache) {
      if (entry.expireAt < now) {
        memoryCache.delete(key);
      }
    }
  }, 30000);
}

/**
 * 获取缓存值（双层查询）
 */
async function get(key) {
  // L1: 内存缓存
  const memEntry = memoryCache.get(key);
  if (memEntry && memEntry.expireAt > Date.now()) {
    metrics.cacheHit('memory');
    return memEntry.value;
  }
  
  // L2: Redis 缓存
  const redisValue = await redisClient.get(key);
  if (redisValue) {
    const value = JSON.parse(redisValue);
    // 回填 L1
    setMemory(key, value, MEMORY_TTL);
    metrics.cacheHit('redis');
    return value;
  }
  
  metrics.cacheMiss();
  return null;
}

/**
 * 设置缓存值
 */
async function set(key, value, ttl = 300) {
  const jsonValue = JSON.stringify(value);
  
  // 设置 L2 (Redis)
  await redisClient.setex(key, ttl, jsonValue);
  
  // 设置 L1 (内存)
  setMemory(key, value, Math.min(ttl * 1000, MEMORY_TTL));
}

/**
 * 删除缓存
 */
async function del(key) {
  memoryCache.delete(key);
  await redisClient.del(key);
}

/**
 * 批量删除（支持模式匹配）
 */
async function delPattern(pattern) {
  // 删除内存缓存
  for (const key of memoryCache.keys()) {
    if (minimatch(key, pattern)) {
      memoryCache.delete(key);
    }
  }
  
  // 删除 Redis 缓存
  const keys = await redisClient.keys(pattern);
  if (keys.length > 0) {
    await redisClient.del(...keys);
  }
}

module.exports = { init, get, set, del, delPattern };
```

### 4.2 缓存中间件 (cacheMiddleware.js)

```javascript
// backend/shared/cacheMiddleware.js

const cache = require('./cache');
const { createLogger } = require('./logger');

const logger = createLogger('cache-middleware');

/**
 * API 响应缓存中间件
 * 
 * @param {Object} options - 配置选项
 * @param {number} options.ttl - 缓存时间（秒）
 * @param {string} options.keyPrefix - 缓存键前缀
 * @param {Function} options.keyGenerator - 自定义键生成函数
 * @param {Array<string>} options.invalidateOn - 触发失效的事件列表
 */
function cacheMiddleware(options = {}) {
  const {
    ttl = 300,
    keyPrefix = 'api:',
    keyGenerator = defaultKeyGenerator,
    invalidateOn = []
  } = options;
  
  return async (req, res, next) => {
    // 只缓存 GET 请求
    if (req.method !== 'GET') {
      return next();
    }
    
    // 跳过认证用户特定数据（除非显式允许）
    if (req.user && !options.cacheUserData) {
      return next();
    }
    
    const cacheKey = keyPrefix + keyGenerator(req);
    
    try {
      const cached = await cache.get(cacheKey);
      
      if (cached) {
        logger.debug({ key: cacheKey }, 'Cache hit');
        return res.json(cached);
      }
      
      // 拦截 res.json 以缓存响应
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        // 只缓存成功响应
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cache.set(cacheKey, data, ttl).catch(err => {
            logger.error({ err, key: cacheKey }, 'Cache set failed');
          });
        }
        return originalJson(data);
      };
      
      next();
    } catch (err) {
      logger.error({ err, key: cacheKey }, 'Cache middleware error');
      next();
    }
  };
}

/**
 * 默认键生成函数
 */
function defaultKeyGenerator(req) {
  const path = req.path;
  const query = JSON.stringify(req.query);
  const user = req.user ? req.user.id : 'anonymous';
  return `${path}:${query}:${user}`;
}

module.exports = cacheMiddleware;
```

### 4.3 缓存失效策略

```javascript
// backend/shared/cacheInvalidation.js

const cache = require('./cache');
const { createLogger } = require('./logger');

const logger = createLogger('cache-invalidation');

// 失效规则配置
const invalidationRules = {
  // 用户相关
  'user.updated': ['api:/users/:userId:*', 'api:/friends:*'],
  'user.deleted': ['api:/users/:userId:*'],
  
  // 精灵相关
  'pokemon.caught': ['api:/pokemon/:userId:*'],
  'pokemon.released': ['api:/pokemon/:userId:*'],
  'pokemon.evolved': ['api:/pokemon/:userId:*'],
  
  // 好友相关
  'friend.added': ['api:/friends:*'],
  'friend.removed': ['api:/friends:*'],
  
  // 道馆相关
  'gym.captured': ['api:/gyms/nearby:*'],
  'raid.started': ['api:/gyms/:gymId:*'],
  'raid.ended': ['api:/gyms/:gymId:*'],
  
  // 道具相关
  'item.used': ['api:/items:*'],
  'item.purchased': ['api:/items:*']
};

/**
 * 处理缓存失效事件
 */
async function handleInvalidation(event, data) {
  const patterns = invalidationRules[event] || [];
  
  for (const pattern of patterns) {
    // 替换模式中的变量
    const concretePattern = resolvePattern(pattern, data);
    
    try {
      await cache.delPattern(concretePattern);
      logger.info({ event, pattern: concretePattern }, 'Cache invalidated');
    } catch (err) {
      logger.error({ err, event, pattern: concretePattern }, 'Invalidation failed');
    }
  }
}

/**
 * 解析模式中的变量
 */
function resolvePattern(pattern, data) {
  return pattern
    .replace(':userId', data.userId || '*')
    .replace(':gymId', data.gymId || '*');
}

module.exports = { handleInvalidation, invalidationRules };
```

### 4.4 Gateway 集成示例

```javascript
// backend/gateway/src/index.js (部分)

const cacheMiddleware = require('../../shared/cacheMiddleware');

// 精灵图鉴缓存（静态数据，长 TTL）
app.get('/pokemon/pokedex', 
  cacheMiddleware({ ttl: 3600, keyPrefix: 'api:pokedex:' }),
  proxyToPokemonService
);

// 用户资料缓存（用户特定，中 TTL）
app.get('/users/:id/profile',
  cacheMiddleware({ 
    ttl: 300, 
    keyPrefix: 'api:profile:',
    cacheUserData: true 
  }),
  proxyToUserService
);

// 好友列表缓存
app.get('/friends',
  cacheMiddleware({ 
    ttl: 180, 
    keyPrefix: 'api:friends:',
    cacheUserData: true 
  }),
  proxyToSocialService
);

// 道具列表缓存
app.get('/items',
  cacheMiddleware({ ttl: 600, keyPrefix: 'api:items:' }),
  proxyToUserService
);
```

### 4.5 Prometheus 指标

```javascript
// backend/shared/metrics.js (扩展)

// 缓存指标
const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['layer'] // memory, redis
});

const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses'
});

const cacheLatency = new Histogram({
  name: 'cache_operation_latency_seconds',
  help: 'Cache operation latency',
  labelNames: ['operation', 'layer'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1]
});

const cacheSize = new Gauge({
  name: 'cache_size_bytes',
  help: 'Current cache size in bytes',
  labelNames: ['layer']
});
```

## 5. 验收标准（可测试）

- [ ] cache.js 模块实现双层缓存（内存 + Redis）
- [ ] cacheMiddleware.js 支持 GET 请求缓存
- [ ] 缓存失效策略支持事件驱动失效
- [ ] Gateway 集成缓存中间件
- [ ] 至少 5 个高频 API 启用缓存
- [ ] Prometheus 缓存指标正确暴露
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 缓存命中率监控可用
- [ ] 缓存穿透保护有效
- [ ] 性能测试显示延迟降低 ≥ 50%

## 6. 工作量估算

**M (Medium)**

- cache.js 核心模块：1 天
- cacheMiddleware.js：0.5 天
- cacheInvalidation.js：0.5 天
- Gateway 集成：0.5 天
- Prometheus 指标：0.5 天
- 单元测试：1 天

**总计：4 天**

## 7. 优先级理由

**P2** 理由：

1. **性能提升**：高频 API 延迟降低 50%+
2. **数据库减压**：减少重复查询，降低数据库负载
3. **用户体验**：更快的响应速度
4. **技术债**：统一缓存机制，消除分散实现
5. **可扩展性**：为未来更高流量做准备

不影响核心功能，但对性能和可维护性有显著提升。
