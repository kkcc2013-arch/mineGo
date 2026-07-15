/**
 * MemoryGuard - 游戏客户端动态内存保护系统
 * 
 * 功能：
 * - 关键数据结构的内存布局定义与保护
 * - 周期性内存哈希校验
 * - 异常检测与上报
 * - 反调试与反注入机制
 * 
 * @module game-client/security/MemoryGuard
 */

'use strict';

class MemoryGuard {
  constructor(options = {}) {
    // 配置
    this.scanInterval = options.scanInterval || 5000; // 扫描间隔 5 秒
    this.enabled = options.enabled !== false;
    this.strictMode = options.strictMode || false; // 严格模式立即断开连接
    
    // 受保护的内存区域
    this.protectedRegions = new Map();
    
    // 校验状态
    this.lastScanTime = 0;
    this.scanCount = 0;
    this.violationCount = 0;
    
    // 回调函数
    this.onViolation = options.onViolation || this.defaultViolationHandler;
    this.onScanComplete = options.onScanComplete || null;
    
    // 定时器
    this.scanTimer = null;
    
    // 反调试状态
    this.debugDetected = false;
    
    // 统计
    this.stats = {
      totalScans: 0,
      violations: 0,
      falsePositives: 0,
      lastViolationTime: null
    };
  }

  /**
   * 注册受保护的内存区域
   * @param {string} name - 区域名称
   * @param {Object} target - 要保护的对象
   * @param {Object} options - 保护选项
   */
  register(name, target, options = {}) {
    if (this.protectedRegions.has(name)) {
      console.warn(`[MemoryGuard] Region "${name}" already registered, updating...`);
    }

    const region = {
      name,
      target,
      hash: this.computeHash(target),
      originalHash: this.computeHash(target),
      lastCheck: Date.now(),
      violationCount: 0,
      critical: options.critical || false, // 关键区域
      immutable: options.immutable || false, // 不可变区域
      onViolation: options.onViolation || null,
      checksumFields: options.checksumFields || null // 只检查特定字段
    };

    this.protectedRegions.set(name, region);
    
    console.log(`[MemoryGuard] Registered protected region: ${name}`, {
      critical: region.critical,
      immutable: region.immutable,
      hashLength: region.hash.length
    });

    return region;
  }

  /**
   * 注销受保护的内存区域
   * @param {string} name - 区域名称
   */
  unregister(name) {
    if (this.protectedRegions.has(name)) {
      this.protectedRegions.delete(name);
      console.log(`[MemoryGuard] Unregistered protected region: ${name}`);
    }
  }

  /**
   * 计算对象的内存哈希
   * @param {Object} obj - 目标对象
   * @param {string[]} fields - 只计算特定字段
   * @returns {string} 哈希值
   */
  computeHash(obj, fields = null) {
    try {
      let dataToHash;
      
      if (fields && Array.isArray(fields)) {
        // 只计算指定字段
        dataToHash = {};
        for (const field of fields) {
          if (obj.hasOwnProperty(field)) {
            dataToHash[field] = obj[field];
          }
        }
      } else {
        dataToHash = obj;
      }
      
      const str = JSON.stringify(dataToHash, Object.keys(dataToHash).sort());
      
      // 简单哈希算法（生产环境可用 Web Crypto API）
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      
      // 转为16进制字符串
      const hashHex = Math.abs(hash).toString(16).padStart(8, '0');
      
      // 加入时间戳混淆（防止静态分析）
      const salt = (Date.now() & 0xFFFF).toString(16);
      return `${hashHex}-${salt}`;
    } catch (error) {
      console.error('[MemoryGuard] Hash computation error:', error);
      return 'ERROR-' + Date.now();
    }
  }

  /**
   * 更新区域哈希（合法修改后调用）
   * @param {string} name - 区域名称
   */
  updateHash(name) {
    const region = this.protectedRegions.get(name);
    if (region) {
      const newHash = this.computeHash(region.target, region.checksumFields);
      region.hash = newHash;
      region.lastCheck = Date.now();
      
      console.log(`[MemoryGuard] Updated hash for region: ${name}`);
    }
  }

  /**
   * 扫描所有受保护的内存区域
   * @returns {Object} 扫描结果
   */
  scan() {
    if (!this.enabled) {
      return { enabled: false, violations: [], timestamp: Date.now() };
    }

    const startTime = performance.now();
    const violations = [];
    const results = [];

    for (const [name, region] of this.protectedRegions) {
      const currentHash = this.computeHash(region.target, region.checksumFields);
      const isValid = currentHash === region.hash || currentHash === region.originalHash;
      
      const result = {
        name,
        isValid,
        expectedHash: region.hash,
        currentHash,
        critical: region.critical,
        checkTime: Date.now() - region.lastCheck
      };

      results.push(result);

      if (!isValid) {
        const violation = {
          region: name,
          expected: region.hash,
          actual: currentHash,
          timestamp: Date.now(),
          critical: region.critical,
          immutable: region.immutable
        };

        violations.push(violation);
        region.violationCount++;
        this.violationCount++;
        this.stats.violations++;
        this.stats.lastViolationTime = new Date().toISOString();

        // 触发违规回调
        if (region.onViolation) {
          region.onViolation(violation);
        }
        
        this.onViolation(violation);
      }

      region.lastCheck = Date.now();
    }

    this.scanCount++;
    this.stats.totalScans++;
    this.lastScanTime = Date.now();

    const scanDuration = performance.now() - startTime;

    const report = {
      enabled: true,
      timestamp: Date.now(),
      duration: scanDuration,
      regionsChecked: this.protectedRegions.size,
      violations: violations.length,
      violationDetails: violations,
      results
    };

    if (this.onScanComplete) {
      this.onScanComplete(report);
    }

    return report;
  }

  /**
   * 启动周期性扫描
   */
  start() {
    if (this.scanTimer) {
      console.warn('[MemoryGuard] Already running');
      return;
    }

    this.enabled = true;
    this.scanTimer = setInterval(() => {
      this.scan();
    }, this.scanInterval);

    console.log(`[MemoryGuard] Started periodic scanning (interval: ${this.scanInterval}ms)`);
    
    // 启动反调试检测
    this.startAntiDebug();
  }

  /**
   * 停止周期性扫描
   */
  stop() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    this.enabled = false;
    this.stopAntiDebug();
    
    console.log('[MemoryGuard] Stopped');
  }

  /**
   * 默认违规处理器
   */
  defaultViolationHandler(violation) {
    console.error('[MemoryGuard] Memory violation detected!', {
      region: violation.region,
      critical: violation.critical,
      timestamp: violation.timestamp
    });

    // 上报违规
    this.reportViolation(violation);

    // 严格模式下立即断开
    if (this.strictMode && violation.critical) {
      this.disconnect('CRITICAL_MEMORY_VIOLATION');
    }
  }

  /**
   * 上报违规到服务器
   */
  async reportViolation(violation) {
    try {
      const report = {
        type: 'MEMORY_VIOLATION',
        region: violation.region,
        expected: violation.expected,
        actual: violation.actual,
        timestamp: violation.timestamp,
        critical: violation.critical,
        userAgent: navigator.userAgent,
        url: window.location.href,
        scanCount: this.scanCount,
        totalViolations: this.violationCount
      };

      // 添加内存快照（敏感信息需脱敏）
      report.memorySnapshot = this.captureMemorySnapshot(violation.region);

      // 发送到服务器
      const response = await fetch('/api/security/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(report)
      });

      if (!response.ok) {
        console.error('[MemoryGuard] Failed to report violation');
      }
    } catch (error) {
      console.error('[MemoryGuard] Report error:', error);
    }
  }

  /**
   * 捕获内存快照
   */
  captureMemorySnapshot(regionName) {
    const region = this.protectedRegions.get(regionName);
    if (!region) return null;

    // 返回脱敏后的快照
    const snapshot = {};
    const target = region.target;

    for (const key of Object.keys(target)) {
      const value = target[key];
      
      // 敏感字段脱敏
      if (typeof value === 'string' && value.length > 20) {
        snapshot[key] = value.substring(0, 4) + '***' + value.substring(value.length - 4);
      } else if (typeof value === 'number') {
        snapshot[key] = value;
      } else if (typeof value === 'boolean') {
        snapshot[key] = value;
      } else {
        snapshot[key] = typeof value;
      }
    }

    return {
      region: regionName,
      fields: Object.keys(snapshot),
      timestamp: Date.now()
    };
  }

  /**
   * 断开连接（严重违规时）
   */
  disconnect(reason) {
    console.error(`[MemoryGuard] Disconnecting: ${reason}`);
    
    // 清除本地数据
    localStorage.clear();
    sessionStorage.clear();
    
    // 跳转到错误页面
    window.location.href = `/error?code=SECURITY_VIOLATION&reason=${encodeURIComponent(reason)}`;
  }

  /**
   * 启动反调试检测
   */
  startAntiDebug() {
    // 方法1：检测开发者工具（控制台）
    this.devtoolsCheck();
    
    // 方法2：检测调试器语句
    this.debuggerCheck();
    
    // 方法3：检测性能异常（调试时执行变慢）
    this.performanceCheck();
  }

  /**
   * 停止反调试检测
   */
  stopAntiDebug() {
    // 清理检测定时器
    if (this._devtoolsTimer) {
      clearInterval(this._devtoolsTimer);
    }
  }

  /**
   * 开发者工具检测
   */
  devtoolsCheck() {
    const threshold = 160;
    
    const check = () => {
      const widthThreshold = window.outerWidth - window.innerWidth > threshold;
      const heightThreshold = window.outerHeight - window.innerHeight > threshold;
      
      if (widthThreshold || heightThreshold) {
        this.handleDebugDetected('DEVTOOLS_OPEN');
      }
    };

    this._devtoolsTimer = setInterval(check, 1000);
    
    // 监听开发者工具打开事件
    const element = new Image();
    Object.defineProperty(element, 'id', {
      get: () => {
        this.handleDebugDetected('DEVTOOLS_CONSOLE');
      }
    });
  }

  /**
   * 调试器检测
   */
  debuggerCheck() {
    const start = performance.now();
    
    // 使用 debugger 语句检测
    // 注意：这会触发断点，谨慎使用
    // debugger;
    
    const duration = performance.now() - start;
    
    // 如果执行时间异常长，可能被调试
    if (duration > 100) {
      this.handleDebugDetected('DEBUGGER_STATEMENT');
    }
  }

  /**
   * 性能检测
   */
  performanceCheck() {
    const start = performance.now();
    
    for (let i = 0; i < 1000; i++) {
      Math.random();
    }
    
    const duration = performance.now() - start;
    
    // 正常情况下应该 < 1ms
    // 如果调试器开启，执行会变慢
    if (duration > 50) {
      this.handleDebugDetected('PERFORMANCE_ANOMALY');
    }
  }

  /**
   * 处理调试检测
   */
  handleDebugDetected(type) {
    if (this.debugDetected) return;
    
    this.debugDetected = true;
    
    console.warn(`[MemoryGuard] Debug detected: ${type}`);
    
    // 上报调试检测
    this.reportDebugDetection(type);
    
    // 触发违规
    this.onViolation({
      region: 'DEBUG_DETECTION',
      type,
      timestamp: Date.now(),
      critical: true
    });
  }

  /**
   * 上报调试检测
   */
  async reportDebugDetection(type) {
    try {
      await fetch('/api/security/debug-detected', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          type,
          timestamp: Date.now(),
          userAgent: navigator.userAgent,
          url: window.location.href
        })
      });
    } catch (error) {
      console.error('[MemoryGuard] Failed to report debug detection');
    }
  }

  /**
   * 获取保护状态
   */
  getStatus() {
    return {
      enabled: this.enabled,
      scanInterval: this.scanInterval,
      regionsCount: this.protectedRegions.size,
      totalScans: this.stats.totalScans,
      violations: this.stats.violations,
      lastScanTime: this.lastScanTime,
      debugDetected: this.debugDetected,
      regions: Array.from(this.protectedRegions.keys())
    };
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.stats = {
      totalScans: 0,
      violations: 0,
      falsePositives: 0,
      lastViolationTime: null
    };
    this.scanCount = 0;
    this.violationCount = 0;
  }
}

// 导出单例
let instance = null;

function getMemoryGuard(options = {}) {
  if (!instance) {
    instance = new MemoryGuard(options);
  }
  return instance;
}

module.exports = {
  MemoryGuard,
  getMemoryGuard
};
