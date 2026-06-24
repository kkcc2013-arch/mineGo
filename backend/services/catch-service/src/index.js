// catch-service/src/index.js
// REQ-00169: 微服务启动器统一化 - 使用 ServiceFactory 重构
'use strict';

const { ServiceFactory } = require('../../../shared/ServiceFactory');
const { query, transactionManager } = require('../../../shared/db');
const { transactionSerializable } = transactionManager;
const { getRedis, getJSON, setJSON } = require('../../../shared/redis');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { validateLocation, checkRateLimit, requireTrustScore, TRUST_SCORE } = require('../../../shared/anti-cheat');
const { publishCatchSuccess, publishCatchFailed } = require('./eventProducers');

// ============================================================
// CATCH MECHANICS CONSTANTS
// ============================================================

const THROW_BONUS = { MISS: 0, NICE: 1.3, GREAT: 1.5, EXCELLENT: 1.7 };
const BALL_MULT   = { POKE_BALL: 1.0, GREAT_BALL: 1.5, ULTRA_BALL: 2.0, MASTER_BALL: Infinity };
const BERRY_MULT  = { NONE: 1.0, RAZZ_BERRY: 1.5, GOLDEN_RAZZ_BERRY: 2.5 };
const CURVE_BONUS = 1.1;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

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

/**
 * Haversine distance calculation
 */
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * Invalidate wild pokemon cache in location-service
 */
async function invalidateWildCache(wildId) {
  const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://localhost:8082';
  const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
  if (!INTERNAL_TOKEN) {
    throw new Error('INTERNAL_SERVICE_TOKEN is not set');
  }
  const response = await fetch(`${LOCATION_SERVICE_URL}/cache/wild/${wildId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${INTERNAL_TOKEN}` }
  });
  if (!response.ok) {
    throw new Error(`Cache invalidation failed: ${response.status}`);
  }
}

/**
 * Handle successful catch
 */
async function handleCatch(userId, session, throwRating, isCurve, sessionId, logger) {
  const XP_BY_RATING = { NICE: 120, GREAT: 170, EXCELLENT: 200 };
  const baseXp = XP_BY_RATING[throwRating] || 100;
  const xp = baseXp + (isCurve ? 10 : 0) + (session.isShiny ? 500 : 0);
  const stardust = 100;
  const candy    = 3;

  const result = await transactionSerializable(async (client) => {
    // REQ-00019: Get random moves from learnset
    const { rows: learnset } = await client.query(`
      SELECT move_id, m.category
      FROM pokemon_moves pm
      JOIN moves m ON pm.move_id = m.id
      WHERE pm.species_id = $1 AND pm.learn_method IN ('TM', 'LEVEL_UP')
    `, [session.speciesId]);

    const fastMoves   = learnset.filter(m => m.category === 'FAST');
    const chargeMoves = learnset.filter(m => m.category === 'CHARGE');

    const randomFast = fastMoves.length > 0
      ? fastMoves[Math.floor(Math.random() * fastMoves.length)].move_id
      : 'TACKLE';

    const randomCharge = chargeMoves.length > 0
      ? chargeMoves[Math.floor(Math.random() * chargeMoves.length)].move_id
      : 'STRUGGLE';

    // Create pokemon instance
    const { rows: [instance] } = await client.query(`
      INSERT INTO pokemon_instances
        (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp,
         is_shiny, is_lucky, is_zero_iv, is_perfect_iv, caught_lat, caught_lng, fast_move, charge_move,
         learned_fast_moves, learned_charge_moves)
      SELECT $1,$2,$3,$4,$4,$5,$6,$7,$8,false,$9,$10,
             (SELECT last_lat FROM users WHERE id=$1),
             (SELECT last_lng FROM users WHERE id=$1),
             $11, $12, ARRAY[$11], ARRAY[$12]
      RETURNING id
    `, [userId, session.speciesId, session.cp, Math.floor(session.cp * 0.8),
        session.iv_attack, session.iv_defense, session.iv_hp, session.isShiny,
        session.isZeroIv || false, session.isPerfectIv || false,
        randomFast, randomCharge]);

    // Reward user
    await client.query(`
      UPDATE users SET xp = xp + $2, stardust = stardust + $3 WHERE id = $1
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

    return {
      pokemonInstanceId: instance.id,
      pokemon: {
        speciesId: session.speciesId,
        name:      session.name_zh,
        cp:        session.cp,
        isShiny:   session.isShiny,
        iv: {
          attack:  session.iv_attack,
          defense: session.iv_defense,
          hp:      session.iv_hp,
        },
      },
      rewards: { xp, stardust, candy },
    };
  });

  // Invalidate cache in location-service (non-blocking)
  invalidateWildCache(session.wildId).catch(err =>
    logger.error({ err, wildId: session.wildId }, 'Failed to invalidate wild pokemon cache')
  );

  // Publish catch success event (non-blocking)
  publishCatchSuccess(userId, result.pokemon, result.rewards, sessionId).catch(err =>
    logger.error({ err }, 'Failed to publish catch success event')
  );

  return result;
}

// ============================================================
// ROUTE HANDLERS
// ============================================================

/**
 * POST /catch/session - Create catch session
 */
async function createCatchSession(req, res, next) {
  const logger = req.app.locals.logger;
  try {
    const { spawnId, playerLat, playerLng } = req.body;
    if (!spawnId) throw new AppError(1001, 'spawnId 必填', 400);

    const userId = req.user.sub;

    // Verify wild pokemon exists and not caught
    const { rows: [wild] } = await query(`
      SELECT w.id, w.species_id, w.cp, w.iv_attack, w.iv_defense, w.iv_hp,
             w.is_shiny, w.weather_boosted, w.expires_at, w.lat, w.lng,
             w.is_zero_iv, w.is_perfect_iv,
             p.name_zh, p.base_catch_rate, p.base_flee_rate, p.rarity
      FROM wild_pokemon w
      JOIN pokemon_species p ON p.id = w.species_id
      WHERE w.id = $1 AND w.is_caught = false AND w.expires_at > NOW()
    `, [spawnId]);

    if (!wild) throw new AppError(3001, '精灵已消失或被捕获', 404);

    // FIX: Distance check is now MANDATORY — missing coords are rejected outright.
    // Previously `if (playerLat && playerLng)` allowed callers to bypass the check
    // entirely by omitting coordinates.
    // Distance threshold aligned with spec: 100m (was 150m in code, comment said 100m).
    if (playerLat == null || playerLng == null) {
      throw new AppError(1001, '缺少定位坐标，请开启位置权限', 400);
    }
    const dist = haversineM(wild.lat, wild.lng, playerLat, playerLng);
    if (dist > 100) throw new AppError(3002, '距离太远，请靠近精灵（需在100米内）', 400);

    // Create session
    const { rows: [session] } = await query(`
      INSERT INTO catch_sessions (user_id, wild_pokemon_id)
      VALUES ($1, $2) RETURNING id
    `, [userId, spawnId]);

    // Cache session state (2 min TTL)
    await setJSON(`catch:session:${session.id}`, {
      userId, wildId: spawnId,
      speciesId:    wild.species_id,
      cp:           wild.cp,
      iv_attack:    wild.iv_attack,
      iv_defense:   wild.iv_defense,
      iv_hp:        wild.iv_hp,
      isShiny:      wild.is_shiny,
      weatherBoosted: wild.weather_boosted,
      isZeroIv:     wild.is_zero_iv,
      isPerfectIv:  wild.is_perfect_iv,
      baseCatchRate: parseFloat(wild.base_catch_rate),
      baseFleeRate:  parseFloat(wild.base_flee_rate),
      rarity:   wild.rarity,
      name_zh:  wild.name_zh,
      ballsThrown: 0,
    }, 120);

    res.json(successResp({
      sessionId: session.id,
      pokemon: {
        pokemonId:      wild.species_id,
        name_zh:        wild.name_zh,
        cp:             wild.cp,
        isShiny:        wild.is_shiny,
        weatherBoosted: wild.weather_boosted,
        rarity:         wild.rarity,
      },
      catchRate: calcCatchProb({
        baseCatchRate: parseFloat(wild.base_catch_rate),
        cp: wild.cp, ballType: 'POKE_BALL', throwRating: 'NICE', isCurve: false,
      }),
      expireAt: new Date(Date.now() + 120000).toISOString(),
    }));
  } catch (err) { next(err); }
}

/**
 * POST /catch/throw - Execute catch throw
 */
async function executeCatchThrow(req, res, next) {
  const logger  = req.app.locals.logger;
  const metrics = req.app.locals.metrics;

  try {
    const { sessionId, ballType, throwRating, isCurve, berryUsed } = req.body;
    if (!sessionId || !ballType || !throwRating) {
      throw new AppError(1001, 'sessionId, ballType, throwRating 必填', 400);
    }

    const userId  = req.user.sub;
    const session = await getJSON(`catch:session:${sessionId}`);
    if (!session) throw new AppError(3003, '捕捉会话已过期', 400);
    if (session.userId !== userId) throw new AppError(1004, '无权操作', 403);

    // Validate ball type
    const ballCol = {
      POKE_BALL:   'pokeball_count',
      GREAT_BALL:  'greatball_count',
      ULTRA_BALL:  'ultraball_count',
      MASTER_BALL: 'masterball_count',
    }[ballType];
    if (!ballCol) throw new AppError(3004, '无效球种', 400);

    // FIX: Atomic ball deduction — replaces the previous two-step SELECT+UPDATE
    // which was vulnerable to a race condition: two concurrent requests could both
    // read balance > 0 and both decrement, resulting in a negative balance.
    // The atomic UPDATE returns rowCount=0 if balance was already 0, which is
    // used as the "insufficient balls" signal.
    const { rowCount } = await query(
      `UPDATE users SET ${ballCol} = ${ballCol} - 1 WHERE id = $1 AND ${ballCol} > 0`,
      [userId]
    );
    if (rowCount === 0) throw new AppError(3005, '精灵球不足', 400);

    // Calculate probabilities
    const catchProb = calcCatchProb({
      baseCatchRate: session.baseCatchRate,
      cp:       session.cp,
      ballType,
      throwRating,
      isCurve:  isCurve  || false,
      berryUsed: berryUsed || 'NONE',
    });

    if (throwRating === 'MISS') {
      // Ball already deducted atomically above
      session.ballsThrown++;
      await setJSON(`catch:session:${sessionId}`, session, 120);

      await query(
        `INSERT INTO catch_throws (session_id,ball_type,throw_rating,is_curve,berry_used,catch_prob,success)
         VALUES ($1,$2,$3,$4,$5,$6,false)`,
        [sessionId, ballType, throwRating, isCurve||false, berryUsed||'NONE', catchProb]
      );

      return res.json(successResp({ result: 'MISS', catchProb }));
    }

    const caught = Math.random() < catchProb;

    // Ball already deducted atomically above
    session.ballsThrown++;

    // Record throw
    await query(
      `INSERT INTO catch_throws (session_id,ball_type,throw_rating,is_curve,berry_used,catch_prob,success)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [sessionId, ballType, throwRating, isCurve||false, berryUsed||'NONE', catchProb, caught]
    );

    if (caught) {
      const rewards = await handleCatch(userId, session, throwRating, isCurve, sessionId, logger);
      await getRedis().del(`catch:session:${sessionId}`);
      metrics.catchAttemptsTotal.inc({ result: 'success' });
      logger.info({
        userId,
        speciesId:   session.speciesId,
        speciesName: session.name_zh,
        cp:          session.cp,
        isShiny:     session.isShiny,
        ...rewards.rewards,
      }, 'Pokemon caught');
      return res.json(successResp({ result: 'CAUGHT', catchProb, ...rewards }));
    }

    // Check flee
    const fleePct = calcFleeProb({ baseFleeRate: session.baseFleeRate, ballsThrown: session.ballsThrown });
    const fled    = session.ballsThrown >= 5 && Math.random() < fleePct;

    if (fled) {
      await query(
        `UPDATE catch_sessions SET ended_at=NOW(), result='FLED', balls_used=$2 WHERE id=$1`,
        [sessionId, session.ballsThrown]
      );
      await query('UPDATE wild_pokemon SET is_caught=true WHERE id=$1', [session.wildId]);
      await getRedis().del(`catch:session:${sessionId}`);
      metrics.catchAttemptsTotal.inc({ result: 'escaped' });
      logger.info({ userId, speciesId: session.speciesId, ballsThrown: session.ballsThrown }, 'Pokemon fled');

      publishCatchFailed(userId, session.speciesId, 'FLED', sessionId).catch(err =>
        logger.error({ err }, 'Failed to publish catch failed event')
      );

      return res.json(successResp({ result: 'FLED', catchProb, rewards: { xp: 25 } }));
    }

    await setJSON(`catch:session:${sessionId}`, session, 120);
    res.json(successResp({ result: 'BALL_USED', catchProb, ballsThrown: session.ballsThrown }));
  } catch (err) { next(err); }
}

// ============================================================
// MAIN ENTRY - ServiceFactory
// ============================================================

async function main() {
  const { app, logger } = await ServiceFactory.createService({
    name: 'catch-service',
    port: process.env.PORT || 8084,
    options: {
      checkDb:    true,
      checkRedis: true,
      trustProxy: true
    },
    postInit: async (app, logger) => {
      app.locals.logger  = logger;
      app.locals.metrics = require('../../../shared/metrics');

      app.post('/catch/session', requireAuth, validateLocation, checkRateLimit('CATCH'), createCatchSession);
      app.post('/catch/throw',   requireAuth, checkRateLimit('CATCH'), executeCatchThrow);

      logger.info('Catch service routes initialized');
    }
  });
}

if (require.main === module) {
  main().catch(err => {
    console.error('Failed to start catch-service:', err);
    process.exit(1);
  });
}

module.exports = { createCatchSession, executeCatchThrow };
