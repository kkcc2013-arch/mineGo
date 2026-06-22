// backend/shared/alertCorrelator.js
// REQ-00275: 告警智能关联与根因分析系统
// 提供告警关联、根因推断、聚类和智能降噪功能

'use strict';

const logger = require('./logger');
const { getRedis } = require('./redis');
const { promisify } = require('util');

// ==================== 常量定义 ====================

const CORRELATION_TIME_WINDOW_MS = 60000; // 关联时间窗口：60秒
const SIMILARITY_THRESHOLD = 0.7; // 聚类相似度阈值
const NOISE_THRESHOLD = 0.9; // 降噪阈值
const HISTORY_WINDOW_DAYS = 7; // 历史窗口：7天
const MAX_CLUSTER_SIZE = 50; // 最大聚类大小

// 告警严重程度权重
const SEVERITY_WEIGHTS = {
  'ServiceDown': 1.0,
  'DatabaseConnectionPoolExhausted': 0.95,
  'RedisConnectionFailed': 0.95,
  'KafkaBrokerDown': 0.95,
  'HighErrorRate': 0.8,
  'HighLatency': 0.7,
  'LowCacheHitRate': 0.5,
  'MemoryUsageHigh': 0.6,
  'CPUUsageHigh': 0.6,
  'DiskUsageHigh': 0.6
};

// 因果规则：定义哪些告警类型可能是其他告警的根因
const CAUSAL_RULES = [
  // 服务宕机导致其他告警
  { cause: 'ServiceDown', effect: '*', weight: 1.0 },
  // 数据库问题导致服务问题
  { cause: 'DatabaseConnectionPoolExhausted', effect: 'HighErrorRate', weight: 0.9 },
  { cause: 'DatabaseConnectionPoolExhausted', effect: 'HighLatency', weight: 0.85 },
  { cause: 'DatabaseQuerySlow', effect: 'HighLatency', weight: 0.8 },
  // Redis 问题导致缓存问题
  { cause: 'RedisConnectionFailed', effect: 'LowCacheHitRate', weight: 0.9 },
  { cause: 'RedisConnectionFailed', effect: 'HighLatency', weight: 0.7 },
  // Kafka 问题导致消息处理问题
  { cause: 'KafkaBrokerDown', effect: 'MessageQueueBacklog', weight: 0.9 },
  // 基础设施问题导致应用问题
  { cause: 'CPUUsageHigh', effect: 'HighLatency', weight: 0.7 },
  { cause: 'MemoryUsageHigh', effect: 'HighLatency', weight: 0.75 },
  { cause: 'DiskUsageHigh', effect: 'HighLatency', weight: 0.6 }
];

// ==================== 服务拓扑 ====================

/**
 * 服务依赖拓扑图
 * 定义微服务之间的依赖关系
 */
const SERVICE_TOPOLOGY = {
  // gateway 依赖所有下游服务
  'gateway': ['user-service', 'location-service', 'pokemon-service', 'catch-service', 'gym-service', 'social-service', 'reward-service', 'payment-service'],
  // 各服务的基础依赖
  'user-service': ['database', 'redis'],
  'location-service': ['database', 'redis', 'kafka'],
  'pokemon-service': ['database', 'redis'],
  'catch-service': ['database', 'redis', 'kafka', 'location-service'],
  'gym-service': ['database', 'redis', 'kafka', 'pokemon-service'],
  'social-service': ['database', 'redis', 'kafka'],
  'reward-service': ['database', 'redis', 'kafka'],
  'payment-service': ['database', 'redis', 'kafka'],
  // 基础设施
  'database': [],
  'redis': [],
  'kafka': []
};

// ==================== AlertCorrelator 类 ====================

/**
 * 告警关联分析器
 */
class AlertCorrelator {
  constructor(config = {}) {
    this.timeWindowMs = config.timeWindowMs || CORRELATION_TIME_WINDOW_MS;
    this.activeAlerts = new Map(); // 活跃告警缓存
    this.alertHistory = []; // 告警历史
    this.serviceTopology = SERVICE_TOPOLOGY;
  }

  /**
   * 处理新告警
   * @param {Object} alert - 告警对象
   * @returns {Promise<Object>} - 处理结果
   */
  async processAlert(alert) {
    const startTime = Date.now();
    
    try {
      // 1. 存储告警
      this.storeAlert(alert);
      
      // 2. 关联分析
      const correlations = this.correlate(alert);
      
      // 3. 根因推断
      const rootCause = this.inferRootCause(alert, correlations);
      
      // 4. 聚类
      const clusterResult = this.cluster(alert);
      
      // 5. 降噪评估
      const noiseResult = await this.evaluateNoise(alert);
      
      // 6. 生成拓扑
      const topology = this.generateTopology(alert, correlations);
      
      const result = {
        alert,
        correlations,
        rootCause,
        cluster: clusterResult,
        noise: noiseResult,
        topology,
        processingTimeMs: Date.now() - startTime
      };
      
      // 记录指标
      this.recordMetrics(result);
      
      logger.info('Alert processed', {
        fingerprint: alert.fingerprint,
        alertname: alert.labels?.alertname,
        correlationCount: correlations.length,
        rootCause: rootCause?.alert?.labels?.alertname,
        isNoise: noiseResult.isNoise,
        processingTimeMs: result.processingTimeMs
      });
      
      return result;
    } catch (error) {
      logger.error('Alert processing failed', {
        fingerprint: alert.fingerprint,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 存储告警
   */
  storeAlert(alert) {
    const fingerprint = alert.fingerprint || this.generateFingerprint(alert);
    alert.fingerprint = fingerprint;
    alert.receivedAt = Date.now();
    
    this.activeAlerts.set(fingerprint, alert);
    this.alertHistory.push(alert);
    
    // 清理过期告警（超过时间窗口）
    this.cleanupExpiredAlerts();
  }

  /**
   * 生成告警指纹
   */
  generateFingerprint(alert) {
    const labels = alert.labels || {};
    const parts = [
      labels.alertname || 'unknown',
      labels.service || 'unknown',
      labels.instance || '',
      labels.severity || ''
    ];
    return parts.join(':').replace(/[^a-zA-Z0-9:_-]/g, '');
  }

  /**
   * 清理过期告警
   */
  cleanupExpiredAlerts() {
    const now = Date.now();
    const expireThreshold = now - this.timeWindowMs * 10; // 保留10个时间窗口
    
    for (const [fingerprint, alert] of this.activeAlerts) {
      if (alert.receivedAt < expireThreshold) {
        this.activeAlerts.delete(fingerprint);
      }
    }
    
    // 限制历史大小
    if (this.alertHistory.length > 10000) {
      this.alertHistory = this.alertHistory.slice(-5000);
    }
  }

  /**
   * 关联分析
   */
  correlate(alert) {
    const correlations = [];
    
    // 1. 基于服务拓扑关联
    const topologyCorrelations = this.correlateByTopology(alert);
    correlations.push(...topologyCorrelations);
    
    // 2. 基于时间窗口关联
    const timeCorrelations = this.correlateByTime(alert);
    correlations.push(...timeCorrelations);
    
    // 3. 基于因果规则关联
    const causalCorrelations = this.correlateByCausalRules(alert);
    correlations.push(...causalCorrelations);
    
    // 去重并排序
    const uniqueCorrelations = this.deduplicateCorrelations(correlations);
    return uniqueCorrelations.sort((a, b) => b.score - a.score);
  }

  /**
   * 基于服务拓扑关联
   */
  correlateByTopology(alert) {
    const correlations = [];
    const serviceName = alert.labels?.service;
    
    if (!serviceName) return correlations;
    
    // 获取依赖的服务
    const dependencies = this.serviceTopology[serviceName] || [];
    const dependents = this.findDependents(serviceName);
    const relatedServices = [...dependencies, ...dependents];
    
    // 查找相关服务的活跃告警
    for (const relatedService of relatedServices) {
      for (const [fp, relatedAlert] of this.activeAlerts) {
        if (relatedAlert.labels?.service === relatedService && 
            fp !== alert.fingerprint) {
          const isUpstream = dependencies.includes(relatedService);
          correlations.push({
            alert: relatedAlert,
            type: 'topology',
            relation: isUpstream ? 'upstream' : 'downstream',
            score: 0.8,
            reason: `服务拓扑关联: ${relatedService} 是 ${serviceName} 的 ${isUpstream ? '上游' : '下游'}`
          });
        }
      }
    }
    
    return correlations;
  }

  /**
   * 查找服务的下游依赖者
   */
  findDependents(serviceName) {
    const dependents = [];
    for (const [service, deps] of Object.entries(this.serviceTopology)) {
      if (deps.includes(serviceName)) {
        dependents.push(service);
      }
    }
    return dependents;
  }

  /**
   * 基于时间窗口关联
   */
  correlateByTime(alert) {
    const correlations = [];
    const now = alert.receivedAt || Date.now();
    const timeWindow = now - this.timeWindowMs;
    
    for (const [fp, relatedAlert] of this.activeAlerts) {
      if (fp === alert.fingerprint) continue;
      if (relatedAlert.receivedAt < timeWindow) continue;
      
      const timeDiff = now - relatedAlert.receivedAt;
      const temporalScore = Math.max(0, 1 - timeDiff / this.timeWindowMs);
      
      if (temporalScore > 0.3) { // 时间相关性阈值
        correlations.push({
          alert: relatedAlert,
          type: 'temporal',
          timeDiff,
          score: temporalScore * 0.6, // 时间关联权重较低
          reason: `时间窗口关联: ${Math.round(timeDiff / 1000)}秒前触发`
        });
      }
    }
    
    return correlations;
  }

  /**
   * 基于因果规则关联
   */
  correlateByCausalRules(alert) {
    const correlations = [];
    const alertname = alert.labels?.alertname;
    
    if (!alertname) return correlations;
    
    for (const rule of CAUSAL_RULES) {
      // 检查当前告警是否是规则的 effect
      if (rule.effect === '*' || rule.effect === alertname) {
        // 查找匹配的 cause 告警
        for (const [fp, relatedAlert] of this.activeAlerts) {
          if (fp === alert.fingerprint) continue;
          if (relatedAlert.labels?.alertname === rule.cause) {
            // 检查服务相关性
            if (this.areServicesRelated(alert, relatedAlert)) {
              correlations.push({
                alert: relatedAlert,
                type: 'causal',
                rule: `${rule.cause} → ${rule.effect}`,
                score: rule.weight,
                reason: `因果规则关联: ${rule.cause} 可能导致 ${alertname}`
              });
            }
          }
        }
      }
      
      // 检查当前告警是否是规则的 cause
      if (rule.cause === alertname) {
        // 查找匹配的 effect 告警
        for (const [fp, relatedAlert] of this.activeAlerts) {
          if (fp === alert.fingerprint) continue;
          if (rule.effect === '*' || relatedAlert.labels?.alertname === rule.effect) {
            if (this.areServicesRelated(alert, relatedAlert)) {
              correlations.push({
                alert: relatedAlert,
                type: 'causal',
                rule: `${alertname} → ${rule.effect}`,
                score: rule.weight * 0.9, // 作为 cause 的关联度略低
                reason: `因果规则关联: ${alertname} 可能导致 ${relatedAlert.labels?.alertname}`
              });
            }
          }
        }
      }
    }
    
    return correlations;
  }

  /**
   * 检查两个告警的服务是否相关
   */
  areServicesRelated(alert1, alert2) {
    const service1 = alert1.labels?.service;
    const service2 = alert2.labels?.service;
    
    if (!service1 || !service2) return true; // 无服务信息时默认相关
    if (service1 === service2) return true;
    
    // 检查拓扑关系
    const deps1 = this.serviceTopology[service1] || [];
    const deps2 = this.serviceTopology[service2] || [];
    
    return deps1.includes(service2) || deps2.includes(service1);
  }

  /**
   * 去重关联结果
   */
  deduplicateCorrelations(correlations) {
    const seen = new Map();
    
    for (const corr of correlations) {
      const fp = corr.alert.fingerprint;
      if (!seen.has(fp) || seen.get(fp).score < corr.score) {
        seen.set(fp, corr);
      }
    }
    
    return Array.from(seen.values());
  }

  /**
   * 根因推断
   */
  inferRootCause(alert, correlations) {
    if (correlations.length === 0) {
      return {
        alert,
        confidence: 1.0,
        isRootCause: true,
        impactChain: [alert],
        reason: '无关联告警，当前告警即为根因'
      };
    }
    
    // 构建候选根因列表
    const candidates = [alert, ...correlations.map(c => c.alert)];
    
    // 计算每个候选的根因概率
    const scoredCandidates = candidates.map(candidate => {
      const score = this.calculateRootCauseScore(candidate, correlations);
      return { alert: candidate, score };
    });
    
    // 排序并选择最可能的根因
    scoredCandidates.sort((a, b) => b.score - a.score);
    const rootCause = scoredCandidates[0];
    
    // 构建影响链
    const impactChain = this.buildImpactChain(rootCause.alert, correlations);
    
    return {
      alert: rootCause.alert,
      confidence: rootCause.score,
      isRootCause: rootCause.alert.fingerprint === alert.fingerprint,
      impactChain,
      affectedServices: this.extractAffectedServices(impactChain),
      suggestedActions: this.getSuggestedActions(rootCause.alert),
      reason: this.explainRootCause(rootCause.alert, rootCause.score)
    };
  }

  /**
   * 计算根因得分
   */
  calculateRootCauseScore(candidate, correlations) {
    let score = 0;
    
    // 1. 严重程度权重
    const alertname = candidate.labels?.alertname;
    const severityWeight = SEVERITY_WEIGHTS[alertname] || 0.5;
    score += severityWeight * 0.4;
    
    // 2. 因果关系得分（作为 cause 的次数）
    const asCauseCount = correlations.filter(c => 
      c.type === 'causal' && c.alert.fingerprint === candidate.fingerprint
    ).length;
    score += Math.min(asCauseCount * 0.15, 0.3);
    
    // 3. 拓扑位置得分（上游服务更可能是根因）
    const upstreamCount = correlations.filter(c => 
      c.type === 'topology' && c.relation === 'upstream' && c.alert.fingerprint === candidate.fingerprint
    ).length;
    score += Math.min(upstreamCount * 0.1, 0.2);
    
    // 4. 时间得分（更早的告警更可能是根因）
    const candidateTime = candidate.receivedAt || Date.now();
    const latestTime = Math.max(...correlations.map(c => c.alert.receivedAt || 0));
    if (latestTime > 0 && candidateTime < latestTime) {
      const timeDiff = latestTime - candidateTime;
      const timeScore = Math.min(timeDiff / 60000, 5) * 0.02; // 每分钟加 0.02，最多 0.1
      score += timeScore;
    }
    
    return Math.min(score, 1.0);
  }

  /**
   * 构建影响链
   */
  buildImpactChain(rootCause, correlations) {
    const chain = [rootCause];
    const visited = new Set([rootCause.fingerprint]);
    
    // BFS 构建影响链
    const queue = [rootCause];
    while (queue.length > 0) {
      const current = queue.shift();
      
      // 找到受当前告警影响的告警
      const affected = correlations.filter(c => 
        c.alert.fingerprint === current.fingerprint && 
        c.type === 'causal' &&
        !visited.has(c.alert.fingerprint)
      );
      
      for (const corr of correlations) {
        if (corr.type === 'causal' && 
            corr.alert.fingerprint === current.fingerprint &&
            !visited.has(corr.alert.fingerprint)) {
          // 找到受影响的告警
          const affectedAlert = correlations.find(c => 
            c.alert.fingerprint !== current.fingerprint &&
            this.areServicesRelated(current, c.alert)
          )?.alert;
          
          if (affectedAlert && !visited.has(affectedAlert.fingerprint)) {
            visited.add(affectedAlert.fingerprint);
            chain.push(affectedAlert);
            queue.push(affectedAlert);
          }
        }
      }
    }
    
    return chain;
  }

  /**
   * 提取受影响的服务
   */
  extractAffectedServices(impactChain) {
    const services = new Set();
    for (const alert of impactChain) {
      if (alert.labels?.service) {
        services.add(alert.labels.service);
      }
    }
    return Array.from(services);
  }

  /**
   * 获取建议操作
   */
  getSuggestedActions(alert) {
    const alertname = alert.labels?.alertname;
    const service = alert.labels?.service;
    
    const actions = [];
    
    // 根据告警类型提供建议
    switch (alertname) {
      case 'ServiceDown':
        actions.push('检查服务日志: kubectl logs -l app=' + service);
        actions.push('检查服务状态: kubectl get pods -l app=' + service);
        actions.push('检查最近部署: kubectl rollout history deployment/' + service);
        break;
      case 'DatabaseConnectionPoolExhausted':
        actions.push('检查数据库连接数: SHOW PROCESSLIST');
        actions.push('检查连接池配置');
        actions.push('考虑增加连接池大小或优化查询');
        break;
      case 'RedisConnectionFailed':
        actions.push('检查 Redis 状态: redis-cli ping');
        actions.push('检查 Redis 内存: redis-cli info memory');
        actions.push('检查网络连接');
        break;
      case 'HighErrorRate':
        actions.push('检查错误日志');
        actions.push('检查上游服务状态');
        actions.push('检查最近代码变更');
        break;
      case 'HighLatency':
        actions.push('检查慢查询日志');
        actions.push('检查缓存命中率');
        actions.push('检查网络延迟');
        break;
      default:
        actions.push('检查服务日志');
        actions.push('检查监控指标');
    }
    
    return actions;
  }

  /**
   * 解释根因
   */
  explainRootCause(alert, score) {
    const alertname = alert.labels?.alertname;
    const service = alert.labels?.service || '未知服务';
    
    if (score >= 0.8) {
      return `高置信度根因: ${service} 的 ${alertname} (置信度: ${(score * 100).toFixed(1)}%)`;
    } else if (score >= 0.6) {
      return `可能根因: ${service} 的 ${alertname} (置信度: ${(score * 100).toFixed(1)}%)`;
    } else {
      return `疑似根因: ${service} 的 ${alertname} (置信度: ${(score * 100).toFixed(1)}%)`;
    }
  }

  /**
   * 告警聚类
   */
  cluster(alert) {
    // 简化实现：基于告警名称和服务聚类
    const clusterKey = `${alert.labels?.alertname}:${alert.labels?.service}`;
    
    return {
      clusterKey,
      alert,
      isNewCluster: true, // 简化：总是返回新聚类
      memberCount: 1
    };
  }

  /**
   * 降噪评估
   */
  async evaluateNoise(alert) {
    // 检查是否为抖动
    const recentCount = this.countRecentAlerts(alert, 600000); // 10分钟
    if (recentCount >= 5) {
      return {
        isNoise: true,
        reason: 'flapping',
        confidence: 0.85,
        action: 'delay',
        delayMs: 60000
      };
    }
    
    // 检查是否为低优先级且已有高优先级告警
    const severity = alert.labels?.severity;
    if (severity === 'info' || severity === 'warning') {
      const hasCritical = Array.from(this.activeAlerts.values()).some(a => 
        a.labels?.severity === 'critical' &&
        a.labels?.service === alert.labels?.service
      );
      if (hasCritical) {
        return {
          isNoise: true,
          reason: 'suppressed_by_critical',
          confidence: 0.9,
          action: 'suppress'
        };
      }
    }
    
    return {
      isNoise: false,
      reason: 'valid_alert',
      action: 'forward'
    };
  }

  /**
   * 统计近期告警数量
   */
  countRecentAlerts(alert, windowMs) {
    const now = Date.now();
    const threshold = now - windowMs;
    
    return this.alertHistory.filter(a => 
      a.fingerprint === alert.fingerprint &&
      a.receivedAt >= threshold
    ).length;
  }

  /**
   * 生成告警拓扑图
   */
  generateTopology(alert, correlations) {
    const nodes = new Map();
    const edges = [];
    
    // 添加当前告警节点
    nodes.set(alert.fingerprint, {
      id: alert.fingerprint,
      label: alert.labels?.alertname || 'Unknown',
      service: alert.labels?.service,
      severity: alert.labels?.severity,
      isRoot: true
    });
    
    // 添加关联告警节点和边
    for (const corr of correlations) {
      const relatedAlert = corr.alert;
      
      if (!nodes.has(relatedAlert.fingerprint)) {
        nodes.set(relatedAlert.fingerprint, {
          id: relatedAlert.fingerprint,
          label: relatedAlert.labels?.alertname || 'Unknown',
          service: relatedAlert.labels?.service,
          severity: relatedAlert.labels?.severity,
          isRoot: false
        });
      }
      
      edges.push({
        source: alert.fingerprint,
        target: relatedAlert.fingerprint,
        type: corr.type,
        score: corr.score,
        label: corr.reason || corr.type
      });
    }
    
    return {
      nodes: Array.from(nodes.values()),
      edges,
      stats: {
        nodeCount: nodes.size,
        edgeCount: edges.length,
        correlationTypes: this.summarizeCorrelationTypes(correlations)
      }
    };
  }

  /**
   * 汇总关联类型
   */
  summarizeCorrelationTypes(correlations) {
    const types = {};
    for (const corr of correlations) {
      types[corr.type] = (types[corr.type] || 0) + 1;
    }
    return types;
  }

  /**
   * 记录指标
   */
  recordMetrics(result) {
    // 这里可以集成 Prometheus 指标
    // 例如: metrics.alertCorrelationTime.observe(result.processingTimeMs);
  }
}

// ==================== 导出 ====================

// 单例实例
let correlatorInstance = null;

/**
 * 获取 AlertCorrelator 单例
 */
function getAlertCorrelator(config = {}) {
  if (!correlatorInstance) {
    correlatorInstance = new AlertCorrelator(config);
  }
  return correlatorInstance;
}

/**
 * 处理告警的便捷函数
 */
async function processAlert(alert) {
  return getAlertCorrelator().processAlert(alert);
}

/**
 * 获取当前活跃告警
 */
function getActiveAlerts() {
  return Array.from(getAlertCorrelator().activeAlerts.values());
}

/**
 * 获取告警历史
 */
function getAlertHistory(limit = 100) {
  const correlator = getAlertCorrelator();
  return correlator.alertHistory.slice(-limit);
}

/**
 * 清除所有告警（测试用）
 */
function clearAlerts() {
  const correlator = getAlertCorrelator();
  correlator.activeAlerts.clear();
  correlator.alertHistory = [];
}

module.exports = {
  AlertCorrelator,
  getAlertCorrelator,
  processAlert,
  getActiveAlerts,
  getAlertHistory,
  clearAlerts,
  SERVICE_TOPOLOGY,
  CAUSAL_RULES,
  SEVERITY_WEIGHTS
};
