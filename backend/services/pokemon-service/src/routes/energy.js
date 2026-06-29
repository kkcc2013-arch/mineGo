/**
 * REQ-00112: 精灵技能冷却与能量系统 - API 路由
 * 创建时间: 2026-06-29 20:00 UTC
 */

'use strict';

const express = require('express');
const router = express.Router();
const energyService = require('../energyService');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('energy-routes');

/**
 * 获取精灵能量状态
 * GET /api/pokemon/:id/energy
 */
router.get('/:id/energy', async (req, res) => {
    try {
        const pokemonId = parseInt(req.params.id);
        
        if (isNaN(pokemonId)) {
            return res.status(400).json({ 
                error: 'invalid_pokemon_id',
                message: 'Invalid Pokemon ID'
            });
        }

        const energyState = await energyService.getEnergyState(pokemonId);
        
        if (!energyState) {
            // 尝试初始化能量池
            const initialized = await energyService.initializeEnergyPool(pokemonId);
            return res.json({
                pokemonId,
                currentEnergy: initialized.current_energy,
                maxEnergy: initialized.max_energy,
                regenRate: initialized.energy_regen_rate,
                initialized: true
            });
        }

        res.json({
            pokemonId,
            currentEnergy: energyState.current_energy,
            maxEnergy: energyState.max_energy,
            regenRate: energyState.energy_regen_rate,
            lastUpdated: energyState.last_updated
        });
    } catch (error) {
        logger.error('Failed to get energy state', { 
            error: error.message, 
            pokemonId: req.params.id 
        });
        res.status(500).json({ 
            error: 'internal_error',
            message: error.message 
        });
    }
});

/**
 * 手动回复能量
 * POST /api/pokemon/:id/energy/regenerate
 */
router.post('/:id/energy/regenerate', async (req, res) => {
    try {
        const pokemonId = parseInt(req.params.id);
        const { amount } = req.body;
        
        if (isNaN(pokemonId)) {
            return res.status(400).json({ 
                error: 'invalid_pokemon_id',
                message: 'Invalid Pokemon ID'
            });
        }

        const result = await energyService.regenerateEnergy(pokemonId, amount);
        
        res.json({
            success: true,
            previousEnergy: result.previousEnergy,
            currentEnergy: result.currentEnergy,
            regenerated: result.regenerated
        });
    } catch (error) {
        logger.error('Failed to regenerate energy', { 
            error: error.message, 
            pokemonId: req.params.id 
        });
        res.status(500).json({ 
            error: 'internal_error',
            message: error.message 
        });
    }
});

/**
 * 检查技能可用性
 * POST /api/pokemon/:id/moves/check
 */
router.post('/:id/moves/check', async (req, res) => {
    try {
        const pokemonId = parseInt(req.params.id);
        const { moveId, battleId } = req.body;
        
        if (isNaN(pokemonId)) {
            return res.status(400).json({ 
                error: 'invalid_pokemon_id',
                message: 'Invalid Pokemon ID'
            });
        }

        if (!moveId) {
            return res.status(400).json({ 
                error: 'missing_move_id',
                message: 'Move ID is required'
            });
        }

        const result = await energyService.canUseMove(pokemonId, moveId, battleId);
        
        res.json(result);
    } catch (error) {
        logger.error('Failed to check move availability', { 
            error: error.message, 
            pokemonId: req.params.id 
        });
        res.status(500).json({ 
            error: 'internal_error',
            message: error.message 
        });
    }
});

/**
 * 获取战斗能量状态
 * GET /api/pokemon/:id/battle/:battleId/energy
 */
router.get('/:id/battle/:battleId/energy', async (req, res) => {
    try {
        const pokemonId = parseInt(req.params.id);
        const battleId = req.params.battleId;
        
        if (isNaN(pokemonId)) {
            return res.status(400).json({ 
                error: 'invalid_pokemon_id',
                message: 'Invalid Pokemon ID'
            });
        }

        const battleState = await energyService.getBattleEnergyState(battleId, pokemonId);
        
        if (!battleState) {
            // 初始化战斗能量
            const initialized = await energyService.initializeBattleEnergy(battleId, pokemonId);
            return res.json({
                pokemonId,
                battleId,
                currentEnergy: initialized.current_energy,
                cooldowns: {},
                turnNumber: 0,
                initialized: true
            });
        }

        res.json({
            pokemonId,
            battleId,
            currentEnergy: battleState.current_energy,
            cooldowns: battleState.cooldowns,
            turnNumber: battleState.turn_number
        });
    } catch (error) {
        logger.error('Failed to get battle energy state', { 
            error: error.message, 
            pokemonId: req.params.id,
            battleId: req.params.battleId
        });
        res.status(500).json({ 
            error: 'internal_error',
            message: error.message 
        });
    }
});

/**
 * 使用技能（战斗中）
 * POST /api/pokemon/:id/battle/:battleId/use-move
 */
router.post('/:id/battle/:battleId/use-move', async (req, res) => {
    try {
        const pokemonId = parseInt(req.params.id);
        const battleId = req.params.battleId;
        const { moveId } = req.body;
        
        if (isNaN(pokemonId)) {
            return res.status(400).json({ 
                error: 'invalid_pokemon_id',
                message: 'Invalid Pokemon ID'
            });
        }

        if (!moveId) {
            return res.status(400).json({ 
                error: 'missing_move_id',
                message: 'Move ID is required'
            });
        }

        const result = await energyService.useMove(battleId, pokemonId, moveId);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.reason,
                details: result
            });
        }

        res.json({
            success: true,
            energyConsumed: result.energyConsumed,
            currentEnergy: result.currentEnergy,
            cooldownSet: result.cooldownSet
        });
    } catch (error) {
        logger.error('Failed to use move', { 
            error: error.message, 
            pokemonId: req.params.id,
            battleId: req.params.battleId
        });
        res.status(500).json({ 
            error: 'internal_error',
            message: error.message 
        });
    }
});

/**
 * 回合开始处理
 * POST /api/pokemon/:id/battle/:battleId/turn-start
 */
router.post('/:id/battle/:battleId/turn-start', async (req, res) => {
    try {
        const pokemonId = parseInt(req.params.id);
        const battleId = req.params.battleId;
        
        if (isNaN(pokemonId)) {
            return res.status(400).json({ 
                error: 'invalid_pokemon_id',
                message: 'Invalid Pokemon ID'
            });
        }

        const result = await energyService.processTurnStart(battleId, pokemonId);
        
        res.json({
            success: true,
            energyRegenerated: result.energyRegenerated,
            currentEnergy: result.currentEnergy,
            cooldowns: result.cooldownsReduced
        });
    } catch (error) {
        logger.error('Failed to process turn start', { 
            error: error.message, 
            pokemonId: req.params.id,
            battleId: req.params.battleId
        });
        res.status(500).json({ 
            error: 'internal_error',
            message: error.message 
        });
    }
});

/**
 * 获取技能能量信息
 * GET /api/moves/:moveId/energy-info
 */
router.get('/moves/:moveId/energy-info', async (req, res) => {
    try {
        const moveId = parseInt(req.params.moveId);
        
        if (isNaN(moveId)) {
            return res.status(400).json({ 
                error: 'invalid_move_id',
                message: 'Invalid Move ID'
            });
        }

        const moveInfo = await energyService.getMoveEnergyInfo(moveId);
        
        if (!moveInfo) {
            return res.status(404).json({ 
                error: 'move_not_found',
                message: 'Move not found'
            });
        }

        res.json(moveInfo);
    } catch (error) {
        logger.error('Failed to get move energy info', { 
            error: error.message, 
            moveId: req.params.moveId 
        });
        res.status(500).json({ 
            error: 'internal_error',
            message: error.message 
        });
    }
});

/**
 * 批量获取技能能量信息
 * POST /api/moves/energy-info/batch
 */
router.post('/moves/energy-info/batch', async (req, res) => {
    try {
        const { moveIds } = req.body;
        
        if (!Array.isArray(moveIds) || moveIds.length === 0) {
            return res.status(400).json({ 
                error: 'invalid_move_ids',
                message: 'Move IDs array is required'
            });
        }

        const moves = await energyService.batchGetMoveEnergyInfo(moveIds);
        
        res.json({
            moves,
            count: moves.length
        });
    } catch (error) {
        logger.error('Failed to batch get move energy info', { 
            error: error.message 
        });
        res.status(500).json({ 
            error: 'internal_error',
            message: error.message 
        });
    }
});

/**
 * 初始化能量池
 * POST /api/pokemon/:id/energy/initialize
 */
router.post('/:id/energy/initialize', async (req, res) => {
    try {
        const pokemonId = parseInt(req.params.id);
        const { baseMaxEnergy } = req.body;
        
        if (isNaN(pokemonId)) {
            return res.status(400).json({ 
                error: 'invalid_pokemon_id',
                message: 'Invalid Pokemon ID'
            });
        }

        const result = await energyService.initializeEnergyPool(pokemonId, baseMaxEnergy || 100);
        
        res.json({
            success: true,
            pokemonId,
            currentEnergy: result.current_energy,
            maxEnergy: result.max_energy,
            regenRate: result.energy_regen_rate
        });
    } catch (error) {
        logger.error('Failed to initialize energy pool', { 
            error: error.message, 
            pokemonId: req.params.id 
        });
        res.status(500).json({ 
            error: 'internal_error',
            message: error.message 
        });
    }
});

module.exports = router;
