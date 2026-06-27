/**
 * 音频系统集成示例
 * 展示如何在游戏客户端中集成音频系统
 */

// 导入音频管理器
const { getAudioManager } = require('./audio/AudioManager');
const { AudioSettings, injectStyles } = require('./audio/AudioSettings');

// 注入样式
injectStyles();

// 初始化音频系统
async function initAudio() {
  const audioManager = getAudioManager();
  
  // 等待用户交互后初始化
  document.addEventListener('click', async () => {
    if (!audioManager.initialized) {
      await audioManager.init();
      
      // 预加载常用 UI 音效
      await audioManager.preloadSounds([
        'ui_click',
        'ui_back',
        'ui_notification',
        'ui_error'
      ]);
      
      console.log('Audio system initialized');
    }
  }, { once: true });
}

// 在游戏启动时调用
initAudio();

/**
 * 使用示例
 */

// 示例 1: 播放 UI 音效
function onButtonClick() {
  const audioManager = getAudioManager();
  audioManager.playSfx('ui_click');
}

// 示例 2: 捕捉精灵音效
async function onPokemonCatch(result) {
  const audioManager = getAudioManager();
  
  // 投球音效
  audioManager.playSfx('catch_throw');
  
  // 等待命中
  await delay(500);
  audioManager.playSfx('catch_hit');
  
  // 根据捕捉结果播放不同音效
  if (result.caught) {
    await delay(1000);
    audioManager.playSfx('catch_caught');
    
    // Excellent 投球额外音效
    if (result.quality === 'excellent') {
      audioManager.playSfx('catch_excellent');
    }
  } else if (result.fled) {
    audioManager.playSfx('catch_fled');
  }
}

// 示例 3: 场景切换
function navigateToScene(sceneName) {
  const audioManager = getAudioManager();
  
  // 自动切换背景音乐
  audioManager.transitionToScene(sceneName);
  
  // 场景特定逻辑
  switch (sceneName) {
    case 'login':
      // 登录场景音乐
      break;
    case 'map':
      // 地图场景（根据时间选择白天/夜晚音乐）
      const hour = new Date().getHours();
      const timeOfDay = (hour >= 6 && hour < 18) ? 'map_day' : 'map_night';
      audioManager.playMusic(timeOfDay);
      break;
    case 'catch':
      // 捕捉场景
      break;
    case 'battle':
      // 战斗场景
      break;
    case 'gym':
      // 道馆场景
      break;
  }
}

// 示例 4: 成就音效
function onLevelUp(newLevel) {
  const audioManager = getAudioManager();
  audioManager.playSfx('level_up');
  
  // 显示成就提示
  showToast(`升级到 ${newLevel} 级！`);
}

function onReward(rewardType) {
  const audioManager = getAudioManager();
  audioManager.playSfx('reward');
}

// 示例 5: 音频设置面板
function showAudioSettings() {
  const audioManager = getAudioManager();
  const container = document.getElementById('settings-container') || document.body;
  
  const settings = new AudioSettings(container, audioManager);
  settings.render();
  settings.open();
}

// 示例 6: 动态音量调整（例如在设置页面）
function adjustVolume() {
  const audioManager = getAudioManager();
  
  // 降低音量（例如播放视频时）
  audioManager.setMasterVolume(0.3);
  
  // 恢复音量
  setTimeout(() => {
    audioManager.setMasterVolume(0.8);
  }, 5000);
}

// 示例 7: 根据游戏状态调整音频
function updateAudioState(gameState) {
  const audioManager = getAudioManager();
  
  if (gameState.isInBackground) {
    // 应用进入后台，暂停音乐
    audioManager.pauseMusic();
  } else {
    // 应用回到前台，恢复音乐
    audioManager.resumeMusic();
  }
  
  if (gameState.isInCall) {
    // 通话中，降低游戏音量
    audioManager.setMasterVolume(0.2);
  } else {
    // 恢复音量
    audioManager.setMasterVolume(0.8);
  }
}

// 示例 8: 无障碍支持（静音时使用振动反馈）
function playHapticFeedback() {
  const audioManager = getAudioManager();
  
  if (audioManager.settings.sfxMuted || audioManager.settings.muted) {
    // 使用振动作为替代反馈
    if (navigator.vibrate) {
      navigator.vibrate(50); // 振动 50ms
    }
  } else {
    // 正常播放音效
    audioManager.playSfx('ui_click');
  }
}

// 辅助函数
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showToast(message) {
  // 实现 Toast 提示
  console.log('Toast:', message);
}

// 导出示例函数
module.exports = {
  initAudio,
  onButtonClick,
  onPokemonCatch,
  navigateToScene,
  onLevelUp,
  onReward,
  showAudioSettings,
  adjustVolume,
  updateAudioState,
  playHapticFeedback
};
