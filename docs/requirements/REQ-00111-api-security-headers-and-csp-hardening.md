# REQ-00111：API 安全响应头与 CSP 强化系统

- **编号**：REQ-00111
- **类别**：安全加固
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、backend/shared、game-client
- **创建时间**：2026-06-11 12:00
- **依赖需求**：无

## 1. 背景与问题

当前项目虽然使用了 `helmet` 中间件，但存在以下安全隐患：

1. **CSP 策略被完全禁用**：`app.use(helmet({ contentSecurityPolicy: false }))` 导致前端完全没有内容安全策略保护，易受 XSS 攻击
2. **缺少 CSRF 保护**：虽然有错误处理代码，但没有实际的 CSRF 令牌生成和验证机制，POST/PUT/DELETE 请求易受跨站请求伪造攻击
3. **响应头不完整**：缺少关键安全头如 `X-Frame-Options`、`Permissions-Policy`、`Cross-Origin-Opener-Policy` 等
4. **敏感 API 未加固**：支付、用户管理等敏感 API 缺少额外的安全层

根据 OWASP API Security Top 10，这些缺陷可能导致：
- API1: Broken Object Level Authorization（缺少额外验证层）
- API2: Broken Authentication（会话固定攻击）
- API8: Injection（XSS、注入攻击）

## 2. 目标

1. 建立完整的 CSP 策略，防止 XSS 攻击，同时确保游戏客户端正常功能
2. 实现 CSRF 保护机制，为状态修改操作提供令牌验证
3. 完善所有 HTTP 安全响应头，达到 OWASP 推荐标准
4. 为敏感 API 添加额外的安全层（Origin 验证、Referer 检查）
5. 建立安全头合规监控和报告机制

**预期收益**：
- 安全评分提升 30%+
- 通过 OWASP ZAP 安全扫描
- 符合 PCI-DSS 支付安全要求

## 3. 范围

### 包含

1. **CSP 策略设计与实现**
   - 为 gateway 定义严格的 CSP 策略
   - 为 game-client 和 admin-dashboard 分别配置不同策略
   - 支持动态 nonce 或 hash 用于内联脚本
   - 上报模式先于强制模式

2. **CSRF 保护系统**
   - 实现 CSRF 令牌生成和验证中间件
   - 双重提交 Cookie 模式（适用于 API）
   - 为所有状态修改操作自动注入验证
   - 白名单机制（公开 API 如登录注册）

3. **安全响应头完善**
   - X-Frame-Options: DENY/SAMEORIGIN
   - Permissions-Policy（地理位置、摄像头等）
   - Cross-Origin-Resource-Policy
   - Cross-Origin-Opener-Policy
   - Strict-Transport-Security（HSTS）强化
   - X-Content-Type-Options: nosniff
   - X-XSS-Protection（兼容旧浏览器）

4. **敏感 API 加固**
   - 支付 API：强制 Origin 验证
   - 用户管理 API：Referer 检查
   - 管理后台：IP 白名单可选

5. **监控与报告**
   - CSP 违规报告端点
   - 安全头合规检查中间件
   - Prometheus 指标

### 不包含

- WAF（Web Application Firewall）部署
- DDoS 防护增强（已有 rate limiting）
- 业务逻辑漏洞修复
- 第三方依赖安全扫描

## 4. 详细需求

### 4.1 CSP 策略配置

```javascript
// backend/shared/cspConfig.js
const cspPolicies = {
  // 游戏客户端 CSP
  gameClient: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      'style-src': ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      'img-src': ["'self'", "data:", "https:", "cdn.jsdelivr.net"],
      'connect-src': ["'self'", "api.minego.com", "wss://ws.minego.com"],
      'font-src': ["'self'", "fonts.gstatic.com"],
      'worker-src': ["'self'", "blob:"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"]
    },
    reportOnly: false
  },
  
  // 管理后台 CSP
  adminDashboard: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", "data:"],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'self'"],
      'report-uri': ["/api/v1/security/csp-report"]
    },
    reportOnly: false
  },
  
  // API Gateway CSP
  apiGateway: {
    directives: {
      'default-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'x-content-type-options': 'nosniff'
    }
  }
};
```

### 4.2 CSRF 保护中间件

```javascript
// backend/shared/csrfProtection.js
const crypto = require('crypto');

class CSRFProtection {
  constructor(options = {}) {
    this.cookieName = options.cookieName || 'XSRF-TOKEN';
    this.headerName = options.headerName || 'X-XSRF-TOKEN';
    this.cookieOptions = {
      httpOnly: false, // 需要前端读取
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      ...options.cookieOptions
    };
  }
  
  // 生成 CSRF 令牌
  generateToken() {
    return crypto.randomBytes(32).toString('base64url');
  }
  
  // 中间件：设置 CSRF Cookie
  setCSRFCookie(req, res, next) {
    if (!req.cookies[this.cookieName]) {
      const token = this.generateToken();
      res.cookie(this.cookieName, token, this.cookieOptions);
    }
    next();
  }
  
  // 中间件：验证 CSRF 令牌
  verifyCSRF(req, res, next) {
    // 安全方法豁免
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (safeMethods.includes(req.method)) {
      return next();
    }
    
    // 白名单路径豁免
    const whitelistPaths = ['/api/v1/auth/login', '/api/v1/auth/register'];
    if (whitelistPaths.some(p => req.path.startsWith(p))) {
      return next();
    }
    
    const cookieToken = req.cookies[this.cookieName];
    const headerToken = req.headers[this.headerName.toLowerCase()];
    
    if (!cookieToken || !headerToken) {
      return res.status(403).json({
        error: 'CSRF token missing',
        code: 'CSRF_MISSING'
      });
    }
    
    if (!crypto.timingSafeEqual(
      Buffer.from(cookieToken),
      Buffer.from(headerToken)
    )) {
      return res.status(403).json({
        error: 'CSRF token invalid',
        code: 'CSRF_INVALID'
      });
    }
    
    next();
  }
}
```

### 4.3 安全响应头中间件

```javascript
// backend/shared/securityHeaders.js
const securityHeaders = {
  // API 安全头
  api: (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    next();
  },
  
  // 前端页面安全头
  frontend: (req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 
      'geolocation=(self), camera=(), microphone=(), payment=(self)');
    next();
  },
  
  // 敏感 API 额外安全头
  sensitive: (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store, private');
    next();
  }
};
```

### 4.4 CSP 违规报告端点

```javascript
// backend/gateway/src/routes/security.js
router.post('/csp-report', express.json({ type: 'application/csp-report' }), async (req, res) => {
  const report = req.body['csp-report'];
  
  logger.warn('CSP violation reported', {
    documentUri: report['document-uri'],
    violatedDirective: report['violated-directive'],
    blockedUri: report['blocked-uri'],
    userAgent: req.headers['user-agent'],
    ip: req.ip
  });
  
  // Prometheus 指标
  cspViolationCounter.inc({
    directive: report['violated-directive'] || 'unknown'
  });
  
  res.status(204).send();
});
```

### 4.5 数据库表

```sql
-- 数据库迁移
CREATE TABLE csp_violation_reports (
  id SERIAL PRIMARY KEY,
  document_uri TEXT NOT NULL,
  violated_directive VARCHAR(255) NOT NULL,
  blocked_uri TEXT,
  user_agent TEXT,
  ip_address INET,
  user_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_csp_reports_created_at ON csp_violation_reports(created_at DESC);
CREATE INDEX idx_csp_reports_directive ON csp_violation_reports(violated_directive);

-- 安全事件审计表
CREATE TABLE security_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL, -- 'CSRF_FAILURE', 'ORIGIN_MISMATCH', 'CSP_VIOLATION'
  user_id INTEGER,
  ip_address INET,
  user_agent TEXT,
  details JSONB,
  severity VARCHAR(20) DEFAULT 'medium', -- 'low', 'medium', 'high', 'critical'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_security_events_type ON security_events(event_type);
CREATE INDEX idx_security_events_user ON security_events(user_id);
CREATE INDEX idx_security_events_created_at ON security_events(created_at DESC);
```

## 5. 验收标准（可测试）

- [ ] CSP 策略已启用，通过 OWASP ZAP XSS 测试，无高危漏洞
- [ ] 所有 POST/PUT/DELETE/PATCH 请求均要求有效的 CSRF 令牌
- [ ] CSRF 令牌验证失败返回 403，并记录安全事件
- [ ] 所有 API 响应包含完整的安全响应头（8+ 个）
- [ ] 支付 API 强制验证 Origin 头，非授权 Origin 返回 403
- [ ] CSP 违规报告端点可接收并记录违规事件
- [ ] 安全事件审计表记录所有安全相关事件
- [ ] 单元测试覆盖率达到 90%+，包含 40+ 测试用例
- [ ] 性能影响 < 5ms（令牌生成和验证）
- [ ] 文档说明各安全头的用途和配置方法

## 6. 工作量估算

**L**（Large）

理由：
- 涉及多个服务和模块（gateway、shared、所有微服务）
- 需要仔细测试 CSP 策略，避免破坏现有前端功能
- CSRF 保护需要前端配合修改
- 多个数据库表和迁移
- 安全测试需要充分

## 7. 优先级理由

**P1** 理由：
1. **安全合规**：OWASP API Security Top 10 中的关键防护
2. **支付安全**：PCI-DSS 要求完整的安全响应头
3. **XSS 防护**：游戏客户端有大量用户输入，CSP 是关键防护层
4. **CSRF 防护**：当前完全缺失，是重大安全隐患
5. **影响面广**：保护所有 API 和前端页面
