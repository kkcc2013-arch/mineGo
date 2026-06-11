/**
 * Redis TTL 统一策略配置
 * REQ-00070: Redis 内存优化与自动 TTL 策略
 * 
 * 分类定义各类数据的 TTL 策略，避免内存泄漏和无限增长
 */

/**
 * TTL 策略分类
 * 
 * 按数据更新频率和业务重要性分级：
 * - 静态数据：很少变化，可缓存较长时间
 * - 半静态数据：偶尔变化，中等 TTL
 * - 用户数据：频繁变化，短 TTL
 * - 动态数据：实时性要求高，极短 TTL
 * - 会话数据：依赖业务场景
 */
const TTL_STRATEGY = {
  // ==================== 静态数据（很少变化）====================
  
  /** 精灵图鉴数据 - 24 小时 */
  POKEDEX: 86400,
  
  /** 精灵种类详情 - 12 小时 */
  SPECIES_DETAIL: 43200,
  
  /** 技能数据 - 24 小时 */
  SKILLS: 86400,
  
  /** 道具配置 - 24 小时 */
  ITEMS: 86400,
  
  /** 游戏配置 - 12 小时 */
  GAME_CONFIG: 43200,

  // ==================== 半静态数据（偶尔变化）====================
  
  /** 道馆基本信息 - 30 分钟 */
  GYM_INFO: 1800,
  
  /** Raid 活动信息 - 5 分钟 */
  RAID_INFO: 300,
  
  /** 游戏活动信息 - 10 分钟 */
  EVENT_INFO: 600,
  
  /** 商店商品列表 - 15 分钟 */
  SHOP_ITEMS: 900,
  
  /** 成就列表 - 1 小时 */
  ACHIEVEMENTS: 3600,

  // ==================== 用户数据（频繁变化）====================
  
  /** 用户个人资料 - 5 分钟 */
  USER_PROFILE: 300,
  
  /** 用户统计信息 - 5 分钟 */
  USER_STATS: 300,
  
  /** 用户道具背包 - 3 分钟 */
  USER_ITEMS: 180,
  
  /** 好友列表 - 3 分钟 */
  FRIEND_LIST: 180,
  
  /** 精灵列表 - 2 分钟 */
  POKEMON_LIST: 120,
  
  /** 精灵详情 - 5 分钟 */
  POKEMON_DETAIL: 300,

  // ==================== 动态数据（实时性要求高）====================
  
  /** 附近道馆 - 1 分钟 */
  NEARBY_GYMS: 60,
  
  /** 附近 Raid - 30 秒 */
  NEARBY_RAIDS: 30,
  
  /** 野生精灵列表 - 1 分钟 */
  WILD_POKEMON: 60,
  
  /** 附近玩家 - 30 秒 */
  NEARBY_PLAYERS: 30,
  
  /** 地图刷新点 - 2 分钟 */
  MAP_SPAWN_POINTS: 120,

  // ==================== 会话数据 ====================
  
  /** JWT 黑名单 - 7 天（与 token 过期时间一致）*/
  JWT_BLACKLIST: 604800,
  
  /** 用户会话 - 24 小时 */
  USER_SESSION: 86400,
  
  /** 设备指纹 - 30 天 */
  DEVICE_FINGERPRINT: 2592000,
  
  /** 验证码 - 5 分钟 */
  CAPTCHA_TOKEN: 300,
  
  /** 登录令牌 - 10 分钟 */
  LOGIN_TOKEN: 600,

  // ==================== 临时数据 ====================
  
  /** 限流计数器 - 1 小时 */
  RATE_LIMIT: 3600,
  
  /** 通知队列 - 24 小时 */
  NOTIFICATION_QUEUE: 86400,
  
  /** 操作日志缓存 - 1 小时 */
  OPERATION_LOG: 3600,
  
  /** 分布式锁 - 10 秒（需业务代码显式设置）*/
  DISTRIBUTED_LOCK: 10,

  // ==================== API 响应缓存 ====================
  
  /** API 响应缓存（通用）- 5 分钟 */
  API_RESPONSE: 300,
  
  /** API 响应缓存（静态资源）- 1 小时 */
  API_RESPONSE_STATIC: 3600,
  
  /** API 响应缓存（动态资源）- 1 分钟 */
  API_RESPONSE_DYNAMIC: 60,

  // ==================== 缓存预热数据 ====================
  
  /** 热点数据（预热）- 15 分钟 */
  HOT_DATA: 900,
  
  /** 精灵位置缓存（预热）- 10 分钟 */
  POKEMON_LOCATION_CACHE: 600,
};

/**
 * TTL 时间桶定义（用于监控 TTL 分布）
 */
const TTL_BUCKETS = [
  { label: 'no_ttl', min: -1, max: 0 },          // 无 TTL
  { label: '<1m', min: 0, max: 60 },             // < 1 分钟
  { label: '1m-5m', min: 60, max: 300 },         // 1-5 分钟
  { label: '5m-30m', min: 300, max: 1800 },      // 5-30 分钟
  { label: '30m-1h', min: 1800, max: 3600 },     // 30 分钟 - 1 小时
  { label: '1h-1d', min: 3600, max: 86400 },     // 1 小时 - 1 天
  { label: '1d-1w', min: 86400, max: 604800 },   // 1 天 - 1 周
  { label: '>1w', min: 604800, max: Infinity },  // > 1 周
];

/**
 * 获取 TTL 桶标签
 * @param {number} ttl - TTL 值（秒）
 * @returns {string} 桶标签
 */
function getTTLBucket(ttl) {
  if (ttl === null || ttl === undefined || ttl === -1) {
    return 'no_ttl';
  }
  
  for (const bucket of TTL_BUCKETS) {
    if (ttl >= bucket.min && ttl < bucket.max) {
      return bucket.label;
    }
  }
  
  return '>1w';
}

/**
 * 验证 TTL 是否合理
 * @param {string} category - 数据类别
 * @param {number} ttl - TTL 值（秒）
 * @returns {Object} 验证结果
 */
function validateTTL(category, ttl) {
  const recommendedTTL = TTL_STRATEGY[category];
  
  if (!recommendedTTL) {
    return {
      valid: false,
      error: `Unknown category: ${category}`,
      recommendedTTL: TTL_STRATEGY.API_RESPONSE // 默认值
    };
  }
  
  if (!ttl || ttl <= 0) {
    return {
      valid: false,
      error: 'TTL must be a positive number',
      recommendedTTL
    };
  }
  
  // 检查是否偏离推荐值过多（±50%）
  const deviation = Math.abs(ttl - recommendedTTL) / recommendedTTL;
  
  if (deviation > 0.5) {
    return {
      valid: true,
      warning: `TTL deviates ${Math.round(deviation * 100)}% from recommended value`,
      recommendedTTL,
      providedTTL: ttl
    };
  }
  
  return {
    valid: true,
    recommendedTTL,
    providedTTL: ttl
  };
}

/**
 * 获取推荐 TTL
 * @param {string} category - 数据类别
 * @returns {number} 推荐 TTL（秒）
 */
function getRecommendedTTL(category) {
  return TTL_STRATEGY[category] || TTL_STRATEGY.API_RESPONSE;
}

module.exports = {
  TTL_STRATEGY,
  TTL_BUCKETS,
  getTTLBucket,
  validateTTL,
  getRecommendedTTL
};
