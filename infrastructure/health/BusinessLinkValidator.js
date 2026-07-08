/**
 * 业务链路验证器
 * 验证核心业务链路的完整性
 * 
 * @module infrastructure/health/BusinessLinkValidator
 */

'use strict';

const EventEmitter = require('events');

/**
 * 业务链路验证器
 * 模拟核心业务请求验证链路完整性
 */
class BusinessLinkValidator extends EventEmitter {
  /**
   * 构造函数
   * @param {Object} config - 配置对象
   * @param {number} config.timeout - 单个链路验证超时（毫秒）
   * @param {Object} config.servicePorts - 服务端口映射
   */
  constructor(config = {}) {
    super();
    this.config = config;
    this.timeout = config.timeout || 15000;
    this.servicePorts = config.servicePorts || {
      'gateway': 8080,
      'user-service': 8081,
      'location-service': 8082,
      'pokemon-service': 8083,
      'catch-service': 8084,
      'gym-service': 8085,
      'social-service': 8086,
      'reward-service': 8087,
      'payment-service': 8088
    };
    
    // 链路端点定义
    this.linkEndpoints = {
      'registration': {
        method: 'POST',
        path: '/api/users/register',
        expectedStatus: [200, 201]
      },
      'login': {
        method: 'POST',
        path: '/api/users/login',
        expectedStatus: [200]
      },
      'catch': {
        method: 'POST',
        path: '/api/catch/attempt',
        expectedStatus: [200, 201]
      },
      'battle': {
        method: 'POST',
        path: '/api/gym/battle/start',
        expectedStatus: [200, 201]
      },
      'payment': {
        method: 'POST',
        path: '/api/payment/create',
        expectedStatus: [200, 201]
      }
    };
  }

  /**
   * 验证业务链路
   * @param {Object} link - 链路定义
   * @param {string} link.name - 链路名称
   * @param {string[]} link.steps - 链路步骤（服务列表）
   * @param {string} link.description - 链路描述
   * @returns {Promise<Object>} 验证结果
   */
  async validateLink(link) {
    const startTime = Date.now();
    
    const result = {
      name: link.name,
      description: link.description,
      success: true,
      steps: [],
      duration: 0,
      error: null
    };

    try {
      // 执行每个步骤的验证
      for (let i = 0; i < link.steps.length; i++) {
        const step = link.steps[i];
        const stepResult = await this.validateStep(step, link.name, i);
        
        result.steps.push(stepResult);
        
        if (!stepResult.success) {
          result.success = false;
          result.error = `Step ${step} failed: ${stepResult.error}`;
          break;
        }
      }

      result.duration = Date.now() - startTime;
      
      this.emit('link:validated', { link: link.name, result });
      
      return result;
    } catch (error) {
      result.success = false;
      result.error = error.message;
      result.duration = Date.now() - startTime;
      
      this.emit('link:error', { link: link.name, error });
      
      return result;
    }
  }

  /**
   * 验证单个步骤
   * @param {string} step - 步骤（服务名或依赖名）
   * @param {string} linkName - 所属链路名
   * @param {number} stepIndex - 步骤索引
   * @returns {Promise<Object>} 步骤验证结果
   */
  async validateStep(step, linkName, stepIndex) {
    const startTime = Date.now();
    
    const result = {
      step,
      index: stepIndex,
      success: true,
      latency: 0,
      error: null
    };

    try {
      // 判断是服务还是依赖
      if (step.includes('service') || step === 'gateway') {
        // 服务验证
        const healthResult = await this.checkServiceHealth(step);
        result.success = healthResult.ok;
        result.latency = healthResult.latency;
        
        if (!healthResult.ok) {
          result.error = healthResult.error || 'Service health check failed';
        }
        
        result.details = {
          type: 'service',
          status: healthResult.status,
          port: this.servicePorts[step]
        };
      } else if (step === 'database') {
        // 数据库验证
        const dbResult = await this.checkDatabaseHealth(linkName);
        result.success = dbResult.ok;
        result.latency = dbResult.latency;
        
        if (!dbResult.ok) {
          result.error = dbResult.error || 'Database health check failed';
        }
        
        result.details = {
          type: 'database',
          connected: dbResult.connected
        };
      } else if (step === 'redis') {
        // Redis 验证
        const redisResult = await this.checkRedisHealth();
        result.success = redisResult.ok;
        result.latency = redisResult.latency;
        
        if (!redisResult.ok) {
          result.error = redisResult.error || 'Redis health check failed';
        }
        
        result.details = {
          type: 'redis',
          connected: redisResult.connected
        };
      } else if (step === 'kafka') {
        // Kafka 验证
        const kafkaResult = await this.checkKafkaHealth();
        result.success = kafkaResult.ok;
        result.latency = kafkaResult.latency;
        
        if (!kafkaResult.ok) {
          result.error = kafkaResult.error || 'Kafka health check failed';
        }
        
        result.details = {
          type: 'kafka',
          connected: kafkaResult.connected
        };
      } else {
        // 未知步骤类型
        result.success = false;
        result.error = `Unknown step type: ${step}`;
      }

      result.latency = Date.now() - startTime;
      
      return result;
    } catch (error) {
      result.success = false;
      result.error = error.message;
      result.latency = Date.now() - startTime;
      
      return result;
    }
  }

  /**
   * 检查服务健康状态
   * @param {string} service - 服务名
   * @returns {Promise<Object>}
   */
  async checkServiceHealth(service) {
    const port = this.servicePorts[service] || 8080;
    const baseUrl = process.env.SERVICE_BASE_URL || 'http://localhost';
    const start = Date.now();
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${baseUrl}:${port}/health`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'BusinessLinkValidator/1.0' }
      });
      
      clearTimeout(timeoutId);
      
      return {
        ok: response.ok,
        status: response.status,
        latency: Date.now() - start
      };
    } catch (error) {
      return {
        ok: false,
        latency: Date.now() - start,
        error: error.message
      };
    }
  }

  /**
   * 检查数据库健康状态
   * @param {string} linkName - 链路名
   * @returns {Promise<Object>}
   */
  async checkDatabaseHealth(linkName) {
    const start = Date.now();
    
    try {
      // 确定查询哪个服务的数据库健康端点
      const serviceMap = {
        'registration': 'user-service',
        'login': 'user-service',
        'catch': 'catch-service',
        'battle': 'gym-service',
        'payment': 'payment-service'
      };
      
      const service = serviceMap[linkName] || 'gateway';
      const port = this.servicePorts[service] || 8080;
      const baseUrl = process.env.SERVICE_BASE_URL || 'http://localhost';
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${baseUrl}:${port}/api/health/database`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'BusinessLinkValidator/1.0' }
      });
      
      clearTimeout(timeoutId);
      
      const body = await response.json().catch(() => ({}));
      
      return {
        ok: response.ok && body.connected !== false,
        connected: body.connected !== false,
        latency: Date.now() - start
      };
    } catch (error) {
      return {
        ok: false,
        connected: false,
        latency: Date.now() - start,
        error: error.message
      };
    }
  }

  /**
   * 检查 Redis 健康状态
   * @returns {Promise<Object>}
   */
  async checkRedisHealth() {
    const start = Date.now();
    const baseUrl = process.env.SERVICE_BASE_URL || 'http://localhost';
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${baseUrl}:8080/api/health/redis`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'BusinessLinkValidator/1.0' }
      });
      
      clearTimeout(timeoutId);
      
      const body = await response.json().catch(() => ({}));
      
      return {
        ok: response.ok && body.connected !== false,
        connected: body.connected !== false,
        latency: Date.now() - start
      };
    } catch (error) {
      return {
        ok: false,
        connected: false,
        latency: Date.now() - start,
        error: error.message
      };
    }
  }

  /**
   * 检查 Kafka 健康状态
   * @returns {Promise<Object>}
   */
  async checkKafkaHealth() {
    const start = Date.now();
    const baseUrl = process.env.SERVICE_BASE_URL || 'http://localhost';
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${baseUrl}:8080/api/health/kafka`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'BusinessLinkValidator/1.0' }
      });
      
      clearTimeout(timeoutId);
      
      const body = await response.json().catch(() => ({}));
      
      return {
        ok: response.ok && body.connected !== false,
        connected: body.connected !== false,
        latency: Date.now() - start
      };
    } catch (error) {
      return {
        ok: false,
        connected: false,
        latency: Date.now() - start,
        error: error.message
      };
    }
  }

  /**
   * 批量验证多个链路
   * @param {Object[]} links - 链路定义数组
   * @returns {Promise<Object>}
   */
  async validateMultiple(links) {
    const startTime = Date.now();
    const results = {
      total: links.length,
      passed: 0,
      failed: 0,
      links: {},
      duration: 0
    };

    for (const link of links) {
      const result = await this.validateLink(link);
      results.links[link.name] = result;
      
      if (result.success) {
        results.passed++;
      } else {
        results.failed++;
      }
    }

    results.duration = Date.now() - startTime;
    
    return results;
  }
}

module.exports = BusinessLinkValidator;