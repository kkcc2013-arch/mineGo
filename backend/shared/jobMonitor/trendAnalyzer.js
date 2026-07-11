/**
 * 执行趋势分析器 - 分析任务执行趋势和模式
 * REQ-00538: 任务执行状态实时监控与智能告警系统
 */

const { Pool } = require('pg');

class TrendAnalyzer {
  constructor(options = {}) {
    this.pool = options.pool || new Pool({
      host: process.env.PG_HOST || 'localhost',
      port: process.env.PG_PORT || 5432,
      database: process.env.PG_DATABASE || 'minego',
      user: process.env.PG_USER || 'minego',
      password: process.env.PG_PASSWORD || 'minego123',
      max: 10
    });
  }

  /**
   * 获取成功率趋势
   * @param {string} jobId 任务ID
   * @param {string} period 周期：hour | day | week | month
   */
  async getSuccessRateTrend(jobId, period = 'day') {
    const intervalMap = {
      hour: "date_trunc('hour', start_time)",
      day: "date_trunc('day', start_time)",
      week: "date_trunc('week', start_time)",
      month: "date_trunc('month', start_time)"
    };

    const interval = intervalMap[period] || intervalMap.day;

    const sql = `
      SELECT
        ${interval} as period_start,
        COUNT(*) as total_runs,
        COUNT(*) FILTER (WHERE status = 'success') as success_count,
        COUNT(*) FILTER (WHERE status = 'failed') as failure_count,
        ROUND(
          COUNT(*) FILTER (WHERE status = 'success')::numeric / NULLIF(COUNT(*), 0) * 100,
          2
        ) as success_rate
      FROM job_execution_logs
      WHERE job_id = $1
        AND start_time >= NOW() - INTERVAL '30 days'
      GROUP BY period_start
      ORDER BY period_start
    `;

    const result = await this.pool.query(sql, [jobId]);

    return {
      jobId,
      period,
      data: result.rows.map(row => ({
        period: row.period_start,
        totalRuns: parseInt(row.total_runs, 10),
        successCount: parseInt(row.success_count, 10),
        failureCount: parseInt(row.failure_count, 10),
        successRate: parseFloat(row.success_rate) || 0
      }))
    };
  }

  /**
   * 获取执行时长趋势
   * @param {string} jobId 任务ID
   * @param {string} period 周期
   */
  async getDurationTrend(jobId, period = 'day') {
    const intervalMap = {
      hour: "date_trunc('hour', start_time)",
      day: "date_trunc('day', start_time)",
      week: "date_trunc('week', start_time)",
      month: "date_trunc('month', start_time)"
    };

    const interval = intervalMap[period] || intervalMap.day;

    const sql = `
      SELECT
        ${interval} as period_start,
        COUNT(*) as run_count,
        AVG(duration_ms) as avg_duration_ms,
        MIN(duration_ms) as min_duration_ms,
        MAX(duration_ms) as max_duration_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) as median_duration_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_duration_ms
      FROM job_execution_logs
      WHERE job_id = $1
        AND start_time >= NOW() - INTERVAL '30 days'
        AND duration_ms IS NOT NULL
      GROUP BY period_start
      ORDER BY period_start
    `;

    const result = await this.pool.query(sql, [jobId]);

    return {
      jobId,
      period,
      data: result.rows.map(row => ({
        period: row.period_start,
        runCount: parseInt(row.run_count, 10),
        avgDurationMs: Math.round(parseFloat(row.avg_duration_ms) || 0),
        minDurationMs: parseInt(row.min_duration_ms, 10) || 0,
        maxDurationMs: parseInt(row.max_duration_ms, 10) || 0,
        medianDurationMs: Math.round(parseFloat(row.median_duration_ms) || 0),
        p95DurationMs: Math.round(parseFloat(row.p95_duration_ms) || 0)
      }))
    };
  }

  /**
   * 获取失败类型分布
   * @param {string} jobId 任务ID
   * @param {object} options 时间范围选项
   */
  async getFailureTypeDistribution(jobId, options = {}) {
    const { startDate, endDate } = options;
    const defaultStart = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const defaultEnd = endDate || new Date();

    const sql = `
      SELECT
        COALESCE(error_message, 'Unknown') as error_type,
        COUNT(*) as count,
        MIN(start_time) as first_seen,
        MAX(start_time) as last_seen
      FROM job_execution_logs
      WHERE job_id = $1
        AND status = 'failed'
        AND start_time >= $2
        AND start_time <= $3
      GROUP BY error_message
      ORDER BY count DESC
      LIMIT 20
    `;

    const result = await this.pool.query(sql, [jobId, defaultStart, defaultEnd]);

    return {
      jobId,
      total: result.rows.reduce((sum, row) => sum + parseInt(row.count, 10), 0),
      distribution: result.rows.map(row => ({
        errorType: row.error_type.substring(0, 100), // 截断长错误消息
        count: parseInt(row.count, 10),
        firstSeen: row.first_seen,
        lastSeen: row.last_seen
      }))
    };
  }

  /**
   * 获取执行热力图数据
   * @param {string} jobId 任务ID
   */
  async getExecutionHeatmap(jobId) {
    const sql = `
      SELECT
        EXTRACT(DOW FROM start_time) as day_of_week,
        EXTRACT(HOUR FROM start_time) as hour_of_day,
        COUNT(*) as run_count,
        COUNT(*) FILTER (WHERE status = 'success') as success_count,
        COUNT(*) FILTER (WHERE status = 'failed') as failure_count,
        AVG(duration_ms) as avg_duration_ms
      FROM job_execution_logs
      WHERE job_id = $1
        AND start_time >= NOW() - INTERVAL '30 days'
      GROUP BY day_of_week, hour_of_day
      ORDER BY day_of_week, hour_of_day
    `;

    const result = await this.pool.query(sql, [jobId]);

    // 转换为热力图格式 [day][hour]
    const heatmap = {};
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    for (let day = 0; day < 7; day++) {
      heatmap[dayNames[day]] = {};
      for (let hour = 0; hour < 24; hour++) {
        heatmap[dayNames[day]][hour] = {
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          avgDurationMs: 0
        };
      }
    }

    for (const row of result.rows) {
      const day = dayNames[parseInt(row.day_of_week, 10)];
      const hour = parseInt(row.hour_of_day, 10);
      heatmap[day][hour] = {
        runCount: parseInt(row.run_count, 10),
        successCount: parseInt(row.success_count, 10),
        failureCount: parseInt(row.failure_count, 10),
        avgDurationMs: Math.round(parseFloat(row.avg_duration_ms) || 0)
      };
    }

    return {
      jobId,
      heatmap,
      days: dayNames,
      hours: Array.from({ length: 24 }, (_, i) => i)
    };
  }

  /**
   * 获取所有任务的执行统计
   */
  async getAllJobsStatistics() {
    const sql = `
      SELECT
        job_id,
        job_name,
        category,
        COUNT(*) as total_runs,
        COUNT(*) FILTER (WHERE status = 'success') as success_count,
        COUNT(*) FILTER (WHERE status = 'failed') as failure_count,
        COUNT(*) FILTER (WHERE status = 'timeout') as timeout_count,
        AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as avg_duration_ms,
        MIN(start_time) as first_run,
        MAX(start_time) as last_run,
        ROUND(
          COUNT(*) FILTER (WHERE status = 'success')::numeric / NULLIF(COUNT(*), 0) * 100,
          2
        ) as success_rate
      FROM job_execution_logs
      WHERE start_time >= NOW() - INTERVAL '7 days'
      GROUP BY job_id, job_name, category
      ORDER BY total_runs DESC
    `;

    const result = await this.pool.query(sql);

    return result.rows.map(row => ({
      jobId: row.job_id,
      jobName: row.job_name,
      category: row.category,
      totalRuns: parseInt(row.total_runs, 10),
      successCount: parseInt(row.success_count, 10),
      failureCount: parseInt(row.failure_count, 10),
      timeoutCount: parseInt(row.timeout_count, 10),
      avgDurationMs: Math.round(parseFloat(row.avg_duration_ms) || 0),
      firstRun: row.first_run,
      lastRun: row.last_run,
      successRate: parseFloat(row.success_rate) || 0
    }));
  }

  /**
   * 检测异常趋势
   * @param {string} jobId 任务ID
   */
  async detectAnomalies(jobId) {
    const sql = `
      WITH recent AS (
        SELECT
          start_time,
          duration_ms,
          status,
          ROW_NUMBER() OVER (ORDER BY start_time DESC) as rn
        FROM job_execution_logs
        WHERE job_id = $1
        ORDER BY start_time DESC
        LIMIT 100
      ),
      stats AS (
        SELECT
          AVG(duration_ms) as avg_duration,
          STDDEV(duration_ms) as stddev_duration,
          COUNT(*) FILTER (WHERE status = 'failed') as failures,
          COUNT(*) as total
        FROM recent
      )
      SELECT
        r.start_time,
        r.duration_ms,
        r.status,
        s.avg_duration,
        s.stddev_duration,
        s.failures,
        s.total,
        CASE
          WHEN r.duration_ms > s.avg_duration + 3 * s.stddev_duration THEN 'duration_anomaly'
          WHEN r.status = 'failed' AND s.failures::float / NULLIF(s.total, 0) > 0.3 THEN 'failure_anomaly'
          ELSE NULL
        END as anomaly_type
      FROM recent r
      CROSS JOIN stats s
      WHERE r.duration_ms > s.avg_duration + 3 * s.stddev_duration
         OR (r.status = 'failed' AND s.failures::float / NULLIF(s.total, 0) > 0.3)
      ORDER BY r.start_time DESC
      LIMIT 20
    `;

    const result = await this.pool.query(sql, [jobId]);

    return {
      jobId,
      anomalies: result.rows.map(row => ({
        timestamp: row.start_time,
        durationMs: parseInt(row.duration_ms, 10),
        status: row.status,
        anomalyType: row.anomaly_type,
        avgDuration: Math.round(parseFloat(row.avg_duration) || 0),
        stddevDuration: Math.round(parseFloat(row.stddev_duration) || 0)
      }))
    };
  }

  /**
   * 获取执行时间预测
   * @param {string} jobId 任务ID
   */
  async predictNextExecution(jobId) {
    const sql = `
      SELECT
        start_time,
        duration_ms,
        status
      FROM job_execution_logs
      WHERE job_id = $1
        AND status = 'success'
        AND duration_ms IS NOT NULL
        AND start_time >= NOW() - INTERVAL '30 days'
      ORDER BY start_time DESC
      LIMIT 30
    `;

    const result = await this.pool.query(sql, [jobId]);

    if (result.rows.length === 0) {
      return { jobId, prediction: null, confidence: 0 };
    }

    const durations = result.rows
      .map(row => parseInt(row.duration_ms, 10))
      .filter(d => d > 0);

    if (durations.length < 3) {
      return { jobId, prediction: null, confidence: 0 };
    }

    // 计算中位数和四分位数
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    const q1 = durations[Math.floor(durations.length * 0.25)];
    const q3 = durations[Math.floor(durations.length * 0.75)];

    return {
      jobId,
      prediction: {
        estimatedDurationMs: median,
        minDurationMs: q1,
        maxDurationMs: q3
      },
      confidence: Math.min(100, Math.round(durations.length * 3 + 40)),
      sampleSize: durations.length
    };
  }

  /**
   * 关闭连接池
   */
  async close() {
    await this.pool.end();
  }
}

module.exports = { TrendAnalyzer };