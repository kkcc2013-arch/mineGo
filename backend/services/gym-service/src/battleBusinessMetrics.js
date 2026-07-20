/**
 * REQ-00614: 核心战斗逻辑业务指标监控系统
 * 创建时间: 2026-07-20 19:00
 * 
 * 功能:
 * - 战斗全链路业务指标埋点
 * - 战斗胜负比、技能执行耗时、伤害数值偏移监控
 * - 基于 Prometheus 的业务指标采集
 * - 战斗结算异常追踪
 */

const client = require('prom-client');
const logger = require('../../../shared/logger');

// ==================== 战斗核心业务指标 ====================

// 战斗胜负比（实时计算）
const battleWinRateGauge = new client.Gauge({
  name: 'battle_win_rate_ratio',
  help: 'Current battle win rate ratio (0-1)',
  labelNames: ['battle_type', 'player_level_range']
});

// 战斗总场次（用于计算胜负比）
const battleTotalCount = new client.Counter({
  name: 'battle_total_count',
  help: 'Total number of battles completed',
  labelNames: ['battle_type', 'player_level_range']
});

// 战斗胜利计数
const battleWinCount = new client.Counter({
  name: 'battle_win_count',
  help: 'Total number of battles won',
  labelNames: ['battle_type', 'player_level_range']
});

// 战斗结算耗时（直方图）
const battleSettlementDuration = new client.Histogram({
  name: 'battle_settlement_duration_seconds',
  help: 'Duration of battle settlement processing in seconds',
  labelNames: ['battle_type'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30]
});

// 战斗结算异常计数
const battleSettlementErrorTotal = new client.Counter({
  name: 'battle_settlement_error_total',
  help: 'Total number of battle settlement errors',
  labelNames: ['battle_type', 'error_type']
});

// 战斗结算超时计数
const battleSettlementTimeoutTotal = new client.Counter({
  name: 'battle_settlement_timeout_total',
  help: 'Total number of battle settlement timeouts',
  labelNames: ['battle_type']
});

// ==================== 技能执行指标 ====================

// 技能执行总次数
const skillExecutionTotal = new client.Counter({
  name: 'skill_execution_total',
  help: 'Total number of skill executions',
  labelNames: ['skill_id', 'skill_name', 'battle_type']
});

// 技能执行耗时
const skillExecutionDuration = new client.Histogram({
  name: 'skill_execution_duration_seconds',
  help: 'Duration of skill execution in seconds',
  labelNames: ['skill_id', 'skill_name'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
});

// 技能执行异常计数
const skillExecutionErrorTotal = new client.Counter({
  name: 'skill_execution_error_total',
  help: 'Total number of skill execution errors',
  labelNames: ['skill_id', 'skill_name', 'error_type']
});

// 技能触发成功率
const skillTriggerSuccessRate = new client.Gauge({
  name: 'skill_trigger_success_rate',
  help: 'Skill trigger success rate (0-1)',
  labelNames: ['skill_id', 'skill_name']
});

// ==================== 伤害数值指标 ====================

// 伤害数值分布
const damageDealtHistogram = new client.Histogram({
  name: 'battle_damage_dealt_detailed',
  help: 'Distribution of damage dealt in battle',
  labelNames: ['battle_type', 'damage_type'],
  buckets: [0, 10, 25, 50, 100, 200, 500, 1000, 2000, 5000]
});

// 伤害数值偏移（预期 vs 实际）
const damageDeviationGauge = new client.Gauge({
  name: 'battle_damage_deviation_ratio',
  help: 'Ratio of damage deviation from expected value',
  labelNames: ['battle_type']
});

// 暴击率
const criticalHitRate = new client.Gauge({
  name: 'battle_critical_hit_rate',
  help: 'Critical hit rate in battles (0-1)',
  labelNames: ['battle_type']
});

// 属性克制触发率
const typeEffectivenessRate = new client.Gauge({
  name: 'battle_type_effectiveness_rate',
  help: 'Type effectiveness trigger rate (0-1)',
  labelNames: ['effectiveness_level']
});

// ==================== 战斗 ID 追踪 ====================

// 战斗追踪记录（用于关联异常）
const battleTraces = new Map();

// 战斗追踪开始
const battleTraceStart = new client.Counter({
  name: 'battle_trace_start_total',
  help: 'Total number of battle traces started',
  labelNames: ['battle_type']
});

// 战斗追踪结束
const battleTraceEnd = new client.Counter({
  name: 'battle_trace_end_total',
  help: 'Total number of battle traces ended',
  labelNames: ['battle_type', 'result']
});

// ==================== 业务指标记录器 ====================

class BattleBusinessMetricsRecorder {
  constructor() {
    this.battleStats = new Map(); // 存储战斗统计数据用于实时计算
    this.skillStats = new Map();  // 技能统计
    this.damageStats = new Map(); // 伤害统计
  }

  /**
   * 记录战斗开始
   * @param {string} battleId - 战斗 ID
   * @param {string} battleType - 战斗类型 (gym, pvp, raid, team)
   * @param {number} playerLevel - 玩家等级
   */
  recordBattleStart(battleId, battleType, playerLevel) {
    const levelRange = this.getLevelRange(playerLevel);
    const startTime = Date.now();

    battleTraces.set(battleId, {
      battleType,
      levelRange,
      startTime,
      skills: [],
      damages: [],
      errors: []
    });

    battleTraceStart.inc({ battle_type: battleType });
    logger.info({ battleId, battleType, levelRange }, 'Battle trace started');
  }

  /**
   * 记录战斗结算
   * @param {string} battleId - 战斗 ID
   * @param {string} result - 战斗结果 (win, lose, draw)
   * @param {number} duration - 战斗持续时间（秒）
   */
  recordBattleEnd(battleId, result, duration) {
    const trace = battleTraces.get(battleId);
    if (!trace) {
      logger.warn({ battleId }, 'Battle trace not found for end record');
      return;
    }

    const { battleType, levelRange } = trace;

    // 更新计数器
    battleTotalCount.inc({ battle_type: battleType, player_level_range: levelRange });
    if (result === 'win') {
      battleWinCount.inc({ battle_type: battleType, player_level_range: levelRange });
    }

    battleTraceEnd.inc({ battle_type: battleType, result });

    // 更新胜负比
    this.updateWinRate(battleType, levelRange, result);

    // 记录战斗耗时
    battleSettlementDuration.observe({ battle_type: battleType }, duration);

    // 清理追踪记录
    setTimeout(() => {
      battleTraces.delete(battleId);
    }, 300000); // 5分钟后清理

    logger.info({ battleId, battleType, result, duration }, 'Battle ended');
  }

  /**
   * 记录战斗结算错误
   * @param {string} battleId - 战斗 ID
   * @param {string} errorType - 错误类型
   * @param {Error} error - 错误对象
   */
  recordBattleError(battleId, errorType, error) {
    const trace = battleTraces.get(battleId);
    const battleType = trace?.battleType || 'unknown';

    battleSettlementErrorTotal.inc({ battle_type: battleType, error_type: errorType });

    if (trace) {
      trace.errors.push({
        errorType,
        message: error.message,
        timestamp: Date.now()
      });
    }

    logger.error({ battleId, battleType, errorType, error: error.message }, 'Battle error recorded');
  }

  /**
   * 记录战斗结算超时
   * @param {string} battleId - 战斗 ID
   */
  recordBattleTimeout(battleId) {
    const trace = battleTraces.get(battleId);
    const battleType = trace?.battleType || 'unknown';

    battleSettlementTimeoutTotal.inc({ battle_type: battleType });
    logger.warn({ battleId, battleType }, 'Battle settlement timeout');
  }

  /**
   * 记录技能执行
   * @param {string} battleId - 战斗 ID
   * @param {string} skillId - 技能 ID
   * @param {string} skillName - 技能名称
   * @param {number} duration - 执行耗时（秒）
   * @param {boolean} success - 是否成功
   */
  recordSkillExecution(battleId, skillId, skillName, duration, success) {
    const trace = battleTraces.get(battleId);
    const battleType = trace?.battleType || 'unknown';

    skillExecutionTotal.inc({ skill_id: skillId, skill_name: skillName, battle_type: battleType });
    skillExecutionDuration.observe({ skill_id: skillId, skill_name: skillName }, duration);

    if (!success) {
      skillExecutionErrorTotal.inc({ skill_id: skillId, skill_name: skillName, error_type: 'execution_failed' });
    }

    // 更新技能统计
    this.updateSkillStats(skillId, skillName, success);

    logger.debug({ battleId, skillId, skillName, duration, success }, 'Skill executed');
  }

  /**
   * 记录技能执行错误
   * @param {string} battleId - 战斗 ID
   * @param {string} skillId - 技能 ID
   * @param {string} skillName - 技能名称
   * @param {string} errorType - 错误类型
   */
  recordSkillError(battleId, skillId, skillName, errorType) {
    const trace = battleTraces.get(battleId);
    const battleType = trace?.battleType || 'unknown';

    skillExecutionErrorTotal.inc({ skill_id: skillId, skill_name: skillName, error_type: errorType });
    logger.error({ battleId, skillId, skillName, errorType }, 'Skill execution error');
  }

  /**
   * 记录伤害
   * @param {string} battleId - 战斗 ID
   * @param {number} damage - 实际伤害
   * @param {number} expectedDamage - 预期伤害
   * @param {string} damageType - 伤害类型 (normal, critical, effectiveness)
   */
  recordDamage(battleId, damage, expectedDamage, damageType = 'normal') {
    const trace = battleTraces.get(battleId);
    const battleType = trace?.battleType || 'unknown';

    damageDealtHistogram.observe({ battle_type: battleType, damage_type: damageType }, damage);

    // 计算伤害偏移
    if (expectedDamage > 0) {
      const deviation = Math.abs(damage - expectedDamage) / expectedDamage;
      damageDeviationGauge.set({ battle_type: battleType }, deviation);
    }

    // 统计暴击
    if (damageType === 'critical') {
      this.updateCriticalHitRate(battleType, true);
    } else {
      this.updateCriticalHitRate(battleType, false);
    }

    logger.debug({ battleId, damage, expectedDamage, damageType }, 'Damage recorded');
  }

  /**
   * 记录属性克制
   * @param {string} battleId - 战斗 ID
   * @param {number} multiplier - 克制倍率
   */
  recordTypeEffectiveness(battleId, multiplier) {
    let effectivenessLevel = 'normal';
    if (multiplier > 1) {
      effectivenessLevel = 'super_effective';
    } else if (multiplier < 1 && multiplier > 0) {
      effectivenessLevel = 'not_very_effective';
    } else if (multiplier === 0) {
      effectivenessLevel = 'no_effect';
    }

    typeEffectivenessRate.set({ effectiveness_level: effectivenessLevel }, multiplier);
  }

  /**
   * 获取战斗追踪信息
   * @param {string} battleId - 战斗 ID
   * @returns {Object|null}
   */
  getBattleTrace(battleId) {
    return battleTraces.get(battleId) || null;
  }

  /**
   * 获取战斗追踪统计
   * @returns {Object}
   */
  getBattleTraceStats() {
    return {
      activeTraces: battleTraces.size,
      totalBattles: Array.from(battleTraces.values()).reduce((sum, trace) => {
        return sum + 1;
      }, 0)
    };
  }

  // ==================== 辅助方法 ====================

  /**
   * 获取等级范围
   */
  getLevelRange(level) {
    if (level < 10) return '1-9';
    if (level < 20) return '10-19';
    if (level < 30) return '20-29';
    if (level < 40) return '30-39';
    return '40+';
  }

  /**
   * 更新胜负比
   */
  updateWinRate(battleType, levelRange, result) {
    const key = `${battleType}:${levelRange}`;
    if (!this.battleStats.has(key)) {
      this.battleStats.set(key, { total: 0, wins: 0 });
    }

    const stats = this.battleStats.get(key);
    stats.total++;
    if (result === 'win') {
      stats.wins++;
    }

    const winRate = stats.wins / stats.total;
    battleWinRateGauge.set({ battle_type: battleType, player_level_range: levelRange }, winRate);
  }

  /**
   * 更新技能统计
   */
  updateSkillStats(skillId, skillName, success) {
    const key = skillId;
    if (!this.skillStats.has(key)) {
      this.skillStats.set(key, { total: 0, success: 0 });
    }

    const stats = this.skillStats.get(key);
    stats.total++;
    if (success) {
      stats.success++;
    }

    const rate = stats.success / stats.total;
    skillTriggerSuccessRate.set({ skill_id: skillId, skill_name: skillName }, rate);
  }

  /**
   * 更新暴击率
   */
  updateCriticalHitRate(battleType, isCritical) {
    const key = battleType;
    if (!this.damageStats.has(key)) {
      this.damageStats.set(key, { total: 0, criticals: 0 });
    }

    const stats = this.damageStats.get(key);
    stats.total++;
    if (isCritical) {
      stats.criticals++;
    }

    const rate = stats.criticals / stats.total;
    criticalHitRate.set({ battle_type: battleType }, rate);
  }
}

// 单例实例
let recorderInstance = null;

function getBattleBusinessMetricsRecorder() {
  if (!recorderInstance) {
    recorderInstance = new BattleBusinessMetricsRecorder();
  }
  return recorderInstance;
}

// ==================== 告警检查器 ====================

class BattleMetricsAlertChecker {
  constructor() {
    this.thresholds = {
      skillErrorRate: 0.05,        // 技能错误率阈值 5%
      skillErrorCountPerMinute: 5, // 每分钟技能错误次数阈值
      battleTimeoutRate: 0.01,     // 战斗超时率阈值 1%
      damageDeviation: 0.3         // 伤害偏移阈值 30%
    };

    this.errorCounts = new Map(); // 错误计数器（用于滑动窗口）
  }

  /**
   * 检查技能错误告警
   * @param {string} skillId - 技能 ID
   * @param {string} skillName - 技能名称
   * @returns {Object|null} 告警对象，无告警返回 null
   */
  checkSkillErrorAlert(skillId, skillName) {
    const key = `skill:${skillId}`;
    const now = Date.now();
    const windowMs = 60000; // 1分钟窗口

    if (!this.errorCounts.has(key)) {
      this.errorCounts.set(key, []);
    }

    const errors = this.errorCounts.get(key);
    errors.push(now);

    // 清理过期记录
    const recentErrors = errors.filter(t => now - t < windowMs);
    this.errorCounts.set(key, recentErrors);

    // 检查阈值
    if (recentErrors.length >= this.thresholds.skillErrorCountPerMinute) {
      return {
        level: 'warning',
        type: 'skill_error_high',
        message: `技能 ${skillName}(${skillId}) 错误次数过高：${recentErrors.length}次/分钟`,
        labels: { skill_id: skillId, skill_name: skillName, count: recentErrors.length },
        timestamp: new Date().toISOString()
      };
    }

    return null;
  }

  /**
   * 检查战斗超时告警
   * @param {string} battleType - 战斗类型
   * @param {number} timeoutCount - 超时次数
   * @param {number} totalCount - 总次数
   * @returns {Object|null}
   */
  checkBattleTimeoutAlert(battleType, timeoutCount, totalCount) {
    if (totalCount < 10) return null; // 样本太少不告警

    const rate = timeoutCount / totalCount;
    if (rate > this.thresholds.battleTimeoutRate) {
      return {
        level: 'critical',
        type: 'battle_timeout_high',
        message: `${battleType} 战斗超时率过高：${(rate * 100).toFixed(2)}%`,
        labels: { battle_type: battleType, rate },
        timestamp: new Date().toISOString()
      };
    }

    return null;
  }

  /**
   * 检查伤害偏移告警
   * @param {string} battleType - 战斗类型
   * @param {number} deviation - 偏移率
   * @returns {Object|null}
   */
  checkDamageDeviationAlert(battleType, deviation) {
    if (deviation > this.thresholds.damageDeviation) {
      return {
        level: 'warning',
        type: 'damage_deviation_high',
        message: `${battleType} 伤害数值偏移过大：${(deviation * 100).toFixed(2)}%`,
        labels: { battle_type: battleType, deviation },
        timestamp: new Date().toISOString()
      };
    }

    return null;
  }
}

// 告警检查器单例
let alertCheckerInstance = null;

function getBattleMetricsAlertChecker() {
  if (!alertCheckerInstance) {
    alertCheckerInstance = new BattleMetricsAlertChecker();
  }
  return alertCheckerInstance;
}

// ==================== 导出 ====================

module.exports = {
  // 指标
  battleWinRateGauge,
  battleTotalCount,
  battleWinCount,
  battleSettlementDuration,
  battleSettlementErrorTotal,
  battleSettlementTimeoutTotal,
  skillExecutionTotal,
  skillExecutionDuration,
  skillExecutionErrorTotal,
  skillTriggerSuccessRate,
  damageDealtHistogram,
  damageDeviationGauge,
  criticalHitRate,
  typeEffectivenessRate,
  battleTraceStart,
  battleTraceEnd,
  
  // 类
  BattleBusinessMetricsRecorder,
  BattleMetricsAlertChecker,
  
  // 工具函数
  getBattleBusinessMetricsRecorder,
  getBattleMetricsAlertChecker,
  
  // 追踪 Map
  battleTraces
};
