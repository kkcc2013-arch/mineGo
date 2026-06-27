# REQ-00329：API 端点命名规范自动校验与文档同步系统

- **编号**：REQ-00329
- **类别**：API 设计规范
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/apiLinter.js、docs/api-spec、.github/workflows、scripts
- **创建时间**：2026-06-26 00:27 UTC
- **依赖需求**：REQ-00008（OpenAPI 文档与 API 设计规范统一）、REQ-00044（API 版本管理）

## 1. 背景与问题

mineGo 项目已有 9 个微服务，暴露了 200+ 个 API 端点，但存在以下 API 命名和文档维护问题：

### 1.1 命名规范不统一
- **路径命名混乱**：部分使用 kebab-case（`/user-profile`），部分使用 camelCase（`/getUserInfo`），部分使用 snake_case（`/catch_pokemon`）
- **HTTP 方法误用**：GET 请求修改数据、POST 请求获取资源等不符合 RESTful 规范的情况
- **资源命名不一致**：同一资源在不同服务中有不同命名（`/pokemons` vs `/pokemon-instances`）
- **复数/单数混用**：`/user` 和 `/users`、`/gym` 和 `/gyms` 同时存在

### 1.2 文档与代码不同步
- OpenAPI 文档手动维护，容易与实际代码脱节
- 新增/修改 API 后忘记更新文档
- 缺少 CI/CD 检查机制，文档过期难以发现
- API 注释缺失或不完整

### 1.3 规范执行困难
- 代码审查难以逐一检查所有 API 端点命名
- 缺少自动化工具辅助开发者遵守规范
- 新成员不了解项目 API 设计规范，容易引入不一致

## 2. 目标

构建 API 端点命名规范自动校验与文档同步系统：

1. **命名规范定义**：制定统一的 RESTful API 命名规范文档
2. **自动校验工具**：开发 API Linter 自动扫描代码并报告命名违规
3. **CI/CD 集成**：PR 检查中自动运行 API Linter，阻止不合规代码合并
4. **文档自动生成**：从代码注释和 JSDoc 自动生成 OpenAPI 文档
5. **文档同步验证**：CI 中验证 OpenAPI 文档与实际代码一致性

**预期收益：**
- API 命名一致性提升至 95%+
- 文档与代码同步率提升至 98%+
- 代码审查效率提升 20%
- 新成员上手时间减少 30%

## 3. 范围

### 包含
- API 命名规范文档（kebab-case、复数资源、RESTful 动词、版本前缀）
- API Linter 工具（扫描路由定义，检查命名规范）
- CI/CD 集成脚本（PR 检查、自动告警）
- OpenAPI 文档自动生成工具（从 JSDoc 注释提取）
- 文档同步验证脚本（对比文档 Schema 与实际路由）
- 开发者友好的错误提示和修复建议
- 管理后台 API 规范统计面板

### 不包含
- 数据库 Schema 命名规范（已有独立规范）
- gRPC API 规范（当前仅 REST API）
- GraphQL API 规范（未使用）
- 前端代码命名规范（已有 ESLint）

## 4. 详细需求

### 4.1 API 命名规范定义

```markdown
## mineGo API 命名规范

### 4.1.1 URL 路径规范
- 使用 kebab-case：`/user-profiles`、`/catch-sessions`
- 使用复数名词表示资源集合：`/users`、`/pokemons`
- 嵌套资源层级不超过 3 层：`/users/{id}/pokemons/{pokemonId}`
- 避免动词：`/users` 而非 `/getUsers`
- 版本前缀：`/api/v1/users`

### 4.1.2 HTTP 方法规范
- GET：获取资源（幂等、安全）
- POST：创建资源（非幂等）
- PUT：完整更新资源（幂等）
- PATCH：部分更新资源（幂等）
- DELETE：删除资源（幂等）

### 4.1.3 响应格式规范
- 成功：`{ success: true, data: {...} }`
- 错误：`{ success: false, error: { code, message } }`
- 分页：`{ data: [...], pagination: { total, limit, offset } }`

### 4.1.4 状态码规范
- 200：成功
- 201：创建成功
- 400：请求参数错误
- 401：未认证
- 403：无权限
- 404：资源不存在
- 409：冲突
- 429：请求过于频繁
- 500：服务器错误
```

### 4.2 API Linter 工具实现

```javascript
// backend/shared/apiLinter.js

const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

/**
 * API Linter - 扫描路由定义并检查命名规范
 */
class ApiLinter {
  constructor(config = {}) {
    this.rules = {
      pathNaming: 'kebab-case',        // kebab-case | camelCase | snake_case
      resourceNaming: 'plural',         // plural | singular
      httpMethodUsage: true,            // 检查 HTTP 方法是否符合 RESTful
      versionPrefix: true,              // 检查版本前缀
      maxNestingLevel: 3,               // 最大嵌套层级
    };
    this.errors = [];
    this.warnings = [];
  }

  /**
   * 扫描服务目录下的所有路由文件
   */
  async scanService(servicePath) {
    const routesPath = path.join(servicePath, 'src/routes');
    if (!fs.existsSync(routesPath)) return;

    const files = fs.readdirSync(routesPath).filter(f => f.endsWith('.js'));
    
    for (const file of files) {
      await this.scanFile(path.join(routesPath, file));
    }
  }

  /**
   * 扫描单个路由文件
   */
  async scanFile(filePath) {
    const code = fs.readFileSync(filePath, 'utf-8');
    const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });

    traverse(ast, {
      CallExpression: (path) => {
        const { callee, arguments: args } = path.node;
        
        // 检查 router.get/post/put/delete 调用
        if (this.isRouterMethod(callee)) {
          const method = callee.property.name.toUpperCase();
          const routePath = this.extractRoutePath(args[0]);
          
          if (routePath) {
            this.checkRouteNaming(routePath, filePath, method);
            this.checkHttpMethodUsage(method, routePath, filePath);
          }
        }
      }
    });
  }

  /**
   * 检查路径命名规范
   */
  checkRouteNaming(routePath, filePath, method) {
    // 规则 1: kebab-case
    if (this.rules.pathNaming === 'kebab-case') {
      if (/[A-Z_]/.test(routePath) && !routePath.includes('{')) {
        this.errors.push({
          file: filePath,
          route: routePath,
          method,
          rule: 'path-naming',
          message: `路径应使用 kebab-case: ${routePath}`,
          suggestion: this.toKebabCase(routePath)
        });
      }
    }

    // 规则 2: 复数资源
    if (this.rules.resourceNaming === 'plural') {
      const segments = routePath.split('/').filter(s => s && !s.startsWith('{'));
      for (const seg of segments) {
        if (!this.isPlural(seg)) {
          this.warnings.push({
            file: filePath,
            route: routePath,
            method,
            rule: 'resource-plural',
            message: `资源命名建议使用复数: ${seg}`,
            suggestion: `${seg}s`
          });
        }
      }
    }

    // 规则 3: 版本前缀
    if (this.rules.versionPrefix && !routePath.startsWith('/api/v')) {
      this.warnings.push({
        file: filePath,
        route: routePath,
        method,
        rule: 'version-prefix',
        message: `建议添加版本前缀: /api/v1${routePath}`
      });
    }

    // 规则 4: 嵌套层级
    const nestingLevel = routePath.split('/').filter(s => s && !s.startsWith('{')).length;
    if (nestingLevel > this.rules.maxNestingLevel) {
      this.warnings.push({
        file: filePath,
        route: routePath,
        method,
        rule: 'max-nesting',
        message: `嵌套层级超过 ${this.rules.maxNestingLevel} 层，建议重构`
      });
    }
  }

  /**
   * 检查 HTTP 方法使用是否符合 RESTful
   */
  checkHttpMethodUsage(method, routePath, filePath) {
    if (!this.rules.httpMethodUsage) return;

    // 检查 GET 请求是否包含修改语义
    const modifyKeywords = ['create', 'update', 'delete', 'remove', 'add'];
    if (method === 'GET') {
      for (const keyword of modifyKeywords) {
        if (routePath.toLowerCase().includes(keyword)) {
          this.warnings.push({
            file: filePath,
            route: routePath,
            method,
            rule: 'http-method-usage',
            message: `GET 请求不应包含修改操作关键词 "${keyword}"，建议使用 POST/PUT/DELETE`
          });
        }
      }
    }

    // 检查 POST 请求是否用于获取资源
    const fetchKeywords = ['get', 'fetch', 'list', 'search', 'query'];
    if (method === 'POST') {
      for (const keyword of fetchKeywords) {
        if (routePath.toLowerCase().includes(keyword)) {
          this.warnings.push({
            file: filePath,
            route: routePath,
            method,
            rule: 'http-method-usage',
            message: `POST 请求用于获取资源 "${keyword}"，建议使用 GET`
          });
        }
      }
    }
  }

  /**
   * 生成报告
   */
  generateReport() {
    return {
      summary: {
        totalErrors: this.errors.length,
        totalWarnings: this.warnings.length,
        scannedFiles: this.scannedFiles
      },
      errors: this.errors,
      warnings: this.warnings
    };
  }

  // 辅助方法
  isRouterMethod(callee) {
    return callee.type === 'MemberExpression' &&
           callee.object.name === 'router' &&
           ['get', 'post', 'put', 'patch', 'delete'].includes(callee.property.name);
  }

  extractRoutePath(node) {
    if (node.type === 'StringLiteral') return node.value;
    return null;
  }

  toKebabCase(str) {
    return str.replace(/([a-z])([A-Z])/g, '$1-$2')
              .replace(/_/g, '-')
              .toLowerCase();
  }

  isPlural(word) {
    return word.endsWith('s') || 
           word.endsWith('data') || 
           word.endsWith('info') ||
           word.endsWith('status');
  }
}

module.exports = ApiLinter;
```

### 4.3 CI/CD 集成

```yaml
# .github/workflows/api-lint.yml
name: API Lint Check

on:
  pull_request:
    paths:
      - 'backend/services/**/routes/**/*.js'
      - 'backend/gateway/**/*.js'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run API Linter
        run: node scripts/api-lint.js
      
      - name: Upload Report
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: api-lint-report
          path: api-lint-report.json
      
      - name: Comment on PR
        if: failure()
        uses: actions/github-script@v6
        with:
          script: |
            const report = require('./api-lint-report.json');
            const body = `## API Lint Report
            
            ❌ **${report.summary.totalErrors}** errors  
            ⚠️ **${report.summary.totalWarnings}** warnings
            
            <details>
            <summary>View Details</summary>
            
            ${report.errors.map(e => `- **${e.file}**: ${e.message}`).join('\n')}
            </details>`;
            
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body
            });
```

### 4.4 OpenAPI 文档自动生成

```javascript
// scripts/generate-openapi.js

const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const doctrine = require('doctrine');

/**
 * 从代码注释自动生成 OpenAPI 文档
 */
class OpenApiGenerator {
  constructor() {
    this.spec = {
      openapi: '3.0.0',
      info: {
        title: 'mineGo API',
        version: '1.0.0',
        description: 'mineGo AR Pokémon Game API'
      },
      paths: {}
    };
  }

  /**
   * 扫描服务并生成文档
   */
  async generateFromServices(servicesPath) {
    const services = fs.readdirSync(servicesPath);
    
    for (const service of services) {
      const routesPath = path.join(servicesPath, service, 'src/routes');
      if (!fs.existsSync(routesPath)) continue;

      const files = fs.readdirSync(routesPath).filter(f => f.endsWith('.js'));
      for (const file of files) {
        await this.processFile(path.join(routesPath, file));
      }
    }

    return this.spec;
  }

  /**
   * 处理单个路由文件
   */
  async processFile(filePath) {
    const code = fs.readFileSync(filePath, 'utf-8');
    const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });

    traverse(ast, {
      CallExpression: (path) => {
        const { callee, arguments: args } = path.node;
        
        if (this.isRouterMethod(callee)) {
          const method = callee.property.name.toLowerCase();
          const routePath = this.extractRoutePath(args[0]);
          const leadingComments = path.node.leadingComments;

          if (routePath && leadingComments) {
            const doc = this.parseJSDoc(leadingComments[0].value);
            this.addPath(method, routePath, doc);
          }
        }
      }
    });
  }

  /**
   * 解析 JSDoc 注释
   */
  parseJSDoc(comment) {
    const parsed = doctrine.parse(comment, { unwrap: true });
    
    return {
      description: parsed.description,
      params: parsed.tags.filter(t => t.title === 'param').map(p => ({
        name: p.name,
        type: p.type.name,
        description: p.description
      })),
      returns: parsed.tags.find(t => t.title === 'returns'),
      examples: parsed.tags.filter(t => t.title === 'example')
    };
  }

  /**
   * 添加到 OpenAPI 规范
   */
  addPath(method, routePath, doc) {
    if (!this.spec.paths[routePath]) {
      this.spec.paths[routePath] = {};
    }

    this.spec.paths[routePath][method] = {
      summary: doc.description || `${method.toUpperCase()} ${routePath}`,
      description: doc.description,
      parameters: doc.params.map(p => ({
        name: p.name,
        in: 'path',
        required: true,
        schema: { type: p.type },
        description: p.description
      })),
      responses: {
        '200': {
          description: doc.returns?.description || 'Success',
          content: {
            'application/json': {
              schema: { type: 'object' }
            }
          }
        }
      }
    };
  }
}

module.exports = OpenApiGenerator;
```

## 5. 验收标准（可测试）

- [ ] API Linter 工具完成，能扫描所有 9 个微服务的路由文件
- [ ] Linter 能检测 kebab-case、复数资源、版本前缀、HTTP 方法误用等违规
- [ ] CI/CD 集成完成，PR 中自动运行 Linter 检查
- [ ] Linter 报告格式清晰，包含文件路径、行号、违规描述、修复建议
- [ ] OpenAPI 文档自动生成工具完成，从 JSDoc 注释提取 API 信息
- [ ] 文档同步验证脚本完成，能检测文档与代码不一致
- [ ] 所有现有 API 端点通过 Linter 检查（警告可接受，错误需修复）
- [ ] API 命名规范文档完成，包含示例和最佳实践
- [ ] 管理后台展示 API 规范统计（总数、违规数、修复率）

## 6. 工作量估算

**M (Medium)**

**理由**：
- Linter 工具开发需要解析 AST，复杂度中等
- CI/CD 集成相对简单
- 文档自动生成需要处理 JSDoc 解析
- 现有代码可能存在大量违规需要修复
- 预计 3-5 个工作日完成

## 7. 优先级理由

**P2 理由**：

1. **长期价值**：API 命名一致性影响代码可维护性和团队协作效率，是重要的技术债清理
2. **非阻塞**：当前系统功能正常，此需求不阻塞核心业务
3. **前置条件已满足**：REQ-00008（OpenAPI 文档）和 REQ-00044（API 版本管理）已完成
4. **投资回报**：一次性投入，长期收益明显（减少代码审查时间、降低维护成本）
5. **时机合适**：项目成熟度已达 90/100，适合在 P0/P1 需求完成后进行规范化提升

**对"项目可用"的贡献**：
- 提升代码质量和可维护性
- 降低新成员上手成本
- 减少前后端协作摩擦
- 为 API 长期演进打下基础
