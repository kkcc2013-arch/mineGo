/**
 * 位置欺骗检测器 - 客户端模块
 * REQ-00586: GPS 位置欺骗检测与虚拟定位防护系统
 * 
 * 检测虚拟定位应用、开发者模式、Mock Location Provider
 */

class LocationSpoofDetector {
  constructor() {
    this.checkResults = {};
    this.riskScore = 0;
    this.flags = [];
  }

  /**
   * 执行全部检测
   */
  async runAllChecks() {
    const results = {
      mockLocationApps: await this.detectMockLocationApps(),
      developerMode: await this.detectDeveloperMode(),
      mockProviders: await this.detectMockLocationProvider(),
      iosIntegrity: await this.detectIOSIntegrity(),
      locationTimestamp: null
    };

    // 计算综合风险
    this.riskScore = this.calculateRiskScore(results);
    this.flags = this.extractFlags(results);
    this.checkResults = results;

    return {
      score: this.riskScore,
      riskLevel: this.getRiskLevel(this.riskScore),
      flags: this.flags,
      details: results
    };
  }

  /**
   * 检测虚拟定位应用
   */
  async detectMockLocationApps() {
    // 在原生层检测已安装的虚拟定位应用
    // 检测列表包含常见的 Fake GPS 应用包名
    const knownMockApps = [
      'com.lexa.fakegps',
      'com.incorporateapps.fakegps.fre',
      'com.blogspot.newapphorizons.fakegps',
      'com.fakegps.mocklocation',
      'com.gpsjoystick.mocklocation',
      'ru.gavrikov.mockgps',
      'com.fakegps.go',
      'com.fake.location'
    ];

    // 在实际原生实现中，会检查 PackageManager
    // 这里提供接口定义
    return {
      detected: false,
      apps: [],
      risk: 0
    };
  }

  /**
   * 检测开发者模式
   */
  async detectDeveloperMode() {
    // Android: Settings.Global.DEVELOPMENT_SETTINGS_ENABLED
    // iOS: 检查是否安装了开发证书
    return {
      enabled: false,
      adbEnabled: false,
      risk: 0
    };
  }

  /**
   * 检测 Mock Location Provider
   */
  async detectMockLocationProvider() {
    // Android: LocationManager.getProviders(true)
    // 过滤系统提供者：gps, network, passive
    return {
      mockProviders: [],
      risk: 0
    };
  }

  /**
   * iOS 设备完整性检查
   */
  async detectIOSIntegrity() {
    // 检测越狱文件路径
    // 检测 DynamicLibraries 注入
    return {
      isJailbroken: false,
      risk: 0
    };
  }

  /**
   * 验证位置时间戳
   */
  async validateLocationTimestamp(location) {
    const now = Date.now();
    const locationTime = location.timestamp || 0;
    const deviation = Math.abs(now - locationTime);

    // 位置时间与当前时间差超过 30 秒则可疑
    const maxDeviation = 30000;
    const consistent = deviation < maxDeviation;

    return {
      consistent,
      deviation,
      risk: consistent ? 0 : 30
    };
  }

  /**
   * 计算风险评分
   */
  calculateRiskScore(results) {
    let score = 0;

    if (results.mockLocationApps?.detected) {
      score += results.mockLocationApps.risk || 40;
    }

    if (results.developerMode?.enabled) {
      score += results.developerMode.risk || 20;
    }

    if (results.mockProviders?.length > 0) {
      score += 30;
    }

    if (results.iosIntegrity?.isJailbroken) {
      score += 50;
    }

    return Math.min(score, 100);
  }

  /**
   * 提取风险标志
   */
  extractFlags(results) {
    const flags = [];

    if (results.mockLocationApps?.detected) flags.push('mock_location_apps');
    if (results.developerMode?.enabled) flags.push('developer_mode');
    if (results.mockProviders?.length > 0) flags.push('mock_providers');
    if (results.iosIntegrity?.isJailbroken) flags.push('jailbroken');

    return flags;
  }

  /**
   * 获取风险等级
   */
  getRiskLevel(score) {
    if (score >= 70) return 'CRITICAL';
    if (score >= 50) return 'HIGH';
    if (score >= 30) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * 上报检测结果到服务端
   */
  async reportToServer(location) {
    const result = await this.runAllChecks();

    try {
      const response = await fetch('/api/v1/location/device-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mockLocationApps: result.details.mockLocationApps?.apps || [],
          developerMode: result.details.developerMode?.enabled || false,
          mockProviders: result.details.mockProviders?.mockProviders || [],
          jailbroken: result.details.iosIntegrity?.isJailbroken || false
        })
      });

      return await response.json();
    } catch (error) {
      console.error('Failed to report device check:', error);
      return { riskScore: result.score };
    }
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LocationSpoofDetector };
} else if (typeof window !== 'undefined') {
  window.LocationSpoofDetector = LocationSpoofDetector;
}