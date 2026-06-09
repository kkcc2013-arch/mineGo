'use strict';

const { getDelayQueue } = require('../../../shared/DelayQueue');
const { createLogger } = require('../../../shared/logger');
const { incrementCounter } = require('../../../shared/metrics');

const logger = createLogger('raid-reward-handler');

/**
 * Initialize raid reward delay handler
 * Raid rewards are sent 5 minutes after raid ends
 */
async function initRaidRewardHandler() {
  const delayQueue = getDelayQueue({ clientId: 'gym-service' });
  
  await delayQueue.registerHandler('raid.reward', async (payload, task) => {
    logger.info({ raidId: payload.raidId }, 'Processing delayed raid reward');
    
    try {
      // Publish rewards to participants
      const result = await publishRaidRewards(payload.raidId, payload.participants);
      
      incrementCounter('raid_rewards_distributed_total', result.distributed, {
        raid_id: payload.raidId,
      });
      
      logger.info({ 
        raidId: payload.raidId, 
        participantCount: payload.participants.length,
        distributed: result.distributed,
      }, 'Raid rewards distributed');
      
    } catch (err) {
      logger.error({ 
        err, 
        raidId: payload.raidId,
      }, 'Failed to distribute raid rewards');
      throw err;
    }
  });
  
  logger.info('Raid reward delay handler initialized');
}

/**
 * Schedule raid reward for delayed distribution
 * @param {string} raidId - Raid ID
 * @param {Array} participants - List of participant user IDs
 * @param {number} delayMs - Delay in milliseconds (default 5 minutes)
 */
async function scheduleRaidReward(raidId, participants, delayMs = 5 * 60 * 1000) {
  const delayQueue = getDelayQueue({ clientId: 'gym-service' });
  
  const result = await delayQueue.schedule('raid.reward', {
    raidId,
    participants,
  }, {
    delay: delayMs,          // Default 5 minutes
    priority: 'high',        // High priority for rewards
    maxRetries: 10,          // Rewards are critical, more retries
    metadata: {
      scheduledAt: new Date().toISOString(),
      participantCount: participants.length,
    },
  });
  
  logger.info({ 
    raidId, 
    participantCount: participants.length,
    taskId: result.taskId,
    delayMs,
  }, 'Raid reward scheduled');
  
  return result;
}

/**
 * Publish raid rewards to participants
 * This would integrate with reward-service
 */
async function publishRaidRewards(raidId, participants) {
  // This is a placeholder - actual implementation would:
  // 1. Calculate rewards based on raid performance
  // 2. Call reward-service to distribute rewards
  // 3. Send notifications to participants
  
  const distributed = participants.length;
  
  // Simulate reward distribution
  logger.debug({ 
    raidId, 
    participants,
  }, 'Distributing rewards to participants');
  
  // In production, this would call:
  // await rewardService.distributeRaidRewards(raidId, participants);
  
  return { distributed, raidId };
}

/**
 * Cancel scheduled raid reward
 * @param {string} taskId - Task ID to cancel
 */
async function cancelRaidReward(taskId) {
  // Note: Full cancellation would require additional implementation
  // For now, we log the cancellation request
  logger.info({ taskId }, 'Raid reward cancellation requested');
  
  // In production, this would:
  // 1. Remove task from delay queue
  // 2. Update task status in database
}

module.exports = { 
  initRaidRewardHandler, 
  scheduleRaidReward,
  publishRaidRewards,
  cancelRaidReward,
};
