/**
 * REQ-00065: 精灵进化与成长系统
 * API 路由
 */

const express = require('express');
const router = express.Router();
const { EvolutionService } = require('../evolutionService');
const { logger } = require('../../../shared/logger');

const evolutionService = new EvolutionService();

/**
 * GET /api/pokemon/:id/evolution/check
 * 检查精灵是否可以进化
 */
router.get('/:id/evolution/check', async (req, res) => {
    try {
        const userId = req.user?.id || req.headers['x-user-id'];
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'UNAUTHORIZED',
                message: '需要登录才能检查进化状态'
            });
        }
        
        const pokemonId = parseInt(req.params.id);
        if (isNaN(pokemonId)) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_POKEMON_ID',
                message: '无效的精灵 ID'
            });
        }
        
        const result = await evolutionService.checkEvolutionEligibility(pokemonId, userId);
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Evolution check failed', { error: error.message, pokemonId: req.params.id });
        res.status(500).json({
            success: false,
            error: 'EVOLUTION_CHECK_FAILED',
            message: error.message
        });
    }
});

/**
 * POST /api/pokemon/:id/evolution/execute
 * 执行进化
 */
router.post('/:id/evolution/execute', async (req, res) => {
    try {
        const userId = req.user?.id || req.headers['x-user-id'];
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'UNAUTHORIZED',
                message: '需要登录才能执行进化'
            });
        }
        
        const pokemonId = parseInt(req.params.id);
        const { targetSpeciesId, skipAnimation } = req.body;
        
        if (isNaN(pokemonId)) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_POKEMON_ID',
                message: '无效的精灵 ID'
            });
        }
        
        if (!targetSpeciesId) {
            return res.status(400).json({
                success: false,
                error: 'TARGET_SPECIES_REQUIRED',
                message: '需要指定目标进化物种'
            });
        }
        
        const result = await evolutionService.performEvolution(
            pokemonId,
            userId,
            targetSpeciesId,
            { skipAnimation }
        );
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Evolution execution failed', { 
            error: error.message, 
            pokemonId: req.params.id,
            body: req.body
        });
        
        const errorMap = {
            'POKEMON_NOT_FOUND': { status: 404, message: '精灵不存在' },
            'INVALID_EVOLUTION_PATH': { status: 400, message: '无效的进化路径' },
            'EVOLUTION_CONDITIONS_NOT_MET': { status: 400, message: '未满足进化条件' },
            'TARGET_SPECIES_NOT_FOUND': { status: 404, message: '目标物种不存在' },
            'INSUFFICIENT_ITEMS': { status: 400, message: '道具不足' }
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
 * POST /api/pokemon/:id/experience
 * 添加经验值
 */
router.post('/:id/experience', async (req, res) => {
    try {
        const userId = req.user?.id || req.headers['x-user-id'];
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'UNAUTHORIZED',
                message: '需要登录才能添加经验值'
            });
        }
        
        const pokemonId = parseInt(req.params.id);
        const { amount, source, bonusMultiplier } = req.body;
        
        if (isNaN(pokemonId)) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_POKEMON_ID',
                message: '无效的精灵 ID'
            });
        }
        
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_AMOUNT',
                message: '经验值必须大于 0'
            });
        }
        
        const result = await evolutionService.addExperience(
            pokemonId,
            userId,
            amount,
            source || 'unknown',
            { bonusMultiplier }
        );
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Add experience failed', { 
            error: error.message, 
            pokemonId: req.params.id,
            body: req.body
        });
        res.status(500).json({
            success: false,
            error: 'ADD_EXPERIENCE_FAILED',
            message: error.message
        });
    }
});

/**
 * POST /api/pokemon/:id/friendship
 * 增加亲密度
 */
router.post('/:id/friendship', async (req, res) => {
    try {
        const userId = req.user?.id || req.headers['x-user-id'];
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'UNAUTHORIZED'
            });
        }
        
        const pokemonId = parseInt(req.params.id);
        const { changeType, amount } = req.body;
        
        if (isNaN(pokemonId)) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_POKEMON_ID'
            });
        }
        
        const result = await evolutionService.addFriendship(
            pokemonId,
            userId,
            changeType || 'walk',
            amount || 1
        );
        
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        logger.error('Add friendship failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'ADD_FRIENDSHIP_FAILED',
            message: error.message
        });
    }
});

/**
 * GET /api/pokemon/:id/stats
 * 获取精灵详细属性
 */
router.get('/:id/stats', async (req, res) => {
    try {
        const userId = req.user?.id || req.headers['x-user-id'];
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'UNAUTHORIZED'
            });
        }
        
        const pokemonId = parseInt(req.params.id);
        
        const result = await evolutionService.db.query(`
            SELECT pi.*, ps.name as species_name, ps.types, ps.image_url,
                   ps.base_hp, ps.base_attack, ps.base_defense,
                   ps.base_sp_attack, ps.base_sp_defense, ps.base_speed,
                   ps.growth_rate
            FROM pokemon_instances pi
            JOIN pokemon_species ps ON pi.species_id = ps.id
            WHERE pi.id = $1 AND pi.user_id = $2
        `, [pokemonId, userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'POKEMON_NOT_FOUND'
            });
        }
        
        const pokemon = result.rows[0];
        const growthRate = pokemon.growth_rate || 'medium_fast';
        const expForNextLevel = evolutionService.getExpForLevel(
            (pokemon.level || 1) + 1,
            growthRate
        );
        
        res.json({
            success: true,
            data: {
                ...pokemon,
                expForNextLevel,
                expProgress: ((pokemon.experience || 0) / expForNextLevel * 100).toFixed(2)
            }
        });
    } catch (error) {
        logger.error('Get pokemon stats failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'GET_STATS_FAILED',
            message: error.message
        });
    }
});

/**
 * GET /api/evolution/items
 * 获取所有进化道具
 */
router.get('/evolution/items', async (req, res) => {
    try {
        const result = await evolutionService.db.query(`
            SELECT * FROM evolution_items ORDER BY name
        `);
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/evolution/history/:userId
 * 获取用户进化历史
 */
router.get('/evolution/history/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;
        
        const result = await evolutionService.db.query(`
            SELECT eh.*, 
                   ps_from.name as from_species_name,
                   ps_to.name as to_species_name
            FROM evolution_history eh
            JOIN pokemon_species ps_from ON eh.from_species_id = ps_from.id
            JOIN pokemon_species ps_to ON eh.to_species_id = ps_to.id
            WHERE eh.user_id = $1
            ORDER BY eh.created_at DESC
            LIMIT $2 OFFSET $3
        `, [userId, limit, offset]);
        
        const countResult = await evolutionService.db.query(`
            SELECT COUNT(*) as total FROM evolution_history WHERE user_id = $1
        `, [userId]);
        
        res.json({
            success: true,
            data: {
                history: result.rows,
                total: parseInt(countResult.rows[0].total),
                limit,
                offset
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
