/**
 * Catch Service - Distributed Lock Integration Example
 * 
 * Demonstrates use of distributed lock in Pokemon catching flow
 */

const { getDistributedLock } = require('../../../shared/distributedLock');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('catch-service');
const lock = getDistributedLock();

/**
 * Catch wild Pokemon with distributed lock protection
 * 
 * Prevents:
 * - Same Pokemon being caught by multiple players simultaneously
 * - Race conditions in catch logic
 * - Data inconsistency
 * 
 * @param {string} userId - User ID
 * @param {string} pokemonId - Wild Pokemon ID
 * @returns {Object} Catch result
 */
async function catchWildPokemon(userId, pokemonId) {
  try {
    // Use distributed lock with auto-extension for long operations
    const result = await lock.withLock(
      `pokemon:catch:${pokemonId}`,
      10000, // 10 second timeout
      {
        autoExtend: true,
        maxExtendCount: 5
      },
      async () => {
        // Step 1: Verify Pokemon exists and is active
        const pokemon = await query(
          'SELECT * FROM wild_pokemon WHERE id = $1 AND status = $2',
          [pokemonId, 'active']
        );
        
        if (!pokemon) {
          throw new AppError(4001, '精灵不存在或已被捕捉', 404);
        }
        
        // Step 2: Check user's catching capabilities
        const user = await query(
          'SELECT pokeball_count, level FROM users WHERE id = $1',
          [userId]
        );
        
        if (user.pokeball_count <= 0) {
          throw new AppError(4002, '精灵球数量不足', 400);
        }
        
        // Step 3: Calculate catch probability
        const catchProbability = calculateCatchProbability(pokemon, user);
        
        // Step 4: Perform catch attempt
        const caught = performCatchAttempt(catchProbability);
        
        if (caught) {
          // Step 5: Transfer Pokemon to user's collection
          await query(
            'UPDATE wild_pokemon SET status = $1, caught_by = $2, caught_at = $3 WHERE id = $4',
            ['caught', userId, new Date(), pokemonId]
          );
          
          await query(
            'INSERT INTO user_pokemon (user_id, pokemon_type, cp, hp, caught_at) VALUES ($1, $2, $3, $4, $5)',
            [userId, pokemon.type, pokemon.cp, pokemon.hp, new Date()]
          );
          
          // Step 6: Update user's pokeball count
          await query(
            'UPDATE users SET pokeball_count = pokeball_count - 1 WHERE id = $1',
            [userId]
          );
          
          logger.info({
            userId,
            pokemonId,
            pokemonType: pokemon.type,
            cp: pokemon.cp
          }, 'Pokemon caught successfully');
          
          return {
            success: true,
            pokemon: {
              type: pokemon.type,
              cp: pokemon.cp,
              hp: pokemon.hp
            }
          };
        } else {
          // Catch failed, Pokemon escaped
          await query(
            'UPDATE users SET pokeball_count = pokeball_count - 1 WHERE id = $1',
            [userId]
          );
          
          logger.info({
            userId,
            pokemonId,
            probability: catchProbability
          }, 'Catch attempt failed, Pokemon escaped');
          
          return {
            success: false,
            reason: 'escape',
            probability: catchProbability
          };
        }
      }
    );
    
    return result;
    
  } catch (err) {
    if (err.message.includes('Failed to acquire lock')) {
      // Lock conflict - Pokemon is being caught by another player
      logger.warn({
        userId,
        pokemonId
      }, 'Pokemon catch locked by another player');
      
      return {
        success: false,
        reason: 'locked',
        message: '精灵正在被其他玩家捕捉，请稍后重试',
        retryable: true
      };
    }
    
    throw err;
  }
}

/**
 * Attempt to catch Pokemon without blocking
 * 
 * @param {string} userId - User ID
 * @param {string} pokemonId - Wild Pokemon ID
 * @returns {Object|null} Catch result or null if locked
 */
async function tryCatchPokemon(userId, pokemonId) {
  // Try to acquire lock without blocking
  const lockObj = await lock.tryAcquire(`pokemon:catch:${pokemonId}`, 10000);
  
  if (!lockObj) {
    // Pokemon is being caught by another player
    return {
      success: false,
      reason: 'locked',
      message: '精灵正在被捕捉中'
    };
  }
  
  try {
    // Perform catch logic
    return await performCatchLogic(userId, pokemonId);
  } finally {
    // Always release lock
    await lock.release(lockObj);
  }
}

/**
 * Batch catch multiple Pokemon with sequential locking
 * 
 * @param {string} userId - User ID
 * @param {string[]} pokemonIds - Pokemon IDs to catch
 * @returns {Object[]} Catch results
 */
async function batchCatchPokemon(userId, pokemonIds) {
  const results = [];
  
  for (const pokemonId of pokemonIds) {
    try {
      // Try each Pokemon one at a time
      const result = await catchWildPokemon(userId, pokemonId);
      results.push(result);
      
      // If locked, skip and continue
      if (result.reason === 'locked') {
        continue;
      }
      
    } catch (err) {
      logger.error({
        userId,
        pokemonId,
        err: err.message
      }, 'Batch catch error for Pokemon');
      
      results.push({
        success: false,
        reason: 'error',
        pokemonId
      });
    }
  }
  
  return results;
}

/**
 * Check if Pokemon is currently being caught
 * 
 * @param {string} pokemonId - Pokemon ID
 * @returns {boolean} True if Pokemon is locked
 */
async function isPokemonBeingCaught(pokemonId) {
  return await lock.isLocked(`pokemon:catch:${pokemonId}`);
}

/**
 * Get estimated wait time for Pokemon catch
 * 
 * @param {string} pokemonId - Pokemon ID
 * @returns {number} Estimated wait time in seconds
 */
async function getCatchWaitTime(pokemonId) {
  const ttl = await lock.getTTL(`pokemon:catch:${pokemonId}`);
  
  if (ttl < 0) {
    return 0;
  }
  
  return Math.ceil(ttl / 1000);
}

module.exports = {
  catchWildPokemon,
  tryCatchPokemon,
  batchCatchPokemon,
  isPokemonBeingCaught,
  getCatchWaitTime
};