/**
 * AudioManager - 游戏音频管理器
 * 
 * 功能：
 * - Web Audio API 封装与兼容性处理
 * - 背景音乐播放与场景切换
 * - 音效播放与池管理
 * - 音量控制与持久化
 * - 移动端音频解锁
 * 
 * @module AudioManager
 * @requires Howler.js (可选，降级到原生 Audio)
 */

class AudioManager {
  constructor() {
    // AudioContext 实例
    this.context = null;
    
    // 音量控制节点
    this.masterGain = null;
    this.musicGain = null;
    this.sfxGain = null;
    
    // 音乐播放器
    this.currentMusic = null;
    this.musicSource = null;
    this.musicVolume = 0.6;
    this.sfxVolume = 1.0;
    this.masterVolume = 0.8;
    
    // 音效缓存池
    this.soundPool = new Map();
    this.activeSounds = [];
    this.maxConcurrentSounds = 5;
    
    // 设置
    this.settings = this.loadSettings();
    this.muted = false;
    this.musicEnabled = true;
    this.sfxEnabled = true;
    
    // 状态
    this.initialized = false;
    this.unlocked = false;
    this.currentScene = null;
    
    // 音频资源映射
    this.soundPaths = {
      // UI 音效
      'ui_click': '/audio/sounds/ui/click.mp3',
      'ui_back': '/audio/sounds/ui/back.mp3',
      'ui_notification': '/audio/sounds/ui/notification.mp3',
      'ui_error': '/audio/sounds/ui/error.mp3',
      
      // 捕捉音效
      'catch_throw': '/audio/sounds/catch/throw.mp3',
      'catch_hit': '/audio/sounds/catch/hit.mp3',
      'catch_caught': '/audio/sounds/catch/caught.mp3',
      'catch_fled': '/audio/sounds/catch/fled.mp3',
      'catch_excellent': '/audio/sounds/catch/excellent.mp3',
      'catch_great': '/audio/sounds/catch/great.mp3',
      'catch_nice': '/audio/sounds/catch/nice.mp3',
      
      // 成就音效
      'level_up': '/audio/sounds/achievement/level-up.mp3',
      'reward': '/audio/sounds/achievement/reward.mp3',
      
      // 补给站音效
      'pokestop_spin': '/audio/sounds/pokestop/spin.mp3',
      
      // 道具音效
      'item_pickup': '/audio/sounds/item/pickup.mp3'
    };
    
    // 背景音乐映射
    this.musicPaths = {
      'login': '/audio/music/login.mp3',
      'map_day': '/audio/music/map_day.mp3',
      'map_night': '/audio/music/map_night.mp3',
      'catch': '/audio/music/catch.mp3',
      'battle': '/audio/music/battle.mp3',
      'gym': '/audio/music/gym.mp3'
    };
    
    // 预加载队列
    this.preloadQueue = [];
    this.preloadedSounds = new Set();
    
    // 绑定方法
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
  }
  
  /**
   * 初始化音频管理器
   * 必须在用户交互后调用（移动端要求）
   */
  async init() {
    if (this.initialized) return;
    
    try {
      // 创建 AudioContext
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContext();
      
      // 创建音量控制节点
      this.masterGain = this.context.createGain();
      this.masterGain.connect(this.context.destination);
      this.masterGain.gain.value = this.masterVolume;
      
      this.musicGain = this.context.createGain();
      this.musicGain.connect(this.masterGain);
      this.musicGain.gain.value = this.musicVolume;
      
      this.sfxGain = this.context.createGain();
      this.sfxGain.connect(this.masterGain);
      this.sfxGain.gain.value = this.sfxVolume;
      
      // 应用持久化设置
      this.applySettings();
      
      // 监听页面可见性变化（切换标签页时暂停音乐）
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
      
      this.initialized = true;
      console.log('[AudioManager] Initialized successfully');
      
      // 尝试解锁（如果 context 处于 suspended 状态）
      if (this.context.state === 'suspended') {
        console.log('[AudioManager] AudioContext suspended, waiting for user interaction');
      } else {
        this.unlocked = true;
      }
      
      return true;
    } catch (error) {
      console.error('[AudioManager] Initialization failed:', error);
      return false;
    }
  }
  
  /**
   * 解锁音频（移动端需要用户交互）
   */
  async unlock() {
    if (!this.context || this.unlocked) return;
    
    try {
      if (this.context.state === 'suspended') {
        await this.context.resume();
      }
      this.unlocked = true;
      console.log('[AudioManager] Audio unlocked');
    } catch (error) {
      console.error('[AudioManager] Unlock failed:', error);
    }
  }
  
  /**
   * 播放音效
   * @param {string} name - 音效名称
   * @param {object} options - 选项 { volume, rate, pan }
   */
  async playSfx(name, options = {}) {
    if (!this.initialized || !this.sfxEnabled || this.muted) return;
    
    // 等待解锁
    if (!this.unlocked) {
      await this.unlock();
    }
    
    // 检查并发限制
    if (this.activeSounds.length >= this.maxConcurrentSounds) {
      // 移除最早播放的音效
      const oldest = this.activeSounds.shift();
      if (oldest && oldest.source) {
        try { oldest.source.stop(); } catch (e) {}
      }
    }
    
    try {
      // 获取音频资源
      const audioBuffer = await this.loadSound(name);
      if (!audioBuffer) {
        console.warn(`[AudioManager] Sound not found: ${name}`);
        return;
      }
      
      // 创建音频源
      const source = this.context.createBufferSource();
      source.buffer = audioBuffer;
      
      // 创建增益节点（用于单独音量控制）
      const gainNode = this.context.createGain();
      const volume = options.volume !== undefined ? options.volume : 1.0;
      gainNode.gain.value = volume;
      
      // 连接节点
      source.connect(gainNode);
      gainNode.connect(this.sfxGain);
      
      // 播放速率
      if (options.rate) {
        source.playbackRate.value = options.rate;
      }
      
      // 声道平衡
      if (options.pan !== undefined) {
        const panNode = this.context.createStereoPanner();
        panNode.pan.value = options.pan;
        gainNode.disconnect();
        gainNode.connect(panNode);
        panNode.connect(this.sfxGain);
      }
      
      // 播放
      source.start(0);
      
      // 跟踪活动音效
      const soundRef = { source, gainNode, name };
      this.activeSounds.push(soundRef);
      
      // 播放结束后清理
      source.onended = () => {
        const index = this.activeSounds.indexOf(soundRef);
        if (index > -1) {
          this.activeSounds.splice(index, 1);
        }
      };
      
    } catch (error) {
      console.error(`[AudioManager] Failed to play sound ${name}:`, error);
    }
  }
  
  /**
   * 播放背景音乐
   * @param {string} name - 音乐名称
   * @param {object} options - { fade, loop }
   */
  async playMusic(name, options = {}) {
    if (!this.initialized || !this.musicEnabled || this.muted) return;
    
    // 等待解锁
    if (!this.unlocked) {
      await this.unlock();
    }
    
    const fade = options.fade !== false;
    const loop = options.loop !== false;
    
    try {
      // 如果正在播放同一首音乐，忽略
      if (this.currentMusic === name && this.musicSource) {
        return;
      }
      
      // 淡出当前音乐
      if (this.musicSource && fade) {
        await this.fadeOutMusic(1000);
      } else if (this.musicSource) {
        this.stopMusic();
      }
      
      // 加载新音乐
      const audioBuffer = await this.loadMusic(name);
      if (!audioBuffer) {
        console.warn(`[AudioManager] Music not found: ${name}`);
        return;
      }
      
      // 创建音频源
      const source = this.context.createBufferSource();
      source.buffer = audioBuffer;
      source.loop = loop;
      
      // 创建增益节点（用于淡入淡出）
      const gainNode = this.context.createGain();
      gainNode.gain.value = fade ? 0 : 1;
      
      // 连接节点
      source.connect(gainNode);
      gainNode.connect(this.musicGain);
      
      // 播放
      source.start(0);
      
      // 保存引用
      this.musicSource = source;
      this.musicGainNode = gainNode;
      this.currentMusic = name;
      
      // 淡入
      if (fade) {
        await this.fadeInMusic(1000);
      }
      
      console.log(`[AudioManager] Playing music: ${name}`);
      
    } catch (error) {
      console.error(`[AudioManager] Failed to play music ${name}:`, error);
    }
  }
  
  /**
   * 暂停背景音乐
   */
  pauseMusic() {
    if (this.context && this.context.state === 'running') {
      this.context.suspend();
    }
  }
  
  /**
   * 恢复背景音乐
   */
  async resumeMusic() {
    if (this.context && this.context.state === 'suspended') {
      await this.context.resume();
    }
  }
  
  /**
   * 停止背景音乐
   */
  stopMusic() {
    if (this.musicSource) {
      try {
        this.musicSource.stop();
      } catch (e) {}
      this.musicSource = null;
      this.musicGainNode = null;
      this.currentMusic = null;
    }
  }
  
  /**
   * 淡出音乐
   * @param {number} duration - 淡出时长（毫秒）
   */
  async fadeOutMusic(duration) {
    if (!this.musicGainNode) return;
    
    const startTime = this.context.currentTime;
    const startValue = this.musicGainNode.gain.value;
    
    this.musicGainNode.gain.setValueAtTime(startValue, startTime);
    this.musicGainNode.gain.linearRampToValueAtTime(0, startTime + duration / 1000);
    
    await new Promise(resolve => setTimeout(resolve, duration));
    this.stopMusic();
  }
  
  /**
   * 淡入音乐
   * @param {number} duration - 淡入时长（毫秒）
   */
  async fadeInMusic(duration) {
    if (!this.musicGainNode) return;
    
    const startTime = this.context.currentTime;
    
    this.musicGainNode.gain.setValueAtTime(0, startTime);
    this.musicGainNode.gain.linearRampToValueAtTime(1, startTime + duration / 1000);
  }
  
  /**
   * 设置主音量
   * @param {number} value - 音量值 (0-1)
   */
  setMasterVolume(value) {
    this.masterVolume = Math.max(0, Math.min(1, value));
    if (this.masterGain) {
      this.masterGain.gain.value = this.masterVolume;
    }
    this.saveSettings();
  }
  
  /**
   * 设置音乐音量
   * @param {number} value - 音量值 (0-1)
   */
  setMusicVolume(value) {
    this.musicVolume = Math.max(0, Math.min(1, value));
    if (this.musicGain) {
      this.musicGain.gain.value = this.musicVolume;
    }
    this.saveSettings();
  }
  
  /**
   * 设置音效音量
   * @param {number} value - 音量值 (0-1)
   */
  setSfxVolume(value) {
    this.sfxVolume = Math.max(0, Math.min(1, value));
    if (this.sfxGain) {
      this.sfxGain.gain.value = this.sfxVolume;
    }
    this.saveSettings();
  }
  
  /**
   * 切换静音
   */
  toggleMute() {
    this.muted = !this.muted;
    if (this.masterGain) {
      this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
    }
    this.saveSettings();
    
    // 触发振动反馈（如果支持）
    if (this.muted && navigator.vibrate) {
      navigator.vibrate(50);
    }
  }
  
  /**
   * 设置静音状态
   * @param {boolean} muted
   */
  setMuted(muted) {
    this.muted = muted;
    if (this.masterGain) {
      this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
    }
    this.saveSettings();
  }
  
  /**
   * 启用/禁用音乐
   * @param {boolean} enabled
   */
  setMusicEnabled(enabled) {
    this.musicEnabled = enabled;
    if (!enabled) {
      this.stopMusic();
    }
    this.saveSettings();
  }
  
  /**
   * 启用/禁用音效
   * @param {boolean} enabled
   */
  setSfxEnabled(enabled) {
    this.sfxEnabled = enabled;
    this.saveSettings();
  }
  
  /**
   * 场景切换
   * @param {string} sceneName - 场景名称
   */
  async transitionToScene(sceneName) {
    if (this.currentScene === sceneName) return;
    
    this.currentScene = sceneName;
    
    // 根据场景选择背景音乐
    const sceneMusicMap = {
      'login': 'login',
      'map': this.isNightTime() ? 'map_night' : 'map_day',
      'catch': 'catch',
      'battle': 'battle',
      'gym': 'gym'
    };
    
    const musicName = sceneMusicMap[sceneName];
    if (musicName) {
      await this.playMusic(musicName, { fade: true, loop: sceneName !== 'catch' });
    }
  }
  
  /**
   * 判断是否为夜间时间
   */
  isNightTime() {
    const hour = new Date().getHours();
    return hour < 6 || hour >= 20;
  }
  
  /**
   * 预加载音效
   * @param {string[]} names - 音效名称列表
   */
  async preloadSounds(names) {
    const promises = names.map(async (name) => {
      if (this.preloadedSounds.has(name)) return;
      
      try {
        await this.loadSound(name);
        this.preloadedSounds.add(name);
      } catch (error) {
        console.warn(`[AudioManager] Failed to preload sound: ${name}`, error);
      }
    });
    
    await Promise.all(promises);
    console.log(`[AudioManager] Preloaded ${names.length} sounds`);
  }
  
  /**
   * 加载音效
   * @param {string} name - 音效名称
   * @returns {AudioBuffer}
   */
  async loadSound(name) {
    // 检查缓存
    if (this.soundPool.has(name)) {
      return this.soundPool.get(name);
    }
    
    const path = this.soundPaths[name];
    if (!path) {
      console.warn(`[AudioManager] Unknown sound: ${name}`);
      return null;
    }
    
    try {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.context.decodeAudioData(arrayBuffer);
      
      // 缓存
      this.soundPool.set(name, audioBuffer);
      
      return audioBuffer;
    } catch (error) {
      console.error(`[AudioManager] Failed to load sound ${name}:`, error);
      return null;
    }
  }
  
  /**
   * 加载音乐
   * @param {string} name - 音乐名称
   * @returns {AudioBuffer}
   */
  async loadMusic(name) {
    const path = this.musicPaths[name];
    if (!path) {
      console.warn(`[AudioManager] Unknown music: ${name}`);
      return null;
    }
    
    try {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.context.decodeAudioData(arrayBuffer);
      
      return audioBuffer;
    } catch (error) {
      console.error(`[AudioManager] Failed to load music ${name}:`, error);
      return null;
    }
  }
  
  /**
   * 处理页面可见性变化
   */
  handleVisibilityChange() {
    if (document.hidden) {
      // 页面隐藏时暂停音乐
      this.pauseMusic();
    } else {
      // 页面可见时恢复音乐
      this.resumeMusic();
    }
  }
  
  /**
   * 加载设置
   */
  loadSettings() {
    try {
      const saved = localStorage.getItem('audioSettings');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      console.warn('[AudioManager] Failed to load settings:', error);
    }
    
    // 默认设置
    return {
      masterVolume: 0.8,
      musicVolume: 0.6,
      sfxVolume: 1.0,
      musicEnabled: true,
      sfxEnabled: true,
      muted: false
    };
  }
  
  /**
   * 保存设置
   */
  saveSettings() {
    const settings = {
      masterVolume: this.masterVolume,
      musicVolume: this.musicVolume,
      sfxVolume: this.sfxVolume,
      musicEnabled: this.musicEnabled,
      sfxEnabled: this.sfxEnabled,
      muted: this.muted
    };
    
    try {
      localStorage.setItem('audioSettings', JSON.stringify(settings));
    } catch (error) {
      console.warn('[AudioManager] Failed to save settings:', error);
    }
  }
  
  /**
   * 应用设置
   */
  applySettings() {
    const settings = this.settings;
    
    this.masterVolume = settings.masterVolume || 0.8;
    this.musicVolume = settings.musicVolume || 0.6;
    this.sfxVolume = settings.sfxVolume || 1.0;
    this.musicEnabled = settings.musicEnabled !== false;
    this.sfxEnabled = settings.sfxEnabled !== false;
    this.muted = settings.muted || false;
    
    if (this.masterGain) {
      this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
    }
    if (this.musicGain) {
      this.musicGain.gain.value = this.musicVolume;
    }
    if (this.sfxGain) {
      this.sfxGain.gain.value = this.sfxVolume;
    }
  }
  
  /**
   * 清理资源
   */
  dispose() {
    // 停止所有音效
    this.activeSounds.forEach(sound => {
      if (sound.source) {
        try { sound.source.stop(); } catch (e) {}
      }
    });
    this.activeSounds = [];
    
    // 停止音乐
    this.stopMusic();
    
    // 关闭 AudioContext
    if (this.context) {
      this.context.close();
    }
    
    // 移除事件监听
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    
    this.initialized = false;
    this.unlocked = false;
    
    console.log('[AudioManager] Disposed');
  }
}

// 导出单例
const audioManager = new AudioManager();

// 自动设置移动端解锁监听
if (typeof window !== 'undefined') {
  const unlockAudio = async () => {
    if (!audioManager.initialized) {
      await audioManager.init();
    }
    await audioManager.unlock();
    
    // 预加载常用 UI 音效
    await audioManager.preloadSounds([
      'ui_click',
      'ui_back',
      'ui_notification',
      'ui_error'
    ]);
    
    document.removeEventListener('touchstart', unlockAudio);
    document.removeEventListener('click', unlockAudio);
  };
  
  document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
  document.addEventListener('click', unlockAudio, { once: true });
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AudioManager, audioManager };
} else if (typeof window !== 'undefined') {
  window.AudioManager = AudioManager;
  window.audioManager = audioManager;
}
