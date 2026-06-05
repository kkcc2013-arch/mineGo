// backend/shared/events/index.js
'use strict';

/**
 * Event Types - Standard event definitions for mineGo
 */
const EventTypes = {
  // Catch related events
  CATCH_SUCCESS: 'catch.success',
  CATCH_FAILED: 'catch.failed',
  CATCH_SESSION_START: 'catch.session.start',
  CATCH_SESSION_END: 'catch.session.end',
  
  // Gym related events
  GYM_BATTLE_START: 'gym.battle.start',
  GYM_BATTLE_END: 'gym.battle.end',
  GYM_DEFEAT: 'gym.defeat',
  GYM_CAPTURED: 'gym.captured',
  
  // User related events
  USER_LEVEL_UP: 'user.level.up',
  USER_ACHIEVEMENT: 'user.achievement',
  USER_REGISTERED: 'user.registered',
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  
  // Social related events
  FRIEND_REQUEST: 'social.friend.request',
  FRIEND_ACCEPT: 'social.friend.accept',
  FRIEND_REMOVE: 'social.friend.remove',
  TRADE_INITIATED: 'social.trade.initiated',
  TRADE_COMPLETED: 'social.trade.completed',
  
  // Reward related events
  REWARD_GRANT: 'reward.grant',
  REWARD_CLAIMED: 'reward.claimed',
  
  // Pokemon related events
  POKEMON_EVOLVED: 'pokemon.evolved',
  POKEMON_TRANSFERRED: 'pokemon.transferred',
  POKEMON_POWERED_UP: 'pokemon.powered_up',
  
  // Payment related events
  PAYMENT_INITIATED: 'payment.initiated',
  PAYMENT_SUCCESS: 'payment.success',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',
  
  // Location related events
  LOCATION_UPDATE: 'location.update',
  WILD_SPAWNED: 'wild.spawned',
  WILD_DESPAWNED: 'wild.despawned',
};

/**
 * Create a standard event
 * @param {string} type - Event type
 * @param {object} data - Event data
 * @param {object} metadata - Additional metadata
 */
function createEvent(type, data, metadata = {}) {
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type,
    data,
    metadata,
    timestamp: new Date().toISOString(),
    version: '1.0',
  };
}

/**
 * Event builders for common events
 */
const EventBuilders = {
  catchSuccess(userId, pokemon, rewards, sessionId) {
    return createEvent(EventTypes.CATCH_SUCCESS, {
      userId,
      pokemon,
      rewards,
      sessionId,
      caughtAt: new Date().toISOString(),
    });
  },
  
  userLevelUp(userId, newLevel, xpEarned) {
    return createEvent(EventTypes.USER_LEVEL_UP, {
      userId,
      newLevel,
      xpEarned,
      leveledUpAt: new Date().toISOString(),
    });
  },
  
  userAchievement(userId, achievementId, value) {
    return createEvent(EventTypes.USER_ACHIEVEMENT, {
      userId,
      achievementId,
      value,
      achievedAt: new Date().toISOString(),
    });
  },
  
  rewardGrant(userId, rewards, reason) {
    return createEvent(EventTypes.REWARD_GRANT, {
      userId,
      rewards,
      reason,
      grantedAt: new Date().toISOString(),
    });
  },
  
  friendRequest(fromUserId, toUserId) {
    return createEvent(EventTypes.FRIEND_REQUEST, {
      fromUserId,
      toUserId,
      requestedAt: new Date().toISOString(),
    });
  },
  
  paymentSuccess(userId, orderId, amount, currency) {
    return createEvent(EventTypes.PAYMENT_SUCCESS, {
      userId,
      orderId,
      amount,
      currency,
      succeededAt: new Date().toISOString(),
    });
  },
};

/**
 * Topic names mapping
 */
const Topics = {
  CATCH: 'catch.events',
  GYM: 'gym.events',
  USER: 'user.events',
  SOCIAL: 'social.events',
  REWARD: 'reward.events',
  PAYMENT: 'payment.events',
  LOCATION: 'location.events',
};

module.exports = {
  EventTypes,
  createEvent,
  EventBuilders,
  Topics,
};
