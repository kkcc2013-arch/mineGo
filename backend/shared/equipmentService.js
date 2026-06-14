// ============================================================
// REQ-00091: Equipment Service
// File: backend/shared/equipmentService.js
// ============================================================

'use strict';

const { createLogger } = require('./logger');
const { emitEvent } = require('./EventBus');

const logger = createLogger('equipment-service');

// 装备类型定义
const EQUIPMENT_TYPES = {
  WEAPON: 'weapon',
  ARMOR: 'armor',
  ACCESSORY: 'accessory',
  SKILL_DISC: 'skill_disc',
  EVOLUTION_STONE: 'evolution_stone',
  HELD_ITEM: 'held_item'
};

// 稀有度定义
const RARITIES = {
  COMMON: 'common',
  UNCOMMON: 'uncommon',
  RARE: 'rare',
  EPIC: 'epic',
  LEGENDARY: 'legendary'
};

// 稀有度配置
const RARITY_CONFIG = {
  common: { multiplier: 1.0, maxLevel: 5, dropRate: 0.50, color: '#9e9e9e' },
  uncommon: { multiplier: 1.2, maxLevel: 7, dropRate: 0.30, color: '#4caf50' },
  rare: { multiplier: 1.5, maxLevel: 10, dropRate: 0.15, color: '#2196f3' },
  epic: { multiplier: 2.0, maxLevel: 12, dropRate: 0.04, color: '#9c27b0' },
  legendary: { multiplier: 3.0, maxLevel: 15, dropRate: 0.01, color: '#ff9800' }
};

/**
 * Equipment Service
 * 装备系统核心服务
 */
class EquipmentService {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
  }

  // ==================== 装备模板 ====================

  /**
   * 获取装备模板列表
   */
  async getTemplates(options = {}) {
    const { type, rarity, setId, limit = 100, offset = 0 } = options;
    
    let query = 'SELECT * FROM equipment_templates WHERE 1=1';
    const params = [];
    
    if (type) {
      params.push(type);
      query += ` AND type = $${params.length}`;
    }
    
    if (rarity) {
      params.push(rarity);
      query += ` AND rarity = $${params.length}`;
    }
    
    if (setId) {
      params.push(setId);
      query += ` AND set_id = $${params.length}`;
    }
    
    query += ` ORDER BY rarity, type, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * 获取装备模板详情
   */
  async getTemplateById(templateId) {
    const result = await this.db.query(
      'SELECT * FROM equipment_templates WHERE id = $1',
      [templateId]
    );
    return result.rows[0] || null;
  }

  // ==================== 玩家装备背包 ====================

  /**
   * 获取玩家装备背包
   */
  async getInventory(userId, options = {}) {
    const { type, rarity, equipped, limit = 100, offset = 0 } = options;
    
    let query = `
      SELECT 
        pe.*,
        et.name_zh, et.name_en, et.name_ja,
        et.type, et.rarity, et.icon_url,
        et.set_id, et.element_affinity, et.max_level,
        up.nickname as pokemon_name
      FROM player_equipment pe
      JOIN equipment_templates et ON pe.template_id = et.id
      LEFT JOIN user_pokemon up ON pe.equipped_to_pokemon_id = up.id
      WHERE pe.user_id = $1
    `;
    const params = [userId];
    
    if (type) {
      params.push(type);
      query += ` AND et.type = $${params.length}`;
    }
    
    if (rarity) {
      params.push(rarity);
      query += ` AND et.rarity = $${params.length}`;
    }
    
    if (equipped !== undefined) {
      params.push(equipped);
      query += ` AND pe.is_equipped = $${params.length}`;
    }
    
    query += ` ORDER BY pe.is_equipped DESC, et.rarity, pe.acquired_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * 获取装备详情
   */
  async getEquipmentById(equipmentId, userId) {
    const result = await this.db.query(`
      SELECT 
        pe.*,
        et.name_zh, et.name_en, et.name_ja,
        et.type, et.rarity, et.description_zh, et.description_en,
        et.icon_url, et.set_id, et.element_affinity, et.max_level,
        et.shop_price, et.sell_price
      FROM player_equipment pe
      JOIN equipment_templates et ON pe.template_id = et.id
      WHERE pe.id = $1 AND pe.user_id = $2
    `, [equipmentId, userId]);
    
    return result.rows[0] || null;
  }

  // ==================== 装备/卸下 ====================

  /**
   * 装备到精灵
   */
  async equip(equipmentId, pokemonId, userId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 检查装备是否存在且属于用户
      const equipmentResult = await client.query(`
        SELECT pe.*, et.type, et.element_affinity, et.max_level
        FROM player_equipment pe
        JOIN equipment_templates et ON pe.template_id = et.id
        WHERE pe.id = $1 AND pe.user_id = $2
      `, [equipmentId, userId]);
      
      if (equipmentResult.rows.length === 0) {
        throw new Error('EQUIPMENT_NOT_FOUND');
      }
      
      const equipment = equipmentResult.rows[0];
      
      if (equipment.is_equipped) {
        throw new Error('EQUIPMENT_ALREADY_EQUIPPED');
      }
      
      // 2. 检查精灵是否存在且属于用户
      const pokemonResult = await client.query(`
        SELECT up.*, ps.type1, ps.type2
        FROM user_pokemon up
        JOIN pokemon_species ps ON up.species_id = ps.id
        WHERE up.id = $1 AND up.user_id = $2
      `, [pokemonId, userId]);
      
      if (pokemonResult.rows.length === 0) {
        throw new Error('POKEMON_NOT_FOUND');
      }
      
      const pokemon = pokemonResult.rows[0];
      
      // 3. 检查元素亲和限制
      if (equipment.element_affinity) {
        const pokemonTypes = [pokemon.type1, pokemon.type2].filter(Boolean);
        if (!pokemonTypes.includes(equipment.element_affinity)) {
          throw new Error('ELEMENT_MISMATCH');
        }
      }
      
      // 4. 检查是否已有同类型装备
      const existingResult = await client.query(`
        SELECT pe.id
        FROM player_equipment pe
        JOIN equipment_templates et ON pe.template_id = et.id
        WHERE pe.equipped_to_pokemon_id = $1
          AND pe.is_equipped = TRUE
          AND et.type = $2
      `, [pokemonId, equipment.type]);
      
      if (existingResult.rows.length > 0) {
        // 自动卸下旧装备
        await client.query(`
          UPDATE player_equipment
          SET is_equipped = FALSE, equipped_to_pokemon_id = NULL
          WHERE id = $1
        `, [existingResult.rows[0].id]);
        
        logger.info('Auto-unequipped existing equipment', {
          userId,
          oldEquipmentId: existingResult.rows[0].id,
          newEquipmentId: equipmentId,
          pokemonId
        });
      }
      
      // 5. 装备
      await client.query(`
        UPDATE player_equipment
        SET is_equipped = TRUE, equipped_to_pokemon_id = $1
        WHERE id = $2
      `, [pokemonId, equipmentId]);
      
      await client.query('COMMIT');
      
      // 发送事件
      await emitEvent('equipment.equipped', {
        userId,
        equipmentId,
        pokemonId,
        type: equipment.type,
        rarity: equipment.rarity
      });
      
      logger.info('Equipment equipped', {
        userId,
        equipmentId,
        pokemonId,
        type: equipment.type
      });
      
      return {
        success: true,
        equipmentId,
        pokemonId,
        type: equipment.type
      };
      
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 从精灵卸下装备
   */
  async unequip(equipmentId, userId) {
    const result = await this.db.query(`
      UPDATE player_equipment
      SET is_equipped = FALSE, equipped_to_pokemon_id = NULL
      WHERE id = $1 AND user_id = $2 AND is_equipped = TRUE
      RETURNING template_id, equipped_to_pokemon_id as pokemon_id
    `, [equipmentId, userId]);
    
    if (result.rows.length === 0) {
      throw new Error('EQUIPMENT_NOT_EQUIPPED');
    }
    
    logger.info('Equipment unequipped', { userId, equipmentId });
    
    return {
      success: true,
      equipmentId,
      pokemonId: result.rows[0].pokemon_id
    };
  }

  // ==================== 装备强化 ====================

  /**
   * 计算强化消耗
   */
  calculateUpgradeCost(currentLevel, rarity) {
    const baseCost = {
      stardust: Math.floor(100 * Math.pow(2, currentLevel - 1)),
      coins: Math.floor(50 * Math.pow(1.5, currentLevel - 1))
    };
    
    const multiplier = RARITY_CONFIG[rarity]?.multiplier || 1.0;
    
    return {
      stardust: Math.floor(baseCost.stardust * multiplier),
      coins: Math.floor(baseCost.coins * multiplier)
    };
  }

  /**
   * 计算强化成功率
   */
  calculateUpgradeSuccessRate(currentLevel, rarity) {
    const baseRate = 1.0 - (currentLevel - 1) * 0.08;
    const rarityBonus = {
      common: 0,
      uncommon: 0.05,
      rare: 0.10,
      epic: 0.15,
      legendary: 0.20
    };
    
    return Math.max(0.3, Math.min(1.0, baseRate + (rarityBonus[rarity] || 0)));
  }

  /**
   * 强化装备
   */
  async upgrade(equipmentId, userId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 获取装备信息
      const equipmentResult = await client.query(`
        SELECT pe.*, et.rarity, et.max_level
        FROM player_equipment pe
        JOIN equipment_templates et ON pe.template_id = et.id
        WHERE pe.id = $1 AND pe.user_id = $2
        FOR UPDATE
      `, [equipmentId, userId]);
      
      if (equipmentResult.rows.length === 0) {
        throw new Error('EQUIPMENT_NOT_FOUND');
      }
      
      const equipment = equipmentResult.rows[0];
      
      // 2. 检查是否已达到最大等级
      if (equipment.current_level >= equipment.max_level) {
        throw new Error('MAX_LEVEL_REACHED');
      }
      
      // 3. 计算消耗和成功率
      const cost = this.calculateUpgradeCost(equipment.current_level, equipment.rarity);
      const successRate = this.calculateUpgradeSuccessRate(equipment.current_level, equipment.rarity);
      
      // 4. 检查用户资源
      const userResult = await client.query(
        'SELECT stardust, coins FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      
      const user = userResult.rows[0];
      
      if (user.stardust < cost.stardust || user.coins < cost.coins) {
        throw new Error('INSUFFICIENT_RESOURCES');
      }
      
      // 5. 扣除资源
      await client.query(
        'UPDATE users SET stardust = stardust - $1, coins = coins - $2 WHERE id = $3',
        [cost.stardust, cost.coins, userId]
      );
      
      // 6. 判断是否成功
      const roll = Math.random();
      const success = roll < successRate;
      
      let newLevel = equipment.current_level;
      let newStats = equipment.current_stats;
      
      if (success) {
        newLevel = equipment.current_level + 1;
        // 使用数据库函数计算新属性
        const statsResult = await client.query(
          'SELECT calculate_equipment_stats($1, $2) as stats',
          [equipment.template_id, newLevel]
        );
        newStats = statsResult.rows[0].stats;
        
        await client.query(`
          UPDATE player_equipment
          SET current_level = $1, current_stats = $2
          WHERE id = $3
        `, [newLevel, JSON.stringify(newStats), equipmentId]);
      }
      
      // 7. 记录强化历史
      await client.query(`
        INSERT INTO equipment_upgrades 
          (equipment_id, user_id, from_level, to_level, cost_resources, success)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        equipmentId,
        userId,
        equipment.current_level,
        newLevel,
        JSON.stringify(cost),
        success
      ]);
      
      await client.query('COMMIT');
      
      // 发送事件
      await emitEvent('equipment.upgraded', {
        userId,
        equipmentId,
        fromLevel: equipment.current_level,
        toLevel: newLevel,
        success,
        cost
      });
      
      logger.info('Equipment upgrade attempt', {
        userId,
        equipmentId,
        fromLevel: equipment.current_level,
        toLevel: newLevel,
        success,
        cost
      });
      
      return {
        success: true,
        upgraded: success,
        fromLevel: equipment.current_level,
        toLevel: newLevel,
        currentStats: newStats,
        cost,
        successRate
      };
      
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ==================== 装备获取 ====================

  /**
   * 给予玩家装备
   */
  async grantEquipment(userId, templateId, source = 'drop', sourceId = null) {
    const result = await this.db.query(`
      INSERT INTO player_equipment 
        (user_id, template_id, acquired_from, source_id)
      VALUES ($1, $2, $3, $4)
      RETURNING id, current_level, current_stats
    `, [userId, templateId, source, sourceId]);
    
    const equipment = result.rows[0];
    
    // 发送事件
    await emitEvent('equipment.acquired', {
      userId,
      equipmentId: equipment.id,
      templateId,
      source
    });
    
    logger.info('Equipment granted', {
      userId,
      equipmentId: equipment.id,
      templateId,
      source
    });
    
    return equipment;
  }

  /**
   * 随机掉落装备（用于Raid等）
   */
  async randomDrop(userId, dropTable = null, guaranteedRarity = null) {
    // 确定稀有度
    let rarity;
    if (guaranteedRarity) {
      rarity = guaranteedRarity;
    } else {
      const roll = Math.random();
      let cumulative = 0;
      for (const [r, config] of Object.entries(RARITY_CONFIG)) {
        cumulative += config.dropRate;
        if (roll < cumulative) {
          rarity = r;
          break;
        }
      }
      rarity = rarity || 'common';
    }
    
    // 随机选择该稀有度的装备
    const result = await this.db.query(`
      SELECT id FROM equipment_templates
      WHERE rarity = $1
      ORDER BY RANDOM()
      LIMIT 1
    `, [rarity]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.grantEquipment(userId, result.rows[0].id, 'drop');
  }

  // ==================== 套装效果 ====================

  /**
   * 获取套装列表
   */
  async getSets() {
    const result = await this.db.query('SELECT * FROM equipment_sets ORDER BY id');
    return result.rows;
  }

  /**
   * 计算精灵的套装效果
   */
  async calculateSetBonuses(pokemonId) {
    const result = await this.db.query(`
      SELECT 
        et.set_id,
        es.name_zh,
        es.pieces_required,
        es.bonus_2_pieces,
        es.bonus_4_pieces,
        es.bonus_6_pieces,
        COUNT(*) as piece_count
      FROM player_equipment pe
      JOIN equipment_templates et ON pe.template_id = et.id
      JOIN equipment_sets es ON et.set_id = es.id
      WHERE pe.equipped_to_pokemon_id = $1
        AND pe.is_equipped = TRUE
        AND et.set_id IS NOT NULL
      GROUP BY et.set_id, es.name_zh, es.pieces_required, 
               es.bonus_2_pieces, es.bonus_4_pieces, es.bonus_6_pieces
    `, [pokemonId]);
    
    const setBonuses = [];
    
    for (const row of result.rows) {
      const bonuses = {};
      
      if (row.piece_count >= 2 && row.bonus_2_pieces) {
        Object.assign(bonuses, row.bonus_2_pieces);
      }
      
      if (row.piece_count >= 4 && row.bonus_4_pieces) {
        Object.assign(bonuses, row.bonus_4_pieces);
      }
      
      if (row.piece_count >= 6 && row.bonus_6_pieces) {
        Object.assign(bonuses, row.bonus_6_pieces);
      }
      
      if (Object.keys(bonuses).length > 0) {
        setBonuses.push({
          setId: row.set_id,
          name: row.name_zh,
          pieceCount: row.piece_count,
          bonuses
        });
      }
    }
    
    return setBonuses;
  }

  // ==================== 战斗属性计算 ====================

  /**
   * 计算精灵战斗属性（包含装备加成）
   */
  async calculateBattleStats(pokemonId) {
    // 获取精灵基础属性
    const pokemonResult = await this.db.query(`
      SELECT 
        up.id,
        up.attack_iv, up.defense_iv, up.hp_iv, up.speed_iv,
        ps.base_attack, ps.base_defense, ps.base_hp,
        ps.type1, ps.type2
      FROM user_pokemon up
      JOIN pokemon_species ps ON up.species_id = ps.id
      WHERE up.id = $1
    `, [pokemonId]);
    
    if (pokemonResult.rows.length === 0) {
      throw new Error('POKEMON_NOT_FOUND');
    }
    
    const pokemon = pokemonResult.rows[0];
    
    // 基础属性
    const baseStats = {
      attack: pokemon.base_attack + pokemon.attack_iv,
      defense: pokemon.base_defense + pokemon.defense_iv,
      hp: pokemon.base_hp + pokemon.hp_iv,
      speed: 100 + pokemon.speed_iv,
      critical_rate: 0.05,
      critical_damage: 1.5
    };
    
    // 获取装备加成
    const equipmentResult = await this.db.query(`
      SELECT pe.current_stats
      FROM player_equipment pe
      WHERE pe.equipped_to_pokemon_id = $1 AND pe.is_equipped = TRUE
    `, [pokemonId]);
    
    const equipmentBonus = {
      attack: 0,
      defense: 0,
      hp: 0,
      speed: 0,
      critical_rate: 0,
      critical_damage: 0
    };
    
    for (const row of equipmentResult.rows) {
      const stats = row.current_stats || {};
      for (const [key, value] of Object.entries(stats)) {
        if (equipmentBonus.hasOwnProperty(key)) {
          equipmentBonus[key] += value;
        }
      }
    }
    
    // 获取套装效果
    const setBonuses = await this.calculateSetBonuses(pokemonId);
    
    const setBonus = {
      attack: 0,
      defense: 0,
      hp: 0,
      speed: 0,
      critical_rate: 0,
      critical_damage: 0
    };
    
    for (const set of setBonuses) {
      for (const [key, value] of Object.entries(set.bonuses)) {
        if (setBonus.hasOwnProperty(key)) {
          setBonus[key] += value;
        }
      }
    }
    
    // 合并属性
    return {
      attack: baseStats.attack + equipmentBonus.attack + setBonus.attack,
      defense: baseStats.defense + equipmentBonus.defense + setBonus.defense,
      maxHp: baseStats.hp + equipmentBonus.hp + setBonus.hp,
      speed: baseStats.speed + equipmentBonus.speed + setBonus.speed,
      criticalRate: baseStats.critical_rate + equipmentBonus.critical_rate + setBonus.critical_rate,
      criticalDamage: baseStats.critical_damage + equipmentBonus.critical_damage + setBonus.critical_damage,
      equipmentBonus,
      setBonuses
    };
  }

  // ==================== 出售装备 ====================

  /**
   * 出售装备
   */
  async sell(equipmentId, userId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 获取装备信息
      const equipmentResult = await client.query(`
        SELECT pe.*, et.sell_price, et.sellable
        FROM player_equipment pe
        JOIN equipment_templates et ON pe.template_id = et.id
        WHERE pe.id = $1 AND pe.user_id = $2
        FOR UPDATE
      `, [equipmentId, userId]);
      
      if (equipmentResult.rows.length === 0) {
        throw new Error('EQUIPMENT_NOT_FOUND');
      }
      
      const equipment = equipmentResult.rows[0];
      
      if (!equipment.sellable) {
        throw new Error('EQUIPMENT_NOT_SELLABLE');
      }
      
      if (equipment.is_equipped) {
        throw new Error('EQUIPMENT_EQUIPPED');
      }
      
      // 2. 删除装备
      await client.query(
        'DELETE FROM player_equipment WHERE id = $1',
        [equipmentId]
      );
      
      // 3. 增加金币
      await client.query(
        'UPDATE users SET coins = coins + $1 WHERE id = $2',
        [equipment.sell_price, userId]
      );
      
      await client.query('COMMIT');
      
      logger.info('Equipment sold', {
        userId,
        equipmentId,
        price: equipment.sell_price
      });
      
      return {
        success: true,
        price: equipment.sell_price
      };
      
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

// 单例
let equipmentService = null;

function getEquipmentService(db, redis) {
  if (!equipmentService) {
    equipmentService = new EquipmentService(db, redis);
  }
  return equipmentService;
}

module.exports = {
  EquipmentService,
  getEquipmentService,
  EQUIPMENT_TYPES,
  RARITIES,
  RARITY_CONFIG
};
