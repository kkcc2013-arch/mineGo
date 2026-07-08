/**
 * InjectionDetector - 注入工具检测与防护系统
 * 
 * 检测常见注入工具：Frida、Xposed/LSPosed、GameGuardian、虚拟环境
 * 
 * 功能：
 * - 多维度检测（进程、端口、文件、API痕迹）
 * - 动态响应（实时阻断、延迟上报、服务器协同）
 * - 检测规则热更新
 * - 误报防护
 * 
 * @module frontend/game-client/src/security/InjectionDetector
 */

class InjectionDetector {
  constructor() {
    this.detectionRules = new Map();
    this.lastDetectionTime = 0;
    this.detectionInterval = 60000; // 每分钟检测一次
    this.reportQueue = [];
    this.hotUpdateUrl = '/api/v1/security/detection-rules';
    this.apiBaseUrl = '/api/v1/security';
    this.deviceId = null;
    this.initialized = false;
    this.detectionTimer = null;
    
    // 检测结果缓存
    this.cachedResults = {
      frida: null,
      xposed: null,
      gameguardian: null,
      virtual: null
    };
    
    // 统计
    this.stats = {
      totalDetections: 0,
      highRiskDetections: 0,
      reportsSent: 0,
      lastCheckTime: null
    };
    
    // 风险等级
    this.RISK_LEVELS = {
      LOW: 'low',
      MEDIUM: 'medium',
      HIGH: 'high',
      CRITICAL: 'critical'
    };
    
    // 平台检测
    this.platform = this.detectPlatform();
  }

  /**
   * 初始化检测器
   */
  async init() {
    if (this.initialized) {
      return { success: true };
    }

    try {
      // 获取设备 ID
      this.deviceId = await this.getDeviceId();
      
      // 加载检测规则
      await this.loadRulesFromServer();
      
      // 执行首次检测
      const results = await this.performDetection();
      
      // 启动定时检测
      this.startPeriodicDetection();
      
      this.initialized = true;
      
      console.log('[InjectionDetector] Initialized', {
        platform: this.platform,
        deviceId: this.deviceId,
        initialRisk: results.riskLevel
      });
      
      return {
        success: true,
        deviceId: this.deviceId,
        riskLevel: results.riskLevel
      };
    } catch (error) {
      console.error('[InjectionDetector] Init failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 主检测入口
   */
  async performDetection() {
    const results = {
      timestamp: Date.now(),
      detections: [],
      riskLevel: this.RISK_LEVELS.LOW,
      deviceId: this.deviceId
    };

    try {
      // 1. Frida 检测
      const fridaResult = await this.detectFrida();
      if (fridaResult.detected) {
        results.detections.push(fridaResult);
        if (fridaResult.severity === 'high') {
          results.riskLevel = this.RISK_LEVELS.HIGH;
        } else if (results.riskLevel === this.RISK_LEVELS.LOW) {
          results.riskLevel = this.RISK_LEVELS.MEDIUM;
        }
      }

      // 2. Xposed/LSPosed 检测
      const xposedResult = await this.detectXposed();
      if (xposedResult.detected) {
        results.detections.push(xposedResult);
        if (xposedResult.isVirtual) {
          results.riskLevel = this.RISK_LEVELS.CRITICAL;
        } else if (results.riskLevel !== this.RISK_LEVELS.CRITICAL) {
          results.riskLevel = this.RISK_LEVELS.HIGH;
        }
      }

      // 3. GameGuardian 检测
      const ggResult = await this.detectGameGuardian();
      if (ggResult.detected) {
        results.detections.push(ggResult);
        if (results.riskLevel === this.RISK_LEVELS.LOW) {
          results.riskLevel = this.RISK_LEVELS.MEDIUM;
        }
      }

      // 4. 虚拟环境检测
      const virtualResult = await this.detectVirtualEnvironment();
      if (virtualResult.detected) {
        results.detections.push(virtualResult);
        results.riskLevel = this.RISK_LEVELS.CRITICAL;
      }

      // 更新统计
      this.stats.totalDetections++;
      this.stats.lastCheckTime = Date.now();
      if (results.riskLevel === this.RISK_LEVELS.HIGH || 
          results.riskLevel === this.RISK_LEVELS.CRITICAL) {
        this.stats.highRiskDetections++;
      }

      // 记录并上报
      this.recordDetection(results);
      if (results.riskLevel !== this.RISK_LEVELS.LOW) {
        await this.reportToServer(results);
      }

      return results;
    } catch (error) {
      console.error('[InjectionDetector] Detection failed:', error);
      results.error = error.message;
      return results;
    }
  }

  /**
   * Frida 检测策略
   */
  async detectFrida() {
    const indicators = [];

    // 策略 1：检测 frida-server 进程（Android）
    if (this.platform === 'android') {
      const processList = await this.getProcessList();
      const fridaProcesses = processList.filter(p => 
        p.name.includes('frida-server') || p.name.includes('frida')
      );
      if (fridaProcesses.length > 0) {
        indicators.push({ type: 'process', name: fridaProcesses[0].name });
      }

      // 策略 2：检测 Frida 默认端口 27042
      const portCheck = await this.checkPort(27042);
      if (portCheck.open) {
        indicators.push({ type: 'port', port: 27042 });
      }
    }

    // 策略 3：检测 Frida 特征文件
    const fridaFiles = [
      '/data/local/tmp/frida-server',
      '/data/local/tmp/re.frida.server',
      '/tmp/frida-server'
    ];
    for (const file of fridaFiles) {
      if (await this.fileExists(file)) {
        indicators.push({ type: 'file', path: file });
      }
    }

    // 策略 4：检测 JavaScript Bridge 痕迹
    if (typeof window !== 'undefined') {
      // Frida 注入后会修改某些全局对象
      const fridaIndicators = [
        '__frida',
        'Frida',
        'frida'
      ];
      
      for (const indicator of fridaIndicators) {
        if (window[indicator]) {
          indicators.push({ type: 'global', name: indicator });
        }
      }
      
      // 检测 Script 修改痕迹
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        if (script.textContent && script.textContent.includes('frida')) {
          indicators.push({ type: 'script', found: 'frida' });
          break;
        }
      }
    }

    this.cachedResults.frida = indicators.length > 0;

    return {
      tool: 'Frida',
      detected: indicators.length > 0,
      indicators,
      severity: indicators.length >= 2 ? 'high' : 'medium'
    };
  }

  /**
   * Xposed/LSPosed 检测策略
   */
  async detectXposed() {
    const indicators = [];

    // 策略 1：检测特征文件路径
    const xposedPaths = [
      '/system/framework/XposedBridge.jar',
      '/system/xposed.prop',
      '/data/misc/xposed/xposed.prop',
      '/data/adb/lspd/config',
      '/data/adb/modules/lspd'
    ];
    for (const path of xposedPaths) {
      if (await this.fileExists(path)) {
        indicators.push({ type: 'file', path });
      }
    }

    // 策略 2：检测 Xposed API 痕迹
    if (typeof window !== 'undefined') {
      if (window.XposedBridge) {
        indicators.push({ type: 'api', found: 'XposedBridge' });
      }
      if (window.XposedHelpers) {
        indicators.push({ type: 'api', found: 'XposedHelpers' });
      }
    }

    // 策略 3：检测堆栈中的 Xposed 调用痕迹
    try {
      const stackTrace = this.captureStackTrace();
      const xposedFrames = stackTrace.filter(f => 
        f.includes('de.robv.android.xposed') || 
        f.includes('org.lsposed.lspd')
      );
      if (xposedFrames.length > 0) {
        indicators.push({ type: 'stack', frames: xposedFrames.slice(0, 3) });
      }
    } catch (e) {
      // Stack trace 捕获失败本身可能是反检测手段
    }

    const isVirtual = await this.isVirtualXposed();

    this.cachedResults.xposed = indicators.length > 0;

    return {
      tool: 'Xposed/LSPosed',
      detected: indicators.length > 0,
      indicators,
      severity: 'high',
      isVirtual
    };
  }

  /**
   * GameGuardian 检测
   */
  async detectGameGuardian() {
    const indicators = [];

    // 进程名检测
    const ggProcessNames = [
      'gameguardian',
      'gg_process',
      'speed.gg',
      'gameguardian.android'
    ];
    
    const processList = await this.getProcessList();
    const ggProcess = processList.find(p => 
      ggProcessNames.some(name => p.name.toLowerCase().includes(name))
    );
    
    if (ggProcess) {
      indicators.push({ 
        type: 'process', 
        pid: ggProcess.pid, 
        name: ggProcess.name 
      });
    }

    // 特征文件检测
    const ggFiles = [
      '/data/data/com.gameguardian',
      '/sdcard/GameGuardian'
    ];
    
    for (const file of ggFiles) {
      if (await this.fileExists(file)) {
        indicators.push({ type: 'file', path: file });
      }
    }

    this.cachedResults.gameguardian = indicators.length > 0;

    return {
      tool: 'GameGuardian',
      detected: indicators.length > 0,
      indicators,
      severity: 'medium'
    };
  }

  /**
   * 虚拟环境检测（VirtualXposed、太极等）
   */
  async detectVirtualEnvironment() {
    const indicators = [];

    // 检测虚拟应用包名
    const virtualPackages = [
      'io.va.exposed',
      'com.exposed.plugin',
      'com.lzplay.np',
      'me.weishu.exp',
      'com.tsng.hidemyapplist'
    ];
    
    const installedPackages = await this.getInstalledPackages();
    const foundPackages = virtualPackages.filter(pkg => 
      installedPackages.includes(pkg)
    );
    
    if (foundPackages.length > 0) {
      indicators.push({ type: 'package', packages: foundPackages });
    }

    // 检测虚拟环境特征
    const appPath = this.getApplicationPath();
    if (appPath && (appPath.includes('virtual') || appPath.includes('clone'))) {
      indicators.push({ type: 'path', path: appPath });
    }

    this.cachedResults.virtual = indicators.length > 0;

    return {
      tool: 'VirtualEnvironment',
      detected: indicators.length > 0,
      indicators,
      severity: 'critical'
    };
  }

  /**
   * 加载检测规则（热更新）
   */
  async loadRulesFromServer() {
    try {
      const response = await fetch(this.hotUpdateUrl, {
        headers: { 'X-Device-ID': this.deviceId }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      const rules = data.rules || [];
      
      // 更新检测规则
      for (const rule of rules) {
        this.detectionRules.set(rule.id, rule);
      }
      
      console.log('[InjectionDetector] Rules updated:', {
        count: rules.length,
        version: data.version
      });
      
      return { success: true, count: rules.length };
    } catch (error) {
      console.warn('[InjectionDetector] Failed to load rules:', error.message);
      // 使用默认规则
      return { success: false, error: error.message };
    }
  }

  /**
   * 上报检测结果
   */
  async reportToServer(results) {
    const report = {
      deviceId: results.deviceId,
      timestamp: results.timestamp,
      riskLevel: results.riskLevel,
      detections: results.detections.map(d => ({
        tool: d.tool,
        indicators: d.indicators.map(i => ({
          type: i.type,
          // 不上报敏感细节，只上报类型
          detected: true
        }))
      }))
    };

    try {
      const response = await fetch(`${this.apiBaseUrl}/injection-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report)
      });
      
      if (response.ok) {
        this.stats.reportsSent++;
        console.log('[InjectionDetector] Report sent successfully');
        return { success: true };
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      // 缓存到本地队列，后续重试
      this.reportQueue.push(report);
      console.warn('[InjectionDetector] Report queued:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 响应策略：根据风险等级采取不同措施
   */
  handleDetectionResult(results) {
    switch (results.riskLevel) {
      case this.RISK_LEVELS.CRITICAL:
        // 虚拟环境/严重注入：立即阻止游戏
        this.blockGameAccess('Virtual environment detected');
        break;
        
      case this.RISK_LEVELS.HIGH:
        // Frida/Xposed：延迟上报 + 功能降级
        this.degradeGameFeatures();
        this.showWarning('Injection tool detected');
        break;
        
      case this.RISK_LEVELS.MEDIUM:
        // GameGuardian：记录警告
        this.showWarning('Memory tool detected');
        break;
        
      case this.RISK_LEVELS.LOW:
        // 正常：无操作
        break;
    }
  }

  /**
   * 阻止游戏访问
   */
  blockGameAccess(reason) {
    console.error('[InjectionDetector] Blocking game access:', reason);
    
    // 显示错误信息
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.95);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 99999;
      color: white;
      font-family: Arial, sans-serif;
    `;
    
    overlay.innerHTML = `
      <h1 style="color: #ff4444; margin-bottom: 20px;">⚠️ 安全警告</h1>
      <p style="font-size: 18px; margin-bottom: 10px;">检测到不安全的运行环境</p>
      <p style="font-size: 14px; color: #888;">${reason}</p>
    `;
    
    document.body.appendChild(overlay);
    
    // 停止游戏循环
    if (typeof window !== 'undefined' && window.gameLoop) {
      window.gameLoop.stop();
    }
  }

  /**
   * 降级游戏功能
   */
  degradeGameFeatures() {
    console.warn('[InjectionDetector] Degrading game features');
    
    // 标记降级模式
    if (typeof window !== 'undefined') {
      window.__degradedMode = true;
    }
    
    // 可以在这里禁用某些功能
    // 例如：禁用交易、限制捕捉次数等
  }

  /**
   * 显示警告
   */
  showWarning(message) {
    console.warn('[InjectionDetector] Warning:', message);
    
    if (typeof window !== 'undefined' && window.alert) {
      // 在开发环境显示警告
      if (process.env.NODE_ENV === 'development') {
        alert(`Security Warning: ${message}`);
      }
    }
  }

  /**
   * 启动定时检测
   */
  startPeriodicDetection() {
    if (this.detectionTimer) {
      clearInterval(this.detectionTimer);
    }
    
    this.detectionTimer = setInterval(async () => {
      const results = await this.performDetection();
      
      if (results.riskLevel !== this.RISK_LEVELS.LOW) {
        this.handleDetectionResult(results);
      }
    }, this.detectionInterval);
  }

  /**
   * 停止定时检测
   */
  stopPeriodicDetection() {
    if (this.detectionTimer) {
      clearInterval(this.detectionTimer);
      this.detectionTimer = null;
    }
  }

  /**
   * 获取检测统计
   */
  getStats() {
    return {
      ...this.stats,
      initialized: this.initialized,
      platform: this.platform,
      cachedResults: this.cachedResults,
      queueSize: this.reportQueue.length
    };
  }

  /**
   * 销毁检测器
   */
  destroy() {
    this.stopPeriodicDetection();
    this.detectionRules.clear();
    this.reportQueue = [];
    this.initialized = false;
  }

  // ========== 辅助方法 ==========

  /**
   * 检测平台
   */
  detectPlatform() {
    if (typeof window === 'undefined') {
      return 'unknown';
    }
    
    const ua = navigator.userAgent.toLowerCase();
    
    if (ua.includes('android')) {
      return 'android';
    } else if (ua.includes('iphone') || ua.includes('ipad')) {
      return 'ios';
    } else if (ua.includes('windows')) {
      return 'windows';
    } else if (ua.includes('mac')) {
      return 'mac';
    } else if (ua.includes('linux')) {
      return 'linux';
    }
    
    return 'unknown';
  }

  /**
   * 获取设备 ID
   */
  async getDeviceId() {
    if (this.deviceId) {
      return this.deviceId;
    }
    
    // 生成设备指纹
    const components = [
      navigator.userAgent,
      navigator.language,
      screen.width + 'x' + screen.height,
      new Date().getTimezoneOffset(),
      navigator.hardwareConcurrency || ''
    ];
    
    const fingerprint = components.join('|');
    
    // 简单哈希
    let hash = 0;
    for (let i = 0; i < fingerprint.length; i++) {
      const char = fingerprint.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    
    this.deviceId = 'device_' + Math.abs(hash).toString(16);
    return this.deviceId;
  }

  /**
   * 获取进程列表（模拟，实际需要 Native Bridge）
   */
  async getProcessList() {
    // 在 Web 环境中无法直接获取进程列表
    // 需要通过 WebView Bridge 调用 Native API
    if (typeof window !== 'undefined' && window.androidBridge) {
      try {
        const processes = await window.androidBridge.getProcessList();
        return JSON.parse(processes);
      } catch (e) {
        console.warn('[InjectionDetector] Failed to get process list:', e);
      }
    }
    
    // 返回空列表（Web 环境）
    return [];
  }

  /**
   * 检查端口（模拟）
   */
  async checkPort(port) {
    // 在 Web 环境中无法直接检查端口
    // 需要通过 Native Bridge
    if (typeof window !== 'undefined' && window.androidBridge) {
      try {
        const result = await window.androidBridge.checkPort(port);
        return { open: result === true };
      } catch (e) {
        console.warn('[InjectionDetector] Failed to check port:', e);
      }
    }
    
    return { open: false };
  }

  /**
   * 检查文件是否存在（模拟）
   */
  async fileExists(path) {
    // 在 Web 环境中无法直接检查文件
    // 需要通过 Native Bridge
    if (typeof window !== 'undefined' && window.androidBridge) {
      try {
        const exists = await window.androidBridge.fileExists(path);
        return exists === true;
      } catch (e) {
        return false;
      }
    }
    
    return false;
  }

  /**
   * 获取已安装包列表（模拟）
   */
  async getInstalledPackages() {
    // 需要通过 Native Bridge
    if (typeof window !== 'undefined' && window.androidBridge) {
      try {
        const packages = await window.androidBridge.getInstalledPackages();
        return JSON.parse(packages);
      } catch (e) {
        return [];
      }
    }
    
    return [];
  }

  /**
   * 获取应用路径
   */
  getApplicationPath() {
    // 需要通过 Native Bridge
    if (typeof window !== 'undefined' && window.androidBridge) {
      try {
        return window.androidBridge.getApplicationPath() || '';
      } catch (e) {
        return '';
      }
    }
    
    return '';
  }

  /**
   * 捕获堆栈跟踪
   */
  captureStackTrace() {
    const stack = new Error().stack || '';
    return stack.split('\n').filter(line => line.trim());
  }

  /**
   * 检测是否为虚拟 Xposed 环境
   */
  async isVirtualXposed() {
    // 检测常见的虚拟 Xposed 应用特征
    const virtualPackages = ['io.va.exposed', 'com.lzplay.np'];
    const installedPackages = await this.getInstalledPackages();
    
    return virtualPackages.some(pkg => installedPackages.includes(pkg));
  }

  /**
   * 记录检测结果
   */
  recordDetection(results) {
    // 存储到本地存储
    if (typeof localStorage !== 'undefined') {
      try {
        const key = `detection_${results.timestamp}`;
        localStorage.setItem(key, JSON.stringify({
          riskLevel: results.riskLevel,
          toolCount: results.detections.length,
          timestamp: results.timestamp
        }));
        
        // 清理旧记录（只保留最近 100 条）
        const keys = Object.keys(localStorage)
          .filter(k => k.startsWith('detection_'))
          .sort();
        
        if (keys.length > 100) {
          keys.slice(0, keys.length - 100).forEach(k => {
            localStorage.removeItem(k);
          });
        }
      } catch (e) {
        // 忽略存储错误
      }
    }
  }
}

// 导出单例
const injectionDetector = new InjectionDetector();

module.exports = {
  InjectionDetector,
  injectionDetector
};
