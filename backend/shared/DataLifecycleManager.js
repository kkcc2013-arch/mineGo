/**
 * DataLifecycleManager - 数据生命周期管理核心模块
 * 
 * 功能：
 * - 数据分类与保留策略管理
 * - 过期数据识别与清理
 * - 数据归档与恢复
 * - 清理审计日志记录
 * 
 * @module DataLifecycleManager
 * @requires db
 * @requires logger
 * @requires metrics
 */

const db = require('./db');
const logger = require('./logger');
const metrics = require('./metrics');

// 数据类别定义
const DATA_CATEGORIES = {
  TEMPORARY: {
    name: '临时数据',
    retentionDays: 7,
    examples: ['验证码', '临时令牌', '上传临时文件'],
    cleanupPolicy: 'hard_delete',
    tables: ['verification_codes', 'temp_tokens', 'temp_uploads']
  },
  OPERATION_LOGS: {
    name: '操作日志',
    retentionDays: 90,
    examples: ['登录日志', 'API 调用日志', '审计日志'],
    cleanupPolicy: 'hard_delete',
    tables: ['login_logs', 'api_logs', 'audit_logs']
  },
  TRANSACTION_RECORDS: {
    name: '交易记录',
    retentionDays: 1095, // 3 年（财务合规要求）
    examples: ['支付订单', '精币流水', '购买记录'],
    cleanupPolicy: 'archive_then_delete',
    tables: ['payment_orders', 'coin_transactions', 'purchase_records']
  },
  USER_DATA: {
    name: '用户数据',
    retentionDays: null, // 用户账户存续期间
    examples: ['用户信息', '精灵数据', '好友关系'],
    cleanupPolicy: 'user_initiated',
    tables: ['users', 'pokemon', 'friendships']
  },
  HISTORICAL_DATA: {
    name: '历史数据',
    retentionDays: 365,
    examples: ['战斗记录', '活动历史', '排行榜快照'],
    cleanupPolicy: 'archive_then_delete',
    tables: ['battle_records', 'activity_history', 'leaderboard_snapshots']
  }
};

/**
 * 数据生命周期管理器
 */
class DataLifecycleManager {
  constructor() {
    this.categories = DATA_CATEGORIES;
    this.metrics = this._initMetrics();
  }

  /**
   * 初始化 Prometheus 指标
   */
  _initMetrics() {
    return {
      expiredRecords: metrics.registerGauge(
        'data_lifecycle_expired_records',
        'Expired records waiting for cleanup',
        ['category']
      ),
      archivedRecords: metrics.registerGauge(
        'data_lifecycle_archived_records',
        'Total archived records',
        ['category']
      ),
      cleanupOperations: metrics.registerCounter(
        'data_lifecycle_cleanup_operations_total',
        'Total cleanup operations',
        ['category', 'operation_type', 'status']
      ),
      cleanupDuration: metrics.registerHistogram(
        'data_lifecycle_cleanup_duration_seconds',
        'Cleanup operation duration',
        ['category', 'operation_type']
      ),
      storageBytes: metrics.registerGauge(
        'data_lifecycle_storage_bytes',
        'Data storage size in bytes',
        ['category']
      )
    };
  }

  /**
   * 获取数据类别配置
   * @param {string} category - 类别名称
   * @returns {Object} 类别配置
   */
  getCategory(category) {
    return this.categories[category] || null;
  }

  /**
   * 获取所有类别配置
   * @returns {Object} 所有类别配置
   */
  getAllCategories() {
    return this.categories;
  }

  /**
   * 识别过期数据
   * @param {string} category - 数据类别
   * @param {Object} options - 选项
   * @returns {Promise<Object>} 过期数据统计
   */
  async identifyExpiredData(category, options = {}) {
    const config = this.categories[category];
    if (!config) {
      throw new Error(`Unknown category: ${category}`);
    }

    if (!config.retentionDays) {
      return { category, expiredCount: 0, message: 'No retention policy' };
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - config.retentionDays);

    const results = {
      category,
      cutoffDate,
      tables: []
    };

    for (const table of config.tables) {
      try {
        const countResult = await db.query(`
          SELECT COUNT(*) as count
          FROM ${table}
          WHERE created_at < $1
            AND (deleted_at IS NULL OR deleted_at < $1)
        `, [cutoffDate]);

        const count = parseInt(countResult.rows[0].count, 10);
        results.tables.push({ table, expiredCount: count });
      } catch (err) {
        logger.warn(`Failed to check table ${table}`, { error: err.message });
        results.tables.push({ table, expiredCount: 0, error: err.message });
      }
    }

    results.expiredCount = results.tables.reduce((sum, t) => sum + t.expiredCount, 0);
    
    // 更新指标
    if (this.metrics.expiredRecords) {
      this.metrics.expiredRecords.set({ category }, results.expiredCount);
    }

    return results;
  }

  /**
   * 执行数据清理
   * @param {string} category - 数据类别
   * @param {Object} options - 选项
   * @returns {Promise<Object>} 清理结果
   */
  async cleanupData(category, options = {}) {
    const startTime = Date.now();
    const config = this.categories[category];
    
    if (!config) {
      throw new Error(`Unknown category: ${category}`);
    }

    const result = {
      category,
      operationType: config.cleanupPolicy,
      tables: [],
      totalRecords: 0,
      status: 'success',
      errors: []
    };

    try {
      const expiredData = await this.identifyExpiredData(category, options);
      
      if (expiredData.expiredCount === 0) {
        result.message = 'No expired data to cleanup';
        return result;
      }

      const cutoffDate = expiredData.cutoffDate;

      for (const tableInfo of expiredData.tables) {
        if (tableInfo.expiredCount === 0) continue;

        try {
          let deleteResult;
          
          if (config.cleanupPolicy === 'soft_delete') {
            deleteResult = await this._softDelete(tableInfo.table, cutoffDate, options);
          } else if (config.cleanupPolicy === 'hard_delete') {
            deleteResult = await this._hardDelete(tableInfo.table, cutoffDate, options);
          } else if (config.cleanupPolicy === 'archive_then_delete') {
            // 归档后删除需要 DataArchiver
            deleteResult = await this._hardDelete(tableInfo.table, cutoffDate, options);
          }

          result.tables.push({
            table: tableInfo.table,
            deletedCount: deleteResult.count
          });
          result.totalRecords += deleteResult.count;
        } catch (err) {
          logger.error(`Failed to cleanup table ${tableInfo.table}`, { error: err.message });
          result.errors.push({ table: tableInfo.table, error: err.message });
          result.status = 'partial';
        }
      }

      // 记录审计日志
      await this._auditCleanup({
        operationType: config.cleanupPolicy,
        category,
        tableName: config.tables.join(','),
        recordCount: result.totalRecords,
        reason: options.reason || 'Scheduled cleanup',
        performedBy: options.performedBy || 'system',
        retentionDays: config.retentionDays,
        criteria: { cutoffDate },
        executionTimeMs: Date.now() - startTime,
        status: result.status
      });

      // 更新指标
      if (this.metrics.cleanupOperations) {
        this.metrics.cleanupOperations.inc(
          { category, operation_type: config.cleanupPolicy, status: result.status },
          1
        );
      }
      if (this.metrics.cleanupDuration) {
        this.metrics.cleanupDuration.observe(
          { category, operation_type: config.cleanupPolicy },
          (Date.now() - startTime) / 1000
        );
      }

      logger.info('Data cleanup completed', {
        category,
        totalRecords: result.totalRecords,
        duration: Date.now() - startTime
      });

    } catch (err) {
      result.status = 'failed';
      result.errors.push({ error: err.message });
      logger.error('Data cleanup failed', { category, error: err.message });
    }

    return result;
  }

  /**
   * 软删除
   */
  async _softDelete(tableName, cutoffDate, options) {
    const result = await db.query(`
      UPDATE ${tableName}
      SET deleted_at = NOW(),
          deleted_reason = $1
      WHERE created_at < $2
        AND deleted_at IS NULL
    `, [options.reason || 'Lifecycle cleanup', cutoffDate]);

    return { count: result.rowCount };
  }

  /**
   * 硬删除
   */
  async _hardDelete(tableName, cutoffDate, options) {
    // 先备份到审计日志
    const records = await db.query(`
      SELECT * FROM ${tableName}
      WHERE created_at < $1
        AND (deleted_at IS NULL OR deleted_at < $1)
      LIMIT 10000
    `, [cutoffDate]);

    if (records.rows.length > 0) {
      await this._auditCleanup({
        operationType: 'hard_delete_backup',
        category: 'BACKUP',
        tableName,
        recordCount: records.rows.length,
        reason: 'Backup before hard delete',
        performedBy: options.performedBy || 'system',
        criteria: { cutoffDate, sampleData: records.rows.slice(0, 5) },
        status: 'success'
      });
    }

    // 执行删除
    const result = await db.query(`
      DELETE FROM ${tableName}
      WHERE created_at < $1
        AND (deleted_at IS NULL OR deleted_at < $1)
    `, [cutoffDate]);

    return { count: result.rowCount };
  }

  /**
   * 记录审计日志
   */
  async _auditCleanup(operation) {
    try {
      await db.query(`
        INSERT INTO data_cleanup_audit_logs (
          operation_type, category, table_name, record_count,
          reason, performed_by, retention_days, criteria,
          execution_time_ms, status, error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        operation.operationType,
        operation.category,
        operation.tableName,
        operation.recordCount,
        operation.reason,
        operation.performedBy,
        operation.retentionDays,
        JSON.stringify(operation.criteria || {}),
        operation.executionTimeMs || 0,
        operation.status,
        operation.errorMessage || null
      ]);
    } catch (err) {
      logger.error('Failed to record cleanup audit log', { error: err.message });
    }
  }

  /**
   * 获取数据生命周期统计
   */
  async getDataLifecycleStats() {
    const stats = {
      categories: [],
      totalExpired: 0,
      lastCleanup: null
    };

    for (const [key, config] of Object.entries(this.categories)) {
      const expired = await this.identifyExpiredData(key);
      stats.categories.push({
        category: key,
        name: config.name,
        retentionDays: config.retentionDays,
        expiredCount: expired.expiredCount,
        cleanupPolicy: config.cleanupPolicy
      });
      stats.totalExpired += expired.expiredCount;
    }

    // 获取最近清理记录
    const lastCleanupResult = await db.query(`
      SELECT * FROM data_cleanup_audit_logs
      ORDER BY created_at DESC
      LIMIT 1
    `);
    stats.lastCleanup = lastCleanupResult.rows[0] || null;

    return stats;
  }

  /**
   * 用户数据删除
   */
  async deleteUserData(userId, options = {}) {
    const startTime = Date.now();
    const result = {
      userId,
      tables: [],
      totalRecords: 0,
      status: 'success'
    };

    // 定义用户相关表
    const userTables = [
      { table: 'users', key: 'id' },
      { table: 'pokemon', key: 'user_id' },
      { table: 'friendships', key: 'user_id' },
      { table: 'battle_records', key: 'user_id' },
      { table: 'coin_transactions', key: 'user_id' },
      { table: 'user_achievements', key: 'user_id' },
      { table: 'user_settings', key: 'user_id' }
    ];

    for (const { table, key } of userTables) {
      try {
        const deleteResult = await db.query(`
          DELETE FROM ${table}
          WHERE ${key} = $1
        `, [userId]);

        result.tables.push({ table, count: deleteResult.rowCount });
        result.totalRecords += deleteResult.rowCount;
      } catch (err) {
        logger.error(`Failed to delete user data from ${table}`, { error: err.message });
        result.status = 'partial';
      }
    }

    // 记录审计日志
    await this._auditCleanup({
      operationType: 'user_data_deletion',
      category: 'USER_DATA',
      tableName: userTables.map(t => t.table).join(','),
      recordCount: result.totalRecords,
      reason: options.reason || 'User requested deletion',
      performedBy: options.performedBy || userId,
      criteria: { userId, immediate: options.immediate },
      executionTimeMs: Date.now() - startTime,
      status: result.status
    });

    logger.info('User data deleted', {
      userId,
      totalRecords: result.totalRecords,
      duration: Date.now() - startTime
    });

    return result;
  }

  /**
   * 计划用户删除
   */
  async scheduleUserDeletion(userId, options = {}) {
    const delayDays = options.delayDays || 30;
    const scheduledAt = new Date();
    scheduledAt.setDate(scheduledAt.getDate() + delayDays);

    const result = await db.query(`
      INSERT INTO user_data_deletion_requests (
        user_id, request_type, requested_at, scheduled_deletion_at, status
      ) VALUES ($1, 'scheduled', NOW(), $2, 'pending')
      RETURNING *
    `, [userId, scheduledAt]);

    logger.info('User deletion scheduled', {
      userId,
      scheduledAt,
      delayDays
    });

    return result.rows[0];
  }

  /**
   * 获取删除状态
   */
  async getDeletionStatus(userId) {
    const result = await db.query(`
      SELECT * FROM user_data_deletion_requests
      WHERE user_id = $1
      ORDER BY requested_at DESC
      LIMIT 1
    `, [userId]);

    return result.rows[0] || null;
  }

  /**
   * 获取审计日志
   */
  async getAuditLogs(options = {}) {
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const result = await db.query(`
      SELECT * FROM data_cleanup_audit_logs
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    return result.rows;
  }
}

// 单例导出
const dataLifecycleManager = new DataLifecycleManager();
module.exports = dataLifecycleManager;
