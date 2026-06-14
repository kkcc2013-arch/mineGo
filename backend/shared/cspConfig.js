'use strict';
/**
 * CSP (Content Security Policy) 配置
 * REQ-00111: API 安全响应头与 CSP 强化系统
 */

const cspPolicies = {
  // 游戏客户端 CSP - 较宽松以支持游戏功能
  gameClient: {
    directives: {
      'default-src': ["'self'"],
      'script-src': [
        "'self'",
        "'unsafe-inline'",  // 游戏客户端需要内联脚本
        "'unsafe-eval'",    // 某些游戏引擎需要 eval
        'cdn.jsdelivr.net',
        'unpkg.com'
      ],
      'style-src': [
        "'self'",
        "'unsafe-inline'",
        'fonts.googleapis.com',
        'cdn.jsdelivr.net'
      ],
      'img-src': [
        "'self'",
        'data:',
        'blob:',
        'https:',
        'cdn.jsdelivr.net'
      ],
      'connect-src': [
        "'self'",
        'api.minego.com',
        'wss://ws.minego.com',
        'https://api.openweathermap.org'  // 天气 API
      ],
      'font-src': [
        "'self'",
        'fonts.gstatic.com',
        'cdn.jsdelivr.net'
      ],
      'worker-src': ["'self'", 'blob:'],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"]
    },
    reportOnly: false,
    reportUri: '/api/v1/security/csp-report'
  },

  // 管理后台 CSP - 更严格
  adminDashboard: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'font-src': ["'self'"],
      'frame-ancestors': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
      'report-uri': ['/api/v1/security/csp-report']
    },
    reportOnly: false
  },

  // API Gateway CSP - 最严格
  apiGateway: {
    directives: {
      'default-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"]
    },
    reportOnly: false
  },

  // 报告模式 CSP（用于测试新策略）
  reportOnly: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'https:'],
      'connect-src': ["'self'"],
      'report-uri': ['/api/v1/security/csp-report']
    },
    reportOnly: true
  }
};

/**
 * 根据请求选择合适的 CSP 策略
 */
function selectCSPPolicy(req) {
  const userAgent = req.headers['user-agent'] || '';
  const referer = req.headers['referer'] || '';
  const origin = req.headers['origin'] || '';

  // API 请求
  if (req.path.startsWith('/api/') || req.path.startsWith('/health') || req.path.startsWith('/metrics')) {
    return cspPolicies.apiGateway;
  }

  // 管理后台
  if (referer.includes('/admin') || req.path.startsWith('/admin')) {
    return cspPolicies.adminDashboard;
  }

  // 游戏客户端
  if (referer.includes('/game') || req.path.startsWith('/game') || req.path === '/') {
    return cspPolicies.gameClient;
  }

  // 默认使用 API 策略
  return cspPolicies.apiGateway;
}

/**
 * 生成 CSP 头字符串
 */
function generateCSPHeader(policy) {
  const directives = policy.directives;
  const parts = [];

  for (const [directive, value] of Object.entries(directives)) {
    if (directive === 'report-uri') continue; // 单独处理

    if (Array.isArray(value)) {
      if (value.length > 0) {
        parts.push(`${directive} ${value.join(' ')}`);
      } else {
        parts.push(directive);
      }
    } else if (typeof value === 'string') {
      parts.push(`${directive} ${value}`);
    } else {
      parts.push(directive);
    }
  }

  // 添加报告 URI
  if (policy.reportUri) {
    parts.push(`report-uri ${policy.reportUri}`);
  }

  return parts.join('; ');
}

module.exports = {
  cspPolicies,
  selectCSPPolicy,
  generateCSPHeader
};
