/**
 * REQ-00045: 设备完整性与模拟器检测系统
 * 单元测试
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const deviceIntegrity = require('../deviceIntegrity');
const { query } = require('../db');
const { getRedis } = require('../redis');

// Mock dependencies
const mockQuery = sinon.stub();
const mockRedis = {
  get: sinon.stub(),
  set: sinon.stub(),
  del: sinon.stub(),
};

// Replace dependencies
sinon.replace(require('../db'), 'query', mockQuery);
sinon.replace(require('../redis'), 'getRedis', () => mockRedis);

describe('DeviceIntegrity', () => {
  beforeEach(() => {
    sinon.resetHistory();
  });

  afterEach(() => {
    sinon.reset();
  });

  describe('detectEmulator', () => {
    it('should detect Bluestacks emulator by model', () => {
      const deviceInfo = {
        model: 'SM-G960F',
        brand: 'samsung',
        manufacturer: 'Samsung',
        product: 'bluestacks',
        hardware: 'qcom',
        os_type: 'android',
      };

      const result = deviceIntegrity.detectEmulator(deviceInfo);

      expect(result.isEmulator).to.be.true;
      expect(result.emulatorType).to.equal('bluestacks');
      expect(result.score).to.be.greaterThan(40);
    });

    it('should detect Nox emulator by model', () => {
      const deviceInfo = {
        model: 'SM-N975F',
        brand: 'samsung',
        manufacturer: 'Samsung',
        product: 'nox',
        hardware: 'qcom',
        os_type: 'android',
      };

      const result = deviceIntegrity.detectEmulator(deviceInfo);

      expect(result.isEmulator).to.be.true;
      expect(result.emulatorType).to.equal('nox');
    });

    it('should detect LDPlayer emulator', () => {
      const deviceInfo = {
        model: 'LDPlayer',
        brand: 'LDPlayer',
        manufacturer: 'LDPlayer',
        product: 'LDPlayer',
        hardware: 'x86',
        os_type: 'android',
      };

      const result = deviceIntegrity.detectEmulator(deviceInfo);

      expect(result.isEmulator).to.be.true;
      expect(result.emulatorType).to.equal('ldplayer');
    });

    it('should detect Android Emulator (AVD)', () => {
      const deviceInfo = {
        model: 'sdk_gphone64_x86_64',
        brand: 'google',
        manufacturer: 'Google',
        product: 'sdk_gphone64_x86_64',
        hardware: 'ranchu',
        os_type: 'android',
      };

      const result = deviceIntegrity.detectEmulator(deviceInfo);

      expect(result.isEmulator).to.be.true;
      expect(result.emulatorType).to.equal('android_emulator');
    });

    it('should detect Genymotion emulator', () => {
      const deviceInfo = {
        model: 'Genymotion',
        brand: 'Genymotion',
        manufacturer: 'Genymotion',
        product: 'vbox86p',
        hardware: 'vbox86',
        board: 'unknown',
        os_type: 'android',
      };

      const result = deviceIntegrity.detectEmulator(deviceInfo);

      expect(result.isEmulator).to.be.true;
      expect(result.emulatorType).to.equal('genymotion');
    });

    it('should detect emulator by x86 CPU on ARM device', () => {
      const deviceInfo = {
        model: 'Pixel 6',
        brand: 'google',
        manufacturer: 'Google',
        cpu_abi: 'x86_64',
        os_type: 'android',
      };

      const result = deviceIntegrity.detectEmulator(deviceInfo);

      expect(result.isEmulator).to.be.true;
      expect(result.indicators.some(i => i.type === 'X86_CPU_ON_ARM')).to.be.true;
    });

    it('should detect emulator by missing battery', () => {
      const deviceInfo = {
        model: 'Pixel 6',
        brand: 'google',
        manufacturer: 'Google',
        has_battery: false,
        os_type: 'android',
      };

      const result = deviceIntegrity.detectEmulator(deviceInfo);

      expect(result.isEmulator).to.be.true;
      expect(result.indicators.some(i => i.type === 'NO_BATTERY')).to.be.true;
    });

    it('should detect emulator by low sensor count', () => {
      const deviceInfo = {
        model: 'Pixel 6',
        brand: 'google',
        manufacturer: 'Google',
        sensor_count: 2,
        os_type: 'android',
      };

      const result = deviceIntegrity.detectEmulator(deviceInfo);

      expect(result.indicators.some(i => i.type === 'LOW_SENSOR_COUNT')).to.be.true;
    });

    it('should NOT flag real device as emulator', () => {
      const deviceInfo = {
        model: 'SM-G960F',
        brand: 'samsung',
        manufacturer: 'Samsung',
        product: 'starlte',
        hardware: 'qcom',
        board: 'sdm845',
        cpu_abi: 'arm64-v8a',
        has_battery: true,
        sensor_count: 15,
        os_type: 'android',
      };

      const result = deviceIntegrity.detectEmulator(deviceInfo);

      expect(result.isEmulator).to.be.false;
      expect(result.score).to.be.lessThan(50);
    });
  });

  describe('detectRoot', () => {
    it('should detect rooted device with su binary', () => {
      const deviceInfo = {
        su_binary_found: true,
        root_files: ['/system/bin/su'],
        os_type: 'android',
      };

      const result = deviceIntegrity.detectRoot(deviceInfo);

      expect(result.isRooted).to.be.true;
      expect(result.score).to.be.greaterThan(40);
    });

    it('should detect Magisk root', () => {
      const deviceInfo = {
        root_apps: ['com.topjohnwu.magisk'],
        is_rooted: true,
        os_type: 'android',
      };

      const result = deviceIntegrity.detectRoot(deviceInfo);

      expect(result.isRooted).to.be.true;
      expect(result.rootType).to.equal('magisk');
    });

    it('should detect SuperSU root', () => {
      const deviceInfo = {
        root_apps: ['eu.chainfire.supersu'],
        os_type: 'android',
      };

      const result = deviceIntegrity.detectRoot(deviceInfo);

      expect(result.isRooted).to.be.true;
      expect(result.rootType).to.equal('supersu');
    });

    it('should detect writable system partition', () => {
      const deviceInfo = {
        writable_system: true,
        os_type: 'android',
      };

      const result = deviceIntegrity.detectRoot(deviceInfo);

      expect(result.indicators.some(i => i.type === 'WRITABLE_SYSTEM')).to.be.true;
    });

    it('should NOT flag non-rooted device', () => {
      const deviceInfo = {
        su_binary_found: false,
        root_apps: [],
        writable_system: false,
        os_type: 'android',
      };

      const result = deviceIntegrity.detectRoot(deviceInfo);

      expect(result.isRooted).to.be.false;
    });
  });

  describe('detectJailbreak', () => {
    it('should detect jailbroken iOS device', () => {
      const deviceInfo = {
        jailbreak_apps: ['/Applications/Cydia.app'],
        os_type: 'ios',
      };

      const result = deviceIntegrity.detectJailbreak(deviceInfo);

      expect(result.isJailbroken).to.be.true;
      expect(result.score).to.be.greaterThan(40);
    });

    it('should detect Sileo jailbreak', () => {
      const deviceInfo = {
        jailbreak_apps: ['/Applications/Sileo.app'],
        os_type: 'ios',
      };

      const result = deviceIntegrity.detectJailbreak(deviceInfo);

      expect(result.isJailbroken).to.be.true;
    });

    it('should detect jailbreak by fork capability', () => {
      const deviceInfo = {
        can_fork: true,
        jailbreak_files: ['/bin/bash'],
        os_type: 'ios',
      };

      const result = deviceIntegrity.detectJailbreak(deviceInfo);

      expect(result.isJailbroken).to.be.true;
      expect(result.indicators.some(i => i.type === 'CAN_FORK')).to.be.true;
    });

    it('should NOT flag non-jailbroken iOS device', () => {
      const deviceInfo = {
        jailbreak_apps: [],
        jailbreak_files: [],
        can_fork: false,
        os_type: 'ios',
      };

      const result = deviceIntegrity.detectJailbreak(deviceInfo);

      expect(result.isJailbroken).to.be.false;
    });
  });

  describe('detectVirtualEnv', () => {
    it('should detect VirtualApp', () => {
      const deviceInfo = {
        virtual_packages: ['io.virtualapp'],
        is_virtual_env: true,
      };

      const result = deviceIntegrity.detectVirtualEnv(deviceInfo);

      expect(result.isVirtualEnv).to.be.true;
      expect(result.virtualEnvType).to.equal('virtualapp');
    });

    it('should detect Parallel Space', () => {
      const deviceInfo = {
        virtual_packages: ['com.lbe.parallel'],
      };

      const result = deviceIntegrity.detectVirtualEnv(deviceInfo);

      expect(result.isVirtualEnv).to.be.true;
      expect(result.virtualEnvType).to.equal('parallel_space');
    });

    it('should detect process name mismatch', () => {
      const deviceInfo = {
        process_name_mismatch: true,
      };

      const result = deviceIntegrity.detectVirtualEnv(deviceInfo);

      expect(result.indicators.some(i => i.type === 'PROCESS_NAME_MISMATCH')).to.be.true;
    });

    it('should detect UID mismatch', () => {
      const deviceInfo = {
        uid_mismatch: true,
      };

      const result = deviceIntegrity.detectVirtualEnv(deviceInfo);

      expect(result.indicators.some(i => i.type === 'UID_MISMATCH')).to.be.true;
    });
  });

  describe('detectHookFramework', () => {
    it('should detect Xposed framework', () => {
      const deviceInfo = {
        xposed_detected: true,
      };

      const result = deviceIntegrity.detectHookFramework(deviceInfo);

      expect(result.hasHookFramework).to.be.true;
      expect(result.hookType).to.equal('xposed');
    });

    it('should detect Frida framework', () => {
      const deviceInfo = {
        frida_detected: true,
      };

      const result = deviceIntegrity.detectHookFramework(deviceInfo);

      expect(result.hasHookFramework).to.be.true;
      expect(result.hookType).to.equal('frida');
    });

    it('should detect Substrate framework', () => {
      const deviceInfo = {
        substrate_detected: true,
      };

      const result = deviceIntegrity.detectHookFramework(deviceInfo);

      expect(result.hasHookFramework).to.be.true;
      expect(result.hookType).to.equal('substrate');
    });

    it('should detect multiple hook frameworks', () => {
      const deviceInfo = {
        xposed_detected: true,
        frida_detected: true,
        hook_files: ['/system/framework/XposedBridge.jar', '/data/local/tmp/frida-server'],
      };

      const result = deviceIntegrity.detectHookFramework(deviceInfo);

      expect(result.hasHookFramework).to.be.true;
      expect(result.score).to.be.greaterThan(50);
    });
  });

  describe('generateDeviceFingerprint', () => {
    it('should generate consistent fingerprint for same device', () => {
      const deviceInfo = {
        brand: 'samsung',
        model: 'SM-G960F',
        device: 'starlte',
        board: 'sdm845',
        manufacturer: 'Samsung',
        cpu_abi: 'arm64-v8a',
        os_type: 'android',
        os_version: '13',
        system_fingerprint: 'samsung/starlte/starlte:13/TQ3A.230901.001/12345678:user/release-keys',
        screen_width: 1440,
        screen_height: 2960,
        screen_density: 4,
        android_id: 'abc123def456',
      };

      const fingerprint1 = deviceIntegrity.generateDeviceFingerprint(deviceInfo);
      const fingerprint2 = deviceIntegrity.generateDeviceFingerprint(deviceInfo);

      expect(fingerprint1).to.equal(fingerprint2);
      expect(fingerprint1).to.have.length(64); // SHA-256 hex
    });

    it('should generate different fingerprints for different devices', () => {
      const deviceInfo1 = {
        brand: 'samsung',
        model: 'SM-G960F',
        os_type: 'android',
      };

      const deviceInfo2 = {
        brand: 'apple',
        model: 'iPhone14,2',
        os_type: 'ios',
      };

      const fingerprint1 = deviceIntegrity.generateDeviceFingerprint(deviceInfo1);
      const fingerprint2 = deviceIntegrity.generateDeviceFingerprint(deviceInfo2);

      expect(fingerprint1).to.not.equal(fingerprint2);
    });
  });

  describe('calculateRiskScore', () => {
    it('should calculate high risk for emulator', () => {
      const deviceInfo = {};
      const detectionResults = {
        emulator: { isEmulator: true, score: 80 },
        root: { isRooted: false, score: 0 },
        jailbreak: { isJailbroken: false, score: 0 },
        virtualEnv: { isVirtualEnv: false, score: 0 },
        hook: { hasHookFramework: false, score: 0 },
      };

      const score = deviceIntegrity.calculateRiskScore(deviceInfo, detectionResults);

      expect(score).to.be.greaterThanOrEqual(80);
    });

    it('should calculate medium risk for rooted device', () => {
      const deviceInfo = {};
      const detectionResults = {
        emulator: { isEmulator: false, score: 0 },
        root: { isRooted: true, score: 40 },
        jailbreak: { isJailbroken: false, score: 0 },
        virtualEnv: { isVirtualEnv: false, score: 0 },
        hook: { hasHookFramework: false, score: 0 },
      };

      const score = deviceIntegrity.calculateRiskScore(deviceInfo, detectionResults);

      expect(score).to.be.greaterThanOrEqual(40);
      expect(score).to.be.lessThan(80);
    });

    it('should calculate high risk for multiple issues', () => {
      const deviceInfo = {};
      const detectionResults = {
        emulator: { isEmulator: false, score: 30 },
        root: { isRooted: true, score: 40 },
        jailbreak: { isJailbroken: false, score: 0 },
        virtualEnv: { isVirtualEnv: true, score: 50 },
        hook: { hasHookFramework: true, score: 30 },
      };

      const score = deviceIntegrity.calculateRiskScore(deviceInfo, detectionResults);

      expect(score).to.be.greaterThanOrEqual(80);
    });

    it('should add risk for multi-account device', () => {
      const deviceInfo = { account_count: 5 };
      const detectionResults = {
        emulator: { isEmulator: false, score: 0 },
        root: { isRooted: false, score: 0 },
        jailbreak: { isJailbroken: false, score: 0 },
        virtualEnv: { isVirtualEnv: false, score: 0 },
        hook: { hasHookFramework: false, score: 0 },
      };

      const score = deviceIntegrity.calculateRiskScore(deviceInfo, detectionResults);

      expect(score).to.be.greaterThan(0);
    });
  });

  describe('getTrustLevel', () => {
    it('should return BANNED for high risk score', () => {
      expect(deviceIntegrity.getTrustLevel(80)).to.equal('BANNED');
      expect(deviceIntegrity.getTrustLevel(100)).to.equal('BANNED');
    });

    it('should return LOW for medium-high risk score', () => {
      expect(deviceIntegrity.getTrustLevel(50)).to.equal('LOW');
      expect(deviceIntegrity.getTrustLevel(79)).to.equal('LOW');
    });

    it('should return MEDIUM for medium risk score', () => {
      expect(deviceIntegrity.getTrustLevel(30)).to.equal('MEDIUM');
      expect(deviceIntegrity.getTrustLevel(49)).to.equal('MEDIUM');
    });

    it('should return HIGH for low risk score', () => {
      expect(deviceIntegrity.getTrustLevel(0)).to.equal('HIGH');
      expect(deviceIntegrity.getTrustLevel(29)).to.equal('HIGH');
    });
  });

  describe('getDevicePolicy', () => {
    it('should return BLOCK policy for high risk', () => {
      const policy = deviceIntegrity.getDevicePolicy(85);

      expect(policy.action).to.equal('BLOCK');
      expect(policy.restrictions).to.include('ALL');
    });

    it('should return RESTRICT policy for medium-high risk', () => {
      const policy = deviceIntegrity.getDevicePolicy(55);

      expect(policy.action).to.equal('RESTRICT');
      expect(policy.restrictions).to.include('NO_TRADING');
    });

    it('should return MONITOR policy for medium risk', () => {
      const policy = deviceIntegrity.getDevicePolicy(35);

      expect(policy.action).to.equal('MONITOR');
      expect(policy.restrictions).to.deep.equal([]);
    });

    it('should return ALLOW policy for low risk', () => {
      const policy = deviceIntegrity.getDevicePolicy(15);

      expect(policy.action).to.equal('ALLOW');
      expect(policy.restrictions).to.deep.equal([]);
    });
  });
});
