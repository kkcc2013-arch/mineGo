/**
 * REQ-00514: 多区域服务状态同步与智能仲裁系统
 * ServiceDependencyAnalyzer - 服务依赖拓扑分析器
 * 
 * 功能：
 * - 分析服务依赖拓扑
 * - 分析故障传播链路
 * - 计算故障严重度
 * 
 * 创建时间: 2026-07-08 22:00 UTC
 */

'use strict';

const { createLogger } = require('../logger');
const promClient = require('prom-client');

const logger = createLogger('service-dependency-analyzer');

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  dependencyDepth: new promClient.Gauge({
    name: 'minego_service_dependency_depth',
    help: 'Service dependency depth',
    labelNames: ['service']
  }),
  
  impactChainLength: new promClient.Gauge({
    name: 'minego_impact_chain_length',
    help: 'Impact chain length for failed service',
    labelNames: ['failed_service', 'region']
  }),
  
  severityScore: new promClient.Gauge({
    name: 'minego_fault_severity_score',
    help: 'Fault severity score (0-100)',
    labelNames: ['service', 'region', 'fault_type']
  }),
  
  analysisOperations: new promClient.Counter({
    name: 'minego_dependency_analysis_operations_total',
    help: 'Total dependency analysis operations',
    labelNames: ['operation', 'result']
  })
};

// ============================================================
// 服务依赖拓扑
// ============================================================

const DEFAULT_DEPENDENCY_TOPOLOGY = {
  gateway: {
    dependencies: ['user', 'pokemon', 'catch', 'gym', 'social', 'reward', 'payment', 'location'],
    critical: true,
    tier: 1,
    description: 'API 网关，所有请求入口'
  },
  
  user: {
    dependencies: ['location', 'reward'],
    critical: true,
    tier: 2,
    description: '用户服务，认证与用户数据'
  },
  
  location: {
    dependencies: [],
    critical: true,
    tier: 3,
    description: '位置服务，GPS 定位与地理数据'
  },
  
  pokemon: {
    dependencies: ['location', 'user'],
    critical: true,
    tier: 2,
    description: '精灵服务，精灵数据与管理'
  },
  
  catch: {
    dependencies: ['pokemon', 'location', 'user', 'reward'],
    critical: true,
    tier: 2,
    description: '捕捉服务，核心游戏玩法'
  },
  
  gym: {
    dependencies: ['pokemon', 'user', 'social', 'location'],
    critical: true,
    tier: 2,
    description: '道馆服务，战斗与占领'
  },
  
  social: {
    dependencies: ['user', 'pokemon'],
    critical: false,
    tier: 3,
    description: '社交服务，好友与交易'
  },
  
  reward: {
    dependencies: ['user'],
    critical: false,
    tier: 3,
    description: '奖励服务，成就与任务'
  },
  
  payment: {
    dependencies: ['user', 'reward'],
    critical: true,
    tier: 2,
    description: '支付服务，内购与充值'
  }
};

// ============================================================
// 服务重要性权重
// ============================================================

const SERVICE_CRITICALITY_WEIGHTS = {
  gateway: 30,
  user: 25,
  catch: 20,
  pokemon: 15,
  gym: 15,
  payment: 15,
  location: 10,
  social: 5,
  reward: 5
};

// ============================================================
// 配置
// ============================================================

const DEFAULT_CONFIG = {
  topology: DEFAULT_DEPENDENCY_TOPOLOGY,
  criticalityWeights: SERVICE_CRITICALITY_WEIGHTS,
  // 严重度计算参数
  severityThresholds: {
    localFault: 30,    // 严重度 < 30 视为局部故障
    regionalFault: 60, // 严重度 < 60 视为区域故障
    globalFault: 80    // 严重度 >= 80 视为全局故障
  },
  // 传播影响系数
  propagationFactor: 0.7, // 依赖服务故障影响上级服务严重度的系数
  // 服务数量影响系数
  serviceCountFactor: 5   // 每增加一个故障服务增加的严重度
};

// ============================================================
// ServiceDependencyAnalyzer 类
// ============================================================

class ServiceDependencyAnalyzer {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.topology = this.config.topology;
    
    // 构建反向依赖图
    this.reverseDependencies = this.buildReverseDependencies();
    
    // 初始化指标
    this.initializeMetrics();
  }

  /**
   * 构建反向依赖图（谁依赖我）
   */
  buildReverseDependencies() {
    const reverse = {};
    
    for (const [service, info] of Object.entries(this.topology)) {
      for (const dep of info.dependencies || []) {
        if (!reverse[dep]) {
          reverse[dep] = [];
        }
        reverse[dep].push(service);
      }
    }
    
    return reverse;
  }

  /**
   * 初始化指标
   */
  initializeMetrics() {
    for (const [service, info] of Object.entries(this.topology)) {
      metrics.dependencyDepth.set({ service }, info.dependencies?.length || 0);
    }
  }

  /**
   * 分析故障传播链路
   * 返回从故障服务向上传播到所有受影响服务的链路
   */
  analyzeImpactChain(failedService) {
    const startTime = Date.now();
    
    try {
      const impactChain = {
        root: failedService,
        affected: [],
        totalAffected: 0,
        criticalAffected: [],
        propagationPaths: []
      };
      
      // BFS 遍历反向依赖图
      const visited = new Set();
      visited.add(failedService);
      
      const queue = [failedService];
      
      while (queue.length > 0) {
        const current = queue.shift();
        const dependents = this.reverseDependencies[current] || [];
        
        for (const dependent of dependents) {
          if (!visited.has(dependent)) {
            visited.add(dependent);
            queue.push(dependent);
            
            impactChain.affected.push(dependent);
            
            if (this.topology[dependent]?.critical) {
              impactChain.criticalAffected.push(dependent);
            }
            
            impactChain.propagationPaths.push({
              from: current,
              to: dependent,
              tier: this.topology[dependent]?.tier || 99
            });
          }
        }
      }
      
      impactChain.totalAffected = impactChain.affected.length;
      
      // 记录指标
      metrics.impactChainLength.set({ failed_service: failedService, region: 'any' }, impactChain.totalAffected);
      metrics.analysisOperations.inc({ operation: 'impact_chain', result: 'success' });
      
      logger.debug('Impact chain analyzed', {
        failedService,
        totalAffected: impactChain.totalAffected,
        criticalAffected: impactChain.criticalAffected.length
      });
      
      return impactChain;
    } catch (error) {
      metrics.analysisOperations.inc({ operation: 'impact_chain', result: 'error' });
      logger.error('Impact chain analysis failed', { failedService, error: error.message });
      throw error;
    }
  }

  /**
   * 获取指定区域受影响的服务列表
   */
  getAffectedServices(region, service, regionState = {}) {
    const impactChain = this.analyzeImpactChain(service);
    const affected = [];
    
    for (const affectedService of impactChain.affected) {
      const serviceState = regionState?.services?.[affectedService];
      affected.push({
        service: affectedService,
        critical: this.topology[affectedService]?.critical || false,
        currentlyHealthy: serviceState?.healthy ?? null,
        tier: this.topology[affectedService]?.tier || 99
      });
    }
    
    return affected;
  }

  /**
   * 计算故障严重度 (0-100)
   * 
   * 严重度计算公式：
   * baseSeverity = 服务重要性权重
   * propagationSeverity = 影响链路严重度总和 * 传播系数
   * countSeverity = 故障服务数量 * 服务数量系数
   * 
   * totalSeverity = baseSeverity + propagationSeverity + countSeverity
   */
  calculateSeverity(region, service, regionState = {}) {
    const startTime = Date.now();
    
    try {
      // 基础严重度 = 服务重要性权重
      const baseSeverity = this.config.criticalityWeights[service] || 10;
      
      // 分析影响链路
      const impactChain = this.analyzeImpactChain(service);
      
      // 传播严重度
      let propagationSeverity = 0;
      for (const affectedService of impactChain.affected) {
        const affectedWeight = this.config.criticalityWeights[affectedService] || 10;
        propagationSeverity += affectedWeight * this.config.propagationFactor;
      }
      
      // 计算当前区域故障服务数量
      let faultCount = 0;
      let criticalFaultCount = 0;
      
      for (const [serviceName, state] of Object.entries(regionState?.services || {})) {
        if (state?.healthy !== true) {
          faultCount++;
          if (this.topology[serviceName]?.critical) {
            criticalFaultCount++;
          }
        }
      }
      
      // 数量严重度
      const countSeverity = faultCount * this.config.serviceCountFactor;
      const criticalCountSeverity = criticalFaultCount * this.config.serviceCountFactor * 2;
      
      // 总严重度（上限 100）
      const totalSeverity = Math.min(100, 
        baseSeverity + propagationSeverity + countSeverity + criticalCountSeverity
      );
      
      // 确定故障类型
      const faultType = this.classifyFaultBySeverity(totalSeverity);
      
      // 记录指标
      metrics.severityScore.set({ service, region, fault_type: faultType }, totalSeverity);
      metrics.analysisOperations.inc({ operation: 'severity', result: 'success' });
      
      logger.debug('Severity calculated', {
        service,
        region,
        totalSeverity,
        faultType,
        baseSeverity,
        propagationSeverity,
        countSeverity
      });
      
      return {
        score: totalSeverity,
        faultType,
        baseSeverity,
        propagationSeverity,
        countSeverity,
        faultCount,
        criticalFaultCount,
        impactChain
      };
    } catch (error) {
      metrics.analysisOperations.inc({ operation: 'severity', result: 'error' });
      logger.error('Severity calculation failed', { service, region, error: error.message });
      throw error;
    }
  }

  /**
   * 根据严重度分类故障类型
   */
  classifyFaultBySeverity(severity) {
    if (severity < this.config.severityThresholds.localFault) {
      return 'local';
    } else if (severity < this.config.severityThresholds.regionalFault) {
      return 'regional';
    } else {
      return 'global';
    }
  }

  /**
   * 获取服务依赖树
   */
  getDependencyTree(service, depth = 0) {
    if (depth > 10) return null; // 防止无限递归
    
    const info = this.topology[service];
    if (!info) return null;
    
    const tree = {
      service,
      critical: info.critical,
      tier: info.tier,
      description: info.description,
      dependencies: []
    };
    
    for (const dep of info.dependencies || []) {
      const depTree = this.getDependencyTree(dep, depth + 1);
      if (depTree) {
        tree.dependencies.push(depTree);
      }
    }
    
    return tree;
  }

  /**
   * 检查循环依赖
   */
  detectCircularDependency() {
    const visited = new Set();
    const recursionStack = new Set();
    const cycles = [];
    
    for (const service of Object.keys(this.topology)) {
      if (this.detectCycleDFS(service, visited, recursionStack, cycles)) {
        // 找到循环依赖
      }
    }
    
    if (cycles.length > 0) {
      logger.warn('Circular dependencies detected', { cycles });
    }
    
    return cycles;
  }

  /**
   * DFS 检测循环
   */
  detectCycleDFS(service, visited, recursionStack, cycles) {
    if (recursionStack.has(service)) {
      cycles.push(service);
      return true;
    }
    
    if (visited.has(service)) {
      return false;
    }
    
    visited.add(service);
    recursionStack.add(service);
    
    const dependencies = this.topology[service]?.dependencies || [];
    for (const dep of dependencies) {
      if (this.detectCycleDFS(dep, visited, recursionStack, cycles)) {
        return true;
      }
    }
    
    recursionStack.delete(service);
    return false;
  }

  /**
   * 获取关键服务列表
   */
  getCriticalServices() {
    return Object.entries(this.topology)
      .filter(([_, info]) => info.critical)
      .map(([service, info]) => ({
        service,
        tier: info.tier,
        dependencies: info.dependencies
      }));
  }

  /**
   * 获取服务层级
   */
  getServiceTier(service) {
    return this.topology[service]?.tier || 99;
  }

  /**
   * 检查服务是否关键
   */
  isServiceCritical(service) {
    return this.topology[service]?.critical === true;
  }

  /**
   * 获取服务依赖列表
   */
  getServiceDependencies(service) {
    return this.topology[service]?.dependencies || [];
  }

  /**
   * 获取服务反向依赖列表（谁依赖我）
   */
  getServiceReverseDependencies(service) {
    return this.reverseDependencies[service] || [];
  }

  /**
   * 计算区域整体健康度
   */
  calculateRegionHealthScore(regionState) {
    const services = regionState?.services || {};
    
    let totalScore = 0;
    let maxScore = 0;
    
    for (const [service, info] of Object.entries(this.topology)) {
      const weight = this.config.criticalityWeights[service] || 10;
      maxScore += weight;
      
      if (services[service]?.healthy === true) {
        totalScore += weight;
      }
    }
    
    return {
      score: Math.round((totalScore / maxScore) * 100),
      totalServices: Object.keys(this.topology).length,
      healthyServices: Object.entries(services).filter(([_, s]) => s?.healthy === true).length,
      criticalServicesHealthy: Object.entries(services)
        .filter(([service, s]) => s?.healthy === true && this.isServiceCritical(service))
        .length
    };
  }

  /**
   * 获取拓扑信息
   */
  getTopologyInfo() {
    return {
      services: Object.keys(this.topology),
      criticalServices: this.getCriticalServices(),
      reverseDependencies: this.reverseDependencies,
      dependencyCount: Object.entries(this.topology)
        .reduce((sum, [_, info]) => sum + (info.dependencies?.length || 0), 0)
    };
  }

  /**
   * 更新拓扑配置
   */
  updateTopology(newTopology) {
    this.topology = { ...this.topology, ...newTopology };
    this.reverseDependencies = this.buildReverseDependencies();
    this.initializeMetrics();
    
    logger.info('Topology updated', { 
      services: Object.keys(this.topology).length 
    });
  }
}

module.exports = ServiceDependencyAnalyzer;