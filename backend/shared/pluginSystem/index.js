/**
 * 插件系统模块入口
 * REQ-00505: 插件生命周期管理与热插拔系统
 */

const BasePlugin = require('./BasePlugin');
const PluginManager = require('./PluginManager');
const DependencyResolver = require('./DependencyResolver');
const PluginHotLoader = require('./PluginHotLoader');

module.exports = {
  BasePlugin,
  PluginManager,
  DependencyResolver,
  PluginHotLoader
};