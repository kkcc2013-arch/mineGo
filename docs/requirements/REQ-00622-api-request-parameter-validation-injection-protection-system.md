# REQ-00622：API 请求参数统一验证与注入防护中间件系统

- **编号**：REQ-00622
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway/middleware/validation, backend/shared/validators, 所有后端服务路由层
- **创建时间**：2026-07-20 22:00
- **依赖需求**：无

## 1. 背景与问题

### 当前问题

mineGo 项目目前已实现 `schemaValidator.js` 用于 OpenAPI Schema 验证，但存在以下问题：

1. **缺乏统一参数验证中间件**：各路由分散处理参数校验，代码重复且不一致
2. **注入防护缺失**：缺少针对 SQL 注入、XSS、NoSQL 注入等攻击的统一防护层
3. **验证规则分散**：参数类型检查、格式验证、范围限制等逻辑散落在各处
4. **错误响应不统一**：参数验证失败时返回格式各异，影响前端错误处理
5. **性能问题**：每次请求都进行完整的 Schema 编译，缺少验证器缓存复用

### 实际影响

- **安全隐患**：2026-07-08 审计发现 3 处潜在的 SQL 注入风险点
- **开发效率低**：每个新路由都需要手动实现参数校验，平均耗时 2 小时
- **维护成本高**：验证逻辑变更需要修改多个文件，易遗漏

## 2. 目标

构建一个统一的 API 请求参数验证与注入防护中间件系统，实现：

1. **统一的验证接口**：一套声明式的参数验证规则定义方式
2. **多层注入防护**：自动检测并阻断 SQL 注入、XSS、NoSQL 注入等攻击
3. **高性能缓存**：编译后的验证器缓存复用，性能损耗 < 5ms
4. **友好的错误提示**：支持多语言的参数验证错误消息
5. **零侵入接入**：现有路由只需添加一行中间件即可启用

## 3. 范围

### 包含

- 参数验证中间件核心模块（`backend/shared/requestValidator.js`）
- 注入防护检测引擎（`backend/shared/injectionDetector.js`）
- 常用验证规则库（类型、格式、范围、自定义规则）
- 验证规则配置 DSL
- 错误响应标准化
- 单元测试和集成测试
- 使用文档和示例

### 不包含

- OpenAPI Schema 验证器的重构（已有独立模块）
- 前端表单验证（属于前端范围）
- 数据库级别的注入防护（属于数据库安全范围）

## 4. 详细需求

### 4.1 参数验证中间件（`requestValidator.js`）

#### 功能特性

```javascript
// 使用示例
const { validateRequest } = require('@pmg/shared/requestValidator');

// 定义验证规则
router.post('/pokemon/catch',
  validateRequest({
    body: {
      pokemonId: { type: 'string', required: true, pattern: /^[a-f0-9]{24}$/ },
      latitude: { type: 'number', required: true, min: -90, max: 90 },
      longitude: { type: 'number', required: true, min: -180, max: 180 },
      ballType: { type: 'string', enum: ['poke', 'great', 'ultra', 'master'], required: true },
      items: { type: 'array', items: { type: 'string' }, maxItems: 10 }
    },
    headers: {
      'x-device-id': { type: 'string', required: true, minLength: 16, maxLength: 64 }
    }
  }),
  catchController.execute
);
```

#### 验证规则类型

- **基础类型**：`string`, `number`, `integer`, `boolean`, `array`, `object`, `date`
- **格式验证**：`email`, `url`, `uuid`, `objectId`, `phone`, `ip`, `lat`, `lng`
- **范围限制**：`min`, `max`, `minLength`, `maxLength`, `minItems`, `maxItems`
- **枚举值**：`enum` 数组
- **正则模式**：`pattern` 正则表达式
- **自定义验证**：`validate` 函数

### 4.2 注入防护检测引擎（`injectionDetector.js`）

#### 检测类型

1. **SQL 注入**：
   - 单引号闭合检测
   - UNION SELECT 注入
   - OR/AND 逻辑注入
   - 注释符号注入（`--`, `/**/`）
   - 存储过程调用检测

2. **NoSQL 注入**：
   - MongoDB 操作符注入（`$where`, `$regex`, `$gt`, `$ne`）
   - JavaScript 表达式注入

3. **XSS 攻击**：
   - `<script>` 标签检测
   - 事件处理器注入（`onclick`, `onerror`）
   - JavaScript 协议注入（`javascript:`）
   - HTML 实体编码绕过

4. **路径遍历**：
   - `../` 序列检测
   - 绝对路径注入

5. **命令注入**：
   - 管道符检测（`|`, `;`, `&`）
   - Shell 命令关键字检测

#### 防护策略

```javascript
// 配置示例
const detector = new InjectionDetector({
  enabledAttacks: ['sql', 'nosql', 'xss', 'pathTraversal', 'commandInjection'],
  strictness: 'high', // 'low' | 'medium' | 'high'
  customPatterns: [
    /custom-attack-pattern/i
  ],
  whiteList: {
    'body.description': true, // 允许富文本字段
  }
});
```

### 4.3 验证规则配置 DSL

支持两种配置方式：

#### 方式 1：对象配置

```javascript
{
  body: {
    username: {
      type: 'string',
      required: true,
      minLength: 3,
      maxLength: 20,
      pattern: /^[a-zA-Z0-9_]+$/,
      sanitize: true, // 自动清理危险字符
      transform: (value) => value.toLowerCase()
    }
  }
}
```

#### 方式 2：链式 API

```javascript
const { body, header, query } = require('@pmg/shared/requestValidator');

validateRequest({
  body: body()
    .field('email').isEmail().required()
    .field('age').isInt({ min: 1, max: 120 }).optional()
    .field('tags').isArray({ maxItems: 10 }).optional(),
  
  query: query()
    .field('page').isInt({ min: 1 }).default(1)
    .field('limit').isInt({ min: 1, max: 100 }).default(20)
});
```

### 4.4 错误响应标准化

#### 验证失败响应格式

```json
{
  "success": false,
  "error": {
    "code": 400001,
    "name": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "body.latitude",
        "code": "INVALID_RANGE",
        "message": "Value must be between -90 and 90",
        "received": 95.5,
        "i18nKey": "validation.latitude.range"
      },
      {
        "field": "body.items[3]",
        "code": "INVALID_TYPE",
        "message": "Expected string, received number",
        "expected": "string",
        "received": "number"
      }
    ]
  },
  "meta": {
    "requestId": "req-abc123",
    "timestamp": "2026-07-20T22:00:00Z"
  }
}
```

#### 支持的错误码

| 错误码 | 名称 | 说明 |
|--------|------|------|
| 400001 | VALIDATION_ERROR | 参数验证失败 |
| 400002 | REQUIRED_FIELD_MISSING | 必填字段缺失 |
| 400003 | INVALID_TYPE | 类型错误 |
| 400004 | INVALID_FORMAT | 格式错误 |
| 400005 | INVALID_RANGE | 超出范围 |
| 400006 | INJECTION_DETECTED | 检测到注入攻击 |
| 400007 | ARRAY_LIMIT_EXCEEDED | 数组长度超限 |

### 4.5 性能要求

- 单次验证耗时 < 5ms（P95）
- 验证器缓存命中率 > 95%
- 内存占用增量 < 10MB
- 支持 10,000+ 并发验证

### 4.6 集成方式

#### 自动注入防护

```javascript
// 全局启用注入防护
app.use(injectionProtectionMiddleware({
  enableLogging: true,
  logLevel: 'warn',
  blockLevel: 'high' // 高危攻击直接阻断
}));
```

#### 路由级验证

```javascript
// 单个路由启用验证
router.post('/api/v2/pokemon/catch',
  validateRequest({
    body: { /* 规则 */ }
  }),
  controller
);

// 批量路由验证
applyValidationToRoutes(router, validationRulesMap);
```

## 5. 验收标准（可测试）

- [ ] 支持至少 15 种参数类型验证（string, number, integer, boolean, array, object, date, email, url, uuid, objectId, phone, ip, lat, lng）
- [ ] 能检测至少 5 种注入攻击类型（SQL, NoSQL, XSS, Path Traversal, Command Injection）
- [ ] 注入检测准确率 ≥ 99.5%，误报率 < 0.1%
- [ ] 单次验证性能 < 5ms（P95），支持验证器缓存
- [ ] 提供至少 20 个常用验证规则（required, type, format, enum, pattern, min, max, minLength, maxLength, minItems, maxItems, email, url, uuid, objectId, phone, ip, lat, lng, custom）
- [ ] 错误响应格式符合 `api-guidelines.md` 标准，支持 i18n
- [ ] 单元测试覆盖率 ≥ 85%，集成测试覆盖主要攻击向量
- [ ] 提供完整使用文档和至少 5 个示例代码
- [ ] 零破坏性变更：现有路由可选择性启用，不影响现有功能
- [ ] 在 `gateway` 和至少 2 个微服务中集成验证

## 6. 工作量估算

**L**（Large）

- 预计开发时间：3-4 天
- 核心模块开发：1.5 天
- 注入防护引擎：1 天
- 测试和文档：1 天
- 集成和优化：0.5 天

## 7. 优先级理由

**P1（高优先级）**

1. **安全关键**：注入攻击是 Web 应用最常见的安全威胁，统一防护层是基础安全设施
2. **影响广泛**：所有 API 路由都受益，提升整体代码质量和安全性
3. **技术债积累**：当前分散的验证逻辑导致维护成本持续增长
4. **生产就绪**：项目已有 600+ 需求，需要完善的安全基础设施支撑生产部署

## 8. 技术方案

### 8.1 核心模块架构

```
backend/shared/
├── requestValidator.js          # 主验证中间件
├── injectionDetector.js         # 注入检测引擎
├── validators/
│   ├── index.js                 # 验证器注册表
│   ├── string.js                # 字符串验证器
│   ├── number.js                # 数字验证器
│   ├── array.js                 # 数组验证器
│   ├── object.js                # 对象验证器
│   ├── format.js                # 格式验证器（email, url, uuid 等）
│   └── custom.js                # 自定义验证器
├── sanitizers/
│   ├── index.js                 # 清理器注册表
│   ├── html.js                  # HTML 清理
│   ├── sql.js                   # SQL 转义
│   └── nosql.js                 # NoSQL 转义
└── validationCache.js           # 验证器缓存
```

### 8.2 注入检测算法

```javascript
class InjectionDetector {
  constructor() {
    this.patterns = {
      sql: [
        /(\bunion\b.*\bselect\b)/i,
        /(\binsert\b.*\binto\b)/i,
        /(\bdelete\b.*\bfrom\b)/i,
        /(\bdrop\b.*\btable\b)/i,
        /(\'|\")\s*(\bor\b|\band\b)\s*(\'|\")/i,
        /(--|#|\/\*|\*\/)/,
        /(\bexec\b|\bexecute\b)/i
      ],
      nosql: [
        /\$where/,
        /\$regex/,
        /\$gt/,
        /\$lt/,
        /\$ne/,
        /\$or/
      ],
      xss: [
        /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
        /javascript:/gi,
        /on\w+\s*=/gi,
        /<iframe/gi,
        /<object/gi,
        /<embed/gi
      ]
    };
  }
  
  detect(value, type = 'all') {
    // 检测逻辑
  }
}
```

### 8.3 性能优化策略

1. **编译缓存**：首次编译验证规则后缓存，后续直接复用
2. **惰性验证**：可选字段未提供时跳过验证
3. **短路评估**：发现错误立即返回，不继续验证后续规则
4. **批量验证**：对数组元素批量验证，减少函数调用开销

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 性能损耗 | 中 | 使用缓存、惰性验证、性能测试 |
| 误报阻断正常请求 | 高 | 提供白名单机制、可配置严格度 |
| 破坏现有功能 | 中 | 零侵入设计、渐进式迁移、充分测试 |
| 规则配置复杂 | 低 | 提供链式 API、丰富示例、文档 |

## 10. 相关文档

- [API 响应格式标准化规范](/docs/api-guidelines.md)
- [OpenAPI Schema 验证器](/backend/shared/schemaValidator.js)
- [统一错误处理](/backend/shared/errorHandler.js)
- [OWASP Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Injection_Prevention_Cheat_Sheet.html)

---

**创建人**：mineGo 自动化开发循环
**审核人**：待定
**最后更新**：2026-07-20 22:00 UTC
