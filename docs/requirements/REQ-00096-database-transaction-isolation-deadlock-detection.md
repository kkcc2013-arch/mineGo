# REQ-00096：数据库事务隔离级别控制与死锁检测机制

- **编号**：REQ-00096
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：in_progress
- **涉及服务/模块**：backend/shared/db.js、catch-service、gym-service、payment-service、social-service
- **创建时间**：2026-06-11 00:20
- **依赖需求**：REQ-00007（数据库迁移管理）

## 1. 背景与问题

当前 mineGo 项目的数据库事务实现存在以下问题：

1. **事务隔离级别固定**：`transaction()` 函数使用默认的 `READ COMMITTED` 隔离级别，无法根据业务场景选择合适的隔离级别
2. **缺少死锁检测**：高并发场景下（道馆战斗、精灵捕捉、交易系统）可能出现死锁，但系统缺乏自动检测和重试机制
3. **长事务风险**：某些复杂操作（如批量精灵进化、跨服务数据同步）可能产生长事务，占用连接池资源
4. **缺少事务超时控制**：当前事务没有超时限制，可能导致连接池耗尽

经代码审查，`backend/shared/db.js` 的 `transaction()` 函数仅支持简单的 `BEGIN/COMMIT/ROLLBACK`，没有隔离级别配置和死锁处理逻辑。

## 2. 目标

1. 支持可配置的事务隔离级别（READ COMMITTED、REPEATABLE READ、SERIALIZABLE）
2. 实现自动死锁检测与智能重试机制
3. 添加事务超时控制，防止长事务占用连接
4. 提供事务监控指标（死锁次数、重试次数、平均事务时长）

## 3. 范围

### 包含

- 扩展 `transaction()` 函数支持隔离级别配置
- 实现死锁检测与自动重试逻辑
- 添加事务超时机制
- Prometheus 指标监控
- 单元测试覆盖

### 不包含

- 分布式事务（需要 Saga 模式或两阶段提交）
- 跨数据库事务

## 4. 详细需求

### 4.1 事务隔离级别配置

```javascript
// backend/shared/db.js 扩展

const ISOLATION_LEVELS = {
  'READ COMMITTED': 'READ COMMITTED',
  'REPEATABLE READ': 'REPEATABLE READ',
  'SERIALIZABLE': 'SERIALIZABLE'
};

/**
 * Execute a database transaction with configurable isolation level
 * @param {Function} fn - Transaction callback
 * @param {Object} options - Transaction options
 * @param {string} options.isolationLevel - Isolation level
 * @param {number} options.timeout - Timeout in milliseconds
 * @param {number} options.retryOnDeadlock - Whether to retry on deadlock
 * @param {number} options.maxRetries - Maximum retry attempts
 */
async function transaction(fn, options = {}) {
  const {
    isolationLevel = 'READ COMMITTED',
    timeout = 30000, // 30 seconds default
    retryOnDeadlock = true,
    maxRetries = 3
  } = options;

  let retries = 0;
  
  while (retries <= maxRetries) {
    try {
      return await executeTransaction(fn, isolationLevel, timeout);
    } catch (err) {
      if (isDeadlockError(err) && retryOnDeadlock && retries < maxRetries) {
        retries++;
        deadlockRetriesTotal.inc({ service: serviceName });
        await sleep(100 * retries); // Exponential backoff
        continue;
      }
      throw err;
    }
  }
}

async function executeTransaction(fn, isolationLevel, timeout) {
  const client = await pool.connect();
  const startTime = Date.now();
  
  // Set transaction timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Transaction timeout')), timeout);
  });

  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    
    const result = await Promise.race([
      fn(client),
      timeoutPromise
    ]);
    
    await client.query('COMMIT');
    transactionDuration.observe({ service: serviceName }, Date.now() - startTime);
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

### 4.2 死锁检测

```javascript
// backend/shared/deadlockDetector.js

/**
 * Check if error is a PostgreSQL deadlock error
 */
function isDeadlockError(error) {
  // PostgreSQL error codes:
  // 40P01: deadlock_detected
  // 40001: serialization_failure
  return error.code === '40P01' || error.code === '40001';
}

/**
 * Extract lock information from deadlock error
 */
function parseDeadlockDetail(error) {
  if (!error.detail) return null;
  
  // Parse PostgreSQL deadlock detail message
  // Example: "Process 12345 waits for ShareLock on transaction 1234; blocked by process 67890."
  const processMatch = error.detail.match(/Process (\d+)/g);
  
  return {
    code: error.code,
    message: error.message,
    detail: error.detail,
    processes: processMatch?.map(p => parseInt(p.replace('Process ', ''))) || [],
    timestamp: Date.now()
  };
}

/**
 * Log deadlock for analysis
 */
async function logDeadlock(db, deadlockInfo, context) {
  await db.query(`
    INSERT INTO deadlock_log (code, message, detail, processes, context, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
  `, [
    deadlockInfo.code,
    deadlockInfo.message,
    deadlockInfo.detail,
    JSON.stringify(deadlockInfo.processes),
    JSON.stringify(context)
  ]);
}
```

### 4.3 事务监控指标

```javascript
// backend/shared/metrics.js 新增指标

const deadlockRetriesTotal = new Counter({
  name: 'db_deadlock_retries_total',
  help: 'Total number of transaction retries due to deadlocks',
  labelNames: ['service']
});

const transactionDuration = new Histogram({
  name: 'db_transaction_duration_seconds',
  help: 'Duration of database transactions in seconds',
  labelNames: ['service', 'isolation_level'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30]
});

const transactionTotal = new Counter({
  name: 'db_transactions_total',
  help: 'Total number of database transactions',
  labelNames: ['service', 'status'] // status: success, rollback, timeout
});

const activeTransactions = new Gauge({
  name: 'db_active_transactions',
  help: 'Number of currently active database transactions',
  labelNames: ['service']
});
```

### 4.4 数据库迁移

```sql
-- database/pending/20260611_002000__add_deadlock_log_table.sql

CREATE TABLE IF NOT EXISTS deadlock_log (
  id SERIAL PRIMARY KEY,
  code VARCHAR(10) NOT NULL,
  message TEXT,
  detail TEXT,
  processes JSONB,
  context JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_deadlock_log_created_at ON deadlock_log(created_at);
CREATE INDEX idx_deadlock_log_code ON deadlock_log(code);

-- Add comment
COMMENT ON TABLE deadlock_log IS 'Records deadlock events for analysis and debugging';
```

### 4.5 服务集成示例

```javascript
// gym-service 使用更高隔离级别
async function battleGym(gymId, pokemonIds) {
  return await transaction(async (client) => {
    // 使用 REPEATABLE READ 确保战斗期间数据一致性
    // ... battle logic
  }, { 
    isolationLevel: 'REPEATABLE READ',
    timeout: 10000 // 10 seconds for battle
  });
}

// payment-service 使用 SERIALIZABLE 确保支付一致性
async function processPayment(orderId) {
  return await transaction(async (client) => {
    // ... payment logic
  }, { 
    isolationLevel: 'SERIALIZABLE',
    timeout: 30000,
    retryOnDeadlock: true,
    maxRetries: 5
  });
}
```

## 5. 验收标准（可测试）

- [ ] `transaction()` 支持 3 种隔离级别配置
- [ ] 死锁发生时自动重试，最多重试 3 次
- [ ] 事务超时后自动回滚并释放连接
- [ ] Prometheus 指标正确记录死锁重试次数、事务时长
- [ ] deadlock_log 表正确记录死锁事件
- [ ] 单元测试覆盖核心逻辑（20+ 测试用例）
- [ ] 性能测试：事务吞吐量不下降超过 5%

## 6. 工作量估算

**M** - 需要扩展 db.js、添加死锁检测器、创建数据库表、编写测试

## 7. 优先级理由

数据库事务隔离级别控制是保证数据一致性的关键。在高并发场景下（道馆战斗、精灵交易、支付），不正确的事务隔离可能导致数据不一致、死锁频发，影响用户体验和系统稳定性。P1 优先级是因为这是系统稳定性的基础保障。


## 2026-10-15 实现复核与真实验收边界

撤回旧done声明；原7项标准和20+/最多3次/吞吐下降不超过5%阈值不改。
默认db.transaction和3种旧API统一真实核心：校验隔离级别、初始尝试后最多3次
真实40P01/40001重试、整体截止时间、失败回滚、迟到回调/连接保护、
COMMIT未知结果不重试、共享Prometheus指标和独立有界死锁日志事务。
现有分布式wait-graph检测器原接口保留；纯PostgreSQL辅助函数单独存放。

38个原事务单测已修正导入并接入主门禁。实际PostGIS存储套件22通过（含父用例），
包括双会话真实死锁、4次序列化失败/3次重试、历史表OID/数据/视图/FK、
阻塞日志超时、COMMIT断连和实际汇率服务经默认事务API调用。历史未知重试
次数/名称保持NULL，不补造。独立旧源码基线和当前源码同池/真实资源转账对比，
7轮配对吞吐中位变化+0.054927%，原-5%门禁通过；源码哈希及原始报告见
[事务说明](../TRANSACTIONS.md)。低并发本地比较不代替生产容量验收。

原85份pending SQL不改；修复采用绑定原始校验和的显式repair。完整迁移仍在
20260627_041000第14句round(double precision,integer)失败，整个pending事务回滚。
当前源码相关远程CI、完整迁移/升级/回滚及业务调用者端到端验收仍未完成，
保持in_progress，不将局部通过解释成全部需求完成。


### 同日远程性能实测及修正

确切bae401eb主CI454和真实事务存储通过；migration16 job116334922847
原吞吐门禁实测-5.624629685951888%，超过原5%上限，结果保留为失败。
不以早先本地通过覆盖CI失败，也不调整门槛/基线/工作负载。随后移除每次
成功事务不必要的Error栈构造和空队列Promise.all/race，保持全部真实
超时/回滚/重试/指标/COMMIT语义；实际事务22重复通过。本地确切新源码
原样配对基准-3.2443239972000937%通过，尚不能代表远程回归已经解决。
远程必须在新源码原门禁通过后才可验收。独立慢查询SQL修复使全链推进到
20260627_060000第13句is_deleted缺失并回滚；完整迁移/回滚仍未通过。


### 2026-10-16 单一操作截止信号

确切5864a4a主CI456/battle通过、真实事务正确性通过，但migration18
job116881319622吞吐再报-5.691201189980399%，原-5%门槛仍失败，报告
归档并保留失败。整体事务现在只与一个截止/连接错误信号竞速，逐个继续点
检查所有权，减少多重Promise竞速分配。原取消/回滚/迟到连接与回调保护/
不确定COMMIT/重试/指标/有界日志规则保持。新增真实未await查询成功与失败
两例，证实提交前等待在途SQL、失败不提交；当前存储24通过。

同基线/同工作负载/同原5%门禁，本地确切新源码配对吞吐中位+0.5400157583078435%
通过，新增实际运行环境信息（包括synchronous_commit=on），不改计时负载。
远程新源码通过仍待验证。独立慢查询门禁前置，完整迁移在之前门禁失败后
也执行以收集真实结果；任何失败仍令作业失败，不忽略任何验收。
