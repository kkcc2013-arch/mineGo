// user-service/src/handlers/notificationHandler.js
// Handle events from other services and create notifications - REQ-00026
'use strict';

const { createLogger } = require('../../../../shared/logger');
const db = require('../../../../shared/db');
const center = require('../../../../shared/notificationCenter');

// EventBus（Kafka，生产未启用）事件 → 站内消息（shared/notificationCenter，REQ-00261）。
// 好友请求、礼物由数据库触发器 + 成就引擎生成消息，这里不再重复生成（映射为 null）。
const NOTIFICATION_TYPES = {
  RARE_SPAWN: (d) => ({ type: 'pokemon.nearby_rare', templateKey: 'spawn_rare', category: 'pokemon', priority: 'high',
    params: { pokemon_name: d.speciesName, distance: `${Math.round(d.distance || 0)}m` }, data: d,
    actionUrl: '/map', dedupeKey: `spawn:${d.speciesId}:${d.expireAt || ''}`, expiresInDays: 1 }),
  RAID_STARTED: (d) => ({ type: 'event.raid_starting', templateKey: 'raid_nearby', category: 'event', priority: 'high',
    params: { pokemon_name: d.bossName, time_left: d.expiresAt || '' }, data: d, actionUrl: `/raids/${d.raidId}`,
    dedupeKey: `raid:${d.raidId}`, expiresInDays: 1 }),
  FRIEND_REQUEST: null,
  GIFT_RECEIVED: null,
  QUEST_COMPLETE: (d) => ({ type: 'reward.quest_complete', category: 'reward', title: '任务完成',
    body: `${d.questName || '每日任务'} 已完成，快去领取奖励`, data: d, actionUrl: '/rewards/quests', dedupeKey: `quest:${d.questId}` }),
  GYM_UNDER_ATTACK: (d) => ({ type: 'event.gym_under_attack', category: 'event', priority: 'high', title: '道馆遭到攻击',
    body: `${d.gymName || '你守护的道馆'} 正在被 ${d.attackerTeam || '其他队伍'} 攻击`, data: d, actionUrl: `/gyms/${d.gymId}` }),
  GYM_LOST: (d) => ({ type: 'event.gym_lost', category: 'event', priority: 'normal', title: '道馆失守',
    body: `${d.gymName || '你守护的道馆'} 已被 ${d.newTeam || '其他队伍'} 占领`, data: d, actionUrl: `/gyms/${d.gymId}` }),
};

async function createNotification(userId, build, data) {
  if (!build || !userId) return;
  await center.notify(db, userId, build(data || {}));
}

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
