/**
 * REQ-00060: 数据库分区表与大数据量表分区策略
 * 
 * PostgreSQL 表分区管理服务
 * - 自动创建未来分区
 * - 归档旧分区
 * - 删除过期分区
 * - 分区统计监控
 */

const { logger, metrics } = require('./index');
const db = require('./db');

class PartitionManager {
  constructor() {
    this.partitionConfigs = {
      catch_records: {
        granularity: 'monthly',
        retentionMonths: 12,
        archiveMonths: 12,
        primaryKey: 'id',
        tableName: 'catch_records'
      },
      location_updates: {
        granularity: 'daily',
        retentionDays: 30,
        archiveDays: 60,
        primaryKey: 'id',
        tableName: 'location_updates'
      },
      audit_logs: {
        granularity: 'monthly',
        retentionMonths: 24,
        archiveMonths: 12,
        primaryKey: 'id',
        tableName: 'audit_logs'
      },
      event_logs: {
        granularity: 'weekly',
        retentionWeeks: 13,  // ~90 days
        archiveWeeks: 13,
        primaryKey: 'id',
        tableName: 'event_logs'
      },
      payment_transactions: {
        granularity: 'monthly',
        retentionMonths: null,  // 永久保留
        primaryKey: 'id',
        tableName: 'payment_transactions'
      }
    };

    this.initialized = false;
  }

  /**
   * 初始化分区管理器
   */
  async initialize() {
    if (this.initialized) return;

    try {
      // 确保分区管理函数存在
      await this.ensurePartitionFunctions();
      this.initialized = true;
      logger.info('PartitionManager initialized');
    } catch (error) {
      logger.error('PartitionManager initialization failed', { error: error.message });
      throw error;
    }
  }

  /**
   * 确保分区管理函数存在
   */
  async ensurePartitionFunctions() {
    await db.query(`
      CREATE OR REPLACE FUNCTION create_partition_if_not_exists(
        parent_table TEXT,
        partition_name TEXT,
        start_date TIMESTAMP WITH TIME ZONE,
        end_date TIMESTAMP WITH TIME ZONE
      ) RETURNS BOOLEAN AS $$
      DECLARE
        partition_exists INTEGER;
      BEGIN
        SELECT count(*) INTO partition_exists
        FROM pg_class WHERE relname = partition_name;
        
        IF partition_exists > 0 THEN
          RETURN FALSE;
        END IF;
        
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          partition_name, parent_table, start_date, end_date
        );
        
        RETURN TRUE;
      END;
      $$ LANGUAGE plpgsql;
    `);
  }

  /**
   * 计算分区信息
   * @param {string} granularity - 分区粒度 (monthly/daily/weekly)
   * @param {number} offset - 偏移量
   * @returns {Object} 分区信息 { name, start, end }
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
        // 计算本周开始（周一）
        const dayOfWeek = now.getDay();
        const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() + daysToMonday + (offset * 7));
        weekStart.setHours(0, 0, 0, 0);
        start = weekStart;
        end = new Date(start);
        end.setDate(end.getDate() + 7);
        // 计算周数
        const yearStart = new Date(start.getFullYear(), 0, 1);
        const weekNum = Math.ceil((((start - yearStart) / 86400000) + yearStart.getDay() + 1) / 7);
        name = `${start.getFullYear()}_w${String(weekNum).padStart(2, '0')}`;
        break;

      default:
        throw new Error(`Unknown granularity: ${granularity}`);
    }

    return { name, start, end };
  }

  /**
   * 创建分区
   * @param {string} tableName - 表名
   * @param {Object} partition - 分区信息
   * @returns {Promise<boolean>} 是否创建成功
   */
  async createPartition(tableName, partition) {
    const partitionName = `${tableName}_${partition.name}`;

    try {
      const result = await db.query(`
        SELECT create_partition_if_not_exists($1, $2, $3, $4) as created
      `, [tableName, partitionName, partition.start, partition.end]);

      const created = result.rows[0]?.created;

      if (created) {
        logger.info('Partition created', { table: tableName, partition: partitionName });
        metrics.increment('partition.created', { table: tableName });
      }

      return created;
    } catch (error) {
      logger.error('Failed to create partition', {
        table: tableName,
        partition: partitionName,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 确保未来分区存在
   * @param {string} tableName - 表名
   * @param {number} aheadCount - 提前创建的分区数量
   * @returns {Promise<string[]>} 创建的分区名称列表
   */
  async ensureFuturePartitions(tableName, aheadCount = 3) {
    await this.initialize();

    const config = this.partitionConfigs[tableName];
    if (!config) {
      throw new Error(`Unknown table: ${tableName}`);
    }

    const created = [];

    for (let i = 0; i < aheadCount; i++) {
      const partition = this.calculatePartition(config.granularity, i);

      try {
        const wasCreated = await this.createPartition(tableName, partition);
        if (wasCreated) {
          created.push(partition.name);
        }
      } catch (error) {
        // 分区已存在，继续
        if (error.code !== '42P07') {
          logger.warn('Partition may already exist', {
            table: tableName,
            partition: partition.name
          });
        }
      }
    }

    return created;
  }

  /**
   * 获取分区列表
   * @param {string} tableName - 表名
   * @returns {Promise<Array>} 分区列表
   */
  async listPartitions(tableName) {
    try {
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
    } catch (error) {
      logger.error('Failed to list partitions', {
        table: tableName,
        error: error.message
      });
      return [];
    }
  }

  /**
   * 解析分区边界
   * @param {Object} row - 数据库行
   * @returns {Object} 解析后的分区信息
   */
  parsePartitionBound(row) {
    // 解析类似 FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00')
    const bound = row.partition_bound || '';
    const fromMatch = bound.match(/FROM \('([^']+)'\)/);
    const toMatch = bound.match(/TO \('([^']+)'\)/);

    return {
      name: row.partition_name.replace(/^[^_]+_/, ''),
      fullName: row.partition_name,
      start: fromMatch ? new Date(fromMatch[1]) : null,
      end: toMatch ? new Date(toMatch[1]) : null,
      bound: bound
    };
  }

  /**
   * 获取分区统计信息
   * @param {string} tableName - 表名
   * @returns {Promise<Array>} 分区统计列表
   */
  async getPartitionStats(tableName) {
    const partitions = await this.listPartitions(tableName);
    const stats = [];

    for (const partition of partitions) {
      try {
        // 获取表大小
        const sizeResult = await db.query(`
          SELECT pg_relation_size($1) AS table_size
        `, [partition.fullName]);

        // 获取行数（近似值，避免全表扫描）
        const countResult = await db.query(`
          SELECT reltuples::bigint AS row_count
          FROM pg_class
          WHERE relname = $1
        `, [partition.fullName]);

        stats.push({
          name: partition.name,
          fullName: partition.fullName,
          start: partition.start,
          end: partition.end,
          sizeBytes: parseInt(sizeResult.rows[0]?.table_size || 0),
          rowCount: parseInt(countResult.rows[0]?.row_count || 0)
        });
      } catch (error) {
        logger.warn('Failed to get partition stats', {
          partition: partition.fullName,
          error: error.message
        });
      }
    }

    return stats;
  }

  /**
   * 计算保留截止日期
   * @param {Object} config - 分区配置
   * @returns {Date} 截止日期
   */
  calculateRetentionCutoff(config) {
    const now = new Date();

    if (config.retentionMonths !== undefined && config.retentionMonths !== null) {
      return new Date(now.getFullYear(), now.getMonth() - config.retentionMonths, 1);
    }
    if (config.retentionDays !== undefined) {
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - config.retentionDays);
      return cutoff;
    }
    if (config.retentionWeeks !== undefined) {
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - config.retentionWeeks * 7);
      return cutoff;
    }

    return null; // 永久保留
  }

  /**
   * 计算归档截止日期
   * @param {Object} config - 分区配置
   * @returns {Date} 截止日期
   */
  calculateArchiveCutoff(config) {
    const now = new Date();

    if (config.archiveMonths !== undefined && config.archiveMonths !== null) {
      const retentionMonths = config.retentionMonths || 0;
      return new Date(now.getFullYear(), now.getMonth() - retentionMonths - config.archiveMonths, 1);
    }
    if (config.archiveDays !== undefined) {
      const retentionDays = config.retentionDays || 0;
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - retentionDays - config.archiveDays);
      return cutoff;
    }
    if (config.archiveWeeks !== undefined) {
      const retentionWeeks = config.retentionWeeks || 0;
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - (retentionWeeks + config.archiveWeeks) * 7);
      return cutoff;
    }

    return null;
  }

  /**
   * 归档分区
   * @param {string} tableName - 表名
   * @param {Object} partition - 分区信息
   * @returns {Promise<boolean>} 是否归档成功
   */
  async archivePartition(tableName, partition) {
    const partitionName = partition.fullName;
    const archiveName = `${tableName}_archive_${partition.name}`;

    try {
      // 1. 分离分区
      await db.query(`
        ALTER TABLE ${tableName} DETACH PARTITION ${partitionName} CONCURRENTLY
      `);

      // 2. 重命名为归档表
      await db.query(`
        ALTER TABLE ${partitionName} RENAME TO ${archiveName}
      `);

      logger.info('Partition archived', {
        table: tableName,
        partition: partitionName,
        archive: archiveName
      });

      metrics.increment('partition.archived', { table: tableName });

      return true;
    } catch (error) {
      logger.error('Failed to archive partition', {
        table: tableName,
        partition: partitionName,
        error: error.message
      });
      return false;
    }
  }

  /**
   * 归档旧分区
   * @param {string} tableName - 表名
   * @returns {Promise<string[]>} 归档的分区名称列表
   */
  async archiveOldPartitions(tableName) {
    const config = this.partitionConfigs[tableName];
    if (!config) {
      return [];
    }

    const cutoffDate = this.calculateArchiveCutoff(config);
    if (!cutoffDate) {
      return []; // 无需归档
    }

    const archived = [];
    const partitions = await this.listPartitions(tableName);

    for (const partition of partitions) {
      if (partition.end && partition.end < cutoffDate) {
        const success = await this.archivePartition(tableName, partition);
        if (success) {
          archived.push(partition.name);
        }
      }
    }

    return archived;
  }

  /**
   * 删除过期分区
   * @param {string} tableName - 表名
   * @returns {Promise<string[]>} 删除的分区名称列表
   */
  async dropExpiredPartitions(tableName) {
    const config = this.partitionConfigs[tableName];
    if (!config) {
      return [];
    }

    const cutoffDate = this.calculateRetentionCutoff(config);
    if (!cutoffDate) {
      return []; // 永久保留
    }

    const dropped = [];
    const partitions = await this.listPartitions(tableName);

    for (const partition of partitions) {
      if (partition.end && partition.end < cutoffDate) {
        try {
          await db.query(`DROP TABLE IF EXISTS ${partition.fullName}`);

          dropped.push(partition.name);
          logger.info('Partition dropped', {
            table: tableName,
            partition: partition.fullName
          });

          metrics.increment('partition.dropped', { table: tableName });
        } catch (error) {
          logger.error('Failed to drop partition', {
            table: tableName,
            partition: partition.fullName,
            error: error.message
          });
        }
      }
    }

    return dropped;
  }

  /**
   * 定时维护任务
   * @returns {Promise<Object>} 维护结果
   */
  async runMaintenance() {
    await this.initialize();

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
        results.errors.push({
          table: tableName,
          error: error.message
        });
        logger.error('Partition maintenance failed for table', {
          table: tableName,
          error: error.message
        });
      }
    }

    logger.info('Partition maintenance completed', {
      created: results.created.length,
      archived: results.archived.length,
      dropped: results.dropped.length,
      errors: results.errors.length
    });

    return results;
  }

  /**
   * 获取所有表的分区概览
   * @returns {Promise<Object>} 分区概览
   */
  async getOverview() {
    await this.initialize();

    const overview = {};

    for (const [tableName, config] of Object.entries(this.partitionConfigs)) {
      try {
        const stats = await this.getPartitionStats(tableName);
        const totalSize = stats.reduce((sum, s) => sum + s.sizeBytes, 0);
        const totalRows = stats.reduce((sum, s) => sum + s.rowCount, 0);

        overview[tableName] = {
          config,
          partitionCount: stats.length,
          totalSizeBytes: totalSize,
          totalRows,
          partitions: stats
        };
      } catch (error) {
        overview[tableName] = {
          config,
          error: error.message
        };
      }
    }

    return overview;
  }
}

// 导出单例
const partitionManager = new PartitionManager();

module.exports = partitionManager;
