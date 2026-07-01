/**
 * 精灵天赋系统 API 路由
 */

import express from 'express';
import talentManager from '../managers/TalentManager.js';
import db from '../db/index.js';
import logger from '../../../shared/logger.js';
import { authenticate, requireOwnership } from '../../../shared/middleware/auth.js';

const router = express.Router();

/**
 * GET /api/pokemon/:pokemonId/talent
 * 获取精灵天赋信息
 */
router.get('/:pokemonId/talent', authenticate, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.id;

    // 验证精灵归属
    const pokemonResult = await db.query(`
      SELECT id, owner_id FROM pokemon WHERE id = $1
    `, [pokemonId]);

    if (!pokemonResult.rows.length) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }

    if (pokemonResult.rows[0].owner_id !== userId) {
      return res.status(403).json({ error: 'Not your Pokemon' });
    }

    const talentInfo = await talentManager.getTalentInfo(parseInt(pokemonId));
    
    if (!talentInfo) {
      return res.status(404).json({ error: 'Talent info not found' });
    }

    res.json({
      success: true,
      data: talentInfo
    });

  } catch (error) {
    logger.error('Failed to get talent info', { error, pokemonId: req.params.pokemonId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/pokemon/:pokemonId/talent/tree
 * 获取精灵天赋树（包含所有可分配天赋）
 */
router.get('/:pokemonId/talent/tree', authenticate, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.id;

    // 获取精灵类型
    const pokemonResult = await db.query(`
      SELECT id, owner_id, type, level FROM pokemon WHERE id = $1
    `, [pokemonId]);

    if (!pokemonResult.rows.length) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }

    const pokemon = pokemonResult.rows[0];
    if (pokemon.owner_id !== userId) {
      return res.status(403).json({ error: 'Not your Pokemon' });
    }

    const talentTree = talentManager.getTalentTree(pokemon.type);
    
    if (!talentTree) {
      return res.status(404).json({ error: 'No talent tree for this Pokemon type' });
    }

    // 构建完整天赋树（包含每个天赋的详细信息）
    const fullTree = {};
    for (const [branch, talents] of Object.entries(talentTree.branches)) {
      fullTree[branch] = talents.map(talentId => {
        const def = talentManager.getTalentDefinition(talentId);
        if (!def) return null;
        
        return {
          id: talentId,
          name: def.name,
          description: def.description,
          category: def.category,
          maxLevel: def.max_level,
          costPerLevel: def.cost_per_level,
          effects: def.effects,
          prerequisites: def.prerequisites,
          unlockCondition: def.unlock_condition,
          // 判断当前精灵是否满足解锁条件
          isUnlockable: pokemon.level >= (def.unlock_condition?.level || 0)
        };
      }).filter(Boolean);
    }

    res.json({
      success: true,
      data: {
        pokemonType: pokemon.type,
        totalTalentPoints: talentTree.total_talent_points,
        branches: fullTree
      }
    });

  } catch (error) {
    logger.error('Failed to get talent tree', { error, pokemonId: req.params.pokemonId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/pokemon/:pokemonId/talent/allocate
 * 分配天赋点
 */
router.post('/:pokemonId/talent/allocate', authenticate, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { talentId, points = 1 } = req.body;
    const userId = req.user.id;

    // 验证精灵归属
    const pokemonResult = await db.query(`
      SELECT id, owner_id FROM pokemon WHERE id = $1
    `, [pokemonId]);

    if (!pokemonResult.rows.length) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }

    if (pokemonResult.rows[0].owner_id !== userId) {
      return res.status(403).json({ error: 'Not your Pokemon' });
    }

    // 验证天赋分配
    const validation = await talentManager.validateTalentAllocation(
      parseInt(pokemonId), talentId, points
    );

    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Invalid allocation', 
        reason: validation.reason 
      });
    }

    // 分配天赋点
    const result = await talentManager.allocateTalentPoint(
      parseInt(pokemonId), talentId, points
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('Failed to allocate talent', { 
      error, 
      pokemonId: req.params.pokemonId, 
      talentId: req.body.talentId 
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/pokemon/:pokemonId/talent/reset
 * 重置天赋（消耗道具）
 */
router.post('/:pokemonId/talent/reset', authenticate, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.id;

    // 验证精灵归属
    const pokemonResult = await db.query(`
      SELECT id, owner_id FROM pokemon WHERE id = $1
    `, [pokemonId]);

    if (!pokemonResult.rows.length) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }

    if (pokemonResult.rows[0].owner_id !== userId) {
      return res.status(403).json({ error: 'Not your Pokemon' });
    }

    // 检查是否有重置道具
    const itemResult = await db.query(`
      SELECT * FROM inventory 
      WHERE user_id = $1 AND item_id = 'talent_reset_token' AND quantity > 0
    `, [userId]);

    if (!itemResult.rows.length) {
      return res.status(400).json({ 
        error: 'No talent reset token', 
        hint: 'You need a Talent Reset Token to reset talents'
      });
    }

    // 执行重置
    const result = await talentManager.resetTalents(parseInt(pokemonId), userId);

    if (!result.success) {
      return res.status(400).json({ error: result.reason });
    }

    // 消耗道具
    await db.query(`
      UPDATE inventory SET quantity = quantity - 1 
      WHERE user_id = $1 AND item_id = 'talent_reset_token'
    `, [userId]);

    res.json({
      success: true,
      data: {
        refundedPoints: result.refundedPoints,
        message: `Talent reset successful. ${result.refundedPoints} points refunded.`
      }
    });

  } catch (error) {
    logger.error('Failed to reset talents', { error, pokemonId: req.params.pokemonId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/pokemon/:pokemonId/talent/recommend
 * 获取天赋推荐配置
 */
router.get('/:pokemonId/talent/recommend', authenticate, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { style = 'balance' } = req.query;
    const userId = req.user.id;

    // 验证精灵归属
    const pokemonResult = await db.query(`
      SELECT id, owner_id FROM pokemon WHERE id = $1
    `, [pokemonId]);

    if (!pokemonResult.rows.length) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }

    if (pokemonResult.rows[0].owner_id !== userId) {
      return res.status(403).json({ error: 'Not your Pokemon' });
    }

    // 获取推荐配置
    const recommendation = await talentManager.getRecommendation(
      parseInt(pokemonId), style
    );

    if (!recommendation) {
      return res.status(404).json({ error: 'No recommendation available' });
    }

    res.json({
      success: true,
      data: recommendation
    });

  } catch (error) {
    logger.error('Failed to get talent recommendation', { error, pokemonId: req.params.pokemonId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/pokemon/:pokemonId/talent/apply-recommendation
 * 一键应用推荐配置
 */
router.post('/:pokemonId/talent/apply-recommendation', authenticate, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { style = 'balance' } = req.body;
    const userId = req.user.id;

    // 验证精灵归属
    const pokemonResult = await db.query(`
      SELECT id, owner_id FROM pokemon WHERE id = $1
    `, [pokemonId]);

    if (!pokemonResult.rows.length) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }

    if (pokemonResult.rows[0].owner_id !== userId) {
      return res.status(403).json({ error: 'Not your Pokemon' });
    }

    // 获取推荐配置
    const recommendation = await talentManager.getRecommendation(
      parseInt(pokemonId), style
    );

    if (!recommendation?.recommendation) {
      return res.status(404).json({ error: 'No recommendation available' });
    }

    // 应用推荐配置
    const allocatedTalents = recommendation.recommendation;
    const hiddenAttributes = talentManager.calculateHiddenAttributes(allocatedTalents);

    await db.query(`
      UPDATE pokemon_talent_config 
      SET allocated_talents = $1, 
          used_points = $2, 
          hidden_attributes = $3, 
          updated_at = CURRENT_TIMESTAMP
      WHERE pokemon_id = $4
    `, [
      JSON.stringify(allocatedTalents),
      Object.values(allocatedTalents).reduce((a, b) => a + b, 0),
      JSON.stringify(hiddenAttributes),
      pokemonId
    ]);

    res.json({
      success: true,
      data: {
        appliedStyle: style,
        allocatedTalents,
        hiddenAttributes
      }
    });

  } catch (error) {
    logger.error('Failed to apply recommendation', { error, pokemonId: req.params.pokemonId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/pokemon/:pokemonId/talent/preview
 * 预览天赋配置的属性效果
 */
router.get('/:pokemonId/talent/preview', authenticate, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { talents } = req.query;
    const userId = req.user.id;

    // 验证精灵归属
    const pokemonResult = await db.query(`
      SELECT id, owner_id FROM pokemon WHERE id = $1
    `, [pokemonId]);

    if (!pokemonResult.rows.length) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }

    if (pokemonResult.rows[0].owner_id !== userId) {
      return res.status(403).json({ error: 'Not your Pokemon' });
    }

    // 解析预览配置
    const previewTalents = talents ? JSON.parse(talents) : {};
    const hiddenAttributes = talentManager.calculateHiddenAttributes(previewTalents);

    res.json({
      success: true,
      data: {
        talents: previewTalents,
        hiddenAttributes
      }
    });

  } catch (error) {
    logger.error('Failed to preview talents', { error, pokemonId: req.params.pokemonId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;