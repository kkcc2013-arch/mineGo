/**
 * 状态效果API路由
 * REQ-00090: 精灵状态效果系统与战斗Buff/Debuff管理
 */
'use strict';

const express = require('express');
const router = express.Router();
const StatusEffectEngine = require('../statusEffectEngine');
const { requireAuth, AppError, successResp } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');
const { getRedisClient } = require('../../../../shared/redis');

const logger = createLogger('status-effects-routes');

// 初始化状态效果引擎
let statusEngine = null;
function getStatusEngine() {
  if (!statusEngine) {
    statusEngine = new StatusEffectEngine(getRedisClient());
  }
  return statusEngine;
}

/**
 * GET /api/pokemon/status-effects/definitions
 * 获取所有状态效果定义
 */
router.get('/definitions', requireAuth, async (req, res, next) => {
  try {
    const { category } = req.query;
    const engine = getStatusEngine();
    
    const definitions = await engine.getAllDefinitions(category);
    
    res.json({ success: true, data: definitions });
  } catch (error) {
    logger.error({ error }, 'Get status definitions failed');
    next(error);
  }
});

/**
 * GET /api/pokemon/status-effects/:battleId/:pokemonId
 * 获取精灵当前状态
 */
router.get('/:battleId/:pokemonId', requireAuth, async (req, res, next) => {
  try {
    const { battleId, pokemonId } = req.params;
    const engine = getStatusEngine();
    
    const statuses = await engine.getPokemonStatuses(battleId, parseInt(pokemonId));
    const statChanges = await engine.getStatChanges(battleId, parseInt(pokemonId));
    const fieldEffect = await engine.getFieldEffect(battleId);
    
    res.json({
      success: true,
      data: {
        statuses,
        statChanges,
        fieldEffect
      }
    });
  } catch (error) {
    logger.error({ error }, 'Get pokemon status failed');
    next(error);
  }
});

/**
 * POST /api/pokemon/status-effects/apply
 * 施加状态效果
 */
router.post('/apply', requireAuth, async (req, res, next) => {
  try {
    const { battleId, targetId, statusCode, options = {} } = req.body;
    const engine = getStatusEngine();
    
    const result = await engine.applyStatus(
      battleId,
      parseInt(targetId),
      statusCode,
      options
    );
    
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Apply status failed');
    next(error);
  }
});

/**
 * POST /api/pokemon/status-effects/remove
 * 移除状态效果
 */
router.post('/remove', requireAuth, async (req, res, next) => {
  try {
    const { battleId, pokemonId, statusCode } = req.body;
    const engine = getStatusEngine();
    
    const result = await engine.removeStatus(
      battleId,
      parseInt(pokemonId),
      statusCode
    );
    
    res.json({ success: result });
  } catch (error) {
    logger.error({ error }, 'Remove status failed');
    next(error);
  }
});

/**
 * POST /api/pokemon/status-effects/dispel
 * 驱散状态效果
 */
router.post('/dispel', requireAuth, async (req, res, next) => {
  try {
    const { battleId, pokemonId, category, dispellableOnly = true } = req.body;
    const engine = getStatusEngine();
    
    const removed = await engine.dispelStatuses(
      battleId,
      parseInt(pokemonId),
      { category, dispellableOnly }
    );
    
    res.json({
      success: true,
      removed
    });
  } catch (error) {
    logger.error({ error }, 'Dispel statuses failed');
    next(error);
  }
});

/**
 * POST /api/pokemon/status-effects/check-action
 * 检查行动是否被阻止
 */
router.post('/check-action', requireAuth, async (req, res, next) => {
  try {
    const { battleId, pokemonId, actionType } = req.body;
    const engine = getStatusEngine();
    
    const result = await engine.checkActionBlocked(
      battleId,
      parseInt(pokemonId),
      actionType
    );
    
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Check action blocked failed');
    next(error);
  }
});

/**
 * POST /api/pokemon/status-effects/turn-start
 * 处理回合开始
 */
router.post('/turn-start', requireAuth, async (req, res, next) => {
  try {
    const { battleId, pokemonId, currentTurn, pokemonData } = req.body;
    const engine = getStatusEngine();
    
    const results = await engine.onTurnStart(
      battleId,
      parseInt(pokemonId),
      currentTurn,
      pokemonData
    );
    
    res.json({ success: true, results });
  } catch (error) {
    logger.error({ error }, 'Process turn start failed');
    next(error);
  }
});

/**
 * POST /api/pokemon/status-effects/turn-end
 * 处理回合结束
 */
router.post('/turn-end', requireAuth, async (req, res, next) => {
  try {
    const { battleId, pokemonId, currentTurn, pokemonData } = req.body;
    const engine = getStatusEngine();
    
    const results = await engine.onTurnEnd(
      battleId,
      parseInt(pokemonId),
      currentTurn,
      pokemonData
    );
    
    res.json({ success: true, results });
  } catch (error) {
    logger.error({ error }, 'Process turn end failed');
    next(error);
  }
});

/**
 * GET /api/pokemon/status-effects/field/:battleId
 * 获取场地效果
 */
router.get('/field/:battleId', requireAuth, async (req, res, next) => {
  try {
    const { battleId } = req.params;
    const engine = getStatusEngine();
    
    const fieldEffect = await engine.getFieldEffect(battleId);
    
    res.json({ success: true, data: fieldEffect });
  } catch (error) {
    logger.error({ error }, 'Get field effect failed');
    next(error);
  }
});

/**
 * POST /api/pokemon/status-effects/stat-change
 * 应用能力变化
 */
router.post('/stat-change', requireAuth, async (req, res, next) => {
  try {
    const { battleId, targetId, statusCode, stacks = 1 } = req.body;
    const engine = getStatusEngine();
    
    const result = await engine.applyStatChange(
      battleId,
      parseInt(targetId),
      statusCode,
      stacks
    );
    
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Apply stat change failed');
    next(error);
  }
});

/**
 * POST /api/pokemon/status-effects/calculate-stats
 * 计算修正后的属性值
 */
router.post('/calculate-stats', requireAuth, async (req, res, next) => {
  try {
    const { baseStats, statChanges } = req.body;
    const engine = getStatusEngine();
    
    const modifiedStats = engine.calculateModifiedStats(baseStats, statChanges);
    
    res.json({ success: true, data: modifiedStats });
  } catch (error) {
    logger.error({ error }, 'Calculate modified stats failed');
    next(error);
  }
});

/**
 * DELETE /api/pokemon/status-effects/battle/:battleId
 * 清除战斗所有状态
 */
router.delete('/battle/:battleId', requireAuth, async (req, res, next) => {
  try {
    const { battleId } = req.params;
    const engine = getStatusEngine();
    
    await engine.clearBattleStatuses(battleId);
    
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Clear battle statuses failed');
    next(error);
  }
});

module.exports = router;
