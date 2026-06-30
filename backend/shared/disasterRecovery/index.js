// backend/shared/disasterRecovery/index.js
// 灾备恢复模块统一导出

const PostgreSQLReplicationManager = require('./PostgreSQLReplicationManager');
const RedisGeoReplication = require('./RedisGeoReplication');
const GSLBController = require('./GSLBController');
const DisasterRecoveryEngine = require('./DisasterRecoveryEngine');

module.exports = {
  PostgreSQLReplicationManager,
  RedisGeoReplication,
  GSLBController,
  DisasterRecoveryEngine,
  
  // 便捷工厂函数
  createDREngine: (options = {}) => new DisasterRecoveryEngine(options),
  
  // 快速初始化
  initialize: async (options = {}) => {
    const engine = new DisasterRecoveryEngine(options);
    await engine.start();
    return engine;
  }
};