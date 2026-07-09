# REQ-00520: 后端服务 API 兼容性版本管理与自动化测试系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00520 |
| 标题 | 后端服务 API 兼容性版本管理与自动化测试系统 |
| 类别 | 运维/CICD |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有后端服务、backend/shared/apiVersionManager.js、backend/tests |
| 创建时间 | 2026-07-09 02:00 UTC |
| 依赖需求 | REQ-00008（OpenAPI 文档与 API 标准化） |

## 1. 背景与问题

mineGo 项目已有 9 个微服务（gateway/user/location/pokemon/catch/gym/social/reward/payment），随着需求持续演进（已超过 500+ 需求），API 接口频繁变更：

**当前痛点：**
1. **兼容性风险高**：API 变更（字段新增/删除/重命名）缺乏系统性兼容性测试，容易破坏前端 game-client 或第三方集成
2. **版本管理混乱**：虽然有 API 版本中间价（`apiVersion.js`），但缺乏自动化的兼容性版本检测和迁移路径管理
3. **测试覆盖不足**：现有测试主要覆盖业务逻辑，缺乏 API 契约测试（Contract Testing）和破坏性变更检测
4. **发布风险高**：微服务独立部署时，服务间 API 兼容性依赖人工验证，容易遗漏

**具体问题：**
- 2026-07-08 的 REQ-00511（WebSocket 连接池系统）实现中，对 `gateway/src/index.js` 的 API 接口调整可能影响 game-client
- STATUS.md 中多个需求涉及“所有后端服务”的 API 调整，但缺乏自动化兼容性验证机制
- 存在 `backend/gateway/src/middleware/apiVersion.js`，但仅用于请求头版本识别，未实现版本兼容性检查

## 2. 目标

建立一套完整的 API 兼容性版本管理与自动化测试系统，确保：
1. **破坏性变更检测**：自动识别 API 变更中的破坏性修改（字段删除、类型变更、必填字段新增等）
2. **契约测试覆盖**：为所有 9 个微服务的对外 API 建立契约测试，确保服务间调用兼容
3. **版本迁移路径**：提供 API 版本迁移文档和自动化测试工具，降低升级成本
4. **CI/CD 集成**：在每次 PR 合并前自动运行兼容性测试，阻止破坏性变更发布

**可量化收益：**
- API 破坏性变更检测率 ≥ 95%
- 服务间契约测试覆盖率 ≥ 80%
- 版本升级测试时间减少 60%（从 2 小时降至 30 分钟）

## 3. 范围

**包含：**
- API 兼容性检测引擎（基于 OpenAPI Schema Diff）
- 契约测试框架（Pact 或 OpenAPI-based Contract Testing）
- 版本管理服务（API 版本声明、废弃策略、迁移工具）
- CI/CD 集成脚本（破坏性变更自动告警、兼容性测试门禁）
- 管理后台集成（API 版本仪表盘、兼容性报告）

**不包含：**
- 前端 API 客户端代码生成（独立需求）
- 数据库 Schema 迁移管理（已有 REQ-00027、REQ-00060）
- API 性能测试（已有 REQ-00063、REQ-00490）

## 4. 详细需求

### 4.1 API 兼容性检测引擎

**核心模块：** `backend/shared/apiCompatibilityEngine.js`

```javascript
class APICompatibilityEngine {
  /**
   * 对比两个 OpenAPI Schema，识别破坏性变更
   * @param {Object} oldSchema - 旧版 OpenAPI Schema
   * @param {Object} newSchema - 新版 OpenAPI Schema
   * @returns {Object} 兼容性报告
   */
  async detectBreakingChanges(oldSchema, newSchema) {
    // 检测规则：
    // 1. 删除端点（PATH 删除）
    // 2. 删除/重命名响应字段
    // 3. 修改字段类型（string → number 等）
    // 4. 新增必填字段
    // 5. 删除可选字段
    // 6. 修改 HTTP 方法
    // 7. 修改认证要求
  }

  /**
   * 生成迁移建议
   */
  async generateMigrationGuide(breakingChanges) {
    // 自动生成迁移文档，包括：
    // - 变更清单
    // - 受影响的服务/客户端
    // - 迁移步骤
    // - 测试建议
  }
}
```

**破坏性变更类型：**
| 类型 | 严重级别 | 示例 |
|------|---------|------|
| CRITICAL | P0 | 删除端点、删除必填响应字段 |
| HIGH | P1 | 修改字段类型、新增必填请求字段 |
| MEDIUM | P2 | 删除可选字段、修改字段约束 |
| LOW | P3 | 新增可选字段、修改描述 |

### 4.2 契约测试框架

**测试类型：**
1. **Provider Contract Tests**：验证服务实现符合 OpenAPI Schema
2. **Consumer Contract Tests**：验证调用方符合服务契约
3. **Integration Contract Tests**：验证服务间调用兼容性

**测试文件组织：**
```
backend/tests/contracts/
├── gateway-contracts.test.js        # Gateway 对外 API 契约
├── user-service-contracts.test.js   # User Service API 契约
├── location-service-contracts.test.js
├── pokemon-service-contracts.test.js
├── catch-service-contracts.test.js
├── gym-service-contracts.test.js
├── social-service-contracts.test.js
├── reward-service-contracts.test.js
└── payment-service-contracts.test.js
```

**契约测试示例：**
```javascript
describe('User Service Contract', () => {
  it('should conform to OpenAPI schema for GET /users/:id', async () => {
    const response = await request(app).get('/users/123');
    
    // 验证响应符合 Schema
    const validationResult = validateAgainstSchema(
      response.body,
      schemas.UserService.getUser.response
    );
    
    expect(validationResult.valid).toBe(true);
  });

  it('should maintain backward compatibility for user response', async () => {
    const oldResponse = require('./fixtures/v1_user_response.json');
    const newResponse = await fetchUser(123);
    
    // 验证旧字段仍然存在
    expect(newResponse).toMatchObject({
      id: expect.any(Number),
      username: expect.any(String),
      email: expect.any(String)
    });
  });
});
```

### 4.3 版本管理服务

**增强现有 `apiVersion.js` 中间件：**

```javascript
class APIVersionManager {
  /**
   * API 版本生命周期管理
   */
  async declareVersion(apiVersion, metadata) {
    // 声明 API 版本
    // - 版本号（v1, v2...）
    // - 发布日期
    // - 废弃日期（可选）
    // - 迁移指南 URL
  }

  async deprecateVersion(apiVersion, sunsetDate) {
    // 标记版本废弃
    // - 设置 Sunset 响应头
    // - 发送通知给调用方
    // - 生成迁移报告
  }

  /**
   * 版本兼容性检查
   */
  async checkVersionCompatibility(requestedVersion, supportedVersions) {
    // 验证请求版本是否受支持
    // 返回兼容性建议
  }
}
```

**版本废弃策略：**
- 废弃公告期：至少 90 天
- Sunset HTTP Header：`Sunset: Sat, 31 Oct 2026 00:00:00 GMT`
- 告警机制：在 admin-dashboard 显示版本使用统计和迁移建议

### 4.4 CI/CD 集成

**GitHub Actions 工作流：**
```yaml
# .github/workflows/api-compatibility-check.yml
name: API Compatibility Check

on:
  pull_request:
    paths:
      - 'backend/*/src/routes/**'
      - 'backend/*/src/controllers/**'
      - 'backend/shared/schemas/**'

jobs:
  compatibility-check:
    runs-on: ubuntu-latest
    steps:
      - name: Generate OpenAPI Diff
        run: npm run api:diff
        
      - name: Check Breaking Changes
        run: npm run api:check-breaking
        
      - name: Run Contract Tests
        run: npm run test:contracts
        
      - name: Comment PR with Results
        uses: actions/github-script@v7
        with:
          script: |
            const report = require('./compatibility-report.json');
            if (report.breakingChanges.length > 0) {
              core.setFailed('Breaking changes detected!');
            }
```

**门禁规则：**
- P0 破坏性变更：阻止合并，要求架构评审
- P1 破坏性变更：允许合并，但需要迁移文档
- P2/P3 变更：仅记录和通知

### 4.5 管理后台集成

**API 版本仪表盘：**
- 当前活跃版本列表
- 各版本使用统计（基于请求头 X-API-Version）
- 废弃版本倒计时
- 破坏性变更历史记录

**兼容性报告：**
- 服务间依赖关系图
- 版本兼容性矩阵
- 迁移路径推荐

## 5. 验收标准（可测试）

- [ ] **兼容性检测引擎实现完成**
  - 能检测 7 种破坏性变更类型
  - 对 10 个历史 API 变更案例检测准确率 ≥ 90%

- [ ] **契约测试覆盖 9 个微服务**
  - 每个服务至少 10 个关键 API 的契约测试
  - 测试执行时间 < 5 分钟

- [ ] **版本管理服务集成完成**
  - 支持版本声明、废弃、查询
  - Sunset Header 正确返回
  - 版本使用统计准确

- [ ] **CI/CD 工作流部署成功**
  - PR 中自动运行兼容性检查
  - 破坏性变更自动评论通知
  - 阻止未审核的 P0 破坏性变更

- [ ] **管理后台仪表盘可用**
  - 显示 API 版本列表和使用统计
  - 兼容性报告可导出为 PDF/Markdown

- [ ] **文档完善**
  - API 版本管理指南
  - 迁移路径文档模板
  - 开发者集成手册

## 6. 工作量估算

**估算：L（Large）**

**工作量分解：**
- 兼容性检测引擎：2 天
- 契约测试框架搭建：3 天（9 个服务 × 10 个测试用例）
- 版本管理服务：1.5 天
- CI/CD 集成：1 天
- 管理后台集成：1.5 天
- 测试和文档：1 天

**总计：约 10 人天**

## 7. 优先级理由

**P1 优先级理由：**

1. **风险高**：mineGo 项目已有 517+ 需求，API 变更频繁，缺乏系统性的兼容性保障机制容易导致生产事故

2. **影响范围广**：涉及 9 个微服务、前端 game-client、可能的第三方集成，兼容性破坏会影响整个系统

3. **成熟度提升关键**：STATUS.md 中“核心功能完整度”已达到 28/25（超额完成），但缺乏 API 兼容性保障会制约系统的可持续演进

4. **技术债务预防**：越早建立兼容性测试体系，后期维护成本越低。目前已有 500+ 需求，现在实施是最佳时机

5. **支撑未来需求**：后续需求的实现都需要修改 API，本需求为所有后续需求提供安全保障，是基础性需求

## 8. 实施路径

**Phase 1：基础设施（第 1-3 天）**
- 实现兼容性检测引擎
- 搭建契约测试框架骨架
- 集成到 CI/CD

**Phase 2：服务覆盖（第 4-6 天）**
- 为 9 个微服务编写契约测试
- 完善版本管理服务
- 测试和验证

**Phase 3：集成优化（第 7-8 天）**
- 管理后台集成
- 文档编写
- 生产环境部署

## 9. 技术依赖

**依赖的现有系统：**
- OpenAPI Schema（REQ-00008 已完成）
- CI/CD Pipeline（已有 GitHub Actions）
- 管理后台（admin-dashboard）

**可选技术方案：**
- OpenAPI Diff 工具：`swagger-diff` 或 `openapi-diff`
- 契约测试：Pact 或自定义 OpenAPI Validator
- 版本管理：自定义服务（基于现有 `apiVersion.js`）

## 10. 成功指标

**短期（1 个月）：**
- 契约测试覆盖率 ≥ 80%
- 破坏性变更检测率 ≥ 95%
- 所有新 API 变更都通过兼容性检查

**长期（3 个月）：**
- API 相关的生产事故降低 80%
- 版本升级时间减少 60%
- 开发者对新 API 集成满意度提升（通过问卷调查）
