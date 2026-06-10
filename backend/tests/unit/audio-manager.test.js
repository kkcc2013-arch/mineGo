/**
 * AudioManager Unit Tests
 * 音频管理器单元测试
 */

const { AudioManager } = require('./AudioManager.js');

// Mock Web Audio API
class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
  }
  
  createGain() {
    return {
      gain: { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
      connect: () => {}
    };
  }
  
  createBufferSource() {
    return {
      buffer: null,
      loop: false,
      playbackRate: { value: 1 },
      onended: null,
      connect: () => {},
      start: () => {},
      stop: () => {}
    };
  }
  
  createStereoPanner() {
    return {
      pan: { value: 0 },
      connect: () => {}
    };
  }
  
  async decodeAudioData(buffer) {
    return { duration: 1.0 };
  }
  
  suspend() {
    this.state = 'suspended';
  }
  
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  
  close() {
    this.state = 'closed';
  }
}

// Mock localStorage
const mockLocalStorage = {
  store: {},
  getItem(key) {
    return this.store[key] || null;
  },
  setItem(key, value) {
    this.store[key] = value;
  },
  clear() {
    this.store = {};
  }
};

global.localStorage = mockLocalStorage;

// Mock fetch
global.fetch = jest.fn((path) => {
  return Promise.resolve({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024))
  });
});

// Mock AudioContext
global.AudioContext = MockAudioContext;
global.webkitAudioContext = MockAudioContext;

describe('AudioManager', () => {
  let audioManager;
  
  beforeEach(() => {
    audioManager = new AudioManager();
    mockLocalStorage.clear();
    jest.clearAllMocks();
  });
  
  afterEach(() => {
    if (audioManager.initialized) {
      audioManager.dispose();
    }
  });
  
  describe('Initialization', () => {
    test('should initialize successfully', async () => {
      const result = await audioManager.init();
      
      expect(result).toBe(true);
      expect(audioManager.initialized).toBe(true);
      expect(audioManager.context).toBeDefined();
      expect(audioManager.masterGain).toBeDefined();
      expect(audioManager.musicGain).toBeDefined();
      expect(audioManager.sfxGain).toBeDefined();
    });
    
    test('should not initialize twice', async () => {
      await audioManager.init();
      const result = await audioManager.init();
      
      expect(result).toBe(true);
    });
    
    test('should unlock audio context', async () => {
      await audioManager.init();
      audioManager.context.state = 'suspended';
      
      await audioManager.unlock();
      
      expect(audioManager.unlocked).toBe(true);
      expect(audioManager.context.state).toBe('running');
    });
  });
  
  describe('Volume Control', () => {
    beforeEach(async () => {
      await audioManager.init();
    });
    
    test('should set master volume', () => {
      audioManager.setMasterVolume(0.5);
      
      expect(audioManager.masterVolume).toBe(0.5);
      expect(audioManager.masterGain.gain.value).toBe(0.5);
    });
    
    test('should clamp volume to 0-1 range', () => {
      audioManager.setMasterVolume(1.5);
      expect(audioManager.masterVolume).toBe(1);
      
      audioManager.setMasterVolume(-0.5);
      expect(audioManager.masterVolume).toBe(0);
    });
    
    test('should set music volume', () => {
      audioManager.setMusicVolume(0.7);
      
      expect(audioManager.musicVolume).toBe(0.7);
      expect(audioManager.musicGain.gain.value).toBe(0.7);
    });
    
    test('should set sfx volume', () => {
      audioManager.setSfxVolume(0.8);
      
      expect(audioManager.sfxVolume).toBe(0.8);
      expect(audioManager.sfxGain.gain.value).toBe(0.8);
    });
  });
  
  describe('Mute Control', () => {
    beforeEach(async () => {
      await audioManager.init();
    });
    
    test('should toggle mute', () => {
      const initialMuted = audioManager.muted;
      
      audioManager.toggleMute();
      
      expect(audioManager.muted).toBe(!initialMuted);
    });
    
    test('should set muted state', () => {
      audioManager.setMuted(true);
      
      expect(audioManager.muted).toBe(true);
      expect(audioManager.masterGain.gain.value).toBe(0);
    });
    
    test('should restore volume when unmuting', () => {
      audioManager.setMasterVolume(0.6);
      audioManager.setMuted(true);
      audioManager.setMuted(false);
      
      expect(audioManager.masterGain.gain.value).toBe(0.6);
    });
  });
  
  describe('Sound Effects', () => {
    beforeEach(async () => {
      await audioManager.init();
      audioManager.unlocked = true;
    });
    
    test('should play sound effect', async () => {
      await audioManager.playSfx('ui_click');
      
      expect(audioManager.activeSounds.length).toBeGreaterThan(0);
    });
    
    test('should not play sound when sfx disabled', async () => {
      audioManager.setSfxEnabled(false);
      
      await audioManager.playSfx('ui_click');
      
      expect(audioManager.activeSounds.length).toBe(0);
    });
    
    test('should not play sound when muted', async () => {
      audioManager.setMuted(true);
      
      await audioManager.playSfx('ui_click');
      
      expect(audioManager.activeSounds.length).toBe(0);
    });
    
    test('should respect concurrent sound limit', async () => {
      // Play more sounds than the limit
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(audioManager.playSfx('ui_click'));
      }
      await Promise.all(promises);
      
      expect(audioManager.activeSounds.length).toBeLessThanOrEqual(audioManager.maxConcurrentSounds);
    });
    
    test('should apply volume option', async () => {
      const volume = 0.5;
      
      await audioManager.playSfx('ui_click', { volume });
      
      // Sound should be played with custom volume
      expect(audioManager.activeSounds.length).toBeGreaterThan(0);
    });
    
    test('should apply playback rate option', async () => {
      const rate = 1.5;
      
      await audioManager.playSfx('ui_click', { rate });
      
      expect(audioManager.activeSounds.length).toBeGreaterThan(0);
    });
  });
  
  describe('Background Music', () => {
    beforeEach(async () => {
      await audioManager.init();
      audioManager.unlocked = true;
    });
    
    test('should play background music', async () => {
      await audioManager.playMusic('login');
      
      expect(audioManager.currentMusic).toBe('login');
      expect(audioManager.musicSource).toBeDefined();
    });
    
    test('should not play music when music disabled', async () => {
      audioManager.setMusicEnabled(false);
      
      await audioManager.playMusic('login');
      
      expect(audioManager.currentMusic).toBeNull();
    });
    
    test('should stop current music when playing new music', async () => {
      await audioManager.playMusic('login', { fade: false });
      await audioManager.playMusic('map_day', { fade: false });
      
      expect(audioManager.currentMusic).toBe('map_day');
    });
    
    test('should pause music', () => {
      audioManager.pauseMusic();
      
      expect(audioManager.context.state).toBe('suspended');
    });
    
    test('should resume music', async () => {
      audioManager.pauseMusic();
      await audioManager.resumeMusic();
      
      expect(audioManager.context.state).toBe('running');
    });
    
    test('should stop music', async () => {
      await audioManager.playMusic('login', { fade: false });
      audioManager.stopMusic();
      
      expect(audioManager.currentMusic).toBeNull();
      expect(audioManager.musicSource).toBeNull();
    });
  });
  
  describe('Scene Transition', () => {
    beforeEach(async () => {
      await audioManager.init();
      audioManager.unlocked = true;
    });
    
    test('should transition to login scene', async () => {
      await audioManager.transitionToScene('login');
      
      expect(audioManager.currentScene).toBe('login');
      expect(audioManager.currentMusic).toBe('login');
    });
    
    test('should transition to map scene (day)', async () => {
      // Mock daytime
      const originalDate = Date;
      global.Date = class extends Date {
        getHours() {
          return 12; // Noon
        }
      };
      
      await audioManager.transitionToScene('map');
      
      expect(audioManager.currentScene).toBe('map');
      expect(audioManager.currentMusic).toBe('map_day');
      
      global.Date = originalDate;
    });
    
    test('should transition to map scene (night)', async () => {
      // Mock nighttime
      const originalDate = Date;
      global.Date = class extends Date {
        getHours() {
          return 22; // 10 PM
        }
      };
      
      await audioManager.transitionToScene('map');
      
      expect(audioManager.currentScene).toBe('map');
      expect(audioManager.currentMusic).toBe('map_night');
      
      global.Date = originalDate;
    });
    
    test('should not transition to same scene', async () => {
      await audioManager.transitionToScene('login');
      await audioManager.transitionToScene('login');
      
      // Should only play music once
      expect(audioManager.currentMusic).toBe('login');
    });
  });
  
  describe('Preloading', () => {
    beforeEach(async () => {
      await audioManager.init();
    });
    
    test('should preload sounds', async () => {
      const sounds = ['ui_click', 'ui_back', 'ui_notification'];
      
      await audioManager.preloadSounds(sounds);
      
      sounds.forEach(sound => {
        expect(audioManager.preloadedSounds.has(sound)).toBe(true);
      });
    });
    
    test('should not preload already loaded sounds', async () => {
      await audioManager.preloadSounds(['ui_click']);
      
      const initialSize = audioManager.preloadedSounds.size;
      
      await audioManager.preloadSounds(['ui_click']);
      
      expect(audioManager.preloadedSounds.size).toBe(initialSize);
    });
  });
  
  describe('Settings Persistence', () => {
    beforeEach(async () => {
      await audioManager.init();
    });
    
    test('should save settings to localStorage', () => {
      audioManager.setMasterVolume(0.7);
      audioManager.setMusicVolume(0.5);
      audioManager.setSfxVolume(0.9);
      
      const saved = JSON.parse(mockLocalStorage.getItem('audioSettings'));
      
      expect(saved.masterVolume).toBe(0.7);
      expect(saved.musicVolume).toBe(0.5);
      expect(saved.sfxVolume).toBe(0.9);
    });
    
    test('should load settings from localStorage', () => {
      const settings = {
        masterVolume: 0.6,
        musicVolume: 0.4,
        sfxVolume: 0.8,
        musicEnabled: false,
        sfxEnabled: true,
        muted: true
      };
      
      mockLocalStorage.setItem('audioSettings', JSON.stringify(settings));
      
      const newManager = new AudioManager();
      const loaded = newManager.loadSettings();
      
      expect(loaded.masterVolume).toBe(0.6);
      expect(loaded.musicVolume).toBe(0.4);
      expect(loaded.sfxVolume).toBe(0.8);
      expect(loaded.musicEnabled).toBe(false);
      expect(loaded.sfxEnabled).toBe(true);
      expect(loaded.muted).toBe(true);
    });
    
    test('should apply settings on initialization', async () => {
      const settings = {
        masterVolume: 0.5,
        musicVolume: 0.3,
        sfxVolume: 0.7,
        musicEnabled: true,
        sfxEnabled: false,
        muted: false
      };
      
      mockLocalStorage.setItem('audioSettings', JSON.stringify(settings));
      
      const newManager = new AudioManager();
      await newManager.init();
      
      expect(newManager.masterVolume).toBe(0.5);
      expect(newManager.musicVolume).toBe(0.3);
      expect(newManager.sfxVolume).toBe(0.7);
      expect(newManager.musicEnabled).toBe(true);
      expect(newManager.sfxEnabled).toBe(false);
      
      newManager.dispose();
    });
  });
  
  describe('Cleanup', () => {
    test('should dispose resources', async () => {
      await audioManager.init();
      audioManager.unlocked = true;
      await audioManager.playSfx('ui_click');
      await audioManager.playMusic('login', { fade: false });
      
      audioManager.dispose();
      
      expect(audioManager.initialized).toBe(false);
      expect(audioManager.unlocked).toBe(false);
      expect(audioManager.activeSounds.length).toBe(0);
      expect(audioManager.currentMusic).toBeNull();
    });
  });
  
  describe('Edge Cases', () => {
    test('should handle invalid sound name', async () => {
      await audioManager.init();
      audioManager.unlocked = true;
      
      await audioManager.playSfx('invalid_sound');
      
      expect(audioManager.activeSounds.length).toBe(0);
    });
    
    test('should handle invalid music name', async () => {
      await audioManager.init();
      audioManager.unlocked = true;
      
      await audioManager.playMusic('invalid_music');
      
      expect(audioManager.currentMusic).toBeNull();
    });
    
    test('should handle play before initialization', async () => {
      await audioManager.playSfx('ui_click');
      
      expect(audioManager.activeSounds.length).toBe(0);
    });
  });
});

// 导出测试
module.exports = {
  MockAudioContext,
  mockLocalStorage
};
