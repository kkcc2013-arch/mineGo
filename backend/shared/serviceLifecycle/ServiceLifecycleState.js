// backend/shared/serviceLifecycle/ServiceLifecycleState.js
// 服务生命周期状态定义与转换规则
'use strict';

/**
 * 服务生命周期状态枚举
 */
const ServiceLifecycleState = {
  // 初始状态
  UNINITIALIZED: 'uninitialized',    // 未初始化
  
  // 启动阶段
  STARTING: 'starting',              // 正在启动
  WAITING_DEPENDENCIES: 'waiting_dependencies',  // 等待依赖服务
  INITIALIZING_PLUGINS: 'initializing_plugins',  // 初始化插件
  CONNECTING_DB: 'connecting_db',    // 连接数据库
  CONNECTING_REDIS: 'connecting_redis',  // 连接 Redis
  CONNECTING_KAFKA: 'connecting_kafka',  // 连接 Kafka
  STARTING_SERVER: 'starting_server',  // 启动 HTTP 服务器
  
  // 运行阶段
  HEALTHY: 'healthy',                // 正常运行
  DEGRADED: 'degraded',              // 降级运行
  DRAINING: 'draining',              // 排空连接（准备关闭）
  
  // 关闭阶段
  STOPPING: 'stopping',              // 正在停止
  STOPPING_PLUGINS: 'stopping_plugins',  // 停止插件
  CLOSING_CONNECTIONS: 'closing_connections',  // 关闭连接
  CLEANUP_RESOURCES: 'cleanup_resources',  // 清理资源
  
  // 终止状态
  STOPPED: 'stopped',                // 已停止
  ERROR: 'error'                     // 错误状态
};

/**
 * 状态转换规则
 * 定义每个状态可以转换到哪些状态
 */
const STATE_TRANSITIONS = {
  'uninitialized': ['starting', 'error'],
  'starting': ['waiting_dependencies', 'initializing_plugins', 'error'],
  'waiting_dependencies': ['initializing_plugins', 'error'],
  'initializing_plugins': ['connecting_db', 'error'],
  'connecting_db': ['connecting_redis', 'error'],
  'connecting_redis': ['connecting_kafka', 'error'],
  'connecting_kafka': ['starting_server', 'error'],
  'starting_server': ['healthy', 'degraded', 'error'],
  'healthy': ['degraded', 'draining', 'stopping', 'error'],
  'degraded': ['healthy', 'draining', 'stopping', 'error'],
  'draining': ['stopping', 'error'],
  'stopping': ['stopping_plugins', 'error'],
  'stopping_plugins': ['closing_connections', 'error'],
  'closing_connections': ['cleanup_resources', 'error'],
  'cleanup_resources': ['stopped', 'error'],
  'stopped': ['starting'],  // 可重启
  'error': ['starting', 'stopped']  // 可重试或终止
};

/**
 * 状态分组
 */
const STATE_GROUPS = {
  startup: [
    'starting',
    'waiting_dependencies',
    'initializing_plugins',
    'connecting_db',
    'connecting_redis',
    'connecting_kafka',
    'starting_server'
  ],
  running: ['healthy', 'degraded'],
  shutdown: [
    'draining',
    'stopping',
    'stopping_plugins',
    'closing_connections',
    'cleanup_resources'
  ],
  terminal: ['stopped', 'error']
};

/**
 * 状态描述（用于日志和监控）
 */
const STATE_DESCRIPTIONS = {
  'uninitialized': 'Service is not initialized',
  'starting': 'Service is starting up',
  'waiting_dependencies': 'Waiting for dependent services to be ready',
  'initializing_plugins': 'Initializing plugins and extensions',
  'connecting_db': 'Establishing database connection',
  'connecting_redis': 'Establishing Redis connection',
  'connecting_kafka': 'Establishing Kafka connection',
  'starting_server': 'Starting HTTP server',
  'healthy': 'Service is healthy and accepting requests',
  'degraded': 'Service is running in degraded mode',
  'draining': 'Draining active connections before shutdown',
  'stopping': 'Service is shutting down',
  'stopping_plugins': 'Stopping plugins and extensions',
  'closing_connections': 'Closing database and cache connections',
  'cleanup_resources': 'Cleaning up resources',
  'stopped': 'Service has stopped',
  'error': 'Service encountered an error'
};

/**
 * 检查状态是否允许接受请求
 */
function canAcceptRequests(state) {
  return state === ServiceLifecycleState.HEALTHY;
}

/**
 * 检查状态是否处于运行中
 */
function isRunning(state) {
  return STATE_GROUPS.running.includes(state);
}

/**
 * 检查状态是否处于关闭中
 */
function isShuttingDown(state) {
  return STATE_GROUPS.shutdown.includes(state);
}

/**
 * 检查状态是否为终态
 */
function isTerminal(state) {
  return STATE_GROUPS.terminal.includes(state);
}

/**
 * 获取状态分组
 */
function getStateGroup(state) {
  for (const [group, states] of Object.entries(STATE_GROUPS)) {
    if (states.includes(state)) {
      return group;
    }
  }
  return 'unknown';
}

module.exports = {
  ServiceLifecycleState,
  STATE_TRANSITIONS,
  STATE_GROUPS,
  STATE_DESCRIPTIONS,
  canAcceptRequests,
  isRunning,
  isShuttingDown,
  isTerminal,
  getStateGroup
};
