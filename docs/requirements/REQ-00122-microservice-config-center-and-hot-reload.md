# REQ-00122：微服务配置中心与动态配置热更新系统

- **编号**：REQ-00122
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/config、Redis、infrastructure/k8s
- **创建时间**：2026-06-11 18:00
- **依赖需求**：REQ-00050（插件化中间件系统）

## 1. 背景与问题

当前 mineGo 项目中，各微服务的配置分散在以下位置：
1. **环境变量**：`backend/services/*/src/index.js` 中直接读取 `process.env`
2. **硬编码**：部分常量和配置直接写在代码中（如超时时间、重试次数、缓存TTL等）
3. **K8s ConfigMap**：基础设施配置在 K8s 中，但服务需要重启才能生效
4. **分散管理**：没有统一的配置中心，配置变更需要逐个服务修改和重启

**问题点**：
- 配置变更需要重启服务，影响可用性
- 配置散落在多处，难以统一管理和审计
- 缺少配置版本控制和回滚能力
- 多环境（dev/staging/prod）配置管理困难
- 无法实时调整限流阈值、缓存策略等运行时参数
- 配置变更缺少通知机制和审计日志

## 2. 目标

建立一个**统一的配置中心**，实现：
1. **集中管理**：所有微服务配置统一存储在 Redis + PostgreSQL 中
2. **热更新**：配置变更实时生效，无需重启服务
3. **版本控制**：配置变更历史追踪，支持一键回滚
4. **多环境支持**：dev/staging/prod 环境配置隔离
5. **审计日志**：记录谁在何时修改了什么配置
6. **实时推送**：配置变更通过 WebSocket 推送给相关服务
7. **降级保护**：配置中心不可用时，服务使用本地缓存配置继续运行

## 3. 范围

### 包含
- 配置中心核心模块（ConfigCenter.js）
- 配置存储层（Redis + PostgreSQL）
- 配置变更通知机制（EventBus + WebSocket）
- 管理 API（CRUD + 版本管理）
- 本地配置缓存与降级
- 前端管理界面（admin-dashboard）
- Prometheus 监控指标
- 单元测试（30+ 测试用例）

### 不包含
- 密钥管理（应使用 K8s Secrets 或 Vault）
- 服务发现（已有 K8s Service）
- 日志聚合（已有 ELK 栈）

## 4. 详细需求

### 4.1 配置存储结构

```javascript
// PostgreSQL 配置表
CREATE TABLE config_entries (
  key VARCHAR(255) PRIMARY KEY,
  value JSONB NOT NULL,
  environment VARCHAR(50) NOT NULL, -- dev/staging/prod
  service VARCHAR(100), -- null 表示全局配置
  description TEXT,
  is_secret BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id),
  version INTEGER DEFAULT 1
);

CREATE TABLE config_history (
  id SERIAL PRIMARY KEY,
  key VARCHAR(255) NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  environment VARCHAR(50) NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_at TIMESTAMP DEFAULT NOW(),
  change_reason TEXT,
  version INTEGER NOT NULL
);

CREATE INDEX idx_config_env_service ON config_entries(environment, service);
CREATE INDEX idx_config_history_key ON config_history(key, environment);
```

### 4.2 核心模块设计

```javascript
// backend/shared/config/ConfigCenter.js
class ConfigCenter {
  constructor() {
    this.cache = new Map();      // 本地缓存
    this.watchers = new Map();   // 监听器
    this.redis = null;           // Redis 客户端
    this.db = null;              // PostgreSQL 连接
    this.environment = process.env.NODE_ENV || 'development';
    this.serviceName = process.env.SERVICE_NAME || 'unknown';
    this.isConnected = false;
    this.pollInterval = 30000;   // 轮询间隔
  }

  // 获取配置值（支持嵌套路径，如 'cache.ttl.short'）
  async get(key, defaultValue = null) {
    // 1. 先查本地缓存
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    // 2. 从 Redis 读取
    const redisValue = await this.redis.get(`config:${this.environment}:${key}`);
    if (redisValue) {
      const value = JSON.parse(redisValue);
      this.cache.set(key, value);
      return value;
    }

    // 3. 从 PostgreSQL 读取（降级）
    const dbValue = await this.db.query(
      'SELECT value FROM config_entries WHERE key = $1 AND environment = $2',
      [key, this.environment]
    );
    
    if (dbValue.rows.length > 0) {
      const value = dbValue.rows[0].value;
      this.cache.set(key, value);
      return value;
    }

    return defaultValue;
  }

  // 批量获取配置
  async getAll(prefix = '') {
    const keys = await this.redis.keys(`config:${this.environment}:${prefix}*`);
    const values = await this.redis.mget(keys);
    const config = {};
    
    keys.forEach((key, i) => {
      const configKey = key.replace(`config:${this.environment}:`, '');
      config[configKey] = JSON.parse(values[i]);
    });
    
    return config;
  }

  // 设置配置值
  async set(key, value, options = {}) {
    const { reason, userId, isSecret = false } = options;
    
    // 1. 获取旧值
    const oldValue = await this.get(key);
    
    // 2. 写入 PostgreSQL（持久化）
    await this.db.query(`
      INSERT INTO config_entries (key, value, environment, service, description, is_secret, updated_by, version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
      ON CONFLICT (key) DO UPDATE SET
        value = $2,
        updated_by = $7,
        updated_at = NOW(),
        version = config_entries.version + 1
    `, [key, JSON.stringify(value), this.environment, this.serviceName, options.description, isSecret, userId]);
    
    // 3. 写入 Redis（快速读取）
    await this.redis.set(
      `config:${this.environment}:${key}`,
      JSON.stringify(value),
      'EX',
      options.ttl || 86400
    );
    
    // 4. 记录历史
    await this.db.query(`
      INSERT INTO config_history (key, old_value, new_value, environment, changed_by, change_reason, version)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [key, JSON.stringify(oldValue), JSON.stringify(value), this.environment, userId, reason, 1]);
    
    // 5. 发布变更通知
    await this.publishChange(key, value, oldValue);
    
    // 6. 更新本地缓存
    this.cache.set(key, value);
    
    // 7. 更新指标
    metrics.incrementCounter('config_update_count', 1, { key });
  }

  // 监听配置变更
  watch(key, callback) {
    if (!this.watchers.has(key)) {
      this.watchers.set(key, new Set());
    }
    this.watchers.get(key).add(callback);
    
    // 返回取消监听函数
    return () => {
      this.watchers.get(key).delete(callback);
      if (this.watchers.get(key).size === 0) {
        this.watchers.delete(key);
      }
    };
  }

  // 发布配置变更
  async publishChange(key, newValue, oldValue) {
    // 1. 通知本地监听器
    if (this.watchers.has(key)) {
      for (const callback of this.watchers.get(key)) {
        try {
          await callback(newValue, oldValue, key);
        } catch (err) {
          this.logger.error({ err, key }, 'Config watcher callback failed');
        }
      }
    }

    // 2. 通过 EventBus 广播
    const EventBus = require('../EventBus');
    await EventBus.publish('config.changed', {
      key,
      newValue,
      oldValue,
      environment: this.environment,
      timestamp: new Date().toISOString()
    });

    // 3. 通过 Redis Pub/Sub 通知其他实例
    await this.redis.publish('config:updates', JSON.stringify({
      key,
      environment: this.environment
    }));
  }

  // 回滚配置
  async rollback(key, version) {
    const history = await this.db.query(`
      SELECT old_value, new_value FROM config_history
      WHERE key = $1 AND environment = $2 AND version = $3
    `, [key, this.environment, version]);
    
    if (history.rows.length === 0) {
      throw new Error(`Config version ${version} not found for key ${key}`);
    }
    
    await this.set(key, history.rows[0].old_value, {
      reason: `Rollback to version ${version}`
    });
  }

  // 初始化配置中心
  async initialize() {
    // 1. 连接 Redis 和 PostgreSQL
    this.redis = getRedisClient();
    this.db = getDbConnection();
    
    // 2. 加载所有配置到本地缓存
    const configs = await this.getAll();
    for (const [key, value] of Object.entries(configs)) {
      this.cache.set(key, value);
    }
    
    // 3. 订阅配置变更
    this.redis.subscribe('config:updates', (message) => {
      const { key, environment } = JSON.parse(message);
      if (environment === this.environment) {
        this.refreshKey(key);
      }
    });
    
    // 4. 启动轮询（防止 Pub/Sub 消息丢失）
    this.startPolling();
    
    this.isConnected = true;
    this.logger.info('ConfigCenter initialized');
  }
}
```

### 4.3 管理 API

```javascript
// backend/gateway/src/routes/config.js

// GET /api/config - 获取所有配置
router.get('/', async (req, res) => {
  const { environment, service, prefix } = req.query;
  const configs = await configCenter.getAll(prefix);
  res.json({ success: true, data: configs });
});

// GET /api/config/:key - 获取单个配置
router.get('/:key', async (req, res) => {
  const value = await configCenter.get(req.params.key);
  res.json({ success: true, data: value });
});

// PUT /api/config/:key - 更新配置
router.put('/:key', requireAdmin, async (req, res) => {
  const { value, reason, isSecret } = req.body;
  await configCenter.set(req.params.key, value, {
    reason,
    userId: req.user.id,
    isSecret
  });
  res.json({ success: true });
});

// GET /api/config/:key/history - 获取配置历史
router.get('/:key/history', async (req, res) => {
  const history = await configCenter.getHistory(req.params.key);
  res.json({ success: true, data: history });
});

// POST /api/config/:key/rollback - 回滚配置
router.post('/:key/rollback', requireAdmin, async (req, res) => {
  const { version } = req.body;
  await configCenter.rollback(req.params.key, version);
  res.json({ success: true });
});
```

### 4.4 使用示例

```javascript
// 在服务中使用配置中心
const config = new ConfigCenter();

// 初始化
await config.initialize();

// 获取配置
const cacheTTL = await config.get('cache.ttl.short', 300);
const rateLimit = await config.get('gateway.rateLimit', { windowMs: 60000, max: 100 });

// 监听配置变更（热更新）
config.watch('gateway.rateLimit', (newValue, oldValue) => {
  console.log('Rate limit updated:', newValue);
  app.set('rateLimit', newValue);
});

// 设置配置
await config.set('cache.ttl.short', 600, {
  reason: '延长缓存时间以减少数据库压力',
  userId: adminUserId
});
```

### 4.5 常见配置项

```yaml
# 全局配置示例
cache:
  ttl:
    short: 300      # 短缓存（5分钟）
    medium: 3600    # 中等缓存（1小时）
    long: 86400     # 长缓存（1天）

gateway:
  rateLimit:
    windowMs: 60000
    max: 100
  cors:
    origins: ["https://minego.app"]
  compression:
    threshold: 1024

services:
  timeout: 30000
  retryAttempts: 3

database:
  pool:
    min: 10
    max: 50

redis:
  prefix: "minego:"
```

## 5. 验收标准

- [ ] 配置中心核心模块实现完成（ConfigCenter.js，20+ 方法）
- [ ] PostgreSQL 数据库迁移文件创建（3 张表）
- [ ] 管理 API 实现（7 个端点）
- [ ] 本地配置缓存机制实现
- [ ] 配置变更实时推送（EventBus + Redis Pub/Sub）
- [ ] 配置监听器（watch）机制实现
- [ ] 配置版本控制与回滚功能
- [ ] 多环境支持（dev/staging/prod）
- [ ] 降级保护（配置中心不可用时使用缓存）
- [ ] Prometheus 指标集成（5 个指标）
- [ ] 单元测试覆盖（30+ 测试用例，覆盖率 90%+）
- [ ] 在至少 3 个服务中集成配置中心
- [ ] 配置变更审计日志
- [ ] API 文档和集成文档

## 6. 工作量估算

**L** - 该需求涉及多个组件，包括：
- 核心模块开发（ConfigCenter.js，约 500 行）
- 数据库设计（3 张表，迁移文件）
- 管理 API 开发（7 个端点）
- 通知机制实现（EventBus + Redis Pub/Sub）
- 单元测试编写（30+ 测试）
- 文档编写

预计工作量：2-3 天

## 7. 优先级理由

**P1 优先级**，理由如下：
1. **基础能力**：配置中心是微服务架构的核心基础设施
2. **提升运维效率**：配置变更无需重启服务，减少停机时间
3. **增强可观测性**：配置变更有审计日志，便于问题排查
4. **支持 A/B 测试**：通过动态配置可以快速调整功能开关
5. **依赖关系**：后续的限流优化、缓存策略优化等都需要动态配置支持
