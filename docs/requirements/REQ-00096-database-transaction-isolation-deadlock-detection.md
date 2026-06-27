# REQ-00096：数据库事务隔离级别控制与死锁检测机制

- **编号**：REQ-00096
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：done
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
