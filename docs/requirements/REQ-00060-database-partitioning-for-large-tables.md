# REQ-00060：数据库分区表与大数据量表分区策略

- **编号**：REQ-00060
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：database/migrations、所有微服务、backend/shared、PostgreSQL
- **创建时间**：2026-06-09 18:05
- **依赖需求**：REQ-00007（数据库迁移管理）

## 1. 背景与问题

mineGo 项目已运行一段时间，随着用户增长，以下表数据量急剧增长：

1. **catch_records**：每次精灵捕捉产生一条记录，日增量约 100 万条
2. **location_updates**：用户位置更新频繁，日增量约 500 万条
3. **audit_logs**：审计日志持续累积，日增量约 50 万条
4. **event_logs**：事件日志表，日增量约 200 万条
5. **payment_transactions**：支付记录持续增长

当前问题：
- 单表查询性能下降，索引维护成本高
- 大表 DDL 操作（如添加索引）耗时过长，影响服务可用性
- 历史数据查询慢，但删除更慢
- 备份时间随数据量线性增长
- 无法按时间范围快速清理历史数据

PostgreSQL 原生支持表分区（Partitioning），可以将大表按时间或范围拆分为多个物理分区，显著提升查询性能和管理效率。

## 2. 目标

1. 为高增长表实现时间分区策略，单分区数据量控制在 1000 万条以内
2. 分区表查询性能提升 50%+（时间范围查询）
3. 支持自动分区创建和旧分区归档/删除
4. 减少索引维护开销，提升写入性能
5. 支持分区级别的备份和恢复

## 3. 范围

- **包含**：
  - 5 个高增长表的分区改造（catch_records、location_updates、audit_logs、event_logs、payment_transactions）
  - 自动分区管理服务
  - 分区归档和清理策略
  - 分区监控指标
  - 迁移脚本和回滚方案

- **不包含**：
  - 其他小表分区（暂无必要）
  - 跨分区查询优化（后续需求）
  - 分区键变更（需全量迁移，风险高）

## 4. 详细需求

### 4.1 分区策略设计

| 表名 | 分区键 | 分区类型 | 分区粒度 | 保留策略 |
|------|--------|----------|----------|----------|
| catch_records | created_at | RANGE | 月分区 | 保留 12 个月，归档 12-24 个月 |
| location_updates | created_at | RANGE | 日分区 | 保留 30 天，归档 31-90 天 |
| audit_logs | created_at | RANGE | 月分区 | 保留 24 个月，归档 24-36 个月 |
| event_logs | created_at | RANGE | 周分区 | 保留 90 天，归档 91-180 天 |
| payment_transactions | created_at | RANGE | 月分区 | 永久保留 |

### 4.2 分区表创建示例

```sql
-- catch_records 分区表改造
-- 1. 创建新的分区父表
CREATE TABLE catch_records_partitioned (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    pokemon_id UUID NOT NULL,
    location GEOMETRY(Point, 4326) NOT NULL,
    catch_method VARCHAR(50),
    ball_type VARCHAR(50),
    catch_rate DECIMAL(5, 4),
    experience_gained INTEGER,
    stardust_gained INTEGER,
    candy_gained INTEGER,
    device_info JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 2. 创建初始分区（当前月和未来 3 个月）
CREATE TABLE catch_records_2026_06 
    PARTITION OF catch_records_partitioned
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE catch_records_2026_07 
    PARTITION OF catch_records_partitioned
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- 3. 创建分区索引（每个分区自动继承）
CREATE INDEX idx_catch_records_user ON catch_records_partitioned (user_id, created_at);
CREATE INDEX idx_catch_records_pokemon ON catch_records_partitioned (pokemon_id, created_at);
CREATE INDEX idx_catch_records_location ON catch_records_partitioned USING GIST (location);

-- 4. 数据迁移（分批迁移，避免锁表）
INSERT INTO catch_records_partitioned 
SELECT * FROM catch_records 
WHERE created_at >= '2026-06-01' AND created_at < '2026-07-01';

-- 5. 重命名替换
ALTER TABLE catch_records RENAME TO catch_records_old;
ALTER TABLE catch_records_partitioned RENAME TO catch_records;
```

### 4.3 自动分区管理服务

```javascript
// backend/shared/partitionManager.js

const db = require('./db');
const { logger, metrics } = require('./index');

class PartitionManager {
  constructor() {
    this.partitionConfigs = {
      catch_records: {
        granularity: 'monthly',
        retentionMonths: 12,
        archiveMonths: 12,
        primaryKey: 'id'
      },
      location_updates: {
        granularity: 'daily',
        retentionDays: 30,
        archiveDays: 60,
        primaryKey: 'id'
      },
      audit_logs: {
        granularity: 'monthly',
        retentionMonths: 24,
        archiveMonths: 12,
        primaryKey: 'id'
      },
      event_logs: {
        granularity: 'weekly',
        retentionWeeks: 13,  // ~90 days
        archiveWeeks: 13,
        primaryKey: 'id'
      },
      payment_transactions: {
        granularity: 'monthly',
        retentionMonths: null,  // 永久保留
        primaryKey: 'id'
      }
    };
  }

  /**
   * 确保未来分区存在
   * @param {string} tableName - 表名
   * @param {number} aheadCount - 提前创建的分区数量
   */
  async ensureFuturePartitions(tableName, aheadCount = 3) {
    const config = this.partitionConfigs[tableName];
    if (!config) {
      throw new Error(`Unknown table: ${tableName}`);
    }

    const created = [];
    
    for (let i = 0; i < aheadCount; i++) {
      const partition = this.calculatePartition(config.granularity, i);
      
      try {
        await this.createPartition(tableName, partition);
        created.push(partition.name);
        logger.info('Partition created', { table: tableName, partition: partition.name });
      } catch (error) {
        if (error.code === '42P07') {  // 分区已存在
          continue;
        }
        throw error;
      }
    }
    
    return created;
  }

  /**
   * 计算分区信息
   */
  calculatePartition(granularity, offset) {
    const now = new Date();
    let start, end, name;
    
    switch (granularity) {
      case 'monthly':
        start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
        name = `${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}`;
        break;
        
      case 'daily':
        start = new Date(now);
        start.setDate(start.getDate() + offset);
        start.setHours(0, 0, 0, 0);
        end = new Date(start);
        end.setDate(end.getDate() + 1);
        name = `${start.getFullYear()}_${String(start.getMonth() + 1).padStart(2, '0')}_${String(start.getDate()).padStart(2, '0')}`;
        break;
        
      case 'weekly':
        const dayOfWeek = now.getDay();
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - dayOfWeek + (offset * 7));
        weekStart.setHours(0, 0, 0, 0);
        start = weekStart;
        end = new Date(start);
        end.setDate(end.getDate() + 7);
        const weekNum = Math.ceil((start.getDate() + new Date(start.getFullYear(), start.getMonth(), 1).getDay()) / 7);
        name = `${start.getFullYear()}_w${String(weekNum).padStart(2, '0')}`;
        break;
    }
    
    return { start, end, name };
  }

  /**
   * 创建分区
   */
  async createPartition(tableName, partition) {
    const partitionName = `${tableName}_${partition.name}`;
    
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${partitionName}
      PARTITION OF ${tableName}
      FOR VALUES FROM ($1) TO ($2)
    `, [partition.start, partition.end]);
    
    metrics.increment('partition.created', { table: tableName });
  }

  /**
   * 归档旧分区
   */
  async archiveOldPartitions(tableName) {
    const config = this.partitionConfigs[tableName];
    if (!config || !config.archiveMonths) {
      return [];
    }

    const archived = [];
    const cutoffDate = this.calculateCutoffDate(config);
    
    // 获取所有分区
    const partitions = await this.listPartitions(tableName);
    
    for (const partition of partitions) {
      if (partition.end < cutoffDate) {
        await this.archivePartition(tableName, partition);
        archived.push(partition.name);
        logger.info('Partition archived', { table: tableName, partition: partition.name });
      }
    }
    
    return archived;
  }

  /**
   * 归档分区到冷存储
   */
  async archivePartition(tableName, partition) {
    const partitionName = `${tableName}_${partition.name}`;
    const archiveName = `${tableName}_archive_${partition.name}`;
    
    // 1. 导出到归档存储（S3/冷存储）
    await this.exportToArchive(tableName, partition);
    
    // 2. 分离分区
    await db.query(`
      ALTER TABLE ${tableName} DETACH PARTITION ${partitionName}
    `);
    
    // 3. 重命名为归档表
    await db.query(`
      ALTER TABLE ${partitionName} RENAME TO ${archiveName}
    `);
    
    metrics.increment('partition.archived', { table: tableName });
  }

  /**
   * 删除过期分区
   */
  async dropExpiredPartitions(tableName) {
    const config = this.partitionConfigs[tableName];
    if (!config || config.retentionMonths === null) {
      return [];  // 永久保留
    }

    const dropped = [];
    const cutoffDate = this.calculateRetentionCutoff(config);
    const partitions = await this.listPartitions(tableName);
    
    for (const partition of partitions) {
      if (partition.end < cutoffDate) {
        const partitionName = `${tableName}_${partition.name}`;
        
        await db.query(`DROP TABLE IF EXISTS ${partitionName}`);
        dropped.push(partition.name);
        
        logger.info('Partition dropped', { table: tableName, partition: partition.name });
        metrics.increment('partition.dropped', { table: tableName });
      }
    }
    
    return dropped;
  }

  /**
   * 获取分区列表
   */
  async listPartitions(tableName) {
    const result = await db.query(`
      SELECT 
        pt.relname AS partition_name,
        pg_get_expr(pt.relpartbound, pt.oid) AS partition_bound
      FROM pg_class pc
      JOIN pg_inherits pi ON pc.oid = pi.inhparent
      JOIN pg_class pt ON pi.inhrelid = pt.oid
      WHERE pc.relname = $1
      ORDER BY pt.relname
    `, [tableName]);
    
    return result.rows.map(row => this.parsePartitionBound(row));
  }

  /**
   * 获取分区统计信息
   */
  async getPartitionStats(tableName) {
    const partitions = await this.listPartitions(tableName);
    const stats = [];
    
    for (const partition of partitions) {
      const partitionName = `${tableName}_${partition.name}`;
      
      const result = await db.query(`
        SELECT 
          pg_relation_size($1) AS table_size,
          (SELECT count(*) FROM ${partitionName}) AS row_count
      `, [partitionName]);
      
      stats.push({
        name: partition.name,
        start: partition.start,
        end: partition.end,
        sizeBytes: parseInt(result.rows[0].table_size),
        rowCount: parseInt(result.rows[0].row_count)
      });
    }
    
    return stats;
  }

  /**
   * 定时维护任务
   */
  async runMaintenance() {
    const results = {
      created: [],
      archived: [],
      dropped: []
    };
    
    for (const tableName of Object.keys(this.partitionConfigs)) {
      try {
        // 确保未来分区存在
        const created = await this.ensureFuturePartitions(tableName);
        results.created.push(...created.map(p => ({ table: tableName, partition: p })));
        
        // 归档旧分区
        const archived = await this.archiveOldPartitions(tableName);
        results.archived.push(...archived.map(p => ({ table: tableName, partition: p })));
        
        // 删除过期分区
        const dropped = await this.dropExpiredPartitions(tableName);
        results.dropped.push(...dropped.map(p => ({ table: tableName, partition: p })));
        
      } catch (error) {
        logger.error('Partition maintenance failed', {
          table: tableName,
          error: error.message
        });
      }
    }
    
    logger.info('Partition maintenance completed', results);
    return results;
  }
}

module.exports = new PartitionManager();
```

### 4.4 分区监控指标

```javascript
// 添加到 backend/shared/metrics.js

// 分区相关指标
metrics.register({
  name: 'partition_row_count',
  type: 'gauge',
  help: 'Number of rows in partition',
  labels: ['table', 'partition']
});

metrics.register({
  name: 'partition_size_bytes',
  type: 'gauge',
  help: 'Size of partition in bytes',
  labels: ['table', 'partition']
});

metrics.register({
  name: 'partition_created_total',
  type: 'counter',
  help: 'Total partitions created',
  labels: ['table']
});

metrics.register({
  name: 'partition_archived_total',
  type: 'counter',
  help: 'Total partitions archived',
  labels: ['table']
});

metrics.register({
  name: 'partition_dropped_total',
  type: 'counter',
  help: 'Total partitions dropped',
  labels: ['table']
});
```

### 4.5 迁移脚本

```javascript
// database/pending/20260609_180500__add_table_partitioning.sql

-- =====================================================
-- REQ-00060: 数据库分区表与大数据量表分区策略
-- =====================================================

-- 1. catch_records 分区改造
-- 创建分区父表
CREATE TABLE IF NOT EXISTS catch_records_partitioned (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    pokemon_id UUID NOT NULL,
    location GEOMETRY(Point, 4326) NOT NULL,
    catch_method VARCHAR(50),
    ball_type VARCHAR(50),
    catch_rate DECIMAL(5, 4),
    experience_gained INTEGER,
    stardust_gained INTEGER,
    candy_gained INTEGER,
    device_info JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_catch_records_user_partitioned 
    ON catch_records_partitioned (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_catch_records_pokemon_partitioned 
    ON catch_records_partitioned (pokemon_id, created_at);
CREATE INDEX IF NOT EXISTS idx_catch_records_location_partitioned 
    ON catch_records_partitioned USING GIST (location);

-- 2. location_updates 分区改造
CREATE TABLE IF NOT EXISTS location_updates_partitioned (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    location GEOMETRY(Point, 4326) NOT NULL,
    accuracy FLOAT,
    speed FLOAT,
    heading FLOAT,
    source VARCHAR(50),
    device_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_location_updates_user_partitioned 
    ON location_updates_partitioned (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_location_updates_location_partitioned 
    ON location_updates_partitioned USING GIST (location);

-- 3. audit_logs 分区改造
CREATE TABLE IF NOT EXISTS audit_logs_partitioned (
    id UUID NOT NULL,
    user_id UUID,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id VARCHAR(100),
    old_values JSONB,
    new_values JSONB,
    ip_address INET,
    user_agent TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_partitioned 
    ON audit_logs_partitioned (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_partitioned 
    ON audit_logs_partitioned (action, created_at);

-- 4. event_logs 分区改造
CREATE TABLE IF NOT EXISTS event_logs_partitioned (
    id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    event_source VARCHAR(50),
    payload JSONB,
    user_id UUID,
    session_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_event_logs_type_partitioned 
    ON event_logs_partitioned (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_event_logs_user_partitioned 
    ON event_logs_partitioned (user_id, created_at);

-- 5. payment_transactions 分区改造
CREATE TABLE IF NOT EXISTS payment_transactions_partitioned (
    id UUID NOT NULL,
    order_id VARCHAR(100) NOT NULL,
    user_id UUID NOT NULL,
    amount DECIMAL(20, 2) NOT NULL,
    currency CHAR(3) DEFAULT 'USD',
    status VARCHAR(50) NOT NULL,
    payment_method VARCHAR(50),
    provider VARCHAR(50),
    provider_transaction_id VARCHAR(200),
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_partitioned 
    ON payment_transactions_partitioned (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_partitioned 
    ON payment_transactions_partitioned (order_id, created_at);

-- 6. 分区管理函数
CREATE OR REPLACE FUNCTION create_partition_if_not_exists(
    parent_table TEXT,
    partition_name TEXT,
    start_date TIMESTAMP WITH TIME ZONE,
    end_date TIMESTAMP WITH TIME ZONE
) RETURNS VOID AS $$
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        partition_name, parent_table, start_date, end_date
    );
END;
$$ LANGUAGE plpgsql;

-- 7. 创建初始分区（2026年6月）
SELECT create_partition_if_not_exists(
    'catch_records_partitioned',
    'catch_records_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

SELECT create_partition_if_not_exists(
    'location_updates_partitioned',
    'location_updates_2026_06_01',
    '2026-06-01 00:00:00+00',
    '2026-06-02 00:00:00+00'
);

SELECT create_partition_if_not_exists(
    'audit_logs_partitioned',
    'audit_logs_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);

SELECT create_partition_if_not_exists(
    'event_logs_partitioned',
    'event_logs_2026_w01',
    '2026-06-01 00:00:00+00',
    '2026-06-08 00:00:00+00'
);

SELECT create_partition_if_not_exists(
    'payment_transactions_partitioned',
    'payment_transactions_2026_06',
    '2026-06-01 00:00:00+00',
    '2026-07-01 00:00:00+00'
);
```

### 4.6 单元测试

```javascript
// backend/tests/unit/partition-manager.test.js

const partitionManager = require('../../shared/partitionManager');
const db = require('../../shared/db');

jest.mock('../../shared/db');

describe('PartitionManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('calculatePartition', () => {
    it('should calculate monthly partition', () => {
      const result = partitionManager.calculatePartition('monthly', 0);
      expect(result.name).toMatch(/^\d{4}_\d{2}$/);
      expect(result.start).toBeInstanceOf(Date);
      expect(result.end).toBeInstanceOf(Date);
      expect(result.end > result.start).toBe(true);
    });

    it('should calculate daily partition', () => {
      const result = partitionManager.calculatePartition('daily', 0);
      expect(result.name).toMatch(/^\d{4}_\d{2}_\d{2}$/);
    });

    it('should calculate weekly partition', () => {
      const result = partitionManager.calculatePartition('weekly', 0);
      expect(result.name).toMatch(/^\d{4}_w\d{2}$/);
    });

    it('should calculate future partition with offset', () => {
      const current = partitionManager.calculatePartition('monthly', 0);
      const future = partitionManager.calculatePartition('monthly', 1);
      expect(future.start >= current.end).toBe(true);
    });
  });

  describe('ensureFuturePartitions', () => {
    it('should create future partitions', async () => {
      db.query.mockResolvedValue({ rows: [] });
      
      const created = await partitionManager.ensureFuturePartitions('catch_records', 2);
      
      expect(db.query).toHaveBeenCalled();
      expect(created.length).toBeGreaterThanOrEqual(0);
    });

    it('should skip existing partitions', async () => {
      db.query.mockRejectedValueOnce({ code: '42P07' });  // 已存在
      db.query.mockResolvedValue({ rows: [] });
      
      const created = await partitionManager.ensureFuturePartitions('catch_records', 1);
      
      expect(created).toBeDefined();
    });
  });

  describe('listPartitions', () => {
    it('should list all partitions', async () => {
      db.query.mockResolvedValue({
        rows: [
          { partition_name: 'catch_records_2026_06', partition_bound: '...' }
        ]
      });
      
      const partitions = await partitionManager.listPartitions('catch_records');
      
      expect(partitions).toBeInstanceOf(Array);
    });
  });

  describe('getPartitionStats', () => {
    it('should return partition statistics', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{ partition_name: 'catch_records_2026_06', partition_bound: '...' }] })
        .mockResolvedValue({ rows: [{ table_size: '1048576', row_count: '10000' }] });
      
      const stats = await partitionManager.getPartitionStats('catch_records');
      
      expect(stats).toBeInstanceOf(Array);
      expect(stats[0]).toHaveProperty('name');
      expect(stats[0]).toHaveProperty('sizeBytes');
      expect(stats[0]).toHaveProperty('rowCount');
    });
  });
});
```

## 5. 验收标准（可测试）

- [ ] 5 个高增长表成功转换为分区表，数据完整性验证通过
- [ ] 分区表查询性能提升 50%+（时间范围查询对比测试）
- [ ] 自动分区管理服务能正确创建未来 3 个月分区
- [ ] 分区归档功能正常，归档数据可恢复
- [ ] 分区删除功能正常，过期数据自动清理
- [ ] 分区监控指标正常上报（Prometheus）
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 迁移脚本可回滚，不影响服务可用性
- [ ] 分区统计 API 可查询各分区大小和行数

## 6. 工作量估算

**L（Large）**：涉及 5 个核心表的分区改造，需要：
- 分区表设计和创建（2-3 天）
- 数据迁移脚本（1-2 天）
- 自动分区管理服务（2 天）
- 监控指标和 API（1 天）
- 测试和验证（2 天）

总计约 8-10 天。

## 7. 优先级理由

**P1 理由**：
1. 数据量增长是生产环境的现实问题，影响查询性能和运维效率
2. 分区表是 PostgreSQL 大数据量场景的最佳实践
3. 早期实现可避免后期数据迁移的巨大成本
4. 对"项目可用"贡献显著：提升性能、降低运维成本、支持数据生命周期管理
5. 依赖 REQ-00007（数据库迁移管理）已完成，条件成熟
