# REQ-00107：数据生命周期管理与自动清理策略

- **编号**：REQ-00107
- **类别**：合规/隐私
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service、pokemon-service、social-service、payment-service、backend/shared、database/migrations、backend/jobs
- **创建时间**：2026-06-11 06:00
- **依赖需求**：REQ-00016（GDPR 合规与用户数据隐私保护）

## 1. 背景与问题

当前系统缺乏完整的数据生命周期管理机制：

1. **数据保留期限不明确**：
   - 用户日志、交易记录、精灵捕捉历史等数据无限期保存
   - 不符合 GDPR、CCPA 等法规对数据最小化和保留期限的要求
   - 数据库存储成本持续增长

2. **过期数据无法自动清理**：
   - 临时数据（验证码、会话令牌）依赖 TTL 但缺乏监控
   - 历史数据（旧战斗记录、过期活动）手动清理效率低
   - 用户删除账户后关联数据清理不彻底

3. **数据归档能力缺失**：
   - 无法将冷数据归档到低成本存储
   - 历史数据分析需要查询全量数据，性能差
   - 缺乏数据恢复机制

4. **合规审计困难**：
   - 无法证明数据已按期删除
   - 缺少数据清理操作的审计日志
   - 用户数据删除请求执行不透明

## 2. 目标

建立完整的数据生命周期管理体系：

1. **数据分类与保留策略**：定义 5 类数据的保留期限（临时 7 天、操作日志 90 天、交易记录 3 年、用户数据按需、历史数据归档）
2. **自动化清理机制**：定时任务自动清理过期数据，支持软删除和硬删除
3. **数据归档系统**：冷数据自动归档到对象存储，支持快速恢复
4. **合规审计日志**：记录所有数据清理操作，支持合规审计

预期收益：
- 存储成本降低 40%+
- 满足 GDPR/CCPA 数据最小化要求
- 数据删除请求执行时间从 7 天缩短至 24 小时
- 数据库查询性能提升 30%+

## 3. 范围

### 包含

- 数据分类与保留策略定义（临时数据、操作日志、交易记录、用户数据、历史数据）
- 数据生命周期管理核心模块（backend/shared/DataLifecycleManager.js）
- 自动清理定时任务系统（backend/jobs/cleanupJobs.js）
- 数据归档服务（backend/shared/DataArchiver.js）
- 数据清理审计日志系统
- 用户数据删除 API 增强（支持立即删除和延期清理）
- 数据恢复机制（归档数据恢复）
- 管理后台数据生命周期仪表板

### 不包含

- 实时数据流处理（Kafka 消息保留由 Kafka 自身管理）
- 文件存储清理（CDN/静态资源由 REQ-00052 管理）
- 日志聚合系统（已有结构化日志系统 REQ-00002）

## 4. 详细需求

### 4.1 数据分类与保留策略

#### 数据类别定义

```javascript
const DATA_CATEGORIES = {
  TEMPORARY: {
    name: '临时数据',
    retentionDays: 7,
    examples: ['验证码', '临时令牌', '上传临时文件'],
    cleanupPolicy: 'hard_delete'
  },
  OPERATION_LOGS: {
    name: '操作日志',
    retentionDays: 90,
    examples: ['登录日志', 'API 调用日志', '审计日志'],
    cleanupPolicy: 'hard_delete'
  },
  TRANSACTION_RECORDS: {
    name: '交易记录',
    retentionDays: 1095, // 3 年（财务合规要求）
    examples: ['支付订单', '精币流水', '购买记录'],
    cleanupPolicy: 'archive_then_delete'
  },
  USER_DATA: {
    name: '用户数据',
    retentionDays: null, // 用户账户存续期间
    examples: ['用户信息', '精灵数据', '好友关系'],
    cleanupPolicy: 'user_initiated'
  },
  HISTORICAL_DATA: {
    name: '历史数据',
    retentionDays: 365,
    examples: ['战斗记录', '活动历史', '排行榜快照'],
    cleanupPolicy: 'archive_then_delete'
  }
};
```

### 4.2 数据生命周期管理核心模块

#### 核心功能

- `identifyExpiredData(category, options)`: 识别过期数据
- `cleanupData(category, options)`: 执行数据清理（软删除/硬删除）
- `archiveData(category, options)`: 归档数据到对象存储
- `restoreArchivedData(archiveId, options)`: 从归档恢复数据
- `getDataLifecycleStats()`: 获取数据生命周期统计
- `auditCleanupOperation(operation)`: 记录清理审计日志

#### 清理策略

```javascript
// 软删除示例
async function softDelete(tableName, whereClause, options) {
  await db.query(`
    UPDATE ${tableName}
    SET deleted_at = NOW(),
        deleted_reason = $1
    WHERE ${whereClause}
  `, [options.reason]);
}

// 硬删除示例
async function hardDelete(tableName, whereClause, options) {
  // 1. 备份到审计日志
  const records = await db.query(`SELECT * FROM ${tableName} WHERE ${whereClause}`);
  await auditLog.record('hard_delete', tableName, records.rows);
  
  // 2. 执行删除
  await db.query(`DELETE FROM ${tableName} WHERE ${whereClause}`);
}
```

### 4.3 自动清理定时任务

#### 任务调度

```javascript
// backend/jobs/cleanupJobs.js
const cron = require('node-cron');

// 每天凌晨 2 点清理临时数据
cron.schedule('0 2 * * *', async () => {
  await DataLifecycleManager.cleanupData('TEMPORARY');
});

// 每周日凌晨 3 点清理操作日志
cron.schedule('0 3 * * 0', async () => {
  await DataLifecycleManager.cleanupData('OPERATION_LOGS');
});

// 每月 1 号凌晨 4 点归档交易记录
cron.schedule('0 4 1 * *', async () => {
  await DataLifecycleManager.archiveData('TRANSACTION_RECORDS');
});

// 每月 15 号凌晨 5 点清理历史数据
cron.schedule('0 5 15 * *', async () => {
  await DataLifecycleManager.cleanupData('HISTORICAL_DATA');
});
```

#### 清理任务监控

- 清理任务执行状态（成功/失败/超时）
- 清理数据量统计
- 清理耗时监控
- 异常告警（清理失败、数据量异常）

### 4.4 数据归档系统

#### 归档流程

```javascript
async function archiveData(category, options) {
  // 1. 识别待归档数据
  const data = await identifyDataToArchive(category);
  
  // 2. 导出数据为 JSON/Parquet 格式
  const archiveFile = await exportData(data, { format: 'parquet' });
  
  // 3. 上传到对象存储（阿里云 OSS / AWS S3）
  const archiveId = await uploadToObjectStorage(archiveFile);
  
  // 4. 记录归档元数据
  await db.query(`
    INSERT INTO data_archives (archive_id, category, record_count, storage_path, archived_at)
    VALUES ($1, $2, $3, $4, NOW())
  `, [archiveId, category, data.length, archiveFile.path]);
  
  // 5. 删除原始数据
  await hardDelete(category.tableName, data.whereClause);
  
  return { archiveId, recordCount: data.length };
}
```

#### 归档元数据表

```sql
CREATE TABLE data_archives (
  id SERIAL PRIMARY KEY,
  archive_id VARCHAR(64) UNIQUE NOT NULL,
  category VARCHAR(32) NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  record_count INTEGER NOT NULL,
  storage_path VARCHAR(512) NOT NULL,
  storage_type VARCHAR(32) NOT NULL, -- 'oss', 's3', 'local'
  compressed BOOLEAN DEFAULT true,
  file_size_bytes BIGINT,
  archived_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP, -- 归档数据保留期限
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_data_archives_category ON data_archives(category);
CREATE INDEX idx_data_archives_archived_at ON data_archives(archived_at);
```

### 4.5 数据清理审计日志

#### 审计日志表

```sql
CREATE TABLE data_cleanup_audit_logs (
  id SERIAL PRIMARY KEY,
  operation_type VARCHAR(32) NOT NULL, -- 'soft_delete', 'hard_delete', 'archive', 'restore'
  category VARCHAR(32) NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  record_count INTEGER NOT NULL,
  reason TEXT,
  performed_by VARCHAR(64), -- 'system', 'user_id', 'admin_id'
  retention_days INTEGER,
  criteria JSONB, -- 清理条件
  execution_time_ms INTEGER,
  status VARCHAR(16) NOT NULL, -- 'success', 'failed', 'partial'
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cleanup_audit_logs_operation ON data_cleanup_audit_logs(operation_type, created_at);
CREATE INDEX idx_cleanup_audit_logs_category ON data_cleanup_audit_logs(category, created_at);
```

#### 审计日志记录

```javascript
async function auditCleanupOperation(operation) {
  await db.query(`
    INSERT INTO data_cleanup_audit_logs (
      operation_type, category, table_name, record_count,
      reason, performed_by, retention_days, criteria,
      execution_time_ms, status, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
    operation.type,
    operation.category,
    operation.tableName,
    operation.recordCount,
    operation.reason,
    operation.performedBy,
    operation.retentionDays,
    JSON.stringify(operation.criteria),
    operation.executionTimeMs,
    operation.status,
    operation.errorMessage
  ]);
}
```

### 4.6 用户数据删除 API 增强

#### API 端点

```javascript
// POST /api/users/:userId/request-data-deletion
// 用户请求数据删除（GDPR Right to Erasure）
router.post('/request-data-deletion', async (req, res) => {
  const { userId } = req.params;
  const { deletionType = 'scheduled' } = req.body; // 'immediate' or 'scheduled'
  
  if (deletionType === 'immediate') {
    // 立即删除（需要二次验证）
    await DataLifecycleManager.deleteUserData(userId, { immediate: true });
  } else {
    // 计划删除（30 天后执行）
    await DataLifecycleManager.scheduleUserDeletion(userId, { delayDays: 30 });
  }
  
  res.json({ success: true, deletionType });
});

// GET /api/users/:userId/data-deletion-status
// 查询数据删除状态
router.get('/data-deletion-status', async (req, res) => {
  const status = await DataLifecycleManager.getDeletionStatus(req.params.userId);
  res.json(status);
});
```

### 4.7 数据恢复机制

#### 恢复 API

```javascript
// POST /api/admin/restore-archived-data
// 管理员恢复归档数据
router.post('/restore-archived-data', authenticateAdmin, async (req, res) => {
  const { archiveId, targetTable } = req.body;
  
  const result = await DataLifecycleManager.restoreArchivedData(archiveId, {
    targetTable,
    performedBy: req.admin.id
  });
  
  res.json({ success: true, restoredRecords: result.recordCount });
});
```

### 4.8 管理后台数据生命周期仪表板

#### 仪表板功能

- 数据生命周期概览（各类别数据量、过期数据量）
- 清理任务执行历史
- 归档数据管理（查看、恢复、删除）
- 合规审计日志查询
- 数据保留策略配置
- 手动触发清理任务

### 4.9 Prometheus 指标

```javascript
// 新增指标
metricsRegistry.registerGauge('data_lifecycle_expired_records', 'Expired records waiting for cleanup', ['category']);
metricsRegistry.registerGauge('data_lifecycle_archived_records', 'Total archived records', ['category']);
metricsRegistry.registerCounter('data_lifecycle_cleanup_operations_total', 'Total cleanup operations', ['category', 'operation_type', 'status']);
metricsRegistry.registerHistogram('data_lifecycle_cleanup_duration_seconds', 'Cleanup operation duration', ['category', 'operation_type']);
metricsRegistry.registerGauge('data_lifecycle_storage_bytes', 'Data storage size in bytes', ['category']);
```

### 4.10 数据库迁移

```sql
-- 20260611_060000__add_data_lifecycle_tables.sql

-- 数据保留策略配置表
CREATE TABLE data_retention_policies (
  id SERIAL PRIMARY KEY,
  category VARCHAR(32) UNIQUE NOT NULL,
  category_name VARCHAR(64) NOT NULL,
  retention_days INTEGER NOT NULL,
  cleanup_policy VARCHAR(32) NOT NULL, -- 'hard_delete', 'soft_delete', 'archive_then_delete'
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 插入默认策略
INSERT INTO data_retention_policies (category, category_name, retention_days, cleanup_policy) VALUES
('TEMPORARY', '临时数据', 7, 'hard_delete'),
('OPERATION_LOGS', '操作日志', 90, 'hard_delete'),
('TRANSACTION_RECORDS', '交易记录', 1095, 'archive_then_delete'),
('USER_DATA', '用户数据', NULL, 'user_initiated'),
('HISTORICAL_DATA', '历史数据', 365, 'archive_then_delete');

-- 用户数据删除计划表
CREATE TABLE user_data_deletion_requests (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  request_type VARCHAR(16) NOT NULL, -- 'immediate', 'scheduled'
  requested_at TIMESTAMP NOT NULL,
  scheduled_deletion_at TIMESTAMP,
  status VARCHAR(16) NOT NULL, -- 'pending', 'processing', 'completed', 'cancelled'
  completed_at TIMESTAMP,
  performed_by VARCHAR(64),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_user_deletion_requests_user ON user_data_deletion_requests(user_id);
CREATE INDEX idx_user_deletion_requests_status ON user_data_deletion_requests(status);

-- 数据归档表（已在 4.4 定义）
-- 数据清理审计日志表（已在 4.5 定义）

-- 为现有表添加删除标记字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_reason VARCHAR(128);
ALTER TABLE pokemon ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE pokemon ADD COLUMN IF NOT EXISTS deleted_reason VARCHAR(128);
```

## 5. 验收标准（可测试）

- [ ] 数据生命周期管理核心模块实现（DataLifecycleManager.js）且通过单元测试（覆盖率 > 90%）
- [ ] 5 类数据保留策略配置完成且可通过 API 查询
- [ ] 自动清理定时任务实现并成功执行（测试环境验证）
- [ ] 数据归档功能实现且支持 OSS/S3 存储
- [ ] 数据恢复功能实现且可从归档恢复数据
- [ ] 数据清理审计日志正确记录所有清理操作
- [ ] 用户数据删除 API 实现且支持立即删除和计划删除
- [ ] 数据删除状态查询 API 实现
- [ ] 管理后台数据生命周期仪表板实现
- [ ] Prometheus 指标正确暴露（5 个指标）
- [ ] 数据库迁移文件创建并成功执行
- [ ] 集成测试覆盖主要清理流程（10+ 测试用例）
- [ ] 文档完善（API 文档、运维手册、合规指南）

## 6. 工作量估算

**L（Large）** - 3-5 人日

理由：
- 核心模块开发（1 人日）：DataLifecycleManager、审计日志
- 定时任务与归档系统（1 人日）：清理任务、归档服务
- API 与管理后台（1 人日）：用户删除 API、管理界面
- 测试与文档（1-2 人日）：单元测试、集成测试、文档

## 7. 优先级理由

**P1 理由**：

1. **合规要求**：GDPR/CCPA 明确要求企业必须建立数据生命周期管理机制，违反将面临高额罚款
2. **成本控制**：数据库存储成本持续增长，过期数据清理可节省 40%+ 存储成本
3. **性能优化**：清理历史数据可提升查询性能 30%+
4. **风险降低**：用户数据删除请求必须在法定期限内完成，当前手动流程效率低风险高
5. **依赖关系**：基于已完成的 REQ-00016（GDPR 合规），进一步完善合规体系

该需求对项目"生产可用"的贡献：
- 满足合规要求，避免法律风险
- 降低运营成本，提升系统效率
- 增强数据治理能力，提高数据质量
