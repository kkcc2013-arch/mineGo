/**
 * backend/shared/monitorReport/MonitorDataCollector.js
 * REQ-00518: 监控数据智能摘要与自动化报告系统
 * 监控数据采集器
 */

'use strict';

const { createLogger } = require('../logger');
const axios = require('axios');

const logger = createLogger('monitor-data-collector');

/**
 * 监控数据采集器
 * 
 * 采集来源：
 * - Prometheus 指标（HTTP 响应时间、错误率、吞吐量）
 * - 服务健康状态（来自 health check）
 * - 日志异常事件（来自 REQ-00480）
 * - 资源使用率（CPU、内存、连接池）
 */
class MonitorDataCollector {
  constructor(config) {
    this.prometheusUrl = config.prometheusUrl || 'http://prometheus:9090';
    this.healthCheckUrl = config.healthCheckUrl || 'http://gateway:3000/health';
    this.services = config.services || [
      'gateway', 'user-service', 'location-service',
      'pokemon-service', 'catch-service', 'gym-service',
      'social-service', 'reward-service', 'payment-service'
    ];
    
    // 关键指标列表
    this.keyMetrics = [
      // HTTP 性能指标
      'http_request_duration_seconds',
      'http_request_errors_total',
      'http_requests_total',
      
      // 业务指标
      'pokemon_catch_attempts_total',
      'pokemon_catch_success_total',
      'gym_battles_total',
      'payment_transactions_total',
      
      // 资源指标
      'process_cpu_usage',
      'process_memory_usage_bytes',
      'db_connection_pool_size',
      'db_connection_pool_available',
      'redis_connection_pool_size',
      
      // 错误指标
      'error_rate',
      'circuit_breaker_open_count',
      'rate_limit_rejected_total'
    ];
    
    // 服务端口映射
    this.servicePorts = {
      'gateway': 3000,
      'user-service': 3001,
      'location-service': 3002,
      'pokemon-service': 3003,
      'catch-service': 3004,
      'gym-service': 3005,
      'social-service': 3006,
      'reward-service': 3007,
      'payment-service': 3008
    };
  }

  /**
   * 采集指定时间范围的监控数据
   * @param {Object} timeRange - { start: Date, end: Date }
   * @returns {Object} 监控数据
   */
  async collect(timeRange) {
    logger.info('Starting monitor data collection', { 
      start: timeRange.start.toISOString(),
      end: timeRange.end.toISOString()
    });
    
    const data = {
      timestamp: new Date(),
      timeRange,
      services: {},
      systemHealth: null,
      anomalies: [],
      resourceUsage: null,
      businessMetrics: null
    };
    
    try {
      // 1. 采集各服务性能指标
      for (const service of this.services) {
        data.services[service] = await this.collectServiceMetrics(service, timeRange);
      }
      
      // 2. 采集系统健康状态
      data.systemHealth = await this.collectSystemHealth();
      
      // 3. 采集异常事件（从日志异常检测系统）
      data.anomalies = await this.collectAnomalies(timeRange);
      
      // 4. 采集资源使用率
      data.resourceUsage = await this.collectResourceUsage(timeRange);
      
      // 5. 采集业务指标
      data.businessMetrics = await this.collectBusinessMetrics(timeRange);
      
      logger.info('Monitor data collection completed', {
        serviceCount: Object.keys(data.services).length,
        anomalyCount: data.anomalies.length
      });
      
      return data;
    } catch (error) {
      logger.error('Monitor data collection failed', { error: error.message });
      throw error;
    }
  }

  /**
   * 采集单个服务的性能指标
   */
  async collectServiceMetrics(service, timeRange) {
    const startTimestamp = Math.floor(timeRange.start.getTime() / 1000);
    const endTimestamp = Math.floor(timeRange.end.getTime() / 1000);
    
    try {
      // 从 Prometheus 查询服务指标
      const metrics = {};
      
      // HTTP 响应时间（P50, P95, P99）
      const durationQuery = `histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{service="${service}"}[${this.getDuration(timeRange)}])) by (le))`;
      const p50Result = await this.queryPrometheus(durationQuery, endTimestamp);
      metrics.responseTimeP50 = this.parsePrometheusValue(p50Result) * 1000; // 转换为 ms
      
      const p95Query = `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service="${service}"}[${this.getDuration(timeRange)}])) by (le))`;
      const p95Result = await this.queryPrometheus(p95Query, endTimestamp);
      metrics.responseTimeP95 = this.parsePrometheusValue(p95Result) * 1000;
      
      const p99Query = `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{service="${service}"}[${this.getDuration(timeRange)}])) by (le))`;
      const p99Result = await this.queryPrometheus(p99Query, endTimestamp);
      metrics.responseTimeP99 = this.parsePrometheusValue(p99Result) * 1000;
      
      // 错误率
      const errorRateQuery = `sum(rate(http_request_errors_total{service="${service}"}[${this.getDuration(timeRange)}])) / sum(rate(http_requests_total{service="${service}"}[${this.getDuration(timeRange)}]))`;
      const errorRateResult = await this.queryPrometheus(errorRateQuery, endTimestamp);
      metrics.errorRate = this.parsePrometheusValue(errorRateResult);
      
      // 吞吐量
      const throughputQuery = `sum(rate(http_requests_total{service="${service}"}[${this.getDuration(timeRange)}]))`;
      const throughputResult = await this.queryPrometheus(throughputQuery, endTimestamp);
      metrics.throughput = this.parsePrometheusValue(throughputResult);
      
      // 数据库连接池使用率
      const dbPoolQuery = `(db_connection_pool_size{service="${service}"} - db_connection_pool_available{service="${service"}) / db_connection_pool_size{service="${service}"}`;
      const dbPoolResult = await this.queryPrometheus(dbPoolQuery, endTimestamp);
      metrics.dbPoolUsage = this.parsePrometheusValue(dbPoolResult);
      
      // Redis 连接池使用率
      const redisPoolQuery = `(redis_connection_pool_used{service="${service"} / redis_connection_pool_size{service="${service}"}`;
      const redisPoolResult = await this.queryPrometheus(redisPoolQuery, endTimestamp);
      metrics.redisPoolUsage = this.parsePrometheusValue(redisPoolResult);
      
      // CPU 使用率
      const cpuQuery = `process_cpu_usage{service="${service"}`;
      const cpuResult = await this.queryPrometheus(cpuQuery, endTimestamp);
      metrics.cpuUsage = this.parsePrometheusValue(cpuResult);
      
      // 内存使用率
      const memoryQuery = `process_memory_usage_bytes{service="${service"} / process_memory_limit_bytes{service="${service"}`;
      const memoryResult = await this.queryPrometheus(memoryQuery, endTimestamp);
      metrics.memoryUsage = this.parsePrometheusValue(memoryResult);
      
      return {
        service,
        metrics,
        status: this.evaluateServiceStatus(metrics)
      };
    } catch (error) {
      logger.warn(`Failed to collect metrics for ${service}`, { error: error.message });
      return {
        service,
        metrics: null,
        status: 'unknown',
        error: error.message
      };
    }
  }

  /**
   * 采集系统整体健康状态
   */
  async collectSystemHealth() {
    try {
      const response = await axios.get(this.healthCheckUrl, { timeout: 5000 });
      return {
        overall: response.data.status || 'healthy',
        services: response.data.services || {},
        timestamp: new Date()
      };
    } catch (error) {
      logger.warn('Failed to collect system health', { error: error.message });
      return {
        overall: 'unknown',
        services: {},
        error: error.message
      };
    }
  }

  /**
   * 采集异常事件（从日志异常检测系统）
   */
  async collectAnomalies(timeRange) {
    try {
      // 查询日志异常检测系统的异常记录
      const { query } = require('../db');
      
      const result = await query(`
        SELECT 
          anomaly_type,
          service,
          severity,
          message,
          count,
          first_occurrence,
          last_occurrence
        FROM log_anomalies
        WHERE first_occurrence >= $1 
          AND first_occurrence <= $2
        ORDER BY severity DESC, count DESC
        LIMIT 50
      `, [timeRange.start, timeRange.end]);
      
      return result.rows.map(row => ({
        type: row.anomaly_type,
        service: row.service,
        severity: row.severity,
        message: row.message,
        count: row.count,
        firstOccurrence: row.first_occurrence,
        lastOccurrence: row.last_occurrence
      }));
    } catch (error) {
      logger.warn('Failed to collect anomalies', { error: error.message });
      return [];
    }
  }

  /**
   * 采集资源使用率
   */
  async collectResourceUsage(timeRange) {
    const endTimestamp = Math.floor(timeRange.end.getTime() / 1000);
    
    try {
      // CPU 使用率
      const cpuQuery = `avg(process_cpu_usage)`;
      const cpuResult = await this.queryPrometheus(cpuQuery, endTimestamp);
      
      // 内存使用率
      const memoryQuery = `avg(process_memory_usage_bytes) / avg(process_memory_limit_bytes)`;
      const memoryResult = await this.queryPrometheus(memoryQuery, endTimestamp);
      
      // 数据库连接池使用率
      const dbPoolQuery = `avg((db_connection_pool_size - db_connection_pool_available) / db_connection_pool_size)`;
      const dbPoolResult = await this.queryPrometheus(dbPoolQuery, endTimestamp);
      
      // Redis 连接池使用率
      const redisPoolQuery = `avg(redis_connection_pool_used / redis_connection_pool_size)`;
      const redisPoolResult = await this.queryPrometheus(redisPoolQuery, endTimestamp);
      
      return {
        cpuUsage: this.parsePrometheusValue(cpuResult),
        memoryUsage: this.parsePrometheusValue(memoryResult),
        dbPoolUsage: this.parsePrometheusValue(dbPoolResult),
        redisPoolUsage: this.parsePrometheusValue(redisPoolResult)
      };
    } catch (error) {
      logger.warn('Failed to collect resource usage', { error: error.message });
      return null;
    }
  }

  /**
   * 采集业务指标
   */
  async collectBusinessMetrics(timeRange) {
    const endTimestamp = Math.floor(timeRange.end.getTime() / 1000);
    const duration = this.getDuration(timeRange);
    
    try {
      // 捕捉尝试次数
      const catchAttemptsQuery = `sum(rate(pokemon_catch_attempts_total[${duration}]))`;
      const catchAttemptsResult = await this.queryPrometheus(catchAttemptsQuery, endTimestamp);
      
      // 捕捉成功次数
      const catchSuccessQuery = `sum(rate(pokemon_catch_success_total[${duration}]))`;
      const catchSuccessResult = await this.queryPrometheus(catchSuccessQuery, endTimestamp);
      
      // 捕捉成功率
      const catchRate = this.parsePrometheusValue(catchSuccessResult) / this.parsePrometheusValue(catchAttemptsResult);
      
      // 道馆战斗次数
      const gymBattlesQuery = `sum(rate(gym_battles_total[${duration}]))`;
      const gymBattlesResult = await this.queryPrometheus(gymBattlesQuery, endTimestamp);
      
      // 支付交易次数
      const paymentTxQuery = `sum(rate(payment_transactions_total[${duration}]))`;
      const paymentTxResult = await this.queryPrometheus(paymentTxQuery, endTimestamp);
      
      // 活跃用户数（估算）
      const activeUsersQuery = `count(http_requests_total)`;
      const activeUsersResult = await this.queryPrometheus(activeUsersQuery, endTimestamp);
      
      return {
        catchAttempts: this.parsePrometheusValue(catchAttemptsResult) * 3600, // 转换为每小时
        catchSuccess: this.parsePrometheusValue(catchSuccessResult) * 3600,
        catchRate: catchRate,
        gymBattles: this.parsePrometheusValue(gymBattlesResult) * 3600,
        paymentTransactions: this.parsePrometheusValue(paymentTxResult) * 3600,
        estimatedActiveUsers: this.parsePrometheusValue(activeUsersResult)
      };
    } catch (error) {
      logger.warn('Failed to collect business metrics', { error: error.message });
      return null;
    }
  }

  /**
   * 查询 Prometheus
   */
  async queryPrometheus(query, timestamp) {
    try {
      const response = await axios.get(`${this.prometheusUrl}/api/v1/query`, {
        params: {
          query,
          time: timestamp
        },
        timeout: 5000
      });
      
      return response.data.data;
    } catch (error) {
      logger.warn('Prometheus query failed', { query, error: error.message });
      return null;
    }
  }

  /**
   * 解析 Prometheus 返回值
   */
  parsePrometheusValue(data) {
    if (!data || !data.result || data.result.length === 0) {
      return 0;
    }
    
    const value = data.result[0].value[1];
    return parseFloat(value) || 0;
  }

  /**
   * 获取时间范围的 Prometheus duration 格式
   */
  getDuration(timeRange) {
    const diffMs = timeRange.end.getTime() - timeRange.start.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffHours >= 24) {
      return `${Math.floor(diffHours / 24)}d`;
    } else if (diffHours >= 1) {
      return `${diffHours}h`;
    } else {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return `${diffMinutes}m`;
    }
  }

  /**
   * 评估服务健康状态
   */
  evaluateServiceStatus(metrics) {
    if (!metrics) return 'unknown';
    
    // 根据关键指标判断状态
    if (metrics.errorRate > 0.05) return 'critical'; // 错误率 > 5%
    if (metrics.responseTimeP99 > 3000) return 'critical'; // P99 > 3s
    if (metrics.cpuUsage > 0.9) return 'critical'; // CPU > 90%
    if (metrics.memoryUsage > 0.9) return 'critical'; // 内存 > 90%
    
    if (metrics.errorRate > 0.02) return 'warning'; // 错误率 > 2%
    if (metrics.responseTimeP99 > 1500) return 'warning'; // P99 > 1.5s
    if (metrics.cpuUsage > 0.7) return 'warning'; // CPU > 70%
    
    return 'healthy';
  }
}

module.exports = MonitorDataCollector;