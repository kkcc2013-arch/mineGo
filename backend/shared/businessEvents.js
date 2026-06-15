/**
 * backend/shared/businessEvents.js
 * 业务事件类型定义与分类体系
 * 
 * @module businessEvents
 * @description 统一的业务事件类型定义，8 大类 50+ 事件类型
 */

const EVENT_CATEGORIES = {
  USER: 'user',
  CATCH: 'catch',
  GYM: 'gym',
  TRADE: 'trade',
  PAYMENT: 'payment',
  SOCIAL: 'social',
  ITEM: 'item',
  PVP: 'pvp'
};

const EVENT_TYPES = {
  // 1. 用户行为
  USER: {
    REGISTER: 'user.register',
    LOGIN: 'user.login',
    LOGOUT: 'user.logout',
    LEVEL_UP: 'user.level_up',
    ACHIEVEMENT_UNLOCK: 'user.achievement_unlock',
    PROFILE_UPDATE: 'user.profile_update',
    SETTINGS_CHANGE: 'user.settings_change',
    SESSION_START: 'user.session_start',
    SESSION_END: 'user.session_end'
  },
  
  // 2. 精灵捕捉
  CATCH: {
    ATTEMPT: 'catch.attempt',
    SUCCESS: 'catch.success',
    FAIL: 'catch.fail',
    ESCAPE: 'catch.escape',
    CRITICAL: 'catch.critical',  // 暴击捕捉
    BERRY_USE: 'catch.berry_use',
    BALL_THROW: 'catch.ball_throw'
  },
  
  // 3. 道馆战斗
  GYM: {
    RAID_START: 'gym.raid_start',
    RAID_WIN: 'gym.raid_win',
    RAID_FAIL: 'gym.raid_fail',
    BATTLE_WIN: 'gym.battle_win',
    BATTLE_FAIL: 'gym.battle_fail',
    GYM_CAPTURE: 'gym.gym_capture',
    GYM_DEPOSIT: 'gym.gym_deposit',
    GYM_FEED: 'gym.gym_feed'
  },
  
  // 4. 精灵交易
  TRADE: {
    INITIATE: 'trade.initiate',
    COMPLETE: 'trade.complete',
    CANCEL: 'trade.cancel',
    STARDUST_EXCHANGE: 'trade.stardust_exchange',
    MARKET_LIST: 'trade.market_list',
    MARKET_BUY: 'trade.market_buy'
  },
  
  // 5. 支付
  PAYMENT: {
    ORDER_CREATE: 'payment.order_create',
    ORDER_SUCCESS: 'payment.order_success',
    ORDER_FAIL: 'payment.order_fail',
    REFUND: 'payment.refund',
    SUBSCRIPTION_START: 'payment.subscription_start',
    SUBSCRIPTION_CANCEL: 'payment.subscription_cancel'
  },
  
  // 6. 社交互动
  SOCIAL: {
    FRIEND_ADD: 'social.friend_add',
    FRIEND_REMOVE: 'social.friend_remove',
    GIFT_SEND: 'social.gift_send',
    GIFT_OPEN: 'social.gift_open',
    GUILD_JOIN: 'social.guild_join',
    GUILD_LEAVE: 'social.guild_leave',
    GUILD_CREATE: 'social.guild_create',
    CHAT_SEND: 'social.chat_send'
  },
  
  // 7. 道具使用
  ITEM: {
    USE: 'item.use',
    PURCHASE: 'item.purchase',
    REWARD: 'item.reward',
    EVOLVE: 'item.evolve',
    UPGRADE: 'item.upgrade',
    SELL: 'item.sell'
  },
  
  // 8. PVP 对战
  PVP: {
    MATCH_START: 'pvp.match_start',
    MATCH_END: 'pvp.match_end',
    RANK_CHANGE: 'pvp.rank_change',
    LEAGUE_JOIN: 'pvp.league_join',
    BATTLE_REWARD: 'pvp.battle_reward'
  }
};

/**
 * 获取事件类别
 * @param {string} eventType - 事件类型
 * @returns {string} 事件类别
 */
function getEventCategory(eventType) {
  const parts = eventType.split('.');
  return parts[0] || 'unknown';
}

/**
 * 验证事件类型是否有效
 * @param {string} eventType - 事件类型
 * @returns {boolean}
 */
function isValidEventType(eventType) {
  for (const category of Object.values(EVENT_TYPES)) {
    if (Object.values(category).includes(eventType)) {
      return true;
    }
  }
  return false;
}

/**
 * 获取所有事件类型列表
 * @returns {string[]}
 */
function getAllEventTypes() {
  const types = [];
  for (const category of Object.values(EVENT_TYPES)) {
    types.push(...Object.values(category));
  }
  return types;
}

/**
 * 获取某类别下所有事件类型
 * @param {string} category - 事件类别
 * @returns {string[]}
 */
function getEventTypesByCategory(category) {
  const upperCategory = category.toUpperCase();
  if (EVENT_TYPES[upperCategory]) {
    return Object.values(EVENT_TYPES[upperCategory]);
  }
  return [];
}

module.exports = {
  EVENT_CATEGORIES,
  EVENT_TYPES,
  getEventCategory,
  isValidEventType,
  getAllEventTypes,
  getEventTypesByCategory
};
