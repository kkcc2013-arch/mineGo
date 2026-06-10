/**
 * Audio Integration - 音频集成辅助模块
 * 
 * 功能：
 * - 为现有 UI 组件添加音效支持
 * - 场景切换音频管理
 * - 游戏事件音效触发
 * 
 * @module AudioIntegration
 */

class AudioIntegration {
  constructor(audioManager) {
    this.audioManager = audioManager || window.audioManager;
    this.initialized = false;
  }
  
  /**
   * 初始化音频集成
   */
  async init() {
    if (this.initialized) return;
    
    // 为按钮添加点击音效
    this.addButtonSounds();
    
    // 为捕捉场景添加音效
    this.addCatchSceneSounds();
    
    // 为成就系统添加音效
    this.addAchievementSounds();
    
    // 监听路由变化
    this.addRouteListener();
    
    this.initialized = true;
    console.log('[AudioIntegration] Initialized');
  }
  
  /**
   * 为按钮添加点击音效
   */
  addButtonSounds() {
    // 监听所有按钮点击
    document.addEventListener('click', (e) => {
      const target = e.target;
      
      // 检查是否为按钮或可点击元素
      if (target.matches('button, .btn, [role="button"], .clickable')) {
        // 判断按钮类型
        if (target.matches('.back-btn, [data-action="back"]')) {
          this.audioManager.playSfx('ui_back');
        } else if (target.matches('.error-btn, [data-type="error"]')) {
          this.audioManager.playSfx('ui_error');
        } else {
          this.audioManager.playSfx('ui_click');
        }
      }
    });
    
    console.log('[AudioIntegration] Button sounds enabled');
  }
  
  /**
   * 为捕捉场景添加音效
   */
  addCatchSceneSounds() {
    // 监听捕捉事件
    if (typeof window !== 'undefined') {
      // 投球事件
      window.addEventListener('catch:throw', () => {
        this.audioManager.playSfx('catch_throw');
      });
      
      // 命中事件
      window.addEventListener('catch:hit', (e) => {
        const { quality } = e.detail || {};
        
        if (quality === 'excellent') {
          this.audioManager.playSfx('catch_excellent');
        } else if (quality === 'great') {
          this.audioManager.playSfx('catch_great');
        } else if (quality === 'nice') {
          this.audioManager.playSfx('catch_nice');
        } else {
          this.audioManager.playSfx('catch_hit');
        }
      });
      
      // 捕捉成功
      window.addEventListener('catch:success', () => {
        this.audioManager.playSfx('catch_caught');
      });
      
      // 精灵逃跑
      window.addEventListener('catch:fled', () => {
        this.audioManager.playSfx('catch_fled');
      });
    }
    
    console.log('[AudioIntegration] Catch scene sounds enabled');
  }
  
  /**
   * 为成就系统添加音效
   */
  addAchievementSounds() {
    if (typeof window !== 'undefined') {
      // 等级提升
      window.addEventListener('user:levelup', () => {
        this.audioManager.playSfx('level_up');
      });
      
      // 获得奖励
      window.addEventListener('reward:received', () => {
        this.audioManager.playSfx('reward');
      });
      
      // 拾取道具
      window.addEventListener('item:pickup', () => {
        this.audioManager.playSfx('item_pickup');
      });
      
      // 补给站旋转
      window.addEventListener('pokestop:spin', () => {
        this.audioManager.playSfx('pokestop_spin');
      });
    }
    
    console.log('[AudioIntegration] Achievement sounds enabled');
  }
  
  /**
   * 监听路由变化
   */
  addRouteListener() {
    if (typeof window !== 'undefined') {
      // 监听 URL 变化
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      
      history.pushState = (...args) => {
        originalPushState.apply(history, args);
        this.handleRouteChange();
      };
      
      history.replaceState = (...args) => {
        originalReplaceState.apply(history, args);
        this.handleRouteChange();
      };
      
      window.addEventListener('popstate', () => {
        this.handleRouteChange();
      });
      
      // 初始场景
      this.handleRouteChange();
    }
    
    console.log('[AudioIntegration] Route listener enabled');
  }
  
  /**
   * 处理路由变化
   */
  handleRouteChange() {
    const path = window.location.pathname;
    
    // 根据路径判断场景
    let scene = 'map';
    
    if (path.includes('/login') || path.includes('/auth')) {
      scene = 'login';
    } else if (path.includes('/catch')) {
      scene = 'catch';
    } else if (path.includes('/battle') || path.includes('/raid')) {
      scene = 'battle';
    } else if (path.includes('/gym')) {
      scene = 'gym';
    } else if (path === '/' || path.includes('/map')) {
      scene = 'map';
    }
    
    // 切换场景音乐
    this.audioManager.transitionToScene(scene);
  }
  
  /**
   * 播放通知音效
   */
  playNotification() {
    this.audioManager.playSfx('ui_notification');
  }
  
  /**
   * 播放错误音效
   */
  playError() {
    this.audioManager.playSfx('ui_error');
  }
  
  /**
   * 播放成功音效
   */
  playSuccess() {
    this.audioManager.playSfx('reward');
  }
}

// 导出单例
const audioIntegration = new AudioIntegration();

// 自动初始化
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    // 等待 AudioManager 初始化
    setTimeout(() => {
      audioIntegration.init();
    }, 1000);
  });
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AudioIntegration, audioIntegration };
} else if (typeof window !== 'undefined') {
  window.AudioIntegration = AudioIntegration;
  window.audioIntegration = audioIntegration;
}
