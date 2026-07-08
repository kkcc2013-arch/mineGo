/**
 * Security 初始化入口
 * 
 * 统一初始化所有安全模块
 * 
 * @module frontend/game-client/src/security/index
 */

const { MemoryGuard, memoryGuard } = require('./MemoryGuard');
const { SecureStorage, secureStorage, SECURE_DATA_KEYS } = require('./SecureStorage');
const { MemoryScanner, memoryScanner } = require('./MemoryScanner');
const { RequestSigner, requestSigner, PROTECTED_PATHS } = require('./RequestSigner');
const { InjectionDetector, injectionDetector } = require('./InjectionDetector');

/**
 * 安全系统初始化配置
 */
const DEFAULT_CONFIG = {
  enableMemoryGuard: true,
  enableSecureStorage: true,
  enableMemoryScanner: true,
  enableRequestSigner: true,
  scannerInterval: 30000,
  onTamperDetected: null,
  onBan: null
};

/**
 * 初始化安全系统
 * @param {Object} config 
 * @returns {Promise<Object>}
 */
async function initSecurity(config = {}) {
  const options = { ...DEFAULT_CONFIG, ...config };
  const results = {
    success: false,
    modules: {},
    errors: []
  };

  try {
    // 1. 初始化 MemoryGuard
    if (options.enableMemoryGuard) {
      try {
        const sessionInfo = await memoryGuard.init();
        results.modules.memoryGuard = {
          initialized: true,
          sessionId: sessionInfo.sessionId
        };
      } catch (error) {
        results.errors.push(`MemoryGuard: ${error.message}`);
        results.modules.memoryGuard = { initialized: false, error: error.message };
      }
    }

    // 2. 初始化 SecureStorage
    if (options.enableSecureStorage) {
      try {
        await secureStorage.init();
        results.modules.secureStorage = { initialized: true };
      } catch (error) {
        results.errors.push(`SecureStorage: ${error.message}`);
        results.modules.secureStorage = { initialized: false, error: error.message };
      }
    }

    // 3. 初始化 MemoryScanner
    if (options.enableMemoryScanner) {
      try {
        memoryScanner.scanInterval = options.scannerInterval || 30000;
        memoryScanner.startScanning();
        results.modules.memoryScanner = { initialized: true, scanning: true };
      } catch (error) {
        results.errors.push(`MemoryScanner: ${error.message}`);
        results.modules.memoryScanner = { initialized: false, error: error.message };
      }
    }

    // 4. 初始化 RequestSigner
    if (options.enableRequestSigner) {
      try {
        requestSigner.installInterceptor();
        results.modules.requestSigner = { initialized: true, interceptorInstalled: true };
      } catch (error) {
        results.errors.push(`RequestSigner: ${error.message}`);
        results.modules.requestSigner = { initialized: false, error: error.message };
      }
    }

    results.success = results.errors.length === 0;
    
    console.log('[Security] Initialization complete:', results);
    
    return results;
  } catch (error) {
    results.errors.push(`Global: ${error.message}`);
    return results;
  }
}

/**
 * 销毁安全系统
 */
function destroySecurity() {
  try {
    memoryScanner.stopScanning();
    requestSigner.uninstallInterceptor();
    memoryGuard.destroy();
    secureStorage.clearAll();
    
    console.log('[Security] Destroyed');
  } catch (error) {
    console.error('[Security] Destroy error:', error);
  }
}

/**
 * 获取安全状态
 * @returns {Object}
 */
function getSecurityStatus() {
  return {
    memoryGuard: memoryGuard.getStatus(),
    secureStorage: secureStorage.getStats(),
    memoryScanner: memoryScanner.getStats(),
    requestSigner: requestSigner.getStats(),
    timestamp: Date.now()
  };
}

/**
 * 保护数据快捷方法
 * @param {string} key 
 * @param {*} data 
 * @returns {Object}
 */
function protectData(key, data) {
  return memoryGuard.wrapSecureData(data, key);
}

/**
 * 验证数据快捷方法
 * @param {Object} protectedData 
 * @returns {boolean}
 */
function verifyData(protectedData) {
  if (protectedData && typeof protectedData._verify === 'function') {
    return protectedData._verify();
  }
  return false;
}

// 自动初始化（可选）
let autoInitialized = false;

async function autoInit() {
  if (autoInitialized) return;
  
  // 等待 DOM 加载完成
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initSecurity().then(results => {
        autoInitialized = true;
        if (!results.success) {
          console.warn('[Security] Auto-init had errors:', results.errors);
        }
      });
    });
  } else {
    await initSecurity();
    autoInitialized = true;
  }
}

// 导出
module.exports = {
  // 类
  MemoryGuard,
  SecureStorage,
  MemoryScanner,
  RequestSigner,
  InjectionDetector,
  
  // 单例
  memoryGuard,
  secureStorage,
  memoryScanner,
  requestSigner,
  injectionDetector,
  
  // 常量
  SECURE_DATA_KEYS,
  PROTECTED_PATHS,
  
  // 方法
  initSecurity,
  destroySecurity,
  getSecurityStatus,
  protectData,
  verifyData,
  autoInit
};
