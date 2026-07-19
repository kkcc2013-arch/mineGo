// backend/shared/k8s-operator/index.js
// REQ-00592: PMG Kubernetes Operator - 部署健康检查与自动回滚

'use strict';

const { KubernetesClient } = require('../KubernetesClient');
const DeploymentHealthCheckController = require('./controllers/DeploymentHealthCheckController');
const { createLogger } = require('../logger');
const { metrics } = require('../metrics');

const logger = createLogger('pmg-operator');

/**
 * PMG Kubernetes Operator
 * 
 * 管理部署健康检查 CRD，监控服务健康状态，自动触发回滚
 */
class PMGOperator {
  constructor(options = {}) {
    this.k8sClient = options.k8sClient || new KubernetesClient();
    this.controllers = new Map();
    
    // 控制器
    this.healthCheckController = new DeploymentHealthCheckController({
      k8sClient: this.k8sClient,
      promClient: options.promClient,
      notifier: options.notifier
    });
    
    // 状态
    this.isRunning = false;
    this.watchers = new Map();
  }

  /**
   * 启动 Operator
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Operator already running');
      return;
    }
    
    logger.info('Starting PMG Kubernetes Operator...');
    
    try {
      // 确保 CRD 已安装
      await this.ensureCRDs();
      
      // 启动健康检查控制器
      this.controllers.set('healthCheck', this.healthCheckController);
      
      // 开始监听 CRD 事件
      await this.startWatchers();
      
      this.isRunning = true;
      
      logger.info('PMG Operator started successfully');
      
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to start operator');
      throw error;
    }
  }

  /**
   * 确保 CRD 已安装
   */
  async ensureCRDs() {
    const crds = [
      { group: 'pmg.io', version: 'v1', plural: 'deploymenthealthchecks' }
    ];
    
    for (const crd of crds) {
      try {
        await this.k8sClient.getCustomResourceDefinition(crd.plural);
        logger.info({ crd: crd.plural }, 'CRD already exists');
      } catch (error) {
        if (error.code === 404) {
          logger.warn({ crd: crd.plural }, 'CRD not found, please apply CRD YAML first');
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * 启动 CRD 事件监听
   */
  async startWatchers() {
    // 监听 DeploymentHealthCheck CRD
    const healthCheckWatcher = await this.k8sClient.watchCustomResource(
      'pmg.io',
      'v1',
      'deploymenthealthchecks',
      'pmg',
      (eventType, object) => this.handleHealthCheckEvent(eventType, object)
    );
    
    this.watchers.set('healthCheck', healthCheckWatcher);
    
    logger.info('CRD watchers started');
  }

  /**
   * 处理健康检查 CRD 事件
   */
  async handleHealthCheckEvent(eventType, object) {
    const name = object.metadata.name;
    const namespace = object.metadata.namespace;
    
    logger.info({ eventType, name, namespace }, 'HealthCheck event received');
    
    switch (eventType) {
      case 'ADDED':
      case 'MODIFIED':
        // 启动健康检查
        await this.healthCheckController.startHealthCheck(object);
        break;
        
      case 'DELETED':
        // 停止健康检查
        const checkId = `${namespace}/${object.spec.targetDeployment}`;
        this.healthCheckController.stopHealthCheck(checkId);
        break;
    }
  }

  /**
   * 停止 Operator
   */
  async stop() {
    logger.info('Stopping PMG Operator...');
    
    // 停止所有监听
    for (const [name, watcher] of this.watchers) {
      await watcher.abort();
      logger.info({ watcher: name }, 'Watcher stopped');
    }
    
    // 停止所有健康检查
    for (const [checkId] of this.healthCheckController.activeChecks) {
      this.healthCheckController.stopHealthCheck(checkId);
    }
    
    this.isRunning = false;
    
    logger.info('PMG Operator stopped');
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeChecks: this.healthCheckController.getActiveChecks().map(c => ({
        id: c.id,
        deployment: c.targetDeployment,
        phase: c.phase,
        checksPassed: c.checksPassed,
        checksFailed: c.checksFailed,
        errorRate: c.currentErrorRate,
        latency: c.currentLatencyP99
      })),
      metrics: this.healthCheckController.getMetrics()
    };
  }
}

// 如果作为独立进程运行
if (require.main === module) {
  const operator = new PMGOperator();
  
  operator.start().catch(err => {
    logger.error({ error: err.message }, 'Operator startup failed');
    process.exit(1);
  });
  
  // 优雅关闭
  process.on('SIGTERM', async () => {
    await operator.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    await operator.stop();
    process.exit(0);
  });
}

module.exports = PMGOperator;