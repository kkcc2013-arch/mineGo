# REQ-00400：API 快照测试与响应结构验证系统

- **编号**：REQ-00400
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、backend/tests/snapshot、backend/shared/snapshotValidator.js、docs/api-spec、.github/workflows
- **创建时间**：2026-06-30 23:05 UTC
- **依赖需求**：REQ-00008（OpenAPI 文档）、REQ-00093（API 契约测试）

## 1. 背景与问题

当前 mineGo 项目已有 280 个测试文件，覆盖了单元测试、集成测试、契约测试、混沌测试等多个层次。然而，缺少 **API 快照测试** 层，这导致以下问题：

1. **响应结构漂移难以检测**：微服务迭代过程中，API 响应结构可能无意间发生变化（新增/删除字段、字段类型变更），现有契约测试仅验证接口契约，无法捕获响应结构的细微变化

2. **回归测试成本高**：每次修改 API 代码后，需要人工检查响应格式是否符合预期，缺乏自动化的快照比对机制

3. **跨服务依赖脆弱**：前端 game-client 和 admin-dashboard 依赖特定响应结构，任何意外变化可能导致前端解析失败，影响用户体验

4. **缺少历史版本比对**：无法追溯 API 响应结构的历史演变，难以判断是否发生 Breaking Change

5. **测试覆盖率报告不完整**：缺少响应结构验证的覆盖率统计，无法全面评估 API 稳定性

## 2. 目标

建立完整的 API 快照测试与响应结构验证系统，实现：

- ✅ 自动捕获所有 REST API 的响应快照，建立响应结构基线
- ✅ 每次运行测试时自动比对快照，检测意外的结构变化
- ✅ 支持快照更新审批机制，防止误更新
- ✅ 与 CI/CD 流水线集成，快照测试失败阻止部署
- ✅ 提供快照差异可视化，快速定位变更内容
- ✅ 补充现有契约测试，形成完整的 API 稳定性防护体系

预期收益：
- 减少 API Breaking Change 导致的前端故障 90%
- 缩短回归测试时间 50%（自动化快照比对替代人工检查）
- 提升 API 稳定性置信度，支持安全迭代

## 3. 范围

**包含**：
1. API 快照捕获框架（支持 GET/POST/PUT/DELETE）
2. 快照存储与版本管理（JSON 格式，存储在 `backend/tests/snapshots/`）
3. 快照比对引擎（字段结构、类型、必需性验证）
4. 快照更新审批流程（命令行工具 + CI/CD 门禁）
5. 快照差异可视化（HTML 报告 + CLI 输出）
6. 与现有测试框架集成（Jest、Supertest）
7. 快照覆盖率报告（统计已覆盖的 API 数量）

**不包含**：
- WebSocket API 快照测试（属于 REQ-00381 范围）
- 前端组件快照测试（前端独立测试体系）
- 性能指标快照（属于 REQ-00166 范围）
- 业务逻辑正确性验证（属于单元测试范围）

## 4. 详细需求

### 4.1 快照捕获框架

```javascript
// backend/shared/snapshotValidator.js
class ApiSnapshotValidator {
  constructor(config) {
    this.snapshotDir = config.snapshotDir || 'tests/snapshots';
    this.autoUpdate = config.autoUpdate || false;
    this.ignoreFields = config.ignoreFields || ['timestamp', 'reqId', 'traceId'];
  }

  // 捕获 API 响应快照
  async captureSnapshot(apiPath, method, response) {
    const snapshotPath = this.getSnapshotPath(apiPath, method);
    const sanitizedResponse = this.sanitizeDynamicFields(response);
    
    await fs.writeJSON(snapshotPath, {
      metadata: {
        apiPath,
        method,
        capturedAt: new Date().toISOString(),
        version: this.extractApiVersion(apiPath),
      },
      response: sanitizedResponse,
    });
  }

  // 比对快照
  async compareSnapshot(apiPath, method, currentResponse) {
    const snapshotPath = this.getSnapshotPath(apiPath, method);
    
    if (!await fs.exists(snapshotPath)) {
      return { status: 'missing', message: '快照不存在，需要首次捕获' };
    }

    const storedSnapshot = await fs.readJSON(snapshotPath);
    const sanitizedCurrent = this.sanitizeDynamicFields(currentResponse);
    
    const diff = this.computeDeepDiff(storedSnapshot.response, sanitizedCurrent);
    
    if (diff.length === 0) {
      return { status: 'match', message: '快照匹配' };
    } else {
      return {
        status: 'diff',
        message: '快照不匹配',
        diff,
        storedSnapshot,
        currentResponse: sanitizedCurrent,
      };
    }
  }

  // 深度差异计算
  computeDeepDiff(expected, actual, path = '') {
    const diffs = [];
    
    // 字段缺失检测
    for (const key in expected) {
      if (!(key in actual)) {
        diffs.push({
          type: 'field_missing',
          path: `${path}.${key}`,
          expected: expected[key],
          actual: undefined,
        });
      }
    }
    
    // 字段新增检测
    for (const key in actual) {
      if (!(key in expected)) {
        diffs.push({
          type: 'field_added',
          path: `${path}.${key}`,
          expected: undefined,
          actual: actual[key],
        });
      }
    }
    
    // 类型不匹配检测
    for (const key in expected) {
      if (key in actual) {
        const expectedType = this.getType(expected[key]);
        const actualType = this.getType(actual[key]);
        
        if (expectedType !== actualType) {
          diffs.push({
            type: 'type_mismatch',
            path: `${path}.${key}`,
            expectedType,
            actualType,
          });
        } else if (typeof expected[key] === 'object' && expected[key] !== null) {
          diffs.push(...this.computeDeepDiff(expected[key], actual[key], `${path}.${key}`));
        }
      }
    }
    
    return diffs;
  }
}
```

### 4.2 快照测试框架集成

```javascript
// backend/tests/snapshot/apiSnapshot.test.js
const request = require('supertest');
const app = require('../../gateway/src/app');
const { ApiSnapshotValidator } = require('../../shared/snapshotValidator');

describe('API Snapshot Tests', () => {
  const validator = new ApiSnapshotValidator({
    snapshotDir: 'tests/snapshots',
    autoUpdate: process.env.UPDATE_SNAPSHOTS === 'true',
  });

  // GET /api/v1/pokemon/:id
  it('GET /api/v1/pokemon/:id 快照验证', async () => {
    const res = await request(app)
      .get('/api/v1/pokemon/pk001')
      .set('Authorization', 'Bearer test-token')
      .expect(200);

    const result = await validator.compareSnapshot('/api/v1/pokemon/:id', 'GET', res.body);
    
    if (result.status === 'missing') {
      await validator.captureSnapshot('/api/v1/pokemon/:id', 'GET', res.body);
      console.log('首次捕获快照');
    } else if (result.status === 'diff') {
      console.error('快照差异:', result.diff);
      throw new Error('API 响应结构发生变化，请检查差异');
    }
  });

  // POST /api/v1/catch
  it('POST /api/v1/catch 快照验证', async () => {
    const res = await request(app)
      .post('/api/v1/catch')
      .send({ pokemonId: 'pk001', ballType: 'pokeball' })
      .expect(200);

    const result = await validator.compareSnapshot('/api/v1/catch', 'POST', res.body);
    
    expect(result.status).toBe('match');
  });
});
```

### 4.3 快照更新审批流程

```bash
# 命令行工具
node scripts/update-snapshots.js --api /api/v1/pokemon/:id --method GET

# CI/CD 门禁
# .github/workflows/test.yml
- name: Run Snapshot Tests
  run: npm run test:snapshot
  
- name: Check Snapshot Status
  if: failure()
  run: |
    echo "快照测试失败，API 响应结构发生变化"
    echo "请确认变更是否为预期 Breaking Change"
    echo "如需更新快照，运行: npm run test:snapshot --update"
    exit 1
```

### 4.4 快照差异可视化

```javascript
// backend/shared/snapshotDiffReporter.js
class SnapshotDiffReporter {
  generateHtmlReport(diffResults) {
    return `
      <html>
        <head><title>API Snapshot Diff Report</title></head>
        <body>
          <h1>快照差异报告</h1>
          <table>
            <tr><th>API</th><th>差异类型</th><th>路径</th><th>详情</th></tr>
            ${diffResults.map(r => `
              <tr>
                <td>${r.apiPath}</td>
                <td>${r.diff.type}</td>
                <td>${r.diff.path}</td>
                <td>${this.formatDiff(r.diff)}</td>
              </tr>
            `).join('')}
          </table>
        </body>
      </html>
    `;
  }

  formatDiff(diff) {
    switch (diff.type) {
      case 'field_missing':
        return `字段缺失: ${diff.path}`;
      case 'field_added':
        return `字段新增: ${diff.path} (${diff.actual})`;
      case 'type_mismatch':
        return `类型不匹配: ${diff.expectedType} → ${diff.actualType}`;
      default:
        return '未知差异';
    }
  }
}
```

### 4.5 快照存储结构

```
backend/tests/snapshots/
├── GET/
│   ├── api-v1-pokemon-{id}.json
│   ├── api-v1-user-profile.json
│   └── api-v1-gym-list.json
├── POST/
│   ├── api-v1-catch.json
│   ├── api-v1-trade.json
│   └── api-v1-payment.json
└── PUT/
    ├── api-v1-pokemon-{id}-nickname.json
```

### 4.6 快照覆盖率统计

```javascript
// backend/shared/snapshotCoverage.js
class SnapshotCoverage {
  async calculateCoverage() {
    const allApis = await this.getAllApisFromOpenApiSpec();
    const coveredApis = await this.getCoveredApisFromSnapshots();
    
    const coverage = {
      total: allApis.length,
      covered: coveredApis.length,
      percentage: (coveredApis.length / allApis.length * 100).toFixed(2),
      uncovered: allApis.filter(api => !coveredApis.includes(api)),
    };
    
    return coverage;
  }

  async generateReport() {
    const coverage = await this.calculateCoverage();
    
    return {
      summary: `快照覆盖率: ${coverage.coverage.percentage}%`,
      details: {
        covered: coverage.covered,
        uncovered: coverage.uncovered,
      },
    };
  }
}
```

## 5. 验收标准（可测试）

- [ ] 快照捕获框架实现完成，支持 GET/POST/PUT/DELETE 方法
- [ ] 快照比对引擎实现完成，能检测字段缺失、新增、类型不匹配
- [ ] 快照测试集成到 Jest 测试框架，可运行 `npm run test:snapshot`
- [ ] 快照存储目录结构规范，快照文件以 JSON 格式存储
- [ ] 快照更新审批流程实现，支持命令行更新和 CI/CD 门禁
- [ ] 快照差异可视化报告生成（HTML + CLI）
- [ ] 快照覆盖率统计功能实现，输出覆盖率百分比报告
- [ ] 至少覆盖 50 个核心 API 的快照（包括捕捉、道馆、支付等关键路径）
- [ ] CI/CD 流水线集成快照测试，快照失败阻止部署
- [ ] 文档完善：快照测试使用指南、快照更新流程

## 6. 工作量估算

**L (Large)** - 约 16-20 小时

理由：
- 需要实现完整的快照框架（捕获、比对、报告）
- 需要覆盖 50+ API 的快照
- 需要与现有测试框架深度集成
- 需要实现 CI/CD 集成和审批流程
- 需要完善的文档和示例

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **API 稳定性关键**：mineGo 已有 9 个微服务、数百个 API，响应结构稳定性直接影响前端可用性
2. **防止 Breaking Change**：现有契约测试仅验证接口契约，无法捕获响应结构的细微变化，快照测试填补这一空白
3. **回归测试效率**：自动化快照比对可大幅缩短回归测试时间，降低迭代成本
4. **成熟度评分提升**：测试覆盖维度当前得分 8/10，快照测试完善后可提升至 9/10，助力总分达到 100
5. **依赖现有需求**：基于 REQ-00008（OpenAPI）和 REQ-00093（契约测试）扩展，技术可行性高

## 8. 实施建议

### 8.1 分阶段实施

**Phase 1（Week 1）**：快照框架核心
- 实现快照捕获和比对引擎
- 集成到 Jest 测试框架
- 基础 CLI 工具

**Phase 2（Week 2）**：核心 API 快照覆盖
- 覆盖捕捉、道馆、支付、精灵管理等核心路径的 50+ API
- 建立快照基线

**Phase 3（Week 3）**：CI/CD 集成与报告
- 集成到 GitHub Actions
- 实现快照差异可视化
- 快照覆盖率报告

### 8.2 技术选型

- **快照格式**：JSON（易读、易比对）
- **差异算法**：基于 JSON deep diff（参考 jest-snapshot）
- **存储位置**：`backend/tests/snapshots/`（版本控制）
- **报告格式**：HTML（详细）+ CLI（摘要）

### 8.3 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 动态字段影响快照稳定性 | 配置 ignoreFields（timestamp、reqId 等） |
| 快照文件过大 | 响应数据精简（仅保留结构，不保留大量数据） |
| 快照更新误操作 | 强制审批流程 + CI/CD 门禁 |
| 测试运行时间长 | 并行快照测试 + 选择性运行 |

---

**创建者**：mineGo 自动化需求生成系统
**创建时间**：2026-06-30 23:05 UTC
**下一步**：实现阶段（代码编写 + 快照覆盖）