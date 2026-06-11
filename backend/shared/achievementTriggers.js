/**
 * REQ-00076: 精灵成就系统与里程碑奖励
 * 成就触发器集成模块
 * 
 * 该模块负责将成就系统集成到现有的游戏事件流中
 */

'use strict';

const achievementService = require('../services/pokemon-service/src/achievementService');
const { createLogger } = require('./logger');

const logger = createLogger('achievement-triggers');

/**
 * 成就触发器映射配置
 * 定义游戏事件与成就触发事件的对应关系
 */
const ACHIEVEMENT_TRIGGERS = {
  // 捕捉类成就触发器
  'pokemon.caught': {
    eventType: 'catch_count',
    extractData: (event) => ({
      count: 1,
      pokemon_id: event.pokemonId,
      species_id: event.speciesId,
      is_new_species: event.isNewSpecies || false,
      is_shiny: event.isShiny || false,
      rarity: event.rarity
    })
  },
  
  'pokemon.shiny_caught': {
    eventType: 'shiny_catch',
    extractData: (event) => ({
      count: 1,
      pokemon_id: event.pokemonId,
      species_id: event.speciesId,
      is_shiny: true
    })
  },
  
  // 战斗类成就触发器
  'battle.won': {
    eventType: 'battle_win',
    extractData: (event) => ({
      win: true,
      battle_type: event.battleType, // 'gym', 'pvp', 'raid'
      opponent_level: event.opponentLevel
    })
  },
  
  'gym.conquered': {
    eventType: 'gym_conquer',
    extractData: (event) => ({
      gym_id: event.gymId,
      gym_level: event.gymLevel
    })
  },
  
  // 社交类成就触发器
  'trade.completed': {
    eventType: 'trade_count',
    extractData: (event) => ({
      trade_id: event.tradeId,
      partner_id: event.partnerId
    })
  },
  
  'friend.added': {
    eventType: 'friend_count',
    extractData: (event) => ({ count: 1 })
  },
  
  // 培育类成就触发器
  'pokemon.bred': {
    eventType: 'pokemon_breed',
    extractData: (event) => ({
      species_id: event.speciesId,
      is_shiny: event.isShiny || false,
      is_perfect_iv: event.isPerfectIV || false
    })
  },
  
  'egg.hatched': {
    eventType: 'egg_hatch',
    extractData: (event) => ({
      species_id: event.speciesId,
      distance: event.eggDistance
    })
  },
  
  // 探索类成就触发器
  'location.distance_update': {
    eventType: 'distance_traveled',
    extractData: (event) => ({
      distance: event.distanceKm
    })
  },
  
  'pokestop.visited': {
    eventType: 'pokestop_visit',
    extractData: (event) => ({ count: 1 })
  },
  
  // 特殊成就触发器
  'pokemon.lucky_encounter': {
    eventType: 'lucky_catch',
    extractData: (event) => ({
      count: 1,
      pokemon_id: event.pokemonId
    })
  }
};

/**
 * 初始化成就触发器
 * 订阅 EventBus 中的相关事件
 */
function initAchievementTriggers() {
  try {
    const { EventBus } = require('./EventBus');
    
    if (!EventBus) {
      logger.warn('EventBus not available, achievement triggers will not be initialized');
      return;
    }
    
    // 订阅所有相关事件
    Object.keys(ACHIEVEMENT_TRIGGERS).forEach(eventName => {
      EventBus.subscribe(eventName, async (event) => {
        try {
          const trigger = ACHIEVEMENT_TRIGGERS[eventName];
          const eventData = trigger.extractData(event);
          
          await achievementService.processEvent(
            event.userId || event.user_id,
            trigger.eventType,
            eventData
          );
        } catch (error) {
          logger.error({ error, eventName, event }, 'Failed to process achievement trigger');
        }
      });
    });
    
    logger.info(`Initialized ${Object.keys(ACHIEVEMENT_TRIGGERS).length} achievement triggers`);
  } catch (error) {
    logger.error({ error }, 'Failed to initialize achievement triggers');
  }
}

/**
 * 手动触发成就事件
 * 供无法通过 EventBus 触发的场景使用
 */
async function triggerAchievementEvent(userId, eventName, eventData) {
  try {
    const trigger = ACHIEVEMENT_TRIGGERS[eventName];
    
    if (!trigger) {
      logger.warn({ eventName }, 'Unknown achievement trigger event');
      return { success: false, error: 'Unknown trigger event' };
    }
    
    const extractedData = trigger.extractData(eventData);
    const results = await achievementService.processEvent(userId, trigger.eventType, extractedData);
    
    return {
      success: true,
      achievementsCompleted: results.length,
      achievements: results
    };
  } catch (error) {
    logger.error({ error, userId, eventName }, 'Failed to manually trigger achievement event');
    return { success: false, error: error.message };
  }
}

/**
 * 获取所有可用的触发事件类型
 */
function getAvailableTriggers() {
  return Object.keys(ACHIEVEMENT_TRIGGERS).map(eventName => ({
    eventName,
    eventType: ACHIEVEMENT_TRIGGERS[eventName].eventType
  }));
}

/**
 * 批量触发成就事件
 * 用于数据迁移或补偿场景
 */
async function batchTriggerAchievementEvents(events) {
  const results = [];
  
  for (const event of events) {
    try {
      const result = await triggerAchievementEvent(event.userId, event.eventName, event.eventData);
      results.push({ ...event, result });
    } catch (error) {
      results.push({ ...event, result: { success: false, error: error.message } });
    }
  }
  
  return results;
}

module.exports = {
  initAchievementTriggers,
  triggerAchievementEvent,
  getAvailableTriggers,
  batchTriggerAchievementEvents,
  ACHIEVEMENT_TRIGGERS
};
