# REQ-00070：Redis 内存优化与自动 TTL 策略

- **编号**：REQ-00070
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：backend/shared/cache.js、backend/shared/redis.js、gateway、所有微服务
- **创建时间**：2026-06-09 23:00
- **依赖需求**：REQ-00031 (API 响应缓存层与缓存失效策略)

## 1. 背景与问题

当前 Redis 缓存系统存在以下问题：

1. **内存浪费严重**：部分缓存数据未设置 TTL，导致内存无限增长
   - `redis.js` 中 `setJSON()` 函数的 `ttlSec` 参数是可选的
   - 部分热点数据缓存没有合理的过期策略
   - 缓存预热系统 (REQ-00039) 可能产生大量未过期数据

2. **缺少内存监控**：
   - 没有 Redis 内存使用率监控指标
   - 无法识别内存泄漏或异常增长
   - 缺少内存使用告警

3. **TTL 配置分散**：
   - cacheConfig.js 中各路由的 TTL 硬编码分散
   - 缺少统一的 TTL 策略管理
   - 不同类型数据没有合理的过期时间分级

4. **缺少内存回收机制**：
   - 无主动清理机制
   - 依赖 Redis 被动的 LRU 淘汰策略
   - 可能影响生产环境性能

**业务影响**：
- Redis 内存使用率过高，增加云服务成本
- 内存碎片化导致性能下降
- 可能触发 OOM 导致服务不可用

## 2. 目标

1. **降低 Redis 内存使用 40%+**，通过合理的 TTL 策略和主动清理
2. **建立内存监控体系**，实时监控内存使用率和热点 Key
3. **统一 TTL 策略管理**，按数据类型分级设置过期时间
4. **实现内存优化自动化**，定期清理过期数据和内存碎片

## 3. 范围

- **包含**：
  - Redis 内存使用率 Prometheus 指标
  - 统一 TTL 策略配置管理
  - 内存使用分析和热点 Key 识别
  - 自动清理过期数据的定时任务
  - 内存告警规则
  - 优化缓存配置，强制 TTL 要求

- **不包含**：
  - Redis 集群扩容或分片
  - 缓存数据压缩（可作为后续优化）
  - Redis 配置调优（maxmemory-policy 等）

## 4. 详细需求

### 4.1 Redis 内存监控指标

新增以下 Prometheus 指标：

```javascript
// 内存使用指标
minego_redis_memory_used_bytes{service}       // 已使用内存
minego_redis_memory_max_bytes{service}         // 最大内存限制
minego_redis_memory_usage_percent{service}     // 内存使用率
minego_redis_memory_fragmentation_ratio{service} // 内存碎片率

// Key 统计指标
minego_redis_key_count{service, type}          // Key 数量（按类型）
minego_redis_expired_keys_total{service}       // 过期 Key 数量
minego_redis_evicted_keys_total{service}       // 淘汰 Key 数量

// TTL 分析指标
minego_redis_keys_without_ttl{service}         // 无 TTL 的 Key 数量
minego_redis_keys_ttl_seconds{service, bucket} // TTL 分布（按时间桶）
```

### 4.2 统一 TTL 策略配置

创建 `backend/shared/cacheTTLConfig.js`：

```javascript
const TTL_STRATEGY = {
  // 静态数据：很少变化
  POKEDEX: 86400,        // 24 小时
  SPECIES_DETAIL: 43200, // 12 小时
  SKILLS: 86400,         // 24 小时
  
  // 半静态数据：偶尔变化
  GYM_INFO: 1800,        // 30 分钟
  RAID_INFO: 300,        // 5 分钟
  EVENT_INFO: 600,       // 10 分钟
  
  // 用户数据：频繁变化
  USER_PROFILE: 300,     // 5 分钟
  USER_STATS: 300,       // 5 分钟
  USER_ITEMS: 180,       // 3 分钟
  FRIEND_LIST: 180,      // 3 分钟
  POKEMON_LIST: 120,     // 2 分钟
  
  // 动态数据：实时性要求高
  NEARBY_GYMS: 60,       // 1 分钟
  NEARBY_RAIDS: 30,      // 30 秒
  WILD_POKEMON: 60,      // 1 分钟
  
  // 会话数据
  JWT_BLACKLIST: 604800, // 7 天
  USER_SESSION: 86400,   // 24 小时
  DEVICE_FINGERPRINT: 2592000, // 30 天
  
  // 临时数据
  RATE_LIMIT: 3600,      // 1 小时
  CAPTCHA_TOKEN: 300,    // 5 分钟
  NOTIFICATION_QUEUE: 86400, // 24 小时
};

// TTL 时间桶分布（用于监控）
const TTL_BUCKETS = [
  0,           // 无 TTL
  60,          // < 1 分钟
  300,         // 1-5 分钟
  1800,        // 5-30 分钟
  3600,        // 30 分钟 - 1 小时
  86400,       // 1 小时 - 1 天
  604800,      // 1 天 - 1 周
  Infinity,    // > 1 周
];
```

### 4.3 强制 TTL 检查中间件

修改 `backend/shared/cache.js`：

```javascript
/**
 * 设置缓存 - 强制要求 TTL
 * @throws {Error} 如果未提供 TTL 则抛出错误
 */
async function set(key, value, ttl) {
  if (!ttl || ttl <= 0) {
    throw new Error(`Cache key "${key}" must have a valid TTL. Use forceSet() for no-TTL keys.`);
  }
  // ... 原有逻辑
}

/**
 * 强制设置缓存（无 TTL）- 仅用于特殊场景，需记录日志
 */
async function forceSet(key, value) {
  logger.warn({ key }, 'Setting cache without TTL - use with caution');
  // ... 设置缓存但不设置 TTL
}
```

### 4.4 内存分析工具

创建 `backend/shared/redisMemoryAnalyzer.js`：

```javascript
class RedisMemoryAnalyzer {
  /**
   * 分析 Redis 内存使用
   * @returns {Object} 内存分析报告
   */
  async analyze() {
    const info = await this.redis.info('memory');
    const stats = this.parseMemoryInfo(info);
    
    return {
      usedMemory: stats.used_memory,
      maxMemory: stats.maxmemory,
      usagePercent: (stats.used_memory / stats.maxmemory) * 100,
      fragmentationRatio: stats.mem_fragmentation_ratio,
      keysWithoutTTL: await this.countKeysWithoutTTL(),
      topKeys: await this.getTopKeys(20), // Top 20 内存占用 Key
      keyTypeDistribution: await this.getKeyTypeDistribution(),
    };
  }
  
  /**
   * 获取无 TTL 的 Key 数量
   */
  async countKeysWithoutTTL() {
    // 使用 SCAN 遍历检查 TTL
  }
  
  /**
   * 获取内存占用最高的 Key
   */
  async getTopKeys(limit) {
    // 使用 MEMORY USAGE 命令
  }
}
```

### 4.5 自动清理任务

创建 `backend/shared/redisCleanupTask.js`：

```javascript
class RedisCleanupTask {
  /**
   * 清理过期数据和内存碎片
   */
  async run() {
    const start = Date.now();
    
    // 1. 清理无 TTL 的可疑 Key（超过 7 天未访问）
    const cleanedKeys = await this.cleanStaleKeys();
    
    // 2. 触发内存碎片整理
    await this.defragment();
    
    // 3. 更新统计指标
    const duration = Date.now() - start;
    
    logger.info({
      cleanedKeys,
      duration,
    }, 'Redis cleanup completed');
    
    return { cleanedKeys, duration };
  }
  
  /**
   * 清理长时间未访问的无 TTL Key
   */
  async cleanStaleKeys() {
    // 扫描无 TTL 的 Key
    // 检查最后访问时间（OBJECT IDLETIME）
    // 删除超过阈值（7 天）的 Key
  }
}
```

### 4.6 告警规则

更新 `infrastructure/k8s/monitoring/prometheus-rules.yml`：

```yaml
# Redis 内存告警
- alert: RedisMemoryHigh
  expr: minego_redis_memory_usage_percent > 80
  for: 5m
  labels:
    severity: warning
    priority: P1
  annotations:
    summary: "Redis 内存使用率过高"
    description: "{{ $labels.service }} Redis 内存使用率 {{ $value }}%，建议清理或扩容"

- alert: RedisMemoryCritical
  expr: minego_redis_memory_usage_percent > 90
  for: 2m
  labels:
    severity: critical
    priority: P0
  annotations:
    summary: "Redis 内存即将耗尽"
    description: "{{ $labels.service }} Redis 内存使用率 {{ $value }}%，可能触发 OOM"

- alert: RedisKeysWithoutTTL
  expr: minego_redis_keys_without_ttl > 1000
  for: 10m
  labels:
    severity: warning
    priority: P1
  annotations:
    summary: "大量 Key 未设置 TTL"
    description: "{{ $labels.service }} 有 {{ $value }} 个 Key 未设置 TTL，可能导致内存泄漏"

- alert: RedisMemoryFragmentation
  expr: minego_redis_memory_fragmentation_ratio > 1.5
  for: 15m
  labels:
    severity: warning
    priority: P2
  annotations:
    summary: "Redis 内存碎片率过高"
    description: "内存碎片率 {{ $value }}，建议执行 MEMORY PURGE 或重启 Redis"
```

## 5. 验收标准（可测试）

- [ ] 新增 10+ Prometheus 指标监控 Redis 内存使用
- [ ] 创建统一的 TTL 策略配置文件，定义 15+ 数据类型的 TTL
- [ ] 修改 `cache.set()` 强制要求 TTL，单元测试覆盖率 100%
- [ ] 实现内存分析工具，支持 Top N Key 分析
- [ ] 实现自动清理任务，每日定时执行
- [ ] 新增 4 个 Prometheus 告警规则
- [ ] 在测试环境验证 Redis 内存使用降低 40%+
- [ ] 更新相关文档，说明 TTL 策略最佳实践

## 6. 工作量估算

**L (Large)** - 需要修改核心缓存模块，新增监控指标、分析工具、清理任务和告警规则，涉及多个服务和配置文件。

## 7. 优先级理由

**P1 理由**：
1. Redis 内存优化直接影响云服务成本，预计每月可节省 20-30% 的 Redis 实例费用
2. 内存泄漏风险可能导致生产环境服务不可用，属于稳定性和可用性保障
3. 与 REQ-00040（云成本监控）形成互补，完善成本控制体系
4. 为后续流量增长提供资源保障，避免内存瓶颈限制业务发展
