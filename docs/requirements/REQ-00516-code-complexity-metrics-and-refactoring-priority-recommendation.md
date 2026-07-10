# REQ-00516：代码复杂度度量与重构优先级智能推荐系统

- **编号**：REQ-00516
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：backend/shared/codeQuality、所有后端服务、admin-dashboard、GitHub Actions
- **创建时间**：2026-07-09 00:00
- **依赖需求**：无

## 1. 背景与问题

mineGo 项目已积累超过 500+ 需求实现，代码库规模持续增长，但缺乏系统化的**代码质量度量与重构优先级决策机制**：

### 1.1 当前问题
1. **技术债不可见**：代码复杂度、重复代码、过长函数等技术债缺乏量化指标
2. **重构决策主观**：重构优先级依赖人工判断，缺乏数据驱动的决策支持
3. **代码腐化风险**：随着功能累积，代码复杂度持续上升，维护成本增加
4. **缺乏趋势追踪**：无法追踪代码质量随时间的演变趋势
5. **团队认知不一**：不同开发者对"好代码"的标准理解不一致

### 1.2 当前代码现状
```javascript
// 示例：过长函数（200+ 行）
async function processPokemonCapture(userId, pokemonId, location, items) {
  // 200+ 行代码，多个职责混杂
  // 难以测试、难以维护
}

// 示例：重复代码（多个服务相似逻辑）
// user-service、social-service、gym-service 都有相似的权限检查逻辑
```

### 1.3 期望改进
构建代码复杂度度量与重构推荐系统，支持：
- 自动化代码质量指标收集（圈复杂度、认知复杂度、代码重复率等）
- 基于影响范围、修改频率、复杂度综合评分推荐重构目标
- 代码质量趋势可视化看板
- PR 自动质量检查与预警
- 技术债积分系统

## 2. 目标

1. **量化技术债**：建立多维度代码质量指标体系
2. **智能推荐**：基于影响范围、修改频率、复杂度综合评分推荐重构目标
3. **趋势可视**：在 Admin Dashboard 展示代码质量演变趋势
4. **预防机制**：在 PR 阶段拦截高风险代码变更
5. **积分驱动**：建立技术债积分制度，量化项目健康度

## 3. 范围

### 包含
- 代码复杂度分析器：`CodeComplexityAnalyzer`
- 重构推荐引擎：`RefactoringRecommender`
- 质量趋势追踪器：`QualityTrendTracker`
- PR 质量检查钩子：GitHub Actions 集成
- Admin Dashboard 可视化页面
- 技术债积分系统：`TechnicalDebtScore`

### 不包含
- 自动重构工具（如 IDE 插件）
- 代码风格检查（已有 ESLint）
- 性能分析（已有 REQ-00502 性能分析框架）
- 第三方代码质量平台集成（如 SonarQube 云服务）

## 4. 详细需求

### 4.1 代码复杂度分析器

```javascript
// backend/shared/codeQuality/CodeComplexityAnalyzer.js

const fs = require('fs').promises;
const path = require('path');
const acorn = require('acorn');
const esquery = require('esquery');

class CodeComplexityAnalyzer {
  constructor() {
    this.metrics = {
      cyclomaticComplexity: 0,      // 圈复杂度
      cognitiveComplexity: 0,        // 认知复杂度
      linesOfCode: 0,                // 代码行数
      functionCount: 0,              // 函数数量
      avgFunctionLength: 0,          // 平均函数长度
      maxFunctionLength: 0,          // 最大函数长度
      duplicateCodeRate: 0,          // 重复代码率
      maintainabilityIndex: 0,       // 可维护性指数
      nestingDepth: 0,               // 最大嵌套深度
      parameterCount: 0              // 最大参数数量
    };
  }

  /**
   * 分析单个文件
   */
  async analyzeFile(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const ast = acorn.parse(content, {
      ecmaVersion: 2022,
      sourceType: 'module',
      locations: true
    });

    const fileMetrics = {
      path: filePath,
      ...this.metrics,
      functions: []
    };

    // 提取所有函数
    const functions = esquery(ast, 'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression');
    
    for (const func of functions) {
      const funcMetrics = this.analyzeFunction(func, content);
      fileMetrics.functions.push(funcMetrics);
      
      fileMetrics.cyclomaticComplexity += funcMetrics.cyclomaticComplexity;
      fileMetrics.cognitiveComplexity += funcMetrics.cognitiveComplexity;
      fileMetrics.functionCount++;
      fileMetrics.maxFunctionLength = Math.max(fileMetrics.maxFunctionLength, funcMetrics.linesOfCode);
    }

    fileMetrics.maintainabilityIndex = this.calculateMaintainabilityIndex(fileMetrics);
    return fileMetrics;
  }

  /**
   * 计算圈复杂度
   */
  calculateCyclomaticComplexity(node) {
    let complexity = 1;
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (['IfStatement', 'WhileStatement', 'ForStatement', 'ForInStatement', 
           'ForOfStatement', 'SwitchCase', 'CatchClause', 'ConditionalExpression',
           'LogicalExpression'].includes(n.type)) {
        complexity++;
      }
      for (const key in n) {
        if (n[key] && typeof n[key] === 'object') {
          Array.isArray(n[key]) ? n[key].forEach(visit) : visit(n[key]);
        }
      }
    };
    visit(node);
    return complexity;
  }

  /**
   * 计算可维护性指数
   */
  calculateMaintainabilityIndex(metrics) {
    const V = metrics.halsteadVolume || 100;
    const G = metrics.cyclomaticComplexity || 1;
    const LOC = metrics.linesOfCode || 1;
    const MI = 171 - 5.2 * Math.log(V) - 0.23 * G - 16.2 * Math.log(LOC);
    return Math.max(0, Math.min(100, MI));
  }
}

module.exports = CodeComplexityAnalyzer;
```

### 4.2 重构推荐引擎

```javascript
// backend/shared/codeQuality/RefactoringRecommender.js

class RefactoringRecommender {
  constructor() {
    this.weights = {
      complexity: 0.3,
      changeFrequency: 0.25,
      bugHistory: 0.2,
      coverage: 0.15,
      dependencyCount: 0.1
    };
  }

  async generateRecommendations(analysisResults, gitHistory, bugTracking) {
    const recommendations = [];
    for (const file of analysisResults.files) {
      const score = this.calculateRefactoringScore(file, gitHistory, bugTracking);
      if (score.priority > 0.6) {
        recommendations.push({
          file: file.path,
          priority: score.priority,
          reasons: this.identifyReasons(file, gitHistory, bugTracking),
          suggestedActions: this.suggestRefactoringActions(file),
          estimatedEffort: this.estimateEffort(file)
        });
      }
    }
    return recommendations.sort((a, b) => b.priority - a.priority);
  }
}

module.exports = RefactoringRecommender;
```

### 4.3 质量趋势追踪器

```javascript
// backend/shared/codeQuality/QualityTrendTracker.js

class QualityTrendTracker {
  constructor(pgPool) {
    this.pool = pgPool;
  }

  async saveSnapshot(analysisResults) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const snapshotResult = await client.query(`
        INSERT INTO code_quality_snapshots (
          snapshot_date, total_files, total_lines, avg_complexity
        ) VALUES (NOW(), $1, $2, $3) RETURNING id
      `, [analysisResults.summary.totalFiles, analysisResults.summary.totalLines, 
          analysisResults.summary.avgComplexity]);
      await client.query('COMMIT');
      return snapshotResult.rows[0].id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = QualityTrendTracker;
```

### 4.4 技术债积分系统

```javascript
// backend/shared/codeQuality/TechnicalDebtScore.js

class TechnicalDebtScore {
  constructor() {
    this.rules = {
      'high-complexity': { points: 5, description: '圈复杂度 > 15' },
      'low-maintainability': { points: 4, description: '可维护性指数 < 65' },
      'long-function': { points: 3, description: '函数长度 > 50 行' },
      'deep-nesting': { points: 3, description: '嵌套深度 > 4' },
      'no-tests': { points: 4, description: '缺少单元测试' }
    };
  }

  calculate(analysisResults, testCoverage) {
    const debt = { totalScore: 0, breakdown: {}, files: [] };
    for (const file of analysisResults.files) {
      const fileDebt = this.calculateFileDebt(file, testCoverage[file.path]);
      if (fileDebt.score > 0) {
        debt.files.push({ path: file.path, score: fileDebt.score });
        debt.totalScore += fileDebt.score;
      }
    }
    debt.healthScore = Math.max(0, 100 - debt.totalScore / analysisResults.summary.totalFiles);
    return debt;
  }
}

module.exports = TechnicalDebtScore;
```

### 4.5 数据库迁移

```sql
-- migrations/code_quality_tables.sql

CREATE TABLE code_quality_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_date TIMESTAMP NOT NULL,
  total_files INTEGER NOT NULL,
  total_lines INTEGER NOT NULL,
  avg_complexity DECIMAL(10, 2) NOT NULL,
  avg_maintainability_index DECIMAL(10, 2) NOT NULL,
  high_complexity_files_count INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE refactoring_recommendations (
  id SERIAL PRIMARY KEY,
  file_path VARCHAR(500) NOT NULL,
  priority DECIMAL(10, 3) NOT NULL,
  reasons JSONB NOT NULL,
  suggested_actions JSONB NOT NULL,
  estimated_effort_hours INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);
```

## 5. 验收标准（可测试）

- [ ] `CodeComplexityAnalyzer.analyzeFile()` 成功分析单个文件并返回复杂度指标
- [ ] 圈复杂度计算准确（if/while/for/case 各增加 1）
- [ ] 认知复杂度计算准确（嵌套结构额外增加复杂度）
- [ ] `RefactoringRecommender.generateRecommendations()` 返回按优先级排序的重构建议
- [ ] 重构优先级分数计算正确（基于复杂度、修改频率、Bug 历史、测试覆盖率）
- [ ] `QualityTrendTracker.saveSnapshot()` 成功保存质量快照到数据库
- [ ] `TechnicalDebtScore.calculate()` 返回技术债积分和健康度评分
- [ ] GitHub Actions 工作流在 PR 中自动运行质量检查
- [ ] Admin Dashboard 展示代码质量趋势图表
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**L - 大工作量**
- CodeComplexityAnalyzer 分析器：3 小时
- RefactoringRecommender 推荐引擎：2 小时
- QualityTrendTracker 趋势追踪：2 小时
- TechnicalDebtScore 积分系统：1.5 小时
- 数据库迁移与模型：1 小时
- GitHub Actions 集成：1.5 小时
- Admin Dashboard 页面：2 小时
- 单元测试：3 小时

总计约 16 小时，需 2 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **技术债管理基础**：代码质量度量是项目管理的重要基础，影响长期维护成本
2. **数据驱动决策**：为重构优先级提供量化依据，避免主观判断
3. **预防机制**：PR 阶段的质量检查可防止代码腐化
4. **成熟度提升**：完成后"文档与开发者体验"维度可提升至 8 分
5. **团队协作**：统一的代码质量标准有助于团队认知一致

此需求是项目长期健康发展的必要保障，为后续技术债清理提供决策支持。
