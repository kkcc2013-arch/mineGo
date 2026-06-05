// shared/tokenCleanup.js - Token Blacklist Cleanup Job
'use strict';

const { createLogger } = require('./logger');
const { getJwtBlacklist } = require('./JwtBlacklist');

const logger = createLogger('token-cleanup');

/**
 * Run token blacklist cleanup
 * Should be called periodically (e.g., every hour)
 * @param {number} batchSize - Number of users to process per run
 * @returns {Promise<object>}
 */
async function runCleanup(batchSize = 100) {
  logger.info('Starting token blacklist cleanup');
  
  try {
    const blacklist = getJwtBlacklist();
    const stats = await blacklist.cleanupExpiredTokens(batchSize);
    
    logger.info(stats, 'Token cleanup completed');
    return stats;
  } catch (err) {
    logger.error({ err }, 'Token cleanup failed');
    throw err;
  }
}

/**
 * Schedule cleanup job using setInterval
 * @param {number} intervalMs - Interval in milliseconds (default: 1 hour)
 * @returns {NodeJS.Timeout}
 */
function scheduleCleanup(intervalMs = 3600000) {
  logger.info({ intervalMs }, 'Scheduling token cleanup job');
  
  // Run immediately on start
  runCleanup().catch(err => {
    logger.error({ err }, 'Initial cleanup failed');
  });
  
  // Schedule periodic runs
  const timer = setInterval(() => {
    runCleanup().catch(err => {
      logger.error({ err }, 'Scheduled cleanup failed');
    });
  }, intervalMs);
  
  return timer;
}

/**
 * Create cleanup job for integration with existing cron system
 * Can be called from a dedicated cron endpoint or external scheduler
 */
async function cleanupJobHandler() {
  const startTime = Date.now();
  
  try {
    const stats = await runCleanup();
    const duration = Date.now() - startTime;
    
    return {
      success: true,
      duration,
      ...stats
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    
    return {
      success: false,
      duration,
      error: err.message
    };
  }
}

module.exports = {
  runCleanup,
  scheduleCleanup,
  cleanupJobHandler
};
