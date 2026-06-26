/**
 * 数据库分区表数据迁移工具
 * REQ-00323: 数据库分区表与大数据量表分区策略
 */

const { Pool } = require('pg');
const logger = require('../shared/logger');

class PartitionMigrator {
  constructor(pool = null) {
    this.pool = pool || new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'minego',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'password'
    });
  }

  /**
   * 将数据从原表迁移到分区表
   * @param {string} sourceTable - 原表名
   * @param {string} targetTable - 分区表名
   * @param {number} batchSize - 每批迁移数量
   * @param {string} dateColumn - 日期字段名称
   */
  async migrateTable(sourceTable, targetTable, batchSize = 10000, dateColumn = 'created_at') {
    let offset = 0;
    let totalMigrated = 0;
    let hasMore = true;

    logger.info(`Starting migration from ${sourceTable} to ${targetTable}`);

    while (hasMore) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // 批量读取数据
        const { rows } = await client.query(`
          SELECT * FROM ${sourceTable}
          ORDER BY ${dateColumn}
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
        logger.error(`Migration batch failed: ${error.message}`, { error });
        throw error;
      } finally {
        client.release();
      }
    }

    logger.info(`Migration completed: ${totalMigrated} rows migrated from ${sourceTable} to ${targetTable}`);
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
      logger.error(`Data mismatch: source=${sourceTotal}, target=${targetTotal}`);
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
      logger.error(`Failed to swap tables: ${error.message}`, { error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 批量迁移所有表
   */
  async migrateAllTables() {
    const tables = [
      { source: 'catch_records', target: 'catch_records_partitioned', dateColumn: 'created_at' },
      { source: 'battle_logs', target: 'battle_logs_partitioned', dateColumn: 'battle_time' },
      { source: 'user_activities', target: 'user_activities_partitioned', dateColumn: 'activity_time' },
      { source: 'pokemon_location_history', target: 'pokemon_location_history_partitioned', dateColumn: 'recorded_at' },
      { source: 'audit_logs', target: 'audit_logs_partitioned', dateColumn: 'created_at' },
      { source: 'notifications', target: 'notifications_partitioned', dateColumn: 'created_at' }
    ];

    const results = [];

    for (const table of tables) {
      try {
        logger.info(`Starting migration for ${table.source}`);
        
        // 检查源表是否存在
        const checkResult = await this.pool.query(`
          SELECT EXISTS (
            SELECT FROM pg_tables 
            WHERE schemaname = 'public' 
            AND tablename = $1
          ) as exists
        `, [table.source]);

        if (!checkResult.rows[0].exists) {
          logger.warn(`Source table ${table.source} does not exist, skipping`);
          results.push({ table: table.source, status: 'skipped', reason: 'source_not_found' });
          continue;
        }

        // 迁移数据
        const migratedCount = await this.migrateTable(table.source, table.target, 5000, table.dateColumn);
        
        // 验证迁移
        await this.verifyMigration(table.source, table.target);
        
        results.push({ 
          table: table.source, 
          status: 'success', 
          migratedCount 
        });
      } catch (error) {
        logger.error(`Migration failed for ${table.source}: ${error.message}`, { error });
        results.push({ 
          table: table.source, 
          status: 'failed', 
          error: error.message 
        });
      }
    }

    return results;
  }

  /**
   * 获取迁移进度
   */
  async getMigrationProgress(sourceTable, targetTable) {
    const sourceCount = await this.pool.query(`SELECT COUNT(*) FROM ${sourceTable}`);
    const targetCount = await this.pool.query(`SELECT COUNT(*) FROM ${targetTable}`);

    return {
      sourceTotal: parseInt(sourceCount.rows[0].count),
      targetTotal: parseInt(targetCount.rows[0].count),
      progress: ((parseInt(targetCount.rows[0].count) / parseInt(sourceCount.rows[0].count)) * 100).toFixed(2)
    };
  }
}

module.exports = PartitionMigrator;