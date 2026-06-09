/**
 * REQ-00045: 设备完整性与模拟器检测系统
 * 核心检测引擎
 * 
 * 创建时间: 2026-06-09 07:00
 */

'use strict';

const crypto = require('crypto');
const { query } = require('./db');
const { getRedis, setJSON, getJSON } = require('./redis');
const { createLogger } = require('./logger');
const promClient = require('prom-client');

const logger = createLogger('device-integrity');

// ============================================================
// 检测规则配置
// ============================================================

const EMULATOR_INDICATORS = {
  // 设备型号检测
  DEVICE_MODELS: [
    'sdk', 'emulator', 'simulator', 'vbox', 'genymotion',
    'nox', 'bluestacks', 'andy', 'memu', 'ldplayer', 'droid4x',
    'andy', 'andyros', 'tiantian', 'microvirt', 'tecent'
  ],
  
  // 硬件制造商
  MANUFACTURERS: [
    'genymotion', 'bluestacks', 'nox', 'andy', 'memu', 'ldplayer',
    'microvirt', 'google', 'unknown'
  ],
  
  // 产品名称
  PRODUCTS: [
    'sdk', 'sdk_google', 'emulator', 'simulator', 'vbox',
    'genymotion', 'bluestacks', 'nox', 'andy', 'memu', 'ldplayer'
  ],
  
  // 硬件特征
  HARDWARE: ['goldfish', 'ranchu', 'vbox86', 'intel', 'amd'],
  
  // 板载设备
  BOARDS: ['goldfish', 'ranchu', 'unknown'],
};

const ROOT_INDICATORS = {
  // Root 管理应用包名
  ROOT_APPS: [
    'com.koushikdutta.superuser',
    'com.thirdparty.superuser',
    'eu.chainfire.supersu',
    'com.noshufou.android.su',
    'com.topjohnwu.magisk',
    'me.phh.superuser',
    'com.kingouser.com',
    'com.android.vending.billing.InAppBillingService.COIN',
  ],
  
  // su 二进制路径
  SU_PATHS: [
    '/system/bin/su', '/system/xbin/su', '/sbin/su',
    '/system/su', '/system/bin/.ext/.su',
    '/system/usr/we-need-root/su',
    '/data/local/xbin/su', '/data/local/bin/su',
    '/data/local/su', '/su/bin/su',
  ],
  
  // 危险文件
  DANGEROUS_FILES: [
    '/system/app/Superuser.apk',
    '/sbin/su', '/system/su',
  ],
};

const JAILBREAK_INDICATORS = {
  // 越狱应用
  APPS: [
    '/Applications/Cydia.app',
    '/Applications/Sileo.app',
    '/Applications/Zebra.app',
    '/Applications/Installer.app',
  ],
  
  // 越狱文件
  FILES: [
    '/Library/MobileSubstrate/MobileSubstrate.dylib',
    '/bin/bash', '/bin/sh',
    '/usr/sbin/sshd', '/usr/bin/sshd',
    '/etc/apt', '/etc/ssh',
    '/var/lib/cydia',
  ],
};

const VIRTUAL_ENV_INDICATORS = {
  // 虚拟环境包名
  PACKAGES: [
    'com.lbe.parallel',
    'com.lody.virtual',
    'io.virtualapp',
    'com.excelliance.dualaid',
    'com.ludashi.dualboot',
    'com.excelliance.kit',
    'com.qihoo.magic',
    'com.besty.media',
  ],
};

const HOOK_INDICATORS = {
  // Xposed
  XPOSED: {
    PACKAGE: 'de.robv.android.xposed.installer',
    FILES: [
      '/system/framework/XposedBridge.jar',
    ],
  },
  
  // Frida
  FRIDA: {
    FILES: [
      '/data/local/tmp/frida-server',
      '/data/local/tmp/frida',
      '/data/local/tmp/re.frida.server',
    ],
  },
  
  // Substrate
  SUBSTRATE: {
    FILES: [
      '/data/data/com.saurik.substrate',
      '/system/lib/libsubstrate.so',
    ],
  },
};

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  deviceRiskScore: new promClient.Histogram({
    name: 'minego_device_risk_score',
    help: 'Device risk score distribution',
    buckets: [0, 10, 20, 30, 50, 80, 100],
    labelNames: ['action'],
    registers: [promClient.register],
  }),
  
  deviceDetectionTotal: new promClient.Counter({
    name: 'minego_device_detection_total',
    help: 'Total device detections by type',
    labelNames: ['type', 'result'],
    registers: [promClient.register],
  }),
  
  deviceBlockedTotal: new promClient.Counter({
    name: 'minego_device_blocked_total',
    help: 'Total blocked devices by reason',
    labelNames: ['reason'],
    registers: [promClient.register],
  }),
  
  multiAccountDeviceTotal: new promClient.Counter({
    name: 'minego_multi_account_device_total',
    help: 'Devices with multiple accounts',
    labelNames: ['account_count_range'],
    registers: [promClient.register],
  }),
  
  deviceRegistrationTotal: new promClient.Counter({
    name: 'minego_device_registration_total',
    help: 'Total device registrations',
    labelNames: ['os_type', 'result'],
    registers: [promClient.register],
  }),
};

// ============================================================
// 检测函数
// ============================================================

/**
 * 检测模拟器
 * @param {Object} deviceInfo - 设备信息
 * @returns {Object} 检测结果
 */
function detectEmulator(deviceInfo) {
  const indicators = [];
  let totalScore = 0;
  
  // 1. 设备型号检测
  const model = (deviceInfo.model || '').toLowerCase();
  const brand = (deviceInfo.brand || '').toLowerCase();
  const manufacturer = (deviceInfo.manufacturer || '').toLowerCase();
  const product = (deviceInfo.product || '').toLowerCase();
  const hardware = (deviceInfo.hardware || '').toLowerCase();
  const board = (deviceInfo.board || '').toLowerCase();
  
  if (EMULATOR_INDICATORS.DEVICE_MODELS.some(m => model.includes(m))) {
    indicators.push({ type: 'MODEL_EMULATOR', weight: 30 });
    totalScore += 30;
  }
  
  if (EMULATOR_INDICATORS.MANUFACTURERS.some(m => manufacturer.includes(m))) {
    indicators.push({ type: 'MANUFACTURER_EMULATOR', weight: 20 });
    totalScore += 20;
  }
  
  if (EMULATOR_INDICATORS.PRODUCTS.some(p => product.includes(p))) {
    indicators.push({ type: 'PRODUCT_EMULATOR', weight: 25 });
    totalScore += 25;
  }
  
  if (EMULATOR_INDICATORS.HARDWARE.some(h => hardware.includes(h))) {
    indicators.push({ type: 'HARDWARE_EMULATOR', weight: 20 });
    totalScore += 20;
  }
  
  if (EMULATOR_INDICATORS.BOARDS.some(b => board.includes(b))) {
    indicators.push({ type: 'BOARD_EMULATOR', weight: 15 });
    totalScore += 15;
  }
  
  // 2. 硬件特征检测
  if (deviceInfo.cpu_abi && (deviceInfo.cpu_abi.includes('x86') || deviceInfo.cpu_abi.includes('x64'))) {
    // ARM 设备上的 x86 通常表示模拟器
    if (deviceInfo.os_type === 'android') {
      indicators.push({ type: 'X86_CPU_ON_ARM', weight: 25 });
      totalScore += 25;
    }
  }
  
  // 3. 传感器检测（模拟器通常缺少传感器）
  if (deviceInfo.sensor_count !== undefined && deviceInfo.sensor_count < 5) {
    indicators.push({ type: 'LOW_SENSOR_COUNT', weight: 15 });
    totalScore += 15;
  }
  
  // 4. 电池检测
  if (deviceInfo.has_battery === false) {
    indicators.push({ type: 'NO_BATTERY', weight: 30 });
    totalScore += 30;
  }
  
  // 5. 客户端上报的模拟器标记
  if (deviceInfo.is_emulator === true) {
    indicators.push({ type: 'CLIENT_REPORTED', weight: 50 });
    totalScore += 50;
  }
  
  // 判定阈值
  const isEmulator = totalScore >= 50;
  const emulatorType = identifyEmulatorType(deviceInfo);
  
  metrics.deviceDetectionTotal.inc({ type: 'emulator', result: isEmulator ? 'detected' : 'clean' });
  
  return {
    isEmulator,
    score: Math.min(100, totalScore),
    indicators,
    emulatorType: isEmulator ? emulatorType : null,
  };
}

/**
 * 识别模拟器类型
 */
function identifyEmulatorType(deviceInfo) {
  const model = (deviceInfo.model || '').toLowerCase();
  const product = (deviceInfo.product || '').toLowerCase();
  
  if (model.includes('bluestacks') || product.includes('bluestacks')) return 'bluestacks';
  if (model.includes('nox') || product.includes('nox')) return 'nox';
  if (model.includes('ldplayer') || product.includes('ldplayer')) return 'ldplayer';
  if (model.includes('memu') || product.includes('memu')) return 'memu';
  if (model.includes('genymotion') || product.includes('genymotion')) return 'genymotion';
  if (model.includes('andy') || product.includes('andy')) return 'andy';
  if (model.includes('sdk') || product.includes('sdk')) return 'android_emulator';
  if (model.includes('vbox')) return 'virtualbox';
  
  return 'unknown';
}

/**
 * 检测 Root
 * @param {Object} deviceInfo - 设备信息
 * @returns {Object} 检测结果
 */
function detectRoot(deviceInfo) {
  const indicators = [];
  let totalScore = 0;
  
  // 1. 客户端上报的 root 文件检测结果
  if (deviceInfo.root_files && deviceInfo.root_files.length > 0) {
    indicators.push({ type: 'ROOT_FILES', weight: 40, files: deviceInfo.root_files });
    totalScore += 40;
  }
  
  // 2. su 二进制文件检测
  if (deviceInfo.su_binary_found === true) {
    indicators.push({ type: 'SU_BINARY', weight: 35 });
    totalScore += 35;
  }
  
  // 3. Root 管理应用检测
  if (deviceInfo.root_apps && deviceInfo.root_apps.length > 0) {
    indicators.push({ type: 'ROOT_APPS', weight: 30, apps: deviceInfo.root_apps });
    totalScore += 30;
  }
  
  // 4. 可写系统分区检测
  if (deviceInfo.writable_system === true) {
    indicators.push({ type: 'WRITABLE_SYSTEM', weight: 25 });
    totalScore += 25;
  }
  
  // 5. 客户端上报的 root 标记
  if (deviceInfo.is_rooted === true) {
    indicators.push({ type: 'CLIENT_REPORTED', weight: 45 });
    totalScore += 45;
  }
  
  const isRooted = totalScore >= 40;
  const rootType = identifyRootType(deviceInfo);
  
  metrics.deviceDetectionTotal.inc({ type: 'root', result: isRooted ? 'detected' : 'clean' });
  
  return {
    isRooted,
    score: Math.min(100, totalScore),
    indicators,
    rootType: isRooted ? rootType : null,
  };
}

/**
 * 识别 Root 类型
 */
function identifyRootType(deviceInfo) {
  if (deviceInfo.root_apps) {
    if (deviceInfo.root_apps.includes('com.topjohnwu.magisk')) return 'magisk';
    if (deviceInfo.root_apps.includes('eu.chainfire.supersu')) return 'supersu';
    if (deviceInfo.root_apps.includes('com.kingouser.com')) return 'kingroot';
  }
  return 'unknown';
}

/**
 * 检测越狱（iOS）
 * @param {Object} deviceInfo - 设备信息
 * @returns {Object} 检测结果
 */
function detectJailbreak(deviceInfo) {
  const indicators = [];
  let totalScore = 0;
  
  // 1. 越狱应用检测
  if (deviceInfo.jailbreak_apps && deviceInfo.jailbreak_apps.length > 0) {
    indicators.push({ type: 'JAILBREAK_APPS', weight: 40, apps: deviceInfo.jailbreak_apps });
    totalScore += 40;
  }
  
  // 2. 越狱文件检测
  if (deviceInfo.jailbreak_files && deviceInfo.jailbreak_files.length > 0) {
    indicators.push({ type: 'JAILBREAK_FILES', weight: 35, files: deviceInfo.jailbreak_files });
    totalScore += 35;
  }
  
  // 3. 可写系统目录检测
  if (deviceInfo.writable_directories && deviceInfo.writable_directories.length > 0) {
    indicators.push({ type: 'WRITABLE_DIRS', weight: 30 });
    totalScore += 30;
  }
  
  // 4. Fork 检测（越狱设备可以 fork）
  if (deviceInfo.can_fork === true) {
    indicators.push({ type: 'CAN_FORK', weight: 25 });
    totalScore += 25;
  }
  
  // 5. 客户端上报的越狱标记
  if (deviceInfo.is_jailbroken === true) {
    indicators.push({ type: 'CLIENT_REPORTED', weight: 45 });
    totalScore += 45;
  }
  
  const isJailbroken = totalScore >= 40;
  
  metrics.deviceDetectionTotal.inc({ type: 'jailbreak', result: isJailbroken ? 'detected' : 'clean' });
  
  return {
    isJailbroken,
    score: Math.min(100, totalScore),
    indicators,
  };
}

/**
 * 检测虚拟环境
 * @param {Object} deviceInfo - 设备信息
 * @returns {Object} 检测结果
 */
function detectVirtualEnv(deviceInfo) {
  const indicators = [];
  let totalScore = 0;
  
  // 1. 虚拟环境包名检测
  if (deviceInfo.virtual_packages && deviceInfo.virtual_packages.length > 0) {
    indicators.push({ type: 'VIRTUAL_PACKAGES', weight: 40, packages: deviceInfo.virtual_packages });
    totalScore += 40;
  }
  
  // 2. 进程名检测
  if (deviceInfo.process_name_mismatch === true) {
    indicators.push({ type: 'PROCESS_NAME_MISMATCH', weight: 30 });
    totalScore += 30;
  }
  
  // 3. UID 异常检测
  if (deviceInfo.uid_mismatch === true) {
    indicators.push({ type: 'UID_MISMATCH', weight: 35 });
    totalScore += 35;
  }
  
  // 4. 外部存储路径重定向检测
  if (deviceInfo.storage_redirected === true) {
    indicators.push({ type: 'STORAGE_REDIRECTED', weight: 25 });
    totalScore += 25;
  }
  
  // 5. 客户端上报的虚拟环境标记
  if (deviceInfo.is_virtual_env === true) {
    indicators.push({ type: 'CLIENT_REPORTED', weight: 50 });
    totalScore += 50;
  }
  
  const isVirtualEnv = totalScore >= 40;
  const virtualEnvType = identifyVirtualEnvType(deviceInfo);
  
  metrics.deviceDetectionTotal.inc({ type: 'virtual_env', result: isVirtualEnv ? 'detected' : 'clean' });
  
  return {
    isVirtualEnv,
    score: Math.min(100, totalScore),
    indicators,
    virtualEnvType: isVirtualEnv ? virtualEnvType : null,
  };
}

/**
 * 识别虚拟环境类型
 */
function identifyVirtualEnvType(deviceInfo) {
  if (deviceInfo.virtual_packages) {
    if (deviceInfo.virtual_packages.includes('io.virtualapp')) return 'virtualapp';
    if (deviceInfo.virtual_packages.includes('com.lody.virtual')) return 'virtualapp';
    if (deviceInfo.virtual_packages.includes('com.lbe.parallel')) return 'parallel_space';
    if (deviceInfo.virtual_packages.includes('com.excelliance.dualaid')) return 'dualaid';
  }
  return 'unknown';
}

/**
 * 检测 Hook 框架
 * @param {Object} deviceInfo - 设备信息
 * @returns {Object} 检测结果
 */
function detectHookFramework(deviceInfo) {
  const indicators = [];
  let totalScore = 0;
  
  // 1. Xposed 检测
  if (deviceInfo.xposed_detected === true) {
    indicators.push({ type: 'XPOSED', weight: 35 });
    totalScore += 35;
  }
  
  // 2. Frida 检测
  if (deviceInfo.frida_detected === true) {
    indicators.push({ type: 'FRIDA', weight: 40 });
    totalScore += 40;
  }
  
  // 3. Substrate 检测
  if (deviceInfo.substrate_detected === true) {
    indicators.push({ type: 'SUBSTRATE', weight: 30 });
    totalScore += 30;
  }
  
  // 4. Hook 文件检测
  if (deviceInfo.hook_files && deviceInfo.hook_files.length > 0) {
    indicators.push({ type: 'HOOK_FILES', weight: 25, files: deviceInfo.hook_files });
    totalScore += 25;
  }
  
  // 5. 客户端上报的 hook 标记
  if (deviceInfo.has_hook_framework === true) {
    indicators.push({ type: 'CLIENT_REPORTED', weight: 45 });
    totalScore += 45;
  }
  
  const hasHookFramework = totalScore >= 30;
  const hookType = identifyHookType(deviceInfo);
  
  metrics.deviceDetectionTotal.inc({ type: 'hook', result: hasHookFramework ? 'detected' : 'clean' });
  
  return {
    hasHookFramework,
    score: Math.min(100, totalScore),
    indicators,
    hookType: hasHookFramework ? hookType : null,
  };
}

/**
 * 识别 Hook 类型
 */
function identifyHookType(deviceInfo) {
  if (deviceInfo.xposed_detected) return 'xposed';
  if (deviceInfo.frida_detected) return 'frida';
  if (deviceInfo.substrate_detected) return 'substrate';
  return 'unknown';
}

// ============================================================
// 设备指纹生成
// ============================================================

/**
 * 生成设备指纹
 * @param {Object} deviceInfo - 设备信息
 * @returns {string} 设备指纹（SHA-256 哈希）
 */
function generateDeviceFingerprint(deviceInfo) {
  // 收集设备唯一特征
  const components = {
    // 硬件特征
    hardware: {
      brand: deviceInfo.brand || '',
      model: deviceInfo.model || '',
      device: deviceInfo.device || '',
      board: deviceInfo.board || '',
      manufacturer: deviceInfo.manufacturer || '',
      cpu_abi: deviceInfo.cpu_abi || '',
    },
    
    // 系统特征
    system: {
      os_type: deviceInfo.os_type || 'unknown',
      os_version: deviceInfo.os_version || '',
      sdk_version: deviceInfo.sdk_version || '',
      fingerprint: deviceInfo.system_fingerprint || '',
    },
    
    // 屏幕特征
    screen: {
      width: deviceInfo.screen_width || 0,
      height: deviceInfo.screen_height || 0,
      density: deviceInfo.screen_density || 0,
    },
    
    // 传感器特征
    sensors: deviceInfo.sensor_fingerprint || '',
    
    // Android ID（如果有）
    android_id: deviceInfo.android_id || '',
    
    // IDFA/IDFV（iOS）
    idfv: deviceInfo.idfv || '',
  };
  
  // 生成 SHA-256 哈希
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify(components))
    .digest('hex');
  
  return fingerprint;
}

// ============================================================
// 风险评分
// ============================================================

/**
 * 计算设备风险评分
 * @param {Object} deviceInfo - 设备信息
 * @param {Object}检测结果 - 各项检测结果
 * @returns {number} 风险评分（0-100）
 */
function calculateRiskScore(deviceInfo, detectionResults) {
  let score = 0;
  
  // 模拟器检测（最高风险）
  if (detectionResults.emulator.isEmulator) {
    score += 80;
  } else if (detectionResults.emulator.score > 30) {
    score += detectionResults.emulator.score;
  }
  
  // Root 检测
  if (detectionResults.root.isRooted) {
    score += 40;
  } else if (detectionResults.root.score > 20) {
    score += detectionResults.root.score * 0.5;
  }
  
  // 越狱检测
  if (detectionResults.jailbreak.isJailbroken) {
    score += 40;
  }
  
  // 虚拟环境检测
  if (detectionResults.virtualEnv.isVirtualEnv) {
    score += 50;
  } else if (detectionResults.virtualEnv.score > 20) {
    score += detectionResults.virtualEnv.score * 0.5;
  }
  
  // Hook 框架检测
  if (detectionResults.hook.hasHookFramework) {
    score += 30;
  }
  
  // 设备关联账号数量（群控检测）
  if (deviceInfo.account_count > 3) {
    score += Math.min(30, (deviceInfo.account_count - 3) * 10);
  }
  
  return Math.min(100, Math.round(score));
}

/**
 * 获取设备信任等级
 * @param {number} riskScore - 风险评分
 * @returns {string} 信任等级
 */
function getTrustLevel(riskScore) {
  if (riskScore >= 80) return 'BANNED';
  if (riskScore >= 50) return 'LOW';
  if (riskScore >= 30) return 'MEDIUM';
  return 'HIGH';
}

/**
 * 获取设备处理策略
 * @param {number} riskScore - 风险评分
 * @returns {Object} 处理策略
 */
function getDevicePolicy(riskScore) {
  if (riskScore >= 80) {
    return {
      action: 'BLOCK',
      restrictions: ['ALL'],
      message: '您的设备存在安全风险，无法登录游戏',
    };
  }
  
  if (riskScore >= 50) {
    return {
      action: 'RESTRICT',
      restrictions: ['NO_TRADING', 'NO_TRANSFER', 'LIMITED_CATCH_RATE'],
      message: '您的设备存在安全风险，部分功能受限',
    };
  }
  
  if (riskScore >= 30) {
    return {
      action: 'MONITOR',
      restrictions: [],
      message: null,
    };
  }
  
  return {
    action: 'ALLOW',
    restrictions: [],
    message: null,
  };
}

// ============================================================
// 设备注册与管理
// ============================================================

/**
 * 注册或更新设备
 * @param {Object} deviceInfo - 设备信息
 * @param {number} userId - 用户ID（可选）
 * @returns {Promise<Object>} 注册结果
 */
async function registerDevice(deviceInfo, userId = null) {
  const startTime = Date.now();
  
  try {
    // 生成设备指纹
    const fingerprint = generateDeviceFingerprint(deviceInfo);
    const deviceId = `dev_${fingerprint.substring(0, 16)}`;
    
    // 执行检测
    const detectionResults = {
      emulator: detectEmulator(deviceInfo),
      root: detectRoot(deviceInfo),
      jailbreak: detectJailbreak(deviceInfo),
      virtualEnv: detectVirtualEnv(deviceInfo),
      hook: detectHookFramework(deviceInfo),
    };
    
    // 计算风险评分
    const riskScore = calculateRiskScore(deviceInfo, detectionResults);
    const trustLevel = getTrustLevel(riskScore);
    const policy = getDevicePolicy(riskScore);
    
    // 查询或创建设备记录
    const { rows: [existingDevice] } = await query(
      'SELECT * FROM device_registrations WHERE fingerprint = $1',
      [fingerprint]
    );
    
    let device;
    
    if (existingDevice) {
      // 更新现有设备
      const { rows: [updated] } = await query(`
        UPDATE device_registrations SET
          last_seen_at = NOW(),
          last_check_at = NOW(),
          risk_score = $1,
          trust_level = $2,
          status = CASE WHEN $1 >= 80 THEN 'BANNED' WHEN $1 >= 50 THEN 'RESTRICTED' ELSE status END,
          restrictions = $3,
          is_emulator = $4,
          emulator_type = $5,
          is_rooted = $6,
          root_type = $7,
          is_jailbroken = $8,
          is_virtual_env = $9,
          virtual_env_type = $10,
          has_hook_framework = $11,
          hook_framework_type = $12,
          detection_details = $13,
          updated_at = NOW()
        WHERE fingerprint = $14
        RETURNING *
      `, [
        riskScore, trustLevel, policy.restrictions,
        detectionResults.emulator.isEmulator, detectionResults.emulator.emulatorType,
        detectionResults.root.isRooted, detectionResults.root.rootType,
        detectionResults.jailbreak.isJailbroken,
        detectionResults.virtualEnv.isVirtualEnv, detectionResults.virtualEnv.virtualEnvType,
        detectionResults.hook.hasHookFramework, detectionResults.hook.hookType,
        JSON.stringify(detectionResults),
        fingerprint
      ]);
      device = updated;
    } else {
      // 创建新设备
      const { rows: [created] } = await query(`
        INSERT INTO device_registrations (
          device_id, fingerprint, brand, model, device_name,
          os_type, os_version, app_version, sdk_version,
          cpu_abi, screen_width, screen_height, screen_density, sensor_count,
          is_emulator, emulator_type, is_rooted, root_type, is_jailbroken,
          is_virtual_env, virtual_env_type, has_hook_framework, hook_framework_type,
          risk_score, trust_level, status, restrictions, detection_details
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28
        ) RETURNING *
      `, [
        deviceId, fingerprint,
        deviceInfo.brand, deviceInfo.model, deviceInfo.device,
        deviceInfo.os_type || 'unknown', deviceInfo.os_version, deviceInfo.app_version, deviceInfo.sdk_version,
        deviceInfo.cpu_abi, deviceInfo.screen_width, deviceInfo.screen_height, deviceInfo.screen_density, deviceInfo.sensor_count,
        detectionResults.emulator.isEmulator, detectionResults.emulator.emulatorType,
        detectionResults.root.isRooted, detectionResults.root.rootType,
        detectionResults.jailbreak.isJailbroken,
        detectionResults.virtualEnv.isVirtualEnv, detectionResults.virtualEnv.virtualEnvType,
        detectionResults.hook.hasHookFramework, detectionResults.hook.hookType,
        riskScore, trustLevel,
        policy.action === 'BLOCK' ? 'BANNED' : policy.action === 'RESTRICT' ? 'RESTRICTED' : 'ACTIVE',
        policy.restrictions,
        JSON.stringify(detectionResults)
      ]);
      device = created;
    }
    
    // 关联用户
    if (userId) {
      await associateDeviceWithUser(deviceId, userId);
    }
    
    // 记录检测日志
    await query(`
      INSERT INTO device_integrity_logs (
        device_id, user_id, detection_result, risk_score, trust_level, action_taken,
        emulator_detected, root_detected, virtual_env_detected, hook_detected,
        client_version, check_duration_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      deviceId, userId, JSON.stringify(detectionResults), riskScore, trustLevel, policy.action,
      detectionResults.emulator.isEmulator, detectionResults.root.isRooted || detectionResults.jailbreak.isJailbroken,
      detectionResults.virtualEnv.isVirtualEnv, detectionResults.hook.hasHookFramework,
      deviceInfo.app_version, Date.now() - startTime
    ]);
    
    // 更新指标
    metrics.deviceRiskScore.observe({ action: policy.action }, riskScore);
    metrics.deviceRegistrationTotal.inc({ os_type: deviceInfo.os_type || 'unknown', result: 'success' });
    
    if (policy.action === 'BLOCK') {
      metrics.deviceBlockedTotal.inc({ reason: 'high_risk' });
    }
    
    // 检查群控
    if (userId) {
      await checkMultiAccountDevice(deviceId);
    }
    
    return {
      device_id: deviceId,
      risk_score: riskScore,
      trust_level: trustLevel,
      action: policy.action,
      restrictions: policy.restrictions,
      message: policy.message,
      detection_results: detectionResults,
    };
  } catch (err) {
    logger.error({ err, deviceInfo }, 'Device registration failed');
    metrics.deviceRegistrationTotal.inc({ os_type: deviceInfo.os_type || 'unknown', result: 'error' });
    throw err;
  }
}

/**
 * 关联设备与用户
 */
async function associateDeviceWithUser(deviceId, userId) {
  const { rows: [existing] } = await query(
    'SELECT * FROM device_account_associations WHERE device_id = $1 AND user_id = $2',
    [deviceId, userId]
  );
  
  if (existing) {
    await query(`
      UPDATE device_account_associations SET
        last_login_at = NOW(),
        login_count = login_count + 1
      WHERE device_id = $1 AND user_id = $2
    `, [deviceId, userId]);
  } else {
    // 检查是否是该用户的第一个设备（设置为主设备）
    const { rows: [userDevices] } = await query(
      'SELECT COUNT(*) as count FROM device_account_associations WHERE user_id = $1',
      [userId]
    );
    
    const isPrimary = parseInt(userDevices.count) === 0;
    
    await query(`
      INSERT INTO device_account_associations (device_id, user_id, is_primary_device)
      VALUES ($1, $2, $3)
    `, [deviceId, userId, isPrimary]);
  }
}

/**
 * 检查多账号设备（群控检测）
 */
async function checkMultiAccountDevice(deviceId) {
  const { rows: [stats] } = await query(`
    SELECT COUNT(DISTINCT user_id) as account_count
    FROM device_account_associations
    WHERE device_id = $1
  `, [deviceId]);
  
  const accountCount = parseInt(stats.account_count);
  
  if (accountCount > 3) {
    // 记录群控检测结果
    const { rows: [existing] } = await query(
      'SELECT * FROM device_cluster_detection WHERE device_id = $1',
      [deviceId]
    );
    
    if (existing) {
      await query(`
        UPDATE device_cluster_detection SET
          account_count = $1,
          is_cluster_device = TRUE,
          cluster_type = CASE WHEN $1 > 10 THEN 'farm' WHEN $1 > 5 THEN 'automation' ELSE 'multi_account' END,
          last_updated_at = NOW()
        WHERE device_id = $2
      `, [accountCount, deviceId]);
    } else {
      await query(`
        INSERT INTO device_cluster_detection (device_id, account_count, is_cluster_device, cluster_type)
        VALUES ($1, $2, TRUE, CASE WHEN $2 > 10 THEN 'farm' WHEN $2 > 5 THEN 'automation' ELSE 'multi_account' END)
      `, [deviceId, accountCount]);
    }
    
    // 更新指标
    const range = accountCount > 10 ? '10+' : accountCount > 5 ? '5-10' : '3-5';
    metrics.multiAccountDeviceTotal.inc({ account_count_range: range });
    
    logger.warn({ deviceId, accountCount }, 'Multi-account device detected');
  }
}

/**
 * 获取设备信息
 * @param {string} deviceId - 设备ID
 * @returns {Promise<Object|null>} 设备信息
 */
async function getDevice(deviceId) {
  const { rows: [device] } = await query(
    'SELECT * FROM device_registrations WHERE device_id = $1',
    [deviceId]
  );
  return device || null;
}

/**
 * 获取设备的关联账号
 * @param {string} deviceId - 设备ID
 * @returns {Promise<Array>} 关联账号列表
 */
async function getDeviceAccounts(deviceId) {
  const { rows } = await query(`
    SELECT user_id, first_login_at, last_login_at, login_count, is_primary_device
    FROM device_account_associations
    WHERE device_id = $1
    ORDER BY last_login_at DESC
  `, [deviceId]);
  return rows;
}

/**
 * 封禁设备
 * @param {string} deviceId - 设备ID
 * @param {string} reason - 封禁原因
 */
async function banDevice(deviceId, reason) {
  await query(`
    UPDATE device_registrations SET
      status = 'BANNED',
      banned_at = NOW(),
      ban_reason = $1,
      risk_score = 100,
      trust_level = 'BANNED',
      restrictions = ARRAY['ALL'],
      updated_at = NOW()
    WHERE device_id = $2
  `, [reason, deviceId]);
  
  metrics.deviceBlockedTotal.inc({ reason: 'manual_ban' });
  logger.info({ deviceId, reason }, 'Device banned');
}

/**
 * 解封设备
 * @param {string} deviceId - 设备ID
 */
async function unbanDevice(deviceId) {
  await query(`
    UPDATE device_registrations SET
      status = 'ACTIVE',
      banned_at = NULL,
      ban_reason = NULL,
      risk_score = GREATEST(risk_score - 30, 0),
      trust_level = CASE WHEN risk_score - 30 < 30 THEN 'HIGH' WHEN risk_score - 30 < 50 THEN 'MEDIUM' ELSE 'LOW' END,
      restrictions = '{}',
      updated_at = NOW()
    WHERE device_id = $1
  `, [deviceId]);
  
  logger.info({ deviceId }, 'Device unbanned');
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  // 检测函数
  detectEmulator,
  detectRoot,
  detectJailbreak,
  detectVirtualEnv,
  detectHookFramework,
  
  // 指纹生成
  generateDeviceFingerprint,
  
  // 风险评分
  calculateRiskScore,
  getTrustLevel,
  getDevicePolicy,
  
  // 设备管理
  registerDevice,
  getDevice,
  getDeviceAccounts,
  banDevice,
  unbanDevice,
  associateDeviceWithUser,
  checkMultiAccountDevice,
  
  // 指标
  metrics,
};