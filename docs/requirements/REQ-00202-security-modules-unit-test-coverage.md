# REQ-00202：安全模块单元测试覆盖率提升系统

- **编号**：REQ-00202
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared、backend/tests/unit、所有微服务
- **创建时间**：2026-06-14 16:05
- **依赖需求**：REQ-00016（GDPR 合规）、REQ-00105（分布式锁）、REQ-00111（安全响应头）

## 1. 背景与问题

通过代码分析发现，多个**关键安全模块**缺少单元测试覆盖：

1. **审计日志模块无测试**：`auditLog.js` 和 `auditLogEncrypted.js` 是 GDPR 合规的核心组件，但无任何测试
2. **分布式锁模块无测试**：`distributedLock.js` 和 `distributedLockMiddleware.js` 是高可用系统的关键组件，缺少测试验证
3. **安全响应头模块无测试**：`securityHeaders.js`、`cspConfig.js`、`csrfProtection.js` 防护 XSS/CSRF 攻击，但无测试保障
4. **数据脱敏模块无测试**：`dataMasking.js` 和 `dataMaskingEngine.js` 处理敏感数据，缺少测试验证脱敏逻辑
5. **错误处理模块无测试**：`errorHandler.js` 和 `response.js` 是 API 响应的核心，缺少测试覆盖

这些模块的测试缺失带来以下风险：
- 安全漏洞可能未被及时发现
- 代码重构可能破坏现有功能
- 回归测试无法覆盖关键路径

## 2. 目标

为 11 个关键安全模块补充单元测试，实现：

1. **审计日志模块测试**：覆盖 GDPR 操作记录、加密存储、日志格式验证
2. **分布式锁模块测试**：覆盖锁获取/释放、超时处理、死锁检测
3. **安全响应头模块测试**：覆盖 CSP 策略、CSRF Token、安全头配置
4. **数据脱敏模块测试**：覆盖脱敏规则、敏感数据检测、格式化输出
5. **错误处理模块测试**：覆盖错误码映射、响应格式、堆栈跟踪处理

## 3. 范围

- **包含**：
  - 11 个安全模块的单元测试文件创建
  - 测试覆盖率目标：每个模块 ≥ 85%
  - Mock 和 Stub 工具函数
  - 测试数据准备和清理

- **不包含**：
  - 集成测试（属于 REQ-00166 范围）
  - E2E 测试（属于 REQ-00036 范围）
  - 性能测试

## 4. 详细需求

### 4.1 审计日志模块测试

```javascript
// backend/tests/unit/auditLog.test.js

describe('AuditLog', () => {
  describe('log()', () => {
    it('should log GDPR consent action with correct format', async () => {
      await auditLog.log({
        action: 'consent_given',
        userId: 'user-123',
        details: { consentType: 'marketing' }
      });
      // Verify log entry
    });
    
    it('should log data export request', async () => {
      // Test DATA_EXPORTED action
    });
    
    it('should log deletion request flow', async () => {
      // Test DELETION_REQUESTED -> DELETION_COMPLETED
    });
    
    it('should include timestamp and requestId', async () => {
      // Verify required fields
    });
  });
  
  describe('query()', () => {
    it('should query logs by userId', async () => {});
    it('should query logs by action type', async () => {});
    it('should query logs by date range', async () => {});
  });
});

// backend/tests/unit/auditLogEncrypted.test.js

describe('AuditLogEncrypted', () => {
  describe('encrypt()', () => {
    it('should encrypt sensitive audit data', async () => {});
    it('should use AES-256-GCM encryption', async () => {});
  });
  
  describe('decrypt()', () => {
    it('should decrypt audit data correctly', async () => {});
    it('should fail with wrong key', async () => {});
  });
});
```

### 4.2 分布式锁模块测试

```javascript
// backend/tests/unit/distributedLock.test.js

describe('DistributedLock', () => {
  describe('acquire()', () => {
    it('should acquire lock successfully', async () => {});
    it('should fail if lock already held', async () => {});
    it('should retry with backoff', async () => {});
    it('should timeout after max retries', async () => {});
  });
  
  describe('release()', () => {
    it('should release lock correctly', async () => {});
    it('should fail if lock not owned', async () => {});
    it('should auto-extend lock before TTL expires', async () => {});
  });
  
  describe('withLock()', () => {
    it('should execute callback with lock', async () => {});
    it('should release lock after callback', async () => {});
    it('should release lock on error', async () => {});
  });
});

// backend/tests/unit/distributedLockMiddleware.test.js

describe('DistributedLockMiddleware', () => {
  it('should prevent concurrent requests to same resource', async () => {});
  it('should return 429 when lock not acquired', async () => {});
  it('should release lock after response', async () => {});
});
```

### 4.3 安全响应头模块测试

```javascript
// backend/tests/unit/securityHeaders.test.js

describe('SecurityHeaders', () => {
  it('should set X-Content-Type-Options: nosniff', async () => {});
  it('should set X-Frame-Options: DENY', async () => {});
  it('should set Strict-Transport-Security header', async () => {});
  it('should set X-XSS-Protection header', async () => {});
  it('should set Referrer-Policy header', async () => {});
  it('should set Permissions-Policy header', async () => {});
});

// backend/tests/unit/cspConfig.test.js

describe('CSPConfig', () => {
  it('should generate valid CSP header', async () => {});
  it('should allow inline scripts with nonce', async () => {});
  it('should allow specific image sources', async () => {});
  it('should block eval() by default', async () => {});
  it('should report CSP violations', async () => {});
});

// backend/tests/unit/csrfProtection.test.js

describe('CSRFProtection', () => {
  it('should generate valid CSRF token', async () => {});
  it('should validate CSRF token from header', async () => {});
  it('should reject invalid CSRF token', async () => {});
  it('should skip CSRF for safe methods (GET, HEAD, OPTIONS)', async () => {});
  it('should rotate token after validation', async () => {});
});
```

### 4.4 数据脱敏模块测试

```javascript
// backend/tests/unit/dataMasking.test.js

describe('DataMasking', () => {
  it('should mask email as u***@example.com', async () => {});
  it('should mask phone as ***1234', async () => {});
  it('should mask credit card as ****-****-****-1234', async () => {});
  it('should mask IP address as 192.168.*.*', async () => {});
  it('should handle null/undefined gracefully', async () => {});
});

// backend/tests/unit/dataMaskingEngine.test.js

describe('DataMaskingEngine', () => {
  it('should detect PII fields automatically', async () => {});
  it('should apply custom masking rules', async () => {});
  it('should mask nested objects', async () => {});
  it('should mask arrays of sensitive data', async () => {});
  it('should log masking operations for audit', async () => {});
});
```

### 4.5 错误处理模块测试

```javascript
// backend/tests/unit/errorHandler.test.js

describe('ErrorHandler', () => {
  it('should format ValidationError correctly', async () => {});
  it('should format AuthenticationError correctly', async () => {});
  it('should format DatabaseError correctly', async () => {});
  it('should hide internal errors in production', async () => {});
  it('should include stack trace in development', async () => {});
  it('should log error details', async () => {});
});

// backend/tests/unit/response.test.js

describe('Response', () => {
  it('should format success response with code 0', async () => {});
  it('should format error response with correct code', async () => {});
  it('should include pagination metadata', async () => {});
  it('should sanitize response data', async () => {});
});
```

### 4.6 测试覆盖率目标

| 模块 | 目标覆盖率 | 关键路径 |
|------|-----------|---------|
| auditLog.js | ≥ 85% | 日志记录、查询、格式化 |
| auditLogEncrypted.js | ≥ 90% | 加密、解密、密钥管理 |
| distributedLock.js | ≥ 90% | 锁获取、释放、续期 |
| distributedLockMiddleware.js | ≥ 85% | 中间件逻辑、错误处理 |
| securityHeaders.js | ≥ 90% | 所有安全头设置 |
| cspConfig.js | ≥ 85% | CSP 策略生成 |
| csrfProtection.js | ≥ 90% | Token 生成、验证 |
| dataMasking.js | ≥ 85% | 各种数据类型脱敏 |
| dataMaskingEngine.js | ≥ 85% | 自动检测、规则应用 |
| errorHandler.js | ≥ 85% | 错误分类、格式化 |
| response.js | ≥ 85% | 响应格式、分页 |

## 5. 验收标准（可测试）

- [ ] 11 个单元测试文件创建完成
- [ ] 每个模块测试覆盖率 ≥ 85%
- [ ] 所有测试通过（npm test）
- [ ] Mock 和 Stub 正确隔离外部依赖
- [ ] 测试数据清理无残留
- [ ] 测试执行时间 < 30 秒
- [ ] CI 流水线测试通过

## 6. 工作量估算

**M（Medium）**

- 审计日志模块测试：0.5 天
- 分布式锁模块测试：0.5 天
- 安全响应头模块测试：0.5 天
- 数据脱敏模块测试：0.5 天
- 错误处理模块测试：0.5 天

总计：2.5 人天

## 7. 优先级理由

**P1 理由**：

1. **安全关键**：这些模块涉及审计、加密、锁、安全头、脱敏等核心安全功能
2. **回归风险高**：无测试覆盖的代码重构风险极高
3. **合规要求**：GDPR 审计日志必须有测试保障
4. **依赖广泛**：这些模块被所有微服务使用，影响面大
5. **快速见效**：单元测试开发成本低，收益明确
