/**
 * REQ-00348: 精灵背包智能整理与自动分类系统
 * API 路由
 */

'use strict';

const express = require('express');
const router = express.Router();
const { query, getClient } = require('../../../../shared/db');
const redis = require('../../../../shared/redis');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../../shared/auth');
const { createLogger, requestLogger } = require('../../../../shared/logger');
const InventorySorter = require('../inventory/InventorySorter');
const OrganizationAdvisor = require('../inventory/OrganizationAdvisor');

const logger = createLogger('inventory-routes');
const sorter = new InventorySorter();
const advisor = new OrganizationAdvisor();

// 应用请求日志和认证中间件
router.use(requestLogger(logger));
router.use(requireAuth);

/**
 * GET /api/pokemon/inventory
 * 获取用户精灵列表（支持排序、分组、过滤）
 */
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const {
      sort = 'combatPower',
      order = 'desc',
      groupBy,
      type,
      minCP,
      maxCP,
      rarity,
      isFavorite,
      isLocked,
      search,
      page = 1,
      limit = 30
    } = req.query;

    // 构建过滤条件
    const filters = {};
    if (type) filters.type = type;
    if (minCP) filters.minCP = parseInt(minCP);
    if (maxCP) filters.maxCP = parseInt(maxCP);
    if (rarity) filters.rarity = rarity;
    if (isFavorite !== undefined) filters.isFavorite = isFavorite === 'true';
    if (isLocked !== undefined) filters.isLocked = isLocked === 'true';
    if (search) filters.search = search;

    // 获取精灵列表
    let pokemonList = await advisor.getUserPokemon(userId);

    // 应用排序
    pokemonList = sorter.sortPokemon(pokemonList, {
      primarySort: sort,
      secondarySort: 'rarity',
      order,
      filters
    });

    // 构建响应
    let response;
    if (groupBy) {
      // 分组展示
      const groups = sorter.groupPokemon(pokemonList, groupBy);
      response = {
        grouped: true,
        groups,
        total: pokemonList.length,
        groupCount: Object.keys(groups).length
      };
    } else {
      // 分页展示
      const offset = (parseInt(page) - 1) * parseInt(limit);
      const paginatedList = pokemonList.slice(offset, offset + parseInt(limit));

      response = {
        grouped: false,
        pokemon: paginatedList,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: pokemonList.length,
          totalPages: Math.ceil(pokemonList.length / parseInt(limit))
        }
      };
    }

    // 缓存用户偏好
    await advisor.updateUserSortPreference(userId, {
      primarySort: sort,
      secondarySort: 'rarity',
      order
    });

    res.json(successResp(response));
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get inventory');
    next(error);
  }
});

/**
 * GET /api/pokemon/inventory/advice
 * 获取智能整理建议
 */
router.get('/advice', async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const advice = await advisor.generateOrganizationAdvice(userId);
    res.json(successResp(advice));
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to generate advice');
    next(error);
  }
});

/**
 * GET /api/pokemon/inventory/sort-options
 * 获取可用的排序选项
 */
router.get('/sort-options', (req, res) => {
  const sortOptions = InventorySorter.getSortOptions();
  const groupOptions = InventorySorter.getGroupOptions();
  res.json(successResp({ sortOptions, groupOptions }));
});

/**
 * GET /api/pokemon/inventory/storage
 * 获取背包存储状态
 */
router.get('/storage', async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const pokemonList = await advisor.getUserPokemon(userId);
    const storageUsage = advisor.calculateStorageUsage(userId, pokemonList);
    res.json(successResp(storageUsage));
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get storage status');
    next(error);
  }
});

/**
 * GET /api/pokemon/inventory/:pokemonId
 * 获取单个精灵详情
 */
router.get('/:pokemonId', async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { pokemonId } = req.params;

    const result = await query(`
      SELECT 
        pi.*,
        ps.name as species_name,
        ps.types as species_types
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.id = $1 AND pi.user_id = $2 AND pi.is_deleted = false
    `, [pokemonId, userId]);

    if (result.rows.length === 0) {
      throw new AppError(4001, '精灵不存在', 404);
    }

    res.json(successResp(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pokemon/inventory/favorite
 * 设置/取消收藏
 */
router.post('/favorite', async (req, res, next) => {
  const client = await getClient();
  try {
    const userId = req.user.sub;
    const { pokemonId, isFavorite } = req.body;

    if (!pokemonId || isFavorite === undefined) {
      throw new AppError(1001, 'pokemonId 和 isFavorite 必填', 400);
    }

    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE pokemon_instances 
      SET is_favorite = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND is_deleted = false
      RETURNING id, species_id, is_favorite
    `, [isFavorite, pokemonId, userId]);

    if (result.rows.length === 0) {
      throw new AppError(4001, '精灵不存在或无权操作', 404);
    }

    await client.query('COMMIT');

    // 清除缓存
    await redis.del(`user:${userId}:pokemon:list`);

    logger.info({ userId, pokemonId, isFavorite }, 'Pokemon favorite toggled');

    res.json(successResp({
      pokemonId,
      isFavorite: result.rows[0].is_favorite
    }));
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * POST /api/pokemon/inventory/lock
 * 锁定/解锁精灵
 */
router.post('/lock', async (req, res, next) => {
  const client = await getClient();
  try {
    const userId = req.user.sub;
    const { pokemonId, isLocked } = req.body;

    if (!pokemonId || isLocked === undefined) {
      throw new AppError(1001, 'pokemonId 和 isLocked 必填', 400);
    }

    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE pokemon_instances 
      SET is_locked = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND is_deleted = false
      RETURNING id, species_id, is_locked
    `, [isLocked, pokemonId, userId]);

    if (result.rows.length === 0) {
      throw new AppError(4001, '精灵不存在或无权操作', 404);
    }

    await client.query('COMMIT');

    // 清除缓存
    await redis.del(`user:${userId}:pokemon:list`);

    logger.info({ userId, pokemonId, isLocked }, 'Pokemon lock toggled');

    res.json(successResp({
      pokemonId,
      isLocked: result.rows[0].is_locked
    }));
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * POST /api/pokemon/inventory/tags
 * 更新精灵自定义标签
 */
router.post('/tags', async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { pokemonId, tags } = req.body;

    if (!pokemonId || !Array.isArray(tags)) {
      throw new AppError(1001, 'pokemonId 和 tags 必填', 400);
    }

    const result = await query(`
      UPDATE pokemon_instances 
      SET custom_tags = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND is_deleted = false
      RETURNING id, custom_tags
    `, [tags, pokemonId, userId]);

    if (result.rows.length === 0) {
      throw new AppError(4001, '精灵不存在或无权操作', 404);
    }

    await redis.del(`user:${userId}:pokemon:list`);

    res.json(successResp({
      pokemonId,
      tags: result.rows[0].custom_tags
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pokemon/inventory/batch-transfer
 * 批量转移精灵
 */
router.post('/batch-transfer', async (req, res, next) => {
  const client = await getClient();
  try {
    const userId = req.user.sub;
    const { pokemonIds } = req.body;

    if (!pokemonIds || !Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      throw new AppError(1001, 'pokemonIds 必填且非空数组', 400);
    }

    // 批量限制
    if (pokemonIds.length > 100) {
      throw new AppError(1002, '单次最多转移100只精灵', 400);
    }

    await client.query('BEGIN');

    // 检查锁定和收藏精灵
    const lockedResult = await client.query(`
      SELECT id FROM pokemon_instances 
      WHERE id = ANY($1) AND user_id = $2 AND (is_locked = true OR is_favorite = true)
    `, [pokemonIds, userId]);

    if (lockedResult.rows.length > 0) {
      throw new AppError(1003, '包含锁定或收藏精灵，无法转移', 400, {
        lockedIds: lockedResult.rows.map(r => r.id)
      });
    }

    // 执行批量转移
    const transferResult = await client.query(`
      UPDATE pokemon_instances 
      SET is_deleted = true, deleted_at = NOW(), updated_at = NOW()
      WHERE id = ANY($1) AND user_id = $2 AND is_deleted = false 
        AND is_locked = false AND is_favorite = false
      RETURNING id, species_id
    `, [pokemonIds, userId]);

    const transferredCount = transferResult.rows.length;

    // 计算糖果奖励
    const candyReward = transferredCount * 1;

    // 发放糖果
    if (candyReward > 0) {
      await client.query(`
        INSERT INTO user_candies (user_id, amount)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET 
          amount = user_candies.amount + $2,
          updated_at = NOW()
      `, [userId, candyReward]);
    }

    await client.query('COMMIT');

    // 清除缓存
    await redis.del(`user:${userId}:pokemon:list`);

    logger.info({ userId, transferredCount, candyReward }, 'Batch transfer completed');

    res.json(successResp({
      transferred: transferredCount,
      candyEarned: candyReward,
      transferredIds: transferResult.rows.map(r => r.id)
    }));
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

/**
 * POST /api/pokemon/inventory/batch-favorite
 * 批量设置收藏
 */
router.post('/batch-favorite', async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { pokemonIds, isFavorite } = req.body;

    if (!pokemonIds || !Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      throw new AppError(1001, 'pokemonIds 必填且非空数组', 400);
    }

    if (isFavorite === undefined) {
      throw new AppError(1001, 'isFavorite 必填', 400);
    }

    const result = await query(`
      UPDATE pokemon_instances 
      SET is_favorite = $1, updated_at = NOW()
      WHERE id = ANY($2) AND user_id = $3 AND is_deleted = false
      RETURNING id
    `, [isFavorite, pokemonIds, userId]);

    await redis.del(`user:${userId}:pokemon:list`);

    res.json(successResp({
      updated: result.rows.length,
      isFavorite
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pokemon/inventory/sort-preference
 * 保存用户排序偏好
 */
router.post('/sort-preference', async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { primarySort, secondarySort, order } = req.body;

    if (!primarySort) {
      throw new AppError(1001, 'primarySort 必填', 400);
    }

    await advisor.updateUserSortPreference(userId, {
      primarySort,
      secondarySort: secondarySort || 'rarity',
      order: order || 'desc'
    });

    res.json(successResp({
      primarySort,
      secondarySort,
      order
    }));
  } catch (error) {
    next(error);
  }
});

// 错误处理
router.use(errorHandler);

module.exports = router;
