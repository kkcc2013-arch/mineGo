/**
 * AudioIntegration - 音频系统集成模块
 * REQ-00470: 集成动态音效调节系统到主音频管理器
 * 
 * 这个文件提供了一个插件式集成方案，避免直接修改 AudioManager 核心代码
 */

import { DynamicAudioAdjuster } from './DynamicAudioAdjuster.js';
import { DynamicAudioSettings } from './DynamicAudioSettings.js';

/**
 * 为 AudioManager 添加动态调节支持
 */
function extendAudioManager(AudioManagerClass) {
  // 保存原始 init 方法
  const originalInit = AudioManagerClass.prototype.init;
  
  // 扩展 init 方法
  AudioManagerClass.prototype.init = async function() {
    // 调用原始 init
    await originalInit.call(this);
    
    // 初始化动态调节器
    try {
      this.dynamicAdjuster = new DynamicAudioAdjuster(this);
      await this.dynamicAdjuster.init();
      console.log('[AudioManager] Dynamic adjuster initialized');
    } catch (error) {
      console.warn('[AudioManager] Dynamic adjuster init failed (optional feature):', error);
      this.dynamicAdjuster = null;
    }
  };
  
  // 添加获取动态调节器的方法
  AudioManagerClass.prototype.getDynamicAdjuster = function() {
    return this.dynamicAdjuster;
  };
  
  // 添加发送游戏事件的方法
  AudioManagerClass.prototype.emitGameEvent = function(eventType, data) {
    if (this.dynamicAdjuster && window.gameEvents) {
      window.gameEvents.emit(eventType, { type: eventType, data });
    }
  };
  
  // 保存原始 destroy 方法
  const originalDestroy = AudioManagerClass.prototype.destroy;
  
  // 扩展 destroy 方法
  AudioManagerClass.prototype.destroy = function() {
    // 销毁动态调节器
    if (this.dynamicAdjuster) {
      this.dynamicAdjuster.destroy();
      this.dynamicAdjuster = null;
    }
    
    // 调用原始 destroy
    if (originalDestroy) {
      originalDestroy.call(this);
    }
  };
  
  return AudioManagerClass;
}

/**
 * 创建全局游戏事件系统
 */
function createGameEventSystem() {
  const listeners = new Map();
  
  return {
    on(eventType, handler) {
      if (!listeners.has(eventType)) {
        listeners.set(eventType, new Set());
      }
      listeners.get(eventType).add(handler);
    },
    
    off(eventType, handler) {
      if (listeners.has(eventType)) {
        listeners.get(eventType).delete(handler);
      }
    },
    
    emit(eventType, data) {
      if (listeners.has(eventType)) {
        for (const handler of listeners.get(eventType)) {
          try {
            handler(data);
          } catch (error) {
            console.error(`[GameEvents] Handler error for ${eventType}:`, error);
          }
        }
      }
    },
    
    clear() {
      listeners.clear();
    }
  };
}

/**
 * 初始化动态音频系统
 */
async function initDynamicAudio(audioManager) {
  // 创建全局事件系统
  if (!window.gameEvents) {
    window.gameEvents = createGameEventSystem();
  }
  
  // 创建动态调节器
  const adjuster = new DynamicAudioAdjuster(audioManager);
  await adjuster.init();
  
  // 绑定到 AudioManager
  audioManager.dynamicAdjuster = adjuster;
  
  console.log('[DynamicAudio] System initialized');
  
  return adjuster;
}

/**
 * 在设置页面添加动态音频设置 UI
 */
function createDynamicAudioSettingsUI(container, audioManager) {
  const settings = new DynamicAudioSettings(container);
  settings.init(audioManager);
  return settings;
}

// 自动初始化逻辑（当 AudioManager 就绪时）
if (typeof window !== 'undefined') {
  // 监听 AudioManager 就绪事件
  window.addEventListener('audio:ready', async (event) => {
    const audioManager = event.detail;
    if (audioManager) {
      try {
        await initDynamicAudio(audioManager);
      } catch (error) {
        console.warn('[DynamicAudio] Auto-init failed:', error);
      }
    }
  });
  
  // 提供 hook 供游戏客户端主动触发
  window.initDynamicAudio = async (audioManager) => {
    return await initDynamicAudio(audioManager);
  };
}

// 导出
export {
  extendAudioManager,
  createGameEventSystem,
  initDynamicAudio,
  createDynamicAudioSettingsUI,
  DynamicAudioAdjuster,
  DynamicAudioSettings
};

export default {
  extendAudioManager,
  initDynamicAudio,
  createDynamicAudioSettingsUI
};