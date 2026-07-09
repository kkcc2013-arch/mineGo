// backend/shared/testUtils/DatabaseSnapshotManager.js
'use strict';

const { Pool } = require('pg');
const { createLogger } = require('../logger');

const logger = createLogger('database-snapshot');

/**
 * 数据库快照管理器
 * 用于测试隔离：测试前快照、测试后恢复
 */
class DatabaseSnapshotManager {
  constructor(config = {}) {
    this.pool = config.pool || new Pool({
      host: process.env.TEST_DB_HOST || 'localhost',
      port: process.env.TEST_DB_PORT || 5432,
      database: process.env.TEST_DB_NAME || 'minego_test',
      user: process.env.TEST_DB_USER || 'minego',
      password: process.env.TEST_DB_PASSWORD || 'minego123'
    });
    
    this.snapshots = new Map();
    this.tables = config.tables || [
      'users', 'pokemon', 'gyms', 'quests', 'achievements', 'friendships', 
      'gifts', 'payment_orders', 'catch_records', 'battle_records'
    ];
    this.snapshotPrefix = config.snapshotPrefix || 'test_snap_';
  }

  /**
   * 创建数据库快照
   * @param {string} snapshotId - 快照 ID
   * @returns {Promise<Object>} 快照信息
   */
  async createSnapshot(snapshotId) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const tablesSnapshot = {};
      const snapshotTime = new Date().toISOString();
      
      for (const table of this.tables) {
        // 保存表数据到临时表
        const tempTable = `${this.snapshotPrefix}${table}_${snapshotId}`;
        
        await client.query(`
          CREATE TEMP TABLE ${tempTable} AS 
          SELECT * FROM ${table}
        `);
        
        // 获取记录数
        const countResult = await client.query(`SELECT COUNT(*) FROM ${tempTable}`);
        tablesSnapshot[table] = {
          tempTable,
          count: parseInt(countResult.rows[0].count),
          preserved: true
        };
        
        logger.debug({ table, count: tablesSnapshot[table].count }, 'Table snapshot created');
      }
      
      // 保存快照元数据
      this.snapshots.set(snapshotId, {
        id: snapshotId,
        tables: tablesSnapshot,
        createdAt: snapshotTime
      });
      
      await client.query('COMMIT');
      
      logger.info({ snapshotId, tables: this.tables.length }, 'Database snapshot created');
      
      return {
        snapshotId,
        tables: tablesSnapshot,
        createdAt: snapshotTime
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ snapshotId, error: error.message }, 'Failed to create snapshot');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 恢复数据库快照
   * @param {string} snapshotId - 快照 ID
   * @returns {Promise<Object>} 恢复信息
   */
  async restoreSnapshot(snapshotId) {
    const snapshot = this.snapshots.get(snapshotId);
    
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }
    
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const restoreResults = {};
      
      for (const table of this.tables) {
        const tempTable = snapshot.tables[table]?.tempTable;
        
        if (!tempTable) {
          logger.warn({ table }, 'Snapshot missing for table');
          continue;
        }
        
        // 清空原表
        await client.query(`TRUNCATE TABLE ${table} CASCADE`);
        
        // 从临时表恢复数据
        await client.query(`INSERT INTO ${table} SELECT * FROM ${tempTable}`);
        
        // 删除临时表
        await client.query(`DROP TABLE ${tempTable}`);
        
        // 验证恢复记录数
        const countResult = await client.query(`SELECT COUNT(*) FROM ${table}`);
        const restoredCount = parseInt(countResult.rows[0].count);
        
        restoreResults[table] = {
          restoredCount,
          originalCount: snapshot.tables[table].count,
          success: restoredCount === snapshot.tables[table].count
        };
        
        logger.debug({ table, restoredCount }, 'Table restored');
      }
      
      await client.query('COMMIT');
      
      // 删除快照
      this.snapshots.delete(snapshotId);
      
      logger.info({ snapshotId, tables: this.tables.length }, 'Database snapshot restored');
      
      return {
        snapshotId,
        tables: restoreResults,
        restoredAt: new Date().toISOString()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ snapshotId, error: error.message }, 'Failed to restore snapshot');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 清理所有快照
   */
  async cleanupAllSnapshots() {
    const client = await this.pool.connect();
    
    try {
      for (const [snapshotId, snapshot] of this.snapshots) {
        for (const table of this.tables) {
          const tempTable = snapshot.tables[table]?.tempTable;
          if (tempTable) {
            await client.query(`DROP TABLE IF EXISTS ${tempTable}`);
          }
        }
      }
      
      this.snapshots.clear();
      logger.info('All snapshots cleaned up');
    } finally {
      client.release();
    }
  }

  /**
   * 获取快照列表
   */
  listSnapshots() {
    return Array.from(this.snapshots.keys()).map(id => ({
      id,
      createdAt: this.snapshots.get(id).createdAt,
      tables: Object.keys(this.snapshots.get(id).tables)
    }));
  }

  /**
   * 检查快照是否存在
   */
  hasSnapshot(snapshotId) {
    return this.snapshots.has(snapshotId);
  }

  /**
   * 清空数据库（用于测试初始化）
   */
  async clearDatabase() {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const table of this.tables) {
        await client.query(`TRUNCATE TABLE ${table} CASCADE`);
        logger.debug({ table }, 'Table cleared');
      }
      
      await client.query('COMMIT');
      logger.info('Database cleared');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error: error.message }, 'Failed to clear database');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 填充种子数据
   */
  async seedDatabase(seedData) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const [table, rows] of Object.entries(seedData)) {
        if (!rows || rows.length === 0) continue;
        
        const columns = Object.keys(rows[0]);
        const values = rows.map(row => columns.map(col => row[col]));
        
        const query = `
          INSERT INTO ${table} (${columns.join(', ')})
          VALUES ${rows.map((_, i) => `(${columns.map((_, j) => `$${i * columns.length + j + 1}`).join(', ')})`).join(', ')}
        `;
        
        await client.query(query, values.flat());
        
        logger.debug({ table, count: rows.length }, 'Seed data inserted');
      }
      
      await client.query('COMMIT');
      logger.info('Database seeded');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error: error.message }, 'Failed to seed database');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 关闭连接池
   */
  async close() {
    await this.pool.end();
    logger.info('Database snapshot manager closed');
  }
}

// 导出
module.exports = {
  DatabaseSnapshotManager,
  createSnapshotManager: (config) => new DatabaseSnapshotManager(config)
};