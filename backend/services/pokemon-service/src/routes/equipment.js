// ============================================================
// REQ-00091: Equipment Routes
// File: backend/services/pokemon-service/src/routes/equipment.js
// ============================================================

'use strict';

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../../../shared/logger');
const { getEquipmentService } = require('../../../../shared/equipmentService');

const logger = createLogger('equipment-routes');

/**
 * GET /api/pokemon/equipment/templates
 * 获取装备模板列表
 */
router.get('/templates', async (req, res) => {
  try {
    const { type, rarity, setId, limit, offset } = req.query;
    
    const equipmentService = getEquipmentService(req.db, req.redis);
    const templates = await equipmentService.getTemplates({
      type,
      rarity,
      setId: setId ? parseInt(setId) : undefined,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0
    });
    
    res.json({ success: true, data: templates });
  } catch (err) {
    logger.error('Failed to get equipment templates', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message }
    });
  }
});

/**
 * GET /api/pokemon/equipment/templates/:id
 * 获取装备模板详情
 */
router.get('/templates/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const equipmentService = getEquipmentService(req.db, req.redis);
    const template = await equipmentService.getTemplateById(parseInt(id));
    
    if (!template) {
      return res.status(404).json({
        success: false,
        error: { code: 'TEMPLATE_NOT_FOUND' }
      });
    }
    
    res.json({ success: true, data: template });
  } catch (err) {
    logger.error('Failed to get equipment template', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message }
    });
  }
});

/**
 * GET /api/pokemon/equipment/inventory
 * 获取玩家装备背包
 */
router.get('/inventory', async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, rarity, equipped, limit, offset } = req.query;
    
    const equipmentService = getEquipmentService(req.db, req.redis);
    const inventory = await equipmentService.getInventory(userId, {
      type,
      rarity,
      equipped: equipped === 'true' ? true : equipped === 'false' ? false : undefined,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0
    });
    
    res.json({ success: true, data: inventory });
  } catch (err) {
    logger.error('Failed to get equipment inventory', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message }
    });
  }
});

/**
 * GET /api/pokemon/equipment/:id
 * 获取装备详情
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const equipmentService = getEquipmentService(req.db, req.redis);
    const equipment = await equipmentService.getEquipmentById(parseInt(id), userId);
    
    if (!equipment) {
      return res.status(404).json({
        success: false,
        error: { code: 'EQUIPMENT_NOT_FOUND' }
      });
    }
    
    res.json({ success: true, data: equipment });
  } catch (err) {
    logger.error('Failed to get equipment', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message }
    });
  }
});

/**
 * POST /api/pokemon/equipment/equip
 * 装备到精灵
 */
router.post('/equip', async (req, res) => {
  try {
    const { equipmentId, pokemonId } = req.body;
    const userId = req.user.id;
    
    if (!equipmentId || !pokemonId) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAMETERS' }
      });
    }
    
    const equipmentService = getEquipmentService(req.db, req.redis);
    const result = await equipmentService.equip(
      parseInt(equipmentId),
      parseInt(pokemonId),
      userId
    );
    
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Failed to equip', { error: err.message });
    
    const errorMap = {
      'EQUIPMENT_NOT_FOUND': { status: 404, code: 'EQUIPMENT_NOT_FOUND' },
      'EQUIPMENT_ALREADY_EQUIPPED': { status: 400, code: 'EQUIPMENT_ALREADY_EQUIPPED' },
      'POKEMON_NOT_FOUND': { status: 404, code: 'POKEMON_NOT_FOUND' },
      'ELEMENT_MISMATCH': { status: 400, code: 'ELEMENT_MISMATCH' }
    };
    
    const error = errorMap[err.message] || { status: 500, code: 'INTERNAL_ERROR' };
    res.status(error.status).json({
      success: false,
      error: { code: error.code, message: err.message }
    });
  }
});

/**
 * POST /api/pokemon/equipment/unequip
 * 从精灵卸下装备
 */
router.post('/unequip', async (req, res) => {
  try {
    const { equipmentId } = req.body;
    const userId = req.user.id;
    
    if (!equipmentId) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_EQUIPMENT_ID' }
      });
    }
    
    const equipmentService = getEquipmentService(req.db, req.redis);
    const result = await equipmentService.unequip(parseInt(equipmentId), userId);
    
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Failed to unequip', { error: err.message });
    
    const errorMap = {
      'EQUIPMENT_NOT_EQUIPPED': { status: 400, code: 'EQUIPMENT_NOT_EQUIPPED' }
    };
    
    const error = errorMap[err.message] || { status: 500, code: 'INTERNAL_ERROR' };
    res.status(error.status).json({
      success: false,
      error: { code: error.code, message: err.message }
    });
  }
});

/**
 * POST /api/pokemon/equipment/upgrade
 * 强化装备
 */
router.post('/upgrade', async (req, res) => {
  try {
    const { equipmentId } = req.body;
    const userId = req.user.id;
    
    if (!equipmentId) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_EQUIPMENT_ID' }
      });
    }
    
    const equipmentService = getEquipmentService(req.db, req.redis);
    const result = await equipmentService.upgrade(parseInt(equipmentId), userId);
    
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Failed to upgrade equipment', { error: err.message });
    
    const errorMap = {
      'EQUIPMENT_NOT_FOUND': { status: 404, code: 'EQUIPMENT_NOT_FOUND' },
      'MAX_LEVEL_REACHED': { status: 400, code: 'MAX_LEVEL_REACHED' },
      'INSUFFICIENT_RESOURCES': { status: 400, code: 'INSUFFICIENT_RESOURCES' }
    };
    
    const error = errorMap[err.message] || { status: 500, code: 'INTERNAL_ERROR' };
    res.status(error.status).json({
      success: false,
      error: { code: error.code, message: err.message }
    });
  }
});

/**
 * GET /api/pokemon/equipment/sets
 * 获取套装列表
 */
router.get('/sets', async (req, res) => {
  try {
    const equipmentService = getEquipmentService(req.db, req.redis);
    const sets = await equipmentService.getSets();
    
    res.json({ success: true, data: sets });
  } catch (err) {
    logger.error('Failed to get equipment sets', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message }
    });
  }
});

/**
 * GET /api/pokemon/equipment/sets/:id
 * 获取套装详情
 */
router.get('/sets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await req.db.query(
      'SELECT * FROM equipment_sets WHERE id = $1',
      [parseInt(id)]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'SET_NOT_FOUND' }
      });
    }
    
    // 获取套装包含的装备
    const templatesResult = await req.db.query(
      'SELECT * FROM equipment_templates WHERE set_id = $1',
      [parseInt(id)]
    );
    
    res.json({
      success: true,
      data: {
        ...result.rows[0],
        pieces: templatesResult.rows
      }
    });
  } catch (err) {
    logger.error('Failed to get equipment set', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message }
    });
  }
});

/**
 * GET /api/pokemon/equipment/pokemon/:pokemonId
 * 获取精灵已装备列表
 */
router.get('/pokemon/:pokemonId', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.id;
    
    // 验证精灵归属
    const pokemonCheck = await req.db.query(
      'SELECT id FROM user_pokemon WHERE id = $1 AND user_id = $2',
      [parseInt(pokemonId), userId]
    );
    
    if (pokemonCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'POKEMON_NOT_FOUND' }
      });
    }
    
    const equipmentService = getEquipmentService(req.db, req.redis);
    
    // 获取已装备列表
    const result = await req.db.query(`
      SELECT 
        pe.*,
        et.name_zh, et.name_en, et.type, et.rarity, et.icon_url
      FROM player_equipment pe
      JOIN equipment_templates et ON pe.template_id = et.id
      WHERE pe.equipped_to_pokemon_id = $1 AND pe.is_equipped = TRUE
    `, [parseInt(pokemonId)]);
    
    // 获取套装效果
    const setBonuses = await equipmentService.calculateSetBonuses(parseInt(pokemonId));
    
    // 获取战斗属性
    const battleStats = await equipmentService.calculateBattleStats(parseInt(pokemonId));
    
    res.json({
      success: true,
      data: {
        equipment: result.rows,
        setBonuses,
        battleStats
      }
    });
  } catch (err) {
    logger.error('Failed to get pokemon equipment', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message }
    });
  }
});

/**
 * POST /api/pokemon/equipment/sell
 * 出售装备
 */
router.post('/sell', async (req, res) => {
  try {
    const { equipmentId } = req.body;
    const userId = req.user.id;
    
    if (!equipmentId) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_EQUIPMENT_ID' }
      });
    }
    
    const equipmentService = getEquipmentService(req.db, req.redis);
    const result = await equipmentService.sell(parseInt(equipmentId), userId);
    
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Failed to sell equipment', { error: err.message });
    
    const errorMap = {
      'EQUIPMENT_NOT_FOUND': { status: 404, code: 'EQUIPMENT_NOT_FOUND' },
      'EQUIPMENT_NOT_SELLABLE': { status: 400, code: 'EQUIPMENT_NOT_SELLABLE' },
      'EQUIPMENT_EQUIPPED': { status: 400, code: 'EQUIPMENT_EQUIPPED' }
    };
    
    const error = errorMap[err.message] || { status: 500, code: 'INTERNAL_ERROR' };
    res.status(error.status).json({
      success: false,
      error: { code: error.code, message: err.message }
    });
  }
});

/**
 * GET /api/pokemon/equipment/upgrade-preview/:id
 * 获取强化预览（消耗和成功率）
 */
router.get('/upgrade-preview/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const equipmentService = getEquipmentService(req.db, req.redis);
    const equipment = await equipmentService.getEquipmentById(parseInt(id), userId);
    
    if (!equipment) {
      return res.status(404).json({
        success: false,
        error: { code: 'EQUIPMENT_NOT_FOUND' }
      });
    }
    
    if (equipment.current_level >= equipment.max_level) {
      return res.json({
        success: true,
        data: {
          maxLevelReached: true,
          currentLevel: equipment.current_level,
          maxLevel: equipment.max_level
        }
      });
    }
    
    const cost = equipmentService.calculateUpgradeCost(equipment.current_level, equipment.rarity);
    const successRate = equipmentService.calculateUpgradeSuccessRate(equipment.current_level, equipment.rarity);
    
    // 获取用户资源
    const userResult = await req.db.query(
      'SELECT stardust, coins FROM users WHERE id = $1',
      [userId]
    );
    
    const user = userResult.rows[0];
    const canAfford = user.stardust >= cost.stardust && user.coins >= cost.coins;
    
    res.json({
      success: true,
      data: {
        currentLevel: equipment.current_level,
        nextLevel: equipment.current_level + 1,
        maxLevel: equipment.max_level,
        cost,
        successRate,
        canAfford,
        userResources: {
          stardust: user.stardust,
          coins: user.coins
        }
      }
    });
  } catch (err) {
    logger.error('Failed to get upgrade preview', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message }
    });
  }
});

module.exports = router;
