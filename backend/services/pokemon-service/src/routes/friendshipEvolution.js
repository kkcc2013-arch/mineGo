// pokemon-service/src/routes/friendshipEvolution.js
'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, AppError, successResp } = require('../../../../shared/auth');
const { query } = require('../../../../shared/db');
const { FriendshipCalculator } = require('../friendshipCalculator');
const { createLogger } = require('../../../../shared/logger');

const logger = createLogger('friendship-evolution-routes');

/**
 * 获取精灵亲密度状态
 * GET /pokemon/:pokemonId/friendship
 */
router.get('/:pokemonId/friendship', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.sub;

    // 验证所有权
    const { rows: [pokemon] } = await query(
      'SELECT user_id FROM pokemon_instances WHERE id = $1',
      [pokemonId]
    );

    if (!pokemon) throw new AppError(4040, '精灵不存在', 404);
    if (pokemon.user_id !== userId) throw new AppError(4030, '无权访问此精灵', 403);

    const calculator = new FriendshipCalculator();
    const status = await calculator.getFriendshipStatus(pokemonId);

    res.json(successResp(status));
  } catch (err) {
    next(err);
  }
});

/**
 * 获取进化进度和建议
 * GET /pokemon/:pokemonId/friendship/evolution-progress
 */
router.get('/:pokemonId/friendship/evolution-progress', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.sub;

    const { rows: [pokemon] } = await query(
      'SELECT user_id FROM pokemon_instances WHERE id = $1',
      [pokemonId]
    );

    if (!pokemon) throw new AppError(4040, '精灵不存在', 404);
    if (pokemon.user_id !== userId) throw new AppError(4030, '无权访问此精灵', 403);

    const calculator = new FriendshipCalculator();
    const suggestions = await calculator.getFriendshipImprovementSuggestions(pokemonId);
    const status = await calculator.getFriendshipStatus(pokemonId);

    res.json(successResp({
      currentFriendship: status.friendship,
      friendshipLevel: status.friendshipLevel,
      evolutionProgress: status.evolutionProgress,
      suggestions
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * 获取亲密度历史
 * GET /pokemon/:pokemonId/friendship/history
 */
router.get('/:pokemonId/friendship/history', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.params;
    const { limit = 20 } = req.query;
    const userId = req.user.sub;

    const { rows: [pokemon] } = await query(
      'SELECT user_id FROM pokemon_instances WHERE id = $1',
      [pokemonId]
    );

    if (!pokemon) throw new AppError(4040, '精灵不存在', 404);
    if (pokemon.user_id !== userId) throw new AppError(4030, '无权访问此精灵', 403);

    const calculator = new FriendshipCalculator();
    const history = await calculator.getFriendshipHistory(pokemonId, parseInt(limit));

    res.json(successResp({ history, total: history.length }));
  } catch (err) {
    next(err);
  }
});

/**
 * 预览进化结果
 * POST /pokemon/:pokemonId/friendship/evolution-preview
 */
router.post('/:pokemonId/friendship/evolution-preview', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.sub;

    const { rows: [pokemon] } = await query(`
      SELECT pi.*, ps.name as species_name, ps.type_primary, ps.type_secondary,
             ps.base_attack, ps.base_defense, ps.base_stamina
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE pi.id = $1
    `, [pokemonId]);

    if (!pokemon) throw new AppError(4040, '精灵不存在', 404);
    if (pokemon.user_id !== userId) throw new AppError(4030, '无权访问此精灵', 403);

    const calculator = new FriendshipCalculator();
    const status = await calculator.getFriendshipStatus(pokemonId);

    if (!status.evolutionProgress.hasEvolution) {
      throw new AppError(4000, '该精灵无法通过亲密度进化', 400);
    }

    // 获取目标物种信息
    const { rows: [targetSpecies] } = await query(`
      SELECT id, name, type_primary, type_secondary,
             base_attack, base_defense, base_stamina
      FROM pokemon_species WHERE id = $1
    `, [status.evolutionProgress.targetSpeciesId]);

    // 计算进化后CP预测
    const currentCP = pokemon.cp;
    const estimatedCP = calculator.estimateEvolvedCP(pokemon, targetSpecies);

    res.json(successResp({
      canEvolve: status.canEvolve,
      currentSpecies: pokemon.species_name,
      targetSpecies: targetSpecies.name,
      currentFriendship: pokemon.friendship,
      requiredFriendship: status.evolutionProgress.requiredFriendship,
      currentCP,
      estimatedCP,
      cpChange: estimatedCP - currentCP,
      typeChange: {
        from: [pokemon.type_primary, pokemon.type_secondary].filter(Boolean),
        to: [targetSpecies.type_primary, targetSpecies.type_secondary].filter(Boolean)
      },
      timeRestriction: status.evolutionProgress.timeRestriction,
      currentTimeReady: status.evolutionProgress.timeReady
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * 增加亲密度（供其他服务调用）
 * POST /pokemon/:pokemonId/friendship/add
 */
router.post('/:pokemonId/friendship/add', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.params;
    const { source, amount, context } = req.body;
    const userId = req.user.sub;

    if (!source) throw new AppError(4000, '缺少 source 参数', 400);

    const { rows: [pokemon] } = await query(
      'SELECT user_id FROM pokemon_instances WHERE id = $1',
      [pokemonId]
    );

    if (!pokemon) throw new AppError(4040, '精灵不存在', 404);
    if (pokemon.user_id !== userId) throw new AppError(4030, '无权访问此精灵', 403);

    const calculator = new FriendshipCalculator();
    const result = await calculator.addFriendship(pokemonId, source, amount, context);

    res.json(successResp(result));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
