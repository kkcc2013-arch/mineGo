// location-service/src/index.js  +  routes/map.js  (combined)
'use strict';
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const { query }  = require('../../../shared/db');
const { getRedis, geoAdd, geoRadius, setJSON, getJSON } = require('../../../shared/redis');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../shared/auth');

const app  = express();
const PORT = process.env.PORT || 8082;

app.use(helmet());
app.use(cors());
app.use(express.json());

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

async function getWeatherBonus(lat, lng) {
  // In prod: call weather API
  const hour = new Date().getHours();
  if (hour < 6 || hour > 20) return 'FOGGY';
  if (hour > 10 && hour < 15) return 'SUNNY';
  return 'CLOUDY';
}

async function spawnPokemonForPoint(spawnPointId, lat, lng, biome) {
  const spawnKey = `spawn:${spawnPointId}`;
  const existing = await getJSON(spawnKey);
  if (existing) return existing; // already active

  // Pick species based on biome + rarity weights
  const { rows: species } = await query(`
    SELECT id, rarity, type1 FROM pokemon_species
    WHERE ($1 = 'ANY' OR $1 = ANY(biomes) OR biomes IS NULL)
    ORDER BY random()
    LIMIT 50
  `, [biome]);

  if (!species.length) return null;

  // Weighted random selection
  let totalWeight = 0;
  const weighted = species.map(s => {
    const w = RARITY_WEIGHTS[s.rarity] || 10;
    totalWeight += w;
    return { ...s, weight: w };
  });

  let rand = Math.random() * totalWeight;
  let chosen = weighted[0];
  for (const s of weighted) {
    rand -= s.weight;
    if (rand <= 0) { chosen = s; break; }
  }

  const weather = await getWeatherBonus(lat, lng);
  const weatherBoosted = (WEATHER_BONUS[weather] || []).some(t => chosen.type1 === t);

  // Generate IVs
  const iv_attack  = Math.floor(Math.random() * 16);
  const iv_defense = Math.floor(Math.random() * 16);
  const iv_hp      = Math.floor(Math.random() * 16);

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

  const payload = { ...wild, spawnPointId };
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
  const { rows } = await query(`
    SELECT w.id, w.species_id, w.lat, w.lng, w.cp,
           w.is_shiny, w.weather_boosted, w.expires_at,
           p.name_zh, p.name_en, p.type1, p.type2, p.rarity, p.sprite_url
    FROM wild_pokemon w
    JOIN pokemon_species p ON p.id = w.species_id
    WHERE w.is_caught = false
      AND w.expires_at > NOW()
      AND ST_DWithin(
        w.location::geography,
        ST_SetSRID(ST_MakePoint($2,$1),4326)::geography,
        $3
      )
    ORDER BY w.expires_at DESC
    LIMIT 50
  `, [lat, lng, radius]);
  
  // Populate cache for future queries
  for (const w of rows) {
    await setJSON(`wild:${w.id}`, w, 1800);
  }
  
  return rows;
}

async function getNearbyWildCount(lat, lng, radius) {
  const { rows: [r] } = await query(`
    SELECT COUNT(*)::int FROM wild_pokemon
    WHERE is_caught=false AND expires_at > NOW()
      AND ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
  `, [lat, lng, radius]);
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

app.use(errorHandler);
app.listen(PORT, () => console.log(`[location-service] listening on :${PORT}`));
module.exports = app;
