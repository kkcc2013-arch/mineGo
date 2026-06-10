# REQ-00080：API 请求响应 Schema 验证系统

- **编号**：REQ-00080
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、backend/shared、所有微服务、docs/api-spec/openapi
- **创建时间**：2026-06-10 05:00
- **依赖需求**：REQ-00008, REQ-00044

## 1. 背景与问题

mineGo 项目已建立 API 设计规范（REQ-00008）和版本管理机制（REQ-00044），但在实际开发中存在以下问题：

1. **请求参数校验分散**：各服务独立实现参数校验，代码重复且标准不一致
2. **响应格式无强制约束**：部分 API 响应不符合统一格式规范，前端需要额外适配
3. **OpenAPI Schema 与代码不同步**：文档更新滞后，Schema 定义与实际实现存在偏差
4. **开发阶段问题难以发现**：API 不一致问题往往到集成测试或生产环境才暴露
5. **缺少自动化验证**：没有机制自动检测 API 是否符合设计规范

这些问题导致：
- 前后端联调成本高
- API 文档可信度下降
- 代码审查负担重
- 生产环境 API 异常风险增加

## 2. 目标

构建完整的 API 请求响应 Schema 验证系统，实现：

1. **请求自动校验**：基于 OpenAPI Schema 自动验证请求参数，拒绝非法请求
2. **响应自动校验**：开发/测试环境自动验证响应格式，捕获不一致问题
3. **Schema 即文档**：从代码注解自动生成/更新 OpenAPI Schema，保持同步
4. **实时监控告警**：API 不符合规范时自动告警，快速定位问题
5. **开发体验优化**：提供友好的错误提示，加速开发调试

预期收益：
- API 不一致问题减少 90%+
- 前后端联调时间减少 50%+
- API 文档准确率提升至 99%+
- 代码审查效率提升 30%+

## 3. 范围

- **包含**：
  - OpenAPI Schema 加载与解析模块
  - 请求参数校验中间件（path/query/header/body）
  - 响应格式校验中间件（开发/测试环境）
  - Schema 与代码一致性检测工具
  - API 验证错误友好提示
  - Prometheus 验证指标
  - 单元测试覆盖

- **不包含**：
  - OpenAPI 文档生成（已有 REQ-00008）
  - API 版本管理（已有 REQ-00044）
  - API Mock 服务器（后续需求）
  - 前端 TypeScript 类型生成（后续需求）

## 4. 详细需求

### 4.1 Schema 加载与解析模块

```javascript
// backend/shared/schemaValidator.js

class SchemaValidator {
  constructor(options) {
    this.openapiDocs = new Map();  // version -> OpenAPI document
    this.validators = new Map();   // operationId -> Ajv validator
    this.cacheEnabled = options.cacheEnabled ?? true;
  }

  // 加载 OpenAPI 文档
  async loadSchema(version, schemaPath) {
    const doc = await this.parseOpenAPI(schemaPath);
    this.openapiDocs.set(version, doc);
    await this.compileValidators(doc);
  }

  // 编译 JSON Schema 验证器
  async compileValidators(doc) {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const operationId = operation.operationId;
        
        // 请求验证器
        this.validators.set(`${operationId}:request`, {
          params: this.compileParamsSchema(operation.parameters),
          query: this.compileQuerySchema(operation.parameters),
          headers: this.compileHeadersSchema(operation.parameters),
          body: this.compileBodySchema(operation.requestBody),
        });
        
        // 响应验证器
        this.validators.set(`${operationId}:response`, {
          '200': this.compileResponseSchema(operation.responses['200']),
          '400': this.compileResponseSchema(operation.responses['400']),
          // ... 其他状态码
        });
      }
    }
  }
}
```

### 4.2 请求校验中间件

```javascript
// backend/shared/middleware/requestValidator.js

function requestValidatorMiddleware(options = {}) {
  const validator = new SchemaValidator(options);
  
  return async (req, res, next) => {
    const operationId = req.openapi?.operationId;
    if (!operationId) return next();
    
    const schema = validator.validators.get(`${operationId}:request`);
    if (!schema) return next();
    
    const errors = [];
    
    // 1. Path 参数校验
    if (schema.params) {
      const valid = schema.params(req.params);
      if (!valid) errors.push({ location: 'path', errors: schema.params.errors });
    }
    
    // 2. Query 参数校验
    if (schema.query) {
      const valid = schema.query(req.query);
      if (!valid) errors.push({ location: 'query', errors: schema.query.errors });
    }
    
    // 3. Header 校验
    if (schema.headers) {
      const valid = schema.headers(req.headers);
      if (!valid) errors.push({ location: 'headers', errors: schema.headers.errors });
    }
    
    // 4. Body 校验
    if (schema.body && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const valid = schema.body(req.body);
      if (!valid) errors.push({ location: 'body', errors: schema.body.errors });
    }
    
    if (errors.length > 0) {
      metrics.apiValidationErrors.inc({ operationId, type: 'request' });
      return res.status(400).json({
        code: 1001,
        message: '请求参数不符合规范',
        data: { validationErrors: errors },
        traceId: req.headers['x-trace-id'],
      });
    }
    
    next();
  };
}
```

### 4.3 响应校验中间件

```javascript
// backend/shared/middleware/responseValidator.js

function responseValidatorMiddleware(options = {}) {
  const validator = new SchemaValidator(options);
  const enabledEnvironments = ['development', 'test'];
  
  return (req, res, next) => {
    if (!enabledEnvironments.includes(process.env.NODE_ENV)) {
      return next();
    }
    
    const operationId = req.openapi?.operationId;
    if (!operationId) return next();
    
    // 拦截 res.json
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      const schema = validator.validators.get(`${operationId}:response`);
      const statusSchema = schema?.[res.statusCode.toString()];
      
      if (statusSchema) {
        const valid = statusSchema(data);
        if (!valid) {
          const error = {
            operationId,
            statusCode: res.statusCode,
            errors: statusSchema.errors,
            actual: data,
            traceId: req.headers['x-trace-id'],
          };
          
          logger.warn('API 响应不符合 Schema', error);
          metrics.apiValidationErrors.inc({ operationId, type: 'response' });
          
          // 开发环境抛出错误，测试环境仅记录
          if (process.env.NODE_ENV === 'development') {
            console.error('❌ API 响应验证失败:', JSON.stringify(error, null, 2));
          }
        }
      }
      
      return originalJson(data);
    };
    
    next();
  };
}
```

### 4.4 Schema 一致性检测工具

```javascript
// scripts/schema-consistency-check.js

async function checkSchemaConsistency() {
  const issues = [];
  
  // 1. 加载所有 OpenAPI Schema
  const schemas = await loadAllSchemas();
  
  // 2. 遍历所有路由
  const routes = await extractRoutesFromCode();
  
  for (const route of routes) {
    const schema = findSchemaForRoute(schemas, route);
    
    if (!schema) {
      issues.push({
        type: 'missing_schema',
        route: route.path,
        method: route.method,
        message: `路由 ${route.method} ${route.path} 缺少 OpenAPI Schema 定义`,
      });
      continue;
    }
    
    // 3. 检查参数是否匹配
    const paramDiff = compareParameters(schema, route);
    if (paramDiff.length > 0) {
      issues.push({
        type: 'param_mismatch',
        route: route.path,
        method: route.method,
        differences: paramDiff,
      });
    }
    
    // 4. 检查响应是否匹配
    const responseDiff = compareResponses(schema, route);
    if (responseDiff.length > 0) {
      issues.push({
        type: 'response_mismatch',
        route: route.path,
        method: route.method,
        differences: responseDiff,
      });
    }
  }
  
  return issues;
}
```

### 4.5 Prometheus 指标

```javascript
// backend/shared/metrics.js 新增指标

const apiValidationErrors = new Counter({
  name: 'minego_api_validation_errors_total',
  help: 'API 验证错误总数',
  labelNames: ['operationId', 'type'], // type: request | response
});

const apiValidationDuration = new Histogram({
  name: 'minego_api_validation_duration_seconds',
  help: 'API 验证耗时',
  labelNames: ['operationId', 'type'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
});

const schemaLoadErrors = new Counter({
  name: 'minego_schema_load_errors_total',
  help: 'Schema 加载错误总数',
  labelNames: ['version', 'error'],
});
```

### 4.6 错误提示优化

```javascript
// backend/shared/schemaErrorFormatter.js

function formatValidationErrors(errors) {
  return errors.map(error => {
    const path = error.instancePath || error.dataPath || '';
    const message = error.message;
    const params = error.params || {};
    
    // 友好错误提示
    const friendlyMessages = {
      'required': `缺少必填字段: ${params.missingProperty}`,
      'type': `字段类型错误: 期望 ${params.type}, 实际 ${typeof error.data}`,
      'minimum': `数值过小: 最小值为 ${params.minimum}`,
      'maximum': `数值过大: 最大值为 ${params.maximum}`,
      'minLength': `字符串过短: 最小长度 ${params.limit}`,
      'maxLength': `字符串过长: 最大长度 ${params.limit}`,
      'pattern': `格式不正确: 应匹配 ${params.pattern}`,
      'enum': `值不在允许范围内: 允许值 [${params.allowedValues.join(', ')}]`,
      'additionalProperties': `不允许的字段: ${params.additionalProperty}`,
    };
    
    return {
      path,
      message: friendlyMessages[error.keyword] || message,
      keyword: error.keyword,
      params,
    };
  });
}
```

### 4.7 API 端点

```javascript
// backend/gateway/src/routes/schemaValidation.js

// GET /admin/schema/status - Schema 加载状态
// GET /admin/schema/operations - 所有已定义的 operationId
// POST /admin/schema/reload - 重新加载 Schema
// GET /admin/schema/consistency - 一致性检测结果
// GET /admin/schema/errors - 最近验证错误统计
```

## 5. 验收标准（可测试）

- [ ] 所有 OpenAPI Schema 正确加载并编译为验证器
- [ ] 请求参数不符合 Schema 时返回 400 错误，包含详细错误信息
- [ ] 响应格式不符合 Schema 时在开发环境输出警告日志
- [ ] Schema 一致性检测工具能发现 Schema 与代码不一致问题
- [ ] Prometheus 指标正确记录验证错误和耗时
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] 验证中间件对请求延迟影响 < 5ms
- [ ] 错误提示信息友好、可读、包含修复建议

## 6. 工作量估算

**L (Large)**

理由：
- 需要实现 Schema 加载、编译、验证核心逻辑
- 需要开发请求/响应校验中间件
- 需要开发一致性检测工具
- 需要集成到所有微服务
- 需要编写大量单元测试

预计工时：3-4 人天

## 7. 优先级理由

**P1 理由**：

1. **API 质量保障**：API 是前后端交互的唯一接口，质量直接影响用户体验
2. **开发效率提升**：自动验证减少手动校验代码，加速开发迭代
3. **问题前置发现**：开发阶段发现问题，避免生产环境故障
4. **文档可信度**：Schema 即文档，确保文档与代码同步
5. **依赖关系**：为后续 API Mock、前端类型生成等功能奠定基础

对"项目可用"的贡献：显著提升 API 稳定性和开发效率，是生产级 API 的必要保障。
