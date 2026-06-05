// catch-service/src/index.js
'use strict';
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../../../shared/db');
const { getRedis, getJSON, setJSON } = require('../../../shared/redis');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../shared/auth');
const { createLogger, requestLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { validateLocation, checkRateLimit, requireTrustScore, TRUST_SCORE } = require('../../../shared/anti-cheat');
const { publishCatchSuccess, publishCatchFailed } = require('./eventProducers');

const logger = createLogger('catch-service');
const SERVICE_NAME = 'catch-service';

const app  = express();
const PORT = process.env.PORT || 8084;

app.use(helmet()); app.use(cors()); app.use(express.json());

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'catch-service' }));

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
// CATCH MECHANICS
// ============================================================

// Throw rating bonus multiplier
const THROW_BONUS = { MISS: 0, NICE: 1.3, GREAT: 1.5, EXCELLENT: 1.7 };
const BALL_MULT   = { POKE_BALL: 1.0, GREAT_BALL: 1.5, ULTRA_BALL: 2.0, MASTER_BALL: Infinity };
const BERRY_MULT  = { NONE: 1.0, RAZZ_BERRY: 1.5, GOLDEN_RAZZ_BERRY: 2.5 };
const CURVE_BONUS = 1.1;

/**
 * Calculate catch probability.
 * Formula from SAD: P = 1 - (1 - baseCatchRate/(2*cpModifier))^(ballMult*berryMult*throwBonus)
 */
function calcCatchProb({ baseCatchRate, cp, ballType, throwRating, isCurve, berryUsed }) {
  if (ballType === 'MASTER_BALL') return 1.0;

  const cpModifier = Math.max(1.0, 1 + (cp / 2500));
  const base       = baseCatchRate / (2 * cpModifier);
  const throwB     = THROW_BONUS[throwRating] || 1.0;
  const curveB     = isCurve ? CURVE_BONUS : 1.0;
  const exponent   = BALL_MULT[ballType] * BERRY_MULT[berryUsed || 'NONE'] * throwB * curveB;

  return Math.min(0.99, 1 - Math.pow(Math.max(0, 1 - base), exponent));
}

/**
 * Calculate flee probability.
 */
function calcFleeProb({ baseFleeRate, ballsThrown }) {
  const patience = Math.max(0, 1 - ballsThrown * 0.05);
  return Math.min(0.9, baseFleeRate * patience);
}

// ── POST /catch/session ──────────────────────────────────────
app.post('/catch/session', requireAuth, validateLocation, checkRateLimit('CATCH'), async (req, res, next) => {
  try {
    const { spawnId, playerLat, playerLng } = req.body;
    if (!spawnId) throw new AppError(1001, 'spawnId 必填', 400);

    const userId = req.user.sub;

    // Verify wild pokemon exists and not caught
    const { rows: [wild] } = await query(`
      SELECT w.id, w.species_id, w.cp, w.iv_attack, w.iv_defense, w.iv_hp,
             w.is_shiny, w.weather_boosted, w.expires_at, w.lat, w.lng,
             p.name_zh, p.base_catch_rate, p.base_flee_rate, p.rarity
      FROM wild_pokemon w
      JOIN pokemon_species p ON p.id = w.species_id
      WHERE w.id = $1 AND w.is_caught = false AND w.expires_at > NOW()
    `, [spawnId]);

    if (!wild) throw new AppError(3001, '精灵已消失或被捕获', 404);

    // Distance check (must be within 100m)
    if (playerLat && playerLng) {
      const dist = haversineM(wild.lat, wild.lng, playerLat, playerLng);
      if (dist > 150) throw new AppError(3002, '距离太远，请靠近精灵', 400);
    }

    // Create session
    const { rows: [session] } = await query(`
      INSERT INTO catch_sessions (user_id, wild_pokemon_id)
      VALUES ($1, $2) RETURNING id
    `, [userId, spawnId]);

    // Cache session state
    await setJSON(`catch:session:${session.id}`, {
      userId, wildId: spawnId,
      speciesId: wild.species_id,
      cp: wild.cp, iv_attack: wild.iv_attack, iv_defense: wild.iv_defense, iv_hp: wild.iv_hp,
      isShiny: wild.is_shiny, weatherBoosted: wild.weather_boosted,
      baseCatchRate: parseFloat(wild.base_catch_rate),
      baseFleeRate: parseFloat(wild.base_flee_rate),
      rarity: wild.rarity, name_zh: wild.name_zh,
      ballsThrown: 0,
    }, 120); // 2 min session TTL

    res.json(successResp({
      sessionId: session.id,
      pokemon: {
        pokemonId: wild.species_id, name_zh: wild.name_zh,
        cp: wild.cp, isShiny: wild.is_shiny, weatherBoosted: wild.weather_boosted,
        rarity: wild.rarity,
      },
      catchRate: calcCatchProb({
        baseCatchRate: parseFloat(wild.base_catch_rate),
        cp: wild.cp, ballType: 'POKE_BALL', throwRating: 'NICE', isCurve: false,
      }),
      expireAt: new Date(Date.now() + 120000).toISOString(),
    }));
  } catch (err) { next(err); }
});

// ── POST /catch/throw ─────────────────────────────────────────
app.post('/catch/throw', requireAuth, checkRateLimit('CATCH'), async (req, res, next) => {
  try {
    const { sessionId, ballType, throwRating, isCurve, berryUsed } = req.body;
    if (!sessionId || !ballType || !throwRating) {
      throw new AppError(1001, 'sessionId, ballType, throwRating 必填', 400);
    }

    const userId = req.user.sub;
    const session = await getJSON(`catch:session:${sessionId}`);
    if (!session) throw new AppError(3003, '捕捉会话已过期', 400);
    if (session.userId !== userId) throw new AppError(1004, '无权操作', 403);

    // Verify ball availability
    const ballCol = {
      POKE_BALL: 'pokeball_count', GREAT_BALL: 'greatball_count',
      ULTRA_BALL: 'ultraball_count', MASTER_BALL: 'masterball_count',
    }[ballType];
    if (!ballCol) throw new AppError(3004, '无效球种', 400);

    const { rows: [inv] } = await query(`SELECT ${ballCol} FROM users WHERE id=$1`, [userId]);
    if (inv[ballCol] <= 0) throw new AppError(3005, '精灵球不足', 400);

    // Calculate probabilities
    const catchProb = calcCatchProb({
      baseCatchRate: session.baseCatchRate,
      cp: session.cp, ballType, throwRating,
      isCurve: isCurve || false,
      berryUsed: berryUsed || 'NONE',
    });

    if (throwRating === 'MISS') {
      // Deduct ball, no catch attempt
      await query(`UPDATE users SET ${ballCol}=${ballCol}-1 WHERE id=$1`, [userId]);
      session.ballsThrown++;
      await setJSON(`catch:session:${sessionId}`, session, 120);

      await query(`INSERT INTO catch_throws (session_id,ball_type,throw_rating,is_curve,berry_used,catch_prob,success)
                   VALUES ($1,$2,$3,$4,$5,$6,false)`,
        [sessionId, ballType, throwRating, isCurve||false, berryUsed||'NONE', catchProb]);

      return res.json(successResp({ result: 'MISS', catchProb }));
    }

    const caught = Math.random() < catchProb;

    // Deduct ball
    await query(`UPDATE users SET ${ballCol}=${ballCol}-1 WHERE id=$1`, [userId]);
    session.ballsThrown++;

    // Record throw
    await query(`INSERT INTO catch_throws (session_id,ball_type,throw_rating,is_curve,berry_used,catch_prob,success)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [sessionId, ballType, throwRating, isCurve||false, berryUsed||'NONE', catchProb, caught]);

    if (caught) {
      const rewards = await handleCatch(userId, session, throwRating, isCurve, sessionId);
      await getRedis().del(`catch:session:${sessionId}`);
      return res.json(successResp({ result: 'CAUGHT', catchProb, ...rewards }));
    }

    // Check flee
    const fleePct = calcFleeProb({ baseFleeRate: session.baseFleeRate, ballsThrown: session.ballsThrown });
    const fled    = session.ballsThrown >= 5 && Math.random() < fleePct;

    if (fled) {
      await query(`UPDATE catch_sessions SET ended_at=NOW(), result='FLED', balls_used=$2 WHERE id=$1`,
        [sessionId, session.ballsThrown]);
      await query('UPDATE wild_pokemon SET is_caught=true WHERE id=$1', [session.wildId]); // mark as gone
      await getRedis().del(`catch:session:${sessionId}`);
      metrics.catchAttemptsTotal.inc({ result: 'escaped' });
      logger.info({ userId, speciesId: session.speciesId, ballsThrown: session.ballsThrown }, 'Pokemon fled');
      
      // Publish catch failed event (async, non-blocking)
      publishCatchFailed(userId, session.speciesId, 'FLED', sessionId).catch(err =>
        logger.error({ err }, 'Failed to publish catch failed event')
      );
      
      return res.json(successResp({ result: 'FLED', catchProb, rewards: { xp: 25 } }));
    }

    await setJSON(`catch:session:${sessionId}`, session, 120);
    res.json(successResp({ result: 'BALL_USED', catchProb, ballsThrown: session.ballsThrown }));
  } catch (err) { next(err); }
});

async function handleCatch(userId, session, throwRating, isCurve, sessionId) {
  const XP_BY_RATING = { NICE: 120, GREAT: 170, EXCELLENT: 200 };
  const baseXp = XP_BY_RATING[throwRating] || 100;
  const xp = baseXp + (isCurve ? 10 : 0) + (session.isShiny ? 500 : 0);
  const stardust = 100;
  const candy    = 3;

  const result = await transaction(async (client) => {
    // REQ-00019: Get random moves from learnset
    const { rows: learnset } = await client.query(`
      SELECT move_id, m.category 
      FROM pokemon_moves pm
      JOIN moves m ON pm.move_id = m.id
      WHERE pm.species_id = $1 AND pm.learn_method IN ('TM', 'LEVEL_UP')
    `, [session.speciesId]);
    
    const fastMoves = learnset.filter(m => m.category === 'FAST');
    const chargeMoves = learnset.filter(m => m.category === 'CHARGE');
    
    // Random fast move (default to TACKLE if none available)
    const randomFast = fastMoves.length > 0 
      ? fastMoves[Math.floor(Math.random() * fastMoves.length)].move_id 
      : 'TACKLE';
    
    // Random charge move (default to STRUGGLE if none available)
    const randomCharge = chargeMoves.length > 0 
      ? chargeMoves[Math.floor(Math.random() * chargeMoves.length)].move_id 
      : 'STRUGGLE';
    
    // Create pokemon instance with initial moves
    const { rows: [instance] } = await client.query(`
      INSERT INTO pokemon_instances
        (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp,
         is_shiny, is_lucky, caught_lat, caught_lng, fast_move, charge_move,
         learned_fast_moves, learned_charge_moves)
      SELECT $1,$2,$3,$4,$4,$5,$6,$7,$8,false,
             (SELECT last_lat FROM users WHERE id=$1),
             (SELECT last_lng FROM users WHERE id=$1),
             $9, $10, ARRAY[$9], ARRAY[$10]
      RETURNING id
    `, [userId, session.speciesId, session.cp, Math.floor(session.cp * 0.8),
        session.iv_attack, session.iv_defense, session.iv_hp, session.isShiny,
        randomFast, randomCharge]);

    // Reward user
    await client.query(`
      UPDATE users SET
        xp = xp + $2, stardust = stardust + $3
      WHERE id = $1
    `, [userId, xp, stardust]);

    // Add candy
    await client.query(`
      INSERT INTO candy_inventory (user_id, species_id, amount)
      VALUES ($1,$2,$3)
      ON CONFLICT (user_id, species_id) DO UPDATE SET amount = candy_inventory.amount + $3
    `, [userId, session.speciesId, candy]);

    // Update pokedex
    await client.query(`
      INSERT INTO pokedex_entries (user_id, species_id, seen_count, caught_count, first_caught_at, best_cp)
      VALUES ($1,$2,1,1,NOW(),$3)
      ON CONFLICT (user_id, species_id) DO UPDATE SET
        caught_count = pokedex_entries.caught_count + 1,
        best_cp = GREATEST(pokedex_entries.best_cp, $3),
        has_shiny = pokedex_entries.has_shiny OR $4
    `, [userId, session.speciesId, session.cp, session.isShiny]);

    // Mark wild as caught
    await client.query('UPDATE wild_pokemon SET is_caught=true, caught_by=$1 WHERE id=$2',
      [userId, session.wildId]);

    // Close session
    await client.query(`
      UPDATE catch_sessions SET ended_at=NOW(), result='CAUGHT', balls_used=$2,
        instance_id=$3, xp_earned=$4, stardust_earned=$5, candy_earned=$6
      WHERE id=$7
    `, [userId, session.ballsThrown, instance.id, xp, stardust, candy, session.wildId]);

    // Update catch achievement
    await client.query(`
      INSERT INTO user_achievements (user_id, achievement_id, current_value, updated_at)
      VALUES ($1, 'catch_total', 1, NOW())
      ON CONFLICT (user_id, achievement_id) DO UPDATE SET
        current_value = user_achievements.current_value + 1, updated_at = NOW()
    `, [userId]);

    // Invalidate cache in location-service
    invalidateWildCache(session.wildId).catch(err => 
      logger.error({ err, wildId: session.wildId }, 'Failed to invalidate wild pokemon cache')
    );

    // Record catch success metric
    metrics.catchAttemptsTotal.inc({ result: 'success' });
    logger.info({
      userId,
      speciesId: session.speciesId,
      speciesName: session.name_zh,
      cp: session.cp,
      isShiny: session.isShiny,
      xp,
      stardust,
      candy,
    }, 'Pokemon caught');

    return {
      pokemonInstanceId: instance.id,
      pokemon: {
        speciesId: session.speciesId,
        name: session.name_zh,
        cp: session.cp,
        isShiny: session.isShiny,
        iv: {
          attack: session.iv_attack,
          defense: session.iv_defense,
          hp: session.iv_hp,
        },
      },
      rewards: { xp, stardust, candy },
    };
  });

  // Publish catch success event (async, non-blocking)
  // Event consumers: user-service (update bag), reward-service (grant rewards), 
  // social-service (send notifications), etc.
  publishCatchSuccess(userId, result.pokemon, result.rewards, sessionId).catch(err =>
    logger.error({ err }, 'Failed to publish catch success event')
  );

  return result;
}

// Invalidate wild pokemon cache in location-service
async function invalidateWildCache(wildId) {
  const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://localhost:8082';
  const response = await fetch(`${LOCATION_SERVICE_URL}/cache/wild/${wildId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${process.env.INTERNAL_SERVICE_TOKEN || 'internal-service-token'}`
    }
  });
  
  if (!response.ok) {
    throw new Error(`Cache invalidation failed: ${response.status}`);
  }
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

app.use(errorHandler);
app.listen(PORT, () => logger.info({ port: PORT }, 'Catch service started'));
module.exports = app;
