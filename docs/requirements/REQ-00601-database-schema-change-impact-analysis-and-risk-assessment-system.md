# REQ-00601：数据库 Schema 变更智能影响分析与风险评估系统

- **编号**：REQ-00601
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：database/migrate.js、backend/shared/schemaChangeAnalyzer.js、backend/shared/schemaImpactAnalyzer.js、gateway、所有后端服务、admin-dashboard
- **创建时间**：2026-07-20 02:00
- **依赖需求**：REQ-00007（数据库迁移管理）、REQ-00306（数据库迁移回滚系统）

## 1. 背景与问题

当前 mineGo 项目使用 PostgreSQL + PostGIS 数据库，已有数据库迁移管理（REQ-00007）和迁移回滚系统（REQ-00306）。但是：

1. **缺乏变更前的影响分析**：开发者在执行 schema 变更前，无法评估变更对现有数据、查询、索引的影响
2. **风险评估不足**：缺少对破坏性变更（如删除列、修改数据类型）的自动化风险评级
3. **依赖关系不透明**：表之间的外键关系、索引依赖、视图依赖缺乏可视化分析
4. **回滚成本未知**：无法预估回滚所需时间和数据恢复难度

目前 database/migrate.js 只负责执行迁移，缺少变更前的智能分析和风险预警。

## 2. 目标

构建一个数据库 Schema 变更智能影响分析与风险评估系统，在执行 DDL 变更前：

- **自动分析变更影响范围**：识别受影响的表、视图、索引、外键约束
- **评估风险等级**：对破坏性变更进行风险分级（低/中/高/极高）
- **预估执行时间**：基于表大小和索引复杂度预测迁移耗时
- **提供回滚建议**：生成安全的回滚脚本和恢复策略
- **集成 CI/CD 检查**：在 PR 阶段自动检测高风险变更并提醒

## 3. 范围

- **包含**：
  - Schema 变更解析器（解析 SQL DDL 语句）
  - 依赖图构建器（表/视图/索引/外键关系）
  - 影响范围分析器（查询、存储过程、触发器影响）
  - 风险评估引擎（基于规则的风险分级）
  - 执行时间预估器（基于表统计信息）
  - 回滚脚本生成器
  - CI/CD 集成脚本（GitHub Actions check）
  - Admin Dashboard 可视化界面

- **不包含**：
  - 数据库迁移的实际执行（已有 migrate.js）
  - 数据库性能监控（已有相关需求）
  - 数据备份与恢复（已有 REQ-00025）

## 4. 详细需求

### 4.1 Schema 变更解析器

```javascript
// backend/shared/schemaChangeAnalyzer.js

class SchemaChangeAnalyzer {
  /**
   * 解析 SQL DDL 语句，提取变更类型和目标对象
   * @param {string} migrationSql - 迁移 SQL 内容
   * @returns {SchemaChange[]} - 变更列表
   */
  parseMigration(migrationSql) { ... }
}

// 变更类型枚举
const ChangeType = {
  CREATE_TABLE: 'CREATE_TABLE',
  ALTER_TABLE_ADD_COLUMN: 'ALTER_TABLE_ADD_COLUMN',
  ALTER_TABLE_DROP_COLUMN: 'ALTER_TABLE_DROP_COLUMN',
  ALTER_TABLE_MODIFY_COLUMN: 'ALTER_TABLE_MODIFY_COLUMN',
  ADD_INDEX: 'ADD_INDEX',
  DROP_INDEX: 'DROP_INDEX',
  ADD_CONSTRAINT: 'ADD_CONSTRAINT',
  DROP_CONSTRAINT: 'DROP_CONSTRAINT',
  CREATE_VIEW: 'CREATE_VIEW',
  DROP_VIEW: 'DROP_VIEW',
};
```

### 4.2 依赖图构建器

```javascript
// backend/shared/schemaDependencyGraph.js

class SchemaDependencyGraph {
  /**
   * 从数据库元数据构建依赖图
   * @param {Pool} dbPool - 数据库连接池
   * @returns {DependencyGraph} - 依赖关系图
   */
  async buildGraph(dbPool) {
    // 查询 information_schema 获取表、列、约束
    // 查询 pg_class 获取索引、视图依赖
    // 构建有向图表示依赖关系
  }

  /**
   * 获取受影响的下游对象
   * @param {string} objectType - 表/视图/索引
   * @param {string} objectName - 对象名
   * @returns {AffectedObject[]} - 受影响对象列表
   */
  async getAffectedObjects(objectType, objectName) { ... }
}
```

### 4.3 影响范围分析器

```javascript
// backend/shared/schemaImpactAnalyzer.js

class SchemaImpactAnalyzer {
  /**
   * 分析 schema 变更的影响范围
   * @param {SchemaChange[]} changes - 变更列表
   * @param {DependencyGraph} graph - 依赖图
   * @returns {ImpactAnalysis} - 影响分析结果
   */
  async analyzeImpact(changes, graph) {
    // 1. 直接影响：变更目标对象本身
    // 2. 间接影响：依赖该对象的视图、触发器、存储过程
    // 3. 查询影响：涉及该表的常用查询
    // 4. 应用影响：引用该表的代码路径
  }
}

// 影响分析结果结构
interface ImpactAnalysis {
  directImpact: AffectedObject[];
  indirectImpact: AffectedObject[];
  affectedQueries: QueryPattern[];
  affectedServices: ServiceModule[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  estimatedExecutionTime: number; // 毫秒
  rollbackComplexity: 'simple' | 'moderate' | 'complex';
}
```

### 4.4 风险评估引擎

```javascript
// backend/shared/schemaRiskAssessor.js

class SchemaRiskAssessor {
  /**
   * 评估 schema 变更的风险等级
   */
  assessRisk(changes, impactAnalysis) {
    // 风险因素：
    // 1. 数据丢失风险（DROP COLUMN, DROP TABLE）
    // 2. 类型变更风险（缩小类型范围、精度变更）
    // 3. 约束变更风险（NOT NULL 添加）
    // 4. 索引变更风险（删除索引影响查询性能）
    // 5. 影响范围（受影响对象数量）
    // 6. 表大小（大表变更锁表时间长）
  }
}

// 风险等级规则
const RiskRules = {
  DROP_TABLE: 'critical',        // 数据完全丢失
  DROP_COLUMN: 'critical',       // 数据部分丢失
  MODIFY_COLUMN_TYPE: 'high',    // 可能数据截断
  ADD_NOT_NULL_CONSTRAINT: 'high', // 可能违反约束
  ADD_FOREIGN_KEY: 'medium',     // 可能约束冲突
  ADD_COLUMN: 'low',             // 默认值填充
  ADD_INDEX: 'low',              // 只影响性能
};
```

### 4.5 执行时间预估器

```javascript
// backend/shared/schemaExecutionEstimator.js

class SchemaExecutionEstimator {
  /**
   * 预估迁移执行时间
   */
  async estimateExecutionTime(changes, dbPool) {
    // 获取表统计信息
    const stats = await this.getTableStats(dbPool);
    
    // 基于 PostgreSQL 经验值估算
    // - ALTER TABLE 全表扫描：约 1000 行/秒
    // - ADD INDEX：约 5000 行/秒
    // - ADD COLUMN with DEFAULT：需要全表更新
  }
}

interface TableStats {
  tableName: string;
  rowCount: number;
  tableSize: number;    // 字节
  indexCount: number;
  avgRowSize: number;
}
```

### 4.6 回滚脚本生成器

```javascript
// backend/shared/schemaRollbackGenerator.js

class SchemaRollbackGenerator {
  /**
   * 为每个变更生成对应的回滚语句
   */
  generateRollback(changes) {
    // CREATE TABLE -> DROP TABLE
    // ADD COLUMN -> DROP COLUMN
    // DROP COLUMN -> 需要备份恢复（标记为不可逆）
    // ADD INDEX -> DROP INDEX
    // ADD CONSTRAINT -> DROP CONSTRAINT
  }
}
```

### 4.7 CI/CD 集成

```yaml
# .github/workflows/schema-change-check.yml
name: Schema Change Analysis

on:
  pull_request:
    paths:
      - 'database/migrations/**'
      - 'backend/migrations/**'

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Analyze Schema Changes
        run: |
          node backend/shared/schemaChangeAnalyzer.js \
            --migration-path database/migrations \
            --output schema-analysis.json
      
      - name: Check Risk Level
        run: |
          RISK=$(jq -r '.riskLevel' schema-analysis.json)
          if [ "$RISK" = "critical" ]; then
            echo "::error::Critical risk detected in schema changes!"
            echo "Please review: ${{ steps.analysis.outputs.report_url }}"
            exit 1
          fi
      
      - name: Comment on PR
        uses: actions/github-script@v7
        with:
          script: |
            const analysis = require('./schema-analysis.json');
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `## Schema Change Analysis
            
            **Risk Level**: ${analysis.riskLevel}
            **Affected Objects**: ${analysis.affectedCount}
            **Estimated Time**: ${analysis.estimatedTime}ms
            
            ${analysis.summary}
            `
            });
```

### 4.8 Admin Dashboard 界面

```html
<!-- admin-dashboard/schema-analysis.html -->
<div class="schema-analysis-panel">
  <h2>Schema Change Analysis</h2>
  
  <div class="risk-indicator" data-risk="critical">
    <!-- 红/黄/绿 风险指示器 -->
  </div>
  
  <div class="impact-graph">
    <!-- D3.js 渲染依赖关系图 -->
  </div>
  
  <div class="affected-objects-list">
    <!-- 受影响对象列表，按类型分组 -->
  </div>
  
  <div class="rollback-script-preview">
    <!-- 回滚脚本预览 -->
  </div>
  
  <div class="approval-workflow">
    <!-- 高风险变更需要审批 -->
  </div>
</div>
```

## 5. 验收标准（可测试）

- [ ] 能解析标准 PostgreSQL DDL 语句（CREATE/ALTER/DROP）
- [ ] 能识别表、列、索引、约束、视图之间的依赖关系
- [ ] 能正确评估 10+ 种变更类型的风险等级
- [ ] 对破坏性变更（DROP）标记为 critical 风险
- [ ] 能预估 100 万行表的 ALTER 执行时间，误差在 30% 以内
- [ ] 能生成有效的回滚 SQL 脚本
- [ ] CI/CD 能在 PR 阶段检测高风险变更并阻止合并
- [ ] Admin Dashboard 能可视化依赖关系和影响范围
- [ ] 单元测试覆盖率达到 85% 以上

## 6. 工作量估算

**L（Large）**

理由：
- 需要实现多个核心模块（解析器、分析器、评估器）
- 需要深入 PostgreSQL 系统表查询
- 需要集成 CI/CD 和 Dashboard
- 预计需要 3-5 个工作日

## 7. 优先级理由

**P1（高优先级）**

1. **数据安全关键**：错误的 schema 变更可能导致数据丢失，影响范围大
2. **开发效率提升**：减少手动分析变更影响的时间，避免生产事故
3. **依赖已满足**：REQ-00007（迁移管理）和 REQ-00306（回滚系统）已完成
4. **成熟度贡献**：对"数据库/数据治理"维度有显著提升