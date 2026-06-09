/**
 * 热点数据缓存配置
 * REQ-00039: 热点数据缓存预热系统
 * 
 * 定义需要预热的热点数据类型、查询语句和刷新策略
 */

const HOT_DATA_CONFIG = {
  // 精灵图鉴 - 访问频率最高的基础数据
  pokemonSpecies: {
    enabled: true,
    keys: ['pokemon:species:*'],  // 支持模式
    preloadQuery: 'SELECT * FROM pokemon_species',
    ttl: 3600000,  // 1 小时
    refreshInterval: 1800000,  // 30 分钟刷新一次
    priority: 1,  // 最高优先级
    description: 'Pokemon species database - most frequently accessed base data',
  },
  
  // 活动配置 - 全局共享
  events: {
    enabled: true,
    keys: ['events:active', 'events:config:*'],
    preloadQuery: `SELECT * FROM events WHERE status = 'active'`,
    ttl: 1800000,  // 30 分钟
    refreshInterval: 600000,  // 10 分钟
    priority: 2,
    description: 'Active events configuration - globally shared',
  },
  
  // 稀有精灵刷新点缓存
  rareSpawnPoints: {
    enabled: true,
    keys: ['spawn:rare:*'],
    preloadQuery: `
      SELECT id, lat, lng, rarity 
      FROM spawn_points 
      WHERE rarity IN ('EPIC', 'LEGENDARY') AND is_active = true
    `,
    ttl: 300000,  // 5 分钟
    refreshInterval: 120000,  // 2 分钟
    priority: 3,
    description: 'Rare spawn points cache for quick lookup',
  },
  
  // 道馆信息
  gyms: {
    enabled: true,
    keys: ['gym:*'],
    preloadQuery: 'SELECT id, lat, lng, team_id FROM gyms WHERE is_active = true',
    ttl: 600000,  // 10 分钟
    refreshInterval: 300000,  // 5 分钟
    priority: 2,
    description: 'Active gyms information',
  },
  
  // 物品商店配置
  shopItems: {
    enabled: true,
    keys: ['shop:items:*'],
    preloadQuery: 'SELECT * FROM shop_items WHERE available = true',
    ttl: 3600000,  // 1 小时
    refreshInterval: 1800000,  // 30 分钟
    priority: 3,
    description: 'Shop items configuration',
  },
  
  // 精灵技能数据
  moves: {
    enabled: true,
    keys: ['moves:*'],
    preloadQuery: 'SELECT * FROM moves',
    ttl: 7200000,  // 2 小时
    refreshInterval: 3600000,  // 1 小时
    priority: 2,
    description: 'Pokemon moves database',
  },
};

/**
 * 获取启用的热点数据配置（按优先级排序）
 */
function getEnabledConfigs() {
  return Object.entries(HOT_DATA_CONFIG)
    .filter(([, config]) => config.enabled)
    .sort((a, b) => a[1].priority - b[1].priority);
}

/**
 * 获取单个配置
 */
function getConfig(name) {
  return HOT_DATA_CONFIG[name];
}

/**
 * 获取所有配置名称
 */
function getConfigNames() {
  return Object.keys(HOT_DATA_CONFIG);
}

module.exports = {
  HOT_DATA_CONFIG,
  getEnabledConfigs,
  getConfig,
  getConfigNames,
};
