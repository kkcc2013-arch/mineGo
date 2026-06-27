# REQ-00330：代码质量度量系统与自动化重构建议引擎

- **编号**：REQ-00330
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared、所有微服务、.github/workflows、admin-dashboard、scripts
- **创建时间**：2026-06-26 01:00 UTC
- **依赖需求**：无

## 1. 背景与问题

mineGo 项目经过长期迭代，已积累大量代码：

- **代码规模**：4435 个 JavaScript 文件，后端服务总计 50,235 行代码
- **测试覆盖不足**：仅有 263 个测试文件，覆盖率约 5.9%，远低于生产标准的 80%
- **大文件问题**：多个文件超过 800 行（tradeFraudDetection.js 1032 行、deviceIntegrity.js 1013 行、pokemonBackupService.js 1005 行）
- **代码重复**：缺少自动化的重复代码检测机制
- **技术债累积**：部分代码存在 TODO/FIXME 标记但缺乏跟踪系统
- **重构缺乏依据**：无法量化代码质量，难以确定重构优先级

当前问题：
1. **缺少代码质量度量**：无法量化技术债的严重程度
2. **重构决策困难**：不知道哪些模块最需要重构
3. **代码评审效率低**：缺少自动化质量检查报告
4. **技术债蔓延风险**：缺少预防机制，质量持续下降

## 2. 目标

建立自动化的代码质量度量与重构建议系统，实现：

1. **量化代码质量**：为每个服务和模块生成质量评分（0-100）
2. **识别重构目标**：自动检测高优先级重构候选（大文件、高复杂度、重复代码）
3. **生成重构建议**：提供具体的重构方案和预估工作量
4. **CI/CD 集成**：在 PR 中自动生成质量报告，防止新增技术债
5. **趋势追踪**：跟踪代码质量随时间的变化趋势

预期收益：
- 重构效率提升 50%（有明确的优先级和数据支撑）
- 代码评审时间减少 30%（自动化质量检查）
- 技术债增长率降低 70%（预防机制）
- 6 个月内测试覆盖率提升至 40%

## 3. 范围

### 包含：
- 代码复杂度分析引擎（圈复杂度、认知复杂度、嵌套深度）
- 代码重复检测系统（CPD - Copy/Paste Detector）
- 大文件检测与拆分建议生成器
- 测试覆盖率追踪与缺口分析
- 代码质量评分系统（多维度加权评分）
- 重构建议生成器（基于启发式规则和最佳实践）
- CI/CD 集成脚本（GitHub Actions 自动化检查）
- Admin Dashboard 质量监控页面
- 质量趋势图表与历史对比
- 技术债跟踪系统（TODO/FIXME 自动提取与状态跟踪）

### 不包含：
- 自动代码重构工具（仅提供建议）
- 代码格式化工具（Prettier 已存在）
- 语法错误检测（ESLint 已覆盖）
- 性能优化建议（属于 REQ-00325 等性能需求）

## 4. 详细需求

### 4.1 代码复杂度分析引擎

#### 4.1.1 圈复杂度计算
```javascript
// backend/shared/codeQuality/cyclomaticComplexity.js
class CyclomaticComplexityAnalyzer {
  /**
   * 计算函数的圈复杂度
   * 公式: M = E - N + 2P
   * E: 控制流图的边数
   * N: 控制流图的节点数
   * P: 连接组件数（通常为 1）
   */
  analyze(filePath) {
    const ast = this.parseFile(filePath);
    const functions = this.extractFunctions(ast);
    
    return functions.map(fn => ({
      name: fn.name,
      line: fn.loc.start.line,
      complexity: this.calculateComplexity(fn),
      rating: this.getComplexityRating(complexity)
    }));
  }
  
  getComplexityRating(complexity) {
    if (complexity <= 10) return 'A'; // 简单
    if (complexity <= 20) return 'B'; // 中等
    if (complexity <= 50) return 'C'; // 复杂
    return 'D'; // 非常复杂，需要重构
  }
}
```

#### 4.1.2 认知复杂度计算
```javascript
// backend/shared/codeQuality/cognitiveComplexity.js
class CognitiveComplexityAnalyzer {
  /**
   * 计算认知复杂度（更贴近人类理解的复杂度度量）
   * 规则：
   * - 嵌套结构：每层 +1
   * - 控制流中断（break/continue/return）：+1
   * - 逻辑运算符：+1
   * - 三元运算符：+1
   */
  analyze(filePath) {
    // 实现认知复杂度计算
  }
}
```

#### 4.1.3 嵌套深度分析
```javascript
// backend/shared/codeQuality/nestingDepth.js
class NestingDepthAnalyzer {
  /**
   * 检测过深的嵌套（推荐最大深度：4）
   */
  analyze(filePath) {
    const issues = [];
    const ast = this.parseFile(filePath);
    
    this.traverse(ast, (node, depth) => {
      if (depth > 4) {
        issues.push({
          line: node.loc.start.line,
          depth,
          message: `嵌套深度 ${depth} 超过推荐值 4`
        });
      }
    });
    
    return issues;
  }
}
```

### 4.2 代码重复检测系统

#### 4.2.1 CPD 集成
```javascript
// backend/shared/codeQuality/duplicateDetector.js
class DuplicateCodeDetector {
  constructor(config = {}) {
    this.minLines = config.minLines || 10; // 最小重复行数
    this.minTokens = config.minTokens || 50; // 最小重复 token 数
  }
  
  /**
   * 检测代码重复
   * 使用 PMD CPD (Copy/Paste Detector) 算法
   */
  async detectDuplicates(directory) {
    const files = await this.getAllJsFiles(directory);
    const tokens = await Promise.all(
      files.map(f => this.tokenize(f))
    );
    
    const duplicates = this.findDuplicates(tokens);
    
    return {
      totalFiles: files.length,
      duplicateGroups: duplicates.length,
      duplicatedLines: this.sumDuplicatedLines(duplicates),
      duplicates: duplicates.map(d => ({
        files: d.files,
        lines: d.lineCount,
        tokens: d.tokenCount,
        similarity: d.similarity
      }))
    };
  }
  
  /**
   * 计算重复代码百分比
   */
  calculateDuplicationPercentage(duplicates, totalLines) {
    const duplicatedLines = this.sumDuplicatedLines(duplicates);
    return (duplicatedLines / totalLines * 100).toFixed(2);
  }
}
```

### 4.3 大文件检测与拆分建议

#### 4.3.1 文件规模分析
```javascript
// backend/shared/codeQuality/fileSizeAnalyzer.js
class FileSizeAnalyzer {
  constructor(config = {}) {
    this.maxLines = config.maxLines || 500; // 推荐最大行数
    this.maxFunctions = config.maxFunctions || 20; // 推荐最大函数数
  }
  
  analyze(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').length;
    const ast = this.parseFile(filePath);
    const functions = this.extractFunctions(ast);
    const classes = this.extractClasses(ast);
    const imports = this.extractImports(ast);
    
    const issues = [];
    
    if (lines > this.maxLines) {
      issues.push({
        type: 'FILE_TOO_LARGE',
        severity: lines > 1000 ? 'HIGH' : 'MEDIUM',
        message: `文件 ${lines} 行超过推荐值 ${this.maxLines}`,
        recommendation: this.generateSplitRecommendation(filePath, functions, classes)
      });
    }
    
    if (functions.length > this.maxFunctions) {
      issues.push({
        type: 'TOO_MANY_FUNCTIONS',
        severity: 'MEDIUM',
        message: `文件包含 ${functions.length} 个函数超过推荐值 ${this.maxFunctions}`,
        recommendation: '考虑拆分为多个模块'
      });
    }
    
    return {
      filePath,
      lines,
      functions: functions.length,
      classes: classes.length,
      imports: imports.length,
      issues
    };
  }
  
  /**
   * 生成拆分建议
   */
  generateSplitRecommendation(filePath, functions, classes) {
    const recommendations = [];
    
    // 按功能分组建议
    const functionGroups = this.groupFunctionsByFeature(functions);
    recommendations.push({
      action: 'SPLIT_BY_FEATURE',
      description: '按功能拆分为独立模块',
      groups: functionGroups
    });
    
    // 按类拆分建议
    if (classes.length > 1) {
      recommendations.push({
        action: 'SPLIT_BY_CLASS',
        description: '每个类拆分为独立文件',
        files: classes.map(c => `${c.name}.js`)
      });
    }
    
    return recommendations;
  }
}
```

### 4.4 测试覆盖率追踪

#### 4.4.1 覆盖率收集与分析
```javascript
// backend/shared/codeQuality/coverageTracker.js
class CoverageTracker {
  /**
   * 收集测试覆盖率数据
   */
  async collectCoverage(servicePath) {
    const coveragePath = path.join(servicePath, 'coverage/coverage-final.json');
    
    if (!fs.existsSync(coveragePath)) {
      return null;
    }
    
    const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
    
    return {
      lines: this.calculateLineCoverage(coverage),
      functions: this.calculateFunctionCoverage(coverage),
      branches: this.calculateBranchCoverage(coverage),
      statements: this.calculateStatementCoverage(coverage),
      uncoveredFiles: this.findUncoveredFiles(coverage)
    };
  }
  
  /**
   * 分析覆盖缺口
   */
  analyzeCoverageGaps(coverage) {
    const gaps = [];
    
    for (const [file, data] of Object.entries(coverage)) {
      const uncoveredLines = this.getUncoveredLines(data);
      const uncoveredBranches = this.getUncoveredBranches(data);
      
      if (uncoveredLines.length > 0 || uncoveredBranches.length > 0) {
        gaps.push({
          file,
          uncoveredLines: uncoveredLines.length,
          uncoveredBranches: uncoveredBranches.length,
          priority: this.prioritizeGap(file, uncoveredLines, uncoveredBranches)
        });
      }
    }
    
    return gaps.sort((a, b) => b.priority - a.priority);
  }
  
  /**
   * 优先级计算（业务关键文件优先）
   */
  prioritizeGap(file, uncoveredLines, uncoveredBranches) {
    let priority = 0;
    
    // 业务关键路径加分
    if (file.includes('payment') || file.includes('catch') || file.includes('gym')) {
      priority += 50;
    }
    
    // 未覆盖代码量加分
    priority += Math.min(uncoveredLines / 10, 30);
    
    // 分支覆盖率影响
    priority += Math.min(uncoveredBranches / 5, 20);
    
    return priority;
  }
}
```

### 4.5 代码质量评分系统

#### 4.5.1 多维度评分
```javascript
// backend/shared/codeQuality/qualityScorer.js
class QualityScorer {
  constructor() {
    this.weights = {
      complexity: 0.25,     // 复杂度评分
      duplication: 0.20,    // 重复代码评分
      coverage: 0.20,       // 测试覆盖率评分
      fileSize: 0.15,       // 文件大小评分
      maintainability: 0.20 // 可维护性评分
    };
  }
  
  /**
   * 计算服务代码质量评分
   */
  async scoreService(servicePath) {
    const metrics = {
      complexity: await this.scoreComplexity(servicePath),
      duplication: await this.scoreDuplication(servicePath),
      coverage: await this.scoreCoverage(servicePath),
      fileSize: await this.scoreFileSize(servicePath),
      maintainability: await this.scoreMaintainability(servicePath)
    };
    
    const overallScore = Object.entries(metrics).reduce((total, [key, score]) => {
      return total + score * this.weights[key];
    }, 0);
    
    return {
      service: path.basename(servicePath),
      overallScore: Math.round(overallScore),
      metrics,
      grade: this.getGrade(overallScore),
      recommendations: this.generateRecommendations(metrics)
    };
  }
  
  /**
   * 评分转等级
   */
  getGrade(score) {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }
  
  /**
   * 复杂度评分（0-100）
   */
  async scoreComplexity(servicePath) {
    const analyzer = new CyclomaticComplexityAnalyzer();
    const files = await this.getAllJsFiles(servicePath);
    
    let totalComplexity = 0;
    let functionCount = 0;
    
    for (const file of files) {
      const results = analyzer.analyze(file);
      for (const fn of results) {
        totalComplexity += fn.complexity;
        functionCount++;
      }
    }
    
    const avgComplexity = functionCount > 0 ? totalComplexity / functionCount : 0;
    
    // 平均复杂度 <= 10 得 100 分
    // 平均复杂度 >= 50 得 0 分
    if (avgComplexity <= 10) return 100;
    if (avgComplexity >= 50) return 0;
    return Math.round(100 - (avgComplexity - 10) * 2.5);
  }
  
  /**
   * 重复代码评分（0-100）
   */
  async scoreDuplication(servicePath) {
    const detector = new DuplicateCodeDetector();
    const result = await detector.detectDuplicates(servicePath);
    
    // 重复率 0% 得 100 分
    // 重复率 20% 得 0 分
    const duplicationRate = result.duplicatedLines / result.totalLines;
    if (duplicationRate === 0) return 100;
    if (duplicationRate >= 0.20) return 0;
    return Math.round(100 - duplicationRate * 500);
  }
  
  /**
   * 测试覆盖率评分（0-100）
   */
  async scoreCoverage(servicePath) {
    const tracker = new CoverageTracker();
    const coverage = await tracker.collectCoverage(servicePath);
    
    if (!coverage) return 0; // 无覆盖率数据
    
    // 直接使用行覆盖率作为评分
    return Math.round(coverage.lines.percentage);
  }
  
  /**
   * 文件大小评分（0-100）
   */
  async scoreFileSize(servicePath) {
    const analyzer = new FileSizeAnalyzer();
    const files = await this.getAllJsFiles(servicePath);
    
    let score = 100;
    
    for (const file of files) {
      const result = analyzer.analyze(file);
      
      // 每个大文件扣分
      for (const issue of result.issues) {
        if (issue.type === 'FILE_TOO_LARGE') {
          score -= issue.severity === 'HIGH' ? 5 : 2;
        }
      }
    }
    
    return Math.max(0, score);
  }
  
  /**
   * 可维护性评分（0-100）
   */
  async scoreMaintainability(servicePath) {
    // 基于多个因素：
    // - 注释覆盖率
    // - 函数长度
    // - 参数数量
    // - 依赖数量
    
    const files = await this.getAllJsFiles(servicePath);
    let totalScore = 0;
    
    for (const file of files) {
      const maintainabilityIndex = await this.calculateMaintainabilityIndex(file);
      totalScore += maintainabilityIndex;
    }
    
    return Math.round(totalScore / files.length);
  }
}
```

### 4.6 重构建议生成器

#### 4.6.1 智能重构建议
```javascript
// backend/shared/codeQuality/refactoringAdvisor.js
class RefactoringAdvisor {
  /**
   * 生成重构建议
   */
  async generateRecommendations(servicePath) {
    const scorer = new QualityScorer();
    const score = await scorer.scoreService(servicePath);
    
    const recommendations = [];
    
    // 基于评分生成建议
    if (score.metrics.complexity < 70) {
      recommendations.push({
        priority: 'HIGH',
        type: 'COMPLEXITY_REDUCTION',
        title: '降低代码复杂度',
        description: '检测到高复杂度函数，建议拆分',
        affectedFiles: await this.findHighComplexityFiles(servicePath),
        effort: 'M',
        impact: '提升可读性和可维护性'
      });
    }
    
    if (score.metrics.duplication < 70) {
      recommendations.push({
        priority: 'HIGH',
        type: 'DUPLICATION_REMOVAL',
        title: '消除重复代码',
        description: '检测到代码重复，建议提取公共模块',
        affectedFiles: await this.findDuplicateCodeFiles(servicePath),
        effort: 'S',
        impact: '减少维护成本，降低 bug 风险'
      });
    }
    
    if (score.metrics.coverage < 50) {
      recommendations.push({
        priority: 'MEDIUM',
        type: 'COVERAGE_IMPROVEMENT',
        title: '提升测试覆盖率',
        description: `当前覆盖率 ${score.metrics.coverage}%，建议提升至 80%`,
        affectedFiles: await this.findLowCoverageFiles(servicePath),
        effort: 'L',
        impact: '提高代码质量信心，减少回归 bug'
      });
    }
    
    if (score.metrics.fileSize < 70) {
      recommendations.push({
        priority: 'MEDIUM',
        type: 'FILE_SPLIT',
        title: '拆分大文件',
        description: '检测到过大的文件，建议按功能拆分',
        affectedFiles: await this.findLargeFiles(servicePath),
        effort: 'M',
        impact: '提高代码可读性和模块化程度'
      });
    }
    
    return recommendations.sort((a, b) => {
      const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }
  
  /**
   * 估算重构工作量
   */
  estimateEffort(recommendations) {
    const effortMap = { S: 1, M: 3, L: 5, XL: 10 };
    const totalPoints = recommendations.reduce((sum, r) => {
      return sum + effortMap[r.effort];
    }, 0);
    
    // 假设每个点对应 2 小时工作量
    const estimatedHours = totalPoints * 2;
    
    return {
      totalPoints,
      estimatedHours,
      estimatedDays: Math.ceil(estimatedHours / 8),
      breakdown: this.breakdownByType(recommendations)
    };
  }
}
```

### 4.7 CI/CD 集成

#### 4.7.1 GitHub Actions 工作流
```yaml
# .github/workflows/code-quality.yml
name: Code Quality Check

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

jobs:
  quality-check:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run code quality analysis
        run: node scripts/codeQualityAnalyzer.js
      
      - name: Generate quality report
        run: node scripts/generateQualityReport.js --format markdown > quality-report.md
      
      - name: Comment PR with quality report
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = fs.readFileSync('quality-report.md', 'utf8');
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: report
            });
      
      - name: Upload quality metrics
        uses: actions/upload-artifact@v4
        with:
          name: quality-metrics
          path: quality-metrics.json
      
      - name: Check quality gates
        run: |
          node scripts/checkQualityGates.js || exit 1
```

#### 4.7.2 质量门禁检查
```javascript
// scripts/checkQualityGates.js
const qualityGates = {
  minOverallScore: 60,       // 最低总体评分
  maxComplexity: 20,         // 最大圈复杂度
  maxDuplication: 10,        // 最大重复率 %
  minCoverage: 30,           // 最低覆盖率 %
  maxFileSize: 1000          // 最大文件行数
};

async function checkGates() {
  const report = await loadQualityReport();
  const violations = [];
  
  if (report.overallScore < qualityGates.minOverallScore) {
    violations.push(`总体评分 ${report.overallScore} < ${qualityGates.minOverallScore}`);
  }
  
  if (report.maxComplexity > qualityGates.maxComplexity) {
    violations.push(`最大复杂度 ${report.maxComplexity} > ${qualityGates.maxComplexity}`);
  }
  
  if (report.duplicationRate > qualityGates.maxDuplication) {
    violations.push(`重复率 ${report.duplicationRate}% > ${qualityGates.maxDuplication}%`);
  }
  
  if (report.coverage < qualityGates.minCoverage) {
    violations.push(`覆盖率 ${report.coverage}% < ${qualityGates.minCoverage}%`);
  }
  
  if (report.maxFileSize > qualityGates.maxFileSize) {
    violations.push(`最大文件 ${report.maxFileSize} 行 > ${qualityGates.maxFileSize} 行`);
  }
  
  if (violations.length > 0) {
    console.error('❌ 质量门禁检查失败:');
    violations.forEach(v => console.error(`  - ${v}`));
    process.exit(1);
  }
  
  console.log('✅ 质量门禁检查通过');
}
```

### 4.8 Admin Dashboard 监控页面

#### 4.8.1 数据库表结构
```sql
-- 数据库迁移文件
CREATE TABLE code_quality_metrics (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  overall_score INTEGER NOT NULL,
  complexity_score INTEGER NOT NULL,
  duplication_score INTEGER NOT NULL,
  coverage_score INTEGER NOT NULL,
  file_size_score INTEGER NOT NULL,
  maintainability_score INTEGER NOT NULL,
  total_files INTEGER NOT NULL,
  total_lines INTEGER NOT NULL,
  total_functions INTEGER NOT NULL,
  avg_complexity DECIMAL(5,2) NOT NULL,
  duplication_rate DECIMAL(5,2) NOT NULL,
  coverage_percentage DECIMAL(5,2) NOT NULL,
  scan_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  commit_hash VARCHAR(40),
  branch VARCHAR(100)
);

CREATE TABLE code_quality_issues (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  issue_type VARCHAR(50) NOT NULL, -- COMPLEXITY, DUPLICATION, SIZE, COVERAGE
  severity VARCHAR(20) NOT NULL, -- HIGH, MEDIUM, LOW
  line_number INTEGER,
  message TEXT NOT NULL,
  recommendation TEXT,
  status VARCHAR(20) DEFAULT 'open', -- open, in_progress, resolved
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  scan_id INTEGER REFERENCES code_quality_metrics(id)
);

CREATE TABLE refactoring_recommendations (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  priority VARCHAR(20) NOT NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  affected_files TEXT[],
  estimated_effort VARCHAR(10), -- S, M, L, XL
  estimated_hours INTEGER,
  impact TEXT,
  status VARCHAR(20) DEFAULT 'pending', -- pending, in_progress, completed
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX idx_quality_metrics_service ON code_quality_metrics(service_name, scan_timestamp DESC);
CREATE INDEX idx_quality_issues_service ON code_quality_issues(service_name, status);
CREATE INDEX idx_refactoring_status ON refactoring_recommendations(status, priority);
```

#### 4.8.2 Dashboard API 端点
```javascript
// backend/gateway/src/routes/codeQuality.js
router.get('/api/v1/code-quality/services', async (req, res) => {
  const services = await db.query(`
    SELECT DISTINCT ON (service_name) 
      service_name, overall_score, grade, scan_timestamp
    FROM code_quality_metrics
    ORDER BY service_name, scan_timestamp DESC
  `);
  
  res.json({ services });
});

router.get('/api/v1/code-quality/services/:serviceName', async (req, res) => {
  const { serviceName } = req.params;
  
  const latest = await db.query(`
    SELECT * FROM code_quality_metrics
    WHERE service_name = $1
    ORDER BY scan_timestamp DESC
    LIMIT 1
  `, [serviceName]);
  
  const history = await db.query(`
    SELECT scan_timestamp, overall_score, complexity_score, 
           duplication_score, coverage_score
    FROM code_quality_metrics
    WHERE service_name = $1
    ORDER BY scan_timestamp DESC
    LIMIT 30
  `, [serviceName]);
  
  const issues = await db.query(`
    SELECT * FROM code_quality_issues
    WHERE service_name = $1 AND status = 'open'
    ORDER BY severity, created_at DESC
    LIMIT 20
  `, [serviceName]);
  
  res.json({ latest, history, issues });
});

router.get('/api/v1/code-quality/trends', async (req, res) => {
  const { days = 30 } = req.query;
  
  const trends = await db.query(`
    SELECT 
      DATE(scan_timestamp) as date,
      AVG(overall_score) as avg_score,
      AVG(coverage_percentage) as avg_coverage,
      AVG(duplication_rate) as avg_duplication
    FROM code_quality_metrics
    WHERE scan_timestamp > NOW() - INTERVAL '${days} days'
    GROUP BY DATE(scan_timestamp)
    ORDER BY date
  `);
  
  res.json({ trends });
});
```

### 4.9 技术债跟踪系统

#### 4.9.1 TODO/FIXME 自动提取
```javascript
// backend/shared/codeQuality/techDebtScanner.js
class TechDebtScanner {
  constructor() {
    this.patterns = [
      /TODO\(([^)]+)\):\s*(.+)/gi,
      /FIXME:\s*(.+)/gi,
      /HACK:\s*(.+)/gi,
      /XXX:\s*(.+)/gi,
      /BUG\(([^)]+)\):\s*(.+)/gi
    ];
  }
  
  /**
   * 扫描代码中的技术债标记
   */
  async scanDirectory(directory) {
    const files = await this.getAllJsFiles(directory);
    const debts = [];
    
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      
      lines.forEach((line, index) => {
        for (const pattern of this.patterns) {
          const matches = line.matchAll(pattern);
          for (const match of matches) {
            debts.push({
              file,
              line: index + 1,
              type: this.extractType(match[0]),
              author: match[1] || null,
              description: match[2] || match[1],
              code: line.trim(),
              priority: this.inferPriority(match[0])
            });
          }
        }
      });
    }
    
    return debts;
  }
  
  /**
   * 推断优先级
   */
  inferPriority(comment) {
    if (comment.includes('FIXME') || comment.includes('BUG')) return 'HIGH';
    if (comment.includes('HACK') || comment.includes('XXX')) return 'MEDIUM';
    return 'LOW';
  }
}
```

## 5. 验收标准（可测试）

- [ ] 代码复杂度分析引擎可正确计算所有 JavaScript 文件的圈复杂度、认知复杂度和嵌套深度
- [ ] 代码重复检测系统能检测出 10 行以上的重复代码块，重复率计算准确度 ≥ 95%
- [ ] 大文件检测器能识别超过 500 行的文件并生成拆分建议
- [ ] 测试覆盖率追踪系统能收集各服务的覆盖率数据并生成缺口报告
- [ ] 代码质量评分系统为每个服务生成 0-100 的质量评分和 A-F 等级
- [ ] 重构建议生成器能基于质量分析结果生成优先级排序的重构建议
- [ ] GitHub Actions 工作流在每次 PR 时自动运行质量检查并生成报告
- [ ] 质量门禁检查可配置阈值，低于阈值时阻止合并
- [ ] Admin Dashboard 展示各服务的质量评分、历史趋势和问题列表
- [ ] 技术债扫描器能提取代码中的 TODO/FIXME 标记并生成跟踪列表
- [ ] 所有新代码编写单元测试，覆盖率 ≥ 70%
- [ ] 文档齐全：包括使用指南、配置说明、API 文档

## 6. 工作量估算

**工作量：L（Large）**

理由：
- 需要实现多个分析引擎（复杂度、重复检测、覆盖率等）
- 需要集成到 CI/CD 流水线
- 需要创建数据库表和 API 端点
- 需要创建 Admin Dashboard 监控页面
- 需要编写完善的测试和文档

预估工时：
- 核心分析引擎：16 小时
- 评分和建议系统：8 小时
- CI/CD 集成：6 小时
- Dashboard 页面：10 小时
- 测试和文档：8 小时
- **总计：48 小时（约 6 个工作日）**

## 7. 优先级理由

**优先级：P1**

理由：
1. **技术债问题严重**：当前测试覆盖率仅 5.9%，大文件问题突出，急需量化工具
2. **重构效率低下**：缺少数据支撑，重构决策困难，影响开发效率
3. **质量把控缺失**：缺少自动化质量检查，技术债持续累积
4. **生产就绪关键**：代码质量是生产就绪的基础，直接影响系统稳定性
5. **投资回报高**：一次性投入，长期收益，可显著提升代码质量和开发效率
6. **支撑后续重构**：为后续的重构工作提供优先级依据和效果验证

该需求是技术债治理的基础设施，完成后将显著提升项目的可维护性和代码质量。
