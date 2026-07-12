# REQ-00547：API 响应 Schema 强制执行与合约测试自动化系统

- **编号**：REQ-00547
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有后端服务、backend/shared/schemaValidator.js、backend/tests/contract、.github/workflows
- **创建时间**：2026-07-12 19:00 UTC
- **依赖需求**：REQ-00520（API 兼容性版本管理）、REQ-00315（API 响应 Schema 校验系统）

## 1. 背景与问题

当前 mineGo 项目已有 HATEOAS 资源发现系统（REQ-00518）、API 版本管理机制（REQ-00520），但在实际开发中仍存在以下问题：

1. **响应格式不一致**：不同服务返回的 JSON 结构风格各异，有的用 `data`，有的用 `result`，错误码格式不统一
2. **Schema 校验缺失**：缺乏强制性的响应 Schema 校验机制，API 变更时可能意外破坏下游依赖
3. **合约测试覆盖不足**：前后端合约测试依赖手工验证，缺少自动化回归
4. **文档与代码脱节**：API 文档描述与实际响应结构存在偏差，导致前端对接困难

这些问题会导致：
- 前端团队需要频繁适配不同的响应格式
- API 变更时无法及时发现破坏性变化
- 集成测试成本高，回归效率低

## 2. 目标

建立一套完整的 API 响应 Schema 强制执行与合约测试自动化系统：

- **Schema 定义标准化**：所有 API 响必须有对应的 JSON Schema 定义
- **强制校验机制**：在开发和测试阶段自动校验响应是否符合 Schema
- **合约测试自动化**：CI/CD 流程中自动执行合约测试，发现 Schema 违规立即阻断
- **差异报告系统**：自动检测 Schema 与实际响应的差异，生成修复建议

## 3. 范围

- **包含**：
  - Schema Registry 服务（集中存储和管理 API Schema）
  - 响应校验中间件（自动校验所有 API 响应）
  - 合约测试框架（自动生成测试用例，校验契约）
  - Schema 差异检测与报告生成
  - CI/CD 集成（GitHub Actions Workflow）
  - 管理后台 Schema 管理界面

- **不包含**：
  - 请求参数校验（已有 Middleware 处理）
  - API 文档生成（已有 OpenAPI 生成系统）
  - 前端 Mock 服务（REQ-00546 已覆盖）

## 4. 详细需求

### 4.1 Schema Registry

```javascript
// backend/shared/schemaRegistry/SchemaRegistry.js
class SchemaRegistry {
  // Schema 存储（PostgreSQL + Redis 缓存）
  async registerSchema(serviceName, route, version, schema);
  async getSchema(serviceName, route, version);
  async listSchemas(serviceName);
  async validateSchema(schema); // 校验 Schema 本身有效性
  
  // Schema 版本管理
  async getVersionHistory(serviceName, route);
  async diffVersions(serviceName, route, v1, v2);
}
```

### 4.2 Schema 定义规范

所有 API Schema 必须包含：
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Pokemon Catch Response",
  "type": "object",
  "required": ["success", "code", "data"],
  "properties": {
    "success": { "type": "boolean" },
    "code": { "type": "integer", "enum": [200, 400, 401, 403, 404, 500] },
    "message": { "type": "string" },
    "data": { "type": "object" },
    "_links": { "$ref": "#/definitions/HateoasLinks" },
    "_meta": { "$ref": "#/definitions/Metadata" }
  },
  "definitions": {
    "HateoasLinks": { ... },
    "Metadata": { ... }
  }
}
```

### 4.3 响应校验中间件

```javascript
// gateway/src/middleware/schemaValidation.js
function schemaValidationMiddleware(options) {
  return async (req, res, next) => {
    // 拦截 res.json，校验响应
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      const schema = await schemaRegistry.getSchema(
        req.serviceName,
        req.route,
        req.apiVersion
      );
      
      if (schema) {
        const result = await validateAgainstSchema(body, schema);
        if (!result.valid) {
          // 记录违规，不阻断生产环境，仅警告
          logger.warn('Schema validation failed', {
            route: req.route,
            errors: result.errors
          });
          
          // 非生产环境抛出错误
          if (process.env.NODE_ENV !== 'production') {
            return originalJson({
              success: false,
              code: 500,
              message: 'Schema validation failed',
              errors: result.errors,
              actualResponse: body
            });
          }
        }
      }
      
      return originalJson(body);
    };
    
    next();
  };
}
```

### 4.4 合约测试框架

```javascript
// backend/tests/contract/ContractTestRunner.js
class ContractTestRunner {
  // 从 Schema Registry 加载所有 Schema
  async loadContractSchemas();
  
  // 自动生成测试用例
  async generateTestCases(schema);
  
  // 执行合约测试
  async runContractTest(serviceName, route);
  
  // 执行所有合约测试
  async runAllContractTests();
  
  // 生成测试报告
  async generateReport();
}
```

### 4.5 Schema 差异检测

```javascript
// backend/shared/schemaRegistry/SchemaDiffDetector.js
class SchemaDiffDetector {
  // 比较 Schema 与实际响应
  async compareWithActualResponse(serviceName, route, actualResponse);
  
  // 生成差异报告
  async generateDiffReport();
  
  // 建议修复方案
  async suggestFixes(differences);
}
```

### 4.6 CI/CD 集成

```yaml
# .github/workflows/contract-test.yml
name: API Contract Tests
on:
  push:
    paths:
      - 'backend/**'
      - 'docs/schemas/**'
  pull_request:
    branches: [main]

jobs:
  contract-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Run Contract Tests
        run: npm run test:contract
      - name: Upload Report
        uses: actions/upload-artifact@v4
        with:
          name: contract-report
          path: reports/contract-test-report.json
```

## 5. 验收标准（可测试）

- [ ] 所有后端服务 API 响均有对应的 JSON Schema 定义
- [ ] Schema Registry 支持版本管理和历史查询
- [ ] 响应校验中间件在开发环境能自动拦截 Schema 违规
- [ ] 合约测试框架能自动生成并执行测试用例
- [ ] CI/CD 合约测试流程能阻断破坏性变更
- [ ] Schema 差异检测能识别 95% 以上的响应结构偏差
- [ ] 管理后台提供 Schema 管理界面（查看、编辑、版本对比）
- [ ] 单元测试覆盖 Schema Registry、校验中间件、合约测试框架

## 6. 工作量估算

**L（Large）**

理由：
- 涉及多个核心模块开发（Schema Registry、校验中间件、合约测试框架）
- 需要为现有 9 个微服务的 API 编写 Schema 定义
- CI/CD 集成和测试编写
- 预计工作量：3-5 个工作日

## 7. 优先级理由

**P1（高优先级）**

理由：
- API 响应一致性是前后端协作的基础，直接影响开发效率
- 合约测试自动化能显著降低回归测试成本
- 配合 REQ-00520（API 版本管理）形成完整的 API 治理体系
- 对"项目可用"有显著贡献：提升 API 稳定性、减少集成问题

## 8. 技术参考

- JSON Schema Draft-07 规范
- OpenAPI 3.0 Schema 定义
- Pact 合约测试框架设计理念
- REQ-00518 HATEOAS 资源发现系统
- REQ-00520 API 兼容性版本管理