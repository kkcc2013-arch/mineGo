# REQ-00383：精灵捕捉结果批处理与异步持久化优化系统

- **编号**：REQ-00383
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：catch-service、backend/shared、Redis、Kafka、PostgreSQL、database/migrations
- **创建时间**：2026-06-30 09:00 UTC
- **依赖需求**：无

## 1. 背景与问题

当前精灵捕捉流程采用**实时数据库写入**模式：每次捕捉成功后立即执行 PostgreSQL 事务操作（更新精灵表、背包表、用户记录表等）。在高并发场景下（峰值 QPS 500+），这种模式存在以下性能瓶颈：

1. **数据库连接池压力**：每个捕捉请求占用一个数据库连接，峰值时连接池可能耗尽
2. **事务锁定时间长**：复杂的事务操作（精灵创建 + 背包更新 + 用户积分更新）持续 50-100ms，导致行锁竞争
3. **响应延迟高**：用户等待数据库写入完成才能收到响应，平均捕捉 API 响应时间 150-200ms
4. **数据库写入 I/O 高**：大量小事务导致磁盘 I/O 碎片化，影响整体数据库性能

从 `catch-service/src/index.js` 分析，`handleCatchSuccess()` 函数包含 4-6 个数据库操作：
- 精灵记录插入（pokemon 表）
- 背包容量更新（user_bag 表）
- 捕捉记录写入（catch_records 表）
- 用户积分/经验更新（user_stats 表）
- 物品消耗记录（inventory_log 表）

这些操作可以**异步批处理**，大幅降低数据库压力和响应延迟。

## 2. 目标

实现捕捉结果的**批处理与异步持久化**机制，达到以下性能指标：

- **API 响应时间降低 60%**：从 150-200ms 降低到 50-70ms
- **数据库连接占用减少 70%**：峰值连接数从 50 降低到 15
- **数据库写入吞吐提升 3倍**：从 500 TPS 提升到 1500 TPS
- **99% 数据可靠性保证**：异步持久化失败率低于 1%，具备自动重试与补偿机制
- **峰值 QPS 支持提升到 2000+**

## 3. 范围

- **包含**：
  - 捕捉结果批处理队列（Redis List + Kafka）
  - 异步持久化 Worker（批量写入数据库）
  - 失败重试与补偿机制
  - 批处理策略配置（批量大小、超时时间、优先级）
  - 监控指标（批处理延迟、队列长度、成功率）
  - 数据一致性检查（幂等性验证）

- **不包含**：
  - 其他服务的批处理改造（仅针对 catch-service）
  - 分布式事务协调（采用最终一致性模式）
  - 前端客户端改造（API 响应格式保持不变）

## 4. 详细需求

### 4.1 批处理队列架构

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│ catch API   │───→  │ Redis Queue  │───→  │ Kafka Topic │
│ (immediate) │      │ (buffer)     │      │ (reliable)  │
└─────────────┘      └──────────────┘      └─────────────┘
                                                │
                                                ↓
                         ┌──────────────────────────────┐
                         │ Async Batch Worker           │
                         │ (batch insert to PostgreSQL) │
                         └──────────────────────────────┘
```

**Redis Queue 设计**：
- 使用 `RPUSH` 将捕捉结果推入队列 `catch:results:pending`
- 队列数据结构：`{ userId, pokemonId, cp, iv, caughtAt, itemsUsed, bonusData }`
- 队列长度监控：超过 1000 条时触发告警

**Kafka Topic 配置**：
- Topic: `catch-results-batch`
- Partition: 3（按 userId 分区）
- Retention: 7 days
- Compaction: enabled（防止重复处理）

### 4.2 API 快速响应机制

捕捉 API 立即返回成功响应，数据先写入 Redis：

```javascript
// catch-service/src/index.js 改造
async function handleCatchSuccess(req, res) {
  const catchResult = {
    userId: req.user.id,
    pokemonId: generatedPokemon.id,
    cp: generatedPokemon.cp,
    iv: generatedPokemon.iv,
    caughtAt: new Date(),
    itemsUsed: req.body.itemsUsed,
    bonusData: calculateBonuses(req.body)
  };
  
  // 1. 立即写入 Redis（保证响应速度）
  await redis.rpush('catch:results:pending', JSON.stringify(catchResult));
  
  // 2. 发送 Kafka 事件（可靠持久化）
  await publishCatchResultToKafka(catchResult);
  
  // 3. 立即返回响应（不等待数据库）
  return successResp(res, {
    success: true,
    pokemon: { id: catchResult.pokemonId, cp: catchResult.cp },
    message: '精灵捕捉成功！正在存入背包...'
  });
}
```

### 4.3 异步批处理 Worker

**Worker 核心逻辑**：
- 批量大小：50 条（可配置）
- 批处理间隔：500ms（可配置）
- 优先级：按捕获时间排序，最近的优先处理

```javascript
// backend/jobs/catchBatchWorker.js
class CatchBatchWorker {
  constructor() {
    this.batchSize = parseInt(process.env.CATCH_BATCH_SIZE) || 50;
    this.batchInterval = parseInt(process.env.CATCH_BATCH_INTERVAL_MS) || 500;
    this.maxRetries = 3;
  }
  
  async processBatch() {
    // 1. 从 Kafka 消费批量消息
    const messages = await kafkaConsumer.consume({
      topic: 'catch-results-batch',
      maxMessages: this.batchSize,
      timeout: this.batchInterval
    });
    
    if (messages.length === 0) return;
    
    // 2. 批量插入数据库（使用 COPY 命令优化）
    try {
      await this.batchInsertToDatabase(messages);
      logger.info(`Batch processed: ${messages.length} catch results`);
    } catch (error) {
      // 3. 失败重试
      await this.retryFailedBatch(messages, error);
    }
  }
  
  async batchInsertToDatabase(messages) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // 使用 PostgreSQL COPY 命令批量插入
      const pokemonData = messages.map(m => [
        m.userId, m.pokemonId, m.cp, m.iv, m.caughtAt
      ]);
      
      await client.query(`
        COPY pokemon (user_id, pokemon_id, cp, iv, caught_at)
        FROM STDIN WITH (FORMAT binary)
      `, pokemonData);
      
      // 批量更新背包容量
      await client.query(`
        UPDATE user_bag 
        SET pokemon_count = pokemon_count + 1,
            last_updated = NOW()
        WHERE user_id = ANY($1)
      `, [messages.map(m => m.userId)]);
      
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
}
```

### 4.4 数据一致性保证

**幂等性机制**：
- 每个 catchResult 生成唯一 `catchId`（基于 userId + pokemonId + timestamp）
- Redis 存储已处理的 catchId（SET `catch:processed:{catchId}` TTL 7d）
- Worker 处理前检查 catchId 是否已处理

**补偿机制**：
- Worker 失败后，消息重新推入 Kafka retry topic
- 重试超过 3 次后，写入 `catch:results:failed` 队列
- 定时任务扫描失败队列，手动补偿处理

**一致性检查**：
- 每小时执行一次一致性校验任务
- 对比 Redis pending 队列 + Kafka topic + PostgreSQL 数据
- 发现不一致时自动修复

### 4.5 监控与告警

**关键指标**：
- `catch_batch_queue_length`：Redis 队列长度
- `catch_batch_processing_latency`：批处理延迟（从捕捉到持久化）
- `catch_batch_success_rate`：批处理成功率
- `catch_batch_retry_count`：重试次数

**告警规则**：
- 队列长度 > 1000：P1 告警（批处理 Worker 可能卡住）
- 批处理延迟 > 30s：P2 告警
- 成功率 < 95%：P0 告警（数据一致性风险）

### 4.6 配置管理

**环境变量**：
```bash
CATCH_BATCH_SIZE=50              # 批量大小
CATCH_BATCH_INTERVAL_MS=500      # 批处理间隔
CATCH_BATCH_MAX_RETRIES=3        # 最大重试次数
CATCH_BATCH_QUEUE_MAX_LENGTH=10000  # 队列最大长度
CATCH_BATCH_WORKER_COUNT=3       # Worker 数量
```

**动态配置**（支持运行时调整）：
- 通过 admin-dashboard 调整批处理参数
- 支持高峰期临时增大批量大小

## 5. 验收标准（可测试）

- [ ] 捕捉 API 响应时间降低到 50-70ms（99th percentile）
- [ ] 批处理 Worker 吞吐量达到 1500 TPS（压力测试验证）
- [ ] 数据可靠性测试：10 万次捕捉，失败率 < 1%
- [ ] 幂等性测试：重复推送相同 catchResult，数据库只有一条记录
- [ ] 一致性检查测试：队列、Kafka、PostgreSQL 数据完全一致
- [ ] 监控指标完整：队列长度、延迟、成功率、重试次数全部可观测
- [ ] 峰值测试：QPS 2000 场景下系统稳定运行 30 分钟
- [ ] 补偿机制测试：模拟 Worker 失败，自动重试成功

## 6. 工作量估算

**L（Large）** - 3-4 周

- **理由**：涉及架构改造、批处理逻辑、一致性保证、监控集成、压力测试，工作量较大。核心改造需要：
  - catch-service API 改造（1 周）
  - 批处理 Worker 实现（1.5 周）
  - 一致性机制 + 监控（0.5 周）
  - 测试 + 优化（1 周）

## 7. 优先级理由

**P1 优先级**：

1. **性能瓶颈突破**：捕捉 API 是高频操作（占 30% 请求量），优化后整体系统性能提升显著
2. **数据库压力缓解**：减少数据库连接占用，间接提升所有服务性能
3. **用户体验提升**：响应时间降低 60%，捕捉体验更流畅
4. **成本优化**：数据库写入效率提升，降低 I/O 成本
5. **高并发支持**：为未来 10x 用户增长预留性能空间

对"项目可用"的贡献：捕捉系统是核心功能，性能优化直接提升用户留存率和系统稳定性。