// frontend/game-client/src/security/EnvironmentDetector.js
// REQ-00483: 客户端环境检测模块 - Root/越狱、模拟器、注入框架检测

'use strict';

/**
 * 环境检测器 - 检测客户端运行环境可信度
 */
class EnvironmentDetector {
  constructor() {
    this检测结果 = {
      isRooted: false,
      isJailbroken: false,
      isEmulator: false,
      hasDebuggerAttached: false,
      hasInjection: false,
      detectedHooks: [],
      modifiedFunctions: [],
      environmentData: {}
    };
    
    this.emulatorIndicators = [];
    this.hookIndicators = [];
  }

  /**
   * 执行完整环境检测
   */
  async detect() {
    console.log('[EnvironmentDetector] Starting environment detection...');
    
    // 1. Root/越狱检测
    await this.detectRootOrJailbreak();
    
    // 2. 模拟器检测
    await this.detectEmulator();
    
    // 3. 调试器检测
    await this.detectDebugger();
    
    // 4. 注入框架检测
    await this.detectInjection();
    
    // 5. 运行时完整性校验
    await this.checkRuntimeIntegrity();
    
    // 6. 收集环境数据
    this.collectEnvironmentData();
    
    console.log('[EnvironmentDetector] Detection complete', this检测结果);
    
    return this检测结果;
  }

  /**
   * Root/越狱检测
   * Web环境下通过浏览器特征和异常行为检测
   */
  async detectRootOrJailbreak() {
    const indicators = [];
    
    // 1. 检测开发者工具/调试器
    const devtoolsOpen = this._detectDevTools();
    if (devtoolsOpen) {
      indicators.push('devtools_open');
      this检测结果.hasDebuggerAttached = true;
    }
    
    // 2. 检测异常全局对象修改（可能是注入框架）
    const globalObjectModified = this._checkGlobalObjectModifications();
    if (globalObjectModified.length > 0) {
      indicators.push('global_objects_modified');
      this检测结果.detectedHooks = globalObjectModified;
    }
    
    // 3. 检测 Performance API 异常（时间加速）
    const timeAcceleration = this._detectTimeAcceleration();
    if (timeAcceleration) {
      indicators.push('time_acceleration');
      this检测结果.hasInjection = true;
    }
    
    // 4. 检测 User Agent 异常（可能是模拟器或修改过的浏览器）
    const userAgentAnomaly = this._analyzeUserAgent();
    if (userAgentAnomaly) {
      indicators.push('user_agent_anomaly');
    }
    
    // 标记结果
    if (indicators.length >= 2) {
      this检测结果.isRooted = true;
    }
    
    console.log('[EnvironmentDetector] Root/Jailbreak indicators:', indicators);
  }

  /**
   * 模拟器检测
   * 通过 WebGL、Canvas、WebRTC、Battery API 等特征识别
   */
  async detectEmulator() {
    const indicators = [];
    
    // 1. WebGL 渲染器特征检测
    const webglInfo = this._getWebGLInfo();
    if (webglInfo.renderer.includes('SwiftShader') || 
        webglInfo.renderer.includes('ANGLE') ||
        webglInfo.renderer.includes('llvmpipe')) {
      indicators.push('software_renderer');
      this.emulatorIndicators.push('webgl_swiftshader');
    }
    
    // 2. Canvas 指纹异常检测
    const canvasFingerprint = await this._getCanvasFingerprint();
    if (canvasFingerprint.isSuspicious) {
      indicators.push('canvas_anomaly');
      this.emulatorIndicators.push('canvas_suspicious');
    }
    
    // 3. WebRTC 本地 IP 异常
    const webrtcIPs = await this._getWebRTCIPs();
    if (webrtcIPs.length === 0 || webrtcIPs.includes('0.0.0.0')) {
      indicators.push('webrtc_blocked');
      this.emulatorIndicators.push('webrtc_anomaly');
    }
    
    // 4. Battery API 异常值检测
    const batteryInfo = await this._getBatteryInfo();
    if (batteryInfo.isSuspicious) {
      indicators.push('battery_anomaly');
      this.emulatorIndicators.push('battery_suspicious');
    }
    
    // 5. Navigator 属性异常检测
    const navigatorAnomalies = this._detectNavigatorAnomalies();
    if (navigatorAnomalies.length > 0) {
      indicators.push('navigator_anomaly');
      this.emulatorIndicators.push(...navigatorAnomalies);
    }
    
    // 6. 触摸屏支持检测
    const touchSupport = this._checkTouchSupport();
    if (!touchSupport.hasTouch) {
      indicators.push('no_touch');
      this.emulatorIndicators.push('no_touch_support');
    }
    
    // 7. 硬件并发数异常（模拟器通常为1-2）
    if (navigator.hardwareConcurrency <= 2) {
      indicators.push('low_cpu_cores');
      this.emulatorIndicators.push('hardware_concurrency_low');
    }
    
    // 判断是否为模拟器（需要3个以上指标）
    this检测结果.isEmulator = indicators.length >= 3;
    
    console.log('[EnvironmentDetector] Emulator indicators:', indicators);
  }

  /**
   * 调试器检测
   */
  async detectDebugger() {
    // 1. 检测 DevTools 打开状态
    const devtoolsOpen = this._detectDevTools();
    
    // 2. 检测 debugger 语句被触发
    const debuggerTriggered = await this._testDebuggerStatement();
    
    // 3. 检测时间差异常（调试时执行时间会变长）
    const timeDiffAnomaly = this._detectTimingAnomaly();
    
    this检测结果.hasDebuggerAttached = devtoolsOpen || debuggerTriggered || timeDiffAnomaly;
    
    console.log('[EnvironmentDetector] Debugger detection result:', this检测结果.hasDebuggerAttached);
  }

  /**
   * 注入框架检测
   * 检测常见的 Hook 框架和修改器痕迹
   */
  async detectInjection() {
    const detectedHooks = [];
    
    // 1. 检测 XMLHttpRequest 是否被 Hook
    if (this._isXMLHttpRequestHooked()) {
      detectedHooks.push('XMLHttpRequest');
    }
    
    // 2. 检测 fetch 是否被 Hook
    if (this._isFetchHooked()) {
      detectedHooks.push('fetch');
    }
    
    // 3. 检测 WebSocket 是否被 Hook
    if (this._isWebSocketHooked()) {
      detectedHooks.push('WebSocket');
    }
    
    // 4. 检测原型链是否被篡改
    const prototypeHooks = this._detectPrototypeChainModification();
    if (prototypeHooks.length > 0) {
      detectedHooks.push(...prototypeHooks);
    }
    
    // 5. 检测常见注入框架特征
    const frameworkDetected = this._detectInjectionFrameworks();
    if (frameworkDetected) {
      detectedHooks.push(frameworkDetected);
    }
    
    this检测结果.detectedHooks = detectedHooks;
    this检测结果.hasInjection = detectedHooks.length > 0;
    
    console.log('[EnvironmentDetector] Injection detection result:', detectedHooks);
  }

  /**
   * 运行时完整性校验
   * 检测关键函数是否被篡改
   */
  async checkRuntimeIntegrity() {
    const modifiedFunctions = [];
    const functionHashes = {};
    
    // 获取关键函数列表
    const criticalFunctions = [
      'calculateCaptureProbability',
      'processPokemonData',
      'validateLocation',
      'encryptPayload'
    ];
    
    for (const funcName of criticalFunctions) {
      try {
        // 检查函数是否存在
        if (typeof window.gameCore?.[funcName] === 'function') {
          const funcSource = window.gameCore[funcName].toString();
          const hash = await this._hashString(funcSource);
          
          functionHashes[funcName] = hash;
          
          // 比对预期哈希（实际应用中应从服务端获取）
          // 这里仅做本地标记，不阻止运行
          const expectedHash = this._getExpectedFunctionHash(funcName);
          if (expectedHash && hash !== expectedHash) {
            modifiedFunctions.push(funcName);
          }
        }
      } catch (error) {
        console.warn('[EnvironmentDetector] Function check error:', funcName, error);
      }
    }
    
    this检测结果.modifiedFunctions = modifiedFunctions;
    this检测结果.functionHashes = functionHashes;
    
    console.log('[EnvironmentDetector] Runtime integrity check result:', modifiedFunctions);
  }

  /**
   * 收集环境数据
   */
  collectEnvironmentData() {
    this检测结果.environmentData = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: navigator.languages,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory || 'unknown',
      screenWidth: screen.width,
      screenHeight: screen.height,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
      touchSupport: this._checkTouchSupport(),
      webglRenderer: this._getWebGLInfo().renderer,
      webglVendor: this._getWebGLInfo().vendor,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack,
      plugins: this._getPluginInfo(),
      fonts: this._getFontInfo()
    };
  }

  // ========== 内部检测方法 ==========

  /**
   * 检测开发者工具打开状态
   */
  _detectDevTools() {
    // 方法1: 通过 window.outerWidth/Height 差值
    const widthThreshold = window.outerWidth - window.innerWidth > 160;
    const heightThreshold = window.outerHeight - window.innerHeight > 160;
    
    // 方法2: 通过 console.log 执行时间差
    const start = performance.now();
    console.log('%c', 'font-size: 100px;');
    const end = performance.now();
    const consoleTimeThreshold = end - start > 100;
    
    // 方法3: 通过 debugger 检测（部分浏览器）
    let devtoolsOpen = false;
    const element = new Image();
    element.__defineGetter__('id', () => {
      devtoolsOpen = true;
    });
    
    return widthThreshold || heightThreshold || consoleTimeThreshold || devtoolsOpen;
  }

  /**
   * 检测全局对象修改
   */
  _checkGlobalObjectModifications() {
    const modifiedObjects = [];
    
    // 检测关键对象是否被修改
    const criticalObjects = [
      'XMLHttpRequest',
      'fetch',
      'WebSocket',
      'localStorage',
      'sessionStorage',
      'crypto'
    ];
    
    for (const objName of criticalObjects) {
      try {
        const nativeObj = window[objName];
        if (nativeObj && typeof nativeObj.toString === 'function') {
          const str = nativeObj.toString();
          // 原生对象 toString 通常返回 [object Object] 或 function ...
          if (!str.includes('[object') && !str.includes('function') && !str.includes('[native')) {
            modifiedObjects.push(objName);
          }
        }
      } catch (error) {
        // 无法访问，可能被修改
        modifiedObjects.push(objName);
      }
    }
    
    return modifiedObjects;
  }

  /**
   * 检测时间加速
   */
  _detectTimeAcceleration() {
    // 通过多次测量间隔检测时间异常
    const measurements = [];
    const iterations = 10;
    
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      // 执行一些计算
      for (let j = 0; j < 1000; j++) {
        Math.random();
      }
      const end = performance.now();
      measurements.push(end - start);
    }
    
    // 检测测量值是否异常一致（时间加速特征）
    const avg = measurements.reduce((a, b) => a + b, 0) / measurements.length;
    const variance = measurements.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / measurements.length;
    
    // 如果方差接近0，可能存在时间加速
    return variance < 0.01 && avg < 1;
  }

  /**
   * 分析 User Agent
   */
  _analyzeUserAgent() {
    const ua = navigator.userAgent;
    
    // 检测常见模拟器特征
    const emulatorPatterns = [
      'Android SDK',
      'Emulator',
      'Simulator',
      'x86',
      'x86_64',
      'Chrome/.*Mobile',
      'Genymotion',
      'BlueStacks',
      'Nox',
      'LDPlayer'
    ];
    
    return emulatorPatterns.some(pattern => {
      const regex = new RegExp(pattern, 'i');
      return regex.test(ua);
    });
  }

  /**
   * 获取 WebGL 信息
   */
  _getWebGLInfo() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      
      if (!gl) {
        return { renderer: 'unknown', vendor: 'unknown' };
      }
      
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      
      if (debugInfo) {
        return {
          renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
          vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
        };
      }
      
      return {
        renderer: gl.getParameter(gl.RENDERER),
        vendor: gl.getParameter(gl.VENDOR)
      };
    } catch (error) {
      return { renderer: 'error', vendor: 'error' };
    }
  }

  /**
   * 获取 Canvas 指纹
   */
  async _getCanvasFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      canvas.width = 200;
      canvas.height = 50;
      
      // 绘制测试图案
      ctx.fillStyle = 'rgb(255, 0, 255)';
      ctx.fillRect(0, 0, 200, 50);
      ctx.fillStyle = 'rgb(0, 255, 255)';
      ctx.fillRect(100, 0, 100, 50);
      
      // 添加文字
      ctx.font = '14px Arial';
      ctx.fillStyle = 'rgb(0, 0, 0)';
      ctx.fillText('MineGo Security Check', 10, 30);
      
      // 获取指纹
      const dataUrl = canvas.toDataURL();
      const hash = await this._hashString(dataUrl);
      
      // 检测异常（模拟器可能返回空白或一致的指纹）
      const isSuspicious = dataUrl.length < 1000 || hash === 'blank_canvas_hash';
      
      return { hash, isSuspicious };
    } catch (error) {
      return { hash: 'error', isSuspicious: true };
    }
  }

  /**
   * 获取 WebRTC 本地 IPs
   */
  async _getWebRTCIPs() {
    const ips = [];
    
    try {
      const pc = new RTCPeerConnection({
        iceServers: []
      });
      
      pc.createDataChannel('');
      
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const candidate = event.candidate.candidate;
          const ipMatch = candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
          if (ipMatch) {
            ips.push(ipMatch[1]);
          }
        }
      };
      
      await pc.createOffer().then(offer => pc.setLocalDescription(offer));
      
      // 等待 ICE 收集完成
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      pc.close();
    } catch (error) {
      // WebRTC 可能被阻止
    }
    
    return ips;
  }

  /**
   * 获取电池信息
   */
  async _getBatteryInfo() {
    try {
      if ('getBattery' in navigator) {
        const battery = await navigator.getBattery();
        
        // 检测异常值（模拟器常返回100%且充电）
        const isSuspicious = 
          battery.level === 1.0 && 
          battery.charging === true &&
          battery.chargingTime === 0;
        
        return {
          level: battery.level,
          charging: battery.charging,
          chargingTime: battery.chargingTime,
          dischargingTime: battery.dischargingTime,
          isSuspicious
        };
      }
    } catch (error) {
      // Battery API 可能被阻止
    }
    
    return { isSuspicious: false };
  }

  /**
   * 检测 Navigator 异常
   */
  _detectNavigatorAnomalies() {
    const anomalies = [];
    
    // 检测语言设置异常
    if (!navigator.language || navigator.language === 'und') {
      anomalies.push('language_undefined');
    }
    
    // 检测平台异常
    if (navigator.platform.includes('Linux x86_64') && navigator.userAgent.includes('Mobile')) {
      anomalies.push('platform_mobile_inconsistency');
    }
    
    // 检测 plugins 异常（模拟器可能为空）
    if (navigator.plugins.length === 0) {
      anomalies.push('no_plugins');
    }
    
    return anomalies;
  }

  /**
   * 检测触摸屏支持
   */
  _checkTouchSupport() {
    return {
      hasTouch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
      maxTouchPoints: navigator.maxTouchPoints,
      touchEvent: 'TouchEvent' in window
    };
  }

  /**
   * 测试 debugger 语句
   */
  async _testDebuggerStatement() {
    let triggered = false;
    
    try {
      // 使用 setTimeout 避免阻塞
      const start = performance.now();
      debugger;  // 如果调试器打开，这里会暂停
      const end = performance.now();
      
      // 如果时间差很大，说明 debugger 被触发
      triggered = (end - start) > 100;
    } catch (error) {
      triggered = true;
    }
    
    return triggered;
  }

  /**
   * 检测时间差异常
   */
  _detectTimingAnomaly() {
    const iterations = 100;
    const times = [];
    
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      // 执行简单计算
      Math.sqrt(i);
      const end = performance.now();
      times.push(end - start);
    }
    
    // 检测时间差是否异常大
    const avg = times.reduce((a, b) => a + b, 0) / iterations;
    return avg > 5;  // 正常应该 < 1ms
  }

  /**
   * 检测 XMLHttpRequest 是否被 Hook
   */
  _isXMLHttpRequestHooked() {
    try {
      const nativeXHR = window.XMLHttpRequest.prototype;
      const openStr = nativeXHR.open.toString();
      
      // 原生方法 toString 应返回 "function open() { [native code] }"
      return !openStr.includes('[native code]');
    } catch (error) {
      return true;
    }
  }

  /**
   * 检测 fetch 是否被 Hook
   */
  _isFetchHooked() {
    try {
      const fetchStr = window.fetch.toString();
      return !fetchStr.includes('[native code]');
    } catch (error) {
      return true;
    }
  }

  /**
   * 检测 WebSocket 是否被 Hook
   */
  _isWebSocketHooked() {
    try {
      const wsStr = window.WebSocket.toString();
      return !wsStr.includes('[native code]');
    } catch (error) {
      return true;
    }
  }

  /**
   * 检测原型链修改
   */
  _detectPrototypeChainModification() {
    const modifications = [];
    
    try {
      // 检测 Object.prototype 是否被修改
      const objectProto = Object.prototype;
      const ownProps = Object.getOwnPropertyNames(objectProto);
      
      // 原生 Object.prototype 只有少数属性
      const nativeProps = ['__proto__', 'constructor', 'toString', 'toLocaleString', 
        'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'];
      
      const extraProps = ownProps.filter(prop => !nativeProps.includes(prop));
      
      if (extraProps.length > 0) {
        modifications.push(...extraProps.map(p => `Object.prototype.${p}`));
      }
      
      // 检测 Array.prototype
      const arrayProto = Array.prototype;
      const arrayOwnProps = Object.getOwnPropertyNames(arrayProto);
      const nativeArrayProps = ['length', 'constructor', 'toString', 'toLocaleString',
        'join', 'pop', 'push', 'reverse', 'shift', 'slice', 'sort', 'splice',
        'unshift', 'concat', 'indexOf', 'lastIndexOf', 'forEach', 'map', 'filter',
        'reduce', 'reduceRight', 'find', 'findIndex', 'every', 'some', 'includes',
        'fill', 'copyWithin', 'entries', 'keys', 'values', '__proto__'];
      
      const extraArrayProps = arrayOwnProps.filter(prop => !nativeArrayProps.includes(prop));
      
      if (extraArrayProps.length > 0) {
        modifications.push(...extraArrayProps.map(p => `Array.prototype.${p}`));
      }
    } catch (error) {
      modifications.push('prototype_chain_error');
    }
    
    return modifications;
  }

  /**
   * 检测注入框架特征
   */
  _detectInjectionFrameworks() {
    // 检测常见注入框架特征
    const frameworkPatterns = {
      'Frida': ['frida', 'Frida', 'FRIDA'],
      'Xposed': ['xposed', 'Xposed', 'de.robv.android.xposed'],
      'CydiaSubstrate': ['substrate', 'Substrate', 'MSHook'],
      'Tampermonkey': ['tampermonkey', 'Tampermonkey'],
      'Greasemonkey': ['greasemonkey', 'Greasemonkey']
    };
    
    for (const [framework, patterns] of Object.entries(frameworkPatterns)) {
      for (const pattern of patterns) {
        if (pattern in window || 
            (window.gameCore && pattern in window.gameCore) ||
            navigator.userAgent.includes(pattern)) {
          return framework;
        }
      }
    }
    
    return null;
  }

  /**
   * 获取插件信息
   */
  _getPluginInfo() {
    if (!navigator.plugins) return [];
    
    return Array.from(navigator.plugins).map(plugin => ({
      name: plugin.name,
      description: plugin.description,
      filename: plugin.filename
    }));
  }

  /**
   * 获取字体信息
   */
  _getFontInfo() {
    // 简化版字体检测
    const testFonts = ['Arial', 'Verdana', 'Times New Roman', 'Courier New'];
    const availableFonts = [];
    
    for (const font of testFonts) {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = '12px ' + font;
        
        if (ctx.font.includes(font)) {
          availableFonts.push(font);
        }
      } catch (error) {
        // 忽略错误
      }
    }
    
    return availableFonts;
  }

  /**
   * 计算字符串哈希
   */
  async _hashString(str) {
    if (!str) return 'empty';
    
    // 使用 SubtleCrypto（如果可用）
    if ('crypto' in window && 'subtle' in window.crypto) {
      try {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
      } catch (error) {
        // 回退到简单哈希
      }
    }
    
    // 简单哈希算法
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * 获取预期函数哈希（从服务端获取）
   */
  _getExpectedFunctionHash(funcName) {
    // 实际应用中应从服务端动态获取
    // 这里返回空，让服务端验证
    return null;
  }

  /**
   * 获取检测结果摘要
   */
  getSummary() {
    return {
      isClean: !this检测结果.isRooted && 
               !this检测结果.isJailbroken && 
               !this检测结果.isEmulator && 
               !this检测结果.hasDebuggerAttached && 
               !this检测结果.hasInjection && 
               this检测结果.modifiedFunctions.length === 0,
      riskLevel: this._calculateRiskLevel(),
      indicators: {
        rooted: this检测结果.isRooted,
        emulator: this检测结果.isEmulator,
        debugger: this检测结果.hasDebuggerAttached,
        injection: this检测结果.hasInjection,
        modified: this检测结果.modifiedFunctions.length > 0
      }
    };
  }

  /**
   * 计算风险等级
   */
  _calculateRiskLevel() {
    let score = 0;
    
    if (this检测结果.isRooted || this检测结果.isJailbroken) score += 40;
    if (this检测结果.isEmulator) score += 50;
    if (this检测结果.hasDebuggerAttached) score += 60;
    if (this检测结果.hasInjection) score += 70;
    if (this检测结果.modifiedFunctions.length > 0) score += 90;
    
    if (score >= 100) return 'CRITICAL';
    if (score >= 70) return 'HIGH';
    if (score >= 40) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * 发送检测结果到服务端
   */
  async sendToServer() {
    const detectionResult = await this.detect();
    
    try {
      const response = await fetch('/api/v1/integrity/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': localStorage.getItem('deviceId') || 'unknown'
        },
        body: JSON.stringify({
          environment: detectionResult.environmentData,
          risks: {
            isRooted: detectionResult.isRooted,
            isJailbroken: detectionResult.isJailbroken,
            isEmulator: detectionResult.isEmulator,
            hasDebuggerAttached: detectionResult.hasDebuggerAttached,
            hasInjection: detectionResult.hasInjection,
            detectedHooks: detectionResult.detectedHooks,
            modifiedFunctions: detectionResult.modifiedFunctions
          },
          functionHashes: detectionResult.functionHashes,
          timestamp: Date.now()
        })
      });
      
      if (!response.ok) {
        console.error('[EnvironmentDetector] Failed to send report:', response.status);
      }
      
      return response;
    } catch (error) {
      console.error('[EnvironmentDetector] Send error:', error);
      throw error;
    }
  }
}

// 导出
module.exports = EnvironmentDetector;

// 如果是浏览器环境，添加到全局
if (typeof window !== 'undefined') {
  window.EnvironmentDetector = EnvironmentDetector;
}