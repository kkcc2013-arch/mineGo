// location-service/src/index.js  +  routes/map.js  (combined)
'use strict';
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const { query, preparedQuery }  = require('../../../shared/db');
const { getRedis, geoAdd, geoRadius, setJSON, getJSON } = require('../../../shared/redis');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../shared/auth');
const { createLogger, requestLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { getWeather, getBoostedTypes, getTypeNameZh } = require('../../../shared/weatherService');

// Import day/night service (REQ-00102)
const { dayNightService, getCurrentTimePeriod, applyDayNightWeights, TIME_PERIODS } = require('./dayNightService');

// Import spawn config routes (REQ-00142)
const spawnConfigRouter = require('./routes/spawnConfig');

// Import recovery stations routes (REQ-00156)
const recoveryStationsRouter = require('./routes/recoveryStations');

// Import day/night cycle routes (REQ-00102)
const dayNightRouter = require('./routes/dayNight');

// Import habitat routes (REQ-00361)
const habitatRouter = require('./routes/habitat');

const logger = createLogger('location-service');
const SERVICE_NAME = 'location-service';

const app  = express();
const PORT = process.env.PORT || 8082;

app.use(helmet());
app.use(cors());
app.use(express.json());

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'location-service' }));

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.send(await metrics.register.metrics());
  } catch (err) {
    logger.error({ err }, 'Failed to generate metrics');
    res.status(500).json({ error: 'Metrics generation failed' });
  }
});

// ============================================================
// SPAWN ENGINE
// ============================================================
const WEATHER_BONUS = {
  SUNNY:  ['FIRE','GRASS','GROUND'],
  RAINY:  ['WATER','ELECTRIC','BUG'],
  CLOUDY: ['NORMAL','POISON','FAIRY'],
  SNOWY:  ['ICE','STEEL'],
  WINDY:  ['DRAGON','FLYING','PSYCHIC'],
  FOGGY:  ['GHOST','DARK'],
};

const RARITY_WEIGHTS = {
  COMMON: 60, UNCOMMON: 25, RARE: 12, EPIC: 2.5, LEGENDARY: 0.5
};

/**
 * 获取指定坐标的天气加成类型
 * 现在已集成 OpenWeatherMap API，提供真实天气数据
 * 
 * @param {number} lat 纬度
 * @param {number} lng 经度
 * @returns {Promise<string>} 天气类型（SUNNY/RAINY/CLOUDY/SNOWY/WINDY/FOGGY）
 */
async function getWeatherBonus(lat, lng) {
  const weatherData = await getWeather(lat, lng);
  return weatherData.weather;
}

async function spawnPokemonForPoint(spawnPointId, lat, lng, biome) {
  const spawnKey = `spawn:${spawnPointId}`;
  const existing = await getJSON(spawnKey);
  if (existing) return existing; // already active

  // REQ-00102: Get current time period for day/night spawn bonuses
  const timePeriodInfo = await getCurrentTimePeriod(0);
  const currentPeriod = timePeriodInfo.period;
  const periodBonus = timePeriodInfo.spawnBonusMultiplier;

  // Pick species based on biome + rarity weights + day/night weights
  const { rows: species } = await query(`
    SELECT id, rarity, type1, time_preference, is_nocturnal, is_diurnal FROM pokemon_species
    WHERE ($1 = 'ANY' OR $1 = ANY(biomes) OR biomes IS NULL)
    ORDER BY random()
    LIMIT 50
  `, [biome]);

  if (!species.length) return null;

  // REQ-00102: Apply day/night weights
  const weightedSpecies = await applyDayNightWeights(species, currentPeriod, periodBonus);

  // Weighted random selection
  let totalWeight = 0;
  const weighted = weightedSpecies.map(s => {
    const w = s.finalWeight || RARITY_WEIGHTS[s.rarity] || 10;
    totalWeight += w;
    return { ...s, weight: w, ivBonus: s.ivBonus || 0 };
  });

  let rand = Math.random() * totalWeight;
  let chosen = weighted[0];
  for (const s of weighted) {
    rand -= s.weight;
    if (rand <= 0) { chosen = s; break; }
  }

  const weatherData = await getWeather(lat, lng);
  const weatherBoosted = (WEATHER_BONUS[weatherData.weather] || []).some(t => chosen.type1 === t);

  // Generate IVs with special IV system (REQ-00160) + REQ-00102 day/night bonus
  const specialRoll = Math.random();
  let iv_attack, iv_defense, iv_hp;
  let is_zero_iv = false;
  let is_perfect_iv = false;
  const ivBonus = chosen.ivBonus || 0;

  if (specialRoll < 0.0001) { // 0.01% 零 IV
    iv_attack = iv_defense = iv_hp = 0;
    is_zero_iv = true;
    logger.info({ spawnPointId, speciesId: chosen.id, type: 'zero_iv', period: currentPeriod }, 'Special IV spawned: Zero IV');
  } else if (specialRoll < 0.001) { // 0.09% 完美 IV (0.001 - 0.0001)
    iv_attack = iv_defense = iv_hp = 15;
    is_perfect_iv = true;
    logger.info({ spawnPointId, speciesId: chosen.id, type: 'perfect_iv', period: currentPeriod }, 'Special IV spawned: Perfect IV');
  } else { // 普通生成，应用昼夜IV加成
    const ivBoost = Math.floor(ivBonus * 15); // 将百分比转换为IV点数
    iv_attack  = Math.min(15, Math.floor(Math.random() * 16) + ivBoost);
    iv_defense = Math.min(15, Math.floor(Math.random() * 16) + ivBoost);
    iv_hp      = Math.min(15, Math.floor(Math.random() * 16) + ivBoost);
    
    if (ivBonus > 0) {
      logger.debug({ spawnPointId, speciesId: chosen.id, ivBonus, period: currentPeriod }, 'Applied day/night IV bonus');
    }
  }

  // Calculate CP (simplified formula)
  const { rows: [spec] } = await query(
    'SELECT base_attack, base_defense, base_hp FROM pokemon_species WHERE id=$1', [chosen.id]
  );
  const cp = Math.max(10, Math.floor(
    ((spec.base_attack + iv_attack) * Math.sqrt(spec.base_defense + iv_defense) * Math.sqrt(spec.base_hp + iv_hp)) / 10
  ));

  const isShiny = Math.random() < (1 / 4096);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

  // Save to DB
  const { rows: [wild] } = await query(`
    INSERT INTO wild_pokemon
      (spawn_point_id, species_id, lat, lng, location, cp, iv_attack, iv_defense, iv_hp,
       is_shiny, weather_boosted, expires_at)
    VALUES ($1,$2,$3,$4, ST_GeographyFromText('SRID=4326;POINT(${lng} ${lat})'), $5,$6,$7,$8,$9,$10,$11)
    RETURNING id, species_id, lat, lng, cp, is_shiny, weather_boosted, expires_at
  `, [spawnPointId, chosen.id, lat, lng, cp, iv_attack, iv_defense, iv_hp, isShiny, weatherBoosted, expiresAt]);

  const payload = { 
    ...wild, 
    spawnPointId,
    weather: weatherData.weather,
    weatherDescription: weatherData.description,
    temperature: weatherData.temperature,
    fallback: weatherData.fallback,
    // 特殊 IV 标识 (REQ-00160)
    is_zero_iv,
    is_perfect_iv
  };
  await setJSON(spawnKey, payload, 1800);
  
  // Cache in Redis GEO and detail cache
  await geoAdd('geo:wild_pokemon', lng, lat, wild.id);
  await setJSON(`wild:${wild.id}`, {
    id: wild.id,
    species_id: wild.species_id,
    lat: wild.lat,
    lng: wild.lng,
    cp: wild.cp,
    is_shiny: wild.is_shiny,
    weather_boosted: wild.weather_boosted,
    expires_at: wild.expires_at,
    name_zh: wild.name_zh,
    rarity: wild.rarity
  }, 1800);

  // Update spawn point
  await query('UPDATE spawn_points SET last_spawn_at = NOW() WHERE id=$1', [spawnPointId]);

  return payload;
}

// Background spawn worker (runs every 5 min in prod, triggered here)
async function runSpawnCycle() {
  const { rows: points } = await query(`
    SELECT id, lat, lng, biome FROM spawn_points
    WHERE is_active = true
      AND (last_spawn_at IS NULL OR last_spawn_at < NOW() - INTERVAL '15 minutes')
    LIMIT 200
  `);

  let spawned = 0;
  for (const pt of points) {
    try {
      const result = await spawnPokemonForPoint(pt.id, pt.lat, pt.lng, pt.biome);
      if (result) {
        await geoAdd('geo:wild_pokemon', pt.lng, pt.lat, result.id);
        spawned++;
      }
    } catch (err) {
      console.error('[Spawn] Error for point', pt.id, err.message);
    }
  }
  console.log(`[Spawn] Cycle complete: ${spawned} new spawns`);
}

// ============================================================
// ROUTES
// ============================================================
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'location-service' }));

// GET /map/weather — 获取当前天气
app.get('/map/weather', requireAuth, async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    
    if (isNaN(lat) || isNaN(lng)) {
      throw new AppError(1001, 'lat/lng 无效', 400);
    }
    
    const weatherData = await getWeather(lat, lng);
    
    // 获取受天气加成的精灵类型
    const boostedTypes = getBoostedTypes(weatherData.weather);
    const boostedTypesZh = boostedTypes.map(t => getTypeNameZh(t));
    
    res.json(successResp({
      ...weatherData,
      boostedTypes,
      boostedTypesZh
    }));
  } catch (err) { next(err); }
});

// POST /location  — player GPS update
app.post('/location', requireAuth, async (req, res, next) => {
  try {
    const { lat, lng, accuracy } = req.body;
    if (!lat || !lng) throw new AppError(1001, 'lat/lng 必填', 400);

    const userId = req.user.sub;

    // Anti-cheat: speed check
    const prevKey  = `player:pos:${userId}`;
    const prevData = await getJSON(prevKey);
    if (prevData) {
      const distKm  = haversineKm(prevData.lat, prevData.lng, lat, lng);
      const timeSec = (Date.now() - prevData.ts) / 1000;
      const speedKmh = distKm / (timeSec / 3600);
      if (speedKmh > 100) {
        console.warn('[AntiCheat] Possible GPS spoof: userId=%s speed=%.1f km/h', userId, speedKmh);
        return res.json(successResp({ nearbyAlert: false, warning: 'speed_anomaly' }));
      }
      // Update distance
      if (distKm > 0.005) { // > 5m threshold
        await query('UPDATE users SET total_distance_km = total_distance_km + $1, last_lat=$2, last_lng=$3 WHERE id=$4',
          [distKm, lat, lng, userId]);
      }
    }

    // Store position in Redis (for speed checks + GEO queries)
    await setJSON(prevKey, { lat, lng, ts: Date.now() }, 300);
    await geoAdd('geo:players', lng, lat, userId);

    // Check if any nearby spawns should trigger
    const nearbyCount = await getNearbyWildCount(lat, lng, 500);

    res.json(successResp({ nearbyAlert: nearbyCount > 0 }));
  } catch (err) { next(err); }
});

// GET /map/nearby — get all game elements near player
app.get('/map/nearby', requireAuth, async (req, res, next) => {
  try {
    const lat    = parseFloat(req.query.lat);
    const lng    = parseFloat(req.query.lng);
    const radius = Math.min(parseInt(req.query.radius || '500'), 1000);

    if (isNaN(lat) || isNaN(lng)) throw new AppError(1001, 'lat/lng 无效', 400);

    // Trigger spawn cycle if needed
    runSpawnCycle().catch(console.error);

    const [wildPokemons, pokestops, gyms] = await Promise.all([
      getNearbyWild(lat, lng, radius),
      getNearbyPokestops(lat, lng, radius, req.user.sub),
      getNearbyGyms(lat, lng, radius),
    ]);

    res.json(successResp({ wildPokemons, pokestops, gyms }));
  } catch (err) { next(err); }
});

// DELETE /cache/wild/:id — invalidate wild pokemon cache (called by catch-service)
app.delete('/cache/wild/:id', requireAuth, async (req, res, next) => {
  try {
    const wildId = req.params.id;
    const redis = getRedis();
    
    // Remove from GEO index and detail cache
    await Promise.all([
      redis.zrem('geo:wild_pokemon', wildId),
      redis.del(`wild:${wildId}`)
    ]);
    
    res.json(successResp({ invalidated: true, wildId }));
  } catch (err) { next(err); }
});

// GET /metrics/cache — cache performance metrics
app.get('/metrics/cache', async (req, res, next) => {
  try {
    const total = cacheHits + cacheMisses;
    const hitRate = total > 0 ? (cacheHits / total * 100).toFixed(2) : 0;
    
    res.json({
      cache_hits: cacheHits,
      cache_misses: cacheMisses,
      hit_rate_pct: parseFloat(hitRate),
      total_queries: total
    });
  } catch (err) { next(err); }
});

// ── Data fetch helpers ────────────────────────────────────────
// Cache hit/miss metrics (in-memory for now)
let cacheHits = 0;
let cacheMisses = 0;

async function getNearbyWild(lat, lng, radius) {
  try {
    // Step 1: Try Redis GEO cache first
    const geoResults = await geoRadius('geo:wild_pokemon', lng, lat, radius);
    
    if (geoResults && geoResults.length > 0) {
      // Step 2: Batch fetch details from cache
      const ids = geoResults.map(r => r[0]); // member is wild_pokemon.id
      const cached = await Promise.all(ids.map(id => getJSON(`wild:${id}`)));
      
      // Step 3: Filter valid (not expired, not caught)
      const now = Date.now();
      const valid = cached
        .filter(w => w && new Date(w.expires_at).getTime() > now)
        .map(w => ({
          ...w,
          distance: geoResults.find(r => r[0] === String(w.id))?.[1] || 0
        }));
      
      // Step 4: Check cache hit rate
      const hitRate = valid.length / ids.length;
      cacheHits++;
      
      // If cache hit rate > 80%, return cached data
      if (hitRate > 0.8) {
        return valid.slice(0, 50);
      }
    }
    
    // Step 5: Cache miss or low hit rate - fallback to DB
    cacheMisses++;
    return await getNearbyWildFromDB(lat, lng, radius);
    
  } catch (err) {
    // Cache error - fallback to DB
    console.error('[Cache] Redis error, fallback to DB:', err.message);
    cacheMisses++;
    return await getNearbyWildFromDB(lat, lng, radius);
  }
}

async function getNearbyWildFromDB(lat, lng, radius) {
  // REQ-00575: 使用预编译查询提升性能
  const { rows } = await preparedQuery('getNearbyWild', [lat, lng, radius]);
  
  // Populate cache for future queries
  for (const w of rows) {
    await setJSON(`wild:${w.id}`, w, 1800);
  }
  
  return rows;
}

async function getNearbyWildCount(lat, lng, radius) {
  // REQ-00575: 使用预编译查询
  const { rows: [r] } = await preparedQuery('getNearbyWildCount', [lat, lng, radius]);
  return r.count;
}

async function getNearbyPokestops(lat, lng, radius, userId) {
  const COOLDOWN_MIN = 5;
  const { rows } = await query(`
    SELECT ps.id, ps.name, ps.lat, ps.lng, ps.image_url,
      CASE WHEN last_spin.spun_at > NOW() - INTERVAL '${COOLDOWN_MIN} minutes' THEN false ELSE true END AS can_spin
    FROM pokestops ps
    LEFT JOIN LATERAL (
      SELECT spun_at FROM pokestop_spins
      WHERE pokestop_id = ps.id AND user_id = $3
      ORDER BY spun_at DESC LIMIT 1
    ) last_spin ON true
    WHERE ps.is_active = true
      AND ST_DWithin(
        ps.location::geography,
        ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
        $4
      )
    LIMIT 30
  `, [lat, lng, userId, radius]);
  return rows;
}

async function getNearbyGyms(lat, lng, radius) {
  const { rows } = await query(`
    SELECT g.id, g.name, g.lat, g.lng, g.controlling_team, g.image_url,
           COUNT(gd.id)::int AS defender_count,
           r.id AS active_raid_id, r.raid_level, r.boss_species_id, r.ends_at AS raid_ends_at
    FROM gyms g
    LEFT JOIN gym_defenders gd ON gd.gym_id = g.id
    LEFT JOIN raids r ON r.gym_id = g.id AND r.status = 'ACTIVE' AND r.ends_at > NOW()
    WHERE g.is_active = true
      AND ST_DWithin(
        g.location::geography,
        ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
        $3
      )
    GROUP BY g.id, r.id
    LIMIT 20
  `, [lat, lng, radius]);
  return rows;
}

// Haversine distance in km
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Spawn Config Routes (REQ-00142: 精灵刷新配置管理) ──────────────
app.use('/api/admin/spawn', spawnConfigRouter);

// ── Recovery Stations Routes (REQ-00156: 精灵恢复站系统) ──────────────
app.use('/recovery-stations', recoveryStationsRouter);

// ── Day/Night Cycle Routes (REQ-00102: 精灵昼夜循环系统) ──────────────
app.use('/daynight', dayNightRouter);

// ── Habitat Routes (REQ-00361: 精灵栖息地偏好与环境加成系统) ──────────────
app.use('/habitat', habitatRouter);

app.use(errorHandler);
app.listen(PORT, () => logger.info({ port: PORT }, 'Location service started'));
module.exports = app;
