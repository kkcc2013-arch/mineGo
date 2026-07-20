/**
 * 羁绊技能 API 路由 - REQ-00151
 */

const express = require('express');
const router = express.Router();
const { getBondSkillService } = require('../bondSkillService');
const { createLogger } = require('../../../../shared/logger');
const { authenticate } = require('../../../../shared/authMiddleware');
const { rateLimit } = require('../../../../shared/rateLimitMiddleware');

const logger = createLogger('bond-skill-routes');
const bondSkillService = getBondSkillService();

/**
 * GET /api/pokemon-species/:speciesId/bond-skills/available
 * 查询特定精灵种类可用的羁绊技能列表（公开API）
 */
router.get('/pokemon-species/:speciesId/bond-skills/available', 
  rateLimit({ windowMs: 60000, max: 100 }),
  async (req, res) => {
    try {
      const speciesId = parseInt(req.params.speciesId);
      
      if (isNaN(speciesId) || speciesId <= 0) {
        return res.status(400).json({
          error: 'INVALID_SPECIES_ID',
          message: 'Invalid pokemon species ID'
        });
      }
      
      const skills = await bondSkillService.getAvailableBondSkills(speciesId);
      
      res.json({
        speciesId,
        totalSkills: skills.length,
        skills: skills.map(skill => ({
          id: skill.id,
          slot: skill.slot,
          name: skill.skill_name,
          nameEn: skill.skill_name_en,
          type: skill.type,
          power: skill.power,
          accuracy: skill.accuracy,
          pp: skill.pp,
          effectDescription: skill.effect_description,
          effectType: skill.effect_type,
          unlockFriendshipLevel: skill.unlock_friendship_level,
          energyCost: skill.energy_cost,
          cooldownTurns: skill.cooldown_turns
        }))
      });
      
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get available bond skills');
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to get available bond skills'
      });
    }
  }
);

/**
 * GET /api/pokemon/:id/bond-skills
 * 查询精灵可学习和已学习的羁绊技能
 */
router.get('/pokemon/:id/bond-skills', 
  authenticate,
  rateLimit({ windowMs: 60000, max: 60 }),
  async (req, res) => {
    try {
      const pokemonId = req.params.id;
      const userId = req.user.id;
      
      const result = await bondSkillService.getPokemonBondSkills(pokemonId, userId);
      
      res.json({
        success: true,
        data: {
          pokemonId: result.pokemonId,
          speciesId: result.speciesId,
          friendship: result.friendship,
          learnedCount: result.learnedCount,
          maxSlots: result.maxSlots,
          activeSkill: result.activeSkill,
          skills: result.skills.map(skill => ({
            id: skill.id,
            slot: skill.slot,
            name: skill.skill_name,
            nameEn: skill.skill_name_en,
            type: skill.type,
            power: skill.power,
            accuracy: skill.accuracy,
            pp: skill.pp,
            effectDescription: skill.effect_description,
            effectType: skill.effect_type,
            energyCost: skill.energy_cost,
            cooldownTurns: skill.cooldown_turns,
            isUnlocked: skill.isUnlocked,
            isLearned: skill.isLearned,
            friendshipRequired: skill.friendshipRequired,
            friendshipCurrent: skill.friendshipCurrent,
            friendshipGap: skill.friendshipGap,
            learnedAt: skill.learnedInfo?.learned_at || null,
            timesUsed: skill.learnedInfo?.times_used || 0
          }))
        }
      });
      
    } catch (error) {
      logger.error({ 
        error: error.message,
        userId: req.user?.id 
      }, 'Failed to get pokemon bond skills');
      
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: 'NOT_FOUND',
          message: error.message
        });
      }
      
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to get pokemon bond skills'
      });
    }
  }
);

/**
 * POST /api/pokemon/:id/bond-skills/:skillId/learn
 * 学习羁绊技能
 */
router.post('/pokemon/:id/bond-skills/:skillId/learn', 
  authenticate,
  rateLimit({ windowMs: 60000, max: 20 }),
  async (req, res) => {
    try {
      const pokemonId = req.params.id;
      const skillId = parseInt(req.params.skillId);
      const userId = req.user.id;
      
      if (isNaN(skillId) || skillId <= 0) {
        return res.status(400).json({
          error: 'INVALID_SKILL_ID',
          message: 'Invalid bond skill ID'
        });
      }
      
      const result = await bondSkillService.learnBondSkill(pokemonId, skillId, userId);
      
      logger.info({
        userId,
        pokemonId,
        skillId,
        skillName: result.skill.name
      }, 'Bond skill learned successfully');
      
      res.json({
        success: true,
        message: 'Bond skill learned successfully',
        data: result
      });
      
    } catch (error) {
      logger.error({ 
        error: error.message,
        userId: req.user?.id 
      }, 'Failed to learn bond skill');
      
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: 'NOT_FOUND',
          message: error.message
        });
      }
      
      if (error.message.includes('Friendship level not enough')) {
        return res.status(400).json({
          error: 'FRIENDSHIP_NOT_ENOUGH',
          message: error.message
        });
      }
      
      if (error.message.includes('already learned')) {
        return res.status(409).json({
          error: 'ALREADY_LEARNED',
          message: error.message
        });
      }
      
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to learn bond skill'
      });
    }
  }
);

/**
 * DELETE /api/pokemon/:id/bond-skills/:skillId
 * 遗忘羁绊技能
 */
router.delete('/pokemon/:id/bond-skills/:skillId', 
  authenticate,
  rateLimit({ windowMs: 60000, max: 20 }),
  async (req, res) => {
    try {
      const pokemonId = req.params.id;
      const skillId = parseInt(req.params.skillId);
      const userId = req.user.id;
      
      if (isNaN(skillId) || skillId <= 0) {
        return res.status(400).json({
          error: 'INVALID_SKILL_ID',
          message: 'Invalid bond skill ID'
        });
      }
      
      const result = await bondSkillService.forgetBondSkill(pokemonId, skillId, userId);
      
      logger.info({
        userId,
        pokemonId,
        skillId
      }, 'Bond skill forgotten successfully');
      
      res.json({
        success: true,
        message: 'Bond skill forgotten successfully'
      });
      
    } catch (error) {
      logger.error({ 
        error: error.message,
        userId: req.user?.id 
      }, 'Failed to forget bond skill');
      
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: 'NOT_FOUND',
          message: error.message
        });
      }
      
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to forget bond skill'
      });
    }
  }
);

/**
 * POST /api/pokemon/:id/bond-skills/:skillId/activate
 * 激活羁绊技能（用于战斗）
 */
router.post('/pokemon/:id/bond-skills/:skillId/activate', 
  authenticate,
  rateLimit({ windowMs: 60000, max: 30 }),
  async (req, res) => {
    try {
      const pokemonId = req.params.id;
      const skillId = parseInt(req.params.skillId);
      const userId = req.user.id;
      
      if (isNaN(skillId) || skillId <= 0) {
        return res.status(400).json({
          error: 'INVALID_SKILL_ID',
          message: 'Invalid bond skill ID'
        });
      }
      
      const result = await bondSkillService.activateBondSkill(pokemonId, skillId, userId);
      
      logger.info({
        userId,
        pokemonId,
        skillId
      }, 'Bond skill activated successfully');
      
      res.json({
        success: true,
        message: 'Bond skill activated for battle'
      });
      
    } catch (error) {
      logger.error({ 
        error: error.message,
        userId: req.user?.id 
      }, 'Failed to activate bond skill');
      
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: 'NOT_FOUND',
          message: error.message
        });
      }
      
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to activate bond skill'
      });
    }
  }
);

/**
 * GET /api/bond-skills/stats
 * 获取用户羁绊技能统计
 */
router.get('/bond-skills/stats', 
  authenticate,
  rateLimit({ windowMs: 60000, max: 30 }),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const stats = await bondSkillService.getBondSkillStats(userId);
      
      res.json({
        success: true,
        data: stats
      });
      
    } catch (error) {
      logger.error({ 
        error: error.message,
        userId: req.user?.id 
      }, 'Failed to get bond skill stats');
      
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to get bond skill stats'
      });
    }
  }
);

/**
 * POST /api/bond-skills/calculate-effect
 * 计算羁绊技能实际效果（用于战斗模拟）
 */
router.post('/bond-skills/calculate-effect', 
  authenticate,
  rateLimit({ windowMs: 60000, max: 60 }),
  async (req, res) => {
    try {
      const { pokemonInstanceId, bondSkillId, friendship } = req.body;
      
      if (!pokemonInstanceId || !bondSkillId || friendship === undefined) {
        return res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'Missing required fields: pokemonInstanceId, bondSkillId, friendship'
        });
      }
      
      const effect = await bondSkillService.calculateBondSkillEffect(
        pokemonInstanceId, 
        parseInt(bondSkillId), 
        parseInt(friendship)
      );
      
      res.json({
        success: true,
        data: effect
      });
      
    } catch (error) {
      logger.error({ 
        error: error.message,
        userId: req.user?.id 
      }, 'Failed to calculate bond skill effect');
      
      if (error.message.includes('not found')) {
        return res.status(404).json({
          error: 'NOT_FOUND',
          message: error.message
        });
      }
      
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to calculate bond skill effect'
      });
    }
  }
);

module.exports = router;
