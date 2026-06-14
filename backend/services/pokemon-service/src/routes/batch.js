// pokemon-service/src/routes/batch.js
// REQ-00092: API 请求合并与批量查询优化 - 批量精灵详情接口
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');
const { getJSON, setJSON } = require('../../../shared/redis');
const metrics = require('../../../shared/metrics');

const logger = createLogger('pokemon-batch');

// Prometheus metrics for batch operations
const batchRequestTotal = new (require('prom-client').Counter)({
  name: 'pokemon_batch_request_total',
  help: 'Total number of pokemon batch API requests',
  labelNames: ['status'],
});

const batchRequestSize = new (require('prom-client').Histogram)({
  name: 'pokemon_batch_request_size',
  help: 'Distribution of pokemon batch request sizes',
  buckets: [1, 5, 10, 20, 30, 40, 50],
});

/**
 * POST /batch/details
 * 批量获取精灵详情
 * 
 * Body: { ids: [123, 456, 789] }
 * Response: { code: 0, data: [pokemon1, pokemon2, pokemon3] }
 * 
 * 支持:
 * - 单次最多 50 个 ID
 * - 自动去重
 * - Redis 缓存加速
 */
router.post('/details', requireAuth, async (req, res, next) => {
  const startTime = Date.now();
  
  try {
    const { ids } = req.body;
    const userId = req.user.sub;

    // 参数校验
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError(1001, 'ids 必须是非空数组', 400);
    }

    if (ids.length > 50) {
      throw new AppError(1002, '单次批量查询最多 50 条', 400);
    }

    // 记录批量大小
    batchRequestSize.observe(ids.length);

    // 去重
    const uniqueIds = [...new Set(ids)];
    const idToIndex = new Map(ids.map((id, index) => [id, index]));

    // 尝试从 Redis 缓存批量获取
    const cacheKeys = uniqueIds.map(id => `pokemon:instance:${userId}:${id}`);
    let cachedResults = [];
    
    try {
      const cachedValues = await Promise.all(cacheKeys.map(key => getJSON(key)));
      cachedResults = cachedValues.map((v, i) => ({ id: uniqueIds[i], data: v }));
    } catch (cacheErr) {
      logger.warn({ err: cacheErr }, 'Redis cache read failed, falling back to DB');
    }

    // 分离命中和未命中
    const hitMap = new Map();
    const missIds = [];

    for (const result of cachedResults) {
      if (result.data) {
        hitMap.set(result.id, result.data);
      } else {
        missIds.push(result.id);
      }
    }

    logger.info({ 
      total: uniqueIds.length, 
      cached: hitMap.size, 
      miss: missIds.length 
    }, 'Batch details cache status');

    // 批量查询数据库获取未缓存的精灵
    if (missIds.length > 0) {
      const { rows } = await query(`
        SELECT 
          pi.id,
          pi.species_id,
          pi.nickname,
          pi.cp,
          pi.hp_current,
          pi.hp_max,
          pi.iv_attack,
          pi.iv_defense,
          pi.iv_hp,
          ROUND((pi.iv_attack + pi.iv_defense + pi.iv_hp) * 100.0 / 45, 1) AS iv_pct,
          pi.is_shiny,
          pi.is_lucky,
          pi.is_favorite,
          pi.fast_move,
          pi.charge_move,
          pi.caught_at,
          pi.location_caught,
          pi.buddy_distance_walked,
          ps.name_zh,
          ps.name_en,
          ps.type1,
          ps.type2,
          ps.sprite_url,
          ps.sprite_shiny_url,
          ps.rarity,
          ps.base_attack,
          ps.base_defense,
          ps.base_hp
        FROM pokemon_instances pi
        JOIN pokemon_species ps ON ps.id = pi.species_id
        WHERE pi.id = ANY($1) AND pi.user_id = $2
      `, [missIds, userId]);

      // 缓存并添加到结果
      for (const row of rows) {
        const data = formatPokemonData(row);
        hitMap.set(row.id, data);
        
        // 异步缓存，TTL 5 分钟
        setJSON(`pokemon:instance:${userId}:${row.id}`, data, 300).catch(() => {});
      }
    }

    // 按原始 ids 顺序返回结果
    const results = ids.map(id => hitMap.get(id) || null);

    // 记录指标
    batchRequestTotal.inc({ status: 'success' });
    
    const duration = Date.now() - startTime;
    logger.info({ 
      requested: ids.length, 
      returned: results.filter(Boolean).length,
      duration 
    }, 'Batch details completed');

    res.json(successResp({
      pokemon: results,
      requested: ids.length,
      returned: results.filter(Boolean).length,
      cached: cachedResults.filter(r => r.data).length
    }));

  } catch (err) {
    batchRequestTotal.inc({ status: 'error' });
    logger.error({ err }, 'Batch details failed');
    next(err);
  }
});

/**
 * POST /batch/species
 * 批量获取精灵种族数据（不包含个体数据）
 * 
 * Body: { speciesIds: [1, 4, 7] }
 * Response: { code: 0, data: [species1, species2, species3] }
 */
router.post('/species', async (req, res, next) => {
  const startTime = Date.now();
  
  try {
    const { speciesIds } = req.body;

    if (!Array.isArray(speciesIds) || speciesIds.length === 0) {
      throw new AppError(1001, 'speciesIds 必须是非空数组', 400);
    }

    if (speciesIds.length > 100) {
      throw new AppError(1002, '单次批量查询最多 100 条', 400);
    }

    const uniqueIds = [...new Set(speciesIds)];

    // 尝试从缓存获取
    const cacheKeys = uniqueIds.map(id => `pokemon:species:${id}`);
    let cachedResults = [];
    
    try {
      const cachedValues = await Promise.all(cacheKeys.map(key => getJSON(key)));
      cachedResults = cachedValues.map((v, i) => ({ id: uniqueIds[i], data: v }));
    } catch (cacheErr) {
      logger.warn({ err: cacheErr }, 'Species cache read failed');
    }

    const hitMap = new Map();
    const missIds = [];

    for (const result of cachedResults) {
      if (result.data) {
        hitMap.set(result.id, result.data);
      } else {
        missIds.push(result.id);
      }
    }

    // 查询数据库
    if (missIds.length > 0) {
      const { rows } = await query(`
        SELECT 
          id, name_zh, name_en, name_ja,
          type1, type2, rarity,
          base_attack, base_defense, base_hp,
          candy_to_evolve, evolves_to,
          sprite_url, sprite_shiny_url,
          description_zh, description_en
        FROM pokemon_species
        WHERE id = ANY($1)
      `, [missIds]);

      for (const row of rows) {
        const data = {
          id: row.id,
          name: { zh: row.name_zh, en: row.name_en, ja: row.name_ja },
          types: [row.type1, row.type2].filter(Boolean),
          rarity: row.rarity,
          stats: {
            attack: row.base_attack,
            defense: row.base_defense,
            hp: row.base_hp
          },
          evolution: {
            candyCost: row.candy_to_evolve,
            evolvesTo: row.evolves_to
          },
          sprites: {
            normal: row.sprite_url,
            shiny: row.sprite_shiny_url
          },
          description: {
            zh: row.description_zh,
            en: row.description_en
          }
        };
        
        hitMap.set(row.id, data);
        
        // 缓存 1 小时
        setJSON(`pokemon:species:${row.id}`, data, 3600).catch(() => {});
      }
    }

    // 按原始顺序返回
    const results = speciesIds.map(id => hitMap.get(id) || null);

    const duration = Date.now() - startTime;
    logger.info({ 
      requested: speciesIds.length, 
      returned: results.filter(Boolean).length,
      duration 
    }, 'Batch species completed');

    res.json(successResp({
      species: results,
      requested: speciesIds.length,
      returned: results.filter(Boolean).length
    }));

  } catch (err) {
    logger.error({ err }, 'Batch species failed');
    next(err);
  }
});

/**
 * POST /batch/iv
 * 批量计算精灵 IV 百分比
 * 
 * Body: { pokemon: [{ id: 123, ivAttack: 15, ivDefense: 14, ivHp: 15 }, ...] }
 * Response: { code: 0, data: [{ id: 123, ivPct: 97.8, grade: 'A+' }, ...] }
 */
router.post('/iv', requireAuth, async (req, res, next) => {
  try {
    const { pokemon } = req.body;

    if (!Array.isArray(pokemon) || pokemon.length === 0) {
      throw new AppError(1001, 'pokemon 必须是非空数组', 400);
    }

    if (pokemon.length > 100) {
      throw new AppError(1002, '单次批量计算最多 100 条', 400);
    }

    const results = pokemon.map(p => {
      const ivAttack = Math.max(0, Math.min(15, p.ivAttack || 0));
      const ivDefense = Math.max(0, Math.min(15, p.ivDefense || 0));
      const ivHp = Math.max(0, Math.min(15, p.ivHp || 0));
      
      const ivSum = ivAttack + ivDefense + ivHp;
      const ivPct = (ivSum / 45 * 100).toFixed(1);
      
      // 计算等级
      let grade = 'F';
      if (ivPct >= 97) grade = 'A+';
      else if (ivPct >= 90) grade = 'A';
      else if (ivPct >= 82) grade = 'B';
      else if (ivPct >= 67) grade = 'C';
      else if (ivPct >= 51) grade = 'D';
      
      return {
        id: p.id,
        ivAttack,
        ivDefense,
        ivHp,
        ivSum,
        ivPct: parseFloat(ivPct),
        grade,
        isPerfect: ivSum === 45,
        isHighIV: ivPct >= 90
      };
    });

    res.json(successResp({
      results,
      requested: pokemon.length
    }));

  } catch (err) {
    logger.error({ err }, 'Batch IV calculation failed');
    next(err);
  }
});

/**
 * 格式化精灵数据
 */
function formatPokemonData(row) {
  return {
    id: row.id,
    speciesId: row.species_id,
    nickname: row.nickname,
    cp: row.cp,
    hp: {
      current: row.hp_current,
      max: row.hp_max
    },
    iv: {
      attack: row.iv_attack,
      defense: row.iv_defense,
      hp: row.iv_hp,
      pct: parseFloat(row.iv_pct) || 0
    },
    isShiny: row.is_shiny,
    isLucky: row.is_lucky,
    isFavorite: row.is_favorite,
    moves: {
      fast: row.fast_move,
      charge: row.charge_move
    },
    caughtAt: row.caught_at,
    locationCaught: row.location_caught,
    buddyDistanceWalked: row.buddy_distance_walked || 0,
    species: {
      name: row.name_zh,
      nameEn: row.name_en,
      types: [row.type1, row.type2].filter(Boolean),
      rarity: row.rarity,
      sprites: {
        normal: row.sprite_url,
        shiny: row.sprite_shiny_url
      },
      baseStats: {
        attack: row.base_attack,
        defense: row.base_defense,
        hp: row.base_hp
      }
    }
  };
}

module.exports = router;
