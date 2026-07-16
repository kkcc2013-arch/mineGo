# REQ-00551：API 错误码交互式文档与在线调试沙盒系统

- **编号**：REQ-00551
- **类别**：文档/开发者体验
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、admin-dashboard、docs-site、backend/shared/errorCodes
- **创建时间**：2026-07-16 14:00
- **依赖需求**：REQ-00066（API 错误码标准化，已完成）、REQ-00398（API 调用示例库，已完成）

## 1. 背景与问题

mineGo 已有 API 错误码标准化系统（REQ-00066），但在开发者实际使用中仍存在以下痛点：

### 1.1 当前问题

1. **错误码查询困难**：开发者遇到错误码时需要翻阅静态文档，无法快速定位问题原因
```markdown
// 当前文档格式 - 静态列表
| 错误码 | 说明 | 解决方案 |
|--------|------|----------|
| AUTH001 | Token 无效 | 重新登录 |
// 缺少：示例请求、响应详情、在线调试
```

2. **无法在线调试**：开发者遇到错误后无法直接在文档中模拟请求、排查问题

3. **错误场景示例缺失**：同一错误码在不同场景下可能有不同表现，缺少场景化说明

4. **多语言错误消息预览困难**：错误消息支持多语言（REQ-00101），但开发者无法预览各语言版本

### 1.2 代码现状

当前错误码系统：
- `backend/shared/errorCodes.js`：定义了标准错误码
- `backend/shared/errorMessages.js`：多语言错误消息
- `docs/api/errors.md`：静态文档
- 缺少：交互式文档、在线调试沙盒

## 2. 目标

1. **交互式错误码查询**：输入错误码即时显示详细信息、解决方案、相关 API
2. **在线调试沙盒**：开发者可直接在文档中发送请求，模拟错误场景
3. **场景化错误说明**：展示同一错误码在不同场景下的表现和解决方案
4. **多语言消息预览**：一键切换查看不同语言的错误消息
5. **智能诊断建议**：根据错误信息和上下文，提供可能的原因和修复建议

## 3. 范围

### 包含
- 错误码交互式查询页面
- API 在线调试沙盒
- 场景化错误示例库
- 多语言消息预览器
- 智能诊断建议引擎
- 错误统计分析仪表盘

### 不包含
- API 文档生成（已有 OpenAPI）
- 实际业务逻辑调试
- 线上环境调试

## 4. 详细需求

### 4.1 错误码交互式查询

```javascript
// docs-site/src/components/ErrorCodeExplorer.js

'use strict';

const { errorCodes, getErrorInfo } = require('../../../backend/shared/errorCodes');
const { getErrorMessage } = require('../../../backend/shared/errorMessages');

/**
 * 错误码查询器
 */
class ErrorCodeExplorer {
  constructor() {
    this.errorDatabase = this.buildErrorDatabase();
  }

  /**
   * 构建错误码数据库
   */
  buildErrorDatabase() {
    const database = {};
    
    // 按模块分组
    const modules = {
      AUTH: { name: '认证授权', color: '#ff6b6b' },
      USER: { name: '用户管理', color: '#4ecdc4' },
      POKEMON: { name: '精灵系统', color: '#45b7d1' },
      CATCH: { name: '捕捉系统', color: '#f9ca24' },
      GYM: { name: '道馆系统', color: '#a55eea' },
      SOCIAL: { name: '社交系统', color: '#fd79a8' },
      PAYMENT: { name: '支付系统', color: '#00b894' },
      RATE_LIMIT: { name: '限流控制', color: '#e17055' },
      SYSTEM: { name: '系统错误', color: '#636e72' }
    };

    Object.entries(errorCodes).forEach(([code, info]) => {
      const module = code.split('_')[0];
      const moduleName = modules[module]?.name || '其他';
      
      database[code] = {
        code,
        module,
        moduleName,
        moduleColor: modules[module]?.color || '#666',
        httpStatus: info.httpStatus,
        category: info.category,
        severity: this.calculateSeverity(info.httpStatus),
        scenarios: info.scenarios || [],
        relatedApis: info.relatedApis || [],
        troubleshooting: info.troubleshooting || [],
        examples: info.examples || []
      };
    });

    return database;
  }

  /**
   * 计算错误严重程度
   */
  calculateSeverity(httpStatus) {
    if (httpStatus >= 500) return 'critical';
    if (httpStatus >= 400) return 'warning';
    return 'info';
  }

  /**
   * 搜索错误码
   */
  search(query) {
    const results = [];
    const lowerQuery = query.toLowerCase();

    Object.values(this.errorDatabase).forEach(error => {
      const messages = this.getAllMessages(error.code);
      const searchText = [
        error.code,
        error.moduleName,
        messages.join(' ')
      ].join(' ').toLowerCase();

      if (searchText.includes(lowerQuery)) {
        results.push({
          ...error,
          messages: this.getMessagesByLocale(error.code)
        });
      }
    });

    return results;
  }

  /**
   * 获取所有语言的错误消息
   */
  getMessagesByLocale(code) {
    const locales = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'];
    const messages = {};
    
    locales.forEach(locale => {
      messages[locale] = getErrorMessage(code, locale);
    });

    return messages;
  }

  /**
   * 获取所有消息（用于搜索）
   */
  getAllMessages(code) {
    return Object.values(this.getMessagesByLocale(code));
  }

  /**
   * 获取错误详情
   */
  getErrorDetails(code) {
    const error = this.errorDatabase[code];
    if (!error) return null;

    return {
      ...error,
      messages: this.getMessagesByLocale(code),
      relatedErrors: this.findRelatedErrors(code),
      recentOccurrences: this.getRecentOccurrences(code)
    };
  }

  /**
   * 查找相关错误
   */
  findRelatedErrors(code) {
    const module = code.split('_')[0];
    return Object.keys(this.errorDatabase)
      .filter(c => c.startsWith(module) && c !== code)
      .slice(0, 5);
  }

  /**
   * 获取近期发生统计（模拟数据）
   */
  getRecentOccurrences(code) {
    // 实际应从监控系统获取
    return {
      last24h: Math.floor(Math.random() * 100),
      last7d: Math.floor(Math.random() * 500),
      trend: ['stable', 'increasing', 'decreasing'][Math.floor(Math.random() * 3)]
    };
  }
}

module.exports = { ErrorCodeExplorer };
```

### 4.2 API 调试沙盒

```javascript
// docs-site/src/components/ApiSandbox.js

'use strict';

/**
 * API 调试沙盒
 */
class ApiSandbox {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://api.minego.game';
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * 构建请求配置面板
   */
  buildRequestPanel(api) {
    return {
      method: api.method,
      path: api.path,
      headers: {
        ...this.defaultHeaders,
        'Authorization': '<your-token>'
      },
      params: this.buildParamsPanel(api.params),
      body: api.body ? this.buildBodyEditor(api.body) : null,
      prescripts: api.prescripts || [],
      postscripts: api.postscripts || []
    };
  }

  /**
   * 构建参数面板
   */
  buildParamsPanel(params) {
    return params.map(param => ({
      name: param.name,
      type: param.type,
      required: param.required,
      description: param.description,
      default: param.default,
      options: param.enum,
      value: param.default
    }));
  }

  /**
   * 构建请求体编辑器
   */
  buildBodyEditor(schema) {
    const template = this.generateTemplate(schema);
    return {
      language: 'json',
      template: JSON.stringify(template, null, 2),
      schema: schema,
      validation: true
    };
  }

  /**
   * 生成请求体模板
   */
  generateTemplate(schema) {
    if (schema.type === 'object') {
      const obj = {};
      Object.entries(schema.properties || {}).forEach(([key, prop]) => {
        obj[key] = this.generateTemplate(prop);
      });
      return obj;
    }
    
    if (schema.type === 'array') {
      return [this.generateTemplate(schema.items || {})];
    }
    
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    
    // 根据类型生成默认值
    switch (schema.type) {
      case 'string': return '';
      case 'number':
      case 'integer': return 0;
      case 'boolean': return false;
      default: return null;
    }
  }

  /**
   * 发送请求
   */
  async sendRequest(config) {
    const startTime = Date.now();
    
    try {
      const url = new URL(this.baseUrl + config.path);
      
      // 添加查询参数
      if (config.params) {
        Object.entries(config.params).forEach(([key, value]) => {
          if (value !== undefined && value !== '') {
            url.searchParams.append(key, value);
          }
        });
      }

      // 执行前置脚本
      for (const script of config.prescripts) {
        await this.executeScript(script, config);
      }

      const response = await fetch(url, {
        method: config.method,
        headers: this.processHeaders(config.headers),
        body: config.body ? JSON.stringify(config.body) : undefined
      });

      const data = await response.json();
      const duration = Date.now() - startTime;

      // 执行后置脚本
      for (const script of config.postscripts) {
        await this.executeScript(script, { response: data, duration });
      }

      return {
        success: true,
        status: response.status,
        headers: Object.fromEntries(response.headers),
        data,
        duration,
        timeline: this.buildTimeline(config, data)
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * 处理请求头
   */
  processHeaders(headers) {
    const processed = {};
    Object.entries(headers).forEach(([key, value]) => {
      if (value && value !== '<your-token>') {
        processed[key] = value;
      }
    });
    return processed;
  }

  /**
   * 执行脚本
   */
  async executeScript(script, context) {
    const fn = new Function('context', script.code);
    return fn(context);
  }

  /**
   * 构建请求时间线
   */
  buildTimeline(config, response) {
    return [
      { event: 'DNS Lookup', duration: '10ms' },
      { event: 'TCP Connection', duration: '15ms' },
      { event: 'TLS Handshake', duration: '20ms' },
      { event: 'Request Sent', duration: '5ms' },
      { event: 'Waiting (TTFB)', duration: '50ms' },
      { event: 'Content Download', duration: '10ms' }
    ];
  }

  /**
   * 模拟错误响应
   */
  async simulateError(errorCode) {
    const errorInfo = getErrorInfo(errorCode);
    return {
      success: false,
      status: errorInfo.httpStatus,
      data: {
        success: false,
        error: {
          code: errorCode,
          message: getErrorMessage(errorCode, 'zh-CN'),
          details: errorInfo.details
        }
      }
    };
  }
}

module.exports = { ApiSandbox };
```

### 4.3 场景化错误示例

```javascript
// docs-site/src/data/errorScenarios.js

'use strict';

/**
 * 错误场景示例数据
 */
const ERROR_SCENARIOS = {
  AUTH_TOKEN_INVALID: {
    code: 'AUTH_001',
    title: 'Token 无效场景',
    scenarios: [
      {
        name: 'Token 过期',
        description: '用户长时间未活动，Token 已过期',
        request: {
          method: 'GET',
          path: '/api/v1/user/profile',
          headers: {
            'Authorization': 'Bearer expired_token_xxx'
          }
        },
        response: {
          status: 401,
          body: {
            success: false,
            error: {
              code: 'AUTH_001',
              message: '登录已过期，请重新登录'
            }
          }
        },
        solution: '调用 /api/v1/auth/refresh 刷新 Token'
      },
      {
        name: 'Token 被篡改',
        description: 'Token 签名验证失败',
        request: {
          method: 'GET',
          path: '/api/v1/user/profile',
          headers: {
            'Authorization': 'Bearer tampered_token_xxx'
          }
        },
        response: {
          status: 401,
          body: {
            success: false,
            error: {
              code: 'AUTH_001',
              message: '登录状态异常，请重新登录'
            }
          }
        },
        solution: '清除本地存储，重新登录'
      },
      {
        name: 'Token 被加入黑名单',
        description: '用户在其他设备登出或修改密码',
        request: {
          method: 'GET',
          path: '/api/v1/user/profile'
        },
        response: {
          status: 401,
          body: {
            success: false,
            error: {
              code: 'AUTH_001',
              message: '账号已在其他设备登录'
            }
          }
        },
        solution: '引导用户重新登录'
      }
    ]
  },

  RATE_LIMIT_EXCEEDED: {
    code: 'RATE_LIMIT_001',
    title: '请求频率超限场景',
    scenarios: [
      {
        name: 'API 请求过快',
        description: '短时间内发送大量请求',
        request: {
          method: 'GET',
          path: '/api/v1/pokemon/nearby',
          note: '连续请求超过 10 次/秒'
        },
        response: {
          status: 429,
          headers: {
            'X-RateLimit-Limit': '10',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': '1640000000'
          },
          body: {
            success: false,
            error: {
              code: 'RATE_LIMIT_001',
              message: '请求过于频繁，请稍后再试',
              retryAfter: 60
            }
          }
        },
        solution: '等待 retryAfter 秒后重试，或实现请求队列'
      }
    ]
  },

  CATCH_INVALID_LOCATION: {
    code: 'CATCH_003',
    title: '捕捉位置异常场景',
    scenarios: [
      {
        name: 'GPS 位置跳跃',
        description: '检测到位置瞬间跳跃超过阈值',
        request: {
          method: 'POST',
          path: '/api/v1/catch/attempt',
          body: {
            pokemonId: 'pikachu_001',
            latitude: 39.9042,
            longitude: 116.4074,
            previousLatitude: 31.2304,  // 瞬间跳跃 1200km
            previousLongitude: 121.4737
          }
        },
        response: {
          status: 400,
          body: {
            success: false,
            error: {
              code: 'CATCH_003',
              message: '位置移动异常，请检查 GPS 设置'
            }
          }
        },
        solution: '提示用户检查 GPS 设置，或等待位置稳定'
      },
      {
        name: '模拟器检测',
        description: '检测到运行在模拟器环境',
        request: {
          method: 'POST',
          path: '/api/v1/catch/attempt',
          headers: {
            'X-Device-Integrity': 'invalid'
          }
        },
        response: {
          status: 403,
          body: {
            success: false,
            error: {
              code: 'CATCH_003',
              message: '检测到异常环境，无法进行游戏'
            }
          }
        },
        solution: '提示用户使用真实设备'
      }
    ]
  }
};

module.exports = { ERROR_SCENARIOS };
```

### 4.4 智能诊断引擎

```javascript
// docs-site/src/components/SmartDiagnostics.js

'use strict';

const { errorCodes } = require('../../../backend/shared/errorCodes');

/**
 * 智能诊断引擎
 */
class SmartDiagnostics {
  constructor() {
    this.diagnosticRules = this.loadDiagnosticRules();
  }

  /**
   * 加载诊断规则
   */
  loadDiagnosticRules() {
    return {
      'AUTH_001': [
        {
          condition: (ctx) => ctx.lastAuthTime && (Date.now() - ctx.lastAuthTime > 3600000),
          diagnosis: 'Token 可能已过期',
          solution: '尝试刷新 Token 或重新登录',
          action: 'CALL_REFRESH_TOKEN'
        },
        {
          condition: (ctx) => ctx.deviceChanged,
          diagnosis: '检测到设备变更，Token 可能已失效',
          solution: '引导用户重新登录',
          action: 'SHOW_LOGIN_SCREEN'
        },
        {
          condition: (ctx) => ctx.passwordChangedRecently,
          diagnosis: '密码已修改，所有 Token 已失效',
          solution: '需要重新登录',
          action: 'SHOW_LOGIN_SCREEN'
        }
      ],
      'RATE_LIMIT_001': [
        {
          condition: (ctx) => ctx.requestCount > 100,
          diagnosis: '可能存在无限循环或批量请求',
          solution: '检查代码中的请求逻辑',
          action: 'CHECK_CODE'
        },
        {
          condition: (ctx) => ctx.concurrentRequests > 5,
          diagnosis: '并发请求过多',
          solution: '实现请求队列，限制并发数',
          action: 'IMPLEMENT_QUEUE'
        }
      ],
      'CATCH_003': [
        {
          condition: (ctx) => ctx.speedKmh > 120,
          diagnosis: '移动速度异常（超过 120km/h）',
          solution: '确保在安全环境下游戏',
          action: 'WARN_SAFETY'
        },
        {
          condition: (ctx) => ctx.emulatorDetected,
          diagnosis: '检测到模拟器环境',
          solution: '请使用真实移动设备',
          action: 'SHOW_EMULATOR_WARNING'
        }
      ]
    };
  }

  /**
   * 诊断问题
   */
  diagnose(errorCode, context = {}) {
    const rules = this.diagnosticRules[errorCode] || [];
    const results = [];

    for (const rule of rules) {
      try {
        if (rule.condition(context)) {
          results.push({
            diagnosis: rule.diagnosis,
            solution: rule.solution,
            action: rule.action,
            confidence: 0.8  // 置信度
          });
        }
      } catch (e) {
        // 规则执行失败，跳过
      }
    }

    // 如果没有匹配的规则，返回通用建议
    if (results.length === 0) {
      results.push(this.getGenericDiagnosis(errorCode));
    }

    return {
      errorCode,
      timestamp: new Date().toISOString(),
      diagnostics: results.sort((a, b) => b.confidence - a.confidence)
    };
  }

  /**
   * 获取通用诊断建议
   */
  getGenericDiagnosis(errorCode) {
    const errorInfo = errorCodes[errorCode];
    return {
      diagnosis: errorInfo?.description || '发生未知错误',
      solution: '请参考错误码文档或联系技术支持',
      action: 'SHOW_DOCS',
      confidence: 0.5
    };
  }

  /**
   * 根据错误响应生成调试建议
   */
  generateDebugSuggestions(errorResponse) {
    const suggestions = [];
    
    // 检查常见问题
    if (errorResponse.status === 401) {
      suggestions.push({
        category: '认证',
        items: [
          '检查 Authorization 头格式是否正确',
          '确认 Token 未过期',
          '验证 Token 格式是否为有效 JWT'
        ]
      });
    }

    if (errorResponse.status === 429) {
      suggestions.push({
        category: '限流',
        items: [
          '检查请求频率是否超过限制',
          '实现指数退避重试机制',
          '合并批量请求'
        ]
      });
    }

    if (errorResponse.status === 500) {
      suggestions.push({
        category: '服务端',
        items: [
          '查看服务端日志获取详细错误',
          '稍后重试',
          '联系技术支持并提供请求 ID'
        ]
      });
    }

    return suggestions;
  }

  /**
   * 生成错误报告模板
   */
  generateBugReport(errorCode, context) {
    const diagnosis = this.diagnose(errorCode, context);
    const errorInfo = errorCodes[errorCode];

    return {
      title: `[${errorCode}] ${errorInfo?.description || '未知错误'}`,
      template: `
## 错误信息
- **错误码**: ${errorCode}
- **HTTP 状态**: ${errorInfo?.httpStatus}
- **错误消息**: ${errorInfo?.message}

## 请求详情
- **API**: ${context.method} ${context.path}
- **时间戳**: ${new Date().toISOString()}
- **请求 ID**: ${context.requestId || 'N/A'}

## 诊断建议
${diagnosis.diagnostics.map(d => `- ${d.diagnosis}: ${d.solution}`).join('\n')}

## 重现步骤
1. [请填写重现步骤]

## 预期行为
[请填写预期行为]

## 实际行为
[请填写实际行为]

## 环境
- 客户端版本: ${context.clientVersion || 'N/A'}
- 操作系统: ${context.os || 'N/A'}
- 语言: ${context.locale || 'N/A'}
      `.trim()
    };
  }
}

module.exports = { SmartDiagnostics };
```

### 4.5 文档站点路由

```javascript
// docs-site/src/routes/errors.js

'use strict';

const express = require('express');
const router = express.Router();
const { ErrorCodeExplorer } = require('../components/ErrorCodeExplorer');
const { SmartDiagnostics } = require('../components/SmartDiagnostics');

const explorer = new ErrorCodeExplorer();
const diagnostics = new SmartDiagnostics();

/**
 * GET /docs/errors
 * 错误码查询页面
 */
router.get('/', (req, res) => {
  res.render('errors/index', {
    modules: Object.keys(errorCodes).reduce((acc, code) => {
      const module = code.split('_')[0];
      if (!acc[module]) acc[module] = [];
      acc[module].push(code);
      return acc;
    }, {})
  });
});

/**
 * GET /docs/errors/:code
 * 错误码详情页面
 */
router.get('/:code', (req, res) => {
  const { code } = req.params;
  const details = explorer.getErrorDetails(code);
  
  if (!details) {
    return res.status(404).render('errors/not-found', { code });
  }

  res.render('errors/detail', { error: details });
});

/**
 * GET /docs/api/errors/search
 * 搜索错误码 API
 */
router.get('/search', (req, res) => {
  const { q } = req.query;
  const results = explorer.search(q);
  res.json({ success: true, data: results });
});

/**
 * POST /docs/api/errors/diagnose
 * 智能诊断 API
 */
router.post('/diagnose', (req, res) => {
  const { errorCode, context } = req.body;
  const result = diagnostics.diagnose(errorCode, context);
  res.json({ success: true, data: result });
});

/**
 * POST /docs/api/errors/bug-report
 * 生成 Bug 报告
 */
router.post('/bug-report', (req, res) => {
  const { errorCode, context } = req.body;
  const report = diagnostics.generateBugReport(errorCode, context);
  res.json({ success: true, data: report });
});

module.exports = router;
```

## 5. 验收标准（可测试）

- [ ] 错误码查询页面支持按模块、关键词搜索
- [ ] 错误详情页显示多语言消息（中/英/日/韩）
- [ ] API 沙盒支持发送实际请求并显示响应
- [ ] 场景示例展示至少 3 种常见错误场景
- [ ] 智能诊断返回针对性的解决方案
- [ ] Bug 报告模板自动生成并支持复制
- [ ] 文档站点响应时间 < 500ms
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**M - 中等工作量**
- ErrorCodeExplorer 实现：2 小时
- ApiSandbox 实现：3 小时
- 场景示例数据整理：2 小时
- SmartDiagnostics 实现：2 小时
- 文档页面开发：3 小时
- 单元测试：2 小时

总计约 14 小时，需 2 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **开发者体验提升**：交互式文档大幅降低开发者对接成本，减少技术支持工单
2. **错误定位效率**：智能诊断可减少 50% 的错误排查时间
3. **API 文档完整性**：与已完成的 API 错误码标准化（REQ-00066）形成闭环
4. **竞品对标**：主流平台（Stripe、Twilio）均提供交互式 API 调试沙盒
5. **成熟度评分贡献**：完善"文档与开发者体验"维度

此需求是对现有 API 错误码体系的价值放大，让静态标准变成动态工具，是文档基础设施的重要升级。
