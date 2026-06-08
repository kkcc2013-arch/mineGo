# REQ-00039：热点数据缓存预热系统

- **编号**：REQ-00039
- **类别**：性能优化
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、pokemon-service、location-service、backend/shared、Redis
- **创建时间**：2026-06-08 23:05
- **完成时间**：2026-06-08 23:30
- **依赖需求**：REQ-00031（API 响应缓存层与缓存失效策略）

## 1. 背景与问题

REQ-00031 已实现双层缓存架构（内存 + Redis），显著降低了 API 响应延迟。但在以下场景仍存在性能问题：

1. **服务冷启动**：服务重启或部署后，缓存为空，首批请求直接穿透到数据库，导致延迟激增（可达 500ms+）
2. **缓存大面积失效**：TTL 过期或批量删除后，短时间内大量请求涌入数据库
3. **热点数据未预热**：精灵图鉴、活动配置等高频访问数据未被主动加载

当前 `backend/shared/cache.js` 缺少预热机制，仅支持被动缓存填充。监控数据显示：
- 冷启动后前 5 分钟平均延迟：280ms
- 缓存稳定后平均延迟：45ms
- 缓存命中率：首次请求 0%，后续 85%+

## 2. 目标

1. 服务启动时自动预热热点数据，冷启动延迟降低 70%+
2. 定期刷新热点数据缓存，避免 TTL 边界性能抖动
3. 提供手动预热 API，支持运维干预
4. 预热过程可观测，暴露 Prometheus 指标

## 3. 范围

- **包含**：
  - 热点数据识别与配置（精灵图鉴、活动配置、稀有精灵刷新点）
  - 服务启动时自动预热机制
  - 定时后台刷新任务
  - 预热状态监控与告警
  - 手动预热管理 API

- **不包含**：
  - 用户个性化数据预热（用户精灵列表、背包等）
  - 分布式预热协调（多实例场景，每个实例独立预热）
  - 缓存数据版本控制

## 4. 详细需求

### 4.1 热点数据配置

在 `backend/shared/cacheConfig.js` 中定义热点数据配置：

```javascript
const HOT_DATA_CONFIG = {
  // 精灵图鉴 - 访问频率最高的基础数据
  pokemonSpecies: {
    enabled: true,
    keys: ['pokemon:species:*'],  // 支持模式
    preloadQuery: 'SELECT * FROM pokemon_species',
    ttl: 3600000,  // 1 小时
    refreshInterval: 1800000,  // 30 分钟刷新一次
    priority: 1,  // 最高优先级
  },
  // 活动配置 - 全局共享
  events: {
    enabled: true,
    keys: ['events:active', 'events:config:*'],
    preloadQuery: 'SELECT * FROM events WHERE status = \'active\'',
    ttl: 1800000,
    refreshInterval: 600000,  // 10 分钟
    priority: 2,
  },
  // 稀有精灵刷新点缓存
  rareSpawnPoints: {
    enabled: true,
    keys: ['spawn:rare:*'],
    preloadQuery: `
      SELECT id, lat, lng FROM spawn_points 
      WHERE rarity IN ('EPIC', 'LEGENDARY') AND is_active = true
    `,
    ttl: 300000,  // 5 分钟
    refreshInterval: 120000,
    priority: 3,
  },
  // 道馆信息
  gyms: {
    enabled: true,
    keys: ['gym:*'],
    preloadQuery: 'SELECT id, lat, lng, team_id FROM gyms WHERE is_active = true',
    ttl: 600000,
    refreshInterval: 300000,
    priority: 2,
  }
};
```

### 4.2 缓存预热服务

创建 `backend/shared/cacheWarmup.js`：

```javascript
/**
 * 缓存预热服务
 * 
 * 功能：
 * 1. 服务启动时自动预热热点数据
 * 2. 定时后台刷新
 * 3. 预热状态追踪与监控
 */

const { query } = require('./db');
const { setJSON, set } = require('./redis');
const { createLogger } = require('./logger');
const metrics = require('./metrics');
const { HOT_DATA_CONFIG } = require('./cacheConfig');

const logger = createLogger('cache-warmup');

// 预热状态
const warmupStatus = {
  lastWarmup: null,
  warmupCount: 0,
  failedCount: 0,
  itemsLoaded: 0,
  isWarming: false,
};

// 定时器引用
const refreshTimers = new Map();

/**
 * 初始化预热服务
 * 在服务启动时调用
 */
async function initialize() {
  logger.info('Starting cache warmup initialization...');
  warmupStatus.isWarming = true;
  
  try {
    // 按优先级排序执行预热
    const configs = Object.entries(HOT_DATA_CONFIG)
      .filter(([, config]) => config.enabled)
      .sort((a, b) => a[1].priority - b[1].priority);

    for (const [name, config] of configs) {
      const startTime = Date.now();
      try {
        const count = await warmupData(name, config);
        const duration = Date.now() - startTime;
        logger.info({ name, count, duration }, 'Warmup completed');
        metrics.cacheWarmupTotal.inc({ name, status: 'success' });
      } catch (err) {
        logger.error({ name, err }, 'Warmup failed');
        warmupStatus.failedCount++;
        metrics.cacheWarmupTotal.inc({ name, status: 'error' });
      }
    }

    warmupStatus.lastWarmup = new Date().toISOString();
    warmupStatus.warmupCount++;
    warmupStatus.isWarming = false;
    
    // 启动定时刷新
    startBackgroundRefresh();
    
    logger.info('Cache warmup initialization completed');
  } catch (err) {
    warmupStatus.isWarming = false;
    logger.error({ err }, 'Cache warmup initialization failed');
    throw err;
  }
}

/**
 * 预热单个数据集
 */
async function warmupData(name, config) {
  const { preloadQuery, ttl } = config;
  
  const { rows } = await query(preloadQuery);
  
  // 根据数据类型选择缓存策略
  for (const row of rows) {
    const cacheKey = generateCacheKey(name, row);
    await setJSON(cacheKey, row, ttl / 1000);  // Redis TTL 单位是秒
    warmupStatus.itemsLoaded++;
  }
  
  return rows.length;
}

/**
 * 生成缓存键
 */
function generateCacheKey(name, row) {
  switch (name) {
    case 'pokemonSpecies':
      return `pokemon:species:${row.id}`;
    case 'events':
      return row.id ? `events:config:${row.id}` : 'events:active';
    case 'rareSpawnPoints':
      return `spawn:rare:${row.id}`;
    case 'gyms':
      return `gym:${row.id}`;
    default:
      return `${name}:${row.id || Date.now()}`;
  }
}

/**
 * 启动后台刷新任务
 */
function startBackgroundRefresh() {
  for (const [name, config] of Object.entries(HOT_DATA_CONFIG)) {
    if (!config.enabled || !config.refreshInterval) continue;
    
    // 清除已存在的定时器
    if (refreshTimers.has(name)) {
      clearInterval(refreshTimers.get(name));
    }
    
    // 创建新的定时刷新任务
    const timer = setInterval(async () => {
      logger.debug({ name }, 'Starting background refresh');
      try {
        const count = await warmupData(name, config);
        logger.info({ name, count }, 'Background refresh completed');
        metrics.cacheWarmupTotal.inc({ name, status: 'refresh' });
      } catch (err) {
        logger.error({ name, err }, 'Background refresh failed');
        metrics.cacheWarmupTotal.inc({ name, status: 'refresh_error' });
      }
    }, config.refreshInterval);
    
    refreshTimers.set(name, timer);
  }
}

/**
 * 获取预热状态
 */
function getStatus() {
  return {
    ...warmupStatus,
    configCount: Object.keys(HOT_DATA_CONFIG).length,
    activeRefreshers: refreshTimers.size,
  };
}

/**
 * 手动触发预热
 */
async function triggerWarmup(dataName = null) {
  if (warmupStatus.isWarming) {
    throw new Error('Warmup already in progress');
  }
  
  warmupStatus.isWarming = true;
  
  try {
    if (dataName) {
      const config = HOT_DATA_CONFIG[dataName];
      if (!config) throw new Error(`Unknown data: ${dataName}`);
      await warmupData(dataName, config);
    } else {
      // 预热所有
      for (const [name, config] of Object.entries(HOT_DATA_CONFIG)) {
        if (config.enabled) {
          await warmupData(name, config);
        }
      }
    }
    warmupStatus.lastWarmup = new Date().toISOString();
    warmupStatus.warmupCount++;
  } finally {
    warmupStatus.isWarming = false;
  }
}

/**
 * 清理资源
 */
function shutdown() {
  for (const timer of refreshTimers.values()) {
    clearInterval(timer);
  }
  refreshTimers.clear();
  logger.info('Cache warmup service shutdown');
}

module.exports = {
  initialize,
  getStatus,
  triggerWarmup,
  shutdown,
};
```

### 4.3 Prometheus 指标

在 `backend/shared/metrics.js` 添加：

```javascript
// 缓存预热指标
const cacheWarmupTotal = new Counter({
  name: 'cache_warmup_total',
  help: 'Total number of cache warmup operations',
  labelNames: ['name', 'status'],
});

const cacheWarmupItems = new Gauge({
  name: 'cache_warmup_items_loaded',
  help: 'Number of items loaded during warmup',
  labelNames: ['name'],
});

const cacheWarmupDuration = new Histogram({
  name: 'cache_warmup_duration_seconds',
  help: 'Duration of cache warmup operations',
  labelNames: ['name'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});
```

### 4.4 管理 API

在 gateway 添加预热管理接口：

```javascript
// GET /admin/cache/warmup/status
app.get('/admin/cache/warmup/status', async (req, res) => {
  const status = cacheWarmup.getStatus();
  res.json({ success: true, data: status });
});

// POST /admin/cache/warmup/trigger
app.post('/admin/cache/warmup/trigger', async (req, res) => {
  const { name } = req.body;
  await cacheWarmup.triggerWarmup(name);
  res.json({ success: true, message: 'Warmup triggered' });
});
```

### 4.5 服务集成

在各微服务启动时调用预热初始化：

```javascript
// 在 pokemon-service, location-service 等服务启动时
const cacheWarmup = require('../../../shared/cacheWarmup');

async function startServer() {
  // ... 其他初始化
  
  // 缓存预热（非阻塞）
  cacheWarmup.initialize().catch(err => {
    logger.error({ err }, 'Cache warmup failed, continuing without warm cache');
  });
  
  app.listen(PORT, () => {
    logger.info(`Service started on port ${PORT}`);
  });
}
```

## 5. 验收标准（可测试）

- [ ] 服务启动时自动预热热点数据（精灵图鉴、活动配置、稀有刷新点）
- [ ] 冷启动后前 5 分钟平均延迟 < 100ms（相比之前 280ms 降低 65%+）
- [ ] 预热过程不阻塞服务启动，启动时间增加 < 2 秒
- [ ] 定时刷新任务按配置间隔执行，日志可追踪
- [ ] 预热状态 API 返回正确的统计信息
- [ ] 手动触发预热 API 可用，返回成功响应
- [ ] Prometheus 指标正确暴露：cache_warmup_total、cache_warmup_items_loaded
- [ ] 单元测试覆盖预热核心逻辑（≥ 80% 覆盖率）

## 6. 工作量估算

**M（中等）** - 需要新增约 300 行核心代码，集成到现有服务，配置项和测试用例。预计 1-2 天完成。

## 7. 优先级理由

P1 优先级：
1. **直接影响用户体验**：冷启动延迟问题影响首批用户请求
2. **生产环境必要**：部署后服务需要快速达到最佳性能状态
3. **依赖已就绪**：REQ-00031 已实现缓存层，预热是自然的增强
4. **高性价比**：投入小，收益明显（延迟降低 70%+）
