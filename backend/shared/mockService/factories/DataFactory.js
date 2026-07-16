// mockService/factories/DataFactory.js - 测试数据工厂
'use strict';

/**
 * REQ-00546: API Mock 服务与测试隔离系统
 * 
 * DataFactory - 统一的测试数据生成器
 * 
 * 特性：
 * - 支持 Faker.js 风格的数据生成
 * - 可配置随机种子（可重复的测试数据）
 * - 预定义模板（Pokemon、User、Gym 等）
 * - 关联数据生成
 * - 批量生成
 * - 数据导出/导入
 */

const { createLogger } = require('../../logger');
const crypto = require('crypto');

const logger = createLogger('data-factory');

/**
 * 预定义模板
 */
const TEMPLATES = {
  // 用户模板
  user: {
    id: () => crypto.randomUUID(),
    username: () => `user_${randomString(8)}`,
    email: () => `user${randomInt(1000, 9999)}@test.com`,
    password_hash: () => '$2b$12$' + randomString(60),
    level: () => randomInt(1, 50),
    experience: () => randomInt(0, 100000),
    coins: () => randomInt(0, 5000),
    location: () => ({
      latitude: randomFloat(39.9, 40.1, 6),
      longitude: randomFloat(116.3, 116.5, 6)
    }),
    created_at: () => randomDate(new Date('2023-01-01'), new Date()),
    updated_at: () => new Date()
  },

  // Pokemon 模板
  pokemon: {
    id: () => crypto.randomUUID(),
    species_id: () => randomInt(1, 151),
    name: () => `Pokemon_${randomString(5)}`,
    level: () => randomInt(1, 100),
    cp: () => randomInt(100, 5000),
    hp: () => randomInt(10, 500),
    max_hp: () => randomInt(10, 500),
    attack: () => randomInt(10, 300),
    defense: () => randomInt(10, 300),
    stamina: () => randomInt(10, 300),
    types: () => randomChoice(['fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'], 2),
    is_shiny: () => Math.random() > 0.9,
    owner_id: () => crypto.randomUUID(),
    location: () => ({
      latitude: randomFloat(39.9, 40.1, 6),
      longitude: randomFloat(116.3, 116.5, 6)
    }),
    captured_at: () => randomDate(new Date('2023-01-01'), new Date()),
    created_at: () => new Date(),
    updated_at: () => new Date()
  },

  // 道馆模板
  gym: {
    id: () => crypto.randomUUID(),
    name: () => `Gym_${randomString(5)}`,
    team: () => randomChoice(['valor', 'mystic', 'instinct', 'neutral']),
    latitude: () => randomFloat(39.9, 40.1, 6),
    longitude: () => randomFloat(116.3, 116.5, 6),
    level: () => randomInt(1, 6),
    prestige: () => randomInt(0, 50000),
    slots_available: () => randomInt(0, 6),
    is_ex_raid_eligible: () => Math.random() > 0.7,
    created_at: () => randomDate(new Date('2023-01-01'), new Date()),
    updated_at: () => new Date()
  },

  // 捕捉记录模板
  catchRecord: {
    id: () => crypto.randomUUID(),
    user_id: () => crypto.randomUUID(),
    pokemon_id: () => crypto.randomUUID(),
    species_id: () => randomInt(1, 151),
    location: () => ({
      latitude: randomFloat(39.9, 40.1, 6),
      longitude: randomFloat(116.3, 116.5, 6)
    }),
    captured_at: () => new Date(),
    capture_type: () => randomChoice(['wild', 'lure', 'incense', 'raid']),
    balls_used: () => randomInt(1, 10),
    is_critical: () => Math.random() > 0.9,
    is_first_catch: () => Math.random() > 0.95,
    created_at: () => new Date()
  },

  // 物品模板
  item: {
    id: () => crypto.randomUUID(),
    user_id: () => crypto.randomUUID(),
    item_type: () => randomChoice(['pokeball', 'greatball', 'ultraball', 'potion', 'super_potion', 'revive', 'lucky_egg']),
    quantity: () => randomInt(1, 100),
    created_at: () => randomDate(new Date('2023-01-01'), new Date()),
    updated_at: () => new Date()
  },

  // 好友关系模板
  friendship: {
    id: () => crypto.randomUUID(),
    user_id_1: () => crypto.randomUUID(),
    user_id_2: () => crypto.randomUUID(),
    level: () => randomChoice(['good', 'great', 'ultra', 'best']),
    xp: () => randomInt(0, 100000),
    is_lucky: () => Math.random() > 0.9,
    created_at: () => randomDate(new Date('2023-01-01'), new Date()),
    updated_at: () => new Date()
  },

  // 交易记录模板
  trade: {
    id: () => crypto.randomUUID(),
    sender_id: () => crypto.randomUUID(),
    receiver_id: () => crypto.randomUUID(),
    pokemon_id_1: () => crypto.randomUUID(),
    pokemon_id_2: () => crypto.randomUUID(),
    status: () => randomChoice(['pending', 'completed', 'cancelled']),
    trade_type: () => randomChoice(['normal', 'special', 'lucky']),
    created_at: () => randomDate(new Date('2023-01-01'), new Date()),
    completed_at: () => Math.random() > 0.5 ? new Date() : null
  }
};

/**
 * 辅助函数
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max, decimals = 2) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function randomString(length) {
  return crypto.randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
}

function randomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function randomChoice(array, count = 1) {
  if (count === 1) {
    return array[Math.floor(Math.random() * array.length)];
  }
  
  const shuffled = [...array].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

/**
 * 数据工厂类
 */
class DataFactory {
  constructor(config = {}) {
    this.config = {
      seed: config.seed || Date.now(),
      locale: config.locale || 'en',
      generateImages: config.generateImages || false,
      ...config
    };
    
    // 设置随机种子
    if (this.config.seed !== null) {
      this._setRandomSeed(this.config.seed);
    }
    
    // 自定义模板
    this.customTemplates = new Map();
    
    // 统计数据
    this.stats = {
      generated: 0,
      templates: Object.keys(TEMPLATES).length
    };
    
    logger.info({ config: this.config }, 'DataFactory initialized');
  }

  /**
   * 设置随机种子（使数据可重复）
   */
  _setRandomSeed(seed) {
    // 使用种子初始化随机数生成器
    let currentSeed = seed;
    Math.random = function() {
      currentSeed = (currentSeed * 9301 + 49297) % 233280;
      return currentSeed / 233280;
    };
  }

  /**
   * 生成单个对象
   */
  generate(templateName, overrides = {}) {
    const template = TEMPLATES[templateName] || this.customTemplates.get(templateName);
    
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }
    
    const obj = {};
    
    for (const [key, generator] of Object.entries(template)) {
      if (typeof generator === 'function') {
        obj[key] = generator();
      } else {
        obj[key] = generator;
      }
    }
    
    // 应用覆盖值
    Object.assign(obj, overrides);
    
    this.stats.generated++;
    
    return obj;
  }

  /**
   * 批量生成
   */
  generateMany(templateName, count, overrides = {}) {
    const results = [];
    
    for (let i = 0; i < count; i++) {
      results.push(this.generate(templateName, overrides));
    }
    
    return results;
  }

  /**
   * 注册自定义模板
   */
  registerTemplate(name, template) {
    this.customTemplates.set(name, template);
    this.stats.templates++;
    
    logger.info({ name }, 'Custom template registered');
    return this;
  }

  /**
   * 移除自定义模板
   */
  removeTemplate(name) {
    const removed = this.customTemplates.delete(name);
    if (removed) {
      this.stats.templates--;
    }
    return removed;
  }

  /**
   * 生成关联数据
   */
  generateRelated(mainTemplateName, relatedTemplateName, options = {}) {
    const mainObject = this.generate(mainTemplateName, options.mainOverrides);
    const relatedCount = options.relatedCount || randomInt(1, 5);
    
    const relatedObjects = this.generateMany(relatedTemplateName, relatedCount, {
      [options.foreignKey || 'owner_id']: mainObject.id,
      ...options.relatedOverrides
    });
    
    return {
      main: mainObject,
      related: relatedObjects
    };
  }

  /**
   * 生成完整的用户场景数据
   */
  generateUserScenario(options = {}) {
    const user = this.generate('user', options.userOverrides);
    const pokemonCount = options.pokemonCount || randomInt(5, 20);
    const itemCount = options.itemCount || randomInt(10, 50);
    
    const pokemon = this.generateMany('pokemon', pokemonCount, {
      owner_id: user.id,
      ...options.pokemonOverrides
    });
    
    const items = this.generateMany('item', itemCount, {
      user_id: user.id,
      ...options.itemOverrides
    });
    
    return {
      user,
      pokemon,
      items,
      summary: {
        pokemonCount: pokemon.length,
        itemCount: items.length,
        totalGenerated: 1 + pokemon.length + items.length
      }
    };
  }

  /**
   * 生成完整的道馆场景数据
   */
  generateGymScenario(options = {}) {
    const gym = this.generate('gym', options.gymOverrides);
    const defenderCount = randomInt(0, gym.slots_available);
    
    const defenders = this.generateMany('pokemon', defenderCount, {
      gym_id: gym.id,
      is_defender: true,
      ...options.defenderOverrides
    });
    
    return {
      gym,
      defenders,
      summary: {
        defenderCount: defenders.length,
        slotsAvailable: gym.slots_available - defenderCount
      }
    };
  }

  /**
   * 导出数据为 JSON
   */
  exportJSON(data, pretty = true) {
    return JSON.stringify(data, null, pretty ? 2 : 0);
  }

  /**
   * 导入数据
   */
  importJSON(jsonString) {
    try {
      return JSON.parse(jsonString);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to import JSON data');
      throw error;
    }
  }

  /**
   * 生成数据库插入语句
   */
  generateInsertSQL(tableName, data) {
    if (!Array.isArray(data)) {
      data = [data];
    }
    
    if (data.length === 0) {
      return '';
    }
    
    const columns = Object.keys(data[0]);
    const values = data.map(row => 
      '(' + columns.map(col => 
        typeof row[col] === 'string' 
          ? `'${row[col].replace(/'/g, "''")}'`
          : row[col] === null 
            ? 'NULL' 
            : typeof row[col] === 'object'
              ? `'${JSON.stringify(row[col]).replace(/'/g, "''")}'`
              : row[col]
      ).join(', ') + ')'
    );
    
    return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES\n${values.join(',\n')};`;
  }

  /**
   * 重置随机种子
   */
  resetSeed(newSeed = null) {
    this.config.seed = newSeed || Date.now();
    this._setRandomSeed(this.config.seed);
    logger.info({ seed: this.config.seed }, 'Random seed reset');
    return this;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      customTemplatesCount: this.customTemplates.size,
      config: this.config
    };
  }

  /**
   * 列出所有可用模板
   */
  listTemplates() {
    return {
      builtIn: Object.keys(TEMPLATES),
      custom: Array.from(this.customTemplates.keys())
    };
  }
}

module.exports = DataFactory;