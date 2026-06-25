/**
 * REQ-00061: 服务健康仪表板与自动恢复系统
 * 
 * 功能：
 * 1. 聚合所有微服务健康状态
 * 2. 依赖关系可视化
 * 3. 自动故障检测与告警
 * 4. 智能自动恢复
 */

'use strict';

const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const HealthScorer = require('./healthScorer');
const SelfHealingEngine = require('./SelfHealingEngine');
const ServiceRegistry = require('./ServiceRegistry');
const PrometheusClient = require('./apiMetrics');

const logger = createLogger('service-health-dashboard');

class ServiceHealthDashboard extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      updateInterval: config.updateInterval || 30000, // 30 seconds
      historyRetention: config.historyRetention || 3600000, // 1 hour
      autoRecoveryEnabled: config.autoRecoveryEnabled !== false,
      alertThresholds: {
        healthy: 80,
        warning: 60,
        degraded: 40,
        critical: 0
      },
      ...config
    };
    
    this.healthScorer = new HealthScorer();
    this.selfHealingEngine = new SelfHealingEngine();
    this.serviceRegistry = new ServiceRegistry();
    this.prometheusClient = new PrometheusClient();
    
    // 服务状态缓存
    this.serviceStates = new Map();
    this.serviceHistory = new Map();
    this.dependencyGraph = new Map();
    
    // 定时任务
    this.updateTimer = null;
    this.cleanupTimer = null;
    
    // 告警去重
    this.activeAlerts = new Map();
  }
  
  /**
   * 启动仪表板
   */
  async start() {
    logger.info('启动服务健康仪表板...');
    
    // 加载服务注册信息
    await this._loadServiceRegistry();
    
    // 启动定时更新
    this.updateTimer = setInterval(() => {
      this._updateAllServices().catch(err => {
        logger.error({ err }, '更新服务状态失败');
      });
    }, this.config.updateInterval);
    
    // 启动历史数据清理
    this.cleanupTimer = setInterval(() => {
      this._cleanupHistory();
    }, 60000); // 每分钟清理一次
    
    // 监听自愈引擎事件
    this.selfHealingEngine.on('recovery_triggered', (data) => {
      this.emit('recovery_triggered', data);
      this._handleRecoveryEvent(data);
    });
    
    // 首次更新
    await this._updateAllServices();
    
    logger.info('服务健康仪表板启动完成');
    this.emit('started');
  }
  
  /**
   * 停止仪表板
   */
  async stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    logger.info('服务健康仪表板已停止');
    this.emit('stopped');
  }
  
  /**
   * 获取所有服务健康状态
   */
  async getAllServicesHealth() {
    const services = Array.from(this.serviceStates.values());
    
    // 计算整体健康分数
    const overallScore = services.reduce((sum, s) => sum + s.totalScore, 0) / services.length || 0;
    
    // 统计各状态数量
    const statusCounts = {
      healthy: 0,
      warning: 0,
      degraded: 0,
      critical: 0
    };
    
    services.forEach(s => {
      statusCounts[s.status]++;
    });
    
    return {
      overallScore: Math.round(overallScore),
      overallStatus: this._determineOverallStatus(statusCounts),
      statusCounts,
      services,
      dependencyGraph: this._getDependencyGraph(),
      lastUpdate: new Date().toISOString()
    };
  }
  
  /**
   * 获取单个服务健康状态
   */
  async getServiceHealth(serviceName) {
    const state = this.serviceStates.get(serviceName);
    if (!state) {
      throw new Error(`Service not found: ${serviceName}`);
    }
    
    // 获取历史趋势
    const history = this.serviceHistory.get(serviceName) || [];
    
    return {
      ...state,
      history: history.slice(-60), // 最近60个数据点（30分钟）
      dependencies: this.dependencyGraph.get(serviceName) || []
    };
  }
  
  /**
   * 手动触发服务恢复
   */
  async triggerRecovery(serviceName, strategy) {
    logger.info({ serviceName, strategy }, '手动触发服务恢复');
    
    const state = this.serviceStates.get(serviceName);
    if (!state) {
      throw new Error(`Service not found: ${serviceName}`);
    }
    
    return await this.selfHealingEngine.executeRecovery(serviceName, strategy);
  }
  
  /**
   * 加载服务注册信息
   */
  async _loadServiceRegistry() {
    const services = [
      { name: 'gateway', port: 8080, critical: true },
      { name: 'user-service', port: 3001, critical: true },
      { name: 'pokemon-service', port: 3002, critical: true },
      { name: 'catch-service', port: 3003, critical: true },
      { name: 'location-service', port: 3004, critical: true },
      { name: 'gym-service', port: 3005, critical: true },
      { name: 'social-service', port: 3006, critical: true },
      { name: 'reward-service', port: 3007, critical: true },
      { name: 'payment-service', port: 3008, critical: true }
    ];
    
    // 构建依赖关系图
    const dependencies = {
      'gateway': ['user-service', 'pokemon-service', 'catch-service', 'location-service', 'gym-service', 'social-service', 'reward-service', 'payment-service'],
      'catch-service': ['user-service', 'pokemon-service', 'location-service'],
      'gym-service': ['user-service', 'pokemon-service'],
      'social-service': ['user-service', 'pokemon-service'],
      'reward-service': ['user-service'],
      'payment-service': ['user-service', 'reward-service'],
      'pokemon-service': ['user-service'],
      'location-service': ['user-service']
    };
    
    services.forEach(service => {
      this.serviceRegistry.register(service.name, {
        port: service.port,
        critical: service.critical,
        healthEndpoint: `http://localhost:${service.port}/health`
      });
      
      if (dependencies[service.name]) {
        this.dependencyGraph.set(service.name, dependencies[service.name]);
      }
    });
    
    logger.info(`已加载 ${services.length} 个服务注册信息`);
  }
  
  /**
   * 更新所有服务状态
   */
  async _updateAllServices() {
    const services = this.serviceRegistry.getAll();
    
    const updatePromises = services.map(async (service) => {
      try {
        const metrics = await this._collectServiceMetrics(service.name);
        const health = this.healthScorer.calculateHealthScore(service.name, metrics);
        
        // 更新状态
        this.serviceStates.set(service.name, health);
        
        // 保存历史
        this._saveHistory(service.name, health);
        
        // 检查告警
        await this._checkAlerts(service.name, health);
        
        // 自动恢复
        if (this.config.autoRecoveryEnabled && health.status === 'critical') {
          await this._triggerAutoRecovery(service.name, health);
        }
        
      } catch (error) {
        logger.error({ err: error, serviceName: service.name }, '更新服务状态失败');
        
        // 标记为不可用
        this.serviceStates.set(service.name, {
          serviceName: service.name,
          totalScore: 0,
          status: 'critical',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });
    
    await Promise.allSettled(updatePromises);
    
    this.emit('updated', await this.getAllServicesHealth());
  }
  
  /**
   * 收集服务指标
   */
  async _collectServiceMetrics(serviceName) {
    try {
      // 从 Prometheus 查询指标
      const metrics = await this.prometheusClient.getServiceMetrics(serviceName);
      
      return {
        cpu: metrics.cpu_usage || 0,
        memory: metrics.memory_usage || 0,
        errorRate: metrics.error_rate || 0,
        responseTime: metrics.p95_latency || 0,
        connectionPool: metrics.connection_pool_usage || 0,
        eventLag: metrics.event_lag || 0
      };
    } catch (error) {
      logger.warn({ err: error, serviceName }, '从 Prometheus 获取指标失败，使用默认值');
      
      // 返回默认值
      return {
        cpu: 0,
        memory: 0,
        errorRate: 0,
        responseTime: 0,
        connectionPool: 0,
        eventLag: 0
      };
    }
  }
  
  /**
   * 检查告警
   */
  async _checkAlerts(serviceName, health) {
    const previousState = this.serviceStates.get(serviceName);
    
    // 状态降级告警
    if (previousState && previousState.status !== health.status) {
      const alertKey = `${serviceName}-${health.status}`;
      
      if (!this.activeAlerts.has(alertKey)) {
        const alert = {
          serviceName,
          status: health.status,
          score: health.totalScore,
          message: `${serviceName} 状态从 ${previousState.status} 降级为 ${health.status}`,
          timestamp: new Date().toISOString()
        };
        
        this.activeAlerts.set(alertKey, alert);
        this.emit('alert', alert);
        
        logger.warn({ serviceName, status: health.status }, '服务状态降级');
      }
    }
    
    // 移除已恢复的告警
    if (health.status === 'healthy') {
      for (const [key] of this.activeAlerts) {
        if (key.startsWith(serviceName)) {
          this.activeAlerts.delete(key);
        }
      }
    }
  }
  
  /**
   * 触发自动恢复
   */
  async _triggerAutoRecovery(serviceName, health) {
    logger.info({ serviceName, score: health.totalScore }, '触发自动恢复');
    
    // 分析问题原因
    const problems = this._analyzeProblems(health);
    
    // 选择恢复策略
    const strategy = this._selectRecoveryStrategy(problems);
    
    try {
      await this.selfHealingEngine.executeRecovery(serviceName, strategy);
    } catch (error) {
      logger.error({ err: error, serviceName }, '自动恢复失败');
    }
  }
  
  /**
   * 分析问题原因
   */
  _analyzeProblems(health) {
    const problems = [];
    
    if (health.scores.cpu.score < 50) {
      problems.push({ type: 'cpu_high', severity: 'high' });
    }
    if (health.scores.memory.score < 50) {
      problems.push({ type: 'memory_high', severity: 'critical' });
    }
    if (health.scores.errorRate.score < 50) {
      problems.push({ type: 'error_rate_high', severity: 'high' });
    }
    if (health.scores.responseTime.score < 50) {
      problems.push({ type: 'response_time_high', severity: 'medium' });
    }
    if (health.scores.connectionPool.score < 50) {
      problems.push({ type: 'connection_pool_exhausted', severity: 'high' });
    }
    
    return problems;
  }
  
  /**
   * 选择恢复策略
   */
  _selectRecoveryStrategy(problems) {
    // 根据问题类型选择策略
    for (const problem of problems) {
      switch (problem.type) {
        case 'memory_high':
          return 'restart_with_memory_limit';
        case 'connection_pool_exhausted':
          return 'rebuild_connections';
        case 'error_rate_high':
          return 'rollback';
        case 'cpu_high':
          return 'scale_out';
        default:
          return 'restart';
      }
    }
    return 'restart';
  }
  
  /**
   * 处理恢复事件
   */
  _handleRecoveryEvent(data) {
    logger.info({ data }, '服务恢复事件');
    
    // 更新服务状态
    if (data.success) {
      // 移除告警
      for (const [key] of this.activeAlerts) {
        if (key.startsWith(data.serviceName)) {
          this.activeAlerts.delete(key);
        }
      }
    }
  }
  
  /**
   * 保存历史数据
   */
  _saveHistory(serviceName, health) {
    if (!this.serviceHistory.has(serviceName)) {
      this.serviceHistory.set(serviceName, []);
    }
    
    const history = this.serviceHistory.get(serviceName);
    history.push({
      timestamp: health.timestamp,
      score: health.totalScore,
      status: health.status
    });
    
    // 限制历史记录大小
    if (history.length > 200) {
      history.shift();
    }
  }
  
  /**
   * 清理过期历史数据
   */
  _cleanupHistory() {
    const cutoffTime = Date.now() - this.config.historyRetention;
    
    for (const [serviceName, history] of this.serviceHistory) {
      const filtered = history.filter(h => 
        new Date(h.timestamp).getTime() > cutoffTime
      );
      this.serviceHistory.set(serviceName, filtered);
    }
  }
  
  /**
   * 获取依赖关系图
   */
  _getDependencyGraph() {
    const graph = {
      nodes: [],
      edges: []
    };
    
    // 添加节点
    for (const [serviceName] of this.serviceStates) {
      const state = this.serviceStates.get(serviceName);
      graph.nodes.push({
        id: serviceName,
        label: serviceName,
        status: state.status,
        score: state.totalScore
      });
    }
    
    // 添加边
    for (const [serviceName, deps] of this.dependencyGraph) {
      deps.forEach(dep => {
        graph.edges.push({
          source: serviceName,
          target: dep
        });
      });
    }
    
    return graph;
  }
  
  /**
   * 确定整体状态
   */
  _determineOverallStatus(statusCounts) {
    if (statusCounts.critical > 0) return 'critical';
    if (statusCounts.degraded > 0) return 'degraded';
    if (statusCounts.warning > 0) return 'warning';
    return 'healthy';
  }
}

module.exports = ServiceHealthDashboard;
