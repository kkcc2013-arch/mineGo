/**
 * REQ-00045: 设备完整性检测单元测试
 * 
 * 创建时间: 2026-06-09 07:00
 */

'use strict';

const {
  detectEmulator,
  detectRoot,
  detectJailbreak,
  detectVirtualEnv,
  detectHookFramework,
  generateDeviceFingerprint,
  calculateRiskScore,
  getTrustLevel,
  getDevicePolicy,
} = require('../../shared/deviceIntegrity');

describe('REQ-00045: Device Integrity Detection', () => {
  
  // ============================================================
  // 模拟器检测测试
  // ============================================================
  describe('Emulator Detection', () => {
    
    test('should detect BlueStacks emulator by model', () => {
      const deviceInfo = {
        model: 'BlueStacks',
        brand: 'Google',
        os_type: 'android',
      };
      
      const result = detectEmulator(deviceInfo);
      
      expect(result.isEmulator).toBe(true);
      expect(result.score).toBeGreaterThan(30);
      expect(result.emulatorType).toBe('bluestacks');
    });
    
    test('should detect Nox emulator by model', () => {
      const deviceInfo = {
        model: 'Samsung SM-G9730',
        product: 'nox',
        os_type: 'android',
      };
      
      const result = detectEmulator(deviceInfo);
      
      expect(result.isEmulator).toBe(true);
      expect(result.emulatorType).toBe('nox');
    });
    
    test('should detect LDPlayer emulator', () => {
      const deviceInfo = {
        model: 'LDPlayer',
        brand: 'Google',
        os_type: 'android',
      };
      
      const result = detectEmulator(deviceInfo);
      
      expect(result.isEmulator).toBe(true);
      expect(result.emulatorType).toBe('ldplayer');
    });
    
    test('should detect Genymotion emulator', () => {
      const deviceInfo = {
        model: 'Samsung Galaxy S10',
        manufacturer: 'Genymotion',
        product: 'genymotion',
        os_type: 'android',
      };
      
      const result = detectEmulator(deviceInfo);
      
      expect(result.isEmulator).toBe(true);
      expect(result.emulatorType).toBe('genymotion');
    });
    
    test('should detect Android SDK emulator', () => {
      const deviceInfo = {
        model: 'sdk_gphone64_x86_64',
        brand: 'Google',
        hardware: 'goldfish',
        board: 'goldfish',
        os_type: 'android',
      };
      
      const result = detectEmulator(deviceInfo);
      
      expect(result.isEmulator).toBe(true);
      expect(result.emulatorType).toBe('android_emulator');
    });
    
    test('should detect x86 CPU on Android device', () => {
      const deviceInfo = {
        model: 'Samsung Galaxy S23',
        cpu_abi: 'x86_64',
        os_type: 'android',
      };
      
      const result = detectEmulator(deviceInfo);
      
      expect(result.isEmulator).toBe(true);
      expect(result.indicators.some(i => i.type === 'X86_CPU_ON_ARM')).toBe(true);
    });
    
    test('should detect missing battery', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        has_battery: false,
        os_type: 'android',
      };
      
      const result = detectEmulator(deviceInfo);
      
      expect(result.isEmulator).toBe(true);
    });
    
    test('should detect low sensor count', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        sensor_count: 2,
        os_type: 'android',
      };
      
      const result = detectEmulator(deviceInfo);
      
      expect(result.score).toBeGreaterThan(0);
      expect(result.indicators.some(i => i.type === 'LOW_SENSOR_COUNT')).toBe(true);
    });
    
    test('should not flag real device as emulator', () => {
      const deviceInfo = {
        model: 'Samsung Galaxy S23 Ultra',
        brand: 'Samsung',
        manufacturer: 'Samsung',
        product: 'dm3q',
        hardware: 'qcom',
        board: 'taro',
        cpu_abi: 'arm64-v8a',
        os_type: 'android',
        sensor_count: 15,
        has_battery: true,
      };
      
      const result = detectEmulator(deviceInfo);
      
      expect(result.isEmulator).toBe(false);
      expect(result.score).toBe(0);
    });
    
    test('should use client-reported emulator flag', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        is_emulator: true,
      };
      
      const result = detectEmulator(deviceInfo);
      
      expect(result.isEmulator).toBe(true);
      expect(result.indicators.some(i => i.type === 'CLIENT_REPORTED')).toBe(true);
    });
  });
  
  // ============================================================
  // Root 检测测试
  // ============================================================
  describe('Root Detection', () => {
    
    test('should detect rooted device by root files', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        root_files: ['/system/bin/su', '/system/xbin/su'],
      };
      
      const result = detectRoot(deviceInfo);
      
      expect(result.isRooted).toBe(true);
      expect(result.score).toBeGreaterThan(30);
    });
    
    test('should detect Magisk root', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        root_apps: ['com.topjohnwu.magisk'],
        is_rooted: true,
      };
      
      const result = detectRoot(deviceInfo);
      
      expect(result.isRooted).toBe(true);
      expect(result.rootType).toBe('magisk');
    });
    
    test('should detect SuperSU root', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        root_apps: ['eu.chainfire.supersu'],
      };
      
      const result = detectRoot(deviceInfo);
      
      expect(result.isRooted).toBe(true);
      expect(result.rootType).toBe('supersu');
    });
    
    test('should detect su binary', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        su_binary_found: true,
      };
      
      const result = detectRoot(deviceInfo);
      
      expect(result.isRooted).toBe(true);
    });
    
    test('should detect writable system partition', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        writable_system: true,
      };
      
      const result = detectRoot(deviceInfo);
      
      expect(result.isRooted).toBe(true);
    });
    
    test('should not flag non-rooted device', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
      };
      
      const result = detectRoot(deviceInfo);
      
      expect(result.isRooted).toBe(false);
      expect(result.score).toBe(0);
    });
  });
  
  // ============================================================
  // 越狱检测测试
  // ============================================================
  describe('Jailbreak Detection', () => {
    
    test('should detect jailbroken device by Cydia', () => {
      const deviceInfo = {
        model: 'iPhone 14',
        os_type: 'ios',
        jailbreak_apps: ['/Applications/Cydia.app'],
      };
      
      const result = detectJailbreak(deviceInfo);
      
      expect(result.isJailbroken).toBe(true);
      expect(result.score).toBeGreaterThan(30);
    });
    
    test('should detect Sileo', () => {
      const deviceInfo = {
        model: 'iPhone 14',
        os_type: 'ios',
        jailbreak_apps: ['/Applications/Sileo.app'],
      };
      
      const result = detectJailbreak(deviceInfo);
      
      expect(result.isJailbroken).toBe(true);
    });
    
    test('should detect jailbreak files', () => {
      const deviceInfo = {
        model: 'iPhone 14',
        os_type: 'ios',
        jailbreak_files: ['/bin/bash', '/usr/sbin/sshd'],
      };
      
      const result = detectJailbreak(deviceInfo);
      
      expect(result.isJailbroken).toBe(true);
    });
    
    test('should detect fork capability', () => {
      const deviceInfo = {
        model: 'iPhone 14',
        os_type: 'ios',
        can_fork: true,
      };
      
      const result = detectJailbreak(deviceInfo);
      
      expect(result.isJailbroken).toBe(true);
    });
    
    test('should not flag non-jailbroken device', () => {
      const deviceInfo = {
        model: 'iPhone 14',
        os_type: 'ios',
      };
      
      const result = detectJailbreak(deviceInfo);
      
      expect(result.isJailbroken).toBe(false);
    });
  });
  
  // ============================================================
  // 虚拟环境检测测试
  // ============================================================
  describe('Virtual Environment Detection', () => {
    
    test('should detect VirtualApp', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        virtual_packages: ['io.virtualapp'],
      };
      
      const result = detectVirtualEnv(deviceInfo);
      
      expect(result.isVirtualEnv).toBe(true);
      expect(result.virtualEnvType).toBe('virtualapp');
    });
    
    test('should detect Parallel Space', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        virtual_packages: ['com.lbe.parallel'],
      };
      
      const result = detectVirtualEnv(deviceInfo);
      
      expect(result.isVirtualEnv).toBe(true);
      expect(result.virtualEnvType).toBe('parallel_space');
    });
    
    test('should detect process name mismatch', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        process_name_mismatch: true,
      };
      
      const result = detectVirtualEnv(deviceInfo);
      
      expect(result.isVirtualEnv).toBe(true);
    });
    
    test('should detect UID mismatch', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        uid_mismatch: true,
      };
      
      const result = detectVirtualEnv(deviceInfo);
      
      expect(result.isVirtualEnv).toBe(true);
    });
    
    test('should not flag normal device', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
      };
      
      const result = detectVirtualEnv(deviceInfo);
      
      expect(result.isVirtualEnv).toBe(false);
    });
  });
  
  // ============================================================
  // Hook 框架检测测试
  // ============================================================
  describe('Hook Framework Detection', () => {
    
    test('should detect Xposed framework', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        xposed_detected: true,
      };
      
      const result = detectHookFramework(deviceInfo);
      
      expect(result.hasHookFramework).toBe(true);
      expect(result.hookType).toBe('xposed');
    });
    
    test('should detect Frida', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        frida_detected: true,
      };
      
      const result = detectHookFramework(deviceInfo);
      
      expect(result.hasHookFramework).toBe(true);
      expect(result.hookType).toBe('frida');
    });
    
    test('should detect Substrate', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        substrate_detected: true,
      };
      
      const result = detectHookFramework(deviceInfo);
      
      expect(result.hasHookFramework).toBe(true);
      expect(result.hookType).toBe('substrate');
    });
    
    test('should not flag device without hook framework', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
      };
      
      const result = detectHookFramework(deviceInfo);
      
      expect(result.hasHookFramework).toBe(false);
    });
  });
  
  // ============================================================
  // 设备指纹测试
  // ============================================================
  describe('Device Fingerprint', () => {
    
    test('should generate consistent fingerprint for same device', () => {
      const deviceInfo1 = {
        brand: 'Samsung',
        model: 'Galaxy S23',
        device: 'dm3q',
        os_type: 'android',
        os_version: '14',
        screen_width: 1080,
        screen_height: 2340,
        screen_density: 3,
      };
      
      const deviceInfo2 = { ...deviceInfo1 };
      
      const fp1 = generateDeviceFingerprint(deviceInfo1);
      const fp2 = generateDeviceFingerprint(deviceInfo2);
      
      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(64); // SHA-256 hex length
    });
    
    test('should generate different fingerprints for different devices', () => {
      const deviceInfo1 = {
        brand: 'Samsung',
        model: 'Galaxy S23',
        device: 'dm3q',
        os_type: 'android',
      };
      
      const deviceInfo2 = {
        brand: 'Google',
        model: 'Pixel 7',
        device: 'panther',
        os_type: 'android',
      };
      
      const fp1 = generateDeviceFingerprint(deviceInfo1);
      const fp2 = generateDeviceFingerprint(deviceInfo2);
      
      expect(fp1).not.toBe(fp2);
    });
    
    test('should include all required components in fingerprint', () => {
      const deviceInfo = {
        brand: 'Samsung',
        model: 'Galaxy S23',
        device: 'dm3q',
        os_type: 'android',
        os_version: '14',
        screen_width: 1080,
        screen_height: 2340,
      };
      
      const fp = generateDeviceFingerprint(deviceInfo);
      
      expect(fp).toBeDefined();
      expect(typeof fp).toBe('string');
      expect(fp).toMatch(/^[a-f0-9]{64}$/);
    });
  });
  
  // ============================================================
  // 风险评分测试
  // ============================================================
  describe('Risk Score Calculation', () => {
    
    test('should calculate high risk score for emulator', () => {
      const deviceInfo = {};
      const detectionResults = {
        emulator: { isEmulator: true, score: 80 },
        root: { isRooted: false, score: 0 },
        jailbreak: { isJailbroken: false, score: 0 },
        virtualEnv: { isVirtualEnv: false, score: 0 },
        hook: { hasHookFramework: false, score: 0 },
      };
      
      const score = calculateRiskScore(deviceInfo, detectionResults);
      
      expect(score).toBeGreaterThanOrEqual(80);
    });
    
    test('should calculate risk score for rooted device', () => {
      const deviceInfo = {};
      const detectionResults = {
        emulator: { isEmulator: false, score: 0 },
        root: { isRooted: true, score: 40 },
        jailbreak: { isJailbroken: false, score: 0 },
        virtualEnv: { isVirtualEnv: false, score: 0 },
        hook: { hasHookFramework: false, score: 0 },
      };
      
      const score = calculateRiskScore(deviceInfo, detectionResults);
      
      expect(score).toBe(40);
    });
    
    test('should calculate risk score for virtual environment', () => {
      const deviceInfo = {};
      const detectionResults = {
        emulator: { isEmulator: false, score: 0 },
        root: { isRooted: false, score: 0 },
        jailbreak: { isJailbroken: false, score: 0 },
        virtualEnv: { isVirtualEnv: true, score: 50 },
        hook: { hasHookFramework: false, score: 0 },
      };
      
      const score = calculateRiskScore(deviceInfo, detectionResults);
      
      expect(score).toBe(50);
    });
    
    test('should calculate risk score for multi-account device', () => {
      const deviceInfo = { account_count: 10 };
      const detectionResults = {
        emulator: { isEmulator: false, score: 0 },
        root: { isRooted: false, score: 0 },
        jailbreak: { isJailbroken: false, score: 0 },
        virtualEnv: { isVirtualEnv: false, score: 0 },
        hook: { hasHookFramework: false, score: 0 },
      };
      
      const score = calculateRiskScore(deviceInfo, detectionResults);
      
      expect(score).toBeGreaterThan(0);
    });
    
    test('should cap risk score at 100', () => {
      const deviceInfo = { account_count: 50 };
      const detectionResults = {
        emulator: { isEmulator: true, score: 80 },
        root: { isRooted: true, score: 40 },
        jailbreak: { isJailbroken: true, score: 40 },
        virtualEnv: { isVirtualEnv: true, score: 50 },
        hook: { hasHookFramework: true, score: 30 },
      };
      
      const score = calculateRiskScore(deviceInfo, detectionResults);
      
      expect(score).toBe(100);
    });
    
    test('should return 0 for clean device', () => {
      const deviceInfo = {};
      const detectionResults = {
        emulator: { isEmulator: false, score: 0 },
        root: { isRooted: false, score: 0 },
        jailbreak: { isJailbroken: false, score: 0 },
        virtualEnv: { isVirtualEnv: false, score: 0 },
        hook: { hasHookFramework: false, score: 0 },
      };
      
      const score = calculateRiskScore(deviceInfo, detectionResults);
      
      expect(score).toBe(0);
    });
  });
  
  // ============================================================
  // 信任等级测试
  // ============================================================
  describe('Trust Level', () => {
    
    test('should return BANNED for risk score >= 80', () => {
      expect(getTrustLevel(80)).toBe('BANNED');
      expect(getTrustLevel(100)).toBe('BANNED');
    });
    
    test('should return LOW for risk score 50-79', () => {
      expect(getTrustLevel(50)).toBe('LOW');
      expect(getTrustLevel(79)).toBe('LOW');
    });
    
    test('should return MEDIUM for risk score 30-49', () => {
      expect(getTrustLevel(30)).toBe('MEDIUM');
      expect(getTrustLevel(49)).toBe('MEDIUM');
    });
    
    test('should return HIGH for risk score < 30', () => {
      expect(getTrustLevel(0)).toBe('HIGH');
      expect(getTrustLevel(29)).toBe('HIGH');
    });
  });
  
  // ============================================================
  // 处理策略测试
  // ============================================================
  describe('Device Policy', () => {
    
    test('should block device with risk score >= 80', () => {
      const policy = getDevicePolicy(85);
      
      expect(policy.action).toBe('BLOCK');
      expect(policy.restrictions).toContain('ALL');
      expect(policy.message).toBeDefined();
    });
    
    test('should restrict device with risk score 50-79', () => {
      const policy = getDevicePolicy(60);
      
      expect(policy.action).toBe('RESTRICT');
      expect(policy.restrictions.length).toBeGreaterThan(0);
      expect(policy.restrictions).toContain('NO_TRADING');
    });
    
    test('should monitor device with risk score 30-49', () => {
      const policy = getDevicePolicy(40);
      
      expect(policy.action).toBe('MONITOR');
      expect(policy.restrictions).toEqual([]);
    });
    
    test('should allow device with risk score < 30', () => {
      const policy = getDevicePolicy(10);
      
      expect(policy.action).toBe('ALLOW');
      expect(policy.restrictions).toEqual([]);
      expect(policy.message).toBeNull();
    });
  });
  
  // ============================================================
  // 集成测试
  // ============================================================
  describe('Integration Tests', () => {
    
    test('should detect emulator and calculate correct risk score', () => {
      const deviceInfo = {
        model: 'BlueStacks',
        brand: 'Google',
        os_type: 'android',
      };
      
      const detectionResults = {
        emulator: detectEmulator(deviceInfo),
        root: detectRoot(deviceInfo),
        jailbreak: detectJailbreak(deviceInfo),
        virtualEnv: detectVirtualEnv(deviceInfo),
        hook: detectHookFramework(deviceInfo),
      };
      
      const riskScore = calculateRiskScore(deviceInfo, detectionResults);
      const trustLevel = getTrustLevel(riskScore);
      const policy = getDevicePolicy(riskScore);
      
      expect(riskScore).toBeGreaterThanOrEqual(80);
      expect(trustLevel).toBe('BANNED');
      expect(policy.action).toBe('BLOCK');
    });
    
    test('should detect root + hook and calculate correct risk score', () => {
      const deviceInfo = {
        model: 'Pixel 7',
        os_type: 'android',
        root_files: ['/system/bin/su'],
        xposed_detected: true,
      };
      
      const detectionResults = {
        emulator: detectEmulator(deviceInfo),
        root: detectRoot(deviceInfo),
        jailbreak: detectJailbreak(deviceInfo),
        virtualEnv: detectVirtualEnv(deviceInfo),
        hook: detectHookFramework(deviceInfo),
      };
      
      const riskScore = calculateRiskScore(deviceInfo, detectionResults);
      const trustLevel = getTrustLevel(riskScore);
      
      expect(riskScore).toBeGreaterThanOrEqual(50);
      expect(trustLevel).toBeOneOf(['LOW', 'BANNED']);
    });
    
    test('should classify clean device correctly', () => {
      const deviceInfo = {
        model: 'Samsung Galaxy S23',
        brand: 'Samsung',
        manufacturer: 'Samsung',
        os_type: 'android',
        cpu_abi: 'arm64-v8a',
        sensor_count: 15,
        has_battery: true,
      };
      
      const detectionResults = {
        emulator: detectEmulator(deviceInfo),
        root: detectRoot(deviceInfo),
        jailbreak: detectJailbreak(deviceInfo),
        virtualEnv: detectVirtualEnv(deviceInfo),
        hook: detectHookFramework(deviceInfo),
      };
      
      const riskScore = calculateRiskScore(deviceInfo, detectionResults);
      const trustLevel = getTrustLevel(riskScore);
      const policy = getDevicePolicy(riskScore);
      
      expect(riskScore).toBe(0);
      expect(trustLevel).toBe('HIGH');
      expect(policy.action).toBe('ALLOW');
    });
  });
});