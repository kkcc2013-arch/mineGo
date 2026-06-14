# REQ-00096：数据库事务隔离级别控制与死锁检测机制

- **编号**：REQ-00096
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/db.js、catch-service、gym-service、payment-service、social-service
- **创建时间**：2026-06-11 00:20
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目的数据库事务管理存在以下问题：

1. **缺乏隔离级别控制**：所有事务默认使用 READ COMMITTED 隔离级别，无法针对不同业务场景选择合适的隔离级别
2. **死锁检测缺失**：PostgreSQL 死锁检测依赖超时机制（默认 1s），无法主动预防和快速响应
3. **缺乏死锁监控**：死锁事件未记录到日志和监控系统，难以分析和优化
4. **无重试机制**：事务失败后直接抛出错误，无法自动重试死锁导致的失败
5. **缺乏锁等待监控**：无法监控长时间锁等待，可能导致性能瓶颈

现有代码分析：
- `backend/shared/db.js` 只提供基础的 `query()` 和 `transaction()` 函数
- 所有服务使用相同的事务配置
- 无死锁检测和重试逻辑

## 2. 目标

建立完善的数据库事务隔离级别控制和死锁检测机制：

1. **支持多隔离级别**：READ COMMITTED、REPEATABLE READ、SERIALIZABLE
2. **主动死锁检测**：监控 PostgreSQL 死锁日志，触发告警
3. **自动重试机制**：死锁失败后自动重试，最多 3 次
4. **锁等待监控**：监控长时间锁等待，预警潜在死锁
5. **指标收集**：收集事务成功率、死锁次数、锁等待时间等指标

## 3. 范围

### 包含

- 实现事务隔离级别控制（可配置）
- 实现死锁检测和自动重试
- 实现锁等待监控
- 添加 Prometheus 指标
- 更现有服务的关键事务
- 编写单元测试

### 不包含

- 分布式事务支持（其他需求）
- 数据库读写分离（其他需求）

## 4. 详细需求

### 4.1 事务隔离级别控制

扩展 `backend/shared/db.js`：

```javascript
// 隔离级别常量
const IsolationLevel = {
  READ_COMMITTED: 'READ COMMITTED',
  REPEATABLE_READ: 'REPEATABLE READ',
  SERIALIZABLE: 'SERIALIZABLE',
};

// 支持隔离级别的 transaction 函数
async function transactionWithIsolation(callback, options = {}) {
  const isolationLevel = options.isolationLevel || IsolationLevel.READ_COMMITTED;
  const maxRetries = options.maxRetries || 3;
  const retryDelay = options.retryDelay || 100;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await transaction(async (client) => {
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
        return callback(client);
      });
    } catch (err) {
      if (isDeadlockError(err) && attempt < maxRetries) {
        logger.warn({ attempt, err }, 'Deadlock detected, retrying transaction');
        await sleep(retryDelay * attempt);
        metrics.transactionRetries.inc({ isolation_level: isolationLevel });
      } else {
        throw err;
      }
    }
  }
}
```

### 4.2 死锁检测函数

```javascript
function isDeadlockError(err) {
  // PostgreSQL 死锁错误码: 40P01
  return err.code === '40P01' || 
         err.message?.includes('deadlock detected') ||
         err.message?.includes('could not obtain lock');
}
```

### 4.3 锁等待监控

查询 PostgreSQL `pg_locks` 和 `pg_stat_activity`：

```javascript
async function getLockWaitInfo() {
  const result = await query(`
    SELECT 
      blocked.pid AS blocked_pid,
      blocked.query AS blocked_query,
      blocking.pid AS blocking_pid,
      blocking.query AS blocking_query,
      EXTRACT(EPOCH FROM (now() - blocked.query_start)) AS wait_seconds
    FROM pg_stat_activity blocked
    JOIN pg_locks blocked_locks ON blocked.pid = blocked_locks.pid
    JOIN pg_locks blocking_locks ON blocked_locks.locktype = blocking_locks.locktype
      AND blocked_locks.database IS NOT DISTINCT FROM blocking_locks.database
      AND blocked_locks.relation IS NOT DISTINCT FROM blocking_locks.relation
      AND blocked_locks.page IS NOT DISTINCT FROM blocking_locks.page
      AND blocked_locks.tuple IS NOT DISTINCT FROM blocking_locks.tuple
      AND blocked_locks.pid != blocking_locks.pid
    JOIN pg_stat_activity blocking ON blocking_locks.pid = blocking.pid
    WHERE NOT blocked_locks.granted
    ORDER BY wait_seconds DESC
  `);
  return result.rows;
}
```

### 4.4 Prometheus 指标

```javascript
const metrics = {
  transactionStarted: new Counter({
    name: 'db_transaction_started_total',
    help: 'Total number of transactions started',
    labelNames: ['isolation_level', 'service'],
  }),
  transactionCompleted: new Counter({
    name: 'db_transaction_completed_total',
    help: 'Total number of transactions completed successfully',
    labelNames: ['isolation_level', 'service'],
  }),
  transactionFailed: new Counter({
    name: 'db_transaction_failed_total',
    help: 'Total number of transactions failed',
    labelNames: ['isolation_level', 'service', 'error_type'],
  }),
  transactionRetries: new Counter({
    name: 'db_transaction_retries_total',
    help: 'Total number of transaction retries due to deadlock',
    labelNames: ['isolation_level', 'service'],
  }),
  lockWaitDuration: new Histogram({
    name: 'db_lock_wait_duration_seconds',
    help: 'Lock wait duration in seconds',
    labelNames: ['service'],
    buckets: [0.1, 0.5, 1, 2, 5, 10],
  }),
};
```

### 4.5 服务更新示例

**catch-service（捕捉精灵）**：
- 使用 SERIALIZABLE 隔离级别（防止并发捕捉同一精灵）
- 启用死锁重试

**gym-service（道馆战斗）**：
- 使用 REPEATABLE READ 隔离级别（防止道馆状态不一致）
- 启用死锁重试

**payment-service（支付）**：
- 使用 SERIALIZABLE 隔离级别（防止余额不一致）
- 启用死锁重试

**social-service（精灵交易）**：
- 使用 SERIALIZABLE 隔离级别（防止交易状态不一致）
- 启用死锁重试

## 5. 验收标准（可测试）

- [ ] `transactionWithIsolation()` 函数支持三种隔离级别
- [ ] 死锁错误自动识别并重试
- [ ] Prometheus 指标正确记录事务成功、失败、重试
- [ ] 锁等待监控函数返回正确的阻塞信息
- [ ] catch-service 使用 SERIALIZABLE 隔离级别
- [ ] payment-service 使用 SERIALIZABLE 隔离级别
- [ ] 单元测试覆盖所有核心函数
- [ ] 集成测试验证死锁重试机制
- [ ] 文档说明各服务的隔离级别选择

## 6. 工作量估算

**M（Medium）**

理由：
- 扩展 db.js（2-3小时）
- 更新服务代码（1-2小时）
- 编写测试（2-3小时）
- 总计约 6-8小时

## 7. 优先级理由

**P1**（高优先级）

1. **数据一致性关键**：事务隔离级别直接影响数据一致性，特别是支付和捕捉场景
2. **生产稳定性**：死锁可能导致服务中断，需要快速响应和恢复
3. **可观测性增强**：监控锁等待有助于发现性能瓶颈
4. **符合数据库治理最佳实践**：是生产级系统的必备功能