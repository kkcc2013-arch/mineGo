/**
 * 插件热加载器 - 支持运行时动态加载/卸载插件
 * REQ-00505: 插件生命周期管理与热插拔系统
 */

const path = require('path');
const fs = require('fs').promises;

class PluginHotLoader {
  constructor(pluginManager) {
    this.manager = pluginManager;
    this.pluginPaths = new Map(); // 插件名 → 文件路径
    this.watchers = new Map();    // 文件监听器（开发模式）
  }

  /**
   * 加载插件模块
   * @param {string} pluginPath 插件文件路径
   * @returns {Promise<BasePlugin>} 插件实例
   */
  async load(pluginPath) {
    const absolutePath = path.resolve(pluginPath);
    
    // 检查文件是否存在
    try {
      await fs.access(absolutePath);
    } catch {
      throw new Error(`Plugin file not found: ${pluginPath}`);
    }
    
    // 清除 require 缓存以支持重新加载
    delete require.cache[require.resolve(absolutePath)];
    
    const PluginClass = require(absolutePath);
    
    if (!PluginClass || typeof PluginClass !== 'function') {
      throw new Error(`Invalid plugin module: ${pluginPath} must export a class`);
    }
    
    const plugin = new PluginClass();
    
    // 验证插件基本属性
    if (!plugin.name || !plugin.version) {
      throw new Error(`Plugin must have name and version properties`);
    }
    
    this.pluginPaths.set(plugin.name, absolutePath);
    
    console.log(`[PluginHotLoader] Loaded plugin: ${plugin.name} v${plugin.version} from ${absolutePath}`);
    
    return plugin;
  }

  /**
   * 启用文件监听（开发模式）
   * 文件变化时自动热重载插件
   * @param {string} pluginName 插件名称
   */
  async enableWatch(pluginName) {
    const pluginPath = this.pluginPaths.get(pluginName);
    if (!pluginPath) {
      throw new Error(`Plugin ${pluginName} path not found`);
    }

    if (this.watchers.has(pluginName)) {
      return; // 已在监听
    }

    const fsWatch = require('fs').watch;
    const watcher = fsWatch(pluginPath, async (eventType) => {
      if (eventType === 'change') {
        console.log(`[PluginHotLoader] Detected change in ${pluginName}, reloading...`);
        
        try {
          // 获取当前配置
          const currentConfig = this.manager.pluginConfigs.get(pluginName) || {};
          
          // 热重载流程
          await this.manager.hotUnload(pluginName);
          const plugin = await this.load(pluginPath);
          this.manager.register(plugin, currentConfig);
          await this.manager.initializePlugin(pluginName);
          await this.manager.startPlugin(pluginName);
          
          console.log(`[PluginHotLoader] Plugin ${pluginName} reloaded successfully`);
          
          this.manager.emit('plugin:hot-reloaded', { name: pluginName });
        } catch (error) {
          console.error(`[PluginHotLoader] Failed to reload ${pluginName}:`, error.message);
          this.manager.emit('plugin:reload-error', { name: pluginName, error });
        }
      }
    });

    this.watchers.set(pluginName, watcher);
    console.log(`[PluginHotLoader] Enabled watch for ${pluginName}`);
  }

  /**
   * 禁用文件监听
   * @param {string} pluginName 插件名称
   */
  disableWatch(pluginName) {
    const watcher = this.watchers.get(pluginName);
    if (watcher) {
      watcher.close();
      this.watchers.delete(pluginName);
      console.log(`[PluginHotLoader] Disabled watch for ${pluginName}`);
    }
  }

  /**
   * 禁用所有监听
   */
  disableAllWatchers() {
    for (const [name, watcher] of this.watchers) {
      watcher.close();
      console.log(`[PluginHotLoader] Disabled watch for ${name}`);
    }
    this.watchers.clear();
  }

  /**
   * 扫描插件目录，发现所有插件文件
   * @param {string} dirPath 目录路径
   * @returns {Promise<string[]>} 插件文件路径列表
   */
  async scanDirectory(dirPath) {
    const plugins = [];
    
    try {
      const files = await fs.readdir(dirPath);

      for (const file of files) {
        // 匹配插件文件命名模式
        if (file.endsWith('.plugin.js') || file.endsWith('Plugin.js') || file.endsWith('-plugin.js')) {
          const pluginPath = path.join(dirPath, file);
          plugins.push(pluginPath);
        }
      }

      console.log(`[PluginHotLoader] Scanned ${dirPath}, found ${plugins.length} plugin files`);
      return plugins;
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(`[PluginHotLoader] Directory ${dirPath} not found`);
        return [];
      }
      throw error;
    }
  }

  /**
   * 获取插件路径
   * @param {string} pluginName 插件名称
   * @returns {string|null}
   */
  getPluginPath(pluginName) {
    return this.pluginPaths.get(pluginName);
  }

  /**
   * 获取所有监听的插件
   * @returns {string[]}
   */
  getWatchedPlugins() {
    return Array.from(this.watchers.keys());
  }
}

module.exports = PluginHotLoader;