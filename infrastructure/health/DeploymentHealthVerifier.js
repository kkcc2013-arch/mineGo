/**
 * 部署健康验证服务
 * 在生产环境部署后自动执行多层级健康检查
 * 
 * @module infrastructure/health/DeploymentHealthVerifier
 * @requires events
 */

'use strict';

const EventEmitter = require('events');
const BusinessLinkValidator = require('./BusinessLinkValidator');

/**
 * 部署健康验证器
 * 执行部署后的自动化健康验证
 */
class DeploymentHealthVerifier extends EventEmitter {
  /**
   * 构造函数
   * @param {Object} config - 配置对象
   * @param {string[]} config.services - 需要验证的服务列表
   * @param {number} config.timeout - 验证超时时间（毫秒）
   * @param {number} config.retryCount - 重试次数
   */
  constructor(config = {}) {
    super();
    this.config = config;
    this.services = config.services || [
      'gateway', 'user-service', 'location-service', 
      'pokemon-service', 'catch-service', 'gym-service',
      'social-service', 'reward-service', 'payment-service'
    ];
    this.timeout = config.timeout || 30000;
    this.retryCount = config.retryCount || 3;
    this.results = new Map();
    
    // 服务端口映射
    this.servicePorts = {
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
    
    // 服务依赖关系
    this.dependencyMap = {
      'gateway': ['user-service', 'pokemon-service', 'catch-service', 'gym-service'],
      'user-service': ['database', 'redis'],
      'pokemon-service': ['database', 'redis'],
      'catch-service': ['location-service', 'database'],
      'gym-service': ['kafka', 'database'],
      'location-service': ['redis'],
      'social-service': ['database', 'redis'],
      'reward-service': ['database'],
      'payment-service': ['database', 'redis']
    };
    
    // 关键服务列表
    this.criticalServices = ['gateway', 'user-service', 'catch-service'];
  }

  /**
   * 执行部署后健康验证
   * @param {Object} deploymentInfo - 部署信息
   * @param {string} deploymentInfo.id - 部署 ID
   * @param {string} deploymentInfo.environment - 环境（production/staging）
   * @param {string} deploymentInfo.version - 版本号
   * @returns {Promise<Object>} 验证结果
   */
  async verify(deploymentInfo) {
    const startTime = Date.now();
    
    console.log(`[DeploymentHealthVerifier] Starting verification for deployment ${deploymentInfo.id}`);
    
    const verificationResults = {
      deploymentId: deploymentInfo.id,
      environment: deploymentInfo.environment || 'production',
      version: deploymentInfo.version,
      timestamp: startTime,
      services: {},
      businessLinks: {},
      dependencies: {},
      overallSuccess: true,
      rollbackRequired: false,
      issues: [],
      cascadeImpact: null
    };

    try {
      // 1. 端口健康检查
      await this.verifyPorts(verificationResults);

      // 2. API 响应检查
      await this.verifyAPIs(verificationResults);

      // 3. 数据库连接检查
      await this.verifyDatabaseConnections(verificationResults);

      // 4. 缓存连接检查
      await this.verifyCacheConnections(verificationResults);

      // 5. Kafka 连通性检查
      await this.verifyKafkaConnections(verificationResults);

      // 6. 业务链路验证
      await this.verifyBusinessLinks(verificationResults);

      // 7. 级联影响分析
      await this.analyzeCascadeImpact(verificationResults);

      // 8. 综合判断
      verificationResults.overallSuccess = this.determineOverallSuccess(verificationResults);
      verificationResults.rollbackRequired = this.shouldTriggerRollback(verificationResults);

      verificationResults.duration = Date.now() - startTime;
      
      this.emit('verification:complete', verificationResults);
      
      console.log(`[DeploymentHealthVerifier] Verification completed in ${verificationResults.duration}ms`);
      
      return verificationResults;
    } catch (error) {
      console.error('[DeploymentHealthVerifier] Verification error:', error);
      
      verificationResults.overallSuccess = false;
      verificationResults.rollbackRequired = true;
      verificationResults.error = error.message;
      verificationResults.duration = Date.now() - startTime;
      
      this.emit('verification:error', { deploymentInfo, error });
      
      return verificationResults;
    }
  }

  /**
   * 端口健康检查
   * @param {Object} results - 验证结果对象
   */
  async verifyPorts(results) {
    console.log('[DeploymentHealthVerifier] Verifying service ports...');
    
    for (const service of this.services) {
      const port = this.getServicePort(service);
      
      try {
        const response = await this.checkPort(port);
        
        if (!results.services[service]) results.services[service] = {};
        results.services[service].port = {
          status: response.ok ? 'ok' : 'failed',
          latency: response.latency,
          port
        };
        
        if (!response.ok) {
          results.issues.push({
            service,
            type: 'port',
            severity: 'critical',
            message: `Port ${port} unreachable: ${response.error || 'unknown error'}`
          });
        }
      } catch (error) {
        if (!results.services[service]) results.services[service] = {};
        results.services[service].port = {
          status: 'failed',
          port,
          error: error.message
        };
        
        results.issues.push({
          service,
          type: 'port',
          severity: 'critical',
          message: error.message
        });
      }
    }
  }

  /**
   * API 响应检查
   * @param {Object} results - 验证结果对象
   */
  async verifyAPIs(results) {
    console.log('[DeploymentHealthVerifier] Verifying API endpoints...');
    
    const criticalEndpoints = {
      'gateway': '/health',
      'user-service': '/api/users/health',
      'location-service': '/api/location/health',
      'pokemon-service': '/api/pokemon/health',
      'catch-service': '/api/catch/health',
      'gym-service': '/api/gym/health',
      'social-service': '/api/social/health',
      'reward-service': '/api/reward/health',
      'payment-service': '/api/payment/health'
    };

    for (const [service, endpoint] of Object.entries(criticalEndpoints)) {
      try {
        const response = await this.callEndpoint(service, endpoint);
        
        if (!results.services[service]) results.services[service] = {};
        results.services[service].api = {
          status: response.status === 200 ? 'ok' : 'failed',
          statusCode: response.status,
          latency: response.latency,
          endpoint
        };
        
        if (response.status !== 200) {
          results.issues.push({
            service,
            type: 'api',
            severity: 'high',
            message: `Endpoint ${endpoint} returned status ${response.status}`
          });
        }
      } catch (error) {
        if (!results.services[service]) results.services[service] = {};
        results.services[service].api = {
          status: 'failed',
          endpoint,
          error: error.message
        };
        
        results.issues.push({
          service,
          type: 'api',
          severity: 'high',
          message: `API check failed: ${error.message}`
        });
      }
    }
  }

  /**
   * 数据库连接检查
   * @param {Object} results - 验证结果对象
   */
  async verifyDatabaseConnections(results) {
    console.log('[DeploymentHealthVerifier] Verifying database connections...');
    
    const dbDependentServices = ['user-service', 'pokemon-service', 'catch-service', 'gym-service', 'social-service', 'payment-service'];
    
    for (const service of dbDependentServices) {
      try {
        const response = await this.callEndpoint(service, '/api/health/database');
        
        if (!results.services[service]) results.services[service] = {};
        results.services[service].database = {
          status: response.body?.connected ? 'ok' : 'failed',
          latency: response.latency,
          details: response.body
        };
        
        if (!response.body?.connected) {
          results.issues.push({
            service,
            type: 'database',
            severity: 'critical',
            message: 'Database connection failed'
          });
        }
      } catch (error) {
        if (!results.services[service]) results.services[service] = {};
        results.services[service].database = {
          status: 'failed',
          error: error.message
        };
        
        results.issues.push({
          service,
          type: 'database',
          severity: 'critical',
          message: `Database check failed: ${error.message}`
        });
      }
    }
  }

  /**
   * 缓存连接检查
   * @param {Object} results - 验证结果对象
   */
  async verifyCacheConnections(results) {
    console.log('[DeploymentHealthVerifier] Verifying cache connections...');
    
    try {
      const redisHealth = await this.checkRedis();
      results.dependencies.redis = {
        status: redisHealth.ok ? 'ok' : 'failed',
        latency: redisHealth.latency,
        details: redisHealth.details || {}
      };
      
      if (!redisHealth.ok) {
        results.issues.push({
          type: 'cache',
          severity: 'high',
          message: 'Redis connection failed'
        });
      }
    } catch (error) {
      results.dependencies.redis = {
        status: 'failed',
        error: error.message
      };
      
      results.issues.push({
        type: 'cache',
        severity: 'high',
        message: `Redis check failed: ${error.message}`
      });
    }
  }

  /**
   * Kafka 连通性检查
   * @param {Object} results - 验证结果对象
   */
  async verifyKafkaConnections(results) {
    console.log('[DeploymentHealthVerifier] Verifying Kafka connections...');
    
    try {
      const kafkaHealth = await this.checkKafka();
      results.dependencies.kafka = {
        status: kafkaHealth.ok ? 'ok' : 'failed',
        topics: kafkaHealth.topics || [],
        latency: kafkaHealth.latency
      };
      
      if (!kafkaHealth.ok) {
        results.issues.push({
          type: 'kafka',
          severity: 'high',
          message: 'Kafka connection failed'
        });
      }
    } catch (error) {
      results.dependencies.kafka = {
        status: 'failed',
        error: error.message
      };
      
      results.issues.push({
        type: 'kafka',
        severity: 'high',
        message: `Kafka check failed: ${error.message}`
      });
    }
  }

  /**
   * 业务链路验证
   * @param {Object} results - 验证结果对象
   */
  async verifyBusinessLinks(results) {
    console.log('[DeploymentHealthVerifier] Verifying business links...');
    
    const validator = new BusinessLinkValidator({
      timeout: this.timeout / 3,
      servicePorts: this.servicePorts
    });
    
    // 定义核心业务链路
    const links = [
      {
        name: 'registration',
        description: '用户注册链路',
        steps: ['gateway', 'user-service', 'database']
      },
      {
        name: 'login',
        description: '用户登录链路',
        steps: ['gateway', 'user-service', 'redis', 'database']
      },
      {
        name: 'catch',
        description: '精灵捕捉链路',
        steps: ['gateway', 'location-service', 'catch-service', 'database']
      },
      {
        name: 'battle',
        description: '道馆对战链路',
        steps: ['gateway', 'gym-service', 'kafka', 'database']
      },
      {
        name: 'payment',
        description: '支付流程链路',
        steps: ['gateway', 'payment-service', 'database', 'redis']
      }
    ];

    for (const link of links) {
      try {
        const linkResult = await validator.validateLink(link);
        results.businessLinks[link.name] = {
          ...linkResult,
          description: link.description
        };
        
        if (!linkResult.success) {
          results.issues.push({
            type: 'businessLink',
            severity: 'high',
            link: link.name,
            message: linkResult.error || 'Business link validation failed'
          });
        }
      } catch (error) {
        results.businessLinks[link.name] = {
          success: false,
          error: error.message,
          description: link.description
        };
        
        results.issues.push({
          type: 'businessLink',
          severity: 'high',
          link: link.name,
          message: `Business link validation error: ${error.message}`
        });
      }
    }
  }

  /**
   * 级联影响分析
   * @param {Object} results - 验证结果对象
   */
  async analyzeCascadeImpact(results) {
    console.log('[DeploymentHealthVerifier] Analyzing cascade impact...');
    
    const failedServices = results.issues
      .filter(i => i.service)
      .map(i => i.service);

    if (failedServices.length === 0) {
      results.cascadeImpact = {
        hasImpact: false,
        failed: [],
        affected: [],
        severity: 'none'
      };
      return;
    }

    // 分析上下游依赖
    const affectedServices = new Set(failedServices);
    
    for (const failed of failedServices) {
      // 查找依赖此服务的服务
      for (const [service, dependencies] of Object.entries(this.dependencyMap)) {
        if (dependencies.includes(failed)) {
          affectedServices.add(service);
        }
      }
    }

    results.cascadeImpact = {
      hasImpact: true,
      failed: [...new Set(failedServices)],
      affected: Array.from(affectedServices),
      affectedCount: affectedServices.size,
      severity: this.calculateSeverity(affectedServices.size)
    };
    
    console.log(`[DeploymentHealthVerifier] Cascade impact: ${affectedServices.size} services affected`);
  }

  /**
   * 综合判断验证是否成功
   * @param {Object} results - 验证结果对象
   * @returns {boolean}
   */
  determineOverallSuccess(results) {
    // 1. 关键服务必须全部正常
    for (const service of this.criticalServices) {
      const serviceResult = results.services[service];
      if (!serviceResult) return false;
      
      if (serviceResult.port?.status !== 'ok') return false;
      if (serviceResult.api?.status !== 'ok') return false;
    }

    // 2. 数据库和缓存必须正常
    if (results.dependencies.redis?.status !== 'ok') return false;

    // 3. 至少有 3 条业务链路正常
    const successLinks = Object.values(results.businessLinks || {})
      .filter(l => l.success);
    if (successLinks.length < 3) return false;

    // 4. 没有严重级别的 issue
    const criticalIssues = results.issues.filter(i => 
      i.severity === 'critical'
    );
    if (criticalIssues.length > 0) return false;

    return true;
  }

  /**
   * 是否触发回滚
   * @param {Object} results - 验证结果对象
   * @returns {boolean}
   */
  shouldTriggerRollback(results) {
    // 1. 关键服务端口失败必须回滚
    for (const service of this.criticalServices) {
      if (results.services[service]?.port?.status !== 'ok') {
        return true;
      }
    }

    // 2. 数据库连接失败必须回滚
    const dbFailed = results.issues.some(i => 
      i.type === 'database' && i.severity === 'critical'
    );
    if (dbFailed) return true;

    // 3. 所有业务链路失败必须回滚
    const successLinks = Object.values(results.businessLinks || {})
      .filter(l => l.success);
    if (successLinks.length === 0) return true;

    // 4. 级联影响严重必须回滚
    if (results.cascadeImpact?.severity === 'critical') {
      return true;
    }

    return false;
  }

  /**
   * 计算严重程度
   * @param {number} affectedCount - 受影响服务数量
   * @returns {string}
   */
  calculateSeverity(affectedCount) {
    if (affectedCount >= 7) return 'critical';
    if (affectedCount >= 5) return 'high';
    if (affectedCount >= 3) return 'medium';
    if (affectedCount >= 1) return 'low';
    return 'none';
  }

  /**
   * 获取服务端口
   * @param {string} service - 服务名
   * @returns {number}
   */
  getServicePort(service) {
    return this.servicePorts[service] || 8080;
  }

  /**
   * 检查端口是否可达
   * @param {number} port - 端口号
   * @returns {Promise<Object>}
   */
  async checkPort(port) {
    const start = Date.now();
    const baseUrl = process.env.SERVICE_BASE_URL || 'http://localhost';
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${baseUrl}:${port}/health`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'DeploymentHealthVerifier/1.0' }
      });
      
      clearTimeout(timeoutId);
      
      return {
        ok: response.ok,
        latency: Date.now() - start,
        status: response.status
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
   * 调用服务端点
   * @param {string} service - 服务名
   * @param {string} endpoint - 端点路径
   * @returns {Promise<Object>}
   */
  async callEndpoint(service, endpoint) {
    const port = this.getServicePort(service);
    const start = Date.now();
    const baseUrl = process.env.SERVICE_BASE_URL || 'http://localhost';
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(`${baseUrl}:${port}${endpoint}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'DeploymentHealthVerifier/1.0',
          'Accept': 'application/json'
        }
      });
      
      clearTimeout(timeoutId);
      
      const body = await response.json().catch(() => null);
      
      return {
        status: response.status,
        body,
        latency: Date.now() - start
      };
    } catch (error) {
      return {
        status: 0,
        error: error.message,
        latency: Date.now() - start
      };
    }
  }

  /**
   * 检查 Redis 连接
   * @returns {Promise<Object>}
   */
  async checkRedis() {
    const start = Date.now();
    
    try {
      // 如果有 Redis 客户端，执行 ping
      if (this.config.redisClient) {
        await this.config.redisClient.ping();
        return {
          ok: true,
          latency: Date.now() - start,
          details: { connected: true }
        };
      }
      
      // 否则通过健康检查端点
      const response = await this.callEndpoint('gateway', '/api/health/redis');
      return {
        ok: response.body?.connected || false,
        latency: response.latency,
        details: response.body || {}
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
   * 检查 Kafka 连接
   * @returns {Promise<Object>}
   */
  async checkKafka() {
    const start = Date.now();
    
    try {
      // 通过健康检查端点
      const response = await this.callEndpoint('gateway', '/api/health/kafka');
      
      return {
        ok: response.body?.connected || false,
        topics: response.body?.topics || [],
        latency: response.latency
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
   * 生成验证报告
   * @param {Object} results - 验证结果
   * @returns {string}
   */
  generateReport(results) {
    const lines = [];
    
    lines.push('========================================');
    lines.push(`Deployment Health Verification Report`);
    lines.push(`Deployment ID: ${results.deploymentId}`);
    lines.push(`Environment: ${results.environment}`);
    lines.push(`Timestamp: ${new Date(results.timestamp).toISOString()}`);
    lines.push(`Duration: ${results.duration}ms`);
    lines.push('========================================');
    lines.push('');
    
    lines.push(`Overall Status: ${results.overallSuccess ? '✅ PASSED' : '❌ FAILED'}`);
    lines.push(`Rollback Required: ${results.rollbackRequired ? '⚠️ YES' : '✓ NO'}`);
    lines.push('');
    
    lines.push('Service Health:');
    for (const [service, health] of Object.entries(results.services)) {
      const portStatus = health.port?.status === 'ok' ? '✓' : '✗';
      const apiStatus = health.api?.status === 'ok' ? '✓' : '✗';
      lines.push(`  ${service}: Port[${portStatus}] API[${apiStatus}]`);
    }
    lines.push('');
    
    lines.push('Dependencies:');
    lines.push(`  Redis: ${results.dependencies.redis?.status === 'ok' ? '✓ OK' : '✗ FAILED'}`);
    lines.push(`  Kafka: ${results.dependencies.kafka?.status === 'ok' ? '✓ OK' : '✗ FAILED'}`);
    lines.push('');
    
    lines.push('Business Links:');
    for (const [name, result] of Object.entries(results.businessLinks)) {
      const status = result.success ? '✓' : '✗';
      lines.push(`  ${status} ${name}: ${result.description}`);
    }
    lines.push('');
    
    if (results.issues.length > 0) {
      lines.push('Issues Found:');
      for (const issue of results.issues) {
        lines.push(`  [${issue.severity.toUpperCase()}] ${issue.type}: ${issue.message}`);
      }
      lines.push('');
    }
    
    if (results.cascadeImpact?.hasImpact) {
      lines.push('Cascade Impact:');
      lines.push(`  Severity: ${results.cascadeImpact.severity}`);
      lines.push(`  Failed Services: ${results.cascadeImpact.failed.join(', ')}`);
      lines.push(`  Affected Services: ${results.cascadeImpact.affected.join(', ')}`);
    }
    
    return lines.join('\n');
  }
}

module.exports = DeploymentHealthVerifier;
