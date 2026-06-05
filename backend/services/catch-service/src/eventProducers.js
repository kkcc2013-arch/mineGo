// backend/services/catch-service/src/eventProducers.js
'use strict';

/**
 * Event Producers for catch-service
 * 
 * These functions publish events after catch operations
 * to decouple services through event-driven architecture.
 */

const { getEventBus } = require('../../../shared/EventBus');
const { EventTypes, EventBuilders, Topics } = require('../../../shared/events');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('catch-service-events');

/**
 * Publish catch success event
 * This event will be consumed by:
 * - user-service: Add pokemon to user's bag
 * - reward-service: Grant rewards
 * - social-service: Send notifications
 */
async function publishCatchSuccess(userId, pokemon, rewards, sessionId) {
  try {
    const eventBus = getEventBus({ clientId: 'catch-service' });
    await eventBus.connect();
    
    const event = EventBuilders.catchSuccess(userId, pokemon, rewards, sessionId);
    
    await eventBus.publish(Topics.CATCH, event);
    
    logger.info({
      userId,
      speciesId: pokemon.speciesId,
      sessionId,
      eventId: event.id,
    }, 'Catch success event published');
    
    return event;
  } catch (err) {
    logger.error({ err, userId, sessionId }, 'Failed to publish catch success event');
    // Don't throw - event publishing should not block the main flow
    return null;
  }
}

/**
 * Publish catch failed event
 */
async function publishCatchFailed(userId, speciesId, reason, sessionId) {
  try {
    const eventBus = getEventBus({ clientId: 'catch-service' });
    await eventBus.connect();
    
    const event = {
      ...EventBuilders.catchSuccess(userId, { speciesId }, { xp: 25 }, sessionId),
      type: EventTypes.CATCH_FAILED,
      data: {
        userId,
        speciesId,
        reason,
        sessionId,
        failedAt: new Date().toISOString(),
      },
    };
    
    await eventBus.publish(Topics.CATCH, event);
    
    logger.info({ userId, speciesId, sessionId, reason }, 'Catch failed event published');
    
    return event;
  } catch (err) {
    logger.error({ err, userId, sessionId }, 'Failed to publish catch failed event');
    return null;
  }
}

/**
 * Publish catch session end event
 */
async function publishCatchSessionEnd(userId, sessionId, result, stats) {
  try {
    const eventBus = getEventBus({ clientId: 'catch-service' });
    await eventBus.connect();
    
    const event = {
      type: EventTypes.CATCH_SESSION_END,
      data: {
        userId,
        sessionId,
        result,
        stats,
        endedAt: new Date().toISOString(),
      },
    };
    
    await eventBus.publish(Topics.CATCH, event);
    
    logger.info({ userId, sessionId, result }, 'Catch session end event published');
    
    return event;
  } catch (err) {
    logger.error({ err, userId, sessionId }, 'Failed to publish catch session end event');
    return null;
  }
}

module.exports = {
  publishCatchSuccess,
  publishCatchFailed,
  publishCatchSessionEnd,
};
