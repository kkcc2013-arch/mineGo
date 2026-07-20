/**
 * REQ-00355: 精灵进化路径可视化系统
 * API 路由
 */

const express = require('express');
const router = express.Router();
const { EvolutionVisualizationService, EVOLUTION_TYPES } = require('../evolutionVisualizationService');
const { requireAuth, AppError, successResp } = require('../../../../shared/auth');
const { logger } = require('../../../../shared/logger');

const evolutionVizService = new EvolutionVisualizationService();

/**
 * GET /api/pokemon/:speciesId/evolution-chain
 * 获取精灵进化链（树形结构）
 */
router.get('/species/:speciesId/evolution-chain', async (req, res, next) => {
  try {
    const speciesId = parseInt(req.params.speciesId);
    if (isNaN(speciesId)) {
      throw new AppError(4001, '无效的物种 ID', 400);
    }
    
    const language = req.headers['x-language'] || req.query.lang || 'zh';
    
    const evolutionChain = await evolutionVizService.getEvolutionChain(speciesId, language);
    
    res.json(successResp(evolutionChain));
  } catch (error) {
    logger.error('Failed to get evolution chain', { 
      speciesId: req.params.speciesId, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * GET /api/pokemon/my/:instanceId/evolution-preview
 * 获取用户精灵的进化预览
 */
router.get('/my/:instanceId/evolution-preview', requireAuth, async (req, res, next) => {
  try {
    const instanceId = parseInt(req.params.instanceId);
    const targetSpeciesId = parseInt(req.query.target);
    
    if (isNaN(instanceId)) {
      throw new AppError(4001, '无效的精灵实例 ID', 400);
    }
    
    if (isNaN(targetSpeciesId)) {
      throw new AppError(4002, '需要指定目标物种 ID', 400);
    }
    
    const userId = req.user.sub;
    
    const preview = await evolutionVizService.getEvolutionPreview(
      userId,
      instanceId,
      targetSpeciesId
    );
    
    res.json(successResp(preview));
  } catch (error) {
    logger.error('Failed to get evolution preview', { 
      instanceId: req.params.instanceId, 
      error: error.message 
    });
    
    const errorMap = {
      'Pokemon not found': { status: 404, message: '精灵不存在' },
      'Target species not found': { status: 404, message: '目标物种不存在' }
    };
    
    const errorInfo = errorMap[error.message] || { status: 500, message: error.message };
    
    res.status(errorInfo.status).json({
      success: false,
      error: error.message,
      message: errorInfo.message
    });
  }
});

/**
 * GET /api/pokemon/:speciesId/all-evolution-paths
 * 获取精灵的所有进化路径（包括退化）
 */
router.get('/species/:speciesId/all-evolution-paths', async (req, res, next) => {
  try {
    const speciesId = parseInt(req.params.speciesId);
    if (isNaN(speciesId)) {
      throw new AppError(4001, '无效的物种 ID', 400);
    }
    
    const language = req.headers['x-language'] || req.query.lang || 'zh';
    
    const allPaths = await evolutionVizService.getAllEvolutionPaths(speciesId, language);
    
    res.json(successResp(allPaths));
  } catch (error) {
    logger.error('Failed to get all evolution paths', { 
      speciesId: req.params.speciesId, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * POST /api/pokemon/batch-evolution-chains
 * 批量获取多个物种的进化链
 */
router.post('/batch-evolution-chains', async (req, res, next) => {
  try {
    const { speciesIds } = req.body;
    
    if (!Array.isArray(speciesIds) || speciesIds.length === 0) {
      throw new AppError(4003, '需要提供物种 ID 数组', 400);
    }
    
    if (speciesIds.length > 100) {
      throw new AppError(4004, '批量查询最多支持 100 个物种', 400);
    }
    
    const language = req.headers['x-language'] || req.query.lang || 'zh';
    
    const results = await evolutionVizService.batchGetEvolutionChains(speciesIds, language);
    
    res.json(successResp(results));
  } catch (error) {
    logger.error('Failed to batch get evolution chains', { 
      speciesIds: req.body.speciesIds,
      error: error.message 
    });
    next(error);
  }
});

/**
 * GET /api/pokemon/evolution-types
 * 获取所有进化类型枚举
 */
router.get('/evolution-types', (req, res) => {
  const language = req.headers['x-language'] || req.query.lang || 'zh';
  
  const types = Object.values(EVOLUTION_TYPES).map(type => ({
    code: type,
    name: EVOLUTION_TYPE_NAMES[language]?.[type] || type
  }));
  
  res.json(successResp(types));
});

/**
 * GET /api/pokemon/evolution-stats/:speciesId
 * 获取精灵进化统计数据（进化玩家数、成功率等）
 */
router.get('/evolution-stats/:speciesId', async (req, res, next) => {
  try {
    const speciesId = parseInt(req.params.speciesId);
    
    if (isNaN(speciesId)) {
      throw new AppError(4001, '无效的物种 ID', 400);
    }
    
    // 查询进化历史统计
    const { rows: [stats] } = await query(`
      SELECT 
        COUNT(*) as total_evolutions,
        COUNT(DISTINCT user_id) as unique_players,
        AVG(created_at - LAG(created_at) OVER (ORDER BY created_at)) as avg_time_between
      FROM pokemon_evolution_history
      WHERE to_species_id = $1
    `, [speciesId]);
    
    res.json(successResp({
      speciesId,
      totalEvolutions: parseInt(stats?.total_evolutions || 0),
      uniquePlayers: parseInt(stats?.unique_players || 0),
      avgTimeBetween: stats?.avg_time_between || null
    }));
  } catch (error) {
    logger.error('Failed to get evolution stats', { 
      speciesId: req.params.speciesId, 
      error: error.message 
    });
    next(error);
  }
});

module.exports = router;
