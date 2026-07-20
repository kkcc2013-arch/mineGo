// backend/services/pokemon-service/src/internalRoutes.js
// REQ-00607: Pokemon Service 内部 API 路由

const express = require('express');
const router = express.Router();
const logger = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');

// 服务间认证中间件
const serviceAuthMiddleware = (req, res, next) => {
  const serviceToken = req.headers['authorization'];
  const fromService = req.headers['x-from-service'];
  
  // 验证服务 Token
  if (!serviceToken || !serviceToken.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing service token' });
  }
  
  const token = serviceToken.replace('Bearer ', '');
  
  // 在生产环境应该验证 Token
  if (process.env.NODE_ENV === 'production') {
    const validToken = process.env.SERVICE_TOKEN;
    if (token !== validToken) {
      return res.status(403).json({ error: 'Invalid service token' });
    }
  }
  
  req.fromService = fromService;
  next();
};

// 应用服务认证中间件
router.use(serviceAuthMiddleware);

/**
 * POST /internal/ability/assign
 * 为捕捉的精灵分配特性
 */
router.post('/ability/assign', async (req, res) => {
  const start = Date.now();
  
  try {
    const { playerPokemonId, speciesId, isEventSpawn, forceHidden, hiddenChanceOverride } = req.body;
    
    // 模拟特性分配逻辑
    const ability = {
      abilityId: 'static-discharge',
      slot: 1,
      hidden: false,
      assignedAt: new Date().toISOString()
    };
    
    // 随机分配特性
    if (Math.random() < 0.05 || forceHidden) {
      ability.abilityId = 'hidden-ability-001';
      ability.hidden = true;
    }
    
    logger.info({
      fromService: req.fromService,
      playerPokemonId,
      speciesId,
      ability: ability.abilityId,
      hidden: ability.hidden
    }, 'Ability assigned');
    
    metrics.increment('pokemon.ability.assign.total');
    metrics.timing('pokemon.ability.assign.duration', Date.now() - start);
    
    res.json(ability);
    
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to assign ability');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /internal/ability/battle-effect
 * 获取特性在战斗中的效果
 */
router.post('/ability/battle-effect', async (req, res) => {
  const start = Date.now();
  
  try {
    const { abilityId, context } = req.body;
    
    // 模拟特性效果
    const effect = {
      abilityId,
      effect: 'paralyze',
      chance: 30,
      duration: 3,
      triggers: ['on-hit', 'on-defend']
    };
    
    logger.debug({
      fromService: req.fromService,
      abilityId,
      effect: effect.effect
    }, 'Ability battle effect retrieved');
    
    metrics.increment('pokemon.ability.battle_effect.total');
    metrics.timing('pokemon.ability.battle_effect.duration', Date.now() - start);
    
    res.json(effect);
    
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get ability battle effect');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /internal/status-effect/apply
 * 应用状态效果
 */
router.post('/status-effect/apply', async (req, res) => {
  const start = Date.now();
  
  try {
    const { targetId, effectId, sourceId, battleId } = req.body;
    
    // 模拟应用状态效果
    const result = {
      applied: true,
      effectId: effectId || 'burn-001',
      targetId,
      sourceId,
      turns: 3,
      appliedAt: new Date().toISOString()
    };
    
    logger.info({
      fromService: req.fromService,
      effectId: result.effectId,
      targetId,
      battleId
    }, 'Status effect applied');
    
    metrics.increment('pokemon.status_effect.apply.total');
    metrics.timing('pokemon.status_effect.apply.duration', Date.now() - start);
    
    res.json(result);
    
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to apply status effect');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /internal/status-effect/list
 * 获取状态效果列表
 */
router.get('/status-effect/list', async (req, res) => {
  try {
    const effects = [
      { id: 'burn-001', name: 'Burn', type: 'damage', turns: 3 },
      { id: 'paralyze-001', name: 'Paralyze', type: 'status', turns: 4 },
      { id: 'poison-001', name: 'Poison', type: 'damage', turns: 5 },
      { id: 'sleep-001', name: 'Sleep', type: 'status', turns: 2 },
      { id: 'freeze-001', name: 'Freeze', type: 'status', turns: 2 }
    ];
    
    res.json({ effects });
    
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to list status effects');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /internal/pokemon/validate
 * 验证精灵数据
 */
router.post('/pokemon/validate', async (req, res) => {
  try {
    const { pokemonId, speciesId } = req.body;
    
    const validation = {
      valid: true,
      pokemonId,
      speciesId,
      validatedAt: new Date().toISOString()
    };
    
    res.json(validation);
    
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to validate pokemon');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 健康检查
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pokemon-service', internal: true });
});

module.exports = router;
