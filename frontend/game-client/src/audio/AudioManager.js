/**
 * AudioManager - 核心音频管理器
 * 管理游戏音效和背景音乐的播放、音量控制、场景切换
 */

class AudioManager {
  constructor() {
    this.context = null;           // AudioContext
    this.masterGain = null;        // 主音量控制
    this.musicGain = null;         // 音乐音量
    this.sfxGain = null;           // 音效音量
    this.currentMusic = null;      // 当前播放的音乐
    this.musicElement = null;      // 音乐 Audio 元素
    this.soundPool = new Map();    // 音效缓存池
    this.settings = this.loadSettings();
    this.initialized = false;
    this.currentScene = null;
    this.fadeDuration = 1000;      // 淡入淡出时长
    
    // 音效队列（防止重叠播放）
    this.soundQueue = [];
    this.maxConcurrentSounds = 5;
    this.activeSounds = 0;
  }

  /**
   * 初始化音频系统（需在用户交互后调用）
   */
  async init() {
    if (this.initialized) {
      return;
    }

    try {
      // 创建 AudioContext
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContext();

      // 创建增益节点
      this.masterGain = this.context.createGain();
      this.musicGain = this.context.createGain();
      this.sfxGain = this.context.createGain();

      // 连接节点
      this.masterGain.connect(this.context.destination);
      this.musicGain.connect(this.masterGain);
      this.sfxGain.connect(this.masterGain);

      // 应用初始音量设置
      this.setMasterVolume(this.settings.masterVolume);
      this.setMusicVolume(this.settings.musicVolume);
      this.setSfxVolume(this.settings.sfxVolume);

      // 创建音乐播放元素
      this.musicElement = new Audio();
      this.musicElement.loop = true;

      this.initialized = true;
      console.log('[AudioManager] Initialized successfully');
    } catch (error) {
      console.error('[AudioManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * 播放音效
   * @param {string} name - 音效名称
   * @param {Object} options - 播放选项
   */
  async playSfx(name, options = {}) {
    if (!this.initialized || this.settings.sfxMuted) {
      return;
    }

    // 检查并发音效数量
    if (this.activeSounds >= this.maxConcurrentSounds) {
      console.warn('[AudioManager] Max concurrent sounds reached, skipping:', name);
      return;
    }

    try {
      const soundPath = this.getSoundPath(name);
      let audioBuffer = this.soundPool.get(name);

      // 懒加载音效
      if (!audioBuffer) {
        audioBuffer = await this.loadSound(soundPath);
        this.soundPool.set(name, audioBuffer);
      }

      // 创建音频源
      const source = this.context.createBufferSource();
      source.buffer = audioBuffer;

      // 创建增益节点（用于独立音量控制）
      const gainNode = this.context.createGain();
      gainNode.gain.value = options.volume !== undefined ? options.volume : 1.0;

      // 连接节点
      source.connect(gainNode);
      gainNode.connect(this.sfxGain);

      // 播放
      this.activeSounds++;
      source.start(0);

      // 播放结束回调
      source.onended = () => {
        this.activeSounds--;
      };

      return source;
    } catch (error) {
      console.error('[AudioManager] Failed to play SFX:', name, error);
    }
  }

  /**
   * 播放背景音乐
   * @param {string} name - 音乐名称
   * @param {Object} options - 播放选项
   */
  async playMusic(name, options = {}) {
    if (!this.initialized || this.settings.musicMuted) {
      return;
    }

    const { fade = true, loop = true } = options;

    // 如果是同一首音乐，不重复播放
    if (this.currentMusic === name && !this.musicElement.paused) {
      return;
    }

    try {
      const musicPath = this.getMusicPath(name);

      // 淡出当前音乐
      if (this.currentMusic && fade) {
        await this.fadeOut(this.fadeDuration);
      }

      // 设置新音乐
      this.musicElement.src = musicPath;
      this.musicElement.loop = loop;
      this.currentMusic = name;

      // 淡入新音乐
      if (fade) {
        this.musicElement.volume = 0;
        await this.musicElement.play();
        await this.fadeIn(this.fadeDuration);
      } else {
        this.musicElement.volume = this.settings.musicVolume;
        await this.musicElement.play();
      }

      console.log('[AudioManager] Playing music:', name);
    } catch (error) {
      console.error('[AudioManager] Failed to play music:', name, error);
    }
  }

  /**
   * 暂停背景音乐
   */
  pauseMusic() {
    if (this.musicElement) {
      this.musicElement.pause();
    }
  }

  /**
   * 恢复背景音乐
   */
  resumeMusic() {
    if (this.musicElement && this.currentMusic && !this.settings.musicMuted) {
      this.musicElement.play();
    }
  }

  /**
   * 淡出
   */
  fadeOut(duration) {
    return new Promise((resolve) => {
      if (!this.musicElement || this.musicElement.paused) {
        resolve();
        return;
      }

      const startVolume = this.musicElement.volume;
      const startTime = Date.now();

      const fadeInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        this.musicElement.volume = startVolume * (1 - progress);

        if (progress >= 1) {
          clearInterval(fadeInterval);
          this.musicElement.pause();
          resolve();
        }
      }, 50);
    });
  }

  /**
   * 淡入
   */
  fadeIn(duration) {
    return new Promise((resolve) => {
      const targetVolume = this.settings.musicVolume;
      const startTime = Date.now();

      const fadeInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        this.musicElement.volume = targetVolume * progress;

        if (progress >= 1) {
          clearInterval(fadeInterval);
          resolve();
        }
      }, 50);
    });
  }

  /**
   * 设置主音量
   * @param {number} value - 音量值 (0-1)
   */
  setMasterVolume(value) {
    this.settings.masterVolume = Math.max(0, Math.min(1, value));
    if (this.masterGain) {
      this.masterGain.gain.value = this.settings.masterVolume;
    }
    this.saveSettings();
  }

  /**
   * 设置音乐音量
   * @param {number} value - 音量值 (0-1)
   */
  setMusicVolume(value) {
    this.settings.musicVolume = Math.max(0, Math.min(1, value));
    if (this.musicGain) {
      this.musicGain.gain.value = this.settings.musicVolume;
    }
    if (this.musicElement) {
      this.musicElement.volume = this.settings.musicVolume;
    }
    this.saveSettings();
  }

  /**
   * 设置音效音量
   * @param {number} value - 音量值 (0-1)
   */
  setSfxVolume(value) {
    this.settings.sfxVolume = Math.max(0, Math.min(1, value));
    if (this.sfxGain) {
      this.sfxGain.gain.value = this.settings.sfxVolume;
    }
    this.saveSettings();
  }

  /**
   * 切换静音
   */
  toggleMute() {
    this.settings.muted = !this.settings.muted;
    if (this.masterGain) {
      this.masterGain.gain.value = this.settings.muted ? 0 : this.settings.masterVolume;
    }
    this.saveSettings();
    return this.settings.muted;
  }

  /**
   * 设置静音状态
   * @param {boolean} muted - 是否静音
   */
  setMuted(muted) {
    this.settings.muted = muted;
    if (this.masterGain) {
      this.masterGain.gain.value = muted ? 0 : this.settings.masterVolume;
    }
    this.saveSettings();
  }

  /**
   * 切换音乐静音
   */
  toggleMusicMute() {
    this.settings.musicMuted = !this.settings.musicMuted;
    if (this.settings.musicMuted) {
      this.pauseMusic();
    } else {
      this.resumeMusic();
    }
    this.saveSettings();
    return this.settings.musicMuted;
  }

  /**
   * 切换音效静音
   */
  toggleSfxMute() {
    this.settings.sfxMuted = !this.settings.sfxMuted;
    if (this.sfxGain) {
      this.sfxGain.gain.value = this.settings.sfxMuted ? 0 : this.settings.sfxVolume;
    }
    this.saveSettings();
    return this.settings.sfxMuted;
  }

  /**
   * 预加载音效
   * @param {string[]} names - 音效名称数组
   */
  async preloadSounds(names) {
    const promises = names.map(async (name) => {
      if (!this.soundPool.has(name)) {
        const soundPath = this.getSoundPath(name);
        const audioBuffer = await this.loadSound(soundPath);
        this.soundPool.set(name, audioBuffer);
      }
    });

    await Promise.all(promises);
    console.log('[AudioManager] Preloaded sounds:', names);
  }

  /**
   * 场景切换
   * @param {string} sceneName - 场景名称
   */
  transitionToScene(sceneName) {
    if (this.currentScene === sceneName) {
      return;
    }

    this.currentScene = sceneName;

    // 根据场景自动播放对应音乐
    const sceneMusicMap = {
      login: 'login',
      map: 'map_day',
      map_day: 'map_day',
      map_night: 'map_night',
      catch: 'catch',
      battle: 'battle',
      gym: 'gym'
    };

    const music = sceneMusicMap[sceneName];
    if (music) {
      this.playMusic(music, { fade: true, loop: !['catch'].includes(sceneName) });
    }
  }

  /**
   * 加载音效文件
   * @param {string} path - 音效文件路径
   */
  async loadSound(path) {
    const response = await fetch(path);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.context.decodeAudioData(arrayBuffer);
    return audioBuffer;
  }

  /**
   * 获取音效路径
   * @param {string} name - 音效名称
   */
  getSoundPath(name) {
    const soundMap = {
      // UI 音效
      'ui_click': 'sounds/ui/click.mp3',
      'ui_back': 'sounds/ui/back.mp3',
      'ui_notification': 'sounds/ui/notification.mp3',
      'ui_error': 'sounds/ui/error.mp3',
      
      // 捕捉音效
      'catch_throw': 'sounds/catch/throw.mp3',
      'catch_hit': 'sounds/catch/hit.mp3',
      'catch_caught': 'sounds/catch/caught.mp3',
      'catch_fled': 'sounds/catch/fled.mp3',
      'catch_excellent': 'sounds/catch/excellent.mp3',
      'catch_great': 'sounds/catch/great.mp3',
      'catch_nice': 'sounds/catch/nice.mp3',
      
      // 成就音效
      'level_up': 'sounds/achievement/level-up.mp3',
      'reward': 'sounds/achievement/reward.mp3',
      
      // 其他
      'pokestop_spin': 'sounds/pokestop/spin.mp3',
      'item_pickup': 'sounds/item/pickup.mp3',
      
      // 解锁音效（静音，用于移动端解锁）
      '_unlock': 'sounds/ui/click.mp3'
    };

    const relativePath = soundMap[name] || `sounds/${name}.mp3`;
    return `/audio/${relativePath}`;
  }

  /**
   * 获取音乐路径
   * @param {string} name - 音乐名称
   */
  getMusicPath(name) {
    const musicMap = {
      'login': 'music/login.mp3',
      'map_day': 'music/map_day.mp3',
      'map_night': 'music/map_night.mp3',
      'catch': 'music/catch.mp3',
      'battle': 'music/battle.mp3',
      'gym': 'music/gym.mp3'
    };

    const relativePath = musicMap[name] || `music/${name}.mp3`;
    return `/audio/${relativePath}`;
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
      console.error('[AudioManager] Failed to load settings:', error);
    }

    // 默认设置
    return {
      masterVolume: 0.8,
      musicVolume: 0.6,
      sfxVolume: 1.0,
      muted: false,
      musicMuted: false,
      sfxMuted: false
    };
  }

  /**
   * 保存设置
   */
  saveSettings() {
    try {
      localStorage.setItem('audioSettings', JSON.stringify(this.settings));
    } catch (error) {
      console.error('[AudioManager] Failed to save settings:', error);
    }
  }

  /**
   * 检查音频上下文状态
   */
  checkContextState() {
    if (this.context && this.context.state === 'suspended') {
      this.context.resume();
    }
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      initialized: this.initialized,
      currentScene: this.currentScene,
      currentMusic: this.currentMusic,
      settings: { ...this.settings },
      activeSounds: this.activeSounds,
      soundPoolSize: this.soundPool.size
    };
  }
}

// 单例模式
let audioManagerInstance = null;

function getAudioManager() {
  if (!audioManagerInstance) {
    audioManagerInstance = new AudioManager();
  }
  return audioManagerInstance;
}

// 移动端音频解锁
function unlockAudio() {
  const audioManager = getAudioManager();
  
  if (!audioManager.initialized) {
    audioManager.init().then(() => {
      audioManager.playSfx('_unlock', { volume: 0 });
    });
  } else {
    audioManager.checkContextState();
  }
  
  // 只需触发一次
  document.removeEventListener('touchstart', unlockAudio);
  document.removeEventListener('click', unlockAudio);
}

// 添加事件监听
document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
document.addEventListener('click', unlockAudio, { once: true, passive: true });

// 导出
module.exports = { AudioManager, getAudioManager };
