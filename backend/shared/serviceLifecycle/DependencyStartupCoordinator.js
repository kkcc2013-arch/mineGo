// backend/shared/serviceLifecycle/DependencyStartupCoordinator.js
// 依赖启动协调器
'use strict';

const logger = require('../logger');
const http = require('http');
const https = require('https');

/**
 * 依赖启动协调器
 * 管理服务启动时等待依赖服务就绪
 */
class DependencyStartupCoordinator {
  constructor(lifecycleManager) {
    this.manager = lifecycleManager;
    this.config = lifecycleManager.config;
    this.dependencyStatus = new Map();
  }

  /**
   * 等待依赖服务就绪
   * @param {Array} dependencies 依赖配置列表
   */
  async waitForDependencies(dependencies) {
    if (!Array.isArray(dependencies) || dependencies.length === 0) {
      return;
    }

    const timeout = this.config.dependencyCheckTimeout || 30000;
    const startTime = Date.now();
    
    logger.info('Waiting for dependencies', {
      serviceName: this.manager.serviceName,
      dependencies: dependencies.map(d => d.name),
      timeout
    });

    const results = await Promise.allSettled(
      dependencies.map(dep => this.waitForService(dep, timeout))
    );

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      const errors = failed.map((f, i) => ({
        dependency: dependencies[i].name,
        error: f.reason?.message || 'Unknown error'
      }));
      
      throw new Error(`Dependencies not ready: ${JSON.stringify(errors)}`);
    }

    const duration = Date.now() - startTime;
    logger.info('All dependencies ready', {
      serviceName: this.manager.serviceName,
      duration,
      dependencies: dependencies.map(d => d.name)
    });
  }

  /**
   * 等待单个服务就绪
   */
  async waitForService(service, remainingTimeout) {
    const { name, url, healthPath = '/health', required = true } = service;
    const healthUrl = url + healthPath;
    
    const startTime = Date.now();
    let attempts = 0;
    const retryInterval = 2000;
    
    while (Date.now() - startTime < remainingTimeout) {
      attempts++;
      
      try {
        const isHealthy = await this.checkHealth(healthUrl);
        
        if (isHealthy) {
          this.dependencyStatus.set(name, {
            status: 'ready',
            url,
            attempts,
            readyAt: Date.now()
          });
          
          logger.info('Dependency service ready', {
            serviceName: this.manager.serviceName,
            dependency: name,
            attempts,
            duration: Date.now() - startTime
          });
          
          return true;
        }
      } catch (error) {
        logger.debug('Dependency health check failed', {
          serviceName: this.manager.serviceName,
          dependency: name,
          attempt: attempts,
          error: error.message
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
    
    // 超时
    this.dependencyStatus.set(name, {
      status: 'timeout',
      url,
      attempts,
      timeout: true
    });
    
    if (required) {
      throw new Error(`Dependency ${name} not ready after ${attempts} attempts (${remainingTimeout}ms timeout)`);
    } else {
      logger.warn(`Optional dependency ${name} not ready, continuing startup`, {
        serviceName: this.manager.serviceName
      });
      return false;
    }
  }

  /**
   * 检查健康状态
   */
  async checkHealth(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const timeout = 5000;
      
      const req = client.get(url, {
        timeout,
        headers: {
          'User-Agent': 'mineGo-ServiceLifecycle/1.0'
        }
      }, (res) => {
        let data = '';
        
        res.on('data', chunk => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const body = JSON.parse(data);
              // 检查健康状态字段
              const isHealthy = body.healthy === true || 
                               body.status === 'healthy' ||
                               body.state === 'healthy' ||
                               res.statusCode === 200;
              resolve(isHealthy);
            } catch (e) {
              // 如果返回非 JSON，只要状态码是 200 就认为健康
              resolve(res.statusCode === 200);
            }
          } else {
            reject(new Error(`Health check returned ${res.statusCode}`));
          }
        });
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Health check timeout'));
      });
    });
  }

  /**
   * 获取依赖状态
   */
  getDependencyStatus(name) {
    return this.dependencyStatus.get(name);
  }

  /**
   * 获取所有依赖状态
   */
  getAllDependencyStatus() {
    const status = {};
    for (const [name, info] of this.dependencyStatus.entries()) {
      status[name] = info;
    }
    return status;
  }

  /**
   * 清除依赖状态
   */
  clearDependencyStatus() {
    this.dependencyStatus.clear();
  }
}

module.exports = DependencyStartupCoordinator;