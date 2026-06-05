// backend/services/user-service/src/handlers/catchHandler.js
'use strict';

const { createLogger } = require('../../../shared/logger');
const { query } = require('../../../shared/db');

const logger = createLogger('user-service-catch-handler');

/**
 * Handle catch success event
 * Updates user's bag count and stats
 */
async function handleCatchSuccess(event) {
  const { userId, pokemon, rewards, sessionId } = event.data;
  
  try {
    // Update user's total caught count
    await query(`
      UPDATE users SET
        total_caught = COALESCE(total_caught, 0) + 1,
        last_catch_at = NOW()
      WHERE id = $1
    `, [userId]);
    
    logger.info({
      userId,
      speciesId: pokemon.speciesId,
      sessionId,
    }, 'User stats updated after catch');
    
  } catch (err) {
    logger.error({ err, userId, sessionId }, 'Failed to handle catch success event');
    throw err;
  }
}

/**
 * Register catch event handlers
 */
function registerCatchHandlers(eventBus) {
  eventBus.subscribe('catch.events', async (event) => {
    // Only handle catch.success events
    if (event.type === 'catch.success') {
      await handleCatchSuccess(event);
    }
  }, {
    groupId: 'user-service-catch',
    maxRetries: 3,
    retryDelay: 1000,
  });
  
  logger.info('Catch event handlers registered');
}

module.exports = {
  handleCatchSuccess,
  registerCatchHandlers,
};
