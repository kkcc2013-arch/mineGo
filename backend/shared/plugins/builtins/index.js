/**
 * 内置插件导出
 */
const AuthPlugin = require('./AuthPlugin');
const RateLimitPlugin = require('./RateLimitPlugin');
const LoggingPlugin = require('./LoggingPlugin');
const TracingPlugin = require('./TracingPlugin');
const CircuitBreakerPlugin = require('./CircuitBreakerPlugin');

module.exports = {
  AuthPlugin,
  RateLimitPlugin,
  LoggingPlugin,
  TracingPlugin,
  CircuitBreakerPlugin,
  
  // 便捷导出所有内置插件
  all: [
    AuthPlugin,
    RateLimitPlugin,
    LoggingPlugin,
    TracingPlugin,
    CircuitBreakerPlugin,
  ],
};
