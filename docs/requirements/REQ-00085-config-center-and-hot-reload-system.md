# REQ-00085：配置中心与动态配置热更新系统

- **编号**：REQ-00085
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared、Redis、infrastructure/k8s
- **创建时间**：2026-06-10 09:00
- **依赖需求**：REQ-00014（服务熔断与降级机制）、REQ-00031（API 响应缓存层）

## 1. 背景与问题

当前系统的配置管理存在以下技术债：

1. **配置分散**：各服务的配置散落在环境变量、`.env` 文件、K8s ConfigMap 中，缺乏统一管理入口
2. **热更新缺失**：修改配置需要重启服务，无法动态调整熔断阈值、限流参数、缓存 TTL 等运行时配置
3. **配置漂移风险**：不同环境（dev/staging/prod）的配置差异难以追踪，容易出现配置不一致问题
4. **审计能力薄弱**：配置变更缺乏审计日志，无法追溯谁在何时修改了什么配置
5. **配置版本控制缺失**：无法回滚到历史配置版本

## 2. 目标

构建统一的配置中心系统：
- 集中管理所有微服务的配置项
- 支持配置热更新，无需重启服务
- 配置变更审计与版本控制
- 多环境配置隔离与继承
- 配置变更通知与订阅机制

## 3. 范围

### 包含
- 配置中心核心模块（ConfigCenter）
- 配置存储（Redis + PostgreSQL）
- 配置热更新机制
- 配置版本控制与回滚
- 配置变更审计日志
- 配置管理 API

### 不包含
- 前端配置管理界面（后续需求）
- 配置加密存储（安全需求单独处理）

## 4. 详细需求

### 4.1 配置存储结构

```javascript
// Redis 配置存储结构
const configStructure = {
  // 按服务和环境存储配置
  'config:prod:gateway': {
    rateLimit: { windowMs: 60000, max: 200 },
    circuitBreaker: { failureThreshold: 5, timeout: 60000 },
    cache: { defaultTTL: 300, maxSize: 10000 },
    degradation: { cpuThreshold: 85, memoryThreshold: 90 }
  },
  
  // 配置版本历史
  'config:history:gateway': [
    { version: 1, config: {...}, changedBy: 'admin', changedAt: '2026-06-10T08:00:00Z' },
    { version: 2, config: {...}, changedBy: 'system', changedAt: '2026-06-10T09:00:00Z' }
  ],
  
  // 配置订阅者列表
  'config:subscribers:gateway': ['instance-1', 'instance-2', 'instance-3']
};
```

### 4.2 配置中心核心实现

```javascript
// backend/shared/ConfigCenter.js
class ConfigCenter {
  constructor(options = {}) {
    this.redis = options.redis;
    this.db = options.db;
    this.serviceName = options.serviceName;
    this.environment = process.env.NODE_ENV || 'development';
    this.localConfig = {};
    this.configVersion = 0;
    this.watchers = new Map();
    
    // 初始化时加载配置
    this.initialize();
  }
  
  /**
   * 获取配置项
   */
  async get(key, defaultValue = null) {
    // 先检查本地缓存
    if (this.localConfig[key] !== undefined) {
      return this.localConfig[key];
    }
    
    // 从 Redis 获取
    const redisKey = `config:${this.environment}:${this.serviceName}`;
    const config = await this.redis.hget(redisKey, key);
    
    if (config !== null) {
      const value = JSON.parse(config);
      this.localConfig[key] = value;
      return value;
    }
    
    return defaultValue;
  }
  
  /**
   * 设置配置项
   */
  async set(key, value, changedBy = 'system') {
    const redisKey = `config:${this.environment}:${this.serviceName}`;
    
    // 保存新配置
    await this.redis.hset(redisKey, key, JSON.stringify(value));
    
    // 记录版本历史
    await this.recordConfigChange(key, value, changedBy);
    
    // 通知订阅者
    await this.notifySubscribers(key, value);
    
    // 更新本地缓存
    this.localConfig[key] = value;
    
    return true;
  }
  
  /**
   * 批量更新配置
   */
  async updateConfig(newConfig, changedBy = 'system') {
    const redisKey = `config:${this.environment}:${this.serviceName}`;
    const pipeline = this.redis.pipeline();
    
    for (const [key, value] of Object.entries(newConfig)) {
      pipeline.hset(redisKey, key, JSON.stringify(value));
    }
    
    await pipeline.exec();
    
    // 记录变更
    await this.recordBatchChange(newConfig, changedBy);
    
    // 通知订阅者
    await this.notifySubscribers(null, newConfig);
    
    // 更新本地缓存
    Object.assign(this.localConfig, newConfig);
    
    return true;
  }
  
  /**
   * 订阅配置变更
   */
  subscribe(key, callback) {
    if (!this.watchers.has(key)) {
      this.watchers.set(key, new Set());
    }
    this.watchers.get(key).add(callback);
    
    // 返回取消订阅函数
    return () => {
      this.watchers.get(key)?.delete(callback);
    };
  }
  
  /**
   * 处理配置变更通知
   */
  async handleConfigUpdate(key, value) {
    // 更新本地缓存
    this.localConfig[key] = value;
    
    // 触发订阅回调
    const callbacks = this.watchers.get(key) || this.watchers.get('*');
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          await callback(key, value);
        } catch (err) {
          console.error('Config callback error:', err);
        }
      }
    }
  }
  
  /**
   * 回滚到指定版本
   */
  async rollback(targetVersion, changedBy = 'system') {
    const historyKey = `config:history:${this.serviceName}`;
    const history = await this.redis.lrange(historyKey, 0, -1);
    
    const targetConfig = history
      .map(h => JSON.parse(h))
      .find(h => h.version === targetVersion);
    
    if (!targetConfig) {
      throw new Error(`Config version ${targetVersion} not found`);
    }
    
    await this.updateConfig(targetConfig.config, changedBy);
    return true;
  }
}
```

### 4.3 配置管理 API

```javascript
// backend/gateway/src/routes/config.js
router.get('/config/:service', adminOnly, async (req, res) => {
  const { service } = req.params;
  const config = await configCenter.getServiceConfig(service);
  res.json({ success: true, data: config });
});

router.put('/config/:service', adminOnly, async (req, res) => {
  const { service } = req.params;
  const { config, reason } = req.body;
  await configCenter.updateServiceConfig(service, config, req.user.id, reason);
  res.json({ success: true });
});

router.get('/config/:service/history', adminOnly, async (req, res) => {
  const { service } = req.params;
  const history = await configCenter.getConfigHistory(service);
  res.json({ success: true, data: history });
});

router.post('/config/:service/rollback', adminOnly, async (req, res) => {
  const { service } = req.params;
  const { version, reason } = req.body;
  await configCenter.rollbackConfig(service, version, req.user.id, reason);
  res.json({ success: true });
});
```

## 5. 验收标准（可测试）

- [ ] 配置可通过 API 动态更新，无需重启服务
- [ ] 配置变更在 5 秒内同步到所有服务实例
- [ ] 配置变更记录审计日志，包含操作人、时间、变更内容
- [ ] 支持配置版本历史查询，保留最近 100 个版本
- [ ] 支持配置回滚到任意历史版本
- [ ] 多环境配置隔离（dev/staging/prod）
- [ ] 配置订阅机制正常工作，变更通知准确送达
- [ ] 配置获取性能 < 10ms（Redis 缓存命中）
- [ ] 单元测试覆盖率 ≥ 85%

## 6. 工作量估算

**L**（Large）
- 配置中心核心模块开发（2天）
- 配置管理 API 与权限控制（1天）
- 配置变更通知机制（1天）
- 测试与文档（1天）

## 7. 优先级理由

配置管理是系统可维护性的基础设施。当前配置分散、热更新缺失导致运维效率低下，且无法快速响应线上问题（如调整限流阈值需要重启服务）。统一的配置中心可以显著提升运维效率和系统可观测性。
