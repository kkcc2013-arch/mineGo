// backend/services/pokemon-service/src/staminaService.js
// 精灵体力系统服务 - REQ-00172

'use strict';

const { db } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { cache, CacheKeys } = require('../../../shared/cache');
const { promClient } = require('../../../shared/metrics');

const logger = createLogger('stamina-service');

// ============================================================
// Prometheus Metrics
// ============================================================

const metrics = {
  staminaConsumed: new promClient.Counter({
    name: 'minego_stamina_consumed_total',
    help: 'Total stamina consumed',
    labelNames: ['activity_type', 'service']
  }),
  staminaRecovered: new promClient.Counter({
    name: 'minego_stamina_recovered_total',
    help: 'Total stamina recovered',
    labelNames: ['source', 'service']
  }),
  restStationUsage: new promClient.Gauge({
    name: 'minego_rest_station_usage',
    help: 'Current usage of rest stations',
    labelNames: ['station_id', 'station_name']
  }),
  fatigueDistribution: new promClient.Gauge({
    name: 'minego_pokemon_fatigue_level',
    help: 'Pokemon fatigue level distribution',
    labelNames: ['fatigue_level']
  })
};

// ============================================================
// 疲劳等级配置
// ============================================================

const FATIGUE_LEVELS = {
  fresh: { 
    min: 80, 
    battleBonus: 1.0, 
    catchBonus: 1.0, 
    expBonus: 1.0,
    label: '精力充沛',
    color: '#4CAF50'
  },
  normal: { 
    min: 50, 
    battleBonus: 1.0, 
    catchBonus: 1.0, 
    expBonus: 1.0,
    label: '状态正常',
    color: '#8BC34A'
  },
  tired: { 
    min: 20, 
    battleBonus: 0.85, 
    catchBonus: 0.9, 
    expBonus: 0.95,
    label: '有些疲惫',
    color: '#FF9800'
  },
  exhausted: { 
    min: 0, 
    battleBonus: 0.6, 
    catchBonus: 0.7, 
    expBonus: 0.8,
    label: '精疲力竭',
    color: '#F44336'
  }
};

// 自然恢复速率（每分钟）
const NATURAL_RECOVERY_RATE = 1;
const CACHE_TTL_SECONDS = 30;

// ============================================================
// StaminaService Class
// ============================================================

class StaminaService {
  
  /**
   * 获取精灵当前体力状态
   */
  async getStaminaStatus(pokemonId, userId) {
    const cacheKey = CacheKeys.stamina(pokemonId);
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const pokemon = await db('pokemon')
      .where({ id: pokemonId, user_id: userId })
      .select('id', 'max_stamina', 'current_stamina', 'last_stamina_update', 'fatigue_level')
      .first();

    if (!pokemon) {
      throw new Error('Pokemon not found');
    }

    // 计算自然恢复
    const now = new Date();
    const lastUpdate = new Date(pokemon.last_stamina_update);
    const minutesPassed = Math.floor((now - lastUpdate) / 60000);
    
    let recoveredStamina = 0;
    if (minutesPassed > 0 && pokemon.current_stamina < pokemon.max_stamina) {
      recoveredStamina = Math.min(
        minutesPassed * NATURAL_RECOVERY_RATE,
        pokemon.max_stamina - pokemon.current_stamina
      );
      
      // 异步更新数据库（不阻塞请求）
      this._updateStaminaAsync(pokemonId, recoveredStamina);
    }

    const currentStamina = pokemon.current_stamina + recoveredStamina;
    const fatigueLevel = this.calculateFatigueLevel(currentStamina, pokemon.max_stamina);
    const fatigueEffects = FATIGUE_LEVELS[fatigueLevel];

    const status = {
      pokemonId: pokemon.id,
      maxStamina: pokemon.max_stamina,
      currentStamina,
      staminaPercentage: Math.round((currentStamina / pokemon.max_stamina) * 100),
      fatigueLevel,
      fatigueLabel: fatigueEffects.label,
      fatigueColor: fatigueEffects.color,
      battleBonus: fatigueEffects.battleBonus,
      catchBonus: fatigueEffects.catchBonus,
      expBonus: fatigueEffects.expBonus,
      lastUpdate: now.toISOString(),
      naturalRecoveryRate: NATURAL_RECOVERY_RATE,
      isLowStamina: currentStamina < pokemon.max_stamina * 0.3
    };

    await cache.set(cacheKey, status, CACHE_TTL_SECONDS);
    return status;
  }

  /**
   * 批量获取精灵体力状态
   */
  async getBatchStaminaStatus(pokemonIds, userId) {
    if (!Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      return [];
    }

    const pokemons = await db('pokemon')
      .whereIn('id', pokemonIds)
      .andWhere({ user_id: userId })
      .select('id', 'max_stamina', 'current_stamina', 'last_stamina_update', 'fatigue_level');

    const now = new Date();
    
    return pokemons.map(pokemon => {
      const lastUpdate = new Date(pokemon.last_stamina_update);
      const minutesPassed = Math.floor((now - lastUpdate) / 60000);
      
      let recoveredStamina = 0;
      if (minutesPassed > 0 && pokemon.current_stamina < pokemon.max_stamina) {
        recoveredStamina = Math.min(
          minutesPassed * NATURAL_RECOVERY_RATE,
          pokemon.max_stamina - pokemon.current_stamina
        );
      }

      const currentStamina = pokemon.current_stamina + recoveredStamina;
      const fatigueLevel = this.calculateFatigueLevel(currentStamina, pokemon.max_stamina);
      const fatigueEffects = FATIGUE_LEVELS[fatigueLevel];

      return {
        pokemonId: pokemon.id,
        maxStamina: pokemon.max_stamina,
        currentStamina,
        staminaPercentage: Math.round((currentStamina / pokemon.max_stamina) * 100),
        fatigueLevel,
        fatigueLabel: fatigueEffects.label,
        battleBonus: fatigueEffects.battleBonus,
        catchBonus: fatigueEffects.catchBonus
      };
    });
  }

  /**
   * 消耗体力
   */
  async consumeStamina(pokemonId, activityType, userId, options = {}) {
    const { skipCheck = false, metadata = {} } = options;

    // 获取活动消耗配置
    const config = await db('stamina_config')
      .where({ activity_type: activityType })
      .first();

    if (!config) {
      logger.warn({ activityType }, 'Unknown activity type for stamina consumption');
      return { success: true, staminaConsumed: 0, message: 'Activity does not consume stamina' };
    }

    const status = await this.getStaminaStatus(pokemonId, userId);
    
    if (status.currentStamina < config.stamina_cost && !skipCheck) {
      return { 
        success: false, 
        error: 'Insufficient stamina',
        currentStamina: status.currentStamina,
        required: config.stamina_cost
      };
    }

    const staminaBefore = status.currentStamina;
    const newStamina = Math.max(0, status.currentStamina - config.stamina_cost);
    const newFatigueLevel = this.calculateFatigueLevel(newStamina, status.maxStamina);

    await db('pokemon')
      .where({ id: pokemonId })
      .update({
        current_stamina: newStamina,
        fatigue_level: newFatigueLevel,
        last_stamina_update: new Date()
      });

    // 记录历史
    await db('stamina_history').insert({
      user_id: userId,
      pokemon_id: pokemonId,
      activity_type: activityType,
      stamina_change: -config.stamina_cost,
      stamina_before: staminaBefore,
      stamina_after: newStamina,
      source: 'activity',
      metadata: JSON.stringify(metadata)
    });

    // 清除缓存
    await cache.del(CacheKeys.stamina(pokemonId));

    // 记录指标
    metrics.staminaConsumed.inc({ activity_type: activityType, service: 'pokemon-service' });

    logger.info({
      pokemonId,
      activityType,
      staminaConsumed: config.stamina_cost,
      remainingStamina: newStamina,
      fatigueLevel: newFatigueLevel
    }, 'Stamina consumed');

    return {
      success: true,
      staminaConsumed: config.stamina_cost,
      remainingStamina: newStamina,
      maxStamina: status.maxStamina,
      fatigueLevel: newFatigueLevel,
      fatigueEffects: FATIGUE_LEVELS[newFatigueLevel]
    };
  }

  /**
   * 恢复体力（道具/设施）
   */
  async recoverStamina(pokemonId, amount, source, userId, metadata = {}) {
    if (amount <= 0) {
      throw new Error('Recovery amount must be positive');
    }

    const pokemon = await db('pokemon')
      .where({ id: pokemonId, user_id: userId })
      .select('id', 'max_stamina', 'current_stamina', 'fatigue_level')
      .first();

    if (!pokemon) {
      throw new Error('Pokemon not found');
    }

    const staminaBefore = pokemon.current_stamina;
    const newStamina = Math.min(pokemon.current_stamina + amount, pokemon.max_stamina);
    const actualRecovered = newStamina - staminaBefore;
    const newFatigueLevel = this.calculateFatigueLevel(newStamina, pokemon.max_stamina);

    await db('pokemon')
      .where({ id: pokemonId })
      .update({
        current_stamina: newStamina,
        fatigue_level: newFatigueLevel,
        last_stamina_update: new Date()
      });

    // 记录历史
    await db('stamina_history').insert({
      user_id: userId,
      pokemon_id: pokemonId,
      activity_type: 'recovery',
      stamina_change: actualRecovered,
      stamina_before: staminaBefore,
      stamina_after: newStamina,
      source: source,
      metadata: JSON.stringify(metadata)
    });

    // 清除缓存
    await cache.del(CacheKeys.stamina(pokemonId));

    // 记录指标
    metrics.staminaRecovered.inc({ source, service: 'pokemon-service' }, actualRecovered);

    logger.info({
      pokemonId,
      amount: actualRecovered,
      source,
      newStamina,
      fatigueLevel: newFatigueLevel
    }, 'Stamina recovered');

    return {
      success: true,
      staminaRecovered: actualRecovered,
      currentStamina: newStamina,
      maxStamina: pokemon.max_stamina,
      staminaBefore,
      fatigueLevel: newFatigueLevel,
      fatigueEffects: FATIGUE_LEVELS[newFatigueLevel]
    };
  }

  /**
   * 使用道具恢复体力
   */
  async useRecoveryItem(pokemonId, itemId, userId) {
    const item = await db('stamina_recovery_items')
      .where({ id: itemId })
      .first();

    if (!item) {
      throw new Error('Item not found');
    }

    // 检查用户是否有该道具
    const userItem = await db('user_stamina_items')
      .where({ user_id: userId, item_id: itemId })
      .first();

    if (!userItem || userItem.quantity <= 0) {
      return { success: false, error: 'Insufficient item quantity' };
    }

    // 检查冷却时间
    if (item.cooldown_seconds > 0 && userItem.last_used_at) {
      const lastUsed = new Date(userItem.last_used_at);
      const cooldownEnd = new Date(lastUsed.getTime() + item.cooldown_seconds * 1000);
      
      if (new Date() < cooldownEnd) {
        return { 
          success: false, 
          error: 'Item is on cooldown',
          cooldownRemaining: Math.ceil((cooldownEnd - new Date()) / 1000)
        };
      }
    }

    // 使用道具
    await db('user_stamina_items')
      .where({ user_id: userId, item_id: itemId })
      .update({
        quantity: db.raw('quantity - 1'),
        last_used_at: new Date()
      });

    // 恢复体力
    const result = await this.recoverStamina(pokemonId, item.stamina_amount, 'item', userId, {
      itemId,
      itemName: item.item_name
    });

    return {
      ...result,
      itemName: item.item_name
    };
  }

  /**
   * 在休息站开始休息
   */
  async startRestAtStation(pokemonId, stationId, userId) {
    const station = await db('rest_stations')
      .where({ id: stationId, is_active: true })
      .first();

    if (!station) {
      throw new Error('Rest station not found or inactive');
    }

    if (station.current_users >= station.capacity) {
      return { 
        success: false, 
        error: 'Rest station is at full capacity',
        capacity: station.capacity,
        currentUsers: station.current_users
      };
    }

    // 检查精灵是否已经在休息
    const existingRest = await db('rest_records')
      .where({ pokemon_id: pokemonId, status: 'active' })
      .first();

    if (existingRest) {
      return { 
        success: false, 
        error: 'Pokemon is already resting',
        existingRecordId: existingRest.id
      };
    }

    // 增加当前使用人数
    await db('rest_stations')
      .where({ id: stationId })
      .update({
        current_users: db.raw('current_users + 1'),
        updated_at: new Date()
      });

    // 创建休息记录
    const [record] = await db('rest_records')
      .insert({
        user_id: userId,
        pokemon_id: pokemonId,
        station_id: stationId,
        started_at: new Date(),
        status: 'active'
      })
      .returning('*');

    // 更新指标
    metrics.restStationUsage.set(
      { station_id: stationId, station_name: station.name },
      station.current_users + 1
    );

    logger.info({
      pokemonId,
      stationId,
      stationName: station.name,
      recordId: record.id
    }, 'Pokemon started resting at station');

    return {
      success: true,
      recordId: record.id,
      stationName: station.name,
      recoveryRate: station.recovery_rate,
      message: `精灵开始在 ${station.name} 休息，每分钟恢复 ${station.recovery_rate} 点体力`
    };
  }

  /**
   * 结束休息
   */
  async endRest(recordId, userId) {
    const record = await db('rest_records')
      .where({ id: recordId, user_id: userId })
      .first();

    if (!record) {
      throw new Error('Rest record not found');
    }

    if (record.status !== 'active') {
      throw new Error('Rest already ended');
    }

    const station = await db('rest_stations')
      .where({ id: record.station_id })
      .first();

    const now = new Date();
    const startedAt = new Date(record.started_at);
    const minutesRested = Math.floor((now - startedAt) / 60000);
    
    const staminaRecovered = minutesRested * station.recovery_rate;

    // 更新记录
    await db('rest_records')
      .where({ id: recordId })
      .update({
        ended_at: now,
        stamina_recovered: staminaRecovered,
        status: 'completed'
      });

    // 恢复体力
    const recoveryResult = await this.recoverStamina(
      record.pokemon_id, 
      staminaRecovered, 
      'rest_station', 
      userId,
      { stationId: station.id, stationName: station.name, minutesRested }
    );

    // 减少当前使用人数
    await db('rest_stations')
      .where({ id: record.station_id })
      .update({
        current_users: Math.max(0, db.raw('current_users - 1')),
        updated_at: new Date()
      });

    // 更新指标
    metrics.restStationUsage.set(
      { station_id: station.id, station_name: station.name },
      Math.max(0, station.current_users - 1)
    );

    logger.info({
      recordId,
      pokemonId: record.pokemon_id,
      stationName: station.name,
      minutesRested,
      staminaRecovered
    }, 'Rest ended');

    return {
      success: true,
      minutesRested,
      staminaRecovered,
      stationName: station.name,
      ...recoveryResult
    };
  }

  /**
   * 获取附近的休息站
   */
  async getNearbyRestStations(lat, lng, radius = 2000) {
    const stations = await db('rest_stations')
      .where({ is_active: true })
      .whereRaw(`
        ST_DWithin(
          ST_MakePoint(location_lng, location_lat)::geography,
          ST_MakePoint(?, ?)::geography,
          ?
        )
      `, [lng, lat, radius])
      .select('*');

    return stations.map(station => ({
      id: station.id,
      name: station.name,
      description: station.description,
      lat: station.location_lat,
      lng: station.location_lng,
      recoveryRate: station.recovery_rate,
      capacity: station.capacity,
      availableSlots: station.capacity - station.current_users,
      stationType: station.station_type,
      isAvailable: station.current_users < station.capacity
    }));
  }

  /**
   * 计算疲劳等级
   */
  calculateFatigueLevel(currentStamina, maxStamina) {
    const percentage = (currentStamina / maxStamina) * 100;
    
    if (percentage >= FATIGUE_LEVELS.fresh.min) return 'fresh';
    if (percentage >= FATIGUE_LEVELS.normal.min) return 'normal';
    if (percentage >= FATIGUE_LEVELS.tired.min) return 'tired';
    return 'exhausted';
  }

  /**
   * 获取疲劳状态效果
   */
  getFatigueEffects(fatigueLevel) {
    return FATIGUE_LEVELS[fatigueLevel] || FATIGUE_LEVELS.normal;
  }

  /**
   * 获取体力消耗配置
   */
  async getActivityConfigs() {
    return db('stamina_config').select('*');
  }

  /**
   * 获取恢复道具列表
   */
  async getRecoveryItems() {
    return db('stamina_recovery_items').select('*').orderBy('stamina_amount');
  }

  /**
   * 获取用户道具库存
   */
  async getUserStaminaItems(userId) {
    return db('user_stamina_items as usi')
      .join('stamina_recovery_items as sri', 'usi.item_id', 'sri.id')
      .where('usi.user_id', userId)
      .select(
        'usi.id',
        'usi.quantity',
        'usi.last_used_at',
        'sri.id as item_id',
        'sri.item_name',
        'sri.stamina_amount',
        'sri.cooldown_seconds',
        'sri.rarity',
        'sri.description'
      );
  }

  /**
   * 给用户添加体力道具
   */
  async giveStaminaItem(userId, itemId, quantity = 1) {
    const existing = await db('user_stamina_items')
      .where({ user_id: userId, item_id: itemId })
      .first();

    if (existing) {
      await db('user_stamina_items')
        .where({ user_id: userId, item_id: itemId })
        .update({
          quantity: db.raw('quantity + ?', [quantity]),
          updated_at: new Date()
        });
    } else {
      await db('user_stamina_items')
        .insert({
          user_id: userId,
          item_id: itemId,
          quantity
        });
    }

    return { success: true, itemId, quantityAdded: quantity };
  }

  /**
   * 异步更新体力（内部方法）
   */
  async _updateStaminaAsync(pokemonId, amount) {
    try {
      await db('pokemon')
        .where({ id: pokemonId })
        .update({
          current_stamina: db.raw(`LEAST(current_stamina + ?, max_stamina)`, [amount]),
          last_stamina_update: new Date()
        });
    } catch (error) {
      logger.error({ pokemonId, error: error.message }, 'Failed to update stamina async');
    }
  }

  /**
   * 检查精灵是否有足够体力
   */
  async checkStamina(pokemonId, activityType, userId) {
    const config = await db('stamina_config')
      .where({ activity_type: activityType })
      .first();

    if (!config) return { hasEnough: true };

    const status = await this.getStaminaStatus(pokemonId, userId);
    
    return {
      hasEnough: status.currentStamina >= config.stamina_cost,
      currentStamina: status.currentStamina,
      required: config.stamina_cost,
      fatigueLevel: status.fatigueLevel
    };
  }
}

// ============================================================
// Export
// ============================================================

module.exports = {
  StaminaService,
  staminaService: new StaminaService(),
  FATIGUE_LEVELS
};
