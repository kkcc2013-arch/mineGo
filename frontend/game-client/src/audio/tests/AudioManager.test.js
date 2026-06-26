/**
 * AudioManager 单元测试
 */

const assert = require('assert');
const { AudioManager, getAudioManager } = require('./AudioManager');

// Mock AudioContext
class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.destination = {};
  }

  createGain() {
    return {
      gain: { value: 1 },
      connect: () => {}
    };
  }

  createBufferSource() {
    return {
      buffer: null,
      connect: () => {},
      start: () => {},
      onended: null
    };
  }

  decodeAudioData(buffer) {
    return Promise.resolve({});
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

// Mock Audio
global.AudioContext = MockAudioContext;
global.webkitAudioContext = MockAudioContext;

// Mock localStorage
const localStorageMock = {
  store: {},
  getItem(key) {
    return this.store[key] || null;
  },
  setItem(key, value) {
    this.store[key] = value;
  },
  removeItem(key) {
    delete this.store[key];
  },
  clear() {
    this.store = {};
  }
};
global.localStorage = localStorageMock;

// Mock fetch
global.fetch = () => Promise.resolve({
  ok: true,
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
});

// Mock document
global.document = {
  addEventListener: () => {},
  removeEventListener: () => {}
};

describe('AudioManager', () => {
  let audioManager;

  beforeEach(() => {
    // 重置单例
    audioManagerInstance = null;
    audioManager = getAudioManager();
    localStorageMock.clear();
  });

  describe('初始化', () => {
    it('应该成功初始化', async () => {
      await audioManager.init();
      assert.strictEqual(audioManager.initialized, true);
      assert.ok(audioManager.context);
      assert.ok(audioManager.masterGain);
      assert.ok(audioManager.musicGain);
      assert.ok(audioManager.sfxGain);
    });

    it('重复初始化应该被忽略', async () => {
      await audioManager.init();
      const context1 = audioManager.context;
      
      await audioManager.init();
      const context2 = audioManager.context;
      
      assert.strictEqual(context1, context2);
    });
  });

  describe('音量控制', () => {
    beforeEach(async () => {
      await audioManager.init();
    });

    it('应该正确设置主音量', () => {
      audioManager.setMasterVolume(0.5);
      assert.strictEqual(audioManager.settings.masterVolume, 0.5);
    });

    it('应该限制音量范围在 0-1', () => {
      audioManager.setMasterVolume(1.5);
      assert.strictEqual(audioManager.settings.masterVolume, 1);

      audioManager.setMasterVolume(-0.5);
      assert.strictEqual(audioManager.settings.masterVolume, 0);
    });

    it('应该正确设置音乐音量', () => {
      audioManager.setMusicVolume(0.7);
      assert.strictEqual(audioManager.settings.musicVolume, 0.7);
    });

    it('应该正确设置音效音量', () => {
      audioManager.setSfxVolume(0.9);
      assert.strictEqual(audioManager.settings.sfxVolume, 0.9);
    });

    it('设置应该持久化到 localStorage', () => {
      audioManager.setMasterVolume(0.8);
      const saved = JSON.parse(localStorageMock.getItem('audioSettings'));
      assert.strictEqual(saved.masterVolume, 0.8);
    });
  });

  describe('静音控制', () => {
    beforeEach(async () => {
      await audioManager.init();
    });

    it('应该正确切换全局静音', () => {
      const muted = audioManager.toggleMute();
      assert.strictEqual(audioManager.settings.muted, true);
      assert.strictEqual(muted, true);

      const muted2 = audioManager.toggleMute();
      assert.strictEqual(audioManager.settings.muted, false);
      assert.strictEqual(muted2, false);
    });

    it('应该正确切换音乐静音', () => {
      const muted = audioManager.toggleMusicMute();
      assert.strictEqual(audioManager.settings.musicMuted, true);
      assert.strictEqual(muted, true);
    });

    it('应该正确切换音效静音', () => {
      const muted = audioManager.toggleSfxMute();
      assert.strictEqual(audioManager.settings.sfxMuted, true);
      assert.strictEqual(muted, true);
    });
  });

  describe('设置加载', () => {
    it('应该从 localStorage 加载设置', () => {
      const savedSettings = {
        masterVolume: 0.6,
        musicVolume: 0.4,
        sfxVolume: 0.8,
        muted: false,
        musicMuted: false,
        sfxMuted: false
      };
      localStorageMock.setItem('audioSettings', JSON.stringify(savedSettings));

      const newManager = new AudioManager();
      assert.deepStrictEqual(newManager.settings, savedSettings);
    });

    it('无保存设置时应该使用默认值', () => {
      const settings = audioManager.settings;
      assert.strictEqual(settings.masterVolume, 0.8);
      assert.strictEqual(settings.musicVolume, 0.6);
      assert.strictEqual(settings.sfxVolume, 1.0);
    });
  });

  describe('场景切换', () => {
    beforeEach(async () => {
      await audioManager.init();
    });

    it('应该正确切换场景', () => {
      audioManager.transitionToScene('login');
      assert.strictEqual(audioManager.currentScene, 'login');
    });

    it('重复切换同一场景应该被忽略', () => {
      audioManager.transitionToScene('map');
      const scene1 = audioManager.currentScene;
      
      audioManager.transitionToScene('map');
      const scene2 = audioManager.currentScene;
      
      assert.strictEqual(scene1, scene2);
    });
  });

  describe('状态查询', () => {
    beforeEach(async () => {
      await audioManager.init();
    });

    it('应该返回正确的状态信息', () => {
      const status = audioManager.getStatus();
      
      assert.strictEqual(status.initialized, true);
      assert.ok('settings' in status);
      assert.ok('activeSounds' in status);
      assert.ok('soundPoolSize' in status);
    });
  });

  describe('单例模式', () => {
    it('应该返回同一个实例', () => {
      const instance1 = getAudioManager();
      const instance2 = getAudioManager();
      
      assert.strictEqual(instance1, instance2);
    });
  });
});

describe('SoundPool', () => {
  const SoundPool = require('./SoundPool');
  let soundPool;

  beforeEach(() => {
    soundPool = new SoundPool(10);
  });

  it('应该正确设置和获取音效', () => {
    soundPool.set('test', {});
    assert.ok(soundPool.has('test'));
    assert.ok(soundPool.get('test'));
  });

  it('应该删除音效', () => {
    soundPool.set('test', {});
    soundPool.delete('test');
    assert.ok(!soundPool.has('test'));
  });

  it('应该清空池', () => {
    soundPool.set('test1', {});
    soundPool.set('test2', {});
    soundPool.clear();
    assert.strictEqual(soundPool.size(), 0);
  });

  it('应该限制池大小', () => {
    for (let i = 0; i < 15; i++) {
      soundPool.set(`sound_${i}`, {});
    }
    assert.strictEqual(soundPool.size(), 10);
  });
});

// 运行测试
if (require.main === module) {
  console.log('Running AudioManager tests...');
  // 实际运行时使用测试框架（如 Mocha）
}
