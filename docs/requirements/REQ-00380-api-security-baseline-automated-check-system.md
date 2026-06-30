# REQ-00380：API 安全配置基线自动化检查系统

- **编号**：REQ-00380
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared、.github/workflows、infrastructure/k8s
- **创建时间**：2026-06-30 05:00 UTC
- **依赖需求**：REQ-00111（API 安全响应头）、REQ-00042（基础设施安全扫描）

## 1. 背景与问题

mineGo 项目已实现多项安全功能（安全响应头、CSP、数据加密、审计日志等），但在安全配置管理和持续验证方面存在以下问题：

### 1.1 缺少统一的安全基线定义
- 安全配置分散在多个文件和模块中（`securityHeaders.js`、`csrfProtection.js`、`rateLimit.js` 等）
- 没有统一的安全基线清单，难以确保所有服务都应用了相同的安全配置
- 新服务启动时，容易遗漏必要的安全中间件

### 1.2 配置漂移风险
- 随着项目迭代，安全配置可能被意外修改或禁用
- 开发环境与生产环境的安全配置可能不一致
- 缺少自动化的配置漂移检测机制

### 1.3 安全配置验证不足
- 缺少运行时安全配置验证
- 无法自动检测安全头是否正确设置
- 缺少对 API 端点安全配置的全面审计

### 1.4 合规性检查困难
- 无法自动验证是否符合 OWASP API Security Top 10
- 缺少 PCI-DSS、GDPR 等合规要求的安全配置检查
- 安全审计时需要大量手动检查

根据 OWASP API Security Top 10 和 CIS Benchmarks，需要建立自动化的安全配置基线检查系统。

## 2. 目标

建立 API 安全配置基线自动化检查系统：

1. **统一安全基线定义**：基于 OWASP API Security Top 10、CIS Benchmarks 定义安全配置清单
2. **自动化配置检查**：定期扫描所有服务和 API 端点，检测安全配置缺陷
3. **配置漂移检测**：监控安全配置变更，及时发现配置漂移
4. **合规性报告**：生成符合 OWASP、PCI-DSS、GDPR 的安全配置报告
5. **CI/CD 集成**：在构建和部署阶段自动执行安全配置检查

**预期收益：**
- 安全配置缺陷发现率提升 90%
- 合规审计时间减少 70%
- 配置漂移检测延迟 < 5 分钟
- 新服务安全配置遗漏率降至 0

## 3. 范围

### 包含
- 安全配置基线清单定义（OWASP Top 10、CIS、PCI-DSS）
- 安全配置扫描器（运行时检查）
- 配置漂移检测系统
- 合规性报告生成器
- CI/CD 集成（GitHub Actions）
- 管理后台安全配置仪表板
- 安全配置修复建议引擎

### 不包含
- 漏洞扫描（已有 REQ-00221 容器镜像安全扫描）
- 渗透测试自动化（作为后续独立需求）
- 安全事件响应（已有 REQ-00246 数据泄露应急响应）

## 4. 详细需求

### 4.1 安全配置基线清单

**实现位置**：`backend/shared/securityBaseline.js`

```javascript
/**
 * API 安全配置基线
 * 基于 OWASP API Security Top 10 2023、CIS Benchmarks、PCI-DSS
 */
const SECURITY_BASELINE = {
  // OWASP API1: Broken Object Level Authorization
  authz: {
    requireAuth: { level: 'critical', description: '所有 API 必须认证（除公开端点）' },
    resourceOwnership: { level: 'critical', description: '资源访问必须验证所有权' },
    rbac: { level: 'high', description: '敏感操作需要角色权限验证' }
  },
  
  // OWASP API2: Broken Authentication
  authn: {
    strongAuth: { level: 'critical', description: '使用强认证机制（JWT + refresh token）' },
    mfa: { level: 'high', description: '敏感操作需要 MFA' },
    sessionManagement: { level: 'critical', description: '会话有效期和并发控制' },
    passwordPolicy: { level: 'high', description: '密码复杂度和轮换策略' }
  },
  
  // OWASP API3: Broken Object Property Level Authorization
  dataExposure: {
    fieldFiltering: { level: 'high', description: '响应数据字段过滤' },
    sensitiveDataMask: { level: 'critical', description: '敏感数据脱敏' }
  },
  
  // OWASP API4: Unrestricted Resource Consumption
  rateLimit: {
    globalRateLimit: { level: 'critical', description: '全局速率限制（1000 req/min）' },
    perUserRateLimit: { level: 'high', description: '用户级速率限制' },
    requestSizeLimit: { level: 'high', description: '请求体大小限制（10MB）' }
  },
  
  // OWASP API5: Broken Function Level Authorization
  functionAuthz: {
    endpointAuthz: { level: 'critical', description: '端点级权限验证' },
    adminEndpoint: { level: 'critical', description: '管理端点需要 admin 角色' }
  },
  
  // OWASP API6: Unrestricted Access to Sensitive Business Flows
  businessFlow: {
    transactionLimit: { level: 'high', description: '交易频率限制' },
    antiAutomation: { level: 'high', description: '自动化脚本检测' }
  },
  
  // OWASP API7: Server Side Request Forgery
  ssrf: {
    urlValidation: { level: 'critical', description: 'URL 白名单验证' },
    internalNetwork: { level: 'critical', description: '禁止访问内网地址' }
  },
  
  // OWASP API8: Security Misconfiguration
  config: {
    securityHeaders: { level: 'critical', description: '安全响应头完整' },
    errorHandling: { level: 'high', description: '错误信息不泄露敏感信息' },
    debugMode: { level: 'critical', description: '生产环境禁用调试模式' },
    corsPolicy: { level: 'high', description: 'CORS 策略严格配置' },
    cspPolicy: { level: 'high', description: 'CSP 策略严格配置' }
  },
  
  // OWASP API9: Improper Inventory Management
  inventory: {
    apiVersioning: { level: 'high', description: 'API 版本管理' },
    deprecatedApi: { level: 'medium', description: '废弃 API 通知和下线' },
    apiDoc: { level: 'high', description: 'API 文档完整性' }
  },
  
  // OWASP API10: Unsafe Consumption of APIs
  externalApi: {
    tlsVerification: { level: 'critical', description: '外部 API TLS 证书验证' },
    timeout: { level: 'high', description: '外部 API 调用超时配置' },
    retry: { level: 'medium', description: '重试策略配置' }
  },
  
  // PCI-DSS 合规
  pciDss: {
    encryption: { level: 'critical', description: '支付数据加密存储' },
    keyManagement: { level: 'critical', description: '密钥管理和轮换' },
    auditLog: { level: 'critical', description: '支付操作审计日志' }
  },
  
  // GDPR 合规
  gdpr: {
    dataMinimization: { level: 'high', description: '数据最小化原则' },
    consentManagement: { level: 'high', description: '用户同意管理' },
    dataSubjectRights: { level: 'high', description: '数据主体权利支持' }
  }
};

/**
 * 安全配置检查规则
 */
const CHECK_RULES = [
  {
    id: 'SEC-001',
    category: 'authz',
    name: '认证中间件检查',
    level: 'critical',
    check: (app) => {
      // 检查是否所有路由都有认证中间件
      const routes = app._router.stack.filter(r => r.route);
      const publicEndpoints = ['/health', '/metrics', '/api/v1/auth/login', '/api/v1/auth/register'];
      const issues = [];
      
      routes.forEach(route => {
        const path = route.route.path;
        if (!publicEndpoints.some(p => path.startsWith(p))) {
          const hasAuth = route.route.stack.some(layer => 
            layer.name === 'authMiddleware' || 
            layer.handle?.name === 'authMiddleware'
          );
          if (!hasAuth) {
            issues.push({ path, method: Object.keys(route.route.methods)[0] });
          }
        }
      });
      
      return { passed: issues.length === 0, issues };
    }
  },
  
  {
    id: 'SEC-002',
    category: 'config',
    name: '安全响应头检查',
    level: 'critical',
    check: async (app) => {
      const requiredHeaders = [
        'X-Content-Type-Options',
        'X-Frame-Options',
        'X-XSS-Protection',
        'Strict-Transport-Security',
        'Content-Security-Policy'
      ];
      
      // 发送测试请求
      const response = await supertest(app).get('/health');
      const missingHeaders = requiredHeaders.filter(h => !response.headers[h.toLowerCase()]);
      
      return { passed: missingHeaders.length === 0, issues: missingHeaders };
    }
  },
  
  {
    id: 'SEC-003',
    category: 'rateLimit',
    name: '速率限制检查',
    level: 'critical',
    check: async (app) => {
      // 发送超限请求
      const requests = [];
      for (let i = 0; i < 100; i++) {
        requests.push(supertest(app).get('/api/v1/pokemon'));
      }
      const responses = await Promise.all(requests);
      const rateLimited = responses.some(r => r.status === 429);
      
      return { passed: rateLimited, issues: rateLimited ? [] : ['未检测到速率限制'] };
    }
  },
  
  {
    id: 'SEC-004',
    category: 'config',
    name: 'CORS 配置检查',
    level: 'high',
    check: async (app) => {
      const response = await supertest(app)
        .options('/api/v1/pokemon')
        .set('Origin', 'https://malicious-site.com')
        .set('Access-Control-Request-Method', 'GET');
      
      const allowOrigin = response.headers['access-control-allow-origin'];
      const passed = !allowOrigin || allowOrigin !== '*';
      
      return { passed, issues: passed ? [] : [`CORS 允许任意源: ${allowOrigin}`] };
    }
  },
  
  {
    id: 'SEC-005',
    category: 'config',
    name: '调试模式检查',
    level: 'critical',
    check: () => {
      const isProduction = process.env.NODE_ENV === 'production';
      const debugEnabled = process.env.DEBUG === 'true';
      const passed = !isProduction || !debugEnabled;
      
      return { passed, issues: passed ? [] : ['生产环境启用了 DEBUG 模式'] };
    }
  },
  
  {
    id: 'SEC-006',
    category: 'authn',
    name: 'JWT 配置检查',
    level: 'critical',
    check: () => {
      const jwtSecret = process.env.JWT_SECRET;
      const jwtExpiry = process.env.JWT_EXPIRY;
      
      const issues = [];
      if (!jwtSecret || jwtSecret.length < 32) {
        issues.push('JWT_SECRET 长度不足（应 >= 32 字符）');
      }
      if (jwtExpiry && parseInt(jwtExpiry) > 3600) {
        issues.push('JWT 有效期过长（应 <= 1 小时）');
      }
      
      return { passed: issues.length === 0, issues };
    }
  },
  
  {
    id: 'SEC-007',
    category: 'dataExposure',
    name: '错误信息泄露检查',
    level: 'high',
    check: async (app) => {
      const response = await supertest(app)
        .get('/api/v1/pokemon/invalid-id-123')
        .set('Authorization', 'Bearer invalid-token');
      
      const body = JSON.stringify(response.body);
      const sensitivePatterns = [
        /stack trace/i,
        /at\\s+Object\\./,
        /node_modules/,
        /internal\\s+server\\s+error/i
      ];
      
      const leaked = sensitivePatterns.some(p => p.test(body));
      
      return { passed: !leaked, issues: leaked ? ['错误响应包含堆栈信息'] : [] };
    }
  },
  
  {
    id: 'SEC-008',
    category: 'config',
    name: 'CSP 配置检查',
    level: 'high',
    check: async (app) => {
      const response = await supertest(app).get('/');
      const csp = response.headers['content-security-policy'];
      
      if (!csp) {
        return { passed: false, issues: ['缺少 CSP 头'] };
      }
      
      const issues = [];
      if (csp.includes("script-src 'unsafe-inline'")) {
        issues.push("CSP 允许 'unsafe-inline' 脚本");
      }
      if (csp.includes("script-src 'unsafe-eval'")) {
        issues.push("CSP 允许 'unsafe-eval' 脚本");
      }
      
      return { passed: issues.length === 0, issues };
    }
  }
];

module.exports = { SECURITY_BASELINE, CHECK_RULES };
```

### 4.2 安全配置扫描器

**实现位置**：`backend/shared/securityScanner.js`

```javascript
const { CHECK_RULES } = require('./securityBaseline');
const { createLogger } = require('./logger');
const { getTracer } = require('./tracing');
const { context, trace, SpanStatusCode } = require('@opentelemetry/api');
const fs = require('fs').promises;
const path = require('path');

const logger = createLogger('security-scanner');

/**
 * 安全配置扫描器
 */
class SecurityScanner {
  constructor(options = {}) {
    this.options = {
      scanInterval: options.scanInterval || 3600000, // 1 小时
      driftDetection: options.driftDetection !== false,
      baselinePath: options.baselinePath || './security-baseline-snapshot.json',
      ...options
    };
    
    this.lastBaseline = null;
    this.scanHistory = [];
  }
  
  /**
   * 执行完整扫描
   */
  async scanAll(app) {
    const tracer = getTracer('security-scanner');
    const span = tracer.startSpan('security.scan');
    
    try {
      const results = {
        timestamp: new Date().toISOString(),
        total: CHECK_RULES.length,
        passed: 0,
        failed: 0,
        warnings: 0,
        checks: []
      };
      
      for (const rule of CHECK_RULES) {
        try {
          const checkResult = await rule.check(app);
          
          results.checks.push({
            id: rule.id,
            category: rule.category,
            name: rule.name,
            level: rule.level,
            passed: checkResult.passed,
            issues: checkResult.issues || []
          });
          
          if (checkResult.passed) {
            results.passed++;
          } else {
            if (rule.level === 'critical') {
              results.failed++;
            } else {
              results.warnings++;
            }
          }
        } catch (err) {
          logger.error({ ruleId: rule.id, err: err.message }, '安全检查失败');
          results.checks.push({
            id: rule.id,
            category: rule.category,
            name: rule.name,
            level: rule.level,
            passed: false,
            error: err.message
          });
          results.failed++;
        }
      }
      
      // 记录扫描历史
      this.scanHistory.push(results);
      if (this.scanHistory.length > 30) {
        this.scanHistory.shift();
      }
      
      // 配置漂移检测
      if (this.options.driftDetection) {
        await this.detectDrift(results);
      }
      
      // 更新基线快照
      await this.saveBaselineSnapshot(results);
      
      span.setStatus({ code: SpanStatusCode.OK });
      return results;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  }
  
  /**
   * 配置漂移检测
   */
  async detectDrift(currentResults) {
    if (!this.lastBaseline) {
      this.lastBaseline = currentResults;
      return { drifted: false };
    }
    
    const drift = {
      detected: false,
      changes: []
    };
    
    // 对比检查结果
    currentResults.checks.forEach((check, index) => {
      const baseline = this.lastBaseline.checks[index];
      if (baseline && check.passed !== baseline.passed) {
        drift.detected = true;
        drift.changes.push({
          ruleId: check.id,
          name: check.name,
          level: check.level,
          previous: baseline.passed ? 'passed' : 'failed',
          current: check.passed ? 'passed' : 'failed',
          issues: check.issues
        });
      }
    });
    
    if (drift.detected) {
      logger.warn({ drift }, '检测到安全配置漂移');
      await this.sendDriftAlert(drift);
    }
    
    return drift;
  }
  
  /**
   * 保存基线快照
   */
  async saveBaselineSnapshot(results) {
    const snapshot = {
      timestamp: results.timestamp,
      passed: results.passed,
      failed: results.failed,
      warnings: results.warnings,
      checks: results.checks.map(c => ({
        id: c.id,
        name: c.name,
        level: c.level,
        passed: c.passed
      }))
    };
    
    await fs.writeFile(
      this.options.baselinePath,
      JSON.stringify(snapshot, null, 2)
    );
    
    this.lastBaseline = snapshot;
  }
  
  /**
   * 发送漂移告警
   */
  async sendDriftAlert(drift) {
    // 发送到告警系统（Slack/Email/Webhook）
    const { alertManager } = require('./alertManager');
    
    await alertManager.sendAlert({
      severity: 'high',
      title: '安全配置漂移检测',
      message: `检测到 ${drift.changes.length} 项安全配置变更`,
      details: drift.changes,
      tags: ['security', 'drift', 'compliance']
    });
  }
  
  /**
   * 获取扫描历史
   */
  getHistory(limit = 10) {
    return this.scanHistory.slice(-limit);
  }
  
  /**
   * 获取当前安全评分
   */
  getSecurityScore() {
    if (this.scanHistory.length === 0) {
      return null;
    }
    
    const latest = this.scanHistory[this.scanHistory.length - 1];
    const score = Math.round((latest.passed / latest.total) * 100);
    
    return {
      score,
      grade: this.getGrade(score),
      passed: latest.passed,
      failed: latest.failed,
      warnings: latest.warnings,
      timestamp: latest.timestamp
    };
  }
  
  /**
   * 获取安全等级
   */
  getGrade(score) {
    if (score >= 95) return 'A+';
    if (score >= 90) return 'A';
    if (score >= 85) return 'B+';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }
}

module.exports = { SecurityScanner };
```

### 4.3 CI/CD 集成

**实现位置**：`.github/workflows/security-baseline-check.yml`

```yaml
name: Security Baseline Check

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * *'  # 每天早上 6 点执行

jobs:
  security-scan:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run security baseline scan
        run: |
          node backend/tools/security-baseline-scanner.js \
            --format json \
            --output security-report.json \
            --fail-on critical
      
      - name: Upload security report
        uses: actions/upload-artifact@v4
        with:
          name: security-report
          path: security-report.json
      
      - name: Comment PR with results
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = JSON.parse(fs.readFileSync('security-report.json', 'utf8'));
            
            const body = `## 🔒 Security Baseline Check Results
            
            **Score**: ${report.score}/100 (${report.grade})
            **Passed**: ${report.passed}/${report.total}
            **Failed**: ${report.failed}
            **Warnings**: ${report.warnings}
            
            ${report.failed > 0 ? '### ❌ Failed Checks\n' + report.checks
              .filter(c => !c.passed && c.level === 'critical')
              .map(c => `- **${c.name}**: ${c.issues.join(', ')}`)
              .join('\n') : '✅ All critical checks passed'}
            `;
            
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: body
            });
      
      - name: Fail if critical issues found
        if: steps.scan.outputs.critical-failures > 0
        run: |
          echo "❌ Critical security issues found!"
          exit 1
```

### 4.4 安全配置仪表板 API

**实现位置**：`backend/gateway/src/routes/admin/security.js`

```javascript
const express = require('express');
const router = express.Router();
const { SecurityScanner } = require('../../../shared/securityScanner');
const { requireAdmin, requireMFA } = require('../../../shared/middleware/auth');

const scanner = new SecurityScanner();

/**
 * 获取安全评分
 * GET /api/admin/security/score
 */
router.get('/score', requireAdmin(), async (req, res) => {
  const score = scanner.getSecurityScore();
  res.json({
    success: true,
    data: score
  });
});

/**
 * 执行安全扫描
 * POST /api/admin/security/scan
 */
router.post('/scan', requireAdmin(), requireMFA(), async (req, res) => {
  const results = await scanner.scanAll(req.app);
  res.json({
    success: true,
    data: results
  });
});

/**
 * 获取扫描历史
 * GET /api/admin/security/history
 */
router.get('/history', requireAdmin(), async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const history = scanner.getHistory(limit);
  res.json({
    success: true,
    data: history
  });
});

/**
 * 获取基线清单
 * GET /api/admin/security/baseline
 */
router.get('/baseline', requireAdmin(), async (req, res) => {
  const { SECURITY_BASELINE } = require('../../../shared/securityBaseline');
  res.json({
    success: true,
    data: SECURITY_BASELINE
  });
});

/**
 * 检测配置漂移
 * GET /api/admin/security/drift
 */
router.get('/drift', requireAdmin(), async (req, res) => {
  const drift = await scanner.detectDrift(scanner.lastBaseline);
  res.json({
    success: true,
    data: drift
  });
});

module.exports = router;
```

### 4.5 合规性报告生成器

**实现位置**：`backend/tools/compliance-report-generator.js`

```javascript
#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');
const { SECURITY_BASELINE, CHECK_RULES } = require('../shared/securityBaseline');

/**
 * 生成合规性报告
 */
async function generateComplianceReport(format = 'markdown') {
  const scanner = new (require('../shared/securityScanner').SecurityScanner)();
  
  // 执行扫描
  const results = await scanner.scanAll(app);
  
  // 生成报告
  const report = {
    title: 'mineGo API 安全配置合规性报告',
    generatedAt: new Date().toISOString(),
    summary: {
      score: scanner.getSecurityScore(),
      total: results.total,
      passed: results.passed,
      failed: results.failed,
      warnings: results.warnings
    },
    frameworks: {
      owasp: mapToOWASP(results.checks),
      pciDss: mapToPCIDSS(results.checks),
      gdpr: mapToGDPR(results.checks),
      cis: mapToCIS(results.checks)
    },
    details: results.checks,
    recommendations: generateRecommendations(results.checks)
  };
  
  // 输出格式化
  if (format === 'json') {
    return JSON.stringify(report, null, 2);
  } else if (format === 'html') {
    return generateHTMLReport(report);
  } else {
    return generateMarkdownReport(report);
  }
}

/**
 * 映射到 OWASP API Security Top 10
 */
function mapToOWASP(checks) {
  const owaspMap = {
    'authz': 'API1: Broken Object Level Authorization',
    'authn': 'API2: Broken Authentication',
    'dataExposure': 'API3: Broken Object Property Level Authorization',
    'rateLimit': 'API4: Unrestricted Resource Consumption',
    'functionAuthz': 'API5: Broken Function Level Authorization',
    'businessFlow': 'API6: Unrestricted Access to Sensitive Business Flows',
    'ssrf': 'API7: Server Side Request Forgery',
    'config': 'API8: Security Misconfiguration',
    'inventory': 'API9: Improper Inventory Management',
    'externalApi': 'API10: Unsafe Consumption of APIs'
  };
  
  const owaspResults = {};
  
  Object.entries(owaspMap).forEach(([category, owasp]) => {
    const categoryChecks = checks.filter(c => c.category === category);
    const passed = categoryChecks.filter(c => c.passed).length;
    
    owaspResults[owasp] = {
      status: passed === categoryChecks.length ? '✅ Compliant' : '❌ Non-compliant',
      passed: `${passed}/${categoryChecks.length}`,
      issues: categoryChecks.filter(c => !c.passed)
    };
  });
  
  return owaspResults;
}

/**
 * 映射到 PCI-DSS
 */
function mapToPCIDSS(checks) {
  const pciRequirements = [
    { id: '3.4', name: '支付数据加密', checks: ['encryption'] },
    { id: '3.5', name: '密钥管理', checks: ['keyManagement'] },
    { id: '3.6', name: '密钥轮换', checks: ['keyRotation'] },
    { id: '10.2', name: '审计日志', checks: ['auditLog'] },
    { id: '10.3', name: '日志详情', checks: ['logDetails'] }
  ];
  
  return pciRequirements.map(req => ({
    id: req.id,
    name: req.name,
    status: checks.filter(c => req.checks.includes(c.id)).every(c => c.passed)
      ? '✅ Compliant'
      : '❌ Non-compliant'
  }));
}

/**
 * 映射到 GDPR
 */
function mapToGDPR(checks) {
  const gdprArticles = [
    { article: 'Article 5', name: '数据最小化原则', checks: ['dataMinimization'] },
    { article: 'Article 7', name: '用户同意管理', checks: ['consentManagement'] },
    { article: 'Article 15', name: '数据访问权', checks: ['dataAccess'] },
    { article: 'Article 17', name: '数据删除权', checks: ['dataDeletion'] },
    { article: 'Article 25', name: '隐私保护设计', checks: ['privacyByDesign'] },
    { article: 'Article 32', name: '安全措施', checks: ['securityMeasures'] }
  ];
  
  return gdprArticles.map(article => ({
    article: article.article,
    name: article.name,
    status: checks.filter(c => article.checks.includes(c.id)).every(c => c.passed)
      ? '✅ Compliant'
      : '❌ Non-compliant'
  }));
}

/**
 * 生成修复建议
 */
function generateRecommendations(checks) {
  const recommendations = [];
  
  checks.filter(c => !c.passed).forEach(check => {
    recommendations.push({
      ruleId: check.id,
      name: check.name,
      level: check.level,
      currentStatus: 'Non-compliant',
      recommendation: getRecommendation(check.id),
      priority: check.level === 'critical' ? 'P0' : check.level === 'high' ? 'P1' : 'P2'
    });
  });
  
  return recommendations;
}

/**
 * 获取具体修复建议
 */
function getRecommendation(ruleId) {
  const recommendations = {
    'SEC-001': '为所有受保护的路由添加认证中间件',
    'SEC-002': '在 Express 应用中启用 securityHeaders 中间件',
    'SEC-003': '配置 rateLimit 中间件，设置合理的速率限制',
    'SEC-004': '修改 CORS 配置，使用白名单而非通配符',
    'SEC-005': '在生产环境设置 DEBUG=false',
    'SEC-006': '生成强随机 JWT_SECRET，设置合理的过期时间',
    'SEC-007': '使用统一的错误处理中间件，避免返回堆栈信息',
    'SEC-008': '配置严格的 CSP 策略，禁用 unsafe-inline 和 unsafe-eval'
  };
  
  return recommendations[ruleId] || '请参考安全基线文档进行配置';
}

/**
 * 生成 Markdown 报告
 */
function generateMarkdownReport(report) {
  return `# ${report.title}

生成时间: ${report.generatedAt}

## 📊 总体评分

**得分**: ${report.summary.score.score}/100 (${report.summary.score.grade})
- ✅ 通过: ${report.summary.passed}/${report.summary.total}
- ❌ 失败: ${report.summary.failed}
- ⚠️ 警告: ${report.summary.warnings}

## 🔒 OWASP API Security Top 10 合规性

| 风险项 | 状态 | 通过率 |
|--------|------|--------|
${Object.entries(report.frameworks.owasp).map(([key, value]) => 
  `| ${key} | ${value.status} | ${value.passed} |`
).join('\n')}

## 💳 PCI-DSS 合规性

| 要求 | 描述 | 状态 |
|------|------|------|
${report.frameworks.pciDss.map(r => 
  `| ${r.id} | ${r.name} | ${r.status} |`
).join('\n')}

## 🇪🇺 GDPR 合规性

| 条款 | 描述 | 状态 |
|------|------|------|
${report.frameworks.gdpr.map(a => 
  `| ${a.article} | ${a.name} | ${a.status} |`
).join('\n')}

## 🔧 修复建议

${report.recommendations.map(r => 
  `### ${r.name} (${r.level})
- **优先级**: ${r.priority}
- **当前状态**: ${r.currentStatus}
- **修复建议**: ${r.recommendation}
`
).join('\n')}

---
*本报告由 mineGo 安全配置基线检查系统自动生成*
`;
}

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  const format = args.includes('--format') 
    ? args[args.indexOf('--format') + 1] 
    : 'markdown';
  
  generateComplianceReport(format)
    .then(report => console.log(report))
    .catch(err => {
      console.error('生成报告失败:', err);
      process.exit(1);
    });
}

module.exports = { generateComplianceReport };
```

## 5. 验收标准

- [ ] **基线清单完整**
  - [ ] 覆盖 OWASP API Security Top 10 全部 10 项
  - [ ] 包含 PCI-DSS 核心要求（至少 5 项）
  - [ ] 包含 GDPR 核心要求（至少 6 项）

- [ ] **扫描器功能正确**
  - [ ] 能检测出缺少认证中间件的路由
  - [ ] 能检测出缺失的安全响应头
  - [ ] 能检测出速率限制配置问题
  - [ ] 能检测出 CORS 配置问题
  - [ ] 能检测出生产环境调试模式

- [ ] **配置漂移检测**
  - [ ] 能检测到安全配置变更
  - [ ] 检测延迟 < 5 分钟
  - [ ] 发送告警通知

- [ ] **CI/CD 集成**
  - [ ] GitHub Actions 工作流配置正确
  - [ ] 能在 PR 中显示扫描结果
  - [ ] Critical 级别问题导致构建失败

- [ ] **合规性报告**
  - [ ] 支持 Markdown/JSON/HTML 三种格式
  - [ ] 报告包含 OWASP/PCI-DSS/GDPR 合规状态
  - [ ] 包含详细的修复建议

- [ ] **管理后台**
  - [ ] 安全评分仪表板可访问
  - [ ] 扫描历史记录可查询
  - [ ] 基线清单可查看

- [ ] **测试覆盖**
  - [ ] 单元测试覆盖率 >= 85%
  - [ ] 集成测试验证扫描结果准确性
  - [ ] E2E 测试验证 CI/CD 集成

## 6. 工作量估算

**L (Large)**

**理由**：
- 需要设计完整的安全基线检查系统
- 实现多个核心模块（扫描器、漂移检测、报告生成）
- CI/CD 集成和测试
- 管理后台界面开发
- 预估工时：16-20 小时

## 7. 优先级理由

**P1（高优先级）**

**理由**：
1. **安全合规**：满足 OWASP、PCI-DSS、GDPR 等合规要求的基础
2. **风险防范**：自动检测安全配置缺陷，预防安全事故
3. **运维效率**：自动化安全检查减少手动审计工作量
4. **项目成熟度**：当前成熟度评分 95/100，安全加固仍有提升空间
5. **依赖性**：为后续安全自动化测试、渗透测试自动化奠定基础

此需求完成后，项目将具备完整的安全配置管理和持续验证能力。
