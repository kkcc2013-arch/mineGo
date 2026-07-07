/**
 * 数据库变更到缓存键映射器
 * 
 * REQ-00479: 数据库查询结果缓存自动失效策略系统
 * 
 * 特性：
 * - 自动将数据库表变更映射到缓存键模式
 * - 支持多表多字段的复杂映射
 * - 提供灵活的映射规则配置
 */

const { createLogger } = require('../logger');

const logger = createLogger('change-to-cache-mapper');

// 默认映射规则：表名 -> 缓存键模式
const DEFAULT_MAPPING_RULES = {
  // 用户表
  users: {
    // INSERT 操作
    insert: [
      'api:/users:list:*',
      'api:/users/stats:*'
    ],
    // UPDATE 操作
    update: [
      'api:/users:{id}:*',
      'api:/users:{id}/profile:*',
      'api:/friends:*user:{id}*',
      'api:/users:list:*'
    ],
    // DELETE 操作
    delete: [
      'api:/users:{id}:*',
      'api:/friends:*user:{id}*',
      'api:/users:list:*'
    ],
    
    // 字段级映射
    fields: {
      username: ['api:/users:list:*', 'api:/users/search:*'],
      email: ['api:/users:{id}:*'],
      coins: ['api:/users:{id}/balance:*', 'api:/users:{id}/stats:*'],
      level: ['api:/users:{id}/stats:*', 'api:/leaderboard:*'],
      xp: ['api:/users:{id}/stats:*']
    }
  },
  
  // 精灵表
  pokemon: {
    insert: [
      'api:/pokemon:{owner_id}:*',
      'api:/pokemon:{owner_id}/inventory:*',
      'api:/users:{owner_id}/stats:*'
    ],
    update: [
      'api:/pokemon:{id}:*',
      'api:/pokemon:{owner_id}:*',
      'api:/pokemon:{owner_id}/inventory:*'
    ],
    delete: [
      'api:/pokemon:{id}:*',
      'api:/pokemon:{owner_id}/inventory:*',
      'api:/users:{owner_id}/stats:*'
    ],
    
    fields: {
      cp: ['api:/pokemon:{id}:*', 'api:/leaderboard:*'],
      level: ['api:/pokemon:{id}:*'],
      is_favorite: ['api:/pokemon:{owner_id}/favorites:*']
    }
  },
  
  // 捕捉记录表
  catch_records: {
    insert: [
      'api:/catch:{user_id}:*',
      'api:/users:{user_id}/stats:*',
      'api:/pokemon:{user_id}:*'
    ],
    update: [],
    delete: []
  },
  
  // 道馆表
  gyms: {
    insert: [
      'api:/gyms:list:*',
      'api:/gyms/nearby:*'
    ],
    update: [
      'api:/gyms:{id}:*',
      'api:/gyms:{id}/details:*',
      'api:/gyms/nearby:*'
    ],
    delete: [
      'api:/gyms:{id}:*',
      'api:/gyms:list:*',
      'api:/gyms/nearby:*'
    ],
    
    fields: {
      team_id: ['api:/gyms:{id}/team:*', 'api:/gyms/nearby:*team*'],
      name: ['api:/gyms:{id}:*', 'api:/gyms/search:*']
    }
  },
  
  // 道馆队伍表
  gyms_teams: {
    insert: [
      'api:/gyms:{gym_id}:*',
      'api:/gyms/{gym_id}/team:*'
    ],
    update: [
      'api:/gyms:{gym_id}/team:*',
      'api:/gyms:{gym_id}/slots:*'
    ],
    delete: [
      'api:/gyms:{gym_id}/team:*',
      'api:/gyms:{gym_id}/slots:*'
    ]
  },
  
  // Raid 表
  raids: {
    insert: [
      'api:/raids:list:*',
      'api:/raids/nearby:*',
      'api:/gyms:{gym_id}:*'
    ],
    update: [
      'api:/raids:{gym_id}:*',
      'api:/raids:{gym_id}/participants:*'
    ],
    delete: [
      'api:/raids:{gym_id}:*',
      'api:/raids/list:*'
    ]
  },
  
  // 好友表
  friends: {
    insert: [
      'api:/friends:{user_id}:*',
      'api:/friends/{user_id}/list:*',
      'api:/users:{user_id}/friends:*'
    ],
    update: [
      'api:/friends:{user_id}:*',
      'api:/friends:{friend_id}:*'
    ],
    delete: [
      'api:/friends:{user_id}:*',
      'api:/friends:{friend_id}:*',
      'api:/users:{user_id}/friends:*'
    ]
  },
  
  // 道具表
  items: {
    insert: [
      'api:/items:list:*'
    ],
    update: [
      'api:/items:{id}:*'
    ],
    delete: [
      'api:/items:{id}:*',
      'api:/items:list:*'
    ]
  },
  
  // 用户背包表
  inventory: {
    insert: [
      'api:/inventory:{user_id}:*',
      'api:/users:{user_id}/items:*'
    ],
    update: [
      'api:/inventory:{user_id}:*',
      'api:/users:{user_id}/items:{item_id}*'
    ],
    delete: [
      'api:/inventory:{user_id}:*',
      'api:/users:{user_id}/items:*'
    ]
  },
  
  // 奖励记录表
  reward_records: {
    insert: [
      'api:/rewards:{user_id}:*',
      'api:/users:{user_id}/rewards:*'
    ],
    update: [
      'api:/rewards:{id}:*'
    ],
    delete: []
  },
  
  // 支付记录表
  payments: {
    insert: [
      'api:/payments:{user_id}:*',
      'api:/users:{user_id}/purchases:*',
      'api:/inventory:{user_id}:*'
    ],
    update: [
      'api:/payments:{id}:*',
      'api:/payments:{user_id}:*'
    ],
    delete: []
  }
};

class ChangeToCacheMapper {
  constructor(customRules = {}) {
    // 合并默认规则和自定义规则
    this.mappingRules = { ...DEFAULT_MAPPING_RULES, ...customRules };
    
    logger.info({ 
      tables: Object.keys(this.mappingRules).length 
    }, 'Change-to-cache mapper initialized');
  }
  
  /**
   * 将数据库变更事件映射到缓存键模式
   * @param {Object} changeEvent - 变更事件
   * @returns {Array<string>} 缓存键模式列表
   */
  map(changeEvent) {
    const { table, operation, data, oldData } = changeEvent;
    
    const tableRules = this.mappingRules[table];
    
    if (!tableRules) {
      logger.warn({ table }, 'No mapping rules for table');
      return [];
    }
    
    const patterns = [];
    
    // 操作级映射
    const operationPatterns = tableRules[operation] || [];
    patterns.push(...operationPatterns);
    
    // 字段级映射（仅 UPDATE）
    if (operation === 'update' && tableRules.fields) {
      const changedFields = this.detectChangedFields(data, oldData);
      
      for (const field of changedFields) {
        const fieldPatterns = tableRules.fields[field] || [];
        patterns.push(...fieldPatterns);
      }
    }
    
    // 替换模式中的变量
    const resolvedPatterns = this.resolvePatterns(patterns, data);
    
    // 去重
    const uniquePatterns = [...new Set(resolvedPatterns)];
    
    logger.debug({ 
      table, 
      operation, 
      patterns: uniquePatterns.length 
    }, 'Cache patterns mapped');
    
    return uniquePatterns;
  }
  
  /**
   * 检测变更的字段
   */
  detectChangedFields(newData, oldData) {
    if (!newData || !oldData) return [];
    
    const changedFields = [];
    
    for (const [key, newValue] of Object.entries(newData)) {
      const oldValue = oldData[key];
      
      if (newValue !== oldValue) {
        changedFields.push(key);
      }
    }
    
    return changedFields;
  }
  
  /**
   * 替换模式中的变量
   */
  resolvePatterns(patterns, data) {
    return patterns.map(pattern => {
      return pattern
        .replace(/{id}/g, data.id || '*')
        .replace(/{user_id}/g, data.user_id || '*')
        .replace(/{owner_id}/g, data.owner_id || data.user_id || '*')
        .replace(/{gym_id}/g, data.gym_id || '*')
        .replace(/{friend_id}/g, data.friend_id || '*')
        .replace(/{item_id}/g, data.item_id || '*');
    });
  }
  
  /**
   * 添加自定义映射规则
   */
  addTableMapping(table, rules) {
    if (!this.mappingRules[table]) {
      this.mappingRules[table] = {};
    }
    
    // 合并规则
    for (const [operation, patterns] of Object.entries(rules)) {
      if (!this.mappingRules[table][operation]) {
        this.mappingRules[table][operation] = [];
      }
      this.mappingRules[table][operation].push(...patterns);
    }
    
    logger.info({ table, operations: Object.keys(rules) }, 'Table mapping added');
  }
  
  /**
   * 添加字段映射
   */
  addFieldMapping(table, field, patterns) {
    if (!this.mappingRules[table]) {
      this.mappingRules[table] = {};
    }
    
    if (!this.mappingRules[table].fields) {
      this.mappingRules[table].fields = {};
    }
    
    if (!this.mappingRules[table].fields[field]) {
      this.mappingRules[table].fields[field] = [];
    }
    
    this.mappingRules[table].fields[field].push(...patterns);
    
    logger.info({ table, field }, 'Field mapping added');
  }
  
  /**
   * 获取所有映射规则
   */
  getMappingRules() {
    return { ...this.mappingRules };
  }
  
  /**
   * 获取表的映射规则
   */
  getTableMapping(table) {
    return this.mappingRules[table] || null;
  }
}

module.exports = ChangeToCacheMapper;