/**
 * REQ-00046: 精灵培育系统 API 路由
 */

const express = require('express');
const router = express.Router();
const BreedingService = require('../breedingService');
const { requireAuth } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');
const metrics = require('../../../../shared/metrics');

const logger = createLogger('pokemon-service');
const breedingService = new BreedingService();

/**
 * 获取培育中心状态
 * GET /api/breeding/center
 */
router.get('/center', requireAuth, async (req, res) => {
  try {
    const status = await breedingService.getBreedingStatus(req.user.id);
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error('Failed to get breeding center status', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 检查两只精灵是否可以培育
 * POST /api/breeding/check
 */
router.post('/check', requireAuth, async (req, res) => {
  try {
    const { parent1Id, parent2Id } = req.body;

    if (!parent1Id || !parent2Id) {
      return res.status(400).json({
        success: false,
        error: '缺少精灵 ID'
      });
    }

    const result = await breedingService.canBreed(parent1Id, parent2Id);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to check breeding compatibility', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 开始培育
 * POST /api/breeding/start
 */
router.post('/start', requireAuth, async (req, res) => {
  try {
    const { parent1Id, parent2Id, slotIndex } = req.body;

    if (!parent1Id || !parent2Id) {
      return res.status(400).json({
        success: false,
        error: '缺少精灵 ID'
      });
    }

    const result = await breedingService.startBreeding(
      req.user.id,
      parent1Id,
      parent2Id,
      slotIndex || 0
    );

    metrics.increment('breeding_api_start');
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to start breeding', {
      error: error.message,
      userId: req.user.id,
      parent1Id: req.body.parent1Id,
      parent2Id: req.body.parent2Id
    });
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 收集培育完成的蛋
 * POST /api/breeding/collect/:pairId
 */
router.post('/collect/:pairId', requireAuth, async (req, res) => {
  try {
    const { pairId } = req.params;

    const result = await breedingService.collectEgg(req.user.id, pairId);

    metrics.increment('breeding_api_collect');
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to collect egg', {
      error: error.message,
      userId: req.user.id,
      pairId: req.params.pairId
    });
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 取消培育
 * POST /api/breeding/cancel/:pairId
 */
router.post('/cancel/:pairId', requireAuth, async (req, res) => {
  try {
    const { pairId } = req.params;

    const result = await breedingService.cancelBreeding(req.user.id, pairId);

    metrics.increment('breeding_api_cancel');
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to cancel breeding', {
      error: error.message,
      userId: req.user.id,
      pairId: req.params.pairId
    });
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 更新孵化进度
 * POST /api/breeding/hatch/update
 */
router.post('/hatch/update', requireAuth, async (req, res) => {
  try {
    const { steps } = req.body;

    if (!steps || steps < 0) {
      return res.status(400).json({
        success: false,
        error: '无效的步数'
      });
    }

    const result = await breedingService.updateHatchingProgress(req.user.id, steps);

    metrics.increment('breeding_api_hatch_update');
    if (result.hatched.length > 0) {
      metrics.increment('breeding_api_hatch_complete');
    }
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to update hatching progress', {
      error: error.message,
      userId: req.user.id,
      steps: req.body.steps
    });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取培育统计
 * GET /api/breeding/stats
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await breedingService.getBreedingStats(req.user.id);
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Failed to get breeding stats', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 升级培育中心
 * POST /api/breeding/upgrade
 */
router.post('/upgrade', requireAuth, async (req, res) => {
  try {
    const result = await breedingService.upgradeBreedingCenter(req.user.id);

    metrics.increment('breeding_api_upgrade');
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to upgrade breeding center', {
      error: error.message,
      userId: req.user.id
    });
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取精灵谱系
 * GET /api/breeding/lineage/:pokemonId
 */
router.get('/lineage/:pokemonId', requireAuth, async (req, res) => {
  try {
    const { pokemonId } = req.params;

    const result = await req.db.query(
      `SELECT pl.*, 
              ps1.name as parent1_name,
              ps2.name as parent2_name
       FROM pokemon_lineage pl
       LEFT JOIN pokemon_species ps1 ON pl.parent1_species_id = ps1.id
       LEFT JOIN pokemon_species ps2 ON pl.parent2_species_id = ps2.id
       WHERE pl.pokemon_id = $1`,
      [pokemonId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: null
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    logger.error('Failed to get pokemon lineage', {
      error: error.message,
      userId: req.user.id,
      pokemonId: req.params.pokemonId
    });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
