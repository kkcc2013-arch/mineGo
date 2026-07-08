/**
 * 日志适配器系统索引
 * 导出所有适配器和管理器
 */
'use strict';

const ILogOutputAdapter = require('./ILogOutputAdapter');
const StdoutAdapter = require('./StdoutAdapter');
const FileAdapter = require('./FileAdapter');
const KafkaAdapter = require('./KafkaAdapter');
const ElasticsearchAdapter = require('./ElasticsearchAdapter');
const LogAdapterManager = require('./LogAdapterManager');
const LogConfig = require('./LogConfig');

module.exports = {
  // 抽象接口
  ILogOutputAdapter,
  
  // 内置适配器
  StdoutAdapter,
  FileAdapter,
  KafkaAdapter,
  ElasticsearchAdapter,
  
  // 管理器
  LogAdapterManager,
  
  // 配置系统
  LogConfig,
  
  // 快速初始化函数
  initLogAdapterManager: LogConfig.initLogAdapterManager,
  
  // 适配器工厂
  createAdapter: LogConfig.createAdapter
};