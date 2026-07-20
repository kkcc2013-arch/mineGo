# REQ-00604：游戏客户端内存扫描检测与防护系统

- **编号**：REQ-00604
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、backend/security、gateway、backend/shared/memoryProtection
- **创建时间**：2026-07-20 05:00
- **依赖需求**：REQ-00163 (游戏客户端内存篡改检测)

## 1. 背景与问题

当前 mineGo 已实现了基础的内存篡改检测功能（REQ-00163），能够检测游戏数值（精灵属性、道具数量、货币等）是否被非法修改。然而，针对高级作弊手段——特别是**内存扫描工具**（如 GameGuardian、Cheat Engine、Lucky Patcher 等）的主动防护仍然薄弱：

1. **内存扫描检测缺失**：作弊者可以扫描内存定位关键数值（HP、金币、精灵坐标等），然后批量修改。现有系统只能在修改后被动检测，无法识别扫描行为本身。

2. **关键数据暴露**：游戏进程内存中的敏感数据以明文或简单编码存储，容易被逆向分析和定位。

3. **进程保护不足**：游戏客户端未实施进程级别的保护措施（如 ptrace 附加防护、调试器检测），允许外部工具随意读写内存。

4. **延迟检测风险**：当前检测依赖服务器端校验，存在时间窗口（修改后到下一次同步前的延迟），作弊者可在此窗口内完成非法操作。

## 2. 目标

构建**多层内存安全防护体系**，实现：

1. **主动扫描检测**：实时检测内存扫描工具的运行和内存搜索行为，在扫描阶段即阻断作弊。
2. **数据混淆保护**：对客户端关键数值实施动态加密和虚拟化，增加逆向难度。
3. **进程防护加固**：防止调试器附加和进程内存 dump。
4. **行为风控联动**：检测到的异常行为实时上报，触发账号风控措施。

**预期收益**：
- 减少 95% 以上的内存扫描类作弊成功率
- 增加 10 倍以上的逆向分析成本
- 将作弊检测延迟从分钟级降低到秒级

## 3. 范围

### 包含
- 客户端内存扫描工具检测模块（检测常见扫描器进程）
- 内存值动态加密与虚拟化引擎
- 进程保护模块（反调试、反 ptrace）
- 关键数据内存布局随机化
- 扫描行为特征收集与上报
- 服务端风控联动接口

### 不包含
- 服务端数值校验逻辑（已有 REQ-00163）
- 设备 Root/越狱检测（已有 REQ-00045）
- 网络协议加密（已有 REQ-00434）

## 4. 详细需求

### 4.1 内存扫描工具检测模块

```javascript
// game-client/src/security/MemoryScannerDetector.js

class MemoryScannerDetector {
  constructor() {
    // 已知扫描工具签名库
    this.scannerSignatures = {
      gameGuardian: {
        packageName: ['com.kg256.mh', 'catchgame.me.gameguardian'],
        features: ['speedhack', 'memory_search', 'fuzzy_search']
      },
      cheatEngine: {
        processName: ['cheatengine-x86_64.exe', 'cheatengine-i386.exe'],
        features: ['memory_scan', 'pointer_scan']
      },
      luckyPatcher: {
        packageName: ['com.dimonvideo.luckypatcher', 'com.chelpus.luckypatcher'],
        features: ['apk_modify', 'license_bypass']
      }
    };
  }

  /**
   * 检测扫描工具进程
   * @returns {Object} 检测结果
   */
  detectScannerProcesses() {
    const detected = [];
    
    // Android: 使用 PackageManager 检查已安装应用
    if (this.isAndroid()) {
      for (const [name, sig] of Object.entries(this.scannerSignatures)) {
        if (sig.packageName?.some(pkg => this.checkPackageInstalled(pkg))) {
          detected.push({
            tool: name,
            risk: 'high',
            timestamp: Date.now()
          });
        }
      }
    }
    
    return {
      hasScanner: detected.length > 0,
      scanners: detected,
      riskLevel: detected.length > 0 ? 'critical' : 'low'
    };
  }

  /**
   * 检测内存搜索行为特征
   * 通过监控内存访问模式识别扫描行为
   */
  detectMemorySearchPattern() {
    // 记录内存访问频率和模式
    const memoryAccessPattern = this.collectMemoryAccessMetrics();
    
    // 扫描特征：大量连续内存读取、随机地址访问、重复范围搜索
    const isScanPattern = 
      memoryAccessPattern.sequentialReadRatio > 0.7 ||
      memoryAccessPattern.randomAccessRatio > 0.5 ||
      memoryAccessPattern.repeatScanCount > 3;
    
    return {
      isScanPattern,
      confidence: this.calculateConfidence(memoryAccessPattern),
      metrics: memoryAccessPattern
    };
  }
}
```

### 4.2 内存值动态加密引擎

```javascript
// game-client/src/security/MemoryValueProtector.js

class MemoryValueProtector {
  constructor() {
    this.encryptionKey = null;
    this.keyRotationInterval = 60000; // 1分钟轮换密钥
    this.protectedValues = new Map();
    this.xorMask = 0;
  }

  /**
   * 初始化保护引擎
   */
  initialize() {
    this.encryptionKey = this.generateKey();
    this.xorMask = Math.floor(Math.random() * 0xFFFFFFFF);
    
    // 定期轮换密钥
    setInterval(() => {
      this.rotateKey();
    }, this.keyRotationInterval);
  }

  /**
   * 保护数值 - 存储时加密
   * @param {number} value - 原始值
   * @param {string} key - 值标识
   * @returns {number} 加密后的存储值
   */
  protect(value, key) {
    // 方案1: XOR 掩码 + 密钥加密
    const masked = value ^ this.xorMask;
    
    // 方案2: 添加随机偏移（每次读取结果不同，但解密后一致）
    const randomOffset = Math.floor(Math.random() * 1000);
    const encrypted = masked ^ this.encryptionKey ^ randomOffset;
    
    // 存储元数据用于解密
    this.protectedValues.set(key, {
      offset: randomOffset,
      timestamp: Date.now()
    });
    
    return encrypted;
  }

  /**
   * 解密数值 - 读取时还原
   * @param {number} encryptedValue - 加密值
   * @param {string} key - 值标识
   * @returns {number} 原始值
   */
  unprotect(encryptedValue, key) {
    const meta = this.protectedValues.get(key);
    if (!meta) {
      console.warn(`[MemoryProtector] Unknown key: ${key}`);
      return 0;
    }
    
    const decrypted = encryptedValue ^ this.encryptionKey ^ meta.offset;
    const original = decrypted ^ this.xorMask;
    
    return original;
  }

  /**
   * 内存布局随机化
   * 将关键数据分散存储，避免连续内存块
   */
  scatterMemoryLayout(baseAddress, size) {
    const chunks = [];
    const chunkSize = 64; // 每块64字节
    const numChunks = Math.ceil(size / chunkSize);
    
    for (let i = 0; i < numChunks; i++) {
      // 随机偏移分配
      const randomOffset = Math.floor(Math.random() * 0x10000) * 0x1000;
      chunks.push({
        virtualIndex: i,
        actualAddress: baseAddress + randomOffset,
        size: chunkSize
      });
    }
    
    return chunks;
  }

  /**
   * 生成动态密钥
   */
  generateKey() {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    return array[0];
  }

  /**
   * 轮换密钥
   */
  rotateKey() {
    const oldKey = this.encryptionKey;
    this.encryptionKey = this.generateKey();
    
    // 触发所有保护值重新加密
    for (const [key, meta] of this.protectedValues) {
      meta.offset = Math.floor(Math.random() * 1000);
      meta.timestamp = Date.now();
    }
    
    console.log('[MemoryProtector] Key rotated');
  }
}
```

### 4.3 进程保护模块

```javascript
// game-client/src/security/ProcessProtector.js

class ProcessProtector {
  constructor() {
    this.protectionEnabled = false;
    this.detectionInterval = 5000; // 5秒检测一次
  }

  /**
   * 启用进程保护
   */
  enableProtection() {
    if (this.protectionEnabled) return;
    
    this.protectionEnabled = true;
    
    // 1. 反调试检测
    this.startAntiDebugDetection();
    
    // 2. 进程完整性校验
    this.startIntegrityCheck();
    
    // 3. ptrace 保护 (Linux/Android)
    if (this.isLinuxOrAndroid()) {
      this.enablePtraceProtection();
    }
    
    console.log('[ProcessProtector] Protection enabled');
  }

  /**
   * 反调试检测
   */
  startAntiDebugDetection() {
    const checkAntiDebug = () => {
      if (!this.protectionEnabled) return;
      
      // 检测方法1: 检查 TracerPid (Linux)
      const tracerPid = this.getTracerPid();
      if (tracerPid > 0) {
        this.reportSecurityEvent('debugger_detected', { tracerPid });
        this.handleSecurityBreach('debugger');
      }
      
      // 检测方法2: 时间检测（调试时执行变慢）
      const start = performance.now();
      for (let i = 0; i < 1000; i++) { /* 空循环 */ }
      const elapsed = performance.now() - start;
      
      if (elapsed > 10) { // 正常应该 < 1ms
        this.reportSecurityEvent('timing_anomaly', { elapsed });
      }
      
      // 检测方法3: 端口检测（调试器通常监听某端口）
      this.checkDebuggerPorts();
      
      setTimeout(checkAntiDebug, this.detectionInterval);
    };
    
    checkAntiDebug();
  }

  /**
   * 获取 TracerPid (Linux/Android)
   */
  getTracerPid() {
    try {
      // Node.js 环境: 读取 /proc/self/status
      const fs = require('fs');
      const status = fs.readFileSync('/proc/self/status', 'utf8');
      const match = status.match(/TracerPid:\s*(\d+)/);
      return match ? parseInt(match[1]) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 进程完整性校验
   */
  startIntegrityCheck() {
    const checkIntegrity = () => {
      if (!this.protectionEnabled) return;
      
      // 校验关键代码段哈希
      const codeHash = this.calculateCodeHash();
      if (!this.verifyCodeHash(codeHash)) {
        this.reportSecurityEvent('code_tampered', { hash: codeHash });
        this.handleSecurityBreach('code_tamper');
      }
      
      // 校验内存布局
      const memoryLayout = this.getMemoryLayout();
      if (!this.verifyMemoryLayout(memoryLayout)) {
        this.reportSecurityEvent('memory_layout_changed');
      }
      
      setTimeout(checkIntegrity, this.detectionInterval * 2);
    };
    
    checkIntegrity();
  }

  /**
   * 处理安全违规
   */
  handleSecurityBreach(type) {
    console.error(`[ProcessProtector] Security breach detected: ${type}`);
    
    // 根据严重程度采取不同措施
    switch (type) {
      case 'debugger':
        // 立即终止游戏或进入安全模式
        this.enterSafeMode();
        break;
      case 'code_tamper':
        // 上报并强制重登
        this.forceReauth();
        break;
    }
  }

  /**
   * 进入安全模式（限制功能）
   */
  enterSafeMode() {
    // 标记安全模式
    global.__securityMode = true;
    
    // 禁用敏感功能
    console.warn('[ProcessProtector] Entering safe mode');
    
    // 上报服务器
    this.reportSecurityEvent('safe_mode_activated');
  }
}
```

### 4.4 服务端风控联动接口

```javascript
// backend/security/src/memorySecurityReport.js

class MemorySecurityReportController {
  
  /**
   * 处理客户端内存安全事件上报
   * POST /api/security/memory/report
   */
  async handleMemorySecurityReport(req, res) {
    const { eventType, data, deviceFingerprint, timestamp } = req.body;
    
    // 验证请求
    if (!this.validateReport(req.body)) {
      return res.status(400).json({ error: 'Invalid report' });
    }
    
    // 记录安全事件
    const securityEvent = {
      userId: req.user.id,
      eventType,
      data,
      deviceFingerprint,
      clientTimestamp: timestamp,
      serverTimestamp: Date.now(),
      riskScore: this.calculateRiskScore(eventType, data)
    };
    
    await this.saveSecurityEvent(securityEvent);
    
    // 高风险事件触发风控
    if (securityEvent.riskScore >= 80) {
      await this.triggerRiskControl(req.user.id, securityEvent);
    }
    
    res.json({ 
      success: true,
      action: securityEvent.riskScore >= 80 ? 'restricted' : 'none'
    });
  }

  /**
   * 计算风险分数
   */
  calculateRiskScore(eventType, data) {
    const scores = {
      'scanner_detected': 90,
      'debugger_detected': 95,
      'memory_tampered': 85,
      'timing_anomaly': 60,
      'code_tampered': 100,
      'ptrace_attached': 95
    };
    
    let score = scores[eventType] || 50;
    
    // 根据数据调整
    if (data?.scanCount > 10) score += 10;
    if (data?.persistDuration > 30000) score += 15;
    
    return Math.min(score, 100);
  }

  /**
   * 触发风控措施
   */
  async triggerRiskControl(userId, event) {
    // 1. 标记账号为高风险
    await this.markUserRisk(userId, 'high', event.eventType);
    
    // 2. 强制下次登录验证
    await this.requireReauth(userId);
    
    // 3. 发送安全告警
    await this.sendSecurityAlert(userId, event);
    
    // 4. 可选: 临时封禁
    if (event.riskScore >= 95) {
      await this.temporaryBan(userId, '1h', 'security_violation');
    }
  }
}

module.exports = { MemorySecurityReportController };
```

### 4.5 Gateway 路由集成

```javascript
// gateway/src/routes/security/memorySecurity.js

module.exports = {
  name: 'memory-security',
  routes: [
    {
      method: 'POST',
      path: '/api/security/memory/report',
      handler: 'security/memorySecurity.report',
      auth: true,
      rateLimit: {
        windowMs: 60000,
        max: 10
      },
      validate: {
        body: {
          eventType: { type: 'string', required: true },
          data: { type: 'object', required: false },
          deviceFingerprint: { type: 'string', required: true },
          timestamp: { type: 'number', required: true }
        }
      }
    },
    {
      method: 'GET',
      path: '/api/security/memory/config',
      handler: 'security/memorySecurity.getConfig',
      auth: true
    }
  ]
};
```

## 5. 验收标准（可测试）

- [ ] 能够检测到至少 3 种常见内存扫描工具的运行（GameGuardian、Cheat Engine、Lucky Patcher）
- [ ] 关键数值（金币、精灵属性）在内存中不以明文存储，无法通过内存搜索直接定位
- [ ] 检测到调试器附加时，能触发安全模式并上报服务器
- [ ] 密钥轮换机制每分钟执行一次，不影响游戏性能
- [ ] 内存布局随机化后，关键数据不在连续地址存储
- [ ] 服务端能接收并处理安全事件上报，风险分数计算准确
- [ ] 高风险事件（分数>=80）能自动触发风控措施
- [ ] 单元测试覆盖率 >= 80%
- [ ] 性能测试：保护机制对游戏帧率影响 < 5%

## 6. 工作量估算

**L（大型）**

理由：
- 涉及客户端和服务端双端开发
- 需要实现多个安全模块（检测、加密、进程保护）
- 需要跨平台适配（Android/iOS/Web）
- 需要大量安全测试验证

## 7. 优先级理由

**P1 理由**：

1. **安全关键性**：内存扫描是手游最常见的作弊手段之一，直接影响游戏公平性和经济系统
2. **已有基础**：已有 REQ-00163 的内存篡改检测作为前置，可在此基础上增强
3. **用户影响大**：作弊玩家会严重影响正常玩家体验，导致用户流失
4. **技术可行**：业界已有成熟方案（如 Unity 的 ObscuredPrefs、各种反调试技术）
5. **成本收益高**：相比服务器端检测，客户端防护能更早拦截作弊，降低处理成本

---

**下一步行动**：
1. 实现客户端 MemoryScannerDetector 模块
2. 实现 MemoryValueProtector 加密引擎
3. 实现 ProcessProtector 进程保护
4. 实现服务端 MemorySecurityReportController
5. 集成测试和性能验证