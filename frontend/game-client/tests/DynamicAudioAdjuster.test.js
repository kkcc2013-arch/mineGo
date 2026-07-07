/**
 * REQ-00470: 动态音效调节系统单元测试
 */

import { DynamicAudioAdjuster } from '../src/audio/DynamicAudioAdjuster.js';

// Mock AudioManager
class MockAudioManager {
  constructor() {
    this.initialized = false;
    this.context = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.settings = {
      masterVolume: 0.8,
      musicVolume: 0.6,
      sfxVolume: 0.7
    };
  }
  
  async init() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContext();
    
    this.masterGain = this.context.createGain();
    this.sfxGain = this.context.createGain();
    this.musicGain = this.context.createGain();
    
    this.masterGain.connect(this.context.destination);
    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    
    this.initialized = true;
  }
  
  async loadSound(path) {
    // Mock implementation
    const length = this.context.sampleRate * 2;
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    return buffer;
  }
  
  async playSfx(name, options = {}) {
    // Mock implementation
    return true;
  }
  
  getSoundPath(name) {
    return `/sounds/${name}.mp3`;
  }
}

describe('DynamicAudioAdjuster', () => {
  let adjuster;
  let audioManager;
  
  beforeAll(async () => {
    audioManager = new MockAudioManager();
    await audioManager.init();
  });
  
  afterAll(() => {
    if (audioManager && audioManager.context) {
      audioManager.context.close();
    }
  });
  
  beforeEach(() => {
    adjuster = new DynamicAudioAdjuster(audioManager);
  });
  
  afterEach(() => {
    if (adjuster) {
      adjuster.destroy();
    }
  });
  
  describe('Initialization', () => {
    test('should initialize without errors', async () => {
      await expect(adjuster.init()).resolves.not.toThrow();
    });
    
    test('should create audio filters', async () => {
      await adjuster.init();
      
      expect(adjuster.filters.lowpass).toBeDefined();
      expect(adjuster.filters.highpass).toBeDefined();
      expect(adjuster.reverbNode).toBeDefined();
    });
    
    test('should set initial state correctly', () => {
      expect(adjuster.state.battleIntensity).toBe(0);
      expect(adjuster.state.weather).toBe('clear');
      expect(adjuster.state.playerState).toBe('normal');
    });
  });
  
  describe('Battle Events', () => {
    beforeEach(async () => {
      await adjuster.init();
    });
    
    test('should increase intensity on battle start', () => {
      adjuster.handleBattleEvent({ type: 'battle_start', data: {} });
      
      expect(adjuster.state.battleIntensity).toBe(0.5);
    });
    
    test('should increase intensity on critical hit', () => {
      adjuster.handleBattleEvent({ type: 'critical_hit', data: {} });
      
      expect(adjuster.state.battleIntensity).toBeGreaterThan(0);
    });
    
    test('should increase intensity on combo', () => {
      adjuster.handleBattleEvent({ type: 'combo', data: {} });
      
      expect(adjuster.state.battleIntensity).toBeGreaterThan(0);
    });
    
    test('should reset intensity on battle end', () => {
      adjuster.state.battleIntensity = 0.8;
      adjuster.handleBattleEvent({ type: 'battle_end', data: {} });
      
      expect(adjuster.state.battleIntensity).toBe(0);
    });
    
    test('should not exceed maximum intensity', () => {
      for (let i = 0; i < 10; i++) {
        adjuster.handleBattleEvent({ type: 'critical_hit', data: {} });
      }
      
      expect(adjuster.state.battleIntensity).toBeLessThanOrEqual(1.0);
    });
  });
  
  describe('Weather Events', () => {
    beforeEach(async () => {
      await adjuster.init();
    });
    
    test('should apply weather profile', () => {
      adjuster.handleWeatherEvent({ weather: 'rain', intensity: 1.0 });
      
      expect(adjuster.state.weather).toBe('rain');
      expect(adjuster.targetValues.lowpassFreq).toBe(4000);
    });
    
    test('should update BGM style based on weather', () => {
      adjuster.handleWeatherEvent({ weather: 'thunderstorm', intensity: 1.0 });
      
      expect(adjuster.state.currentBgmStyle).toBe('intense');
    });
    
    test('should set ambient sound type', () => {
      adjuster.handleWeatherEvent({ weather: 'rain', intensity: 0.8 });
      
      expect(adjuster.targetValues.ambientIntensity).toBe(0.4); // 0.5 * 0.8
    });
  });
  
  describe('Player State Events', () => {
    beforeEach(async () => {
      await adjuster.init();
    });
    
    test('should update player health', () => {
      adjuster.handlePlayerEvent({ health: 50 });
      
      expect(adjuster.state.playerHealth).toBe(50);
    });
    
    test('should set low health state', () => {
      adjuster.handlePlayerEvent({ health: 15 });
      
      expect(adjuster.state.playerState).toBe('lowHealth');
    });
    
    test('should trigger low health effect', () => {
      adjuster.handlePlayerEvent({ health: 15 });
      
      expect(adjuster.heartbeatInterval).toBeDefined();
    });
    
    test('should update player stamina', () => {
      adjuster.handlePlayerEvent({ stamina: 20 });
      
      expect(adjuster.state.playerStamina).toBe(20);
      expect(adjuster.state.playerState).toBe('exhausted');
    });
  });
  
  describe('Scene Events', () => {
    beforeEach(async () => {
      await adjuster.init();
    });
    
    test('should update current scene', () => {
      adjuster.handleSceneEvent({ scene: 'battle' });
      
      expect(adjuster.state.currentScene).toBe('battle');
    });
    
    test('should apply scene audio config', () => {
      adjuster.handleSceneEvent({ scene: 'battle' });
      
      expect(adjuster.state.currentBgmStyle).toBe('intense');
      expect(adjuster.targetValues.sfxIntensity).toBe(1.0);
    });
  });
  
  describe('Smooth Transitions', () => {
    beforeEach(async () => {
      await adjuster.init();
    });
    
    test('should smooth transition values', (done) => {
      adjuster.targetValues.lowpassFreq = 4000;
      adjuster.currentValues.lowpassFreq = 8000;
      
      setTimeout(() => {
        const current = adjuster.currentValues.lowpassFreq;
        expect(current).toBeGreaterThan(4000);
        expect(current).toBeLessThan(8000);
        done();
      }, 200);
    });
    
    test('should apply smoothing factor', () => {
      const smoothing = adjuster.config.smoothingFactor;
      expect(smoothing).toBeGreaterThan(0);
      expect(smoothing).toBeLessThan(1);
    });
  });
  
  describe('User Preferences', () => {
    beforeEach(async () => {
      await adjuster.init();
    });
    
    test('should update user preferences', () => {
      adjuster.setUserPreferences({
        intensityMultiplier: 1.5,
        preferredAmbientLevel: 0.7
      });
      
      expect(adjuster.userPreferences.intensityMultiplier).toBe(1.5);
      expect(adjuster.userPreferences.preferredAmbientLevel).toBe(0.7);
    });
    
    test('should enable/disable dynamic adjustment', () => {
      adjuster.setEnabled(false);
      
      expect(adjuster.config.enabled).toBe(false);
      expect(adjuster.userPreferences.dynamicAdjustmentEnabled).toBe(false);
    });
    
    test('should load saved preferences', () => {
      localStorage.setItem('audio_dynamic_prefs', JSON.stringify({
        intensityMultiplier: 1.2
      }));
      
      adjuster.loadUserPreferences();
      
      expect(adjuster.userPreferences.intensityMultiplier).toBe(1.2);
    });
  });
  
  describe('Status Report', () => {
    beforeEach(async () => {
      await adjuster.init();
    });
    
    test('should return status report', () => {
      const report = adjuster.getStatusReport();
      
      expect(report).toHaveProperty('enabled');
      expect(report).toHaveProperty('state');
      expect(report).toHaveProperty('audio');
      expect(report).toHaveProperty('performance');
    });
    
    test('should include current audio values in report', () => {
      const report = adjuster.getStatusReport();
      
      expect(report.audio).toHaveProperty('lowpassFreq');
      expect(report.audio).toHaveProperty('reverbMix');
    });
  });
  
  describe('Reset', () => {
    beforeEach(async () => {
      await adjuster.init();
    });
    
    test('should reset to default state', () => {
      adjuster.state.battleIntensity = 0.8;
      adjuster.state.weather = 'rain';
      
      adjuster.reset();
      
      expect(adjuster.state.battleIntensity).toBe(0);
      expect(adjuster.state.weather).toBe('clear');
    });
    
    test('should stop ambient sound on reset', () => {
      adjuster.currentAmbient = 'rain';
      adjuster.ambientSource = {};
      
      adjuster.reset();
      
      expect(adjuster.currentAmbient).toBeNull();
    });
  });
  
  describe('Performance', () => {
    beforeEach(async () => {
      await adjuster.init();
    });
    
    test('should not cause performance issues with many events', () => {
      const start = performance.now();
      
      for (let i = 0; i < 1000; i++) {
        adjuster.handleBattleEvent({ type: 'battle_action', data: { damage: 50 } });
        adjuster.updateBgmStyle();
      }
      
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(100); // 应该在 100ms 内完成
    });
    
    test('should track update count', (done) => {
      const initialCount = adjuster.performanceMonitor.updateCount;
      
      setTimeout(() => {
        expect(adjuster.performanceMonitor.updateCount).toBeGreaterThan(initialCount);
        done();
      }, 1500);
    });
  });
  
  describe('Cleanup', () => {
    test('should destroy without errors', async () => {
      await adjuster.init();
      
      expect(() => adjuster.destroy()).not.toThrow();
    });
    
    test('should clear intervals on destroy', async () => {
      await adjuster.init();
      
      adjuster.destroy();
      
      expect(adjuster.updateTimer).toBeUndefined();
      expect(adjuster.transitionTimer).toBeUndefined();
    });
    
    test('should disconnect filters on destroy', async () => {
      await adjuster.init();
      
      adjuster.destroy();
      
      // 过滤器应该已断开连接
      expect(() => adjuster.filters.lowpass.frequency.value).toThrow();
    });
  });
});

// 运行测试
console.log('[Test] DynamicAudioAdjuster tests loaded');
