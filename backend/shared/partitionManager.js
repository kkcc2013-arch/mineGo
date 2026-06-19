/**
 * 分区管理器
 * 用于自动管理 PostgreSQL 分区表的创建、归档和清理
 */

const { Pool } = require('pg');
const { createLogger } = require('./logger');
const { metrics } = require('./metrics');

const logger = createLogger('partition-manager');

/**
 * 分区配置
 */
const PARTITION_CONFIGS = {
  catch_records: {
    granularity: 'monthly',
    retentionMonths: 12,
    archiveMonths: 12,
    primaryKey: 'id',
    partitionColumn: 'created_at'
  },
  location_updates: {
    granularity: 'daily',
    retentionDays: 30,
    archiveDays: 60,
    primaryKey: 'id',
    partitionColumn: 'created_at'
  },
  audit_logs: {
    granularity: 'monthly',
    retentionMonths: 24,
    archiveMonths: 12,
    primaryKey: 'id',
    partitionColumn: 'created_at'
  },
  event_logs: {
    granularity: 'weekly',
    retentionWeeks: 13,  // ~90 days
    archiveWeeks: 13,
    primaryKey: 'id',
    partitionColumn: 'created_at'
  },
  payment_transactions: {
    granularity: 'monthly',
    retentionMonths: null,  // 永久保留
    primaryKey: 'id',
    partitionColumn: 'created_at'
  }
};

class PartitionManager {
  constructor(dbPool) {
    this.db = dbPool || new Pool();
    this.partitionConfigs = PARTITION_CONFIGS;
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

        // 记录指标
        metrics.increment('partition.created', { table: tableName });
      } catch (error) {
        if (error.code === '42P07') {  // 分区已存在
          logger.debug('Partition already exists', { table: tableName, partition: partition.name });
          continue;
        }
        logger.error('Failed to create partition', {
          table: tableName,
          partition: partition.name,
          error: error.message
        });
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

      default:
        throw new Error(`Unknown granularity: ${granularity}`);
    }

    return { start, end, name };
  }

  /**
   * 创建分区
   */
  async createPartition(tableName, partition) {
    const partitionName = `${tableName}_${partition.name}`;
    const parentTable = `${tableName}_partitioned`;

    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${partitionName}
      PARTITION OF ${parentTable}
      FOR VALUES FROM ($1) TO ($2)
    `, [partition.start, partition.end]);
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
        try {
          await this.archivePartition(tableName, partition);
          archived.push(partition.name);
          logger.info('Partition archived', { table: tableName, partition: partition.name });

          // 记录指标
          metrics.increment('partition.archived', { table: tableName });
        } catch (error) {
          logger.error('Failed to archive partition', {
            table: tableName,
            partition: partition.name,
            error: error.message
          });
        }
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
    const parentTable = `${tableName}_partitioned`;

    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // 1. 分离分区
      await client.query(`
        ALTER TABLE ${parentTable} DETACH PARTITION ${partitionName}
      `);

      // 2. 重命名为归档表
      await client.query(`
        ALTER TABLE ${partitionName} RENAME TO ${archiveName}
      `);

      // 3. 可选：导出到冷存储（S3/对象存储）
      // await this.exportToArchive(tableName, partition);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

        try {
          await this.db.query(`DROP TABLE IF EXISTS ${partitionName}`);
          dropped.push(partition.name);

          logger.info('Partition dropped', { table: tableName, partition: partition.name });
          metrics.increment('partition.dropped', { table: tableName });
        } catch (error) {
          logger.error('Failed to drop partition', {
            table: tableName,
            partition: partition.name,
            error: error.message
          });
        }
      }
    }

    return dropped;
  }

  /**
   * 获取分区列表
   */
  async listPartitions(tableName) {
    const parentTable = `${tableName}_partitioned`;

    const result = await this.db.query(`
      SELECT
        pt.relname AS partition_name,
        pg_get_expr(pt.relpartbound, pt.oid) AS partition_bound
      FROM pg_class pc
      JOIN pg_inherits pi ON pc.oid = pi.inhparent
      JOIN pg_class pt ON pi.inhrelid = pt.oid
      WHERE pc.relname = $1
      ORDER BY pt.relname
    `, [parentTable]);

    return result.rows.map(row => this.parsePartitionBound(row));
  }

  /**
   * 解析分区边界
   */
  parsePartitionBound(row) {
    // 简化实现，实际需要解析 partition_bound
    // 例如: FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00')
    const boundMatch = row.partition_bound.match(/FROM \('([^']+)'\) TO \('([^']+)'\)/);

    if (boundMatch) {
      return {
        name: row.partition_name.replace(/^[^_]+_/, ''),
        start: new Date(boundMatch[1]),
        end: new Date(boundMatch[2])
      };
    }

    return {
      name: row.partition_name,
      start: null,
      end: null
    };
  }

  /**
   * 获取分区统计信息
   */
  async getPartitionStats(tableName) {
    const partitions = await this.listPartitions(tableName);
    const stats = [];

    for (const partition of partitions) {
      const partitionName = `${tableName}_${partition.name}`;

      try {
        const result = await this.db.query(`
          SELECT
            pg_relation_size($1) AS table_size,
            (SELECT count(*) FROM ${partitionName}) AS row_count
        `, [partitionName]);

        stats.push({
          name: partition.name,
          start: partition.start,
          end: partition.end,
          sizeBytes: parseInt(result.rows[0].table_size) || 0,
          rowCount: parseInt(result.rows[0].row_count) || 0
        });

        // 更新监控指标
        metrics.gauge('partition.row_count', result.rows[0].row_count, {
          table: tableName,
          partition: partition.name
        });
        metrics.gauge('partition.size_bytes', result.rows[0].table_size, {
          table: tableName,
          partition: partition.name
        });
      } catch (error) {
        logger.error('Failed to get partition stats', {
          table: tableName,
          partition: partition.name,
          error: error.message
        });
      }
    }

    return stats;
  }

  /**
   * 计算归档截止日期
   */
  calculateCutoffDate(config) {
    const now = new Date();

    if (config.archiveMonths) {
      now.setMonth(now.getMonth() - config.retentionMonths);
    } else if (config.archiveDays) {
      now.setDate(now.getDate() - config.retentionDays);
    } else if (config.archiveWeeks) {
      now.setDate(now.getDate() - (config.retentionWeeks * 7));
    }

    return now;
  }

  /**
   * 计算保留截止日期
   */
  calculateRetentionCutoff(config) {
    const now = new Date();

    if (config.retentionMonths) {
      now.setMonth(now.getMonth() - config.retentionMonths);
    } else if (config.retentionDays) {
      now.setDate(now.getDate() - config.retentionDays);
    } else if (config.retentionWeeks) {
      now.setDate(now.getDate() - (config.retentionWeeks * 7));
    }

    return now;
  }

  /**
   * 定时维护任务
   */
  async runMaintenance() {
    const results = {
      created: [],
      archived: [],
      dropped: [],
      errors: []
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
        results.errors.push({ table: tableName, error: error.message });
      }
    }

    logger.info('Partition maintenance completed', results);
    return results;
  }

  /**
   * 数据迁移：从旧表迁移到分区表
   */
  async migrateToPartitioned(tableName, batchSize = 10000) {
    const parentTable = `${tableName}_partitioned`;
    const config = this.partitionConfigs[tableName];

    if (!config) {
      throw new Error(`Unknown table: ${tableName}`);
    }

    logger.info('Starting data migration', { table: tableName });

    let offset = 0;
    let totalMigrated = 0;

    while (true) {
      // 分批迁移数据
      const result = await this.db.query(`
        INSERT INTO ${parentTable}
        SELECT * FROM ${tableName}
        WHERE created_at IS NOT NULL
        ORDER BY created_at
        LIMIT $1 OFFSET $2
      `, [batchSize, offset]);

      if (result.rowCount === 0) {
        break;
      }

      totalMigrated += result.rowCount;
      offset += batchSize;

      logger.info('Migration progress', {
        table: tableName,
        migrated: totalMigrated,
        lastBatch: result.rowCount
      });

      // 避免长时间锁表
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info('Data migration completed', { table: tableName, totalMigrated });

    return { migrated: totalMigrated };
  }
}

// 导出单例
const partitionManager = new PartitionManager();

module.exports = {
  PartitionManager,
  partitionManager,
  PARTITION_CONFIGS
};
