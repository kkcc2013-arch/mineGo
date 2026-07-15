# REQ-00548：API 请求签名验证与防篡改保护系统

- **编号**：REQ-00548
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有后端服务、backend/shared/requestSignatureService.js、game-client、admin-dashboard
- **创建时间**：2026-07-15 04:00
- **依赖需求**：无

## 1. 背景与问题

mineGo 作为基于真实 GPS 的 AR 手游，客户端与服务端的通信安全至关重要。当前系统存在以下问题：

1. **请求篡改风险**：攻击者可能修改请求参数（如精灵位置、捕捉结果），造成游戏数据不一致
2. **重放攻击**：部分 API 缺乏请求时效性验证，可能被恶意重放
3. **签名机制缺失**：敏感操作（精灵交易、道具使用）缺少请求签名验证，存在伪造风险
4. **客户端可信度不足**：无法验证请求来源的合法性，可能被模拟器或自动化工具滥用

虽然项目已有 `InjectionGuard.js` 和 `ar-sensor-validator.js` 等安全模块，但缺少一个统一的请求签名验证框架。

## 2. 目标

建立完整的 API 请求签名验证与防篡改保护系统：

- 为敏感 API 添加请求签名验证，防止请求被篡改
- 实现请求时效性检查，防止重放攻击
- 建立签名密钥轮换机制，提升安全性
- 提供多级验证策略，平衡安全性与性能开销

**可量化目标**：
- 敏感 API 签名验证覆盖率达到 100%
- 重放攻击拦截率 ≥ 99.9%
- 签名验证延迟 < 5ms（P95）

## 3. 范围

### 包含
- 请求签名生成与验证服务
- 网关层签名验证中间件
- 客户端签名 SDK（game-client）
- 签名密钥管理与轮换机制
- 请求时效性验证（时间戳检查）
- 敏感操作 API 白名单配置

### 不包含
- TLS/SSL 传输层加密（已有基础设施支持）
- OAuth/OIDC 认证机制（已有 auth.js）
- API 限流与熔断（已有 rateLimitMiddleware）

## 4. 详细需求

### 4.1 签名算法设计

采用 HMAC-SHA256 签名算法，签名流程：

```
1. 构造签名字符串：
   canonicalString = METHOD + "\n" + 
                     PATH + "\n" + 
                     TIMESTAMP + "\n" + 
                     NONCE + "\n" + 
                     BODY_HASH(SHA256)

2. 计算签名：
   signature = HMAC-SHA256(secretKey, canonicalString)

3. 请求头携带：
   X-Signature: signature
   X-Timestamp: timestamp
   X-Nonce: nonce
   X-Key-Version: keyVersion
```

### 4.2 签名验证服务

```javascript
// backend/shared/requestSignatureService.js

class RequestSignatureService {
  constructor() {
    this.keyStore = new Map(); // keyVersion -> secretKey
    this.nonceCache = new LRUCache({ max: 100000, ttl: 300000 }); // 5分钟内不可重用
    this.maxTimestampDrift = 300000; // 5分钟时间漂移允许
    this.sensitiveEndpoints = new Set([
      'POST:/v1/pokemon/catch',
      'POST:/v1/trade/confirm',
      'POST:/v1/gym/battle',
      'POST:/v1/reward/claim',
      'POST:/v1/payment/*',
      'DELETE:/v1/pokemon/*',
    ]);
  }

  /**
   * 生成签名
   */
  generateSignature(method, path, body, keyVersion = 'current') {
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const secretKey = this.getActiveKey(keyVersion);
    
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
    const canonicalString = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
    
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(canonicalString)
      .digest('hex');
    
    return { signature, timestamp, nonce, keyVersion };
  }

  /**
   * 验证签名
   */
  async verifySignature(request) {
    const { method, path, headers, body } = request;
    const signature = headers['x-signature'];
    const timestamp = parseInt(headers['x-timestamp'], 10);
    const nonce = headers['x-nonce'];
    const keyVersion = headers['x-key-version'] || 'current';
    
    // 1. 检查必需头
    if (!signature || !timestamp || !nonce) {
      return { valid: false, reason: 'MISSING_REQUIRED_HEADERS' };
    }
    
    // 2. 检查时间戳
    const now = Date.now();
    if (Math.abs(now - timestamp) > this.maxTimestampDrift) {
      return { valid: false, reason: 'TIMESTAMP_EXPIRED' };
    }
    
    // 3. 检查 Nonce 重放
    if (this.nonceCache.has(nonce)) {
      return { valid: false, reason: 'NONCE_REUSED' };
    }
    
    // 4. 获取密钥
    const secretKey = this.keyStore.get(keyVersion);
    if (!secretKey) {
      return { valid: false, reason: 'INVALID_KEY_VERSION' };
    }
    
    // 5. 计算并验证签名
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
    const canonicalString = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(canonicalString)
      .digest('hex');
    
    if (signature !== expectedSignature) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }
    
    // 6. 记录 Nonce
    this.nonceCache.set(nonce, true);
    
    return { valid: true };
  }

  /**
   * 判断是否需要签名验证
   */
  requiresSignature(method, path) {
    for (const pattern of this.sensitiveEndpoints) {
      if (this.matchPattern(pattern, method, path)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 路径匹配
   */
  matchPattern(pattern, method, path) {
    const [patternMethod, patternPath] = pattern.split(':');
    if (patternMethod !== method) return false;
    if (patternPath.endsWith('*')) {
      return path.startsWith(patternPath.slice(0, -1));
    }
    return patternPath === path;
  }

  /**
   * 密钥轮换
   */
  async rotateKey(newKey) {
    const newVersion = `v${Date.now()}`;
    this.keyStore.set(newVersion, newKey);
    this.keyStore.set('current', newKey);
    
    // 发布密钥更新事件
    await EventBus.publish(EVENTS.SIGNATURE_KEY_ROTATED, {
      keyVersion: newVersion,
      timestamp: new Date().toISOString()
    });
    
    return newVersion;
  }

  /**
   * 获取活跃密钥
   */
  getActiveKey(keyVersion) {
    return this.keyStore.get(keyVersion) || this.keyStore.get('current');
  }
}
```

### 4.3 网关签名验证中间件

```javascript
// backend/gateway/src/middleware/signatureVerification.js

const signatureService = require('../../../shared/requestSignatureService');
const { createLogger } = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');

const logger = createLogger('signature-verification');

function signatureVerificationMiddleware(options = {}) {
  const { skipPaths = [], enforce = true } = options;

  return async (req, res, next) => {
    const startTime = Date.now();
    
    // 跳过不需要验证的路径
    if (skipPaths.some(p => req.path.startsWith(p))) {
      return next();
    }
    
    // 检查是否需要签名验证
    if (!signatureService.requiresSignature(req.method, req.path)) {
      return next();
    }
    
    try {
      const result = await signatureService.verifySignature({
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body
      });
      
      metrics.timing('signature_verification_duration', Date.now() - startTime);
      
      if (!result.valid) {
        logger.warn('Signature verification failed', {
          reason: result.reason,
          path: req.path,
          method: req.method,
          ip: req.ip
        });
        
        metrics.increment('signature_verification_failed', 1, { reason: result.reason });
        
        if (enforce) {
          return res.status(401).json({
            error: 'SIGNATURE_VERIFICATION_FAILED',
            message: 'Request signature is invalid or missing',
            code: 'AUTH_010'
          });
        }
      }
      
      metrics.increment('signature_verification_passed', 1);
      next();
    } catch (error) {
      logger.error('Signature verification error', {
        error: error.message,
        path: req.path
      });
      
      if (enforce) {
        return res.status(500).json({
          error: 'SIGNATURE_VERIFICATION_ERROR',
          code: 'AUTH_011'
        });
      }
      next();
    }
  };
}

module.exports = signatureVerificationMiddleware;
```

### 4.4 客户端签名 SDK

```javascript
// frontend/game-client/src/utils/requestSignature.js

class RequestSignatureClient {
  constructor() {
    this.keyVersion = 'current';
    this.secretKey = null; // 从安全存储获取
  }

  /**
   * 初始化，从服务端获取签名密钥
   */
  async initialize(sessionToken) {
    const response = await fetch('/api/auth/signing-key', {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    });
    const data = await response.json();
    this.secretKey = data.key;
    this.keyVersion = data.version;
  }

  /**
   * 为请求添加签名头
   */
  signRequest(method, path, body = {}) {
    const timestamp = Date.now();
    const nonce = this.generateNonce();
    const bodyHash = this.sha256(JSON.stringify(body));
    
    const canonicalString = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const signature = this.hmacSha256(this.secretKey, canonicalString);
    
    return {
      'X-Signature': signature,
      'X-Timestamp': timestamp.toString(),
      'X-Nonce': nonce,
      'X-Key-Version': this.keyVersion
    };
  }

  generateNonce() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  }

  async sha256(data) {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async hmacSha256(key, data) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const messageData = encoder.encode(data);
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const signatureArray = Array.from(new Uint8Array(signature));
    return signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

export const requestSignature = new RequestSignatureClient();
```

### 4.5 密钥管理 API

```javascript
// backend/gateway/src/routes/signatureKeyRoutes.js

const express = require('express');
const router = express.Router();
const signatureService = require('../../../shared/requestSignatureService');
const { authenticate, requireAdmin } = require('../middleware/auth');

// 获取当前签名密钥（需要认证）
router.get('/current', authenticate, async (req, res) => {
  // 只返回密钥版本，不返回实际密钥
  res.json({
    keyVersion: 'current',
    createdAt: signatureService.keyCreatedAt
  });
});

// 管理员：触发密钥轮换
router.post('/rotate', authenticate, requireAdmin, async (req, res) => {
  const newKey = crypto.randomBytes(32).toString('hex');
  const newVersion = await signatureService.rotateKey(newKey);
  
  res.json({
    success: true,
    newVersion,
    timestamp: new Date().toISOString()
  });
});

// 管理员：获取密钥状态
router.get('/status', authenticate, requireAdmin, (req, res) => {
  res.json({
    keyVersions: Array.from(signatureService.keyStore.keys()),
    activeVersion: 'current',
    nonceCacheSize: signatureService.nonceCache.size,
    sensitiveEndpoints: Array.from(signatureService.sensitiveEndpoints)
  });
});

module.exports = router;
```

### 4.6 敏感 API 配置

```javascript
// config/signatureEndpoints.js

module.exports = {
  // 强制签名验证的端点
  enforced: [
    { method: 'POST', path: '/v1/pokemon/catch' },
    { method: 'POST', path: '/v1/pokemon/transfer' },
    { method: 'POST', path: '/v1/trade/confirm' },
    { method: 'POST', path: '/v1/trade/accept' },
    { method: 'POST', path: '/v1/gym/battle/start' },
    { method: 'POST', path: '/v1/gym/battle/result' },
    { method: 'POST', path: '/v1/reward/claim' },
    { method: 'POST', path: '/v1/payment/initialize' },
    { method: 'POST', path: '/v1/payment/confirm' },
    { method: 'DELETE', path: '/v1/pokemon/:id' },
    { method: 'PUT', path: '/v1/user/settings' },
  ],
  
  // 可选签名验证（宽松模式）
  optional: [
    { method: 'GET', path: '/v1/pokemon/inventory' },
    { method: 'GET', path: '/v1/user/profile' },
  ],
  
  // 跳过签名验证
  skipped: [
    { method: 'GET', path: '/v1/health' },
    { method: 'GET', path: '/v1/metadata' },
  ]
};
```

## 5. 验收标准（可测试）

- [ ] 敏感 API 签名验证覆盖率达到 100%（所有 enforced 端点）
- [ ] 签名验证请求延迟 < 5ms（P95）
- [ ] 重放攻击（相同 Nonce）被正确拦截
- [ ] 时间戳超时请求被正确拒绝（±5分钟窗口）
- [ ] 签名不匹配请求返回 401 错误
- [ ] 客户端 SDK 正确生成签名头
- [ ] 密钥轮换不影响正在进行的请求
- [ ] Prometheus 指标正确记录验证通过/失败次数
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] 集成测试覆盖主要场景（签名验证、重放攻击、时间戳验证）

## 6. 工作量估算

**L（Large）** - 需要实现：
- 后端签名服务（约 400 行）
- 网关中间件（约 100 行）
- 客户端 SDK（约 200 行）
- 密钥管理 API（约 100 行）
- 配置与文档
- 测试用例（约 30 个）

预计工作量：2-3 天

## 7. 优先级理由

**P1 理由**：
1. **安全关键**：防止请求篡改是游戏安全的基石，直接影响游戏公平性
2. **影响核心玩法**：精灵捕捉、交易等核心操作需要签名保护
3. **缺失风险高**：没有签名验证，作弊工具可以伪造任意请求
4. **实现成本合理**：技术方案成熟，不影响现有架构

与其他需求对比：
- 比 P0 低：不阻塞基本功能，但属于安全加固
- 比 P2 高：安全问题优先级高于一般优化需求

## 影响范围

### 新增文件
- `backend/shared/requestSignatureService.js` - 签名验证核心服务
- `backend/gateway/src/middleware/signatureVerification.js` - 网关中间件
- `frontend/game-client/src/utils/requestSignature.js` - 客户端 SDK
- `backend/gateway/src/routes/signatureKeyRoutes.js` - 密钥管理 API
- `config/signatureEndpoints.js` - 敏感 API 配置
- `backend/tests/unit/requestSignature.test.js` - 单元测试

### 修改文件
- `backend/gateway/src/index.js` - 集成签名验证中间件
- `backend/shared/metrics.js` - 新增签名验证指标
- `frontend/game-client/src/api/client.js` - 集成签名 SDK

### 数据库迁移
- 无需新增表，使用 Redis 存储 Nonce 缓存

## 参考

- AWS Signature Version 4 签名流程
- OAuth 1.0 签名规范
- REQ-00021 JWT 黑名单强制登出
- REQ-00494 游戏内行为数据实时风控