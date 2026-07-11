/**
 * 多区域智能仲裁引擎
 * @module backend/shared/regionSync/ArbitrationEngine
 * 
 * 功能：
 * - 检测区域冲突
 * - 执行仲裁算法
 * - 决定故障转移策略
 * - 记录仲裁历史
 */

'use strict';

const { createLogger } = require('../logger');
const { query } = require('../db');
const { getRedis } = require('../redis');
const metrics = require('../metrics');

const logger = createLogger('arbitration-engine');

// 仲裁结果类型
const ARBITRATION_ACTIONS = {
  SWITCH_REGION: 'switch_region',      // 切换到其他区域
  SYNC_STATE: 'sync_state',             // 强制同步状态
  ALERT: 'alert',                        // 仅告警
  NO_ACTION: 'no_action',               // 无需操作
  MANUAL_INTERVENTION: 'manual_intervention' // 需人工干预
};

// 冲突类型
const CONFLICT_TYPES = {
  STATE_MISMATCH: 'state_mismatch',       // 状态不一致
  SPLIT_BRAIN: 'split_brain',             // 脑裂
  NETWORK_PARTITION: 'network_partition', // 网络分区
  LEADER_ELECTION: 'leader_election',     // 领导选举冲突
  DATA_DIVERGENCE: 'data_divergence'      // 数据分歧
};

/**
 * 智能仲裁引擎
 */
class ArbitrationEngine {
  constructor(options = {}) {
    this.regionPriorities = options.regionPriorities || {
      'cn-east': 1,
      'cn-north': 2,
      'cn-south': 3,
      'ap-southeast': 4
    };
    
    this.minHealthyRegions = options.minHealthyRegions || 2;
    this.maxLatencyMs = options.maxLatencyMs || 1000;
    
    this.metrics = this._initMetrics();
  }

  /**
   * 初始化指标
   */
  _initMetrics() {
    return {
      arbitrationTotal: metrics.counter('arbitration_total', 'Arbitration total count', ['reason', 'action']),
      arbitrationDuration: metrics.histogram('arbitration_duration_ms', 'Arbitration duration', [], [50, 100, 250, 500, 1000])
    };
  }

  /**
   * 执行仲裁
   */
  async arbitrate(context) {
    const startTime = Date.now();
    const { currentRegion, reason, regionStates, conflictData } = context;
    
    logger.info({ currentRegion, reason }, 'Starting arbitration');
    
    try {
      // 1. 分析当前状态
      const analysis = await this._analyzeSituation(regionStates);
      
      // 2. 根据原因选择仲裁策略
      let result;
      switch (reason) {
        case 'region_health_degraded':
          result = await this._arbitrateRegionDegraded(analysis, currentRegion);
          break;
        case 'state_mismatch':
          result = await this._arbitrateStateMismatch(analysis, conflictData);
          break;
        case 'split_brain':
          result = await this._arbitrateSplitBrain(analysis, conflictData);
          break;
        case 'network_partition':
          result = await this._arbitrateNetworkPartition(analysis, currentRegion);
          break;
        case 'leader_election':
          result = await this._arbitrateLeaderElection(analysis, conflictData);
          break;
        default:
          result = await this._arbitrateDefault(analysis, currentRegion);
      }
      
      // 3. 记录仲裁历史
      await this._recordArbitration({
        currentRegion,
        reason,
        analysis,
        result,
        timestamp: Date.now()
      });
      
      // 4. 更新指标
      const duration = Date.now() - startTime;
      this.metrics.arbitrationTotal.inc({ reason, action: result.action });
      this.metrics.arbitrationDuration.observe(duration);
      
      logger.info({ reason, action: result.action, duration }, 'Arbitration completed');
      
      return result;
      
    } catch (error) {
      logger.error({ error, reason }, 'Arbitration failed');
      return {
        action: ARBITRATION_ACTIONS.ALERT,
        message: `Arbitration failed: ${error.message}`
      };
    }
  }

  /**
   * 分析当前情况
   */
  async _analyzeSituation(regionStates) {
    const analysis = {
      totalRegions: Object.keys(regionStates).length,
      healthyRegions: 0,
      degradedRegions: 0,
      unhealthyRegions: 0,
      regions: {},
      recommendations: []
    };
    
    for (const [regionId, state] of Object.entries(regionStates)) {
      const regionAnalysis = {
        id: regionId,
        health: state.health || 'unknown',
        priority: this.regionPriorities[regionId] || 999,
        serviceCount: Object.keys(state.services || {}).length,
        healthyServices: 0,
        lastUpdate: state.lastUpdate || 0
      };
      
      // 统计健康服务
      for (const serviceState of Object.values(state.services || {})) {
        if (serviceState.status === 'healthy') {
          regionAnalysis.healthyServices++;
        }
      }
      
      // 计算健康分数
      if (regionAnalysis.serviceCount > 0) {
        regionAnalysis.healthScore = regionAnalysis.healthyServices / regionAnalysis.serviceCount;
      } else {
        regionAnalysis.healthScore = 0;
      }
      
      analysis.regions[regionId] = regionAnalysis;
      
      // 汇总统计
      if (state.health === 'healthy') {
        analysis.healthyRegions++;
      } else if (state.health === 'degraded') {
        analysis.degradedRegions++;
      } else {
        analysis.unhealthyRegions++;
      }
    }
    
    // 生成推荐
    if (analysis.healthyRegions >= this.minHealthyRegions) {
      analysis.recommendations.push('sufficient_healthy_regions');
    } else {
      analysis.recommendations.push('insufficient_healthy_regions');
    }
    
    // 检查是否需要紧急切换
    const activeRegion = await this._getActiveRegion();
    if (activeRegion && regionStates[activeRegion]?.health !== 'healthy') {
      analysis.recommendations.push('active_region_unhealthy');
    }
    
    return analysis;
  }

  /**
   * 区域降级仲裁
   */
  async _arbitrateRegionDegraded(analysis, currentRegion) {
    const currentRegionAnalysis = analysis.regions[currentRegion];
    
    if (!currentRegionAnalysis || currentRegionAnalysis.health === 'healthy') {
      return {
        action: ARBITRATION_ACTIONS.NO_ACTION,
        message: 'Current region is healthy'
      };
    }
    
    // 寻找最佳切换目标
    const bestTarget = this._findBestSwitchTarget(analysis, currentRegion);
    
    if (!bestTarget) {
      logger.warn('No healthy region available for switch');
      return {
        action: ARBITRATION_ACTIONS.ALERT,
        message: 'No healthy region available for switch, manual intervention required'
      };
    }
    
    // 检查是否应该切换
    if (this._shouldSwitch(currentRegionAnalysis, analysis.regions[bestTarget])) {
      return {
        action: ARBITRATION_ACTIONS.SWITCH_REGION,
        targetRegion: bestTarget,
        reason: `Current region ${currentRegion} is ${currentRegionAnalysis.health}`,
        confidence: this._calculateSwitchConfidence(currentRegionAnalysis, analysis.regions[bestTarget])
      };
    }
    
    return {
      action: ARBITRATION_ACTIONS.ALERT,
      message: `Region ${currentRegion} degraded but not switching yet`
    };
  }

  /**
   * 状态不一致仲裁
   */
  async _arbitrateStateMismatch(analysis, conflictData) {
    const { sourceRegion, targetRegion, differences } = conflictData || {};
    
    if (!sourceRegion || !targetRegion) {
      return {
        action: ARBITRATION_ACTIONS.ALERT,
        message: 'Insufficient conflict data'
      };
    }
    
    // 确定权威源
    const authoritativeRegion = this._determineAuthoritativeRegion(
      analysis,
      sourceRegion,
      targetRegion
    );
    
    return {
      action: ARBITRATION_ACTIONS.SYNC_STATE,
      sourceRegion: authoritativeRegion,
      reason: `State mismatch between ${sourceRegion} and ${targetRegion}`,
      details: {
        authoritativeRegion,
        differences: differences || []
      }
    };
  }

  /**
   * 脑裂仲裁
   */
  async _arbitrateSplitBrain(analysis, conflictData) {
    logger.error('Split brain detected, critical arbitration required');
    
    // 脑裂是最严重的情况，需要快速决策
    const { claimedLeader1, claimedLeader2 } = conflictData || {};
    
    // 基于优先级和健康度选择主区域
    const candidate1 = analysis.regions[claimedLeader1];
    const candidate2 = analysis.regions[claimedLeader2];
    
    let winner;
    if (candidate1 && candidate2) {
      // 比较优先级和健康度
      const score1 = candidate1.healthScore * 10 - candidate1.priority;
      const score2 = candidate2.healthScore * 10 - candidate2.priority;
      
      winner = score1 >= score2 ? claimedLeader1 : claimedLeader2;
    } else if (candidate1) {
      winner = claimedLeader1;
    } else if (candidate2) {
      winner = claimedLeader2;
    } else {
      // 无法自动解决
      return {
        action: ARBITRATION_ACTIONS.MANUAL_INTERVENTION,
        message: 'Split brain detected but no valid leader candidate, manual intervention required'
      };
    }
    
    return {
      action: ARBITRATION_ACTIONS.SWITCH_REGION,
      targetRegion: winner,
      reason: 'Split brain resolution',
      confidence: 0.95,
      emergency: true
    };
  }

  /**
   * 网络分区仲裁
   */
  async _arbitrateNetworkPartition(analysis, currentRegion) {
    const activeRegion = await this._getActiveRegion();
    
    // 如果当前区域是主区域且在多数派中，保持不变
    if (activeRegion === currentRegion && analysis.healthyRegions >= this.minHealthyRegions) {
      return {
        action: ARBITRATION_ACTIONS.NO_ACTION,
        message: 'Current region is leader and has quorum'
      };
    }
    
    // 如果当前区域在少数派，切换到多数派的主区域
    const majorityLeader = this._findMajorityLeader(analysis);
    
    if (majorityLeader && majorityLeader !== currentRegion) {
      return {
        action: ARBITRATION_ACTIONS.SYNC_STATE,
        sourceRegion: majorityLeader,
        reason: 'Network partition detected, syncing from majority leader'
      };
    }
    
    return {
      action: ARBITRATION_ACTIONS.ALERT,
      message: 'Network partition detected but no clear majority leader'
    };
  }

  /**
   * 领导选举仲裁
   */
  async _arbitrateLeaderElection(analysis, conflictData) {
    const { candidates } = conflictData || { candidates: [] };
    
    if (candidates.length === 0) {
      // 无候选者，选择最优区域
      const bestRegion = this._findBestSwitchTarget(analysis, null);
      return {
        action: ARBITRATION_ACTIONS.SWITCH_REGION,
        targetRegion: bestRegion,
        reason: 'Leader election with no candidates'
      };
    }
    
    if (candidates.length === 1) {
      return {
        action: ARBITRATION_ACTIONS.SWITCH_REGION,
        targetRegion: candidates[0],
        reason: 'Single leader candidate'
      };
    }
    
    // 多候选者，选择最优
    let bestCandidate = null;
    let bestScore = -1;
    
    for (const candidate of candidates) {
      const candidateAnalysis = analysis.regions[candidate];
      if (!candidateAnalysis) continue;
      
      const score = this._calculateRegionScore(candidateAnalysis);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }
    
    if (bestCandidate) {
      return {
        action: ARBITRATION_ACTIONS.SWITCH_REGION,
        targetRegion: bestCandidate,
        reason: 'Leader election resolved',
        confidence: bestScore
      };
    }
    
    return {
      action: ARBITRATION_ACTIONS.MANUAL_INTERVENTION,
      message: 'Leader election could not be resolved automatically'
    };
  }

  /**
   * 默认仲裁策略
   */
  async _arbitrateDefault(analysis, currentRegion) {
    const currentAnalysis = analysis.regions[currentRegion];
    
    if (currentAnalysis && currentAnalysis.health === 'healthy') {
      return {
        action: ARBITRATION_ACTIONS.NO_ACTION,
        message: 'Current region is healthy, no action needed'
      };
    }
    
    // 寻找最佳切换目标
    const bestTarget = this._findBestSwitchTarget(analysis, currentRegion);
    
    if (bestTarget) {
      return {
        action: ARBITRATION_ACTIONS.SWITCH_REGION,
        targetRegion: bestTarget,
        reason: 'Default arbitration: switching to best available region'
      };
    }
    
    return {
      action: ARBITRATION_ACTIONS.ALERT,
      message: 'No action determined'
    };
  }

  /**
   * 寻找最佳切换目标
   */
  _findBestSwitchTarget(analysis, excludeRegion) {
    let bestRegion = null;
    let bestScore = -1;
    
    for (const [regionId, regionAnalysis] of Object.entries(analysis.regions)) {
      if (regionId === excludeRegion) continue;
      if (regionAnalysis.health !== 'healthy') continue;
      
      const score = this._calculateRegionScore(regionAnalysis);
      if (score > bestScore) {
        bestScore = score;
        bestRegion = regionId;
      }
    }
    
    return bestRegion;
  }

  /**
   * 计算区域得分
   */
  _calculateRegionScore(regionAnalysis) {
    // 综合考虑优先级、健康度、服务数量
    const priorityScore = (10 - regionAnalysis.priority) / 10 * 30; // 优先级占 30%
    const healthScore = regionAnalysis.healthScore * 50; // 健康度占 50%
    const serviceScore = Math.min(regionAnalysis.healthyServices / 10, 1) * 20; // 服务数占 20%
    
    return priorityScore + healthScore + serviceScore;
  }

  /**
   * 判断是否应该切换
   */
  _shouldSwitch(currentRegion, targetRegion) {
    if (!currentRegion || !targetRegion) return false;
    
    // 目标区域必须健康
    if (targetRegion.health !== 'healthy') return false;
    
    // 当前区域不健康或降级
    if (currentRegion.health === 'unhealthy') return true;
    
    // 当前区域降级且目标区域明显更优
    if (currentRegion.health === 'degraded') {
      const currentScore = this._calculateRegionScore(currentRegion);
      const targetScore = this._calculateRegionScore(targetRegion);
      return targetScore > currentScore * 1.2; // 目标区域得分高 20% 以上
    }
    
    return false;
  }

  /**
   * 计算切换置信度
   */
  _calculateSwitchConfidence(currentRegion, targetRegion) {
    if (!currentRegion || !targetRegion) return 0;
    
    let confidence = 0.5; // 基础置信度
    
    // 当前区域不健康 = 高置信度
    if (currentRegion.health === 'unhealthy') {
      confidence += 0.3;
    } else if (currentRegion.health === 'degraded') {
      confidence += 0.15;
    }
    
    // 目标区域优先级高 = 增加置信度
    if (targetRegion.priority === 1) {
      confidence += 0.2;
    } else if (targetRegion.priority === 2) {
      confidence += 0.1;
    }
    
    return Math.min(confidence, 1.0);
  }

  /**
   * 确定权威源
   */
  _determineAuthoritativeRegion(analysis, region1, region2) {
    const analysis1 = analysis.regions[region1];
    const analysis2 = analysis.regions[region2];
    
    if (!analysis1) return region2;
    if (!analysis2) return region1;
    
    // 比较得分
    const score1 = this._calculateRegionScore(analysis1);
    const score2 = this._calculateRegionScore(analysis2);
    
    return score1 >= score2 ? region1 : region2;
  }

  /**
   * 查找多数派领导者
   */
  _findMajorityLeader(analysis) {
    const totalRegions = analysis.totalRegions;
    const majority = Math.floor(totalRegions / 2) + 1;
    
    if (analysis.healthyRegions >= majority) {
      // 存在多数派
      return this._findBestSwitchTarget(analysis, null);
    }
    
    return null;
  }

  /**
   * 获取当前活跃区域
   */
  async _getActiveRegion() {
    try {
      const redis = getRedis();
      return await redis.get('region:active');
    } catch (error) {
      logger.error({ error }, 'Failed to get active region');
      return null;
    }
  }

  /**
   * 记录仲裁历史
   */
  async _recordArbitration(data) {
    try {
      await query(`
        INSERT INTO arbitration_history (
          current_region,
          reason,
          analysis,
          result,
          timestamp
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        data.currentRegion,
        data.reason,
        JSON.stringify(data.analysis),
        JSON.stringify(data.result),
        new Date(data.timestamp)
      ]);
    } catch (error) {
      logger.error({ error }, 'Failed to record arbitration history');
    }
  }
}

module.exports = {
  ArbitrationEngine,
  ARBITRATION_ACTIONS,
  CONFLICT_TYPES
};
