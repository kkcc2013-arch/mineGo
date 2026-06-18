/**
 * REQ-00045: 设备完整性与模拟器检测系统
 * 客户端设备检测 SDK
 * 
 * 创建时间: 2026-06-18
 */

'use strict';

/**
 * DeviceIntegrityDetector - 设备完整性检测器
 * 用于检测模拟器、Root、越狱、虚拟环境和 Hook 框架
 */
class DeviceIntegrityDetector {
  constructor() {
    this检测结果 = {
      is_emulator: false,
      is_rooted: false,
      is_jailbroken: false,
      is_virtual_env: false,
      has_hook_framework: false,
    };
    
    this.deviceInfo = {};
    this.detectionDetails = {};
  }

  /**
   * 执行完整的设备检测
   * @returns {Promise<Object>} 检测结果和设备信息
   */
  async detect() {
    try {
      // 收集设备信息
      await this.collectDeviceInfo();
      
      // 执行各项检测
      const emulatorResult = await this.detectEmulator();
      const rootResult = await this.detectRoot();
      const jailbreakResult = await this.detectJailbreak();
      const virtualEnvResult = await this.detectVirtualEnv();
      const hookResult = await this.detectHookFramework();
      
      this.检测结果 = {
        is_emulator: emulatorResult.detected,
        is_rooted: rootResult.detected,
        is_jailbroken: jailbreakResult.detected,
        is_virtual_env: virtualEnvResult.detected,
        has_hook_framework: hookResult.detected,
      };
      
      this.detectionDetails = {
        emulator: emulatorResult,
        root: rootResult,
        jailbreak: jailbreakResult,
        virtualEnv: virtualEnvResult,
        hook: hookResult,
      };
      
      return {
        deviceInfo: this.deviceInfo,
        检测结果: this.检测结果,
        detectionDetails: this.detectionDetails,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('Device integrity detection failed:', error);
      throw error;
    }
  }

  /**
   * 收集设备基本信息
   */
  async collectDeviceInfo() {
    const ua = navigator.userAgent.toLowerCase();
    
    // 基本设备信息
    this.deviceInfo = {
      // 平台信息
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      os_type: this.getOsType(),
      os_version: this.getOsVersion(),
      
      // 屏幕信息
      screen_width: screen.width,
      screen_height: screen.height,
      screen_density: window.devicePixelRatio || 1,
      color_depth: screen.colorDepth,
      
      // 浏览器/应用信息
      app_version: this.getAppVersion(),
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      
      // 硬件信息（如果可用）
      cpu_cores: navigator.hardwareConcurrency || 0,
      device_memory: navigator.deviceMemory || 0,
      
      // 网络信息
      on_line: navigator.onLine,
      connection_type: this.getConnectionType(),
      
      // 时间戳
      timestamp: Date.now(),
    };
    
    // 尝试获取更多硬件信息
    await this.collectHardwareInfo();
    
    // 生成传感器指纹
    this.deviceInfo.sensor_fingerprint = await this.getSensorFingerprint();
    
    return this.deviceInfo;
  }

  /**
   * 获取操作系统类型
   */
  getOsType() {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('android')) return 'android';
    if (/iphone|ipad|ipod/.test(ua)) return 'ios';
    if (ua.includes('windows')) return 'windows';
    if (ua.includes('mac')) return 'macos';
    if (ua.includes('linux')) return 'linux';
    return 'unknown';
  }

  /**
   * 获取操作系统版本
   */
  getOsVersion() {
    const ua = navigator.userAgent;
    const osType = this.getOsType();
    
    if (osType === 'android') {
      const match = ua.match(/android\s([0-9.]+)/i);
      return match ? match[1] : '';
    }
    if (osType === 'ios') {
      const match = ua.match(/os\s([0-9_]+)/i);
      return match ? match[1].replace(/_/g, '.') : '';
    }
    return '';
  }

  /**
   * 获取应用版本
   */
  getAppVersion() {
    // 从 meta 标签或全局变量获取
    const meta = document.querySelector('meta[name="app-version"]');
    return meta ? meta.content : '1.0.0';
  }

  /**
   * 获取网络连接类型
   */
  getConnectionType() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return connection ? connection.effectiveType || connection.type : 'unknown';
  }

  /**
   * 收集硬件信息
   */
  async collectHardwareInfo() {
    try {
      // 检测电池
      if ('getBattery' in navigator) {
        const battery = await navigator.getBattery();
        this.deviceInfo.has_battery = true;
        this.deviceInfo.battery_level = battery.level;
        this.deviceInfo.battery_charging = battery.charging;
      } else {
        this.deviceInfo.has_battery = true; // 假设有电池
      }
      
      // 检测传感器数量
      if ('sensors' in navigator) {
        const sensors = await navigator.sensors.getSensors();
        this.deviceInfo.sensor_count = sensors.length;
      } else {
        // 通过其他方式估计传感器
        this.deviceInfo.sensor_count = this.estimateSensorCount();
      }
      
      // WebGL 信息（用于设备识别）
      const webglInfo = this.getWebGLInfo();
      this.deviceInfo.webgl_vendor = webglInfo.vendor;
      this.deviceInfo.webgl_renderer = webglInfo.renderer;
      
    } catch (error) {
      console.warn('Hardware info collection partial:', error);
    }
  }

  /**
   * 估计传感器数量
   */
  estimateSensorCount() {
    let count = 0;
    
    // 检测常见传感器 API
    if ('DeviceOrientationEvent' in window) count++;
    if ('DeviceMotionEvent' in window) count++;
    if ('Geolocation' in navigator) count++;
    if ('AmbientLightSensor' in window) count++;
    if ('ProximitySensor' in window) count++;
    
    return count;
  }

  /**
   * 获取 WebGL 信息
   */
  getWebGLInfo() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : '',
          renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : '',
        };
      }
    } catch (error) {
      // WebGL 不可用
    }
    
    return { vendor: '', renderer: '' };
  }

  /**
   * 获取传感器指纹
   */
  async getSensorFingerprint() {
    const fingerprint = [];
    
    try {
      // 陀螺仪检测
      const hasGyroscope = await this.checkSensor('DeviceOrientationEvent');
      fingerprint.push(`gyro:${hasGyroscope}`);
      
      // 加速度计检测
      const hasAccelerometer = await this.checkSensor('DeviceMotionEvent');
      fingerprint.push(`accel:${hasAccelerometer}`);
      
      // GPS 检测
      fingerprint.push(`gps:${'Geolocation' in navigator}`);
      
      // 触摸屏检测
      fingerprint.push(`touch:${'ontouchstart' in window}`);
      
    } catch (error) {
      // 忽略错误
    }
    
    return fingerprint.join('|');
  }

  /**
   * 检测传感器可用性
   */
  async checkSensor(sensorType) {
    return new Promise((resolve) => {
      try {
        if (sensorType === 'DeviceOrientationEvent') {
          if (typeof DeviceOrientationEvent !== 'undefined') {
            const handler = (event) => {
              window.removeEventListener('deviceorientation', handler);
              resolve(!!event.alpha || !!event.beta || !!event.gamma);
            };
            window.addEventListener('deviceorientation', handler);
            setTimeout(() => {
              window.removeEventListener('deviceorientation', handler);
              resolve(false);
            }, 1000);
          } else {
            resolve(false);
          }
        } else if (sensorType === 'DeviceMotionEvent') {
          if (typeof DeviceMotionEvent !== 'undefined') {
            const handler = (event) => {
              window.removeEventListener('devicemotion', handler);
              resolve(!!event.acceleration || !!event.accelerationIncludingGravity);
            };
            window.addEventListener('devicemotion', handler);
            setTimeout(() => {
              window.removeEventListener('devicemotion', handler);
              resolve(false);
            }, 1000);
          } else {
            resolve(false);
          }
        } else {
          resolve(false);
        }
      } catch (error) {
        resolve(false);
      }
    });
  }

  /**
   * 检测模拟器
   */
  async detectEmulator() {
    const indicators = [];
    let score = 0;
    
    const ua = navigator.userAgent.toLowerCase();
    const platform = navigator.platform.toLowerCase();
    
    // 1. 模拟器关键词检测
    const emulatorKeywords = [
      'sdk', 'emulator', 'simulator', 'vbox', 'genymotion',
      'bluestacks', 'nox', 'andy', 'memu', 'ldplayer', 'droid4x',
      'andyros', 'tiantian', 'microvirt', 'tecent', '雷电'
    ];
    
    for (const keyword of emulatorKeywords) {
      if (ua.includes(keyword) || platform.includes(keyword)) {
        indicators.push({ type: 'KEYWORD_DETECTED', keyword, weight: 30 });
        score += 30;
        break;
      }
    }
    
    // 2. 硬件特征检测
    // CPU 核心数异常少（模拟器通常分配较少核心）
    if (this.deviceInfo.cpu_cores && this.deviceInfo.cpu_cores < 4) {
      indicators.push({ type: 'LOW_CPU_CORES', cores: this.deviceInfo.cpu_cores, weight: 10 });
      score += 10;
    }
    
    // 3. 屏幕特征检测
    // 模拟器常见的屏幕分辨率
    const emulatorResolutions = [
      [320, 480], [480, 800], [720, 1280], [1080, 1920], [1440, 2560]
    ];
    
    const isEmulatorResolution = emulatorResolutions.some(
      ([w, h]) => (screen.width === w && screen.height === h) ||
                  (screen.width === h && screen.height === w)
    );
    
    if (isEmulatorResolution) {
      indicators.push({ type: 'EMULATOR_RESOLUTION', weight: 5 });
      score += 5;
    }
    
    // 4. WebGL 检测
    const webgl = this.deviceInfo;
    if (webgl.webgl_vendor) {
      const gpuEmulatorKeywords = ['swiftshader', 'llvmpipe', 'mesa', 'virtualbox'];
      for (const keyword of gpuEmulatorKeywords) {
        if (webgl.webgl_vendor.toLowerCase().includes(keyword) ||
            (webgl.webgl_renderer && webgl.webgl_renderer.toLowerCase().includes(keyword))) {
          indicators.push({ type: 'EMULATOR_GPU', keyword, weight: 25 });
          score += 25;
          break;
        }
      }
    }
    
    // 5. 电池检测
    if (this.deviceInfo.has_battery === false) {
      indicators.push({ type: 'NO_BATTERY', weight: 30 });
      score += 30;
    }
    
    // 6. 传感器检测
    if (this.deviceInfo.sensor_count !== undefined && this.deviceInfo.sensor_count < 3) {
      indicators.push({ type: 'LOW_SENSOR_COUNT', count: this.deviceInfo.sensor_count, weight: 15 });
      score += 15;
    }
    
    // 7. 时区异常检测（模拟器可能使用 UTC）
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone === 'UTC' || timezone === 'Etc/UTC') {
      indicators.push({ type: 'UTC_TIMEZONE', weight: 10 });
      score += 10;
    }
    
    return {
      detected: score >= 40,
      score: Math.min(100, score),
      indicators,
      emulatorType: this.identifyEmulatorType(ua, platform),
    };
  }

  /**
   * 识别模拟器类型
   */
  identifyEmulatorType(ua, platform) {
    const combined = (ua + ' ' + platform).toLowerCase();
    
    if (combined.includes('bluestacks')) return 'bluestacks';
    if (combined.includes('nox')) return 'nox';
    if (combined.includes('ldplayer') || combined.includes('雷电')) return 'ldplayer';
    if (combined.includes('memu')) return 'memu';
    if (combined.includes('genymotion')) return 'genymotion';
    if (combined.includes('andy')) return 'andy';
    if (combined.includes('sdk') || combined.includes('emulator')) return 'android_emulator';
    if (combined.includes('vbox')) return 'virtualbox';
    if (combined.includes('simulator') && this.deviceInfo.os_type === 'ios') return 'ios_simulator';
    
    return null;
  }

  /**
   * 检测 Root（Android）
   */
  async detectRoot() {
    const indicators = [];
    let score = 0;
    
    // Web 环境下无法直接检测 Root，但可以通过一些间接特征
    const ua = navigator.userAgent.toLowerCase();
    
    // 1. 检测 Root 管理器关键词（可能在 User Agent 中）
    const rootKeywords = ['supersu', 'magisk', 'kingroot', 'root'];
    for (const keyword of rootKeywords) {
      if (ua.includes(keyword)) {
        indicators.push({ type: 'ROOT_KEYWORD_IN_UA', keyword, weight: 40 });
        score += 40;
        break;
      }
    }
    
    // 2. 检测特定文件协议（file:// 访问能力）
    try {
      // 某些 Root 设备可能允许更宽松的文件访问
      const testElement = document.createElement('iframe');
      testElement.style.display = 'none';
      testElement.src = 'file:///';
      document.body.appendChild(testElement);
      
      setTimeout(() => {
        document.body.removeChild(testElement);
      }, 100);
    } catch (error) {
      // 无法访问 file://，正常行为
    }
    
    // Web 环境下 Root 检测受限
    // 真实的 Root 检测需要原生 App 配合
    
    return {
      detected: score >= 40,
      score,
      indicators,
      rootType: null,
      note: 'Web environment has limited root detection capability',
    };
  }

  /**
   * 检测越狱（iOS）
   */
  async detectJailbreak() {
    const indicators = [];
    let score = 0;
    
    const ua = navigator.userAgent.toLowerCase();
    
    // 1. 检测越狱关键词
    const jailbreakKeywords = ['cydia', 'sileo', 'substrate', 'jailbreak'];
    for (const keyword of jailbreakKeywords) {
      if (ua.includes(keyword)) {
        indicators.push({ type: 'JAILBREAK_KEYWORD', keyword, weight: 40 });
        score += 40;
        break;
      }
    }
    
    // 2. 检测特定 URL Scheme（Cydia 等）
    const jailbreakSchemes = ['cydia://', 'sileo://', 'zbra://'];
    for (const scheme of jailbreakSchemes) {
      try {
        // 尝试打开越狱应用 URL Scheme
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = scheme;
        document.body.appendChild(iframe);
        
        // 如果成功加载，说明安装了越狱应用
        await new Promise(resolve => setTimeout(resolve, 100));
        document.body.removeChild(iframe);
        
        // 注意：这种方式在现代浏览器可能受限
      } catch (error) {
        // 忽略
      }
    }
    
    return {
      detected: score >= 40,
      score,
      indicators,
      note: 'Web environment has limited jailbreak detection capability',
    };
  }

  /**
   * 检测虚拟环境
   */
  async detectVirtualEnv() {
    const indicators = [];
    let score = 0;
    
    const ua = navigator.userAgent.toLowerCase();
    
    // 1. 检测虚拟环境关键词
    const virtualKeywords = ['virtual', 'parallel', 'dual', 'clone', 'sandbox', 'workprofile'];
    for (const keyword of virtualKeywords) {
      if (ua.includes(keyword)) {
        indicators.push({ type: 'VIRTUAL_KEYWORD', keyword, weight: 30 });
        score += 30;
        break;
      }
    }
    
    // 2. 检测存储空间异常（虚拟环境可能有独立的存储配额）
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        // 虚拟环境通常有较小的配额
        if (estimate.quota && estimate.quota < 100 * 1024 * 1024) { // < 100MB
          indicators.push({ type: 'LOW_STORAGE_QUOTA', quota: estimate.quota, weight: 20 });
          score += 20;
        }
      } catch (error) {
        // 忽略
      }
    }
    
    return {
      detected: score >= 40,
      score,
      indicators,
      virtualEnvType: null,
    };
  }

  /**
   * 检测 Hook 框架
   */
  async detectHookFramework() {
    const indicators = [];
    let score = 0;
    
    const ua = navigator.userAgent.toLowerCase();
    
    // 1. 检测 Hook 框架关键词
    const hookKeywords = ['xposed', 'frida', 'substrate', 'hook', 'inject'];
    for (const keyword of hookKeywords) {
      if (ua.includes(keyword)) {
        indicators.push({ type: 'HOOK_KEYWORD', keyword, weight: 35 });
        score += 35;
        break;
      }
    }
    
    // 2. 检测调试器
    const startTime = performance.now();
    debugger; // 如果有调试器，这里会暂停
    const endTime = performance.now();
    
    if (endTime - startTime > 100) {
      indicators.push({ type: 'DEBUGGER_DETECTED', delay: endTime - startTime, weight: 25 });
      score += 25;
    }
    
    // 3. 检测开发者工具
    try {
      const devtools = /./;
      devtools.toString = function() {
        indicators.push({ type: 'DEVTOOLS_OPEN', weight: 15 });
        score += 15;
        return '';
      };
      
      console.log('%c', devtools);
    } catch (error) {
      // 忽略
    }
    
    return {
      detected: score >= 30,
      score,
      indicators,
      hookType: null,
    };
  }

  /**
   * 生成设备报告（用于上报服务器）
   */
  generateReport() {
    return {
      deviceInfo: this.deviceInfo,
      检测结果: this.检测结果,
      detectionDetails: this.detectionDetails,
      timestamp: Date.now(),
      sdkVersion: '1.0.0',
    };
  }

  /**
   * 获取上报用的 Base64 编码设备信息
   */
  getEncodedDeviceInfo() {
    const report = this.generateReport();
    return btoa(JSON.stringify(report.deviceInfo));
  }
}

// 导出全局实例
const deviceIntegrityDetector = new DeviceIntegrityDetector();

// 自动检测函数
async function performDeviceIntegrityCheck() {
  const result = await deviceIntegrityDetector.detect();
  
  // 将设备信息附加到请求头
  window.__DEVICE_INFO__ = result.deviceInfo;
  window.__DEVICE_INTEGRITY__ = result.检测结果;
  
  // 存储到本地
  try {
    localStorage.setItem('device_info', JSON.stringify(result.deviceInfo));
    localStorage.setItem('device_integrity', JSON.stringify(result.检测结果));
  } catch (error) {
    // 忽略存储错误
  }
  
  return result;
}

// 拦截 fetch 请求，自动添加设备信息头
const originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
  // 跳过某些 URL
  if (url.includes('/health') || url.includes('/metrics')) {
    return originalFetch.call(this, url, options);
  }
  
  // 添加设备信息头
  if (window.__DEVICE_INFO__) {
    options.headers = options.headers || {};
    options.headers['X-Device-Info'] = btoa(JSON.stringify(window.__DEVICE_INFO__));
  }
  
  return originalFetch.call(this, url, options);
};

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DeviceIntegrityDetector,
    deviceIntegrityDetector,
    performDeviceIntegrityCheck,
  };
} else {
  window.DeviceIntegrityDetector = DeviceIntegrityDetector;
  window.deviceIntegrityDetector = deviceIntegrityDetector;
  window.performDeviceIntegrityCheck = performDeviceIntegrityCheck;
}
