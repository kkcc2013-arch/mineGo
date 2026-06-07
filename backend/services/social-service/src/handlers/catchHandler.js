// backend/services/social-service/src/handlers/catchHandler.js
'use strict';

const { createLogger } = require('../../../../shared/logger');
const { getRedis } = require('../../../../shared/redis');

const logger = createLogger('social-service-catch-handler');

/**
 * Handle catch success event
 * Send notification to user's friends
 */
async function handleCatchSuccess(event) {
  const { userId, pokemon, rewards, sessionId } = event.data;
  
  try {
    // Check if it's a rare or shiny pokemon (worth notifying friends)
    const shouldNotify = pokemon.isShiny || pokemon.cp > 2000;
    
    if (!shouldNotify) {
      logger.debug({ userId, speciesId: pokemon.speciesId }, 'Pokemon catch not noteworthy, skipping notification');
      return;
    }
    
    // Get user's friends
    // TODO: Implement friend notification when social graph is ready
    // For now, just log the event
    logger.info({
      userId,
      speciesId: pokemon.speciesId,
      pokemonName: pokemon.name,
      cp: pokemon.cp,
      isShiny: pokemon.isShiny,
    }, 'Noteworthy pokemon caught');
    
    // In the future, this would push to friends' feeds:
    // await publishToFriendFeeds(userId, {
    //   type: 'catch_success',
    //   pokemon,
    //   timestamp: event.timestamp,
    // });
    
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
    groupId: 'social-service-catch',
    maxRetries: 3,
    retryDelay: 1000,
  });
  
  logger.info('Catch event handlers registered');
}

module.exports = {
  handleCatchSuccess,
  registerCatchHandlers,
};
