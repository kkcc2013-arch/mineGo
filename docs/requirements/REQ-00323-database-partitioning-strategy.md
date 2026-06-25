# REQ-00323: 数据库分区表与大数据量表分区策略

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00323 |
| 标题 | 数据库分区表与大数据量表分区策略 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | database/migrations、pokemon-service、user-service、social-service、catch-service、backend/shared |
| 创建时间 | 2026-06-25 01:00 UTC |

## 需求描述

随着 mineGo 项目用户量和精灵数据量的快速增长，单表数据量已突破千万级，导致查询性能下降、索引维护成本上升、历史数据归档困难。本需求实现 PostgreSQL 分区表策略，对高频大表进行水平分区，提升查询性能、简化数据生命周期管理、降低运维成本。

### 核心目标

1. **性能优化**：大表查询性能提升 50%+
2. **数据治理**：历史数据自动归档，冷热数据分离
3. **运维简化**：分区级别的索引维护、备份恢复
4. **成本控制**：降低存储和查询资源消耗

### 目标表

| 表名 | 预估数据量 | 分区策略 | 分区键 |
|------|-----------|----------|--------|
| `catch_records` | 5000万+ | RANGE (按月) | `created_at` |
| `battle_logs` | 2000万+ | RANGE (按月) | `battle_time` |
| `user_activities` | 3000万+ | RANGE (按月) | `activity_time` |
| `pokemon_location_history` | 1亿+ | RANGE (按月) | `recorded_at` |
| `audit_logs` | 5000万+ | RANGE (按月) | `created_at` |
| `notifications` | 2000万+ | RANGE (按月) | `created_at` |

## 技术方案

### 1. PostgreSQL 分区表创建

#### 1.1 主表定义（父表）

```sql
-- database/migrations/20260625010000_create_partitioned_tables.sql

-- 捕捉记录分区表
CREATE TABLE IF NOT EXISTS catch_records_partitioned (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    pokemon_id UUID NOT NULL,
    species_id INTEGER NOT NULL,
    location_id UUID,
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    catch_method VARCHAR(50),
    ball_used VARCHAR(50),
    success BOOLEAN DEFAULT true,
    escaped BOOLEAN DEFAULT false,
    experience_gained INTEGER DEFAULT 0,
    bonus_multiplier DECIMAL(4, 2) DEFAULT 1.0,
    weather VARCHAR(50),
    time_of_day VARCHAR(20),
    device_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 战斗日志分区表
CREATE TABLE IF NOT EXISTS battle_logs_partitioned (
    id UUID NOT NULL,
    battle_id UUID NOT NULL,
    battle_type VARCHAR(50) NOT NULL,
    attacker_id UUID NOT NULL,
    defender_id UUID NOT NULL,
    attacker_pokemon_id UUID NOT NULL,
    defender_pokemon_id UUID NOT NULL,
    skill_id INTEGER,
    damage_dealt INTEGER,
    damage_blocked INTEGER,
    critical_hit BOOLEAN DEFAULT false,
    status_effect VARCHAR(50),
    round_number INTEGER,
    battle_time TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, battle_time)
) PARTITION BY RANGE (battle_time);

-- 用户活动记录分区表
CREATE TABLE IF NOT EXISTS user_activities_partitioned (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    activity_type VARCHAR(100) NOT NULL,
    activity_data JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    device_id VARCHAR(100),
    location_lat DECIMAL(10, 8),
    location_lng DECIMAL(11, 8),
    activity_time TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, activity_time)
) PARTITION BY RANGE (activity_time);

-- 精灵位置历史分区表
CREATE TABLE IF NOT EXISTS pokemon_location_history_partitioned (
    id UUID NOT NULL,
    spawn_point_id UUID NOT NULL,
    species_id INTEGER NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    altitude DECIMAL(8, 2),
    accuracy_radius DECIMAL(6, 2),
    spawn_type VARCHAR(50),
    weather VARCHAR(50),
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL,
    despawn_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- 审计日志分区表
CREATE TABLE IF NOT EXISTS audit_logs_partitioned (
    id UUID NOT NULL,
    user_id UUID,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(255),
    old_values JSONB,
    new_values JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    session_id VARCHAR(255),
    status VARCHAR(20) DEFAULT 'success',
    error_message TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 通知分区表
CREATE TABLE IF NOT EXISTS notifications_partitioned (
    id UUID NOT NULL,
    user_id UUID NOT NULL,
    notification_type VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT,
    data JSONB,
    priority INTEGER DEFAULT 0,
    read_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
```

#### 1.2 分区自动创建函数

```sql
-- database/migrations/20260625010100_create_partition_functions.sql

-- 创建分区管理函数
CREATE OR REPLACE FUNCTION create_monthly_partitions(
    table_name TEXT,
    start_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    months_ahead INTEGER DEFAULT 3,
    months_behind INTEGER DEFAULT 12
) RETURNS VOID AS $$
DECLARE
    partition_date TIMESTAMP WITH TIME ZONE;
    partition_start TIMESTAMP WITH TIME ZONE;
    partition_end TIMESTAMP WITH TIME ZONE;
    partition_name TEXT;
    i INTEGER;
BEGIN
    -- 创建过去的分区
    FOR i IN 0..(months_behind - 1) LOOP
        partition_date := date_trunc('month', start_date - (i || ' months')::INTERVAL);
        partition_start := partition_date;
        partition_end := partition_date + INTERVAL '1 month';
        partition_name := table_name || '_y' || to_char(partition_date, 'YYYY') || '_m' || to_char(partition_date, 'MM');
        
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            partition_name, table_name, partition_start, partition_end
        );
        
        -- 为分区创建本地索引
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_user_id ON %I (user_id)',
            partition_name, partition_name
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_created ON %I (created_at)',
            partition_name, partition_name
        );
    END LOOP;
    
    -- 创建未来的分区
    FOR i IN 1..months_ahead LOOP
        partition_date := date_trunc('month', start_date + (i || ' months')::INTERVAL);
        partition_start := partition_date;
        partition_end := partition_date + INTERVAL '1 month';
        partition_name := table_name || '_y' || to_char(partition_date, 'YYYY') || '_m' || to_char(partition_date, 'MM');
        
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            partition_name, table_name, partition_start, partition_end
        );
        
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_user_id ON %I (user_id)',
            partition_name, partition_name
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_created ON %I (created_at)',
            partition_name, partition_name
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- 自动创建下个月分区的函数
CREATE OR REPLACE FUNCTION auto_create_next_month_partition()
RETURNS VOID AS $$
DECLARE
    table_record RECORD;
    next_month TIMESTAMP WITH TIME ZONE;
    partition_start TIMESTAMP WITH TIME ZONE;
    partition_end TIMESTAMP WITH TIME ZONE;
    partition_name TEXT;
BEGIN
    next_month := date_trunc('month', CURRENT_TIMESTAMP + INTERVAL '1 month');
    partition_start := next_month;
    partition_end := next_month + INTERVAL '1 month';
    
    FOR table_record IN 
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE '%_partitioned'
    LOOP
        partition_name := table_record.tablename || '_y' || to_char(next_month, 'YYYY') || '_m' || to_char(next_month, 'MM');
        
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            partition_name, table_record.tablename, partition_start, partition_end
        );
        
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_%s_user_id ON %I (user_id)',
            partition_name, partition_name
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- 删除旧分区的函数
CREATE OR REPLACE FUNCTION drop_old_partitions(
    table_name TEXT,
    retention_months INTEGER DEFAULT 12
) RETURNS VOID AS $$
DECLARE
    cutoff_date TIMESTAMP WITH TIME ZONE;
    partition_record RECORD;
BEGIN
    cutoff_date := date_trunc('month', CURRENT_TIMESTAMP - (retention_months || ' months')::INTERVAL);
    
    FOR partition_record IN 
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE table_name || '_y%'
    LOOP
        -- 从分区名称中提取日期
        IF regexp_match(partition_record.tablename, 'y(\d{4})_m(\d{2})') IS NOT NULL THEN
            DECLARE
                year_mon TEXT[];
                partition_date TIMESTAMP WITH TIME ZONE;
            BEGIN
                year_mon := regexp_match(partition_record.tablename, 'y(\d{4})_m(\d{2})');
                partition_date := make_date(year_mon[1]::INTEGER, year_mon[2]::INTEGER, 1);
                
                IF partition_date < cutoff_date THEN
                    EXECUTE format('DROP TABLE IF EXISTS %I', partition_record.tablename);
                    RAISE NOTICE 'Dropped old partition: %', partition_record.tablename;
                END IF;
            END;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
```

### 2. 数据迁移工具

```javascript
// backend/shared/partitionMigrator.js

const { Pool } = require('pg');
const logger = require('./logger');

class PartitionMigrator {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * 将数据从原表迁移到分区表
   * @param {string} sourceTable - 原表名
   * @param {string} targetTable - 分区表名
   * @param {number} batchSize - 每批迁移数量
   */
  async migrateTable(sourceTable, targetTable, batchSize = 10000) {
    let offset = 0;
    let totalMigrated = 0;
    let hasMore = true;

    while (hasMore) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // 批量读取数据
        const { rows } = await client.query(`
          SELECT * FROM ${sourceTable}
          ORDER BY created_at
          LIMIT $1 OFFSET $2
        `, [batchSize, offset]);

        if (rows.length === 0) {
          hasMore = false;
          break;
        }

        // 插入到分区表
        for (const row of rows) {
          await this.insertRow(client, targetTable, row);
        }

        await client.query('COMMIT');
        totalMigrated += rows.length;
        offset += batchSize;

        logger.info(`Migrated ${rows.length} rows from ${sourceTable} to ${targetTable}. Total: ${totalMigrated}`);

        if (rows.length < batchSize) {
          hasMore = false;
        }
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`Migration batch failed: ${error.message}`);
        throw error;
      } finally {
        client.release();
      }
    }

    return totalMigrated;
  }

  async insertRow(client, targetTable, row) {
    const columns = Object.keys(row).filter(k => row[k] !== undefined);
    const values = columns.map(c => row[c]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    await client.query(
      `INSERT INTO ${targetTable} (${columns.join(', ')}) VALUES (${placeholders})`,
      values
    );
  }

  /**
   * 验证数据迁移完整性
   */
  async verifyMigration(sourceTable, targetTable) {
    const sourceCount = await this.pool.query(`SELECT COUNT(*) FROM ${sourceTable}`);
    const targetCount = await this.pool.query(`SELECT COUNT(*) FROM ${targetTable}`);

    const sourceTotal = parseInt(sourceCount.rows[0].count);
    const targetTotal = parseInt(targetCount.rows[0].count);

    if (sourceTotal !== targetTotal) {
      throw new Error(`Data mismatch: source=${sourceTotal}, target=${targetTotal}`);
    }

    logger.info(`Migration verified: ${targetTotal} rows match`);
    return true;
  }

  /**
   * 切换表名（原子操作）
   */
  async swapTables(oldTable, newTable, backupSuffix = '_backup') {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 重命名原表为备份表
      await client.query(`ALTER TABLE IF EXISTS ${oldTable} RENAME TO ${oldTable}${backupSuffix}`);
      
      // 重命名分区表为原表名
      await client.query(`ALTER TABLE ${newTable} RENAME TO ${oldTable}`);
      
      await client.query('COMMIT');
      logger.info(`Tables swapped: ${oldTable} -> ${oldTable}${backupSuffix}, ${newTable} -> ${oldTable}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = PartitionMigrator;
```

### 3. 分区管理后台任务

```javascript
// backend/jobs/partitionManager.js

const { Pool } = require('pg');
const logger = require('../shared/logger');
const cron = require('node-cron');

class PartitionManager {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * 初始化分区管理器
   */
  async initialize() {
    // 每月1号自动创建下个月的分区
    cron.schedule('0 0 1 * *', async () => {
      await this.createNextMonthPartitions();
    });

    // 每天凌晨检查并删除过期分区
    cron.schedule('0 2 * * *', async () => {
      await this.cleanupOldPartitions();
    });

    logger.info('Partition manager initialized');
  }

  /**
   * 创建下个月的分区
   */
  async createNextMonthPartitions() {
    try {
      await this.pool.query('SELECT auto_create_next_month_partition()');
      logger.info('Next month partitions created successfully');
    } catch (error) {
      logger.error(`Failed to create next month partitions: ${error.message}`);
    }
  }

  /**
   * 清理过期分区
   */
  async cleanupOldPartitions() {
    const tables = [
      'catch_records_partitioned',
      'battle_logs_partitioned',
      'user_activities_partitioned',
      'pokemon_location_history_partitioned',
      'audit_logs_partitioned',
      'notifications_partitioned'
    ];

    const retentionMonths = {
      'catch_records_partitioned': 12,
      'battle_logs_partitioned': 6,
      'user_activities_partitioned': 3,
      'pokemon_location_history_partitioned': 3,
      'audit_logs_partitioned': 24,
      'notifications_partitioned': 3
    };

    for (const table of tables) {
      try {
        await this.pool.query(
          'SELECT drop_old_partitions($1, $2)',
          [table, retentionMonths[table] || 12]
        );
        logger.info(`Cleaned up old partitions for ${table}`);
      } catch (error) {
        logger.error(`Failed to cleanup partitions for ${table}: ${error.message}`);
      }
    }
  }

  /**
   * 获取分区统计信息
   */
  async getPartitionStats(tableName) {
    const { rows } = await this.pool.query(`
      SELECT 
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) as size,
        pg_total_relation_size(schemaname || '.' || tablename) as bytes
      FROM pg_tables
      WHERE tablename LIKE $1
      ORDER BY tablename
    `, [`${tableName}%`]);

    return rows;
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    const tables = [
      'catch_records_partitioned',
      'battle_logs_partitioned',
      'user_activities_partitioned'
    ];

    const results = {};

    for (const table of tables) {
      // 检查当前月份分区是否存在
      const currentMonth = new Date();
      const partitionName = `${table}_y${currentMonth.getFullYear()}_m${String(currentMonth.getMonth() + 1).padStart(2, '0')}`;
      
      const { rows } = await this.pool.query(`
        SELECT EXISTS (
          SELECT FROM pg_tables 
          WHERE tablename = $1
        ) as exists
      `, [partitionName]);

      results[table] = {
        currentMonthPartitionExists: rows[0].exists,
        stats: await this.getPartitionStats(table)
      };
    }

    return results;
  }
}

module.exports = PartitionManager;
```

### 4. 查询优化器提示

```javascript
// backend/shared/partitionQueryOptimizer.js

class PartitionQueryOptimizer {
  /**
   * 为查询添加分区裁剪提示
   */
  static optimizeQuery(query, params, partitionKey = 'created_at', dateRange = null) {
    // 如果查询包含时间范围，确保分区裁剪生效
    if (dateRange) {
      const { start, end } = dateRange;
      // 确保 WHERE 子句中包含分区键范围
      return {
        query: query.replace(/WHERE/i, `WHERE ${partitionKey} >= $${params.length + 1} AND ${partitionKey} < $${params.length + 2} AND`),
        params: [...params, start, end]
      };
    }

    // 如果没有明确的时间范围，默认查询最近3个月
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    return {
      query: query.replace(/WHERE/i, `WHERE ${partitionKey} >= $${params.length + 1} AND`),
      params: [...params, threeMonthsAgo]
    };
  }

  /**
   * 强制查询使用特定分区
   */
  static forcePartition(query, partitionName) {
    return query.replace(/FROM\s+(\w+)/i, `FROM ${partitionName}`);
  }
}

module.exports = PartitionQueryOptimizer;
```

### 5. 监控与告警

```yaml
# infrastructure/k8s/monitoring/partition-alerts.yaml

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: partition-alerts
  namespace: monitoring
spec:
  groups:
  - name: partition.rules
    rules:
    - alert: PartitionSizeWarning
      expr: |
        pg_partition_size_bytes > 10737418240  # 10GB
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "分区大小超过阈值"
        description: "分区 {{ $labels.partition_name }} 大小已超过 10GB"

    - alert: MissingCurrentMonthPartition
      expr: |
        pg_partition_exists{type="current_month"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "当前月份分区缺失"
        description: "表 {{ $labels.table_name }} 缺少当前月份的分区"

    - alert: PartitionCleanupFailed
      expr: |
        increase(partition_cleanup_errors_total[1h]) > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "分区清理任务失败"
        description: "分区清理任务在过去1小时内失败"

    - alert: PartitionMigrationLag
      expr: |
        pg_partition_migration_lag_rows > 100000
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "分区迁移延迟"
        description: "分区迁移延迟超过 100000 行"
```

## 验收标准

- [ ] 完成所有目标表的分区表创建
- [ ] 实现数据迁移工具，支持增量迁移
- [ ] 实现分区自动创建与清理定时任务
- [ ] 查询性能测试：大表查询性能提升 50%+
- [ ] 分区裁剪测试：验证查询仅扫描必要分区
- [ ] 数据迁移完整性验证：原表与分区表数据一致
- [ ] 监控告警配置完成：分区缺失、大小异常告警
- [ ] 文档完善：分区策略说明、运维手册

## 影响范围

### 数据库变更
- `database/migrations/20260625010000_create_partitioned_tables.sql` - 分区表创建
- `database/migrations/20260625010100_create_partition_functions.sql` - 分区管理函数
- `database/migrations/20260625010200_create_partition_triggers.sql` - 自动分区触发器

### 服务变更
- `pokemon-service` - 捕捉记录查询适配分区表
- `user-service` - 用户活动记录查询适配
- `social-service` - 通知查询适配分区表
- `gym-service` - 战斗日志查询适配
- `backend/shared/partitionMigrator.js` - 数据迁移工具
- `backend/shared/partitionQueryOptimizer.js` - 查询优化器
- `backend/jobs/partitionManager.js` - 分区管理后台任务

### 监控变更
- `infrastructure/k8s/monitoring/partition-alerts.yaml` - 分区告警规则
- Prometheus 指标：分区大小、分区数量、迁移状态

## 参考

- [PostgreSQL 12+ Partitioning Documentation](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [PostgreSQL Table Partitioning Best Practices](https://www.postgresql.org/docs/current/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE)
- [TimescaleDB Hypertable Design](https://docs.timescale.com/timescaledb/latest/how-to-guides/hypertables/)
- [PostgreSQL Partition Maintenance](https://github.com/pgpartman/pg_partman)
