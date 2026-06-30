# REQ-00378：微服务架构决策记录（ADR）系统与知识库管理

- **编号**：REQ-00378
- **类别**：文档/开发者体验
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：docs/architecture、backend/shared、所有微服务、admin-dashboard、.github/workflows
- **创建时间**：2026-06-30 03:00 UTC
- **依赖需求**：无

## 1. 背景与问题

### 当前痛点

**架构知识碎片化问题严重**：
- 189个共享模块散落在 backend/shared 目录，缺乏统一架构说明
- 9个微服务的架构决策未记录，新成员理解成本高
- 技术选型原因、架构演进历史无文档化，知识传承困难
- API设计决策、数据库schema变更缺乏决策记录

**开发者体验问题**：
- 新开发者需要阅读大量代码才能理解系统架构
- 缺乏架构决策的"为什么"记录，只看到"是什么"
- 重构时难以追溯历史决策背景，容易重复犯错
- 跨服务依赖关系缺乏文档化梳理

**运维与故障排查困难**：
- 系统架构演进历史缺失，回滚决策缺乏依据
- 容量规划、性能优化决策未记录
- 安全策略、数据治理决策分散在各处

### 实际影响

- 新成员上手周期长达2-3周
- 架构重构时重复讨论已决策问题
- 故障排查时缺乏历史决策上下文
- 知识传承依赖口头传递，人员流动造成知识流失

## 2. 目标

建立完整的架构决策记录系统，实现：

1. **知识沉淀**：所有重要架构决策有记录、可追溯
2. **开发效率**：新成员通过ADR快速理解系统架构，上手周期缩短50%
3. **决策质量**：重构、优化时能参考历史决策背景
4. **团队协作**：架构决策透明化，便于Code Review和技术讨论

## 3. 范围

### 包含

- **ADR文档系统**：
  - 架构决策记录模板（ADR-NNNN格式）
  - 决策状态管理（提议/已接受/已废弃/已替代）
  - 决策分类（技术选型/架构模式/API设计/数据模型/安全策略）

- **知识库管理**：
  - 微服务架构概览文档
  - 共享模块功能说明文档
  - 跨服务依赖关系图
  - 技术债务清单与改进计划

- **工具支持**：
  - ADR创建命令行工具
  - 决策索引自动生成
  - Markdown文档搜索功能
  - 集成到Git提交流程

### 不包含

- 详细的API文档（已有OpenAPI规范）
- 用户操作手册
- 自动化架构图生成（单独需求）
- 代码注释生成工具

## 4. 详细需求

### 4.1 ADR文档结构

```
docs/architecture/
├── README.md                    # 架构概览
├── decisions/
│   ├── ADR-0001-record-architecture-decisions.md
│   ├── ADR-0002-use-nodejs-express-stack.md
│   ├── ADR-0003-microservices-architecture.md
│   ├── ADR-0004-postgresql-with-postgis.md
│   ├── ADR-0005-redis-for-caching.md
│   ├── ADR-0006-kafka-event-streaming.md
│   ├── ADR-0007-kubernetes-deployment.md
│   ├── ADR-0008-gateway-service-pattern.md
│   ├── ADR-0009-jwt-authentication.md
│   ├── ADR-0010-connection-pool-strategy.md
│   ├── ... (继续补充)
│   └── INDEX.md                 # 决策索引
├── diagrams/
│   ├── system-overview.drawio
│   ├── service-dependencies.drawio
│   └── data-flow.drawio
└── tech-debt/
    ├── TECH-DEBT-001.md
    └── TRACKER.md
```

### 4.2 ADR模板格式

每个ADR包含以下部分：

```markdown
# ADR-NNNN: {决策标题}

## 状态
提议 | 已接受 | 已废弃 | 已替代

## 上下文
描述决策背景、问题、约束条件

## 决策
描述做出的决定和理由

## 后果
描述决策带来的影响（正面/负面）

## 替代方案
考虑过的其他方案及拒绝理由

## 相关决策
关联的其他ADR编号

## 决策日期
YYYY-MM-DD

## 决策者
参与者名单
```

### 4.3 核心功能模块

#### 4.3.1 ADR管理工具（scripts/adr-cli.sh）

```bash
# 创建新ADR
./scripts/adr-cli.sh create "Use PostgreSQL for data storage"

# 列出所有ADR
./scripts/adr-cli.sh list

# 查看ADR详情
./scripts/adr-cli.sh show ADR-0010

# 更新ADR状态
./scripts/adr-cli.sh accept ADR-0010
./scripts/adr-cli.sh deprecate ADR-0005 --superseded-by ADR-0020

# 生成索引
./scripts/adr-cli.sh index

# 搜索决策
./scripts/adr-cli.sh search "database"
```

#### 4.3.2 共享模块文档生成器（scripts/gen-module-docs.js）

```javascript
/**
 * 自动扫描 backend/shared/*.js
 * 提取JSDoc注释和导出接口
 * 生成 docs/architecture/modules/ 文档
 */
class ModuleDocGenerator {
  async scanModule(modulePath) {
    // 解析AST提取函数签名、参数、返回值
    // 解析JSDoc提取说明、示例
  }
  
  async generateMarkdown(moduleName, metadata) {
    // 生成标准格式文档
  }
}
```

#### 4.3.3 架构知识搜索API（backend/shared/ArchitectureSearch.js）

```javascript
/**
 * 提供架构知识搜索能力
 * 支持全文搜索、标签过滤、关系查询
 */
class ArchitectureSearch {
  async search(query, filters = {}) {
    // 搜索ADR文档
    // 搜索模块文档
    // 搜索技术债务清单
  }
  
  async listByTag(tag) {
    // 按标签筛选
  }
  
  async listDecisions(status = 'accepted') {
    // 按状态筛选
  }
}
```

### 4.4 初始ADR清单（需补充）

根据项目现状，至少需补充以下关键决策：

1. **ADR-0003**: 微服务架构模式选择
2. **ADR-0008**: Gateway服务统一入口模式
3. **ADR-0010**: 数据库连接池策略
4. **ADR-0015**: Redis缓存架构
5. **ADR-0020**: Kafka事件驱动架构
6. **ADR-0025**: WebSocket实时通信方案
7. **ADR-0030**: JWT认证与授权策略
8. **ADR-0035**: 分布式追踪方案（OpenTelemetry）
9. **ADR-0040**: 容器化部署策略
10. **ADR-0045**: CI/CD流水线设计

### 4.5 技术债务管理

```markdown
# docs/architecture/tech-debt/TRACKER.md

## 高优先级技术债
| 编号 | 描述 | 影响 | 预估工时 | 负责人 | 状态 |
|------|------|------|----------|--------|------|
| TECH-DEBT-001 | console.log 替换为统一日志 | 中 | 4h | - | new |
| TECH-DEBT-002 | 错误处理模块重构 | 高 | 8h | - | new |
| TECH-DEBT-003 | 微服务样板代码统一化 | 中 | 6h | - | new |

## 中优先级技术债
...

## 低优先级技术债
...
```

### 4.6 Git集成

```bash
# .git/hooks/pre-commit
# 检查ADR文档格式
./scripts/validate-adr.sh

# .github/workflows/docs.yml
# 自动部署架构文档到GitHub Pages
```

## 5. 验收标准（可测试）

- [ ] 创建至少30个核心ADR文档，覆盖主要架构决策
- [ ] ADR管理工具支持创建/查看/更新/搜索操作
- [ ] 共享模块文档自动生成覆盖率 > 80%
- [ ] 架构知识搜索API支持全文搜索和标签过滤
- [ ] 技术债务清单包含至少10条记录，优先级明确
- [ ] 新成员通过ADR文档能在1天内理解核心架构
- [ ] Git提交时自动检查ADR文档格式
- [ ] 架构文档部署到GitHub Pages或内部Wiki

## 6. 工作量估算

**工作量：M（2-3人日）**

理由：
- ADR模板和工具开发：0.5天
- 初始ADR文档撰写（30个）：1.5天
- 模块文档生成器开发：0.5天
- 集成测试与文档部署：0.5天

## 7. 优先级理由

**P2级**（中等优先级）：

1. **非阻塞型需求**：不影响核心功能，可延后实施
2. **长期收益显著**：提升团队协作效率和知识传承
3. **成熟度提升**：完善文档维度（当前4/5分），有助于达到5/5
4. **技术债务预防**：帮助团队避免重复决策和架构腐化
5. **可拆分实施**：可先实现ADR框架，逐步补充内容

此需求虽非紧急，但对项目长期健康发展至关重要，建议在P0/P1需求完成后优先实施。
