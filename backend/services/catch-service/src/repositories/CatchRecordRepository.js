/**
 * 捕捉服务分区查询适配
 * REQ-00323: 数据库分区表与大数据量表分区策略
 */

const { Pool } = require('pg');
const { PartitionQueryHelper } = require('../../shared/partitionMiddleware');
const logger = require('../../shared/logger');

class CatchRecordRepository {
  constructor(pool = null) {
    this.pool = pool || new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'minego',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'password'
    });
    this.tableName = 'catch_records_partitioned';
  }

  /**
   * 查询用户的捕捉记录（带分区优化）
   * @param {string} userId - 用户 ID
   * @param {Object} options - 查询选项
   */
  async findByUserId(userId, options = {}) {
    const {
      startDate = null,
      endDate = null,
      limit = 50,
      offset = 0
    } = options;

    // 如果有日期范围，使用分区范围查询
    if (startDate && endDate) {
      return await PartitionQueryHelper.queryByDateRange(
        this.pool,
        this.tableName,
        startDate,
        endDate,
        {
          columns: '*',
          whereClause: 'user_id = $1',
          params: [userId],
          orderBy: 'created_at DESC',
          limit,
          offset
        }
      );
    }

    // 否则使用优化的查询（默认最近3个月）
    const query = `
      SELECT * FROM ${this.tableName}
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await PartitionQueryHelper.executeOptimized(
      this.pool,
      query,
      [userId, limit, offset],
      {
        partitionKey: 'created_at',
        forceDefaultRange: true,
        maxMonthsBack: 3
      }
    );

    return result.rows;
  }

  /**
   * 查询指定日期范围的捕捉记录
   * @param {Date} startDate - 开始日期
   * @param {Date} endDate - 结束日期
   * @param {Object} filters - 过滤条件
   */
  async findByDateRange(startDate, endDate, filters = {}) {
    const { userId, speciesId, success } = filters;

    let whereConditions = [];
    let params = [];
    let paramIndex = 1;

    if (userId) {
      whereConditions.push(`user_id = $${paramIndex++}`);
      params.push(userId);
    }

    if (speciesId) {
      whereConditions.push(`species_id = $${paramIndex++}`);
      params.push(speciesId);
    }

    if (success !== undefined) {
      whereConditions.push(`success = $${paramIndex++}`);
      params.push(success);
    }

    const whereClause = whereConditions.length > 0 
      ? whereConditions.join(' AND ')
      : '';

    return await PartitionQueryHelper.queryByDateRange(
      this.pool,
      this.tableName,
      startDate,
      endDate,
      {
        columns: '*',
        whereClause,
        params,
        orderBy: 'created_at DESC'
      }
    );
  }

  /**
   * 统计用户的捕捉记录（按日期分组）
   * @param {string} userId - 用户 ID
   * @param {Date} startDate - 开始日期
   * @param {Date} endDate - 结束日期
   */
  async getCatchStatsByDateRange(userId, startDate, endDate) {
    const partitions = PartitionQueryHelper.getApplicablePartitions(
      this.tableName,
      startDate,
      endDate
    );

    const unionQueries = partitions.map(partition => {
      return `
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as total_catches,
          COUNT(CASE WHEN success = true THEN 1 END) as successful_catches,
          AVG(experience_gained) as avg_experience
        FROM ${partition}
        WHERE user_id = $1
        GROUP BY DATE(created_at)
      `;
    });

    const query = `
      SELECT 
        date,
        SUM(total_catches) as total_catches,
        SUM(successful_catches) as successful_catches,
        AVG(avg_experience) as avg_experience
      FROM (${unionQueries.join(' UNION ALL ')}) subquery
      GROUP BY date
      ORDER BY date
    `;

    const result = await this.pool.query(query, [userId]);
    return result.rows;
  }

  /**
   * 插入捕捉记录到分区表
   * @param {Object} catchRecord - 捕捉记录数据
   */
  async insert(catchRecord) {
    const {
      userId,
      pokemonId,
      speciesId,
      locationId,
      latitude,
      longitude,
      catchMethod,
      ballUsed,
      success,
      escaped,
      experienceGained,
      bonusMultiplier,
      weather,
      timeOfDay,
      deviceId
    } = catchRecord;

    const query = `
      INSERT INTO ${this.tableName} (
        user_id, pokemon_id, species_id, location_id,
        latitude, longitude, catch_method, ball_used,
        success, escaped, experience_gained, bonus_multiplier,
        weather, time_of_day, device_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `;

    const result = await this.pool.query(query, [
      userId, pokemonId, speciesId, locationId,
      latitude, longitude, catchMethod, ballUsed,
      success, escaped, experienceGained, bonusMultiplier,
      weather, timeOfDay, deviceId
    ]);

    return result.rows[0];
  }

  /**
   * 批量插入捕捉记录
   * @param {Array} catchRecords - 捕捉记录数组
   */
  async batchInsert(catchRecords) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      for (const record of catchRecords) {
        await this.insert(record);
      }

      await client.query('COMMIT');
      
      logger.info(`Batch inserted ${catchRecords.length} catch records`);
      return { success: true, count: catchRecords.length };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Batch insert failed', { error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取捕捉记录统计信息
   * @param {Object} filters - 过滤条件
   */
  async getStats(filters = {}) {
    const { startDate, endDate, userId } = filters;

    if (!startDate || !endDate) {
      // 默认统计最近3个月
      const defaultStart = new Date();
      defaultStart.setMonth(defaultStart.getMonth() - 3);

      return await this.getStatsByDateRange(userId, defaultStart, new Date());
    }

    return await this.getCatchStatsByDateRange(userId, startDate, endDate);
  }
}

module.exports = CatchRecordRepository;