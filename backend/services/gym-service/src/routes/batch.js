// gym-service/src/routes/batch.js
// REQ-00092: API 请求合并与批量查询优化 - 道馆批量信息接口
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');
const { getJSON, setJSON } = require('../../../shared/redis');

const logger = createLogger('gym-batch');

// Prometheus metrics
const batchRequestTotal = new (require('prom-client').Counter)({
  name: 'gym_batch_request_total',
  help: 'Total number of gym batch API requests',
  labelNames: ['endpoint', 'status'],
});

const batchRequestSize = new (require('prom-client').Histogram)({
  name: 'gym_batch_request_size',
  help: 'Distribution of gym batch request sizes',
  buckets: [1, 5, 10, 20, 30, 50],
});

/**
 * POST /batch/details
 * 批量获取道馆详细信息
 * 
 * Body: { gymIds: ['gym1', 'gym2', 'gym3'] }
 * Response: { code: 0, data: { gyms: [gym1, gym2, gym3] } }
 */
router.post('/details', async (req, res, next) => {
  const startTime = Date.now();
  
  try {
    const { gymIds } = req.body;

    // 参数校验
    if (!Array.isArray(gymIds) || gymIds.length === 0) {
      throw new AppError(1001, 'gymIds 必须是非空数组', 400);
    }

    if (gymIds.length > 50) {
      throw new AppError(1002, '单次批量查询最多 50 条', 400);
    }

    // 记录批量大小
    batchRequestSize.observe(gymIds.length);

    // 去重
    const uniqueIds = [...new Set(gymIds)];
    const idToIndex = new Map(gymIds.map((id, index) => [id, index]));

    // 尝试从缓存获取
    const cacheKeys = uniqueIds.map(id => `gym:details:${id}`);
    let cachedResults = [];
    
    try {
      const cachedValues = await Promise.all(cacheKeys.map(key => getJSON(key)));
      cachedResults = cachedValues.map((v, i) => ({ id: uniqueIds[i], data: v }));
    } catch (cacheErr) {
      logger.warn({ err: cacheErr }, 'Gym cache read failed');
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

    // 批量查询数据库
    if (missIds.length > 0) {
      const { rows: gyms } = await query(`
        SELECT 
          g.id, 
          g.name, 
          g.lat, 
          g.lng, 
          g.team, 
          g.prestige,
          g.ex_raid_eligible AS ex_raid_eligible,
          g.level,
          (SELECT COUNT(*)::int FROM gym_defenders WHERE gym_id = g.id) AS defender_count
        FROM gyms g
        WHERE g.id = ANY($1)
      `, [missIds]);

      // 批量查询防守精灵
      const gymIdsFound = gyms.map(g => g.id);
      let defenders = [];
      
      if (gymIdsFound.length > 0) {
        const { rows: defenderRows } = await query(`
          SELECT 
            gd.gym_id,
            gd.pokemon_id,
            gd.cp,
            gd.motivation,
            gd.slot_order,
            u.nickname AS trainer_name,
            ps.name_zh AS pokemon_name
          FROM gym_defenders gd
          JOIN users u ON u.id = gd.user_id
          JOIN pokemon_instances pi ON pi.id = gd.pokemon_id
          JOIN pokemon_species ps ON ps.id = pi.species_id
          WHERE gd.gym_id = ANY($1)
          ORDER BY gd.gym_id, gd.slot_order
        `, [gymIdsFound]);
        
        defenders = defenderRows;
      }

      // 组装数据并缓存
      for (const gym of gyms) {
        const gymDefenders = defenders.filter(d => d.gym_id === gym.id);
        
        const data = {
          id: gym.id,
          name: gym.name,
          location: {
            lat: gym.lat,
            lng: gym.lng
          },
          team: gym.team,
          prestige: gym.prestige,
          exRaidEligible: gym.ex_raid_eligible,
          level: gym.level,
          defenderCount: gym.defender_count,
          defenders: gymDefenders.map(d => ({
            pokemonId: d.pokemon_id,
            pokemonName: d.pokemon_name,
            cp: d.cp,
            motivation: d.motivation,
            slotOrder: d.slot_order,
            trainerName: d.trainer_name
          }))
        };
        
        hitMap.set(gym.id, data);
        
        // 缓存 1 分钟（道馆信息变化相对频繁）
        setJSON(`gym:details:${gym.id}`, data, 60).catch(() => {});
      }
    }

    // 按原始顺序返回
    const results = gymIds.map(id => hitMap.get(id) || null);

    batchRequestTotal.inc({ endpoint: 'details', status: 'success' });
    
    const duration = Date.now() - startTime;
    logger.info({ 
      requested: gymIds.length, 
      returned: results.filter(Boolean).length,
      cached: cachedResults.filter(r => r.data).length,
      duration 
    }, 'Batch gym details completed');

    res.json(successResp({
      gyms: results,
      requested: gymIds.length,
      returned: results.filter(Boolean).length
    }));

  } catch (err) {
    batchRequestTotal.inc({ endpoint: 'details', status: 'error' });
    logger.error({ err }, 'Batch gym details failed');
    next(err);
  }
});

/**
 * POST /batch/nearby
 * 批量获取附近道馆简要信息（用于地图显示）
 * 
 * Body: { lat, lng, radius = 1000, limit = 20 }
 * Response: { code: 0, data: { gyms: [...] } }
 */
router.post('/nearby', async (req, res, next) => {
  try {
    const { lat, lng, radius = 1000, limit = 20 } = req.body;

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw new AppError(1001, 'lat 和 lng 必填', 400);
    }

    if (radius > 5000) {
      throw new AppError(1002, '最大搜索半径 5000 米', 400);
    }

    // 使用 PostGIS 进行空间查询
    const { rows: gyms } = await query(`
      SELECT 
        g.id,
        g.name,
        g.lat,
        g.lng,
        g.team,
        g.prestige,
        g.level,
        (SELECT COUNT(*)::int FROM gym_defenders WHERE gym_id = g.id) AS defender_count,
        ST_Distance(
          ST_MakePoint(g.lng, g.lat)::geography,
          ST_MakePoint($2, $1)::geography
        ) AS distance
      FROM gyms g
      WHERE ST_DWithin(
        ST_MakePoint(g.lng, g.lat)::geography,
        ST_MakePoint($2, $1)::geography,
        $3
      )
      ORDER BY distance
      LIMIT $4
    `, [lat, lng, radius, limit]);

    const results = gyms.map(g => ({
      id: g.id,
      name: g.name,
      location: { lat: g.lat, lng: g.lng },
      team: g.team,
      prestige: g.prestige,
      level: g.level,
      defenderCount: g.defender_count,
      distance: Math.round(g.distance)
    }));

    res.json(successResp({
      gyms: results,
      center: { lat, lng },
      radius,
      total: results.length
    }));

  } catch (err) {
    logger.error({ err }, 'Batch nearby gyms failed');
    next(err);
  }
});

/**
 * POST /batch/raids
 * 批量获取道馆 Raid 信息
 * 
 * Body: { gymIds: ['gym1', 'gym2'] }
 */
router.post('/raids', requireAuth, async (req, res, next) => {
  try {
    const { gymIds } = req.body;

    if (!Array.isArray(gymIds) || gymIds.length === 0) {
      throw new AppError(1001, 'gymIds 必须是非空数组', 400);
    }

    if (gymIds.length > 50) {
      throw new AppError(1002, '单次批量查询最多 50 条', 400);
    }

    const uniqueIds = [...new Set(gymIds)];

    // 批量查询 Raid 信息
    const { rows: raids } = await query(`
      SELECT 
        r.id AS raid_id,
        r.gym_id,
        r.pokemon_id,
        r.raid_level,
        r.starts_at,
        r.ends_at,
        r.is_exclusive,
        ps.name_zh AS pokemon_name,
        ps.sprite_url
      FROM raids r
      LEFT JOIN pokemon_species ps ON ps.id = r.pokemon_id
      WHERE r.gym_id = ANY($1)
        AND r.ends_at > NOW()
    `, [uniqueIds]);

    // 批量查询参与人数
    const raidIds = raids.map(r => r.raid_id);
    let participantCounts = [];
    
    if (raidIds.length > 0) {
      const { rows: counts } = await query(`
        SELECT raid_id, COUNT(*)::int AS participant_count
        FROM raid_participants
        WHERE raid_id = ANY($1)
        GROUP BY raid_id
      `, [raidIds]);
      
      participantCounts = counts;
    }

    const participantMap = new Map(participantCounts.map(c => [c.raid_id, c.participant_count]));

    // 按 gym 分组
    const gymRaidMap = new Map();
    
    for (const raid of raids) {
      const raidInfo = {
        raidId: raid.raid_id,
        pokemonId: raid.pokemon_id,
        pokemonName: raid.pokemon_name,
        spriteUrl: raid.sprite_url,
        level: raid.raid_level,
        startsAt: raid.starts_at,
        endsAt: raid.ends_at,
        isExclusive: raid.is_exclusive,
        participantCount: participantMap.get(raid.raid_id) || 0
      };
      
      if (!gymRaidMap.has(raid.gym_id)) {
        gymRaidMap.set(raid.gym_id, []);
      }
      gymRaidMap.get(raid.gym_id).push(raidInfo);
    }

    // 组装结果
    const results = gymIds.map(id => ({
      gymId: id,
      hasRaid: gymRaidMap.has(id),
      raids: gymRaidMap.get(id) || []
    }));

    res.json(successResp({
      gyms: results,
      requested: gymIds.length,
      withRaids: results.filter(r => r.hasRaid).length
    }));

  } catch (err) {
    logger.error({ err }, 'Batch raids failed');
    next(err);
  }
});

module.exports = router;
