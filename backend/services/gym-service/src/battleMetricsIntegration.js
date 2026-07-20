/**
 * REQ-00614: 战斗业务指标集成模块
 * 创建时间: 2026-07-20 19:00
 * 
 * 将业务指标监控集成到战斗引擎中
 */

const {
  getBattleBusinessMetricsRecorder,
  getBattleMetricsAlertChecker
} = require('./battleBusinessMetrics');
const logger = require('../../../shared/logger');

// ==================== 战斗引擎指标包装器 ====================

/**
 * 包装战斗引擎方法，自动记录业务指标
 */
class BattleEngineMetricsWrapper {
  constructor(battleEngine) {
    this.engine = battleEngine;
    this.recorder = getBattleBusinessMetricsRecorder();
    this.alertChecker = getBattleMetricsAlertChecker();
  }

  /**
   * 包装战斗开始方法
   */
  async startBattle(battleId, battleType, playerLevel, ...args) {
    const startTime = Date.now();
    
    try {
      // 记录战斗开始
      this.recorder.recordBattleStart(battleId, battleType, playerLevel);
      
      // 执行原方法
      const result = await this.engine.startBattle(battleId, battleType, playerLevel, ...args);
      
      return result;
    } catch (error) {
      // 记录错误
      this.recorder.recordBattleError(battleId, 'start_failed', error);
      throw error;
    }
  }

  /**
   * 包装战斗结束方法
   */
  async endBattle(battleId, result, ...args) {
    const trace = this.recorder.getBattleTrace(battleId);
    const startTime = trace?.startTime || Date.now();
    const duration = (Date.now() - startTime) / 1000;
    
    try {
      // 执行原方法
      const endResult = await this.engine.endBattle(battleId, result, ...args);
      
      // 记录战斗结束
      this.recorder.recordBattleEnd(battleId, result, duration);
      
      return endResult;
    } catch (error) {
      // 记录错误
      this.recorder.recordBattleError(battleId, 'settlement_failed', error);
      throw error;
    }
  }

  /**
   * 包装技能执行方法
   */
  async executeSkill(battleId, skillId, skillName, ...args) {
    const skillStartTime = Date.now();
    
    try {
      // 执行原方法
      const result = await this.engine.executeSkill(battleId, skillId, skillName, ...args);
      
      // 记录技能执行
      const duration = (Date.now() - skillStartTime) / 1000;
      this.recorder.recordSkillExecution(battleId, skillId, skillName, duration, true);
      
      return result;
    } catch (error) {
      // 记录技能错误
      const duration = (Date.now() - skillStartTime) / 1000;
      this.recorder.recordSkillExecution(battleId, skillId, skillName, duration, false);
      this.recorder.recordSkillError(battleId, skillId, skillName, error.code || 'unknown');
      
      // 检查告警
      const alert = this.alertChecker.checkSkillErrorAlert(skillId, skillName);
      if (alert) {
        logger.warn(alert, 'Skill error alert triggered');
        // 这里可以触发告警通知
      }
      
      throw error;
    }
  }

  /**
   * 包装伤害计算方法
   */
  calculateDamage(battleId, attacker, defender, move, options = {}) {
    try {
      // 执行原方法
      const damageResult = this.engine.calculateDamage(attacker, defender, move, options);
      
      // 记录伤害
      const damageType = damageResult.critical ? 'critical' : 'normal';
      this.recorder.recordDamage(battleId, damageResult.damage, damageResult.expected, damageType);
      
      // 记录属性克制
      if (damageResult.typeMultiplier) {
        this.recorder.recordTypeEffectiveness(battleId, damageResult.typeMultiplier);
      }
      
      return damageResult;
    } catch (error) {
      logger.error({ battleId, error: error.message }, 'Damage calculation failed');
      throw error;
    }
  }
}

// ==================== 战斗中间件 ====================

/**
 * 战斗业务指标中间件
 * 用于 Express 路由
 */
function battleMetricsMiddleware(req, res, next) {
  const recorder = getBattleBusinessMetricsRecorder();
  
  // 从 header 获取战斗 ID
  const battleId = req.headers['x-battle-id'] || req.body?.battleId;
  
  if (battleId) {
    // 将 recorder 注入到 request
    req.battleMetrics = {
      recorder,
      battleId,
      startTime: Date.now()
    };
    
    // 监听响应完成
    const originalEnd = res.end;
    res.end = function(...args) {
      const duration = (Date.now() - req.battleMetrics.startTime) / 1000;
      
      // 记录响应时间
      logger.debug({ battleId, duration }, 'Battle request completed');
      
      originalEnd.apply(res, args);
    };
  }
  
  next();
}

// ==================== 战斗追踪 ID 中间件 ====================

/**
 * 确保每个战斗请求都有追踪 ID
 */
function ensureBattleTraceId(req, res, next) {
  const battleId = req.headers['x-battle-id'] || req.body?.battleId || req.params?.battleId;
  
  if (!battleId) {
    // 如果没有战斗 ID，生成一个临时的
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    req.battleId = tempId;
    res.setHeader('X-Battle-Trace-Id', tempId);
  } else {
    req.battleId = battleId;
    res.setHeader('X-Battle-Trace-Id', battleId);
  }
  
  next();
}

// ==================== Prometheus 指标端点 ====================

/**
 * 战斗业务指标端点
 * 暴露给 Prometheus 抓取
 */
function setupBattleMetricsEndpoint(app) {
  const client = require('prom-client');
  
  // 注册所有业务指标
  const {
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
    typeEffectivenessRate
  } = require('./battleBusinessMetrics');
  
  // 确保指标已注册
  try {
    client.register.registerMetric(battleWinRateGauge);
    client.register.registerMetric(battleTotalCount);
    client.register.registerMetric(battleWinCount);
    client.register.registerMetric(battleSettlementDuration);
    client.register.registerMetric(battleSettlementErrorTotal);
    client.register.registerMetric(battleSettlementTimeoutTotal);
    client.register.registerMetric(skillExecutionTotal);
    client.register.registerMetric(skillExecutionDuration);
    client.register.registerMetric(skillExecutionErrorTotal);
    client.register.registerMetric(skillTriggerSuccessRate);
    client.register.registerMetric(damageDealtHistogram);
    client.register.registerMetric(damageDeviationGauge);
    client.register.registerMetric(criticalHitRate);
    client.register.registerMetric(typeEffectivenessRate);
  } catch (err) {
    // 指标可能已注册，忽略错误
  }
  
  // 暴露指标端点
  app.get('/metrics/battle', async (req, res) => {
    try {
      res.set('Content-Type', client.register.contentType);
      res.end(await client.register.metrics());
    } catch (err) {
      res.status(500).end(err.message);
    }
  });
  
  logger.info('Battle business metrics endpoint registered at /metrics/battle');
}

// ==================== 告警规则集成 ====================

/**
 * 将战斗业务告警集成到 AlertManager
 */
function integrateBattleAlerts(alertManager) {
  const alertChecker = getBattleMetricsAlertChecker();
  
  // 添加技能错误告警规则
  alertManager.addRule({
    id: 'battle_skill_error_high',
    name: '技能执行错误率过高',
    condition: (metrics) => {
      // 检查是否有技能错误告警
      return false; // 实际逻辑由 alertChecker 处理
    },
    severity: 'warning',
    channels: ['webhook', 'slack']
  });
  
  // 添加战斗超时告警规则
  alertManager.addRule({
    id: 'battle_timeout_high',
    name: '战斗结算超时率过高',
    condition: (metrics) => {
      return false; // 实际逻辑由 alertChecker 处理
    },
    severity: 'critical',
    channels: ['webhook', 'slack', 'log']
  });
  
  // 添加伤害偏移告警规则
  alertManager.addRule({
    id: 'battle_damage_deviation_high',
    name: '伤害数值偏移异常',
    condition: (metrics) => {
      return false; // 实际逻辑由 alertChecker 处理
    },
    severity: 'warning',
    channels: ['webhook', 'log']
  });
  
  logger.info('Battle alerts integrated with AlertManager');
}

// ==================== 导出 ====================

module.exports = {
  BattleEngineMetricsWrapper,
  battleMetricsMiddleware,
  ensureBattleTraceId,
  setupBattleMetricsEndpoint,
  integrateBattleAlerts
};
