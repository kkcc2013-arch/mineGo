/**
 * 全链路监控数据聚合服务
 * 负责从 Prometheus 和 Jaeger 收集数据并聚合
 */

const axios = require('axios');
const EventEmitter = require('events');

class MonitoringAggregator extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.prometheusUrl = config.prometheusUrl || process.env.PROMETHEUS_URL || 'http://localhost:9090';
    this.jaegerUrl = config.jaegerUrl || process.env.JAEGER_URL || 'http://localhost:16686';
    this.refreshInterval = config.refreshInterval || 5000; // 5秒刷新
    
    // 服务拓扑缓存
    this.serviceTopology = new Map();
    // SLA/SLO 指标缓存
    this.sloMetrics = new Map();
    // 异常指标缓存
    this.anomalyMetrics = new Map();
    
    this.isRunning = false;
    this.timer = null;
  }

  /**
   * 启动监控数据聚合
   */
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.emit('started');
    
    // 立即执行一次
    this.aggregate();
    
    // 定时刷新
    this.timer = setInterval(() => {
      this.aggregate();
    }, this.refreshInterval);
  }

  /**
   * 停止监控数据聚合
   */
  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    
    this.emit('stopped');
  }

  /**
   * 聚合所有监控数据
   */
  async aggregate() {
    try {
      await Promise.all([
        this.aggregateServiceTopology(),
        this.aggregateSLOMetrics(),
        this.aggregateAnomalyMetrics()
      ]);
      
      // 发送聚合完成事件
      this.emit('aggregated', {
        topology: this.getServiceTopology(),
        slo: this.getSLOMetrics(),
        anomalies: this.getAnomalyMetrics(),
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error('[MonitoringAggregator] Aggregation error:', error);
      this.emit('error', error);
    }
  }

  /**
   * 聚合服务拓扑数据
   */
  async aggregateServiceTopology() {
    try {
      // 从 Jaeger 获取服务依赖关系
      const services = await this.getJaegerServices();
      const topology = {
        nodes: [],
        edges: []
      };
      
      // 为每个服务获取依赖关系
      for (const service of services) {
        const dependencies = await this.getJaegerServiceDependencies(service);
        
        // 添加节点
        topology.nodes.push({
          id: service,
          name: service,
          type: this.getServiceType(service),
          status: await this.getServiceStatus(service)
        });
        
        // 添加边
        for (const dep of dependencies) {
          topology.edges.push({
            source: service,
            target: dep,
            traffic: await this.getTraffic(service, dep)
          });
        }
      }
      
      this.serviceTopology.set('current', topology);
      
    } catch (error) {
      console.error('[MonitoringAggregator] Failed to aggregate service topology:', error);
    }
  }

  /**
   * 聚合 SLO 指标
   */
  async aggregateSLOMetrics() {
    try {
      // 核心链路 SLA/SLO 指标
      const coreLinks = ['register', 'login', 'catch', 'battle'];
      
      for (const link of coreLinks) {
        const metrics = await this.getLinkMetrics(link);
        this.sloMetrics.set(link, metrics);
      }
      
    } catch (error) {
      console.error('[MonitoringAggregator] Failed to aggregate SLO metrics:', error);
    }
  }

  /**
   * 聚合异常指标
   */
  async aggregateAnomalyMetrics() {
    try {
      // 从 Prometheus 查询异常指标
      const queries = [
        { name: 'error_rate', query: 'sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)' },
        { name: 'latency_p99', query: 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service))' },
        { name: 'timeout_rate', query: 'sum(rate(http_requests_timeout_total[5m])) by (service)' }
      ];
      
      for (const { name, query } of queries) {
        const result = await this.queryPrometheus(query);
        this.anomalyMetrics.set(name, result);
      }
      
    } catch (error) {
      console.error('[MonitoringAggregator] Failed to aggregate anomaly metrics:', error);
    }
  }

  /**
   * 查询 Prometheus
   */
  async queryPrometheus(query) {
    try {
      const response = await axios.get(`${this.prometheusUrl}/api/v1/query`, {
        params: { query },
        timeout: 5000
      });
      
      if (response.data.status === 'success') {
        return response.data.data.result;
      }
      
      return [];
      
    } catch (error) {
      console.error('[MonitoringAggregator] Prometheus query error:', error.message);
      return [];
    }
  }

  /**
   * 查询 Jaeger 服务列表
   */
  async getJaegerServices() {
    try {
      const response = await axios.get(`${this.jaegerUrl}/api/services`, {
        timeout: 5000
      });
      
      return response.data.data || [];
      
    } catch (error) {
      console.error('[MonitoringAggregator] Jaeger services error:', error.message);
      return [];
    }
  }

  /**
   * 查询 Jaeger 服务依赖
   */
  async getJaegerServiceDependencies(service) {
    try {
      const response = await axios.get(`${this.jaegerUrl}/api/dependencies`, {
        params: { service },
        timeout: 5000
      });
      
      return response.data.data || [];
      
    } catch (error) {
      console.error('[MonitoringAggregator] Jaeger dependencies error:', error.message);
      return [];
    }
  }

  /**
   * 获取服务类型
   */
  getServiceType(service) {
    const typeMap = {
      'gateway': 'api-gateway',
      'user-service': 'core-service',
      'location-service': 'core-service',
      'pokemon-service': 'core-service',
      'catch-service': 'core-service',
      'gym-service': 'core-service',
      'social-service': 'core-service',
      'reward-service': 'core-service',
      'payment-service': 'core-service'
    };
    
    return typeMap[service] || 'service';
  }

  /**
   * 获取服务状态
   */
  async getServiceStatus(service) {
    try {
      const query = `up{job="${service}"} == 1`;
      const result = await this.queryPrometheus(query);
      
      return result.length > 0 ? 'healthy' : 'unhealthy';
      
    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * 获取服务间流量
   */
  async getTraffic(source, target) {
    try {
      const query = `sum(rate(http_requests_total{source="${source}",target="${target}"}[5m]))`;
      const result = await this.queryPrometheus(query);
      
      if (result.length > 0 && result[0].value) {
        return parseFloat(result[0].value[1]);
      }
      
      return 0;
      
    } catch (error) {
      return 0;
    }
  }

  /**
   * 获取链路指标
   */
  async getLinkMetrics(link) {
    try {
      const latencyQuery = `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{link="${link}"}[5m])) by (le))`;
      const errorRateQuery = `sum(rate(http_requests_total{link="${link}",status=~"5.."}[5m])) / sum(rate(http_requests_total{link="${link}"}[5m]))`;
      const throughputQuery = `sum(rate(http_requests_total{link="${link}"}[5m]))`;
      
      const [latency, errorRate, throughput] = await Promise.all([
        this.queryPrometheus(latencyQuery),
        this.queryPrometheus(errorRateQuery),
        this.queryPrometheus(throughputQuery)
      ]);
      
      return {
        latency: latency.length > 0 ? parseFloat(latency[0].value[1]) * 1000 : 0, // ms
        errorRate: errorRate.length > 0 ? parseFloat(errorRate[0].value[1]) * 100 : 0, // %
        throughput: throughput.length > 0 ? parseFloat(throughput[0].value[1]) : 0, // req/s
        timestamp: Date.now()
      };
      
    } catch (error) {
      console.error('[MonitoringAggregator] Failed to get link metrics:', error);
      return {
        latency: 0,
        errorRate: 0,
        throughput: 0,
        timestamp: Date.now()
      };
    }
  }

  /**
   * 获取服务拓扑
   */
  getServiceTopology() {
    return this.serviceTopology.get('current') || { nodes: [], edges: [] };
  }

  /**
   * 获取 SLO 指标
   */
  getSLOMetrics() {
    const result = {};
    for (const [key, value] of this.sloMetrics) {
      result[key] = value;
    }
    return result;
  }

  /**
   * 获取异常指标
   */
  getAnomalyMetrics() {
    const result = {};
    for (const [key, value] of this.anomalyMetrics) {
      result[key] = value;
    }
    return result;
  }

  /**
   * 获取所有监控数据
   */
  getAllMetrics() {
    return {
      topology: this.getServiceTopology(),
      slo: this.getSLOMetrics(),
      anomalies: this.getAnomalyMetrics(),
      timestamp: Date.now()
    };
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    const checks = {
      prometheus: false,
      jaeger: false
    };
    
    try {
      await axios.get(`${this.prometheusUrl}/-/healthy`, { timeout: 2000 });
      checks.prometheus = true;
    } catch (error) {
      // Ignore
    }
    
    try {
      await axios.get(`${this.jaegerUrl}/api/services`, { timeout: 2000 });
      checks.jaeger = true;
    } catch (error) {
      // Ignore
    }
    
    return {
      healthy: checks.prometheus && checks.jaeger,
      checks
    };
  }
}

module.exports = MonitoringAggregator;
