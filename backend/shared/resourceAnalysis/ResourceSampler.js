/**
 * REQ-00506: 容器资源智能利用率分析系统
 * Kubernetes 资源采样器
 * 
 * 功能：
 * - 从 Prometheus 查询 Pod 资源使用数据
 * - 采样 CPU/Memory 真实消耗
 * - 对比 request/limit 配置
 * - 持久化采样数据到数据库
 * 
 * @module backend/shared/resourceAnalysis/ResourceSampler
 */

'use strict';

const axios = require('axios');
const { createLogger } = require('../logger');
const { executeQuery } = require('../db');

const logger = createLogger('resource-sampler');

/**
 * Prometheus 查询配置
 */
const PROMETHEUS_CONFIG = {
  baseUrl: process.env.PROMETHEUS_URL || 'http://prometheus:9090',
  timeout: 30000,
  queries: {
    // CPU 使用量（核心数）
    cpuUsage: `sum(rate(container_cpu_usage_seconds_total{namespace="pmg", container!=""}[5m])) by (pod, container)`,
    
    // CPU 请求
    cpuRequest: `kube_pod_container_resource_requests{namespace="pmg", resource="cpu", unit="core"}`,
    
    // CPU 限制
    cpuLimit: `kube_pod_container_resource_limits{namespace="pmg", resource="cpu", unit="core"}`,
    
    // Memory 使用量（字节）
    memoryUsage: `sum(container_memory_working_set_bytes{namespace="pmg", container!=""}) by (pod, container)`,
    
    // Memory 请求
    memoryRequest: `kube_pod_container_resource_requests{namespace="pmg", resource="memory", unit="byte"}`,
    
    // Memory 限制
    memoryLimit: `kube_pod_container_resource_limits{namespace="pmg", resource="memory", unit="byte"}`
  }
};

/**
 * 采样时间范围
 */
const SAMPLE_RANGES = {
  '1h': '1h',
  '6h': '6h',
  '24h': '24h',
  '7d': '7d'
};

/**
 * 资源采样器类
 */
class ResourceSampler {
  constructor(config = {}) {
    this.prometheusUrl = config.prometheusUrl || PROMETHEUS_CONFIG.baseUrl;
    this.timeout = config.timeout || PROMETHEUS_CONFIG.timeout;
    this.axiosInstance = axios.create({
      baseURL: this.prometheusUrl,
      timeout: this.timeout
    });
  }

  /**
   * 查询 Prometheus
   * @param {string} query - PromQL 查询语句
   * @param {string} time - 查询时间点（可选）
   * @returns {Promise<Object>} 查询结果
   */
  async queryPrometheus(query, time = null) {
    try {
      const params = { query };
      if (time) {
        params.time = time;
      }

      const response = await this.axiosInstance.get('/api/v1/query', { params });
      
      if (response.data.status !== 'success') {
        throw new Error(`Prometheus query failed: ${response.data.error || 'Unknown error'}`);
      }

      return response.data.data.result;
    } catch (error) {
      logger.error({ err: error, query }, 'Failed to query Prometheus');
      throw error;
    }
  }

  /**
   * 查询 Prometheus 范围数据
   * @param {string} query - PromQL 查询语句
   * @param {string} start - 开始时间
   * @param {string} end - 结束时间
   * @param {string} step - 查询步长
   * @returns {Promise<Object>} 查询结果
   */
  async queryPrometheusRange(query, start, end, step = '5m') {
    try {
      const response = await this.axiosInstance.get('/api/v1/query_range', {
        params: { query, start, end, step }
      });

      if (response.data.status !== 'success') {
        throw new Error(`Prometheus range query failed: ${response.data.error || 'Unknown error'}`);
      }

      return response.data.data.result;
    } catch (error) {
      logger.error({ err: error, query, start, end }, 'Failed to query Prometheus range');
      throw error;
    }
  }

  /**
   * 采样所有服务的资源使用情况
   * @param {string} namespace - Kubernetes 命名空间
   * @returns {Promise<Object>} 采样结果
   */
  async sampleAllResources(namespace = 'pmg') {
    const startTime = Date.now();
    logger.info({ namespace }, 'Starting resource sampling');

    try {
      // 并行查询所有指标
      const [
        cpuUsage,
        cpuRequest,
        cpuLimit,
        memoryUsage,
        memoryRequest,
        memoryLimit
      ] = await Promise.all([
        this.queryPrometheus(PROMETHEUS_CONFIG.queries.cpuUsage),
        this.queryPrometheus(PROMETHEUS_CONFIG.queries.cpuRequest),
        this.queryPrometheus(PROMETHEUS_CONFIG.queries.cpuLimit),
        this.queryPrometheus(PROMETHEUS_CONFIG.queries.memoryUsage),
        this.queryPrometheus(PROMETHEUS_CONFIG.queries.memoryRequest),
        this.queryPrometheus(PROMETHEUS_CONFIG.queries.memoryLimit)
      ]);

      // 合并数据
      const samples = this.mergeResourceData({
        cpuUsage,
        cpuRequest,
        cpuLimit,
        memoryUsage,
        memoryRequest,
        memoryLimit
      });

      // 持久化到数据库
      await this.persistSamples(samples);

      const duration = Date.now() - startTime;
      logger.info({ 
        namespace, 
        sampleCount: samples.length, 
        duration 
      }, 'Resource sampling completed');

      return {
        success: true,
        sampleCount: samples.length,
        samples,
        timestamp: new Date().toISOString(),
        duration
      };
    } catch (error) {
      logger.error({ err: error, namespace }, 'Resource sampling failed');
      throw error;
    }
  }

  /**
   * 合并资源数据
   * @param {Object} data - 各项指标数据
   * @returns {Array} 合并后的样本数据
   */
  mergeResourceData(data) {
    const samplesMap = new Map();

    // 辅助函数：提取 pod 和 container 名称
    const getContainerKey = (metric) => {
      const pod = metric.pod || metric.pod_name;
      const container = metric.container || metric.container_name;
      return `${pod}/${container}`;
    };

    // 处理 CPU 使用
    if (data.cpuUsage) {
      data.cpuUsage.forEach(item => {
        const key = getContainerKey(item.metric);
        if (!samplesMap.has(key)) {
          samplesMap.set(key, {
            pod: item.metric.pod,
            container: item.metric.container,
            namespace: item.metric.namespace || 'pmg'
          });
        }
        const sample = samplesMap.get(key);
        sample.cpuUsage = parseFloat(item.value[1]);
      });
    }

    // 处理 CPU Request
    if (data.cpuRequest) {
      data.cpuRequest.forEach(item => {
        const key = getContainerKey(item.metric);
        const sample = samplesMap.get(key);
        if (sample) {
          sample.cpuRequest = parseFloat(item.value[1]);
        }
      });
    }

    // 处理 CPU Limit
    if (data.cpuLimit) {
      data.cpuLimit.forEach(item => {
        const key = getContainerKey(item.metric);
        const sample = samplesMap.get(key);
        if (sample) {
          sample.cpuLimit = parseFloat(item.value[1]);
        }
      });
    }

    // 处理 Memory 使用
    if (data.memoryUsage) {
      data.memoryUsage.forEach(item => {
        const key = getContainerKey(item.metric);
        const sample = samplesMap.get(key);
        if (sample) {
          sample.memoryUsage = parseFloat(item.value[1]);
        }
      });
    }

    // 处理 Memory Request
    if (data.memoryRequest) {
      data.memoryRequest.forEach(item => {
        const key = getContainerKey(item.metric);
        const sample = samplesMap.get(key);
        if (sample) {
          sample.memoryRequest = parseFloat(item.value[1]);
        }
      });
    }

    // 处理 Memory Limit
    if (data.memoryLimit) {
      data.memoryLimit.forEach(item => {
        const key = getContainerKey(item.metric);
        const sample = samplesMap.get(key);
        if (sample) {
          sample.memoryLimit = parseFloat(item.value[1]);
        }
      });
    }

    return Array.from(samplesMap.values());
  }

  /**
   * 持久化采样数据到数据库
   * @param {Array} samples - 样本数据数组
   * @returns {Promise<void>}
   */
  async persistSamples(samples) {
    const timestamp = new Date();

    for (const sample of samples) {
      await executeQuery(
        `INSERT INTO resource_samples (
          pod_name, container_name, namespace,
          cpu_usage, cpu_request, cpu_limit,
          memory_usage, memory_request, memory_limit,
          sampled_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (pod_name, container_name, sampled_at) 
        DO UPDATE SET
          cpu_usage = EXCLUDED.cpu_usage,
          cpu_request = EXCLUDED.cpu_request,
          cpu_limit = EXCLUDED.cpu_limit,
          memory_usage = EXCLUDED.memory_usage,
          memory_request = EXCLUDED.memory_request,
          memory_limit = EXCLUDED.memory_limit`,
        [
          sample.pod,
          sample.container,
          sample.namespace || 'pmg',
          sample.cpuUsage || null,
          sample.cpuRequest || null,
          sample.cpuLimit || null,
          sample.memoryUsage || null,
          sample.memoryRequest || null,
          sample.memoryLimit || null,
          timestamp
        ]
      );
    }

    logger.info({ count: samples.length }, 'Samples persisted to database');
  }

  /**
   * 获取历史采样数据
   * @param {string} serviceName - 服务名称（可选）
   * @param {number} hours - 查询最近 N 小时
   * @returns {Promise<Array>} 历史样本数据
   */
  async getHistoricalSamples(serviceName = null, hours = 24) {
    const startTime = new Date(Date.now() - hours * 3600 * 1000);
    
    let query = `
      SELECT * FROM resource_samples 
      WHERE sampled_at >= $1
    `;
    const params = [startTime];

    if (serviceName) {
      query += ` AND pod_name LIKE $2`;
      params.push(`${serviceName}%`);
    }

    query += ` ORDER BY sampled_at DESC`;

    const result = await executeQuery(query, params);
    return result.rows;
  }

  /**
   * 计算资源利用率统计
   * @param {string} serviceName - 服务名称
   * @param {number} hours - 统计时间范围（小时）
   * @returns {Promise<Object>} 统计结果
   */
  async calculateUtilizationStats(serviceName, hours = 24) {
    const samples = await this.getHistoricalSamples(serviceName, hours);

    if (samples.length === 0) {
      return {
        serviceName,
        hours,
        sampleCount: 0,
        message: 'No samples found'
      };
    }

    // 按 pod/container 聚合
    const stats = {
      serviceName,
      hours,
      sampleCount: samples.length,
      containers: []
    };

    const containerMap = new Map();
    samples.forEach(sample => {
      const key = `${sample.pod_name}/${sample.container_name}`;
      if (!containerMap.has(key)) {
        containerMap.set(key, {
          podName: sample.pod_name,
          containerName: sample.container_name,
          cpuUsages: [],
          memoryUsages: [],
          cpuRequest: sample.cpu_request,
          cpuLimit: sample.cpu_limit,
          memoryRequest: sample.memory_request,
          memoryLimit: sample.memory_limit
        });
      }
      const container = containerMap.get(key);
      if (sample.cpu_usage) container.cpuUsages.push(sample.cpu_usage);
      if (sample.memory_usage) container.memoryUsages.push(sample.memory_usage);
    });

    // 计算统计指标
    containerMap.forEach((container, key) => {
      const cpuUtilizations = container.cpuRequest
        ? container.cpuUsages.map(u => u / container.cpuRequest)
        : [];
      const memoryUtilizations = container.memoryRequest
        ? container.memoryUsages.map(u => u / container.memoryRequest)
        : [];

      stats.containers.push({
        podName: container.podName,
        containerName: container.containerName,
        cpu: {
          avg: this.average(container.cpuUsages),
          max: Math.max(...container.cpuUsages),
          min: Math.min(...container.cpuUsages),
          request: container.cpuRequest,
          limit: container.cpuLimit,
          avgUtilization: this.average(cpuUtilizations),
          maxUtilization: Math.max(...cpuUtilizations)
        },
        memory: {
          avg: this.average(container.memoryUsages),
          max: Math.max(...container.memoryUsages),
          min: Math.min(...container.memoryUsages),
          request: container.memoryRequest,
          limit: container.memoryLimit,
          avgUtilization: this.average(memoryUtilizations),
          maxUtilization: Math.max(...memoryUtilizations)
        }
      });
    });

    return stats;
  }

  /**
   * 计算平均值
   * @param {Array<number>} values - 数值数组
   * @returns {number} 平均值
   */
  average(values) {
    if (values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  /**
   * 健康检查
   * @returns {Promise<boolean>} Prometheus 是否可用
   */
  async healthCheck() {
    try {
      const response = await this.axiosInstance.get('/-/healthy');
      return response.status === 200;
    } catch (error) {
      logger.error({ err: error }, 'Prometheus health check failed');
      return false;
    }
  }
}

module.exports = ResourceSampler;
