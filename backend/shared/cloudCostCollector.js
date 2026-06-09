// shared/cloudCostCollector.js - 云成本数据采集器
'use strict';
const { createLogger } = require('./logger');
const { costGauge, costByServiceGauge, resourceUtilizationGauge, resourceAllocatedGauge, resourceUsedGauge } = require('./costMetrics');

const logger = createLogger('cloud-cost-collector');

/**
 * 云成本数据采集器
 * 支持 AWS/阿里云/GCP 等主流云厂商
 */
class CloudCostCollector {
  constructor(config = {}) {
    this.providers = new Map();
    this.config = {
      k8sApiUrl: config.k8sApiUrl || process.env.KUBERNETES_SERVICE_HOST 
        ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
        : null,
      k8sToken: config.k8sToken || process.env.KUBERNETES_TOKEN,
      namespace: config.namespace || 'default',
      nodeCostPerCore: config.nodeCostPerCore || parseFloat(process.env.NODE_COST_PER_CORE) || 20, // USD/month
      nodeCostPerMemoryGB: config.nodeCostPerMemoryGB || parseFloat(process.env.NODE_COST_PER_MEMORY_GB) || 3, // USD/month
      ...config
    };
    this.mockMode = config.mockMode || process.env.COST_MOCK_MODE === 'true';
  }

  /**
   * 注册云提供商
   */
  registerProvider(name, adapter) {
    this.providers.set(name, adapter);
    logger.info({ provider: name }, 'Cloud provider registered');
  }

  /**
   * 采集所有云提供商的成本数据
   */
  async collectAllCosts() {
    const results = [];
    
    for (const [name, adapter] of this.providers) {
      try {
        const cost = await adapter.getCost({
          granularity: 'DAILY',
          metrics: ['UnblendedCost'],
          timePeriod: this.getTimePeriod(7)
        });
        
        const total = this.calculateTotalCost(cost);
        
        results.push({
          provider: name,
          data: cost,
          total,
          timestamp: Date.now()
        });
        
        // 更新 Prometheus 指标
        costGauge.set(
          { provider: name, resource_type: 'all', namespace: this.config.namespace, service: 'all' },
          total
        );
        
        logger.info({ provider: name, total }, 'Cost collected');
      } catch (error) {
        logger.error({ provider: name, error: error.message }, 'Failed to collect cost');
      }
    }
    
    // 如果没有真实提供商，使用模拟数据
    if (results.length === 0 && this.mockMode) {
      return this.getMockCosts();
    }
    
    return results;
  }

  /**
   * 按服务维度拆分成本
   */
  async collectCostByService(namespace = 'default') {
    const serviceCosts = new Map();
    
    try {
      // K8s 资源使用量采集
      const podMetrics = await this.getPodMetrics(namespace);
      
      // 计算成本
      for (const pod of podMetrics) {
        const cpuCostPerMonth = this.calculateCpuCost(pod.cpuUsage);
        const memCostPerMonth = this.calculateMemoryCost(pod.memoryUsage);
        
        // 转换为日成本
        const cpuCostPerDay = cpuCostPerMonth / 30;
        const memCostPerDay = memCostPerMonth / 30;
        
        const serviceName = pod.labels?.app || pod.labels?.service || 'unknown';
        const currentCost = serviceCosts.get(serviceName) || { cpu: 0, memory: 0, total: 0 };
        
        currentCost.cpu += cpuCostPerDay;
        currentCost.memory += memCostPerDay;
        currentCost.total += cpuCostPerDay + memCostPerDay;
        
        serviceCosts.set(serviceName, currentCost);
        
        // 更新 Prometheus 指标
        costByServiceGauge.set(
          { service_name: serviceName, resource_type: 'cpu' },
          cpuCostPerDay
        );
        costByServiceGauge.set(
          { service_name: serviceName, resource_type: 'memory' },
          memCostPerDay
        );
        
        // 更新资源利用率指标
        if (pod.cpuLimit) {
          const cpuUtil = pod.cpuUsage / pod.cpuLimit;
          resourceUtilizationGauge.set(
            { service: serviceName, resource_type: 'cpu', namespace },
            cpuUtil * 100
          );
        }
        if (pod.memoryLimit) {
          const memUtil = pod.memoryUsage / pod.memoryLimit;
          resourceUtilizationGauge.set(
            { service: serviceName, resource_type: 'memory', namespace },
            memUtil * 100
          );
        }
      }
      
      logger.info({ namespace, services: serviceCosts.size }, 'Service costs collected');
    } catch (error) {
      logger.error({ namespace, error: error.message }, 'Failed to collect service costs');
      
      // 返回模拟数据
      if (this.mockMode) {
        return this.getMockServiceCosts();
      }
    }
    
    return Object.fromEntries(serviceCosts);
  }

  /**
   * 获取 Pod 资源指标
   */
  async getPodMetrics(namespace) {
    if (!this.config.k8sApiUrl || !this.config.k8sToken) {
      throw new Error('Kubernetes API not configured');
    }
    
    const metricsUrl = `${this.config.k8sApiUrl}/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`;
    
    const response = await fetch(metricsUrl, {
      headers: { 
        'Authorization': `Bearer ${this.config.k8sToken}`,
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`K8s Metrics API returned ${response.status}`);
    }
    
    const data = await response.json();
    
    return data.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      labels: item.metadata.labels || {},
      cpuUsage: this.parseCpu(item.containers?.[0]?.usage?.cpu || '0m'),
      memoryUsage: this.parseMemory(item.containers?.[0]?.usage?.memory || '0Mi'),
      cpuLimit: this.parseCpu(item.containers?.[0]?.resources?.limits?.cpu || '0'),
      memoryLimit: this.parseMemory(item.containers?.[0]?.resources?.limits?.memory || '0Mi')
    }));
  }

  /**
   * 解析 CPU 字符串
   */
  parseCpu(cpuStr) {
    if (!cpuStr || cpuStr === '0') return 0;
    // 转换 "100m" -> 0.1 cores, "1" -> 1 core
    if (cpuStr.endsWith('m')) {
      return parseInt(cpuStr) / 1000;
    }
    if (cpuStr.endsWith('n')) {
      return parseInt(cpuStr) / 1000000000;
    }
    return parseFloat(cpuStr);
  }

  /**
   * 解析内存字符串
   */
  parseMemory(memStr) {
    if (!memStr || memStr === '0') return 0;
    const units = {
      'Ki': 1024,
      'Mi': 1024 * 1024,
      'Gi': 1024 * 1024 * 1024,
      'Ti': 1024 * 1024 * 1024 * 1024
    };
    
    for (const [unit, multiplier] of Object.entries(units)) {
      if (memStr.endsWith(unit)) {
        return parseFloat(memStr) * multiplier;
      }
    }
    
    return parseFloat(memStr);
  }

  /**
   * 计算 CPU 成本
   */
  calculateCpuCost(cpuCores) {
    // 月成本 = 核心数 * 每核成本
    return cpuCores * this.config.nodeCostPerCore;
  }

  /**
   * 计算内存成本
   */
  calculateMemoryCost(memoryBytes) {
    // 月成本 = GB 数 * 每 GB 成本
    const memoryGB = memoryBytes / (1024 * 1024 * 1024);
    return memoryGB * this.config.nodeCostPerMemoryGB;
  }

  /**
   * 获取时间范围
   */
  getTimePeriod(days = 7) {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    
    return {
      Start: start.toISOString().split('T')[0],
      End: end.toISOString().split('T')[0]
    };
  }

  /**
   * 计算总成本
   */
  calculateTotalCost(costData) {
    if (!Array.isArray(costData)) return 0;
    
    return costData.reduce((sum, item) => {
      const amount = item.Total?.UnblendedCost?.Amount || item.amount || 0;
      return sum + parseFloat(amount);
    }, 0);
  }

  /**
   * 获取模拟成本数据
   */
  getMockCosts() {
    const mockData = [{
      provider: 'mock',
      data: [
        { date: new Date().toISOString().split('T')[0], amount: 50 + Math.random() * 20 }
      ],
      total: 50 + Math.random() * 20,
      timestamp: Date.now()
    }];
    
    costGauge.set(
      { provider: 'mock', resource_type: 'all', namespace: this.config.namespace, service: 'all' },
      mockData[0].total
    );
    
    return mockData;
  }

  /**
   * 获取模拟服务成本数据
   */
  getMockServiceCosts() {
    const services = [
      'user-service',
      'location-service', 
      'pokemon-service',
      'catch-service',
      'gym-service',
      'social-service',
      'reward-service',
      'payment-service',
      'gateway'
    ];
    
    const costs = {};
    
    for (const service of services) {
      const cpuCost = 1 + Math.random() * 3;
      const memCost = 0.5 + Math.random() * 1.5;
      costs[service] = {
        cpu: cpuCost,
        memory: memCost,
        total: cpuCost + memCost
      };
      
      costByServiceGauge.set(
        { service_name: service, resource_type: 'cpu' },
        cpuCost
      );
      costByServiceGauge.set(
        { service_name: service, resource_type: 'memory' },
        memCost
      );
    }
    
    return costs;
  }
}

/**
 * AWS Cost Explorer 适配器
 */
class AWSCostAdapter {
  constructor(config = {}) {
    this.config = config;
    this.accessKeyId = config.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
    this.secretAccessKey = config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
    this.region = config.region || process.env.AWS_REGION || 'us-east-1';
  }

  async getCost(params) {
    // 简化实现：实际应调用 AWS Cost Explorer API
    // 这里返回模拟数据用于演示
    if (!this.accessKeyId) {
      throw new Error('AWS credentials not configured');
    }
    
    // 模拟 API 调用延迟
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const days = Math.ceil(
      (new Date(params.timePeriod.End) - new Date(params.timePeriod.Start)) / (1000 * 60 * 60 * 24)
    );
    
    // 返回模拟数据
    const results = [];
    const start = new Date(params.timePeriod.Start);
    
    for (let i = 0; i < days; i++) {
      const date = new Date(start);
      date.setDate(date.getDate() + i);
      
      results.push({
        TimePeriod: {
          Start: date.toISOString().split('T')[0],
          End: date.toISOString().split('T')[0]
        },
        Total: {
          UnblendedCost: {
            Amount: (15 + Math.random() * 10).toFixed(2),
            Unit: 'USD'
          }
        }
      });
    }
    
    return results;
  }
}

/**
 * 阿里云成本适配器
 */
class AliCloudCostAdapter {
  constructor(config = {}) {
    this.config = config;
    this.accessKeyId = config.accessKeyId || process.env.ALIYUN_ACCESS_KEY_ID;
    this.accessKeySecret = config.accessKeySecret || process.env.ALIYUN_ACCESS_KEY_SECRET;
  }

  async getCost(params) {
    if (!this.accessKeyId || !this.accessKeySecret) {
      throw new Error('Aliyun credentials not configured');
    }
    
    // 模拟 API 调用延迟
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 返回模拟数据
    const days = Math.ceil(
      (new Date(params.timePeriod.End) - new Date(params.timePeriod.Start)) / (1000 * 60 * 60 * 24)
    );
    
    const results = [];
    const start = new Date(params.timePeriod.Start);
    
    for (let i = 0; i < days; i++) {
      const date = new Date(start);
      date.setDate(date.getDate() + i);
      
      results.push({
        date: date.toISOString().split('T')[0],
        amount: (10 + Math.random() * 8).toFixed(2),
        currency: 'USD'
      });
    }
    
    return results;
  }
}

/**
 * Mock 成本适配器（用于测试和开发）
 */
class MockCostAdapter {
  constructor(config = {}) {
    this.config = config;
    this.baseCost = config.baseCost || 50;
  }

  async getCost(params) {
    const days = Math.ceil(
      (new Date(params.timePeriod.End) - new Date(params.timePeriod.Start)) / (1000 * 60 * 60 * 24)
    );
    
    const results = [];
    const start = new Date(params.timePeriod.Start);
    
    for (let i = 0; i < days; i++) {
      const date = new Date(start);
      date.setDate(date.getDate() + i);
      
      results.push({
        TimePeriod: {
          Start: date.toISOString().split('T')[0],
          End: date.toISOString().split('T')[0]
        },
        Total: {
          UnblendedCost: {
            Amount: (this.baseCost + Math.random() * 20).toFixed(2),
            Unit: 'USD'
          }
        }
      });
    }
    
    return results;
  }
}

module.exports = {
  CloudCostCollector,
  AWSCostAdapter,
  AliCloudCostAdapter,
  MockCostAdapter
};
