/**
 * 执行日志持久化 - 将任务执行记录存储到 PostgreSQL
 * REQ-00538: 任务执行状态实时监控与智能告警系统
 */

const { Pool } = require('pg');

class JobExecutionLogger {
  constructor(options = {}) {
    this.pool = options.pool || new Pool({
      host: process.env.PG_HOST || 'localhost',
      port: process.env.PG_PORT || 5432,
      database: process.env.PG_DATABASE || 'minego',
      user: process.env.PG_USER || 'minego',
      password: process.env.PG_PASSWORD || 'minego123',
      max: 10
    });
    this.retentionDays = options.retentionDays || 90;
    this.isInitialized = false;
  }

  /**
   * 初始化数据库表
   */
  async initialize() {
    if (this.isInitialized) return;

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS job_execution_logs (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(100) NOT NULL,
        job_name VARCHAR(200),
        category VARCHAR(50),
        status VARCHAR(20) NOT NULL,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP,
        duration_ms INTEGER,
        error_message TEXT,
        error_stack TEXT,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_execution_logs(job_id);
      CREATE INDEX IF NOT EXISTS idx_job_logs_status ON job_execution_logs(status);
      CREATE INDEX IF NOT EXISTS idx_job_logs_start_time ON job_execution_logs(start_time DESC);
      CREATE INDEX IF NOT EXISTS idx_job_logs_category ON job_execution_logs(category);
    `;

    await this.pool.query(createTableSQL);
    this.isInitialized = true;
    console.log('[JobExecutionLogger] Database initialized');
  }

  /**
   * 记录执行日志
   * @param {object} logData 执行日志数据
   */
  async log(logData) {
    if (!this.isInitialized) await this.initialize();

    const {
      jobId,
      jobName,
      category,
      status,
      startTime,
      endTime,
      durationMs,
      errorMessage,
      errorStack,
      metadata
    } = logData;

    const insertSQL = `
      INSERT INTO job_execution_logs (
        job_id, job_name, category, status, start_time, end_time,
        duration_ms, error_message, error_stack, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `;

    const values = [
      jobId,
      jobName,
      category,
      status,
      startTime,
      endTime,
      durationMs,
      errorMessage,
      errorStack,
      metadata ? JSON.stringify(metadata) : null
    ];

    const result = await this.pool.query(insertSQL, values);
    return result.rows[0].id;
  }

  /**
   * 记录任务开始
   */
  async logStart(jobId, jobName, category, startTime = new Date()) {
    return this.log({
      jobId,
      jobName,
      category,
      status: 'running',
      startTime,
      metadata: { action: 'started' }
    });
  }

  /**
   * 更新任务结束
   */
  async logEnd(jobId, logId, status, endTime = new Date(), error = null) {
    const updateSQL = `
      UPDATE job_execution_logs
      SET status = $1, end_time = $2, duration_ms = $3,
          error_message = $4, error_stack = $5
      WHERE id = $6 AND job_id = $7
    `;

    const startTime = await this.getLogStartTime(logId);
    const durationMs = startTime ? endTime.getTime() - startTime.getTime() : null;

    await this.pool.query(updateSQL, [
      status,
      endTime,
      durationMs,
      error?.message,
      error?.stack,
      logId,
      jobId
    ]);
  }

  /**
   * 获取日志开始时间
   */
  async getLogStartTime(logId) {
    const result = await this.pool.query(
      'SELECT start_time FROM job_execution_logs WHERE id = $1',
      [logId]
    );
    return result.rows[0]?.start_time;
  }

  /**
   * 查询执行历史
   * @param {string} jobId 任务ID
   * @param {object} options 查询选项
   */
  async getHistory(jobId, options = {}) {
    const { limit = 100, offset = 0, status = null, startDate = null, endDate = null } = options;

    let sql = 'SELECT * FROM job_execution_logs WHERE job_id = $1';
    const values = [jobId];
    let paramIndex = 2;

    if (status) {
      sql += ` AND status = $${paramIndex}`;
      values.push(status);
      paramIndex++;
    }

    if (startDate) {
      sql += ` AND start_time >= $${paramIndex}`;
      values.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      sql += ` AND start_time <= $${paramIndex}`;
      values.push(endDate);
      paramIndex++;
    }

    sql += ` ORDER BY start_time DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    values.push(limit, offset);

    const result = await this.pool.query(sql, values);
    return result.rows;
  }

  /**
   * 查询最近失败的日志
   * @param {string} jobId 任务ID
   * @param {number} count 数量
   */
  async getRecentFailures(jobId, count = 10) {
    const sql = `
      SELECT * FROM job_execution_logs
      WHERE job_id = $1 AND status = 'failed'
      ORDER BY start_time DESC
      LIMIT $2
    `;
    const result = await this.pool.query(sql, [jobId, count]);
    return result.rows;
  }

  /**
   * 获取所有任务的最近执行记录
   */
  async getAllRecentLogs(limit = 50) {
    const sql = `
      SELECT * FROM job_execution_logs
      ORDER BY start_time DESC
      LIMIT $1
    `;
    const result = await this.pool.query(sql, [limit]);
    return result.rows;
  }

  /**
   * 获取统计数据
   * @param {string} jobId 任务ID
   * @param {object} period 时间范围
   */
  async getStatistics(jobId, period = {}) {
    const { startDate, endDate } = period;
    const defaultStart = startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 默认7天
    const defaultEnd = endDate || new Date();

    const sql = `
      SELECT
        COUNT(*) as total_runs,
        COUNT(*) FILTER (WHERE status = 'success') as success_count,
        COUNT(*) FILTER (WHERE status = 'failed') as failure_count,
        COUNT(*) FILTER (WHERE status = 'timeout') as timeout_count,
        AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as avg_duration_ms,
        MIN(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as min_duration_ms,
        MAX(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as max_duration_ms,
        COUNT(*) FILTER (WHERE status = 'success')::float / COUNT(*)::float as success_rate
      FROM job_execution_logs
      WHERE job_id = $1 AND start_time >= $2 AND start_time <= $3
    `;

    const result = await this.pool.query(sql, [jobId, defaultStart, defaultEnd]);
    return result.rows[0];
  }

  /**
   * 获取所有任务的统计摘要
   */
  async getAllJobsStatistics(period = {}) {
    const { startDate, endDate } = period;
    const defaultStart = startDate || new Date(Date.now() - 24 * 60 * 60 * 1000); // 默认1天
    const defaultEnd = endDate || new Date();

    const sql = `
      SELECT
        job_id,
        job_name,
        category,
        COUNT(*) as total_runs,
        COUNT(*) FILTER (WHERE status = 'success') as success_count,
        COUNT(*) FILTER (WHERE status = 'failed') as failure_count,
        COUNT(*) FILTER (WHERE status = 'running') as running_count,
        AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as avg_duration_ms,
        COUNT(*) FILTER (WHERE status = 'success')::float / COUNT(*)::float as success_rate
      FROM job_execution_logs
      WHERE start_time >= $1 AND start_time <= $2
      GROUP BY job_id, job_name, category
      ORDER BY job_id
    `;

    const result = await this.pool.query(sql, [defaultStart, defaultEnd]);
    return result.rows;
  }

  /**
   * 清理过期日志
   */
  async cleanupOldLogs() {
    const cutoffDate = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);

    const sql = `
      DELETE FROM job_execution_logs
      WHERE created_at < $1
      RETURNING COUNT(*) as deleted_count
    `;

    const result = await this.pool.query(sql, [cutoffDate]);
    console.log(`[JobExecutionLogger] Cleaned up ${result.rowCount} old logs before ${cutoffDate.toISOString()}`);
    return result.rowCount;
  }

  /**
   * 获取失败类型分布
   * @param {string} jobId 任务ID
   */
  async getFailureDistribution(jobId, period = {}) {
    const { startDate, endDate } = period;
    const defaultStart = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const defaultEnd = endDate || new Date();

    const sql = `
      SELECT
        error_message,
        COUNT(*) as count
      FROM job_execution_logs
      WHERE job_id = $1 AND status = 'failed' AND start_time >= $2 AND start_time <= $3
      GROUP BY error_message
      ORDER BY count DESC
      LIMIT 10
    `;

    const result = await this.pool.query(sql, [jobId, defaultStart, defaultEnd]);
    return result.rows;
  }

  /**
   * 关闭连接池
   */
  async close() {
    await this.pool.end();
    console.log('[JobExecutionLogger] Connection pool closed');
  }
}

module.exports = { JobExecutionLogger };