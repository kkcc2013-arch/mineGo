// user-service/src/handlers/notificationHandler.js
// Handle events from other services and create notifications - REQ-00026
'use strict';

const { createLogger } = require('../../../../shared/logger');
const { createNotification, NOTIFICATION_TYPES } = require('../routes/notifications');

const logger = createLogger('notification-handler');

/**
 * Initialize notification event handlers
 * @param {EventBus} eventBus - EventBus instance
 */
function initNotificationHandlers(eventBus) {
  if (!eventBus) {
    logger.warn('EventBus not available, notification handlers not initialized');
    return;
  }

  // ── Rare Spawn Notification ────────────────────────────────
  eventBus.subscribe('pokemon.rare_spawn', async (event) => {
    try {
      const { speciesId, speciesName, lat, lng, rarity, nearbyUsers, expiresAt } = event.data;
      
      logger.info({ speciesId, speciesName, nearbyUsersCount: nearbyUsers?.length }, 
        'Processing rare spawn notification');
      
      // Send notification to all nearby users
      if (nearbyUsers && Array.isArray(nearbyUsers)) {
        for (const userId of nearbyUsers) {
          await createNotification(userId, NOTIFICATION_TYPES.RARE_SPAWN, {
            speciesId,
            speciesName,
            distance: event.data.distances?.[userId] || 0,
            lat,
            lng,
            rarity,
            expireAt: expiresAt,
          });
        }
      }
    } catch (err) {
      logger.error({ err, event }, 'Failed to handle rare spawn event');
    }
  });

  // ── Raid Started Notification ──────────────────────────────
  eventBus.subscribe('raid.started', async (event) => {
    try {
      const { raidId, gymId, gymName, bossSpeciesId, bossName, tier, lat, lng, expiresAt, nearbyUsers } = event.data;
      
      logger.info({ raidId, gymId, bossName, nearbyUsersCount: nearbyUsers?.length }, 
        'Processing raid started notification');
      
      // Send notification to all nearby users
      if (nearbyUsers && Array.isArray(nearbyUsers)) {
        for (const userId of nearbyUsers) {
          await createNotification(userId, NOTIFICATION_TYPES.RAID_STARTED, {
            raidId,
            gymId,
            gymName,
            bossSpeciesId,
            bossName,
            tier,
            lat,
            lng,
            expiresAt,
          });
        }
      }
    } catch (err) {
      logger.error({ err, event }, 'Failed to handle raid started event');
    }
  });

  // ── Friend Request Notification ────────────────────────────
  eventBus.subscribe('friend.request_created', async (event) => {
    try {
      const { toUserId, fromUserId, fromUserName } = event.data;
      
      logger.info({ toUserId, fromUserId }, 'Processing friend request notification');
      
      await createNotification(toUserId, NOTIFICATION_TYPES.FRIEND_REQUEST, {
        fromUserId,
        fromUserName,
      });
    } catch (err) {
      logger.error({ err, event }, 'Failed to handle friend request event');
    }
  });

  // ── Gift Received Notification ─────────────────────────────
  eventBus.subscribe('social.gift_sent', async (event) => {
    try {
      const { toUserId, fromUserId, fromUserName, giftId } = event.data;
      
      logger.info({ toUserId, fromUserId, giftId }, 'Processing gift received notification');
      
      await createNotification(toUserId, NOTIFICATION_TYPES.GIFT_RECEIVED, {
        fromUserId,
        fromUserName,
        giftId,
      });
    } catch (err) {
      logger.error({ err, event }, 'Failed to handle gift sent event');
    }
  });

  // ── Quest Complete Notification ────────────────────────────
  eventBus.subscribe('reward.quest_completed', async (event) => {
    try {
      const { userId, questId, questName, rewards } = event.data;
      
      logger.info({ userId, questId, questName }, 'Processing quest complete notification');
      
      await createNotification(userId, NOTIFICATION_TYPES.QUEST_COMPLETE, {
        questId,
        questName,
        rewards,
      });
    } catch (err) {
      logger.error({ err, event }, 'Failed to handle quest complete event');
    }
  });

  // ── Gym Under Attack Notification ──────────────────────────
  eventBus.subscribe('gym.under_attack', async (event) => {
    try {
      const { gymId, gymName, attackerTeam, defenderUserIds } = event.data;
      
      logger.info({ gymId, gymName, attackerTeam, defenderCount: defenderUserIds?.length }, 
        'Processing gym under attack notification');
      
      // Send notification to all defenders
      if (defenderUserIds && Array.isArray(defenderUserIds)) {
        for (const userId of defenderUserIds) {
          await createNotification(userId, NOTIFICATION_TYPES.GYM_UNDER_ATTACK, {
            gymId,
            gymName,
            attackerTeam,
          });
        }
      }
    } catch (err) {
      logger.error({ err, event }, 'Failed to handle gym under attack event');
    }
  });

  // ── Gym Lost Notification ──────────────────────────────────
  eventBus.subscribe('gym.lost', async (event) => {
    try {
      const { gymId, gymName, newTeam, previousDefenderUserIds } = event.data;
      
      logger.info({ gymId, gymName, newTeam, defenderCount: previousDefenderUserIds?.length }, 
        'Processing gym lost notification');
      
      // Send notification to all previous defenders
      if (previousDefenderUserIds && Array.isArray(previousDefenderUserIds)) {
        for (const userId of previousDefenderUserIds) {
          await createNotification(userId, NOTIFICATION_TYPES.GYM_LOST, {
            gymId,
            gymName,
            newTeam,
          });
        }
      }
    } catch (err) {
      logger.error({ err, event }, 'Failed to handle gym lost event');
    }
  });

  logger.info('Notification event handlers initialized');
}

module.exports = {
  initNotificationHandlers,
};
