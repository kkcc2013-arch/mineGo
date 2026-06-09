/**
 * REQ-00045: 设备完整性检测（客户端）
 * 
 * 创建时间: 2026-06-09 07:00
 * 
 * 该模块运行在游戏客户端，执行设备完整性检测并上报到服务端
 */

'use strict';

// ============================================================
// 检测配置
// ============================================================

const EMULATOR_INDICATORS = {
  DEVICE_MODELS: [
    'sdk', 'emulator', 'simulator', 'vbox', 'genymotion',
    'nox', 'bluestacks', 'andy', 'memu', 'ldplayer', 'droid4x'
  ],
  MANUFACTURERS: [
    'genymotion', 'bluestacks', 'nox', 'andy', 'memu', 'ldplayer',
    'microvirt', 'unknown'
  ],
  PRODUCTS: [
    'sdk', 'sdk_google', 'emulator', 'simulator', 'vbox',
    'genymotion', 'bluestacks', 'nox', 'andy', 'memu', 'ldplayer'
  ],
  HARDWARE: ['goldfish', 'ranchu', 'vbox86', 'intel', 'amd'],
};

const ROOT_INDICATORS = {
  ROOT_APPS: [
    'com.koushikdutta.superuser',
    'com.thirdparty.superuser',
    'eu.chainfire.supersu',
    'com.noshufou.android.su',
    'com.topjohnwu.magisk',
    'me.phh.superuser',
    'com.kingouser.com',
  ],
  SU_PATHS: [
    '/system/bin/su', '/system/xbin/su', '/sbin/su',
    '/system/su', '/system/bin/.ext/.su',
    '/su/bin/su', '/data/local/su',
  ],
};

const VIRTUAL_ENV_INDICATORS = {
  PACKAGES: [
    'com.lbe.parallel',
    'com.lody.virtual',
    'io.virtualapp',
    'com.excelliance.dualaid',
    'com.ludashi.dualboot',
  ],
};

const HOOK_INDICATORS = {
  XPOSED_PACKAGE: 'de.robv.android.xposed.installer',
  FRIDA_FILES: [
    '/data/local/tmp/frida-server',
    '/data/local/tmp/frida',
  ],
};

// ============================================================
// 检测函数
// ============================================================

/**
 * 获取设备信息
 */
async function getDeviceInfo() {
  const info = {
    // 基本信息
    brand: getBrand(),
    model: getModel(),
    manufacturer: getManufacturer(),
    product: getProduct(),
    device: getDevice(),
    board: getBoard(),
    hardware: getHardware(),
    
    // 系统信息
    os_type: getOsType(),
    os_version: getOsVersion(),
    sdk_version: getSdkVersion(),
    cpu_abi: getCpuAbi(),
    
    // 屏幕信息
    screen_width: screen.width,
    screen_height: screen.height,
    screen_density: window.devicePixelRatio || 1,
    
    // 应用信息
    app_version: getAppVersion(),
    
    // 传感器信息
    sensor_count: await getSensorCount(),
    
    // 电池信息
    has_battery: await hasBattery(),
    
    // 时间戳
    timestamp: Date.now(),
  };
  
  // 执行检测
  info.is_emulator = detectEmulator(info);
  info.emulator_score = getEmulatorScore(info);
  
  info.is_rooted = await detectRoot();
  info.root_files = await getRootFiles();
  
  info.is_jailbroken = detectJailbreak();
  
  info.is_virtual_env = detectVirtualEnv();
  info.virtual_packages = await getVirtualPackages();
  
  info.has_hook_framework = await detectHookFramework();
  
  // 获取 Android ID（需要原生 bridge）
  info.android_id = await getAndroidId();
  
  return info;
}

/**
 * 检测模拟器
 */
function detectEmulator(info) {
  const model = (info.model || '').toLowerCase();
  const manufacturer = (info.manufacturer || '').toLowerCase();
  const product = (info.product || '').toLowerCase();
  const hardware = (info.hardware || '').toLowerCase();
  
  // 检查设备型号
  if (EMULATOR_INDICATORS.DEVICE_MODELS.some(m => model.includes(m))) {
    return true;
  }
  
  // 检查制造商
  if (EMULATOR_INDICATORS.MANUFACTURERS.some(m => manufacturer.includes(m))) {
    return true;
  }
  
  // 检查产品名
  if (EMULATOR_INDICATORS.PRODUCTS.some(p => product.includes(p))) {
    return true;
  }
  
  // 检查硬件
  if (EMULATOR_INDICATORS.HARDWARE.some(h => hardware.includes(h))) {
    return true;
  }
  
  // 检查 x86 CPU（ARM 设备上的 x86 表示模拟器）
  if (info.cpu_abi && info.cpu_abi.includes('x86')) {
    return true;
  }
  
  // 检查传感器数量（模拟器通常较少）
  if (info.sensor_count !== undefined && info.sensor_count < 5) {
    return true;
  }
  
  // 检查电池
  if (info.has_battery === false) {
    return true;
  }
  
  return false;
}

/**
 * 获取模拟器评分
 */
function getEmulatorScore(info) {
  let score = 0;
  
  const model = (info.model || '').toLowerCase();
  const manufacturer = (info.manufacturer || '').toLowerCase();
  const product = (info.product || '').toLowerCase();
  const hardware = (info.hardware || '').toLowerCase();
  
  if (EMULATOR_INDICATORS.DEVICE_MODELS.some(m => model.includes(m))) score += 30;
  if (EMULATOR_INDICATORS.MANUFACTURERS.some(m => manufacturer.includes(m))) score += 20;
  if (EMULATOR_INDICATORS.PRODUCTS.some(p => product.includes(p))) score += 25;
  if (EMULATOR_INDICATORS.HARDWARE.some(h => hardware.includes(h))) score += 20;
  if (info.cpu_abi && info.cpu_abi.includes('x86')) score += 25;
  if (info.sensor_count !== undefined && info.sensor_count < 5) score += 15;
  if (info.has_battery === false) score += 30;
  
  return Math.min(100, score);
}

/**
 * 检测 Root（需要原生 bridge）
 */
async function detectRoot() {
  // Web 环境下无法检测，返回 false
  if (typeof window === 'undefined' || !window.AndroidBridge) {
    return false;
  }
  
  try {
    // 通过原生 bridge 检测
    if (window.AndroidBridge.isRooted) {
      return window.AndroidBridge.isRooted();
    }
    
    // 检测 su 文件
    if (window.AndroidBridge.checkRootFiles) {
      const result = await window.AndroidBridge.checkRootFiles(ROOT_INDICATORS.SU_PATHS);
      return result.length > 0;
    }
    
    return false;
  } catch (e) {
    console.warn('Root detection failed:', e);
    return false;
  }
}

/**
 * 获取 Root 文件列表
 */
async function getRootFiles() {
  if (typeof window === 'undefined' || !window.AndroidBridge) {
    return [];
  }
  
  try {
    if (window.AndroidBridge.checkRootFiles) {
      return await window.AndroidBridge.checkRootFiles(ROOT_INDICATORS.SU_PATHS);
    }
  } catch (e) {
    console.warn('Get root files failed:', e);
  }
  
  return [];
}

/**
 * 检测越狱（iOS）
 */
function detectJailbreak() {
  // Web 环境无法检测
  return false;
}

/**
 * 检测虚拟环境
 */
function detectVirtualEnv() {
  // 通过进程名、UID 等检测
  // Web 环境下检测能力有限
  return false;
}

/**
 * 获取虚拟环境包名
 */
async function getVirtualPackages() {
  if (typeof window === 'undefined' || !window.AndroidBridge) {
    return [];
  }
  
  try {
    if (window.AndroidBridge.checkInstalledPackages) {
      const installed = await window.AndroidBridge.checkInstalledPackages(
        VIRTUAL_ENV_INDICATORS.PACKAGES
      );
      return installed;
    }
  } catch (e) {
    console.warn('Get virtual packages failed:', e);
  }
  
  return [];
}

/**
 * 检测 Hook 框架
 */
async function detectHookFramework() {
  if (typeof window === 'undefined' || !window.AndroidBridge) {
    return false;
  }
  
  try {
    // 检测 Xposed
    if (window.AndroidBridge.isXposedInstalled) {
      const xposed = await window.AndroidBridge.isXposedInstalled();
      if (xposed) return true;
    }
    
    // 检测 Frida
    if (window.AndroidBridge.checkFridaFiles) {
      const frida = await window.AndroidBridge.checkFridaFiles(HOOK_INDICATORS.FRIDA_FILES);
      if (frida.length > 0) return true;
    }
    
    return false;
  } catch (e) {
    console.warn('Hook framework detection failed:', e);
    return false;
  }
}

/**
 * 获取 Android ID
 */
async function getAndroidId() {
  if (typeof window === 'undefined' || !window.AndroidBridge) {
    return null;
  }
  
  try {
    if (window.AndroidBridge.getAndroidId) {
      return await window.AndroidBridge.getAndroidId();
    }
  } catch (e) {
    console.warn('Get Android ID failed:', e);
  }
  
  return null;
}

// ============================================================
// 辅助函数
// ============================================================

function getBrand() {
  return navigator.userAgent.match(/\(([^;]+);/)?.[1] || 'unknown';
}

function getModel() {
  return navigator.userAgent.match(/\(([^)]+)\)/)?.[1]?.split(';').pop()?.trim() || 'unknown';
}

function getManufacturer() {
  return 'unknown'; // Web 无法获取
}

function getProduct() {
  return 'unknown'; // Web 无法获取
}

function getDevice() {
  return 'unknown'; // Web 无法获取
}

function getBoard() {
  return 'unknown'; // Web 无法获取
}

function getHardware() {
  return 'unknown'; // Web 无法获取
}

function getOsType() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  return 'web';
}

function getOsVersion() {
  const ua = navigator.userAgent;
  const match = ua.match(/(Android|OS) (\d+[._]\d+)/);
  return match ? match[2].replace('_', '.') : 'unknown';
}

function getSdkVersion() {
  return 'unknown'; // Web 无法获取
}

function getCpuAbi() {
  return 'unknown'; // Web 无法获取
}

function getAppVersion() {
  return localStorage.getItem('app_version') || '1.0.0';
}

async function getSensorCount() {
  try {
    if ('sensors' in navigator) {
      const sensors = await navigator.sensors.getSensors();
      return sensors.length;
    }
  } catch (e) {
    // Sensor API 不可用
  }
  return undefined;
}

async function hasBattery() {
  try {
    if ('getBattery' in navigator) {
      const battery = await navigator.getBattery();
      return battery !== null;
    }
  } catch (e) {
    // Battery API 不可用
  }
  return true; // 假设有电池
}

// ============================================================
// 设备指纹
// ============================================================

/**
 * 生成设备指纹
 */
async function generateDeviceFingerprint() {
  const components = {
    // 硬件特征
    hardware: {
      brand: getBrand(),
      model: getModel(),
      screen: {
        width: screen.width,
        height: screen.height,
        density: window.devicePixelRatio,
      },
    },
    
    // 系统特征
    system: {
      os_type: getOsType(),
      os_version: getOsVersion(),
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    
    // 浏览器特征
    browser: {
      user_agent: navigator.userAgent,
      platform: navigator.platform,
      plugins: Array.from(navigator.plugins || []).map(p => p.name).join(','),
      do_not_track: navigator.doNotTrack,
    },
    
    // 时间戳
    timestamp: Date.now(),
  };
  
  // 使用 SubtleCrypto 生成 SHA-256
  const data = JSON.stringify(components);
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const fingerprint = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return fingerprint;
}

// ============================================================
// 设备信息上报
// ============================================================

/**
 * 上报设备信息到服务端
 * @param {string} apiBase - API 基础 URL
 * @param {string} token - 认证 Token
 * @returns {Promise<Object>} 服务端响应
 */
async function reportDeviceInfo(apiBase, token) {
  const deviceInfo = await getDeviceInfo();
  const fingerprint = await generateDeviceFingerprint();
  
  deviceInfo.fingerprint = fingerprint;
  
  const response = await fetch(`${apiBase}/api/device/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(deviceInfo),
  });
  
  if (!response.ok) {
    throw new Error(`Device registration failed: ${response.status}`);
  }
  
  return response.json();
}

/**
 * 获取设备信息 Header（用于每个请求）
 * @returns {Promise<string>} Base64 编码的设备信息
 */
async function getDeviceInfoHeader() {
  const deviceInfo = await getDeviceInfo();
  const json = JSON.stringify(deviceInfo);
  return btoa(json);
}

// ============================================================
// 导出
// ============================================================

// 全局对象（供原生 bridge 调用）
if (typeof window !== 'undefined') {
  window.DeviceIntegrity = {
    getDeviceInfo,
    detectEmulator,
    detectRoot,
    detectVirtualEnv,
    detectHookFramework,
    generateDeviceFingerprint,
    reportDeviceInfo,
    getDeviceInfoHeader,
  };
}

module.exports = {
  getDeviceInfo,
  detectEmulator,
  detectRoot,
  detectJailbreak,
  detectVirtualEnv,
  detectHookFramework,
  generateDeviceFingerprint,
  reportDeviceInfo,
  getDeviceInfoHeader,
};