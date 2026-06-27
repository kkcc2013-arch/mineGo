/**
 * REQ-00076: Achievement Triggers Integration
 * Created: 2026-06-27 05:00 UTC
 */

'use strict';

const { achievementService } = require('../services/pokemon-service/src/achievementService');
const { createLogger } = require('./logger');

const logger = createLogger('achievement-triggers');

// 成就触发器映射
const ACHIEVEMENT_TRIGGERS = {
  // 捕捉类事件
  'pokemon.caught': {
    eventType: 'catch_count',
    extractData: (event) => ({
      count: 1,
      pokemon_id: event.pokemonId,
      species_id: event.speciesId,
      is_new_species: event.isNewSpecies || false,
      is_shiny: event.isShiny || false,
      rarity: event.rarity,
      is_lucky: event.isLucky || false,
      is_night: event.isNight || false,
      catch_time: event.catchTime
    })
  },
  
  // 战斗类事件
  'battle.won': {
    eventType: 'battle_win',
    extractData: (event) => ({
      win: true,
      battle_type: event.battleType, // 'gym', 'pvp', 'raid'
      opponent_level: event.opponentLevel,
      pokemon_used: event.pokemonUsed
    })
  },
  
  'gym.conquered': {
    eventType: 'gym_conquer',
    extractData: (event) => ({
      count: 1,
      gym_id: event.gymId,
      gym_level: event.gymLevel,
      team_id: event.teamId
    })
  },
  
  // 社交类事件
  'trade.completed': {
    eventType: 'trade_count',
    extractData: (event) => ({
      count: 1,
      trade_id: event.tradeId,
      partner_id: event.partnerId,
      pokemon_traded: event.pokemonTraded
    })
  },
  
  'friend.added': {
    eventType: 'friend_count',
    extractData: (event) => ({
      count: 1,
      friend_id: event.friendId
    })
  },
  
  // 培育类事件
  'pokemon.bred': {
    eventType: 'pokemon_breed',
    extractData: (event) => ({
      count: 1,
      species_id: event.speciesId,
      is_shiny: event.isShiny || false,
      parent_ids: event.parentIds
    })
  },
  
  'egg.hatched': {
    eventType: 'egg_hatch',
    extractData: (event) => ({
      count: 1,
      species_id: event.speciesId,
      egg_distance: event.eggDistance,
      is_shiny: event.isShiny || false
    })
  },
  
  // 探索类事件
  'distance.traveled': {
    eventType: 'distance_traveled',
    extractData: (event) => ({
      distance: event.distanceKm || event.distance,
      start_location: event.startLocation,
      end_location: event.endLocation
    })
  },
  
  'pokestop.visited': {
    eventType: 'pokestop_visit',
    extractData: (event) => ({
      count: 1,
      pokestop_id: event.pokestopId,
      items_received: event.itemsReceived
    })
  }
};

/**
 * 处理成就触发事件
 */
async function handleAchievementTrigger(eventName, event) {
  const trigger = ACHIEVEMENT_TRIGGERS[eventName];
  
  if (!trigger) {
    logger.warn({ eventName }, 'Unknown achievement trigger event');
    return;
  }
  
  try {
    const eventData = trigger.extractData(event);
    const userId = event.userId || event.user_id;
    
    if (!userId) {
      logger.warn({ eventName, event }, 'Missing userId in achievement trigger event');
      return;
    }
    
    const results = await achievementService.processEvent(userId, trigger.eventType, eventData);
    
    if (results.length > 0) {
      logger.info({ userId, eventName, unlockedCount: results.length }, 'Achievements unlocked');
    }
    
    return results;
  } catch (error) {
    logger.error({ err: error, eventName, event }, 'Failed to handle achievement trigger');
  }
}

/**
 * 初始化成就触发器订阅
 */
function initAchievementTriggers(eventBus) {
  if (!eventBus) {
    logger.warn('EventBus not available, achievement triggers not initialized');
    return;
  }
  
  Object.keys(ACHIEVEMENT_TRIGGERS).forEach(eventName => {
    eventBus.subscribe(eventName, async (event) => {
      await handleAchievementTrigger(eventName, event);
    });
  });
  
  logger.info({ triggers: Object.keys(ACHIEVEMENT_TRIGGERS) }, 'Achievement triggers initialized');
}

/**
 * 手动触发成就事件（用于测试或特殊情况）
 */
async function triggerAchievement(userId, eventName, eventData) {
  return await handleAchievementTrigger(eventName, {
    userId,
    ...eventData
  });
}

module.exports = {
  ACHIEVEMENT_TRIGGERS,
  handleAchievementTrigger,
  initAchievementTriggers,
  triggerAchievement
};