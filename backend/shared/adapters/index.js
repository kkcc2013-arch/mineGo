/**
 * 事件总线适配器模块
 * 
 * 导出所有适配器和接口：
 * - IEventBusAdapter：适配器接口
 * - KafkaAdapter：Kafka 实现（生产环境）
 * - MemoryAdapter：内存实现（开发/测试）
 * - RedisStreamAdapter：Redis Streams 实现（轻量级部署）
 */

const IEventBusAdapter = require('./IEventBusAdapter');
const KafkaAdapter = require('./KafkaAdapter');
const MemoryAdapter = require('./MemoryAdapter');
const RedisStreamAdapter = require('./RedisStreamAdapter');

module.exports = {
  IEventBusAdapter,
  KafkaAdapter,
  MemoryAdapter,
  RedisStreamAdapter
};
