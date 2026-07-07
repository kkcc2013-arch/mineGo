/**
 * DynamicAudioAdjuster - 智能动态音效调节系统
 * REQ-00470：游戏内动态音效与背景音乐智能调节系统
 * 
 * 功能：
 * - 根据游戏状态自动调节音效平衡与 BGM 风格
 * - 战斗激烈程度影响音效强度
 * - 天气状态影响环境音效
 * - 玩家体力状态影响音效节奏
 * - 支持无缝过渡和用户自定义
 */

class DynamicAudioAdjuster {
  constructor(audioManager) {
    this.audioManager = audioManager;
    this.config = {
      enabled: true,
      smoothingFactor: 0.3,      // 平滑过渡系数
      updateInterval: 1000,       // 状态更新间隔（ms）
      transitionDuration: 2000,   // 状态切换过渡时长（ms）
      
      // 战斗状态阈值
      battleIntensityThresholds: {
        low: 0.3,
        medium: 0.6,
        high: 0.9
      },
      
      // 天气状态映射
      weatherAudioProfiles: {
        clear: {
          bgmStyle: 'bright',
          ambientIntensity: 0.2,
          filterFreq: 8000
        },
        rain: {
          bgmStyle: 'melancholy',
          ambientIntensity: 0.5,
          ambientType: 'rain',
          filterFreq: 4000
        },
        cloudy: {
          bgmStyle: 'neutral',
          ambientIntensity: 0.3,
          filterFreq: 6000
        },
        windy: {
          bgmStyle: 'dynamic',
          ambientIntensity: 0.4,
          ambientType: 'wind',
          filterFreq: 5000
        },
        fog: {
          bgmStyle: 'mysterious',
          ambientIntensity: 0.6,
          filterFreq: 3000,
          reverbIntensity: 0.7
        },
        snow: {
          bgmStyle: 'peaceful',
          ambientIntensity: 0.3,
          ambientType: 'snow',
          filterFreq: 5000
        },
        thunderstorm: {
          bgmStyle: 'intense',
          ambientIntensity: 0.8,
          filterFreq: 2000,
          reverbIntensity: 0.9
        }
      },
      
      // BGM 风格配置
      bgmStyles: {
        bright: {
          energy: 0.7,
          tempo: 1.0,
          frequencyBias: 'high',  // 提升高频
          reverb: 0.3
        },
        melancholy: {
          energy: 0.4,
          tempo: 0.8,
          frequencyBias: 'low',
          reverb: 0.6
        },
        neutral: {
          energy: 0.5,
          tempo: 1.0,
          frequencyBias: 'balanced',
          reverb: 0.4
        },
        dynamic: {
          energy: 0.8,
          tempo: 1.2,
          frequencyBias: 'high',
          reverb: 0.5
        },
        mysterious: {
          energy: 0.3,
          tempo: 0.9,
          frequencyBias: 'low',
          reverb: 0.7
        },
        peaceful: {
          energy: 0.2,
          tempo: 0.7,
          frequencyBias: 'low',
          reverb: 0.5
        },
        intense: {
          energy: 1.0,
          tempo: 1.4,
          frequencyBias: 'high',
          reverb: 0.4
        }
      },
      
      // 玩家状态映射
      playerStateProfiles: {
        normal: {
          audioIntensity: 0.7,
          tempoMultiplier: 1.0
        },
        exhausted: {
          audioIntensity: 0.5,
          tempoMultiplier: 0.8
        },
        energized: {
          audioIntensity: 0.9,
          tempoMultiplier: 1.2
        },
        lowHealth: {
          audioIntensity: 0.6,
          tempoMultiplier: 0.9,
          heartbeatEffect: true
        }
      }
    };
    
    // 当前状态
    this.state = {
      battleIntensity: 0,
      weather: 'clear',
      playerHealth: 100,
      playerStamina: 100,
      playerState: 'normal',
      currentScene: 'idle',
      previousScene: null,
      currentBgmStyle: 'neutral',
      lastUpdate: Date.now()
    };
    
    // 音频处理器
    this.filters = {
      lowpass: null,
      highpass: null
    };
    this.reverbNode = null;
    this.currentAmbient = null;
    
    // 用户偏好（可自定义）
    this.userPreferences = {
      dynamicAdjustmentEnabled: true,
      intensityMultiplier: 1.0,
      preferredAmbientLevel: 0.5
    };
    
    // 平滑过渡目标值
    this.targetValues = {
      lowpassFreq: 8000,
      highpassFreq: 20,
      reverbMix: 0.3,
      sfxIntensity: 1.0,
      ambientIntensity: 0.2
    };
    
    this.currentValues = { ...this.targetValues };
    
    // 状态监听器
    this.stateListeners = new Map();
    
    // 性能监控
    this.performanceMonitor = {
      updateCount: 0,
      cpuUsage: 0,
      memoryUsage: 0
    };
  }
  
  /**
   * 初始化动态调节系统
   */
  async init() {
    if (!this.audioManager.initialized) {
      await this.audioManager.init();
    }
    
    // 创建音频滤波器
    this.createFilters();
    
    // 创建混响效果
    await this.createReverb();
    
    // 连接处理器到音频链路
    this.connectFilters();
    
    // 启动状态监听
    this.startStateMonitoring();
    
    // 启动平滑过渡定时器
    this.startSmoothTransition();
    
    console.log('[DynamicAudioAdjuster] Initialized');
  }
  
  /**
   * 创建音频滤波器
   */
  createFilters() {
    // 低通滤波器（控制高频）
    this.filters.lowpass = this.audioManager.context.createBiquadFilter();
    this.filters.lowpass.type = 'lowpass';
    this.filters.lowpass.frequency.value = this.targetValues.lowpassFreq;
    this.filters.lowpass.Q.value = 1;
    
    // 高通滤波器（控制低频）
    this.filters.highpass = this.audioManager.context.createBiquadFilter();
    this.filters.highpass.type = 'highpass';
    this.filters.highpass.frequency.value = this.targetValues.highpassFreq;
    this.filters.highpass.Q.value = 1;
  }
  
  /**
   * 创建混响效果
   */
  async createReverb() {
    // 使用 ConvolverNode 创建混响
    // 简化实现：使用延迟网络模拟混响
    this.reverbNode = this.audioManager.context.createConvolver();
    
    // 创建简单的混响 IR（脉冲响应）
    const irBuffer = await this.createReverbIR(2, 2.0, 0.5);
    this.reverbNode.buffer = irBuffer;
    
    // 混响增益控制
    this.reverbGain = this.audioManager.context.createGain();
    this.reverbGain.gain.value = this.targetValues.reverbMix;
  }
  
  /**
   * 创建混响脉冲响应（简化版本）
   */
  async createReverbIR(duration, decay, mix) {
    const length = this.audioManager.context.sampleRate * duration;
    const impulse = this.audioManager.context.createBuffer(2, length, this.audioManager.context.sampleRate);
    
    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        // 简化的衰减曲线
        channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    
    return impulse;
  }
  
  /**
   * 连接滤波器到音频链路
   */
  connectFilters() {
    // 在音效增益节点后插入滤波器
    const sfxGain = this.audioManager.sfxGain;
    
    // 断开原有连接
    sfxGain.disconnect();
    
    // 连接滤波器链
    sfxGain.connect(this.filters.highpass);
    this.filters.highpass.connect(this.filters.lowpass);
    this.filters.lowpass.connect(this.audioManager.masterGain);
    
    // 连接混响（平行路径）
    sfxGain.connect(this.reverbNode);
    this.reverbNode.connect(this.reverbGain);
    this.reverbGain.connect(this.audioManager.masterGain);
  }
  
  /**
   * 启动状态监听
   */
  startStateMonitoring() {
    // 监听游戏事件
    this.subscribeToGameEvents();
    
    // 定时更新
    this.updateTimer = setInterval(() => {
      this.updateAudioState();
      this.performanceMonitor.updateCount++;
    }, this.config.updateInterval);
  }
  
  /**
   * 订阅游戏事件
   */
  subscribeToGameEvents() {
    // 监听战斗事件
    this.stateListeners.set('battle', (event) => {
      this.handleBattleEvent(event);
    });
    
    // 监听天气变化
    this.stateListeners.set('weather', (event) => {
      this.handleWeatherEvent(event);
    });
    
    // 监听玩家状态
    this.stateListeners.set('player', (event) => {
      this.handlePlayerEvent(event);
    });
    
    // 监听场景切换
    this.stateListeners.set('scene', (event) => {
      this.handleSceneEvent(event);
    });
    
    // 注册事件监听器到游戏系统
    if (window.gameEvents) {
      for (const [eventType, handler] of this.stateListeners) {
        window.gameEvents.on(eventType, handler);
      }
    }
  }
  
  /**
   * 处理战斗事件
   */
  handleBattleEvent(event) {
    const { type, data } = event;
    
    // 计算战斗激烈程度
    let intensity = this.state.battleIntensity;
    
    switch (type) {
      case 'battle_start':
        intensity = 0.5; // 中等强度
        break;
      case 'battle_action':
        // 根据伤害值调整强度
        if (data.damage) {
          const damageRatio = data.damage / 100;
          intensity = Math.min(1.0, intensity + damageRatio * 0.2);
        }
        break;
      case 'critical_hit':
        intensity = Math.min(1.0, intensity + 0.3);
        break;
      case 'combo':
        intensity = Math.min(1.0, intensity + 0.2);
        break;
      case 'battle_end':
        intensity = 0;
        break;
      case 'damage_taken':
        intensity = Math.min(1.0, intensity + 0.15);
        break;
    }
    
    // 平滑衰减
    if (type !== 'battle_action' && type !== 'critical_hit') {
      intensity = intensity * 0.95;
    }
    
    this.state.battleIntensity = intensity;
    this.updateBgmStyle();
  }
  
  /**
   * 处理天气事件
   */
  handleWeatherEvent(event) {
    const { weather, intensity } = event;
    
    if (this.config.weatherAudioProfiles[weather]) {
      this.state.weather = weather;
      this.applyWeatherProfile(weather, intensity);
    }
  }
  
  /**
   * 应用天气音频配置
   */
  applyWeatherProfile(weather, intensity = 1.0) {
    const profile = this.config.weatherAudioProfiles[weather];
    
    // 更新滤波器频率
    this.targetValues.lowpassFreq = profile.filterFreq;
    
    // 更新混响强度
    if (profile.reverbIntensity) {
      this.targetValues.reverbMix = profile.reverbIntensity;
    }
    
    // 更新环境音效
    this.targetValues.ambientIntensity = profile.ambientIntensity * intensity;
    
    // 播放天气环境音效
    if (profile.ambientType) {
      this.playAmbientSound(profile.ambientType, profile.ambientIntensity);
    }
    
    // 更新 BGM 风格
    if (profile.bgmStyle) {
      this.state.currentBgmStyle = profile.bgmStyle;
    }
    
    this.updateBgmStyle();
  }
  
  /**
   * 处理玩家状态事件
   */
  handlePlayerEvent(event) {
    const { health, stamina, state } = event;
    
    if (health !== undefined) {
      this.state.playerHealth = health;
      
      // 低血量效果
      if (health < 20) {
        this.state.playerState = 'lowHealth';
        this.applyLowHealthEffect();
      }
    }
    
    if (stamina !== undefined) {
      this.state.playerStamina = stamina;
      
      // 体力影响
      if (stamina < 30) {
        this.state.playerState = 'exhausted';
      } else if (stamina > 80) {
        this.state.playerState = 'energized';
      } else {
        this.state.playerState = 'normal';
      }
    }
    
    this.updateBgmStyle();
  }
  
  /**
   * 处理场景切换事件
   */
  handleSceneEvent(event) {
    const { scene } = event;
    
    this.state.previousScene = this.state.currentScene;
    this.state.currentScene = scene;
    
    // 应用场景音频配置
    this.applySceneAudio(scene);
  }
  
  /**
   * 应用场景音频配置
   */
  applySceneAudio(scene) {
    const sceneConfigs = {
      idle: {
        bgmStyle: 'peaceful',
        sfxIntensity: 0.6
      },
      exploration: {
        bgmStyle: 'neutral',
        sfxIntensity: 0.7
      },
      catch_attempt: {
        bgmStyle: 'dynamic',
        sfxIntensity: 0.9
      },
      battle: {
        bgmStyle: 'intense',
        sfxIntensity: 1.0
      },
      gym_battle: {
        bgmStyle: 'intense',
        sfxIntensity: 1.0
      },
      raid: {
        bgmStyle: 'intense',
        sfxIntensity: 1.0,
        reverbMix: 0.6
      },
      social: {
        bgmStyle: 'bright',
        sfxIntensity: 0.5
      },
      shop: {
        bgmStyle: 'bright',
        sfxIntensity: 0.4
      }
    };
    
    const config = sceneConfigs[scene];
    if (config) {
      if (config.bgmStyle) {
        this.state.currentBgmStyle = config.bgmStyle;
      }
      if (config.sfxIntensity) {
        this.targetValues.sfxIntensity = config.sfxIntensity;
      }
      if (config.reverbMix) {
        this.targetValues.reverbMix = config.reverbMix;
      }
      
      this.updateBgmStyle();
    }
  }
  
  /**
   * 更新 BGM 风格
   */
  updateBgmStyle() {
    const style = this.config.bgmStyles[this.state.currentBgmStyle];
    if (!style) return;
    
    // 战斗强度影响
    const battleMultiplier = 1 + (this.state.battleIntensity * 0.5);
    
    // 玩家状态影响
    const playerProfile = this.config.playerStateProfiles[this.state.playerState];
    
    // 计算综合效果
    const energy = style.energy * battleMultiplier * (playerProfile?.audioIntensity || 1);
    const tempo = style.tempo * (playerProfile?.tempoMultiplier || 1);
    
    // 应用频率偏移
    this.applyFrequencyBias(style.frequencyBias, energy);
    
    // 应用节奏调整
    this.applyTempoAdjustment(tempo);
    
    // 更新混响
    this.targetValues.reverbMix = style.reverb * this.userPreferences.intensityMultiplier;
  }
  
  /**
   * 应用频率偏移
   */
  applyFrequencyBias(bias, energy) {
    const baseFreq = 6000;
    
    switch (bias) {
      case 'high':
        // 提升高频（战斗、动态场景）
        this.targetValues.lowpassFreq = baseFreq + energy * 4000;
        this.targetValues.highpassFreq = 100 + energy * 100;
        break;
      case 'low':
        // 提升低频（平静、神秘场景）
        this.targetValues.lowpassFreq = baseFreq - energy * 2000;
        this.targetValues.highpassFreq = 20;
        break;
      case 'balanced':
        // 平衡频率
        this.targetValues.lowpassFreq = baseFreq;
        this.targetValues.highpassFreq = 50;
        break;
    }
  }
  
  /**
   * 应用节奏调整（通过音量波动模拟）
   */
  applyTempoAdjustment(tempo) {
    // 简化实现：通过调整音效播放速率模拟节奏变化
    // 完整实现需要与音乐播放器配合
    if (this.audioManager.musicElement) {
      const baseRate = 1.0;
      const adjustedRate = baseRate + (tempo - 1.0) * 0.2;
      this.audioManager.musicElement.playbackRate = Math.max(0.5, Math.min(2.0, adjustedRate));
    }
  }
  
  /**
   * 应用低血量效果
   */
  applyLowHealthEffect() {
    // 添加心跳音效
    if (!this.heartbeatInterval) {
      this.heartbeatInterval = setInterval(() => {
        this.playHeartbeatSound();
      }, 800);
    }
    
    // 降低音频强度，增加紧张感
    this.targetValues.sfxIntensity = 0.6;
    this.targetValues.reverbMix = 0.7;
  }
  
  /**
   * 播放心跳音效
   */
  playHeartbeatSound() {
    if (this.state.playerHealth > 30) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      return;
    }
    
    // 简化实现：播放预设的心跳音效
    this.audioManager.playSfx('heartbeat', { volume: 0.3 });
  }
  
  /**
   * 播放环境音效
   */
  async playAmbientSound(type, intensity) {
    // 停止当前环境音效
    if (this.currentAmbient) {
      this.stopAmbientSound();
    }
    
    // 环境音效映射
    const ambientSounds = {
      rain: 'ambient_rain',
      wind: 'ambient_wind',
      snow: 'ambient_snow',
      forest: 'ambient_forest',
      city: 'ambient_city'
    };
    
    const soundName = ambientSounds[type];
    if (!soundName) return;
    
    // 创建环境音效播放器（循环播放）
    try {
      this.ambientSource = this.audioManager.context.createBufferSource();
      const buffer = await this.audioManager.loadSound(this.audioManager.getSoundPath(soundName));
      this.ambientSource.buffer = buffer;
      this.ambientSource.loop = true;
      
      // 环境音效增益
      this.ambientGain = this.audioManager.context.createGain();
      this.ambientGain.gain.value = intensity * this.userPreferences.preferredAmbientLevel;
      
      // 连接
      this.ambientSource.connect(this.ambientGain);
      this.ambientGain.connect(this.audioManager.masterGain);
      
      this.ambientSource.start();
      this.currentAmbient = type;
    } catch (error) {
      console.warn('[DynamicAudioAdjuster] Failed to play ambient sound:', error);
    }
  }
  
  /**
   * 停止环境音效
   */
  stopAmbientSound() {
    if (this.ambientSource) {
      this.ambientSource.stop();
      this.ambientSource.disconnect();
      this.ambientSource = null;
    }
    this.currentAmbient = null;
  }
  
  /**
   * 启动平滑过渡定时器
   */
  startSmoothTransition() {
    this.transitionTimer = setInterval(() => {
      this.applySmoothTransition();
    }, 50); // 50ms 更新一次，确保平滑
  }
  
  /**
   * 应用平滑过渡
   */
  applySmoothTransition() {
    const smoothing = this.config.smoothingFactor;
    
    // 平滑过渡各个参数
    for (const [key, target] of Object.entries(this.targetValues)) {
      const current = this.currentValues[key];
      const smoothed = current + (target - current) * smoothing;
      this.currentValues[key] = smoothed;
      
      // 应用到音频处理器
      this.applyValue(key, smoothed);
    }
  }
  
  /**
   * 应用平滑后的值
   */
  applyValue(key, value) {
    switch (key) {
      case 'lowpassFreq':
        if (this.filters.lowpass) {
          this.filters.lowpass.frequency.setTargetAtTime(value, this.audioManager.context.currentTime, 0.1);
        }
        break;
      case 'highpassFreq':
        if (this.filters.highpass) {
          this.filters.highpass.frequency.setTargetAtTime(value, this.audioManager.context.currentTime, 0.1);
        }
        break;
      case 'reverbMix':
        if (this.reverbGain) {
          this.reverbGain.gain.setTargetAtTime(value, this.audioManager.context.currentTime, 0.1);
        }
        break;
      case 'sfxIntensity':
        // 调整音效整体强度
        const baseVolume = this.audioManager.settings.sfxVolume;
        this.audioManager.sfxGain.gain.setTargetAtTime(baseVolume * value, this.audioManager.context.currentTime, 0.1);
        break;
      case 'ambientIntensity':
        if (this.ambientGain) {
          this.ambientGain.gain.setTargetAtTime(value * this.userPreferences.preferredAmbientLevel, this.audioManager.context.currentTime, 0.1);
        }
        break;
    }
  }
  
  /**
   * 更新音频状态（定时任务）
   */
  updateAudioState() {
    // CPU 使用率检查（避免过度消耗）
    if (this.performanceMonitor.cpuUsage > 80) {
      console.warn('[DynamicAudioAdjuster] High CPU usage, reducing update frequency');
      clearInterval(this.updateTimer);
      this.updateTimer = setInterval(() => {
        this.updateAudioState();
      }, this.config.updateInterval * 2);
    }
    
    // 自然衰减战斗强度
    if (this.state.battleIntensity > 0) {
      this.state.battleIntensity *= 0.98;
      if (this.state.battleIntensity < 0.1) {
        this.state.battleIntensity = 0;
      }
    }
    
    // 检查并停止低血量效果
    if (this.state.playerHealth > 30 && this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  /**
   * 用户偏好设置
   */
  setUserPreferences(prefs) {
    this.userPreferences = {
      ...this.userPreferences,
      ...prefs
    };
    
    // 保存到本地存储
    localStorage.setItem('audio_dynamic_prefs', JSON.stringify(this.userPreferences));
    
    // 立即应用
    this.updateBgmStyle();
  }
  
  /**
   * 加载用户偏好
   */
  loadUserPreferences() {
    const saved = localStorage.getItem('audio_dynamic_prefs');
    if (saved) {
      try {
        this.userPreferences = JSON.parse(saved);
      } catch (e) {
        console.warn('[DynamicAudioAdjuster] Failed to load preferences:', e);
      }
    }
  }
  
  /**
   * 获取当前状态报告
   */
  getStatusReport() {
    return {
      enabled: this.config.enabled,
      state: {
        battleIntensity: this.state.battleIntensity,
        weather: this.state.weather,
        playerState: this.state.playerState,
        currentScene: this.state.currentScene,
        bgmStyle: this.state.currentBgmStyle
      },
      audio: {
        lowpassFreq: this.currentValues.lowpassFreq,
        highpassFreq: this.currentValues.highpassFreq,
        reverbMix: this.currentValues.reverbMix,
        sfxIntensity: this.currentValues.sfxIntensity,
        ambientIntensity: this.currentValues.ambientIntensity,
        currentAmbient: this.currentAmbient
      },
      performance: this.performanceMonitor,
      userPreferences: this.userPreferences
    };
  }
  
  /**
   * 重置为默认状态
   */
  reset() {
    this.state = {
      battleIntensity: 0,
      weather: 'clear',
      playerHealth: 100,
      playerStamina: 100,
      playerState: 'normal',
      currentScene: 'idle',
      previousScene: null,
      currentBgmStyle: 'neutral',
      lastUpdate: Date.now()
    };
    
    this.targetValues = {
      lowpassFreq: 8000,
      highpassFreq: 20,
      reverbMix: 0.3,
      sfxIntensity: 1.0,
      ambientIntensity: 0.2
    };
    
    this.stopAmbientSound();
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  /**
   * 启用/禁用动态调节
   */
  setEnabled(enabled) {
    this.config.enabled = enabled;
    this.userPreferences.dynamicAdjustmentEnabled = enabled;
    
    if (!enabled) {
      this.reset();
      // 恢复默认音频参数
      this.audioManager.sfxGain.gain.value = this.audioManager.settings.sfxVolume;
    }
    
    localStorage.setItem('audio_dynamic_prefs', JSON.stringify(this.userPreferences));
  }
  
  /**
   * 销毁
   */
  destroy() {
    // 清理定时器
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
    if (this.transitionTimer) {
      clearInterval(this.transitionTimer);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // 停止环境音效
    this.stopAmbientSound();
    
    // 移除事件监听
    if (window.gameEvents) {
      for (const [eventType, handler] of this.stateListeners) {
        window.gameEvents.off(eventType, handler);
      }
    }
    
    // 断开滤波器
    if (this.filters.lowpass) {
      this.filters.lowpass.disconnect();
    }
    if (this.filters.highpass) {
      this.filters.highpass.disconnect();
    }
    if (this.reverbNode) {
      this.reverbNode.disconnect();
    }
    if (this.reverbGain) {
      this.reverbGain.disconnect();
    }
    
    console.log('[DynamicAudioAdjuster] Destroyed');
  }
}

// 导出
export { DynamicAudioAdjuster };
export default DynamicAudioAdjuster;