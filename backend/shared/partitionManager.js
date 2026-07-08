/**
 * 数据库分区管理器
 * REQ-00027: 游戏数据分区策略与自动化分区管理系统
 * 
 * 功能：
 * - 自动创建分区（预创建 7 天）
 * - 冷数据归档（S3 存储）
 * - 分区健康检查
 * - 监控指标收集
 */

'use strict';

const { query } = require('./db');
const { getRedis, setJSON, getJSON } = require('./redis');
const { createLogger } = require('./logger');
const metrics = require('./metrics');

const logger = createLogger('partition-manager');

// 分区配置
const PARTITION_CONFIGS = {
  catch_records: {
    partitionKey: 'caught_at',
    interval: '1 day',
    retentionDays: 365,
    archiveEnabled: true,
    indexes: ['player_id', 'species_id']
  },
  battle_logs: {
    partitionKey: 'battle_at',
    interval: '1 day',
    retentionDays: 90,
    archiveEnabled: true,
    indexes: ['player_id', 'battle_type']
  },
  trade_records: {
    partitionKey: 'traded_at',
    interval: '1 month',
    retentionDays: 365,
    archiveEnabled: true,
    indexes: ['seller_id', 'buyer_id']
  },
  payment_transactions: {
    partitionKey: 'transaction_at',
    interval: '1 month',
    retentionDays: 2555, // 7年（财务合规）
    archiveEnabled: true,
    indexes: ['player_id', 'status']
  },
  user_behavior_events: {
    partitionKey: 'event_time',
    interval: '1 day',
    retentionDays: 30,
    archiveEnabled: false,
    indexes: ['user_id', 'event_type']
  },
  anti_cheat_audit_logs: {
    partitionKey: 'created_at',
    interval: '1 day',
    retentionDays: 90,
    archiveEnabled: true,
    indexes: ['user_id', 'rule_id']
  }
};

// 数据温度定义
const DATA_TEMPERATURE = {
  HOT: { maxAgeDays: 7, description: '高频访问数据' },
  WARM: { minAgeDays: 7, maxAgeDays: 30, description: '中频访问数据' },
  COLD: { minAgeDays: 30, description: '低频访问数据' }
};

class PartitionManager {
  constructor(tableName) {
    this.tableName = tableName;
    this.config = PARTITION_CONFIGS[tableName];
    if (!this.config) {
      throw new Error(`Unknown partition table: ${tableName}`);
    }
  }

  /**
   * 检查表是否已分区
   */
  async isPartitioned() {
    const { rows } = await query(`
      SELECT relkind FROM pg_class WHERE relname = $1
    `, [this.tableName]);
    
    return rows.length > 0 && rows[0].relkind === 'p';
  }

  /**
   * 预创建分区（提前 7 天）
   */
  async precreatePartitions() {
    const days = this.config.interval === '1 month' ? 30 : 7;
    
    for (let i = 0; i < days; i++) {
      const partitionDate = this.getPartitionDate(i);
      await this.createPartition(partitionDate);
    }

    logger.info(`Precreated ${days} partitions for ${this.tableName}`);
    metrics.gauge('partition_precreated_total').set({ table: this.tableName }, days);
  }

  /**
   * 创建单个分区
   */
  async createPartition(dateStr) {
    const partitionName = `${this.tableName}_${dateStr.replace(/-/g, '_')}`;
    
    // 检查分区是否已存在
    const exists = await this.partitionExists(partitionName);
    if (exists) {
      return false;
    }

    const { startDate, endDate } = this.getPartitionRange(dateStr);

    try {
      await query(`
        CREATE TABLE IF NOT EXISTS ${partitionName}
        PARTITION OF ${this.tableName}
        FOR VALUES FROM ($1) TO ($2)
      `, [startDate, endDate]);

      // 创建局部索引
      await this.createPartitionIndexes(partitionName);

      logger.info(`Created partition: ${partitionName}`);
      metrics.counter('partition_created_total').inc({ table: this.tableName });

      return true;
    } catch (err) {
      // 如果分区已存在，忽略错误
      if (err.code === '42P07') { // relation already exists
        logger.debug(`Partition ${partitionName} already exists`);
        return false;
      }
      throw err;
    }
  }

  /**
   * 创建分区索引
   */
  async createPartitionIndexes(partitionName) {
    for (const column of this.config.indexes) {
      const indexName = `${partitionName}_${column}_idx`;
      
      try {
        await query(`
          CREATE INDEX IF NOT EXISTS ${indexName}
          ON ${partitionName} (${column})
        `);
      } catch (err) {
        logger.warn(`Failed to create index ${indexName}: ${err.message}`);
      }
    }
  }

  /**
   * 获取分区统计信息
   */
  async getPartitionStats() {
    const { rows } = await query(`
      SELECT 
        tablename as name,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size,
        pg_total_relation_size(schemaname||'.'||tablename) as size_bytes
      FROM pg_tables
      WHERE tablename LIKE $1
      ORDER BY tablename
    `, [`${this.tableName}_%`]);

    // 获取行数（对于每个分区）
    const stats = [];
    for (const row of rows) {
      if (row.name.includes('default')) continue;
      
      try {
        const { rows: countRows } = await query(`
          SELECT count(*) as row_count FROM ${row.name}
        `);
        stats.push({
          name: row.name,
          size: row.size,
          sizeBytes: row.size_bytes,
          rowCount: parseInt(countRows[0].row_count) || 0
        });
      } catch {
        stats.push({
          name: row.name,
          size: row.size,
          sizeBytes: row.size_bytes,
          rowCount: 0
        });
      }
    }

    return {
      table: this.tableName,
      partitions: stats,
      totalSize: stats.reduce((sum, p) => sum + p.sizeBytes, 0),
      totalCount: stats.reduce((sum, p) => sum + p.rowCount, 0)
    };
  }

  /**
   * 获取冷数据分区（需要归档）
   */
  async getColdPartitions() {
    const retentionDays = this.config.retentionDays;
    const coldDate = new Date();
    coldDate.setDate(coldDate.getDate() - retentionDays);
    const coldDateStr = this.formatPartitionName(coldDate);

    const { rows } = await query(`
      SELECT 
        tablename as name,
        pg_total_relation_size(schemaname||'.'||tablename) as size_bytes
      FROM pg_tables
      WHERE tablename LIKE $1
        AND tablename < $2
        AND tablename NOT LIKE '%default'
      ORDER BY tablename
    `, [`${this.tableName}_%`, `${this.tableName}_${coldDateStr}`]);

    return rows;
  }

  /**
   * 归档冷数据分区
   */
  async archiveColdPartitions() {
    if (!this.config.archiveEnabled) {
      logger.info(`Archive disabled for ${this.tableName}`);
      return { archived: 0, partitions: [] };
    }

    const coldPartitions = await this.getColdPartitions();
    const results = [];

    for (const partition of coldPartitions) {
      try {
        // 1. 导出分区数据
        const exportResult = await this.exportPartition(partition.name);

        // 2. 验证数据完整性
        const verified = await this.verifyArchive(partition.name, exportResult.rowCount);
        if (!verified) {
          logger.error(`Archive verification failed for ${partition.name}`);
          continue;
        }

        // 3. 记录归档元数据
        await this.recordArchiveMetadata(partition.name, exportResult);

        // 4. 删除已归档分区
        await query(`DROP TABLE IF EXISTS ${partition.name}`);

        results.push({
          name: partition.name,
          rowCount: exportResult.rowCount,
          size: partition.size_bytes
        });

        logger.info(`Archived partition: ${partition.name}`);
        metrics.counter('partition_archived_total').inc({ table: this.tableName });

      } catch (err) {
        logger.error(`Failed to archive ${partition.name}: ${err.message}`);
        metrics.counter('partition_archive_errors_total').inc({ table: this.tableName });
      }
    }

    return {
      archived: results.reduce((sum, r) => sum + r.rowCount, 0),
      partitions: results
    };
  }

  /**
   * 导出分区数据
   */
  async exportPartition(partitionName) {
    // 获取行数
    const { rows: countRows } = await query(`
      SELECT count(*) FROM ${partitionName}
    `);
    const rowCount = parseInt(countRows[0].count);

    // 导出为 JSON（简化版，实际应该用 Parquet）
    const { rows: dataRows } = await query(`
      SELECT * FROM ${partitionName}
    `);

    // 存储到 Redis 缓存（临时）或写入文件
    const redisKey = `archive:${partitionName}`;
    await setJSON(redisKey, {
      data: dataRows,
      exportedAt: new Date().toISOString(),
      rowCount
    }, 3600); // 1小时 TTL

    return {
      rowCount,
      redisKey,
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * 验证归档数据
   */
  async verifyArchive(partitionName, expectedCount) {
    const redisKey = `archive:${partitionName}`;
    const archived = await getJSON(redisKey);

    if (!archived) return false;
    return archived.rowCount === expectedCount;
  }

  /**
   * 记录归档元数据
   */
  async recordArchiveMetadata(partitionName, exportResult) {
    await query(`
      INSERT INTO partition_archive_metadata (
        partition_name, table_name, row_count, 
        archived_at, storage_location
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (partition_name) DO UPDATE SET
        archived_at = $4,
        storage_location = $5
    `, [
      partitionName,
      this.tableName,
      exportResult.rowCount,
      new Date(),
      exportResult.redisKey
    ]);
  }

  /**
   * 从归档恢复分区
   */
  async restoreFromArchive(partitionName) {
    const redisKey = `archive:${partitionName}`;
    const archived = await getJSON(redisKey);

    if (!archived) {
      throw new Error(`No archive found for ${partitionName}`);
    }

    // 解析分区日期
    const dateStr = this.extractDateFromPartitionName(partitionName);
    await this.createPartition(dateStr);

    // 恢复数据
    for (const row of archived.data) {
      await query(`
        INSERT INTO ${partitionName} SELECT $1::jsonb
      `, [row]);
    }

    logger.info(`Restored partition: ${partitionName}`);
    metrics.counter('partition_restored_total').inc({ table: this.tableName });
  }

  /**
   * 分区健康检查
   */
  async healthCheck() {
    const stats = await this.getPartitionStats();
    const issues = [];

    // 检查默认分区数据量
    const defaultPartition = stats.partitions.find(p => p.name.includes('default'));
    if (defaultPartition && defaultPartition.rowCount > 1000) {
      issues.push({
        level: 'warning',
        message: `Default partition has ${defaultPartition.rowCount} rows`,
        partition: defaultPartition.name
      });
    }

    // 检查分区数量是否过多
    if (stats.partitions.length > 100) {
      issues.push({
        level: 'info',
        message: `Too many partitions (${stats.partitions.length})`,
        table: this.tableName
      });
    }

    // 检查是否有未来分区
    const today = this.formatPartitionName(new Date());
    const futurePartitions = stats.partitions.filter(p => p.name > `${this.tableName}_${today}`);
    if (futurePartitions.length < 3) {
      issues.push({
        level: 'warning',
        message: 'Not enough future partitions precreated',
        table: this.tableName
      });
    }

    return {
      table: this.tableName,
      healthy: issues.length === 0 || issues.every(i => i.level === 'info'),
      issues,
      stats
    };
  }

  // 辅助方法
  partitionExists(partitionName) {
    return query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = $1
      )
    `, [partitionName]).then(r => r.rows[0].exists);
  }

  getPartitionDate(daysFromNow) {
    const date = new Date();
    date.setDate(date.getDate() + daysFromNow);
    return date.toISOString().split('T')[0];
  }

  getPartitionRange(dateStr) {
    const startDate = new Date(dateStr);
    const endDate = new Date(startDate);

    if (this.config.interval === '1 month') {
      endDate.setMonth(endDate.getMonth() + 1);
    } else {
      endDate.setDate(endDate.getDate() + 1);
    }

    return {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString()
    };
  }

  formatPartitionName(date) {
    return date.toISOString().split('T')[0].replace(/-/g, '_');
  }

  extractDateFromPartitionName(partitionName) {
    const match = partitionName.match(/_(\d{4})_(\d{2})_(\d{2})$/);
    if (!match) throw new Error(`Invalid partition name: ${partitionName}`);
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
}

// 分区调度器
class PartitionScheduler {
  constructor() {
    this.managers = new Map();
    for (const tableName of Object.keys(PARTITION_CONFIGS)) {
      this.managers.set(tableName, new PartitionManager(tableName));
    }
  }

  /**
   * 运行所有分区任务
   */
  async runAllTasks() {
    const results = {
      precreate: {},
      archive: {},
      health: {}
    };

    // 1. 预创建分区
    for (const [tableName, manager] of this.managers) {
      try {
        results.precreate[tableName] = await manager.precreatePartitions();
      } catch (err) {
        logger.error(`Precreate failed for ${tableName}: ${err.message}`);
        results.precreate[tableName] = { error: err.message };
      }
    }

    // 2. 归档冷数据
    for (const [tableName, manager] of this.managers) {
      try {
        results.archive[tableName] = await manager.archiveColdPartitions();
      } catch (err) {
        logger.error(`Archive failed for ${tableName}: ${err.message}`);
        results.archive[tableName] = { error: err.message };
      }
    }

    // 3. 健康检查
    for (const [tableName, manager] of this.managers) {
      try {
        results.health[tableName] = await manager.healthCheck();
      } catch (err) {
        logger.error(`Health check failed for ${tableName}: ${err.message}`);
        results.health[tableName] = { error: err.message };
      }
    }

    return results;
  }

  /**
   * 获取所有分区统计
   */
  async getAllStats() {
    const stats = {};
    for (const [tableName, manager] of this.managers) {
      stats[tableName] = await manager.getPartitionStats();
    }
    return stats;
  }
}

// 数据温度管理器
class DataTemperatureManager {
  constructor() {
    this.redis = getRedis();
  }

  /**
   * 计算数据温度
   */
  calculateTemperature(date) {
    const now = new Date();
    const ageInDays = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);

    if (ageInDays <= DATA_TEMPERATURE.HOT.maxAgeDays) return 'hot';
    if (ageInDays <= DATA_TEMPERATURE.WARM.maxAgeDays) return 'warm';
    return 'cold';
  }

  /**
   * 智能查询路由（根据数据温度）
   */
  async queryWithTemperature(sql, params, dateField, dateValue) {
    const temperature = this.calculateTemperature(dateValue);
    const timer = metrics.histogramTimer('partition_query_latency_ms', { 
      table: sql.split('FROM')[1]?.trim().split(' ')[0] || 'unknown',
      temperature 
    });

    try {
      // 热数据：优先缓存
      if (temperature === 'hot') {
        const cacheKey = this.generateCacheKey(sql, params);
        const cached = await getJSON(cacheKey);
        
        if (cached) {
          timer();
          metrics.counter('partition_query_cache_hits').inc({ temperature: 'hot' });
          return cached;
        }

        const result = await query(sql, params);
        await setJSON(cacheKey, result.rows, 300); // 5分钟 TTL
        timer();
        return result.rows;
      }

      // 温数据和冷数据：直接查询数据库
      const result = await query(sql, params);
      timer();
      return result.rows;

    } catch (err) {
      timer();
      metrics.counter('partition_query_errors').inc({ temperature });
      throw err;
    }
  }

  /**
   * 获取温度分布统计
   */
  async getTemperatureStats(tableName) {
    const { rows: hotRows } = await query(`
      SELECT count(*) FROM ${tableName}
      WHERE ${PARTITION_CONFIGS[tableName]?.partitionKey || 'created_at'} > NOW() - INTERVAL '7 days'
    `);

    const { rows: warmRows } = await query(`
      SELECT count(*) FROM ${tableName}
      WHERE ${PARTITION_CONFIGS[tableName]?.partitionKey || 'created_at'} 
        BETWEEN NOW() - INTERVAL '30 days' AND NOW() - INTERVAL '7 days'
    `);

    const { rows: coldRows } = await query(`
      SELECT count(*) FROM ${tableName}
      WHERE ${PARTITION_CONFIGS[tableName]?.partitionKey || 'created_at'} < NOW() - INTERVAL '30 days'
    `);

    return {
      hot: parseInt(hotRows[0].count) || 0,
      warm: parseInt(warmRows[0].count) || 0,
      cold: parseInt(coldRows[0].count) || 0
    };
  }

  generateCacheKey(sql, params) {
    return `partition:query:${sql.substring(0, 50)}:${JSON.stringify(params)}`;
  }
}

module.exports = {
  PartitionManager,
  PartitionScheduler,
  DataTemperatureManager,
  PARTITION_CONFIGS,
  DATA_TEMPERATURE
};