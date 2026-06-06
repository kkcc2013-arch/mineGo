/**
 * Gateway 缓存配置
 * REQ-00031: API 响应缓存层与缓存失效策略
 */

const { cacheMiddleware, presets } = require('../../shared/cacheMiddleware');

/**
 * 缓存路由配置
 * 格式：[路径模式, 缓存选项, 是否需要认证]
 */
const cacheRoutes = [
  // 静态数据 - 长缓存
  {
    path: '/v1/pokemon/pokedex',
    options: {
      ...presets.static,
      keyPrefix: 'api:pokedex:',
      ttl: 3600 // 1 小时
    },
    auth: false
  },
  
  // 用户资料 - 中等缓存
  {
    path: '/v1/users/:id/profile',
    options: {
      ...presets.userData,
      keyPrefix: 'api:profile:',
      ttl: 300, // 5 分钟
      cacheUserData: true
    },
    auth: true
  },
  
  // 好友列表
  {
    path: '/v1/friends',
    options: {
      ...presets.list,
      keyPrefix: 'api:friends:',
      ttl: 180 // 3 分钟
    },
    auth: true
  },
  
  // 道具列表
  {
    path: '/v1/users/:id/items',
    options: {
      ...presets.list,
      keyPrefix: 'api:items:',
      ttl: 600 // 10 分钟
    },
    auth: true
  },
  
  // 用户精灵列表
  {
    path: '/v1/pokemon',
    options: {
      ...presets.userData,
      keyPrefix: 'api:pokemon:',
      ttl: 120 // 2 分钟
    },
    auth: true
  },
  
  // 精灵详情
  {
    path: '/v1/pokemon/:id',
    options: {
      ...presets.static,
      keyPrefix: 'api:pokemon-detail:',
      ttl: 300 // 5 分钟
    },
    auth: true
  },
  
  // 道馆列表
  {
    path: '/v1/gyms/nearby',
    options: {
      ...presets.dynamic,
      keyPrefix: 'api:gyms-nearby:',
      ttl: 60 // 1 分钟
    },
    auth: true
  },
  
  // 道馆详情
  {
    path: '/v1/gyms/:id',
    options: {
      ...presets.userData,
      keyPrefix: 'api:gym-detail:',
      ttl: 180 // 3 分钟
    },
    auth: true
  },
  
  // Raid 列表
  {
    path: '/v1/raids/nearby',
    options: {
      ...presets.dynamic,
      keyPrefix: 'api:raids-nearby:',
      ttl: 30 // 30 秒
    },
    auth: true
  },
  
  // 用户统计
  {
    path: '/v1/users/:id/stats',
    options: {
      ...presets.userData,
      keyPrefix: 'api:user-stats:',
      ttl: 300 // 5 分钟
    },
    auth: true
  }
];

/**
 * 不应该缓存的路径模式
 */
const noCachePatterns = [
  /^\/v1\/auth/,           // 认证相关
  /^\/v1\/catch/,          // 捕捉操作
  /^\/v1\/payment/,        // 支付操作
  /^\/v1\/trades/,         // 交易操作
  /\/create$/,             // 创建操作
  /\/update$/,             // 更新操作
  /\/delete$/,             // 删除操作
  /\/action$/,             // 动作操作
];

/**
 * 检查路径是否应该跳过缓存
 * @param {string} path - 请求路径
 * @returns {boolean}
 */
function shouldSkipCache(path) {
  return noCachePatterns.some(pattern => pattern.test(path));
}

/**
 * 为路由生成缓存中间件
 * @param {string} path - 路由路径
 * @returns {Function|null} 缓存中间件或 null
 */
function getCacheMiddleware(path) {
  // 检查是否应该跳过缓存
  if (shouldSkipCache(path)) {
    return null;
  }
  
  // 查找匹配的缓存配置
  const config = cacheRoutes.find(route => {
    // 简单的路径匹配（支持 :param 参数）
    const routePattern = route.path.replace(/:\w+/g, '[^/]+');
    const regex = new RegExp(`^${routePattern}$`);
    return regex.test(path);
  });
  
  if (config) {
    return cacheMiddleware(config.options);
  }
  
  return null;
}

/**
 * 获取所有缓存路由配置
 * @returns {Array} 缓存路由配置
 */
function getCacheRoutes() {
  return cacheRoutes;
}

/**
 * 获取所有不缓存的模式
 * @returns {Array<RegExp>} 不缓存模式列表
 */
function getNoCachePatterns() {
  return noCachePatterns;
}

module.exports = {
  cacheRoutes,
  noCachePatterns,
  shouldSkipCache,
  getCacheMiddleware,
  getCacheRoutes,
  getNoCachePatterns,
  presets
};
