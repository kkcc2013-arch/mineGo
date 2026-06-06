/**
 * 缓存失效策略 - 事件驱动的缓存失效
 * 
 * REQ-00031: API 响应缓存层与缓存失效策略
 * 
 * 特性：
 * - 基于事件的自动失效
 * - 支持模式匹配批量失效
 * - 集成 EventBus 事件系统
 * - 支持手动失效
 */

const cache = require('./cache');
const { createLogger } = require('./logger');

const logger = createLogger('cache-invalidation');

// 失效规则配置
const invalidationRules = {
  // 用户相关
  'user.created': [
    'api:/users:list:*',
    'api:/users/stats:*'
  ],
  'user.updated': [
    'api:/users/:userId:*',
    'api:/users/:userId/profile:*',
    'api:/friends:*'
  ],
  'user.deleted': [
    'api:/users/:userId:*',
    'api:/friends:*'
  ],
  
  // 精灵相关
  'pokemon.caught': [
    'api:/pokemon/:userId:*',
    'api:/pokemon/:userId/inventory:*',
    'api:/users/:userId/stats:*'
  ],
  'pokemon.released': [
    'api:/pokemon/:userId:*',
    'api:/pokemon/:userId/inventory:*'
  ],
  'pokemon.evolved': [
    'api:/pokemon/:userId:*',
    'api:/pokemon/:pokemonId:*'
  ],
  'pokemon.transferred': [
    'api:/pokemon/:userId:*',
    'api:/pokemon/:userId/inventory:*'
  ],
  
  // 好友相关
  'friend.requested': [
    'api:/friends:*',
    'api:/friends/requests:*'
  ],
  'friend.added': [
    'api:/friends:*',
    'api:/friends/:userId:*',
    'api:/users/:userId/friends:*'
  ],
  'friend.removed': [
    'api:/friends:*',
    'api:/friends/:userId:*'
  ],
  
  // 道馆相关
  'gym.created': [
    'api:/gyms/nearby:*',
    'api:/gyms:list:*'
  ],
  'gym.captured': [
    'api:/gyms/nearby:*',
    'api:/gyms/:gymId:*',
    'api:/gyms/:gymId/details:*'
  ],
  'gym.defeated': [
    'api:/gyms/:gymId:*',
    'api:/gyms/:gymId/team:*'
  ],
  
  // Raid 相关
  'raid.started': [
    'api:/gyms/:gymId:*',
    'api:/raids:nearby:*',
    'api:/raids/:gymId:*'
  ],
  'raid.ended': [
    'api:/gyms/:gymId:*',
    'api:/raids:nearby:*',
    'api:/raids/:gymId:*'
  ],
  'raid.joined': [
    'api:/raids/:gymId:*',
    'api:/raids/:gymId/participants:*'
  ],
  
  // 道具相关
  'item.used': [
    'api:/items:*',
    'api:/inventory:*',
    'api:/users/:userId/items:*'
  ],
  'item.purchased': [
    'api:/items:*',
    'api:/inventory:*',
    'api:/users/:userId/items:*'
  ],
  'item.received': [
    'api:/items:*',
    'api:/inventory:*'
  ],
  
  // 奖励相关
  'reward.claimed': [
    'api:/rewards:*',
    'api:/rewards/available:*',
    'api:/users/:userId/rewards:*'
  ],
  
  // 支付相关
  'payment.completed': [
    'api:/users/:userId/items:*',
    'api:/users/:userId/purchases:*',
    'api:/inventory:*'
  ],
  
  // 捕捉相关
  'catch.success': [
    'api:/pokemon/:userId:*',
    'api:/users/:userId/stats:*',
    'api:/users/:userId/inventory:*'
  ],
  'catch.failed': [
    'api:/users/:userId/stats:*'
  ]
};

// 事件订阅器
let eventBus = null;
let isSubscribed = false;

/**
 * 初始化缓存失效系统
 * @param {Object} eventBusInstance - EventBus 实例
 */
function init(eventBusInstance) {
  if (!eventBusInstance) {
    logger.warn('EventBus not provided, event-driven invalidation disabled');
    return;
  }
  
  eventBus = eventBusInstance;
  
  // 订阅所有相关事件
  subscribeToEvents();
  
  logger.info('Cache invalidation system initialized');
}

/**
 * 订阅事件
 */
function subscribeToEvents() {
  if (isSubscribed || !eventBus) {
    return;
  }
  
  // 订阅所有定义的事件类型
  const eventTypes = Object.keys(invalidationRules);
  
  for (const eventType of eventTypes) {
    eventBus.subscribe(eventType, async (event) => {
      await handleInvalidation(eventType, event.data || event);
    });
  }
  
  isSubscribed = true;
  logger.info({ events: eventTypes.length }, 'Subscribed to invalidation events');
}

/**
 * 处理缓存失效事件
 * @param {string} event - 事件类型
 * @param {Object} data - 事件数据
 */
async function handleInvalidation(event, data) {
  const patterns = invalidationRules[event] || [];
  
  if (patterns.length === 0) {
    logger.debug({ event }, 'No invalidation rules for event');
    return;
  }
  
  logger.info({ event, patterns: patterns.length }, 'Processing cache invalidation');
  
  for (const pattern of patterns) {
    try {
      // 替换模式中的变量
      const concretePattern = resolvePattern(pattern, data);
      
      // 删除匹配的缓存
      await cache.delPattern(concretePattern);
      
      logger.debug({ event, pattern: concretePattern }, 'Cache invalidated');
    } catch (err) {
      logger.error({ err, event, pattern }, 'Invalidation failed');
    }
  }
}

/**
 * 解析模式中的变量
 * @param {string} pattern - 模式字符串
 * @param {Object} data - 数据对象
 * @returns {string} 解析后的模式
 */
function resolvePattern(pattern, data) {
  return pattern
    .replace(/:userId/g, data.userId || data.user_id || '*')
    .replace(/:pokemonId/g, data.pokemonId || data.pokemon_id || '*')
    .replace(/:gymId/g, data.gymId || data.gym_id || '*')
    .replace(/:friendId/g, data.friendId || data.friend_id || '*')
    .replace(/:itemId/g, data.itemId || data.item_id || '*');
}

/**
 * 手动触发缓存失效
 * @param {string} event - 事件类型
 * @param {Object} data - 事件数据
 */
async function invalidate(event, data) {
  await handleInvalidation(event, data);
}

/**
 * 按模式手动删除缓存
 * @param {string} pattern - 缓存键模式
 */
async function invalidatePattern(pattern) {
  try {
    await cache.delPattern(pattern);
    logger.info({ pattern }, 'Cache invalidated by pattern');
  } catch (err) {
    logger.error({ err, pattern }, 'Pattern invalidation failed');
    throw err;
  }
}

/**
 * 使特定用户的所有缓存失效
 * @param {string} userId - 用户 ID
 */
async function invalidateUser(userId) {
  const patterns = [
    `api:/users:${userId}:*`,
    `api:/pokemon:${userId}:*`,
    `api:/friends:*user:${userId}*`,
    `api:/items:*user:${userId}*`,
    `api:/inventory:*user:${userId}*`
  ];
  
  for (const pattern of patterns) {
    try {
      await cache.delPattern(pattern);
    } catch (err) {
      logger.error({ err, pattern }, 'User cache invalidation failed');
    }
  }
  
  logger.info({ userId }, 'User cache invalidated');
}

/**
 * 使特定道馆的所有缓存失效
 * @param {string} gymId - 道馆 ID
 */
async function invalidateGym(gymId) {
  const patterns = [
    `api:/gyms:${gymId}:*`,
    `api:/raids:${gymId}:*`
  ];
  
  for (const pattern of patterns) {
    try {
      await cache.delPattern(pattern);
    } catch (err) {
      logger.error({ err, pattern }, 'Gym cache invalidation failed');
    }
  }
  
  logger.info({ gymId }, 'Gym cache invalidated');
}

/**
 * 使所有附近查询缓存失效
 */
async function invalidateNearbyQueries() {
  try {
    await cache.delPattern('api:/gyms/nearby:*');
    await cache.delPattern('api:/pokemon/nearby:*');
    await cache.delPattern('api:/raids/nearby:*');
    
    logger.info('Nearby queries cache invalidated');
  } catch (err) {
    logger.error({ err }, 'Nearby queries invalidation failed');
  }
}

/**
 * 添加自定义失效规则
 * @param {string} event - 事件类型
 * @param {Array<string>} patterns - 失效模式列表
 */
function addInvalidationRule(event, patterns) {
  if (!invalidationRules[event]) {
    invalidationRules[event] = [];
  }
  
  invalidationRules[event].push(...patterns);
  
  // 如果 EventBus 已初始化，订阅新事件
  if (eventBus && !invalidationRules[event].subscribed) {
    eventBus.subscribe(event, async (e) => {
      await handleInvalidation(event, e.data || e);
    });
    invalidationRules[event].subscribed = true;
  }
  
  logger.info({ event, patterns }, 'Invalidation rule added');
}

/**
 * 移除失效规则
 * @param {string} event - 事件类型
 */
function removeInvalidationRule(event) {
  delete invalidationRules[event];
  logger.info({ event }, 'Invalidation rule removed');
}

/**
 * 获取所有失效规则
 * @returns {Object} 失效规则映射
 */
function getInvalidationRules() {
  return { ...invalidationRules };
}

/**
 * 批量失效多个事件
 * @param {Array<{event: string, data: Object}>} events - 事件列表
 */
async function batchInvalidate(events) {
  for (const { event, data } of events) {
    await handleInvalidation(event, data);
  }
  
  logger.info({ count: events.length }, 'Batch invalidation completed');
}

module.exports = {
  init,
  handleInvalidation,
  invalidate,
  invalidatePattern,
  invalidateUser,
  invalidateGym,
  invalidateNearbyQueries,
  addInvalidationRule,
  removeInvalidationRule,
  getInvalidationRules,
  batchInvalidate,
  invalidationRules
};
