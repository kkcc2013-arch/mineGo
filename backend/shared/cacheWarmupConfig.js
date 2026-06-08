/**
 * 缓存预热配置 - 热点数据定义
 * 
 * REQ-00039: 热点数据缓存预热系统
 * 
 * 定义需要预热的热点数据集：
 * - 访问频率高的基础数据
 * - 启动时必须可用的配置数据
 * - 影响 API 性能的关键数据
 */

const HOT_DATA_CONFIG = {
  // 精灵图鉴 - 访问频率最高的基础数据
  pokemonSpecies: {
    enabled: true,
    name: 'pokemonSpecies',
    description: '精灵图鉴基础数据',
    keys: ['pokemon:species:*'],  // 支持模式
    preloadQuery: `
      SELECT id, name_zh, name_en, type1, type2, rarity,
             base_attack, base_defense, base_hp,
             candy_to_evolve, evolves_to, sprite_url, sprite_shiny_url,
             description_zh, description_en
      FROM pokemon_species
      ORDER BY id
    `,
    cacheKeyTemplate: 'pokemon:species:{id}',
    ttl: 3600,  // 1 小时（秒）
    refreshInterval: 1800000,  // 30 分钟刷新一次（毫秒）
    priority: 1,  // 最高优先级
    batchSize: 50,  // 批量处理大小
  },
  
  // 活动配置 - 全局共享
  events: {
    enabled: true,
    name: 'events',
    description: '当前活动配置',
    keys: ['events:active', 'events:config:*'],
    preloadQuery: `
      SELECT id, name, type, start_time, end_time, 
             config, bonuses, status
      FROM events 
      WHERE status = 'active'
      ORDER BY start_time
    `,
    cacheKeyTemplate: 'events:config:{id}',
    additionalKeys: ['events:active'],  // 额外的聚合键
    ttl: 1800,  // 30 分钟
    refreshInterval: 600000,  // 10 分钟
    priority: 2,
    batchSize: 20,
  },
  
  // 稀有精灵刷新点缓存
  rareSpawnPoints: {
    enabled: true,
    name: 'rareSpawnPoints',
    description: '稀有精灵刷新点',
    keys: ['spawn:rare:*'],
    preloadQuery: `
      SELECT id, lat, lng, rarity, spawn_type, 
             last_spawn_time, next_spawn_time
      FROM spawn_points 
      WHERE rarity IN ('EPIC', 'LEGENDARY') 
        AND is_active = true
      ORDER BY rarity DESC, next_spawn_time
      LIMIT 100
    `,
    cacheKeyTemplate: 'spawn:rare:{id}',
    ttl: 300,  // 5 分钟
    refreshInterval: 120000,  // 2 分钟
    priority: 3,
    batchSize: 50,
  },
  
  // 道馆信息
  gyms: {
    enabled: true,
    name: 'gyms',
    description: '道馆位置与状态',
    keys: ['gym:*'],
    preloadQuery: `
      SELECT id, lat, lng, team_id, level,
             defending_pokemon_id, slots_available,
             is_in_battle, last_modified
      FROM gyms 
      WHERE is_active = true
      ORDER BY level DESC
      LIMIT 500
    `,
    cacheKeyTemplate: 'gym:{id}',
    ttl: 600,  // 10 分钟
    refreshInterval: 300000,  // 5 分钟
    priority: 2,
    batchSize: 100,
  },
  
  // 技能数据
  moves: {
    enabled: true,
    name: 'moves',
    description: '精灵技能基础数据',
    keys: ['moves:*', 'move:*'],
    preloadQuery: `
      SELECT id, name_zh, name_en, type, category,
             power, accuracy, pp, effect, description_zh
      FROM moves
      WHERE is_active = true
      ORDER BY type, id
    `,
    cacheKeyTemplate: 'move:{id}',
    aggregateKey: 'moves:all',  // 聚合键存储完整列表
    ttl: 3600,  // 1 小时
    refreshInterval: 1800000,  // 30 分钟
    priority: 2,
    batchSize: 50,
  },
  
  // 物品配置
  items: {
    enabled: true,
    name: 'items',
    description: '物品配置数据',
    keys: ['items:*', 'item:*'],
    preloadQuery: `
      SELECT id, name_zh, name_en, category,
             effect, rarity, max_stack, description_zh
      FROM items
      WHERE is_active = true
      ORDER BY category, id
    `,
    cacheKeyTemplate: 'item:{id}',
    aggregateKey: 'items:all',
    ttl: 3600,
    refreshInterval: 1800000,
    priority: 3,
    batchSize: 50,
  },
};

/**
 * 获取启用的热点数据配置（按优先级排序）
 * @returns {Array<{name: string, config: object}>}
 */
function getEnabledConfigs() {
  return Object.entries(HOT_DATA_CONFIG)
    .filter(([, config]) => config.enabled)
    .map(([name, config]) => ({ name, config }))
    .sort((a, b) => a.config.priority - b.config.priority);
}

/**
 * 获取指定名称的配置
 * @param {string} name - 配置名称
 * @returns {object|null}
 */
function getConfig(name) {
  return HOT_DATA_CONFIG[name] || null;
}

/**
 * 获取所有配置名称
 * @returns {string[]}
 */
function getConfigNames() {
  return Object.keys(HOT_DATA_CONFIG);
}

/**
 * 检查配置是否存在且启用
 * @param {string} name - 配置名称
 * @returns {boolean}
 */
function isEnabled(name) {
  const config = HOT_DATA_CONFIG[name];
  return config && config.enabled;
}

module.exports = {
  HOT_DATA_CONFIG,
  getEnabledConfigs,
  getConfig,
  getConfigNames,
  isEnabled,
};
