/**
 * 数据库分区管理器
 * REQ-00323: 数据库分区表与大数据量表分区策略
 */

const { Pool } = require('pg');
const cron = require('node-cron');
const logger = require('../shared/logger');

class PartitionManager {
  constructor(pool = null) {
    this.pool = pool || new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'minego',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'password'
    });
    
    this.cronJobs = [];
  }

  /**
   * 初始化分区管理器
   */
  async initialize() {
    try {
      // 每月1号凌晨自动创建下个月的分区
      const monthlyJob = cron.schedule('0 0 1 * *', async () => {
        logger.info('Starting monthly partition creation');
        await this.createNextMonthPartitions();
      });
      this.cronJobs.push(monthlyJob);

      // 每天凌晨2点检查并删除过期分区
      const dailyJob = cron.schedule('0 2 * * *', async () => {
        logger.info('Starting daily partition cleanup');
        await this.cleanupOldPartitions();
      });
      this.cronJobs.push(dailyJob);

      logger.info('Partition manager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize partition manager', { error });
      throw error;
    }
  }

  /**
   * 创建下个月的分区
   */
  async createNextMonthPartitions() {
    try {
      const result = await this.pool.query('SELECT auto_create_next_month_partition()');
      logger.info('Next month partitions created successfully', { result });
      
      // 发送通知
      await this.notifyPartitionCreated();
      
      return { success: true, created: true };
    } catch (error) {
      logger.error('Failed to create next month partitions', { error });
      
      // 发送告警
      await this.alertPartitionCreationFailed(error);
      
      return { success: false, error: error.message };
    }
  }

  /**
   * 清理过期分区
   */
  async cleanupOldPartitions() {
    const tables = [
      { name: 'catch_records_partitioned', retentionMonths: 12 },
      { name: 'battle_logs_partitioned', retentionMonths: 6 },
      { name: 'user_activities_partitioned', retentionMonths: 3 },
      { name: 'pokemon_location_history_partitioned', retentionMonths: 3 },
      { name: 'audit_logs_partitioned', retentionMonths: 24 },
      { name: 'notifications_partitioned', retentionMonths: 3 }
    ];

    const results = [];

    for (const table of tables) {
      try {
        await this.pool.query(
          'SELECT drop_old_partitions($1, $2)',
          [table.name, table.retentionMonths]
        );
        
        logger.info(`Cleaned up old partitions for ${table.name}`, {
          table: table.name,
          retentionMonths: table.retentionMonths
        });
        
        results.push({ table: table.name, status: 'success' });
      } catch (error) {
        logger.error(`Failed to cleanup partitions for ${table.name}`, { error });
        results.push({ table: table.name, status: 'failed', error: error.message });
      }
    }

    return results;
  }

  /**
   * 获取分区统计信息
   */
  async getPartitionStats(tableName) {
    try {
      const { rows } = await this.pool.query(
        'SELECT * FROM get_partition_stats($1)',
        [tableName]
      );
      
      return rows;
    } catch (error) {
      logger.error(`Failed to get partition stats for ${tableName}`, { error });
      throw error;
    }
  }

  /**
   * 获取所有分区表的统计信息
   */
  async getAllPartitionStats() {
    const tables = [
      'catch_records_partitioned',
      'battle_logs_partitioned',
      'user_activities_partitioned',
      'pokemon_location_history_partitioned',
      'audit_logs_partitioned',
      'notifications_partitioned'
    ];

    const stats = {};

    for (const table of tables) {
      try {
        stats[table] = await this.getPartitionStats(table);
      } catch (error) {
        stats[table] = { error: error.message };
      }
    }

    return stats;
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
      try {
        // 检查当前月份分区是否存在
        const currentMonth = new Date();
        const partitionName = `${table}_y${currentMonth.getFullYear()}_m${String(currentMonth.getMonth() + 1).padStart(2, '0')}`;
        
        const { rows } = await this.pool.query(`
          SELECT EXISTS (
            SELECT FROM pg_tables 
            WHERE tablename = $1
          ) as exists
        `, [partitionName]);

        const stats = await this.getPartitionStats(table);

        results[table] = {
          currentMonthPartitionExists: rows[0].exists,
          partitionCount: stats.length,
          totalSize: stats.reduce((sum, s) => sum + s.size_bytes, 0),
          stats
        };
      } catch (error) {
        results[table] = {
          error: error.message
        };
      }
    }

    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      tables: results
    };
  }

  /**
   * 手动创建指定月份的分区
   */
  async createSpecificPartition(tableName, year, month) {
    try {
      const partitionDate = new Date(year, month - 1, 1);
      const partitionStart = partitionDate.toISOString();
      const partitionEnd = new Date(year, month, 1).toISOString();
      const partitionName = `${tableName}_y${year}_m${String(month).padStart(2, '0')}`;

      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF ${tableName} 
         FOR VALUES FROM ($1) TO ($2)`,
        [partitionStart, partitionEnd]
      );

      // 创建索引
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS idx_${partitionName}_user_id ON ${partitionName} (user_id)`
      );
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS idx_${partitionName}_created ON ${partitionName} (created_at)`
      );

      logger.info(`Created specific partition: ${partitionName}`);
      
      return { success: true, partitionName };
    } catch (error) {
      logger.error(`Failed to create partition for ${tableName} ${year}-${month}`, { error });
      throw error;
    }
  }

  /**
   * 通知分区创建成功
   */
  async notifyPartitionCreated() {
    // 这里可以集成到消息通知系统
    logger.info('Partition creation notification sent');
  }

  /**
   * 告警分区创建失败
   */
  async alertPartitionCreationFailed(error) {
    logger.error('Partition creation failed alert', { error });
    // 这里可以集成到告警系统（如 Slack、邮件等）
  }

  /**
   * 停止所有定时任务
   */
  stop() {
    for (const job of this.cronJobs) {
      job.stop();
    }
    logger.info('Partition manager stopped');
  }

  /**
   * 获取分区健康状态摘要
   */
  async getHealthSummary() {
    const healthCheck = await this.healthCheck();
    const allStats = await this.getAllPartitionStats();
    
    const summary = {
      overallStatus: 'healthy',
      timestamp: new Date().toISOString(),
      tables: {},
      issues: []
    };

    for (const [tableName, tableStats] of Object.entries(allStats)) {
      if (tableStats.error) {
        summary.tables[tableName] = { status: 'error', error: tableStats.error };
        summary.issues.push(`${tableName}: ${tableStats.error}`);
        summary.overallStatus = 'degraded';
      } else {
        const totalSize = tableStats.reduce((sum, s) => sum + s.size_bytes, 0);
        const partitionCount = tableStats.length;
        
        summary.tables[tableName] = {
          status: 'healthy',
          partitionCount,
          totalSize,
          totalSizePretty: this.formatBytes(totalSize)
        };
      }
    }

    return summary;
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }
}

module.exports = PartitionManager;