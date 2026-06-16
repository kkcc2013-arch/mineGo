/**
 * MemoryScanner - 运行时内存扫描器
 * 
 * 功能：
 * - 检测内存修改器特征码
 * - 检测 Hook 框架（Frida、Xposed）
 * - 检测代码注入
 * - 定期扫描并上报异常
 * 
 * @module frontend/game-client/src/security/MemoryScanner
 */

const { memoryGuard } = require('./MemoryGuard');

class MemoryScanner {
  constructor() {
    this.memoryGuard = memoryGuard;
    this.scanInterval = 30000; // 30 秒扫描一次
    this.scanTimer = null;
    this.isScanning = false;
    this.scanCount = 0;
    this.detectionHistory = [];
    this.maxHistorySize = 50;
    this.apiBaseUrl = '/api/v1/security';
    
    // 可疑特征码模式
    this.suspiciousPatterns = [
      // 内存修改器
      { name: 'GameGuardian', pattern: /gg\.(set|get|range|add|clear|search)/i, severity: 'high' },
      { name: 'CheatEngine', pattern: /cheat\s*engine|ce_\w+/i, severity: 'high' },
      { name: 'LuckyPatcher', pattern: /lucky\s*patcher|lp_\w+/i, severity: 'high' },
      { name: 'GameCIH', pattern: /gamecih|cih_\w+/i, severity: 'high' },
      { name: 'GameKiller', pattern: /gamekiller|gk_\w+/i, severity: 'high' },
      
      // Hook 框架
      { name: 'Frida', pattern: /frida|__frida|FRIDA_/i, severity: 'critical' },
      { name: 'Xposed', pattern: /xposed|de\.robv\.android\.xposed/i, severity: 'critical' },
      { name: 'Substrate', pattern: /substrate|MSHook|MSMessage/i, severity: 'critical' },
      { name: 'CydiaSubstrate', pattern: /cydia.*substrate/i, severity: 'critical' },
      
      // 调试器
      { name: 'Debugger', pattern: /debugger|__debugger/i, severity: 'medium' },
      
      // 虚拟化检测绕过
      { name: 'VMware', pattern: /vmware|vmware/i, severity: 'low' },
      { name: 'VirtualBox', pattern: /virtualbox|vbox/i, severity: 'low' },
      
      // 自动化工具
      { name: 'Selenium', pattern: /selenium|webdriver/i, severity: 'medium' },
      { name: 'Puppeteer', pattern: /puppeteer|headless/i, severity: 'medium' },
      
      // 脚本注入
      { name: 'Tampermonkey', pattern: /tampermonkey|greasemonkey/i, severity: 'low' }
    ];
    
    // 关键函数原始实现（用于检测 Hook）
    this.originalFunctions = new Map();
    
    // Native 函数签名
    this.nativeFunctionSignatures = new Map();
  }

  /**
   * 启动定期扫描
   */
  startScanning() {
    if (this.scanTimer) {
      console.warn('[MemoryScanner] Already scanning');
      return;
    }
    
    // 保存原始函数引用
    this.saveOriginalFunctions();
    
    // 立即执行一次扫描
    this.scan();
    
    // 启动定期扫描
    this.scanTimer = setInterval(() => {
      this.scan();
    }, this.scanInterval);
    
    console.log('[MemoryScanner] Started periodic scanning');
  }

  /**
   * 停止扫描
   */
  stopScanning() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    console.log('[MemoryScanner] Stopped scanning');
  }

  /**
   * 保存原始函数引用
   */
  saveOriginalFunctions() {
    // 保存关键原生函数
    const nativeFunctions = [
      { obj: window, name: 'fetch' },
      { obj: window, name: 'XMLHttpRequest' },
      { obj: window, name: 'localStorage' },
      { obj: window, name: 'sessionStorage' },
      { obj: JSON, name: 'stringify' },
      { obj: JSON, name: 'parse' },
      { obj: Object, name: 'freeze' },
      { obj: Object, name: 'defineProperty' },
      { obj: Array.prototype, name: 'push' },
      { obj: Array.prototype, name: 'splice' }
    ];
    
    for (const { obj, name } of nativeFunctions) {
      if (obj && obj[name]) {
        this.originalFunctions.set(name, {
          fn: obj[name],
          string: obj[name].toString()
        });
      }
    }
  }

  /**
   * 执行扫描
   * @returns {Promise<Array>}
   */
  async scan() {
    if (this.isScanning) {
      return [];
    }
    
    this.isScanning = true;
    this.scanCount++;
    const detections = [];
    
    try {
      // 1. 全局作用域扫描
      const globalDetections = this.scanGlobalScope();
      detections.push(...globalDetections);
      
      // 2. 原型污染检测
      const prototypeDetections = this.checkPrototypePollution();
      detections.push(...prototypeDetections);
      
      // 3. Native 函数 Hook 检测
      const hookDetections = this.checkNativeHooks();
      detections.push(...hookDetections);
      
      // 4. DOM 篡改检测
      const domDetections = this.checkDOMTampering();
      detections.push(...domDetections);
      
      // 5. 时间戳篡改检测
      const timeDetections = this.checkTimeManipulation();
      detections.push(...timeDetections);
      
      // 记录检测结果
      if (detections.length > 0) {
        this.recordDetections(detections);
        
        // 上报服务端
        await this.reportDetections(detections);
      }
      
    } catch (error) {
      console.error('[MemoryScanner] Scan error:', error);
    } finally {
      this.isScanning = false;
    }
    
    return detections;
  }

  /**
   * 扫描全局作用域
   * @returns {Array}
   */
  scanGlobalScope() {
    const detections = [];
    
    try {
      // 获取全局对象字符串表示
      const globalKeys = Object.keys(globalThis).join(' ');
      const globalValues = Object.values(globalThis)
        .map(v => typeof v === 'function' ? v.toString() : String(v))
        .join(' ');
      
      // 检测可疑模式
      for (const { name, pattern, severity } of this.suspiciousPatterns) {
        if (pattern.test(globalKeys) || pattern.test(globalValues)) {
          detections.push({
            name,
            type: 'global_scope',
            severity,
            timestamp: Date.now(),
            details: `Pattern found in global scope`
          });
        }
      }
      
    } catch (error) {
      // 忽略权限错误
    }
    
    return detections;
  }

  /**
   * 检查原型污染
   * @returns {Array}
   */
  checkPrototypePollution() {
    const detections = [];
    
    try {
      // 检查 Object.prototype 是否被修改
      const objectProtoKeys = Object.keys(Object.prototype);
      const suspiciousProtoKeys = ['constructor', '__proto__', 'prototype'];
      
      for (const key of objectProtoKeys) {
        if (!suspiciousProtoKeys.includes(key) && !Object.prototype.hasOwnProperty.call(Object.prototype, key)) {
          // 可能被污染
          detections.push({
            name: 'ObjectPrototypePollution',
            type: 'prototype_pollution',
            severity: 'high',
            timestamp: Date.now(),
            details: `Unexpected key on Object.prototype: ${key}`
          });
        }
      }
      
      // 检查 Array.prototype
      const arrayProtoKeys = Object.keys(Array.prototype);
      const knownArrayMethods = [
        'length', 'constructor', 'concat', 'copyWithin', 'fill', 'find', 'findIndex',
        'pop', 'push', 'reverse', 'shift', 'slice', 'sort', 'splice', 'unshift',
        'includes', 'indexOf', 'keys', 'entries', 'forEach', 'filter', 'flat',
        'flatMap', 'map', 'every', 'some', 'reduce', 'reduceRight', 'toLocaleString',
        'toString', 'values', 'at', 'findLast', 'findLastIndex', 'toReversed',
        'toSorted', 'toSpliced', 'with'
      ];
      
      for (const key of arrayProtoKeys) {
        if (!knownArrayMethods.includes(key)) {
          detections.push({
            name: 'ArrayPrototypePollution',
            type: 'prototype_pollution',
            severity: 'medium',
            timestamp: Date.now(),
            details: `Unexpected key on Array.prototype: ${key}`
          });
        }
      }
      
    } catch (error) {
      // 忽略
    }
    
    return detections;
  }

  /**
   * 检查 Native 函数是否被 Hook
   * @returns {Array}
   */
  checkNativeHooks() {
    const detections = [];
    
    try {
      for (const [name, original] of this.originalFunctions.entries()) {
        const current = original.fn;
        
        if (!current) continue;
        
        // 检查 toString 结果是否被修改
        const currentString = current.toString();
        
        // Native 函数通常显示为 [native code]
        if (original.string.includes('[native code]') && 
            !currentString.includes('[native code]')) {
          detections.push({
            name: `NativeHook_${name}`,
            type: 'native_hook',
            severity: 'critical',
            timestamp: Date.now(),
            details: `Function ${name} appears to be hooked`,
            original: original.string.substring(0, 100),
            current: currentString.substring(0, 100)
          });
        }
        
        // 检查函数是否被替换
        if (current !== original.fn) {
          detections.push({
            name: `FunctionReplaced_${name}`,
            type: 'function_replacement',
            severity: 'high',
            timestamp: Date.now(),
            details: `Function ${name} reference changed`
          });
        }
      }
      
    } catch (error) {
      // 忽略
    }
    
    return detections;
  }

  /**
   * 检查 DOM 篡改
   * @returns {Array}
   */
  checkDOMTampering() {
    const detections = [];
    
    try {
      // 检查是否有隐藏的 iframe（可能用于注入）
      const hiddenIframes = document.querySelectorAll('iframe[style*="display: none"], iframe[style*="visibility: hidden"]');
      
      if (hiddenIframes.length > 0) {
        detections.push({
          name: 'HiddenIframes',
          type: 'dom_tampering',
          severity: 'medium',
          timestamp: Date.now(),
          details: `Found ${hiddenIframes.length} hidden iframes`
        });
      }
      
      // 检查是否有可疑的 script 标签
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.textContent || '';
        
        if (content.includes('eval(') || 
            content.includes('Function(') ||
            content.includes('document.write(')) {
          detections.push({
            name: 'SuspiciousScript',
            type: 'dom_tampering',
            severity: 'high',
            timestamp: Date.now(),
            details: 'Script contains suspicious patterns'
          });
          break;
        }
      }
      
    } catch (error) {
      // 忽略
    }
    
    return detections;
  }

  /**
   * 检查时间篡改
   * @returns {Array}
   */
  checkTimeManipulation() {
    const detections = [];
    
    try {
      // 使用 Performance API 检测时间异常
      const now = Date.now();
      const perfNow = performance.now();
      
      // 如果两次调用相差太大，可能时间被篡改
      const expectedPerfNow = perfNow - this.lastPerfNow || 0;
      
      if (this.lastPerfNow && expectedPerfNow > this.scanInterval * 2) {
        detections.push({
          name: 'TimeManipulation',
          type: 'time_tampering',
          severity: 'medium',
          timestamp: now,
          details: 'Possible time manipulation detected'
        });
      }
      
      this.lastPerfNow = perfNow;
      
    } catch (error) {
      // 忽略
    }
    
    return detections;
  }

  /**
   * 记录检测结果
   * @param {Array} detections 
   */
  recordDetections(detections) {
    this.detectionHistory.push(...detections);
    
    // 限制历史大小
    if (this.detectionHistory.length > this.maxHistorySize) {
      this.detectionHistory = this.detectionHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * 上报检测结果
   * @param {Array} detections 
   */
  async reportDetections(detections) {
    try {
      // 过滤严重级别
      const criticalAndHigh = detections.filter(
        d => d.severity === 'critical' || d.severity === 'high'
      );
      
      if (criticalAndHigh.length === 0) {
        return; // 只上报严重问题
      }
      
      const response = await fetch(`${this.apiBaseUrl}/report-scan`, {
        method: 'POST',
        headers: this.memoryGuard.getSecureHeaders(),
        body: JSON.stringify({
          sessionId: this.memoryGuard.sessionId,
          scanCount: this.scanCount,
          detections: criticalAndHigh,
          timestamp: Date.now(),
          url: window.location.href
        })
      });
      
      const result = await response.json();
      
      if (result.action === 'ban') {
        this.memoryGuard.triggerBan(result.reason);
      }
      
    } catch (error) {
      console.error('[MemoryScanner] Failed to report:', error);
    }
  }

  /**
   * 获取扫描统计
   * @returns {Object}
   */
  getStats() {
    const severityCounts = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    };
    
    for (const detection of this.detectionHistory) {
      severityCounts[detection.severity] = (severityCounts[detection.severity] || 0) + 1;
    }
    
    return {
      scanCount: this.scanCount,
      isScanning: this.isScanning,
      totalDetections: this.detectionHistory.length,
      severityCounts,
      lastScanTime: this.detectionHistory.length > 0 
        ? this.detectionHistory[this.detectionHistory.length - 1].timestamp 
        : null
    };
  }

  /**
   * 手动触发扫描
   * @returns {Promise<Object>}
   */
  async manualScan() {
    const detections = await this.scan();
    return {
      scanCount: this.scanCount,
      detections,
      stats: this.getStats()
    };
  }

  /**
   * 清除历史记录
   */
  clearHistory() {
    this.detectionHistory = [];
  }
}

// 单例导出
const memoryScanner = new MemoryScanner();

// 全局暴露
if (typeof window !== 'undefined') {
  window.__memoryScanner = memoryScanner;
}

module.exports = { MemoryScanner, memoryScanner };
