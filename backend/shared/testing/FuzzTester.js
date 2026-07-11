/**
 * API Fuzz Tester - API 模糊测试引擎
 * 对 API 端点进行 Fuzz 测试，发现输入验证漏洞
 * 
 * @module backend/shared/testing/FuzzTester
 * @version 1.0.0
 */

const fc = require('fast-check');
const { 
  userInputArbitrary, 
  sqlInjectionArbitrary, 
  xssArbitrary, 
  noSqlInjectionArbitrary,
  jsonBoundaryArbitrary
} = require('./arbitraries');

/**
 * FuzzTester - API 模糊测试器
 */
class FuzzTester {
  constructor(options = {}) {
    this.options = {
      numRuns: options.numRuns || 1000,
      timeout: options.timeout || 5000,
      baseUrl: options.baseUrl || 'http://localhost:8080',
      headers: options.headers || {},
      ...options
    };
    this.results = [];
    this.strategies = this.initializeStrategies();
  }

  /**
   * 初始化 Fuzz 测试策略
   */
  initializeStrategies() {
    return {
      headerInjection: new HeaderInjectionStrategy(),
      bodyInjection: new BodyInjectionStrategy(),
      paramInjection: new ParamInjectionStrategy(),
      authBypass: new AuthBypassStrategy(),
      typeConfusion: new TypeConfusionStrategy(),
      boundaryValue: new BoundaryValueStrategy(),
      rateLimitBypass: new RateLimitBypassStrategy()
    };
  }

  /**
   * 对单个端点进行 Fuzz 测试
   */
  async fuzzEndpoint(endpoint, method = 'POST', options = {}) {
    const { numRuns = this.options.numRuns } = options;
    const results = {
      endpoint,
      method,
      totalRuns: numRuns,
      issues: [],
      passed: 0,
      failed: 0,
      startTime: Date.now()
    };

    // 选择适用的策略
    const applicableStrategies = this.selectStrategies(method);

    for (let i = 0; i < numRuns; i++) {
      // 随机选择一个策略
      const strategyName = applicableStrategies[Math.floor(Math.random() * applicableStrategies.length)];
      const strategy = this.strategies[strategyName];

      // 生成 Fuzz 请求
      const request = strategy.generate(endpoint, method);

      try {
        const response = await this.sendRequest(request);
        const analysis = this.analyzeResponse(response, request, strategyName);

        if (analysis.issues.length > 0) {
          results.issues.push(...analysis.issues);
          results.failed++;
        } else {
          results.passed++;
        }
      } catch (error) {
        results.issues.push({
          type: 'request_error',
          severity: 'medium',
          request: this.sanitizeRequest(request),
          error: error.message,
          strategy: strategyName
        });
        results.failed++;
      }
    }

    results.endTime = Date.now();
    results.duration = results.endTime - results.startTime;
    results.severityCounts = this.countSeverities(results.issues);

    this.results.push(results);
    return results;
  }

  /**
   * 选择适用于该 HTTP 方法的策略
   */
  selectStrategies(method) {
    const strategies = ['headerInjection', 'boundaryValue', 'typeConfusion'];

    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      strategies.push('bodyInjection');
      strategies.push('paramInjection');
    }

    if (['GET', 'DELETE'].includes(method)) {
      strategies.push('paramInjection');
    }

    // 认证绕过策略适用于所有方法
    strategies.push('authBypass');

    return strategies;
  }

  /**
   * 发送请求（模拟实现，实际使用时需要替换）
   */
  async sendRequest(request) {
    // 模拟响应（实际实现需要连接真实服务器）
    return {
      status: 200,
      headers: {},
      body: { success: true }
    };
  }

  /**
   * 分析响应，检测问题
   */
  analyzeResponse(response, request, strategyName) {
    const issues = [];

    // 检查 HTTP 状态码
    if (response.status >= 500) {
      issues.push({
        type: 'server_error',
        severity: 'critical',
        statusCode: response.status,
        strategy: strategyName,
        description: `Server returned ${response.status} error`
      });
    }

    // 检查信息泄露
    if (response.body) {
      const bodyStr = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);

      // 检查堆栈跟踪泄露
      if (/stack|Error:|at [a-zA-Z]+\.[a-zA-Z]+/.test(bodyStr)) {
        issues.push({
          type: 'stack_trace_leak',
          severity: 'high',
          strategy: strategyName,
          description: 'Stack trace exposed in response'
        });
      }

      // 检查敏感信息泄露
      if (/password|secret|api_key|token/.test(bodyStr.toLowerCase())) {
        issues.push({
          type: 'sensitive_data_leak',
          severity: 'critical',
          strategy: strategyName,
          description: 'Sensitive data exposed in response'
        });
      }

      // 检查 SQL 错误泄露
      if (/sql|mysql|postgres|ora-0|syntax error/i.test(bodyStr)) {
        issues.push({
          type: 'sql_error_leak',
          severity: 'high',
          strategy: strategyName,
          description: 'SQL error information exposed'
        });
      }
    }

    // 检查响应头安全问题
    const headers = response.headers || {};

    if (!headers['content-type']) {
      issues.push({
        type: 'missing_content_type',
        severity: 'low',
        strategy: strategyName,
        description: 'Missing Content-Type header'
      });
    }

    if (!headers['x-content-type-options']) {
      issues.push({
        type: 'missing_nosniff',
        severity: 'low',
        strategy: strategyName,
        description: 'Missing X-Content-Type-Options: nosniff'
      });
    }

    return { issues };
  }

  /**
   * 统计各严重级别问题数量
   */
  countSeverities(issues) {
    return {
      critical: issues.filter(i => i.severity === 'critical').length,
      high: issues.filter(i => i.severity === 'high').length,
      medium: issues.filter(i => i.severity === 'medium').length,
      low: issues.filter(i => i.severity === 'low').length
    };
  }

  /**
   * 清理请求中的敏感信息用于日志
   */
  sanitizeRequest(request) {
    const sanitized = { ...request };
    if (sanitized.headers && sanitized.headers['Authorization']) {
      sanitized.headers['Authorization'] = '[REDACTED]';
    }
    return sanitized;
  }

  /**
   * 对多个端点进行批量 Fuzz 测试
   */
  async fuzzEndpoints(endpoints) {
    const results = [];

    for (const endpoint of endpoints) {
      const result = await this.fuzzEndpoint(
        endpoint.path,
        endpoint.method || 'GET',
        endpoint.options || {}
      );
      results.push(result);
    }

    return this.generateAggregateReport(results);
  }

  /**
   * 生成聚合报告
   */
  generateAggregateReport(results) {
    const totalRuns = results.reduce((sum, r) => sum + r.totalRuns, 0);
    const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);

    return {
      summary: {
        totalEndpoints: results.length,
        totalRuns,
        totalIssues,
        averageIssuesPerEndpoint: totalIssues / results.length,
        endpointsWithIssues: results.filter(r => r.issues.length > 0).length,
        passRate: ((totalRuns - totalIssues) / totalRuns * 100).toFixed(2)
      },
      severityCounts: {
        critical: results.reduce((sum, r) => sum + r.severityCounts.critical, 0),
        high: results.reduce((sum, r) => sum + r.severityCounts.high, 0),
        medium: results.reduce((sum, r) => sum + r.severityCounts.medium, 0),
        low: results.reduce((sum, r) => sum + r.severityCounts.low, 0)
      },
      results
    };
  }
}

/**
 * Header 注入策略
 */
class HeaderInjectionStrategy {
  name = 'HeaderInjection';

  generate(endpoint, method) {
    const maliciousHeaders = fc.sample(
      fc.record({
        'X-Forwarded-For': fc.oneof(
          fc.constant("'; DROP TABLE users; --"),
          fc.constant('"><script>alert(1)</script>'),
          fc.constant('127.0.0.1'),// 尝试绕过 IP 检测
          fc.constant('undefined'),
          fc.constant(null)
        ),
        'User-Agent': fc.oneof(
          fc.constant('<script>alert(1)</script>'),
          fc.constant(''),
          fc.constant("'; --"),
          fc.constant('../../../etc/passwd')
        ),
        'Referer': fc.oneof(
          fc.constant('javascript:alert(1)'),
          fc.constant('http://evil.com'),
          fc.constant('')
        ),
        'X-Custom-Header': fc.string().filter(s => s.includes('\n') || s.includes('\r'))
      })
    )[0];

    return {
      method,
      path: endpoint,
      headers: {
        'Content-Type': 'application/json',
        ...maliciousHeaders
      },
      body: {}
    };
  }
}

/**
 * Body 注入策略
 */
class BodyInjectionStrategy {
  name = 'BodyInjection';

  generate(endpoint, method) {
    const payloads = [
      // SQL 注入
      { id: "1' OR '1'='1" },
      { id: "1; DROP TABLE users; --" },
      { id: "1 UNION SELECT * FROM users" },
      // NoSQL 注入
      { id: { $gt: '' } },
      { id: { $where: 'this.password == this.username' } },
      { query: { $ne: null } },
      // XSS
      { name: '<script>alert(1)</script>' },
      { name: '<img src=x onerror=alert(1)>' },
      { content: 'javascript:alert(1)' },
      // 原型污染
      { __proto__: { isAdmin: true } },
      { constructor: { prototype: { isAdmin: true } } },
      // 类型混淆
      { id: '1' },
      { id: null },
      { id: [] },
      { id: {} },
      // 超长值
      { name: 'a'.repeat(100000) },
      // 深嵌套
      { data: JSON.parse('{ "a": '.repeat(50) + '"b"' + '}'.repeat(50)) }
    ];

    const payload = payloads[Math.floor(Math.random() * payloads.length)];

    return {
      method,
      path: endpoint,
      headers: { 'Content-Type': 'application/json' },
      body: payload
    };
  }
}

/**
 * 参数注入策略
 */
class ParamInjectionStrategy {
  name = 'ParamInjection';

  generate(endpoint, method) {
    const params = [
      { id: '1' },
      { id: '1 OR 1=1' },
      { id: '../../../etc/passwd' },
      { id: '..\\..\\..\\windows\\system32' },
      { id: '"><script>alert(1)</script>' },
      { id: '' },
      { id: null },
      { id: 'undefined' },
      { id: 'NaN' },
      { id: '0' },
      { id: '-1' },
      { id: '999999999999999' },
      { page: '-1' },
      { page: '0' },
      { page: '999999999' },
      { sort: 'id; DROP TABLE users' },
      { filter: '{"$gt":""}' }
    ];

    const param = params[Math.floor(Math.random() * params.length)];
    const queryString = Object.entries(param)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    return {
      method,
      path: `${endpoint}?${queryString}`,
      headers: { 'Content-Type': 'application/json' },
      body: {}
    };
  }
}

/**
 * 认证绕过策略
 */
class AuthBypassStrategy {
  name = 'AuthBypass';

  generate(endpoint, method) {
    const authVariants = [
      {},// 无认证
      { 'Authorization': '' },// 空
      { 'Authorization': 'Bearer invalid_token' },
      { 'Authorization': 'Bearer null' },
      { 'Authorization': 'Bearer undefined' },
      { 'Authorization': 'Basic admin:admin' },
      { 'Authorization': 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.' },// 无算法 JWT
      { 'X-User-Id': '1' },// 直接注入用户 ID
      { 'X-Admin': 'true' },
      { 'X-Forwarded-User': 'admin' },
      { 'Cookie': 'session=invalid; admin=true' }
    ];

    const auth = authVariants[Math.floor(Math.random() * authVariants.length)];

    return {
      method,
      path: endpoint,
      headers: {
        'Content-Type': 'application/json',
        ...auth
      },
      body: {}
    };
  }
}

/**
 * 类型混淆策略
 */
class TypeConfusionStrategy {
  name = 'TypeConfusion';

  generate(endpoint, method) {
    const typeConfusions = [
      // 数值字段传入字符串
      { id: 'string', cp: 'string', level: 'string' },
      // 数值字段传入对象
      { id: {}, cp: [], level: null },
      // 字符串字段传入数值
      { name: 123, nickname: true },
      // 布尔字段传入其他类型
      { isFavorite: 'true', isPublic: 1 },
      // 数组字段传入字符串
      { types: 'fire' },
      // 对象字段传入数组
      { location: [] },
      // 极端值
      { id: Number.MAX_SAFE_INTEGER },
      { id: Number.MIN_SAFE_INTEGER },
      { cp: Infinity },
      { level: NaN },
      // null/undefined
      { id: null },
      { id: undefined },
      // 数组注入
      { id: [1, 2, 3] },
      { types: [['fire']] }
    ];

    const payload = typeConfusions[Math.floor(Math.random() * typeConfusions.length)];

    return {
      method,
      path: endpoint,
      headers: { 'Content-Type': 'application/json' },
      body: payload
    };
  }
}

/**
 * 边界值策略
 */
class BoundaryValueStrategy {
  name = 'BoundaryValue';

  generate(endpoint, method) {
    const boundaryPayloads = [
      // 空值
      {},
      { id: '' },
      { id: null },
      // 零值
      { id: 0, cp: 0, level: 0, hp: 0 },
      // 负值
      { id: -1, cp: -1, level: -1, hp: -1 },
      // 极大值
      { id: Number.MAX_SAFE_INTEGER },
      { cp: Number.MAX_SAFE_INTEGER },
      { level: Number.MAX_SAFE_INTEGER },
      // 超限值
      { id: 100000000 },// 超大 ID
      { cp: 100000 },// 超大 CP
      { level: 101 },// 超限等级
      // 浮点精度
      { amount: 0.1 + 0.2 },// 0.30000000000000004
      { amount: 0.123456789 },
      // 特殊字符
      { name: '' },
      { name: '\u0000' },
      { name: '\u202E' },
      // 超长字符串
      { name: 'a'.repeat(100000) },
      // 空数组
      { types: [] },
      { moves: [] },
      // 超大数组
      { types: Array(10000).fill('fire') }
    ];

    const payload = boundaryPayloads[Math.floor(Math.random() * boundaryPayloads.length)];

    return {
      method,
      path: endpoint,
      headers: { 'Content-Type': 'application/json' },
      body: payload
    };
  }
}

/**
 * 速率限制绕过策略
 */
class RateLimitBypassStrategy {
  name = 'RateLimitBypass';

  generate(endpoint, method) {
    const bypassHeaders = {
      'X-Forwarded-For': '127.0.0.1',
      'X-Real-IP': '127.0.0.1',
      'X-Originating-IP': '127.0.0.1',
      'X-Remote-Addr': '127.0.0.1',
      'X-Client-IP': '127.0.0.1'
    };

    // 随机选择部分 header
    const selectedHeaders = {};
    const keys = Object.keys(bypassHeaders);
    const numHeaders = Math.floor(Math.random() * keys.length) + 1;
    for (let i = 0; i < numHeaders; i++) {
      const key = keys[Math.floor(Math.random() * keys.length)];
      selectedHeaders[key] = bypassHeaders[key];
    }

    return {
      method,
      path: endpoint,
      headers: {
        'Content-Type': 'application/json',
        ...selectedHeaders
      },
      body: {}
    };
  }
}

module.exports = {
  FuzzTester,
  HeaderInjectionStrategy,
  BodyInjectionStrategy,
  ParamInjectionStrategy,
  AuthBypassStrategy,
  TypeConfusionStrategy,
  BoundaryValueStrategy,
  RateLimitBypassStrategy
};