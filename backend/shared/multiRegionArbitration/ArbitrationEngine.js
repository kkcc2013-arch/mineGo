/**
 * REQ-00514: 多区域服务状态同步与智能仲裁系统
 * ArbitrationEngine - 智能仲裁引擎
 * 
 * 功能：
 * - 根据状态快照执行仲裁决策
 * - 分类故障类型（局部故障 vs 区域故障 vs 全局故障）
 * - 生成并执行决策
 * - 与 FailoverController 集成
 * 
 * 创建时间: 2026-07-08 22:00 UTC
 */

'use strict';

const { EventEmitter } = require('events');
const { createLogger } = require('../logger');
const promClient = require('prom-client');

const logger = createLogger('arbitration-engine');

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  arbitrationDecisions: new promClient.Counter({
    name: 'minego_arbitration_decisions_total',
    help: 'Total arbitration decisions made',
    labelNames: ['fault_type', 'decision_type', 'region', 'result']
  }),
  
  arbitrationLatency: new promClient.Histogram({
    name: 'minego_arbitration_latency_ms',
    help: 'Arbitration decision latency in milliseconds',
    labelNames: ['fault_type'],
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000]
  }),
  
  currentFaultType: new promClient.Gauge({
    name: 'minego_current_fault_type',
    help: 'Current fault type classification (0=local, 1=regional, 2=global)',
    labelNames: ['region']
  }),
  
  arbitrationInProgress: new promClient.Gauge({
    name: 'minego_arbitration_in_progress',
    help: 'Arbitration currently in progress (0/1)'
  }),
  
  escalationEvents: new promClient.Counter({
    name: 'minego_fault_escalation_events_total',
    help: 'Total fault escalation events',
    labelNames: ['from_type', 'to_type', 'service', 'region']
  })
};

// ============================================================
// 仲裁规则配置
// ============================================================

const DEFAULT_RULES = {
  localFault: {
    threshold: 30,
    action: 'degradation',
    description: '局部故障：单服务/单节点故障，优先尝试局部修复'
  },
  
  regionalFault: {
    threshold: 60,
    action: 'regional_switch',
    description: '区域故障：多服务/多节点故障，区域内切换'
  },
  
  globalFault: {
    threshold: 80,
    action: 'failover',
    description: '全局故障：核心服务全区域故障，全局灾备切换'
  }
};

// ============================================================
// 决策优先级
// ============================================================

const DECISION_PRIORITY = {
  degradation: 1,       // 优先尝试降级修复
  regional_switch: 2,   // 区域内切换
  regional_recover: 3,  // 区域恢复
  failover: 4,          // 全局灾备切换
  escalate: 5           // 升级处理
};

// ============================================================
// 配置
// ============================================================

const DEFAULT_CONFIG = {
  rules: DEFAULT_RULES,
  decisionTimeoutMs: 30000,
  cooldownPeriodMs: 60000,
  maxEscalationLevel: 3,
  autoExecute: true,
  decisionLogRetention: 100
};

// ============================================================
// ArbitrationEngine 类
// ============================================================

class ArbitrationEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // 仲裁状态
    this.arbitrationState = {
      inProgress: false,
      currentDecision: null,
      lastDecision: null,
      decisionHistory: [],
      escalationLevel: 0
    };
    
    // 引用组件（需在 initialize 时设置）
    this.stateCollector = null;
    this.dependencyAnalyzer = null;
    this.degradationPolicy = null;
    this.splitBrainPrevention = null;
    this.failoverController = null;
  }

  /**
   * 初始化仲裁引擎
   */
  async initialize(components) {
    this.stateCollector = components.stateCollector;
    this.dependencyAnalyzer = components.dependencyAnalyzer;
    this.degradationPolicy = components.degradationPolicy;
    this.splitBrainPrevention = components.splitBrainPrevention;
    this.failoverController = components.failoverController;
    
    logger.info('ArbitrationEngine initialized');
  }

  /**
   * 执行仲裁决策
   */
  async arbitrate(stateSnapshot) {
    const startTime = Date.now();
    
    // 检查是否已有仲裁在进行
    if (this.arbitrationState.inProgress) {
      logger.warn('Arbitration already in progress');
      return {
        status: 'pending',
        message: 'Arbitration already in progress'
      };
    }
    
    // 设置仲裁锁定
    this.arbitrationState.inProgress = true;
    metrics.arbitrationInProgress.set(1);
    
    if (this.stateCollector) {
      this.stateCollector.setArbitrationLocked(true);
    }
    
    try {
      // 分析各区域状态
      const regionAnalysis = this.analyzeRegions(stateSnapshot);
      
      // 确定最严重的故障
      const worstFault = this.findWorstFault(regionAnalysis);
      
      if (!worstFault) {
        // 无故障或所有区域健康
        logger.debug('No fault detected in arbitration');
        return {
          status: 'healthy',
          decision: 'none',
          message: 'All regions healthy'
        };
      }
      
      // 分类故障类型
      const faultClassification = this.classifyFault(worstFault);
      
      // 生成决策
      const decision = this.generateDecision(faultClassification, regionAnalysis, stateSnapshot);
      
      // 记录决策
      this.recordDecision(decision);
      
      // 执行决策（如果启用自动执行）
      if (this.config.autoExecute) {
        const executionResult = await this.executeDecision(decision);
        decision.executionResult = executionResult;
      }
      
      const latency = Date.now() - startTime;
      metrics.arbitrationLatency.observe({ fault_type: faultClassification.type }, latency);
      
      logger.info('Arbitration decision made', {
        faultType: faultClassification.type,
        decisionType: decision.type,
        latency,
        affectedRegion: worstFault.region,
        affectedService: worstFault.service
      });
      
      return decision;
    } catch (error) {
      metrics.arbitrationDecisions.inc({
        fault_type: 'unknown',
        decision_type: 'error',
        region: 'unknown',
        result: 'error'
      });
      
      logger.error('Arbitration failed', { error: error.message });
      
      return {
        status: 'error',
        error: error.message
      };
    } finally {
      this.arbitrationState.inProgress = false;
      metrics.arbitrationInProgress.set(0);
      
      if (this.stateCollector) {
        this.stateCollector.setArbitrationLocked(false);
      }
    }
  }

  /**
   * 分析各区域状态
   */
  analyzeRegions(stateSnapshot) {
    const analysis = {};
    
    for (const [region, state] of Object.entries(stateSnapshot.regions || {})) {
      // 计算各故障服务的严重度
      const faultServices = [];
      
      for (const [service, serviceState] of Object.entries(state.services || {})) {
        if (serviceState?.healthy !== true) {
          const severity = this.dependencyAnalyzer?.calculateSeverity(region, service, state) 
            || { score: 50, faultType: 'regional' };
          
          faultServices.push({
            service,
            severity: severity.score,
            faultType: severity.faultType,
            impactChain: severity.impactChain,
            error: serviceState.error
          });
        }
      }
      
      // 计算区域整体严重度
      const regionSeverity = this.calculateRegionSeverity(faultServices);
      
      analysis[region] = {
        healthy: state.healthy,
        latency: state.latency,
        faultServices,
        regionSeverity,
        faultCount: faultServices.length,
        criticalFaultCount: faultServices.filter(f => 
          this.dependencyAnalyzer?.isServiceCritical(f.service)
        ).length
      };
      
      // 设置指标
      metrics.currentFaultType.set({ region }, 
        this.mapFaultTypeToNumber(regionSeverity.type)
      );
    }
    
    return analysis;
  }

  /**
   * 计算区域整体严重度
   */
  calculateRegionSeverity(faultServices) {
    if (faultServices.length === 0) {
      return { score: 0, type: 'none' };
    }
    
    // 最高严重度
    const maxSeverity = Math.max(...faultServices.map(f => f.severity));
    
    // 平均严重度
    const avgSeverity = faultServices.reduce((sum, f) => sum + f.severity, 0) / faultServices.length;
    
    // 综合严重度（加权）
    const combinedSeverity = maxSeverity * 0.6 + avgSeverity * 0.4;
    
    // 分类故障类型
    const type = this.classifyFaultBySeverity(combinedSeverity);
    
    return {
      score: combinedSeverity,
      maxSeverity,
      avgSeverity,
      type
    };
  }

  /**
   * 找到最严重的故障
   */
  findWorstFault(regionAnalysis) {
    let worstFault = null;
    let worstSeverity = 0;
    
    for (const [region, analysis] of Object.entries(regionAnalysis)) {
      for (const fault of analysis.faultServices || []) {
        if (fault.severity > worstSeverity) {
          worstSeverity = fault.severity;
          worstFault = {
            region,
            ...fault
          };
        }
      }
    }
    
    return worstFault;
  }

  /**
   * 分类故障类型
   */
  classifyFault(fault) {
    const severity = fault.severity;
    const regionSeverity = fault.regionSeverity || severity;
    
    const type = this.classifyFaultBySeverity(regionSeverity);
    
    return {
      type,
      severity,
      region: fault.region,
      service: fault.service,
      impactChain: fault.impactChain,
      description: this.config.rules[type]?.description || 'Unknown fault type'
    };
  }

  /**
   * 根据严重度分类故障类型
   */
  classifyFaultBySeverity(severity) {
    const { localFault, regionalFault, globalFault } = this.config.rules;
    
    if (severity < localFault.threshold) {
      return 'local';
    } else if (severity < regionalFault.threshold) {
      return 'regional';
    } else if (severity >= globalFault.threshold) {
      return 'global';
    } else {
      return 'regional';
    }
  }

  /**
   * 将故障类型映射为数值
   */
  mapFaultTypeToNumber(type) {
    const map = { none: 0, local: 1, regional: 2, global: 3 };
    return map[type] || 0;
  }

  /**
   * 生成决策
   */
  generateDecision(faultClassification, regionAnalysis, stateSnapshot) {
    const decision = {
      id: `arb-${Date.now()}`,
      timestamp: new Date().toISOString(),
      faultType: faultClassification.type,
      faultSeverity: faultClassification.severity,
      affectedRegion: faultClassification.region,
      affectedService: faultClassification.service,
      type: null, // 决策类型
      action: null, // 具体动作
      priority: 0,
      details: {},
      healthyRegions: [],
      recoveryPlan: []
    };
    
    // 获取健康区域
    decision.healthyRegions = Object.entries(regionAnalysis)
      .filter(([_, a]) => a.healthy)
      .map(([region]) => region);
    
    // 根据故障类型生成决策
    const faultType = faultClassification.type;
    
    switch (faultType) {
      case 'local':
        decision.type = 'degradation';
        decision.action = this.config.rules.localFault.action;
        decision.priority = DECISION_PRIORITY.degradation;
        decision.details = {
          strategy: 'try_local_fix',
          timeoutMs: 30000,
          fallback: 'regional_switch'
        };
        decision.recoveryPlan = [
          { step: 'isolate_fault', service: faultClassification.service },
          { step: 'try_local_fix', service: faultClassification.service },
          { step: 'monitor_recovery', duration: 30000 },
          { step: 'escalate_if_needed' }
        ];
        break;
        
      case 'regional':
        decision.type = 'regional_switch';
        decision.action = this.config.rules.regionalFault.action;
        decision.priority = DECISION_PRIORITY.regional_switch;
        decision.details = {
          strategy: 'regional_recovery',
          targetRegion: decision.healthyRegions[0] || 'backup',
          fallback: 'failover'
        };
        decision.recoveryPlan = [
          { step: 'redirect_traffic', toRegion: decision.details.targetRegion },
          { step: 'isolate_faulty_region', region: faultClassification.region },
          { step: 'attempt_region_recovery' },
          { step: 'restore_traffic_after_recovery' }
        ];
        break;
        
      case 'global':
        decision.type = 'failover';
        decision.action = this.config.rules.globalFault.action;
        decision.priority = DECISION_PRIORITY.failover;
        decision.details = {
          strategy: 'global_failover',
          targetRegion: this.findBestRecoveryRegion(decision.healthyRegions, regionAnalysis),
          requireQuorum: true
        };
        decision.recoveryPlan = [
          { step: 'acquire_arbitration_lock' },
          { step: 'vote_for_failover' },
          { step: 'execute_failover', toRegion: decision.details.targetRegion },
          { step: 'verify_service_health' },
          { step: 'notify_stakeholders' }
        ];
        break;
        
      default:
        decision.type = 'monitor';
        decision.action = 'continue_monitoring';
        decision.priority = 0;
    }
    
    return decision;
  }

  /**
   * 找到最佳恢复区域
   */
  findBestRecoveryRegion(healthyRegions, regionAnalysis) {
    if (healthyRegions.length === 0) {
      return 'backup';
    }
    
    // 选择延迟最低的健康区域
    let bestRegion = healthyRegions[0];
    let bestLatency = regionAnalysis[bestRegion]?.latency || 9999;
    
    for (const region of healthyRegions) {
      const latency = regionAnalysis[region]?.latency || 9999;
      if (latency < bestLatency) {
        bestLatency = latency;
        bestRegion = region;
      }
    }
    
    return bestRegion;
  }

  /**
   * 执行决策
   */
  async executeDecision(decision) {
    const startTime = Date.now();
    
    logger.info('Executing decision', {
      decisionType: decision.type,
      affectedRegion: decision.affectedRegion,
      affectedService: decision.affectedService
    });
    
    try {
      let result;
      
      switch (decision.type) {
        case 'degradation':
          result = await this.executeDegradationDecision(decision);
          break;
          
        case 'regional_switch':
          result = await this.executeRegionalSwitchDecision(decision);
          break;
          
        case 'failover':
          result = await this.executeFailoverDecision(decision);
          break;
          
        case 'monitor':
          result = { status: 'monitoring', message: 'Continuing to monitor' };
          break;
          
        default:
          result = { status: 'unknown', message: 'Unknown decision type' };
      }
      
      const duration = Date.now() - startTime;
      
      metrics.arbitrationDecisions.inc({
        fault_type: decision.faultType,
        decision_type: decision.type,
        region: decision.affectedRegion,
        result: 'success'
      });
      
      result.duration = duration;
      
      logger.info('Decision executed successfully', {
        decisionType: decision.type,
        duration
      });
      
      this.emit('decision-executed', { decision, result });
      
      return result;
    } catch (error) {
      metrics.arbitrationDecisions.inc({
        fault_type: decision.faultType,
        decision_type: decision.type,
        region: decision.affectedRegion,
        result: 'error'
      });
      
      logger.error('Decision execution failed', {
        decisionType: decision.type,
        error: error.message
      });
      
      this.emit('decision-failed', { decision, error });
      
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  /**
   * 执行降级决策
   */
  async executeDegradationDecision(decision) {
    if (this.degradationPolicy) {
      const result = await this.degradationPolicy.tryLocalFix(
        decision.affectedRegion,
        {
          service: decision.affectedService,
          severity: decision.faultSeverity
        }
      );
      
      return result;
    }
    
    return {
      status: 'degradation_initiated',
      message: 'Degradation policy not configured, manual intervention required'
    };
  }

  /**
   * 执行区域切换决策
   */
  async executeRegionalSwitchDecision(decision) {
    const targetRegion = decision.details.targetRegion;
    
    logger.info('Executing regional switch', {
      fromRegion: decision.affectedRegion,
      toRegion: targetRegion
    });
    
    // 更新活跃区域
    if (this.stateCollector) {
      this.stateCollector.setActiveRegion(targetRegion);
    }
    
    return {
      status: 'regional_switch_completed',
      fromRegion: decision.affectedRegion,
      toRegion: targetRegion
    };
  }

  /**
   * 执行灾备切换决策
   */
  async executeFailoverDecision(decision) {
    // 获取仲裁锁（防脑裂）
    if (this.splitBrainPrevention && decision.details.requireQuorum) {
      const lockAcquired = await this.splitBrainPrevention.acquireArbitrationLock();
      
      if (!lockAcquired) {
        return {
          status: 'lock_denied',
          message: 'Unable to acquire arbitration lock, another arbitration in progress'
        };
      }
      
      // 投票决策
      const votes = await this.splitBrainPrevention.voteForSwitch(decision);
      const quorumReached = await this.splitBrainPrevention.checkQuorum(votes);
      
      if (!quorumReached) {
        await this.splitBrainPrevention.releaseLock();
        return {
          status: 'quorum_not_reached',
          message: 'Failover decision did not reach quorum',
          votes
        };
      }
    }
    
    // 执行灾备切换
    if (this.failoverController) {
      const failoverResult = await this.failoverController.failover({
        trigger: 'arbitration',
        reason: `Global fault detected: ${decision.affectedService} in ${decision.affectedRegion}`,
        force: decision.faultSeverity >= 90
      });
      
      // 释放锁
      if (this.splitBrainPrevention) {
        await this.splitBrainPrevention.releaseLock();
      }
      
      return {
        status: 'failover_completed',
        failoverResult
      };
    }
    
    return {
      status: 'failover_initiated',
      targetRegion: decision.details.targetRegion,
      message: 'FailoverController not configured'
    };
  }

  /**
   * 升级故障等级
   */
  async escalate(currentDecision, newSeverity) {
    const oldType = currentDecision.faultType;
    const newType = this.classifyFaultBySeverity(newSeverity);
    
    if (newType !== oldType) {
      metrics.escalationEvents.inc({
        from_type: oldType,
        to_type: newType,
        service: currentDecision.affectedService,
        region: currentDecision.affectedRegion
      });
      
      logger.warn('Fault escalation', {
        fromType: oldType,
        toType: newType,
        newSeverity,
        service: currentDecision.affectedService
      });
      
      this.arbitrationState.escalationLevel++;
      
      // 重新仲裁
      const stateSnapshot = this.stateCollector?.getStateSnapshot();
      if (stateSnapshot) {
        return await this.arbitrate(stateSnapshot);
      }
    }
    
    return currentDecision;
  }

  /**
   * 记录决策
   */
  recordDecision(decision) {
    this.arbitrationState.lastDecision = decision;
    this.arbitrationState.decisionHistory.push(decision);
    
    // 限制历史记录长度
    if (this.arbitrationState.decisionHistory.length > this.config.decisionLogRetention) {
      this.arbitrationState.decisionHistory.shift();
    }
  }

  /**
   * 获取决策历史
   */
  getDecisionHistory(limit = 10) {
    return this.arbitrationState.decisionHistory.slice(-limit);
  }

  /**
   * 获取最后决策
   */
  getLastDecision() {
    return this.arbitrationState.lastDecision;
  }

  /**
   * 获取仲裁状态
   */
  getArbitrationState() {
    return {
      inProgress: this.arbitrationState.inProgress,
      lastDecision: this.arbitrationState.lastDecision,
      escalationLevel: this.arbitrationState.escalationLevel,
      historyCount: this.arbitrationState.decisionHistory.length
    };
  }

  /**
   * 清除历史
   */
  clearHistory() {
    this.arbitrationState.decisionHistory = [];
    logger.info('Decision history cleared');
  }
}

module.exports = ArbitrationEngine;