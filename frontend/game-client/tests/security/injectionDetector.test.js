/**
 * InjectionDetector 单元测试
 * REQ-00503: 游戏客户端注入工具检测与防护系统
 */

const { InjectionDetector, injectionDetector } = require('../../src/security/InjectionDetector.js');

// Mock Native Bridge for testing
const mockAndroidBridge = {
  getProcessList: jest.fn(),
  checkPort: jest.fn(),
  fileExists: jest.fn(),
  getInstalledPackages: jest.fn(),
  getApplicationPath: jest.fn()
};

// Mock fetch for testing
global.fetch = jest.fn();

// Mock localStorage
const localStorageMock = {
  store: {},
  getItem: jest.fn((key) => localStorageMock.store[key]),
  setItem: jest.fn((key, value) => localStorageMock.store[key] = value),
  removeItem: jest.fn((key) => delete localStorageMock.store[key]),
  clear: jest.fn(() => localStorageMock.store = {})
};
global.localStorage = localStorageMock;

describe('InjectionDetector', () => {
  let detector;

  beforeEach(() => {
    detector = new InjectionDetector();
    jest.clearAllMocks();
    
    // Reset mock Android Bridge
    if (typeof window !== 'undefined') {
      window.androidBridge = mockAndroidBridge;
    }
  });

  afterEach(() => {
    detector.destroy();
  });

  describe('Initialization', () => {
    test('should initialize successfully', async () => {
      const result = await detector.init();
      
      expect(result.success).toBe(true);
      expect(result.deviceId).toBeDefined();
      expect(detector.initialized).toBe(true);
    });

    test('should get device ID after initialization', async () => {
      await detector.init();
      
      const deviceId = detector.getDeviceId();
      expect(deviceId).toBeDefined();
      expect(deviceId).toMatch(/^device_[a-f0-9]+$/);
    });

    test('should return status correctly', async () => {
      await detector.init();
      
      const status = detector.getStatus();
      
      expect(status.initialized).toBe(true);
      expect(status.platform).toBeDefined();
      expect(status.stats).toBeDefined();
    });
  });

  describe('Frida Detection', () => {
    test('should detect Frida process', async () => {
      mockAndroidBridge.getProcessList.mockResolvedValue([
        { pid: 1234, name: 'frida-server' }
      ]);
      
      const result = await detector.detectFrida();
      
      expect(result.detected).toBe(true);
      expect(result.tool).toBe('Frida');
      expect(result.indicators.length).toBeGreaterThan(0);
      expect(result.indicators[0].type).toBe('process');
    });

    test('should detect Frida port 27042', async () => {
      mockAndroidBridge.getProcessList.mockResolvedValue([]);
      mockAndroidBridge.checkPort.mockResolvedValue({ open: true });
      
      const result = await detector.detectFrida();
      
      expect(result.detected).toBe(true);
      expect(result.indicators.find(i => i.type === 'port')).toBeDefined();
    });

    test('should detect Frida file', async () => {
      mockAndroidBridge.getProcessList.mockResolvedValue([]);
      mockAndroidBridge.checkPort.mockResolvedValue({ open: false });
      mockAndroidBridge.fileExists.mockResolvedValue(true);
      
      const result = await detector.detectFrida();
      
      expect(result.detected).toBe(true);
      expect(result.indicators.find(i => i.type === 'file')).toBeDefined();
    });

    test('should return no detection when clean', async () => {
      mockAndroidBridge.getProcessList.mockResolvedValue([]);
      mockAndroidBridge.checkPort.mockResolvedValue({ open: false });
      mockAndroidBridge.fileExists.mockResolvedValue(false);
      
      const result = await detector.detectFrida();
      
      expect(result.detected).toBe(false);
      expect(result.indicators.length).toBe(0);
    });
  });

  describe('Xposed Detection', () => {
    test('should detect Xposed files', async () => {
      mockAndroidBridge.fileExists.mockImplementation((path) => {
        if (path.includes('XposedBridge')) return Promise.resolve(true);
        return Promise.resolve(false);
      });
      
      const result = await detector.detectXposed();
      
      expect(result.detected).toBe(true);
      expect(result.indicators.find(i => i.type === 'file')).toBeDefined();
    });

    test('should detect Xposed API in window', async () => {
      global.window = { XposedBridge: {} };
      
      const result = await detector.detectXposed();
      
      expect(result.detected).toBe(true);
      expect(result.indicators.find(i => i.type === 'api')).toBeDefined();
      
      global.window = undefined;
    });

    test('should detect VirtualXposed environment', async () => {
      mockAndroidBridge.fileExists.mockResolvedValue(true);
      mockAndroidBridge.getInstalledPackages.mockResolvedValue(['io.va.exposed']);
      
      const result = await detector.detectXposed();
      
      expect(result.detected).toBe(true);
      expect(result.isVirtual).toBe(true);
    });
  });

  describe('GameGuardian Detection', () => {
    test('should detect GameGuardian process', async () => {
      mockAndroidBridge.getProcessList.mockResolvedValue([
        { pid: 5678, name: 'gameguardian.android' }
      ]);
      
      const result = await detector.detectGameGuardian();
      
      expect(result.detected).toBe(true);
      expect(result.tool).toBe('GameGuardian');
      expect(result.indicators[0].type).toBe('process');
    });

    test('should not detect when no GameGuardian', async () => {
      mockAndroidBridge.getProcessList.mockResolvedValue([
        { pid: 100, name: 'com.minego.game' }
      ]);
      
      const result = await detector.detectGameGuardian();
      
      expect(result.detected).toBe(false);
    });
  });

  describe('Virtual Environment Detection', () => {
    test('should detect VirtualXposed package', async () => {
      mockAndroidBridge.getInstalledPackages.mockResolvedValue(['io.va.exposed', 'com.minego.game']);
      
      const result = await detector.detectVirtualEnvironment();
      
      expect(result.detected).toBe(true);
      expect(result.severity).toBe('critical');
      expect(result.indicators.find(i => i.type === 'package')).toBeDefined();
    });

    test('should detect virtual path', async () => {
      mockAndroidBridge.getInstalledPackages.mockResolvedValue(['com.minego.game']);
      mockAndroidBridge.getApplicationPath.mockResolvedValue('/data/app/virtual/com.minego.game');
      
      const result = await detector.detectVirtualEnvironment();
      
      expect(result.detected).toBe(true);
      expect(result.indicators.find(i => i.type === 'path')).toBeDefined();
    });
  });

  describe('Full Detection', () => {
    test('should perform full detection and return results', async () => {
      mockAndroidBridge.getProcessList.mockResolvedValue([]);
      mockAndroidBridge.checkPort.mockResolvedValue({ open: false });
      mockAndroidBridge.fileExists.mockResolvedValue(false);
      mockAndroidBridge.getInstalledPackages.mockResolvedValue(['com.minego.game']);
      
      const result = await detector.performDetection();
      
      expect(result.timestamp).toBeDefined();
      expect(result.deviceId).toBeDefined();
      expect(result.riskLevel).toBeDefined();
      expect(result.detections).toBeDefined();
    });

    test('should set critical risk level for virtual environment', async () => {
      mockAndroidBridge.getInstalledPackages.mockResolvedValue(['io.va.exposed']);
      
      const result = await detector.performDetection();
      
      expect(result.riskLevel).toBe('critical');
    });

    test('should set high risk level for Frida', async () => {
      mockAndroidBridge.getProcessList.mockResolvedValue([
        { pid: 1234, name: 'frida-server' }
      ]);
      mockAndroidBridge.getInstalledPackages.mockResolvedValue(['com.minego.game']);
      
      const result = await detector.performDetection();
      
      expect(result.riskLevel).toBe('high');
    });
  });

  describe('Reporting', () => {
    test('should report to server successfully', async () => {
      global.fetch.mockResolvedValue({ ok: true });
      
      const result = {
        deviceId: 'test_device',
        timestamp: Date.now(),
        riskLevel: 'medium',
        detections: [{ tool: 'GameGuardian', indicators: [{ type: 'process' }] }]
      };
      
      await detector.reportToServer(result);
      
      expect(detector.stats.reportsSent).toBe(1);
    });

    test('should queue report on failure', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'));
      
      const result = {
        deviceId: 'test_device',
        timestamp: Date.now(),
        riskLevel: 'high',
        detections: [{ tool: 'Frida', indicators: [{ type: 'process' }] }]
      };
      
      await detector.reportToServer(result);
      
      expect(detector.reportQueue.length).toBeGreaterThan(0);
    });
  });

  describe('Rule Loading', () => {
    test('should load rules from server', async () => {
      const mockRules = [
        { id: 'frida-port', detection_strategy: { port: 27042 } },
        { id: 'xposed-file', detection_strategy: { paths: ['/system/xposed.prop'] } }
      ];
      
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ rules: mockRules })
      });
      
      const result = await detector.loadRulesFromServer();
      
      expect(result.success).toBe(true);
      expect(detector.detectionRules.size).toBeGreaterThan(0);
    });
  });

  describe('Response Handling', () => {
    test('should handle critical detection by blocking game', () => {
      const mockBlockGame = jest.spyOn(detector, 'blockGameAccess').mockImplementation();
      
      const result = { riskLevel: 'critical' };
      detector.handleDetectionResult(result);
      
      expect(mockBlockGame).toHaveBeenCalled();
      
      mockBlockGame.mockRestore();
    });

    test('should handle high detection by degrading features', () => {
      const mockDegrade = jest.spyOn(detector, 'degradeGameFeatures').mockImplementation();
      const mockWarning = jest.spyOn(detector, 'showWarning').mockImplementation();
      
      const result = { riskLevel: 'high' };
      detector.handleDetectionResult(result);
      
      expect(mockDegrade).toHaveBeenCalled();
      expect(mockWarning).toHaveBeenCalled();
      
      mockDegrade.mockRestore();
      mockWarning.mockRestore();
    });

    test('should handle medium detection by warning', () => {
      const mockWarning = jest.spyOn(detector, 'showWarning').mockImplementation();
      
      const result = { riskLevel: 'medium' };
      detector.handleDetectionResult(result);
      
      expect(mockWarning).toHaveBeenCalled();
      
      mockWarning.mockRestore();
    });

    test('should not act for low risk', () => {
      const result = { riskLevel: 'low' };
      detector.handleDetectionResult(result);
      
      // No actions should be taken for low risk
      // This test passes if no errors are thrown
    });
  });

  describe('Cleanup', () => {
    test('should destroy detector properly', async () => {
      await detector.init();
      detector.destroy();
      
      expect(detector.initialized).toBe(false);
      expect(detector.detectionTimer).toBeNull();
    });
  });
});

describe('InjectionDetector Singleton', () => {
  test('should export singleton instance', () => {
    expect(injectionDetector).toBeDefined();
    expect(injectionDetector instanceof InjectionDetector).toBe(true);
  });

  test('should have consistent device ID across calls', async () => {
    await injectionDetector.init();
    const id1 = injectionDetector.getDeviceId();
    
    // Second init should return same ID
    await injectionDetector.init();
    const id2 = injectionDetector.getDeviceId();
    
    expect(id1).toBe(id2);
  });
});

describe('Integration Tests', () => {
  test('should handle complete detection cycle', async () => {
    // Clean environment
    mockAndroidBridge.getProcessList.mockResolvedValue([]);
    mockAndroidBridge.checkPort.mockResolvedValue({ open: false });
    mockAndroidBridge.fileExists.mockResolvedValue(false);
    mockAndroidBridge.getInstalledPackages.mockResolvedValue(['com.minego.game']);
    global.fetch.mockResolvedValue({ ok: true });
    
    const detector = new InjectionDetector();
    
    // Initialize
    const initResult = await detector.init();
    expect(initResult.success).toBe(true);
    
    // Perform detection
    const detectionResult = await detector.performDetection();
    expect(detectionResult.riskLevel).toBe('low');
    
    // Get status
    const status = detector.getStatus();
    expect(status.initialized).toBe(true);
    
    // Cleanup
    detector.destroy();
  });

  test('should handle attack scenario', async () => {
    // Attacker environment with Frida
    mockAndroidBridge.getProcessList.mockResolvedValue([
      { pid: 1234, name: 'frida-server' }
    ]);
    mockAndroidBridge.checkPort.mockResolvedValue({ open: true });
    mockAndroidBridge.getInstalledPackages.mockResolvedValue(['com.minego.game']);
    global.fetch.mockResolvedValue({ ok: true });
    
    const detector = new InjectionDetector();
    
    // Initialize and detect
    await detector.init();
    const result = await detector.performDetection();
    
    expect(result.riskLevel).toBe('high');
    expect(result.detections.length).toBeGreaterThan(0);
    
    // Should report to server
    expect(detector.stats.reportsSent).toBeGreaterThan(0);
    
    detector.destroy();
  });
});