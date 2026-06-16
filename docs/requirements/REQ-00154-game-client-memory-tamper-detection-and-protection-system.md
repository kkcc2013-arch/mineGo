# REQ-00154: 游戏客户端内存篡改检测与防护系统

- **编号**：REQ-00154
- **类别**：反作弊
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：game-client、gateway、catch-service、gym-service、backend/shared/memoryGuard.js
- **创建时间**：2026-06-13 07:00
- **依赖需求**：REQ-00010（GPS伪造检测）、REQ-00045（设备完整性检测）

## 1. 背景与问题

### 现状分析
mineGo 项目已实现多层反作弊能力：
- GPS 伪造检测（REQ-00010）：速度异常、精度检测、模拟位置标记
- 设备完整性检测（REQ-00045）：模拟器、Root、Hook 框架检测
- 行为异常检测（REQ-00028）：捕捉成功率、轨迹模式分析

然而，**缺少客户端内存篡改检测**，存在以下安全漏洞：

1. **内存修改器攻击**：使用 GameGuardian、Cheat Engine 等工具直接修改游戏内存
   - 修改精灵 CP/IV 值
   - 修改精灵球数量、金币、星尘
   - 修改战斗伤害、捕捉成功率
2. **代码注入攻击**：通过 Frida、Xposed 注入恶意代码
   - Hook 捕捉函数，强制 100% 成功率
   - Hook 位置函数，伪造 GPS
3. **协议重放攻击**：截获并重放 API 请求
   - 重放捕捉请求刷精灵
   - 重放奖励领取请求

### 影响范围
- 内存修改器可绕过所有服务端校验
- 修改后的数据提交到服务端，破坏游戏公平性
- 无法检测到高级作弊者（使用加密内存修改器）

## 2. 目标

构建客户端内存篡改检测与防护系统：
1. **关键数据完整性校验**：对 CP、IV、货币等关键数据生成校验码
2. **运行时内存监控**：检测内存修改器特征码
3. **代码注入检测**：检测 Frida、Xposed 等 Hook 框架
4. **协议防重放**：请求签名 + 时间戳 + nonce
5. **异常上报与封禁**：检测到篡改立即上报，触发风控

## 3. 范围

- **包含**：
  - 客户端内存完整性校验模块
  - 关键数据加密存储
  - 运行时内存扫描器
  - 请求签名与防重放中间件
  - 异常上报 API
  - 风控策略配置

- **不包含**：
  - 服务端数据校验（已有）
  - 设备完整性检测（REQ-00045 已实现）
  - 行为分析（REQ-00028 已实现）

## 4. 详细需求

### 4.1 客户端内存完整性校验

```javascript
// frontend/game-client/src/security/MemoryGuard.js

class MemoryGuard {
  constructor() {
    this.secretKey = null; // 动态生成的密钥
    this.checksums = new Map(); // 数据校验码映射
    this.tamperCount = 0;
    this.maxTamperCount = 3; // 超过 3 次触发封禁
  }

  // 初始化：从服务端获取密钥
  async init() {
    const response = await fetch('/api/v1/security/init-session', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: this.getDeviceId(),
        timestamp: Date.now()
      })
    });
    const { sessionId, encryptedKey } = await response.json();
    this.secretKey = this.decryptKey(encryptedKey, sessionId);
    this.sessionId = sessionId;
  }

  // 为关键数据生成校验码
  generateChecksum(data, dataKey) {
    const jsonStr = JSON.stringify(data);
    const hmac = this.hmacSha256(jsonStr, this.secretKey);
    this.checksums.set(dataKey, { hmac, timestamp: Date.now() });
    return hmac;
  }

  // 验证数据完整性
  verifyChecksum(data, dataKey) {
    const stored = this.checksums.get(dataKey);
    if (!stored) return false;
    
    const currentHmac = this.hmacSha256(JSON.stringify(data), this.secretKey);
    if (currentHmac !== stored.hmac) {
      this.onTamperDetected(dataKey, stored.hmac, currentHmac);
      return false;
    }
    return true;
  }

  // 检测到篡改
  async onTamperDetected(dataKey, expected, actual) {
    this.tamperCount++;
    
    // 上报篡改事件
    await fetch('/api/v1/security/report-tamper', {
      method: 'POST',
      headers: this.getSecureHeaders(),
      body: JSON.stringify({
        sessionId: this.sessionId,
        dataKey,
        expectedHmac: expected,
        actualHmac: actual,
        tamperCount: this.tamperCount,
        timestamp: Date.now(),
        stackTrace: new Error().stack
      })
    });

    if (this.tamperCount >= this.maxTamperCount) {
      this.triggerBan();
    }
  }

  // 关键数据包装器
  wrapSecureData(data, dataKey) {
    const checksum = this.generateChecksum(data, dataKey);
    return {
      data,
      _checksum: checksum,
      _key: dataKey,
      _verify: () => this.verifyChecksum(data, dataKey)
    };
  }
}

// 使用示例
const memoryGuard = new MemoryGuard();
await memoryGuard.init();

// 保护精灵数据
const securePokemon = memoryGuard.wrapSecureData(pokemon, `pokemon:${pokemon.id}`);

// 每次访问前验证
if (!securePokemon._verify()) {
  console.error('精灵数据被篡改！');
}
```

### 4.2 关键数据加密存储

```javascript
// frontend/game-client/src/security/SecureStorage.js

class SecureStorage {
  constructor(memoryGuard) {
    this.memoryGuard = memoryGuard;
    this.encryptedData = new Map();
  }

  // 加密存储关键数据
  setSecure(key, value) {
    const encrypted = this.encrypt(JSON.stringify(value));
    const checksum = this.memoryGuard.generateChecksum(value, key);
    this.encryptedData.set(key, { encrypted, checksum });
  }

  // 解密并验证
  getSecure(key) {
    const stored = this.encryptedData.get(key);
    if (!stored) return null;

    const decrypted = JSON.parse(this.decrypt(stored.encrypted));
    if (!this.memoryGuard.verifyChecksum(decrypted, key)) {
      throw new Error(`数据完整性校验失败: ${key}`);
    }
    return decrypted;
  }

  // AES-GCM 加密
  encrypt(plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = this.memoryGuard.secretKey;
    // Web Crypto API AES-GCM 加密
    // ...
  }
}

// 保护的关键数据类型
const SECURE_DATA_KEYS = {
  PLAYER_CURRENCY: 'player:currency',        // 金币、宝石、星尘
  PLAYER_INVENTORY: 'player:inventory',      // 精灵球、药水数量
  POKEMON_CP: (id) => `pokemon:${id}:cp`,    // 精灵 CP
  POKEMON_IV: (id) => `pokemon:${id}:iv`,    // 精灵 IV
  BATTLE_STATE: 'battle:state'               // 战斗状态
};
```

### 4.3 运行时内存扫描器

```javascript
// frontend/game-client/src/security/MemoryScanner.js

class MemoryScanner {
  constructor() {
    this.scanInterval = 30000; // 30 秒扫描一次
    this.suspiciousPatterns = [
      // 内存修改器特征码
      { name: 'GameGuardian', pattern: /gg\.(set|get|range|add)/i },
      { name: 'CheatEngine', pattern: /cheat\s*engine/i },
      { name: 'LuckyPatcher', pattern: /lucky\s*patcher/i },
      // Hook 框架特征
      { name: 'Frida', pattern: /frida|__frida/i },
      { name: 'Xposed', pattern: /xposed|de\.robv\.android\.xposed/i },
      { name: 'Substrate', pattern: /substrate|MSHook/i }
    ];
  }

  // 启动定期扫描
  startScanning() {
    setInterval(() => this.scan(), this.scanInterval);
  }

  // 扫描检测
  async scan() {
    const detections = [];

    // 检测全局对象中的可疑属性
    for (const [name, pattern] of this.suspiciousPatterns) {
      if (this.checkGlobalScope(pattern)) {
        detections.push({ name, type: 'global_scope', timestamp: Date.now() });
      }
    }

    // 检测异常的 Function.prototype 修改
    if (this.checkFunctionPrototype()) {
      detections.push({ name: 'PrototypePollution', type: 'prototype', timestamp: Date.now() });
    }

    // 检测 Native 函数被 Hook
    if (this.checkNativeHooks()) {
      detections.push({ name: 'NativeHook', type: 'native_hook', timestamp: Date.now() });
    }

    if (detections.length > 0) {
      await this.reportDetections(detections);
    }

    return detections;
  }

  // 检查全局作用域
  checkGlobalScope(pattern) {
    const globalStr = Object.keys(globalThis).join(' ');
    return pattern.test(globalStr);
  }

  // 检查 Function.prototype 是否被污染
  checkFunctionPrototype() {
    const originalToString = Function.prototype.toString;
    const checkFunc = function() { return 'test'; };
    return checkFunc.toString() !== 'function() { return \'test\'; }';
  }

  // 上报检测结果
  async reportDetections(detections) {
    await fetch('/api/v1/security/report-scan', {
      method: 'POST',
      headers: this.getSecureHeaders(),
      body: JSON.stringify({
        sessionId: this.memoryGuard.sessionId,
        detections,
        timestamp: Date.now()
      })
    });
  }
}
```

### 4.4 请求签名与防重放

```javascript
// frontend/game-client/src/security/RequestSigner.js

class RequestSigner {
  constructor(memoryGuard) {
    this.memoryGuard = memoryGuard;
    this.nonceCache = new Set();
  }

  // 签名请求
  signRequest(method, path, body = {}) {
    const timestamp = Date.now();
    const nonce = crypto.randomUUID();
    
    // 构造签名字符串
    const signStr = [
      method.toUpperCase(),
      path,
      timestamp,
      nonce,
      JSON.stringify(body)
    ].join('\n');

    // HMAC-SHA256 签名
    const signature = this.hmacSha256(signStr, this.memoryGuard.secretKey);

    return {
      'X-Request-Timestamp': timestamp,
      'X-Request-Nonce': nonce,
      'X-Request-Signature': signature,
      'X-Session-Id': this.memoryGuard.sessionId
    };
  }

  // 发送签名请求
  async signedFetch(url, options = {}) {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : {};
    const path = new URL(url).pathname;

    const signHeaders = this.signRequest(method, path, body);

    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        ...signHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
}
```

### 4.5 服务端验证中间件

```javascript
// backend/gateway/src/middleware/requestSignature.js

const crypto = require('crypto');
const { getRedisClient } = require('../../shared/cache');

// 防重放验证
async function verifyRequestSignature(req, res, next) {
  const timestamp = parseInt(req.headers['x-request-timestamp']);
  const nonce = req.headers['x-request-nonce'];
  const signature = req.headers['x-request-signature'];
  const sessionId = req.headers['x-session-id'];

  // 1. 时间戳验证（5 分钟窗口）
  const now = Date.now();
  if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
    return res.status(401).json({ error: 'Request expired' });
  }

  // 2. Nonce 验证（防重放）
  const redis = getRedisClient();
  const nonceKey = `nonce:${sessionId}:${nonce}`;
  const exists = await redis.exists(nonceKey);
  if (exists) {
    return res.status(401).json({ error: 'Replay attack detected' });
  }
  await redis.setex(nonceKey, 300, '1'); // 5 分钟过期

  // 3. 签名验证
  const session = await getSession(sessionId);
  const signStr = [
    req.method.toUpperCase(),
    req.path,
    timestamp,
    nonce,
    JSON.stringify(req.body)
  ].join('\n');

  const expectedSig = crypto
    .createHmac('sha256', session.secretKey)
    .update(signStr)
    .digest('hex');

  if (signature !== expectedSig) {
    // 记录篡改事件
    await recordTamperEvent(sessionId, 'signature_mismatch');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

// 路由应用
app.use('/api/v1/catch', verifyRequestSignature, catchRoutes);
app.use('/api/v1/battle', verifyRequestSignature, battleRoutes);
app.use('/api/v1/payment', verifyRequestSignature, paymentRoutes);
```

### 4.6 数据库表设计

```sql
-- 安全会话表
CREATE TABLE security_sessions (
  session_id VARCHAR(64) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  device_id VARCHAR(128),
  secret_key_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  tamper_count INTEGER DEFAULT 0,
  is_banned BOOLEAN DEFAULT FALSE
);

-- 篡改事件表
CREATE TABLE tamper_events (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(64) REFERENCES security_sessions(session_id),
  event_type VARCHAR(32) NOT NULL, -- checksum_mismatch, signature_mismatch, scan_detection
  data_key VARCHAR(128),
  details JSONB,
  reported_at TIMESTAMPTZ DEFAULT NOW(),
  client_ip INET,
  user_agent TEXT
);

CREATE INDEX idx_tamper_events_session ON tamper_events(session_id);
CREATE INDEX idx_tamper_events_type ON tamper_events(event_type);
CREATE INDEX idx_tamper_events_time ON tamper_events(reported_at DESC);

-- Nonce 缓存表（Redis 备份）
CREATE TABLE request_nonces (
  nonce VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
```

### 4.7 API 端点

```
POST /api/v1/security/init-session
  - 初始化安全会话，返回加密密钥
  - 请求: { deviceId, timestamp }
  - 响应: { sessionId, encryptedKey, expiresIn }

POST /api/v1/security/report-tamper
  - 上报篡改事件
  - 请求: { sessionId, dataKey, expectedHmac, actualHmac, tamperCount, timestamp, stackTrace }
  - 响应: { action: 'warn' | 'ban', reason? }

POST /api/v1/security/report-scan
  - 上报内存扫描结果
  - 请求: { sessionId, detections, timestamp }
  - 响应: { action: 'ok' | 'investigate' }

GET /api/v1/security/status
  - 查询会话安全状态
  - 响应: { tamperCount, isBanned, lastScanTime }
```

### 4.8 Prometheus 指标

```javascript
// backend/shared/metrics.js 新增指标

// 篡改检测计数
const tamperDetectedTotal = new Counter({
  name: 'minego_security_tamper_detected_total',
  help: 'Total number of tamper detections',
  labelNames: ['event_type', 'data_key']
});

// 安全会话数
const securitySessionsActive = new Gauge({
  name: 'minego_security_sessions_active',
  help: 'Number of active security sessions'
});

// 内存扫描检测
const memoryScanDetections = new Counter({
  name: 'minego_security_memory_scan_detections_total',
  help: 'Memory scan detections by type',
  labelNames: ['detection_name', 'detection_type']
});

// 重放攻击拦截
const replayAttackBlocked = new Counter({
  name: 'minego_security_replay_attack_blocked_total',
  help: 'Number of replay attacks blocked'
});
```

## 5. 验收标准

- [ ] `node --check frontend/game-client/src/security/MemoryGuard.js` 通过
- [ ] `node --check frontend/game-client/src/security/SecureStorage.js` 通过
- [ ] `node --check frontend/game-client/src/security/MemoryScanner.js` 通过
- [ ] `node --check frontend/game-client/src/security/RequestSigner.js` 通过
- [ ] `node --check backend/gateway/src/middleware/requestSignature.js` 通过
- [ ] `curl -sf http://localhost:3001/api/v1/security/init-session -X POST` 返回 200
- [ ] `curl -sf http://localhost:3001/api/v1/security/status` 返回 200
- [ ] 数据库迁移文件存在并可通过 `node scripts/run-migrations.js` 执行
- [ ] 单元测试 `node backend/tests/unit/memory-guard.test.js` 通过（30+ 测试用例）
- [ ] 前端集成测试：篡改检测触发后请求被拒绝

## 6. 工作量估算

**L（Large）**

理由：
- 涉及客户端和服务端双向改造
- 需要加密算法实现（AES-GCM、HMAC-SHA256）
- 需要内存扫描器定期运行
- 需要防重放机制与 Redis 集成
- 预计 5-7 个文件，约 40KB 代码

## 7. 优先级理由

**P1 理由**：
1. 内存篡改是高价值作弊手段，影响游戏公平性
2. 与现有反作弊系统（GPS、设备检测、行为分析）互补
3. 实现后可显著提升作弊成本
4. 对"项目可用"贡献：保护核心游戏数据完整性

## 8. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 客户端密钥可能被逆向提取 | 使用白盒加密、密钥分散存储 |
| 性能影响：签名计算开销 | 仅对关键 API（捕捉、战斗、支付）启用 |
| 误判：网络延迟导致时间戳过期 | 5 分钟窗口 + 客户端时间同步 |
| 内存扫描可能被绕过 | 多层检测 + 服务端数据校验兜底 |
