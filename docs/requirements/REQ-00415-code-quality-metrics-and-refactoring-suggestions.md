# REQ-00415: 代码质量度量与重构建议系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00415 |
| 标题 | 代码质量度量与重构建议系统 |
| 类别 | 技术债/重构 |
| 优先级 | P2 |
| 状态 | new |
| 涉及服务 | shared/analyzer、admin-dashboard、github-actions |
| 创建时间 | 2026-07-01 17:00 |

## 需求描述

建立一套完整的代码质量度量体系，自动分析代码库健康状况，并生成重构建议报告。帮助团队识别技术债热点、追踪代码腐化趋势、优先处理高风险区域。

### 核心目标

1. **量化代码质量** - 多维度指标（复杂度、耦合度、覆盖率、重复率等）
2. **识别技术债热点** - 定位高优先级重构目标
3. **生成重构建议** - 基于最佳实践提供具体改进方案
4. **趋势追踪** - 监控质量变化，预防代码腐化
5. **集成 CI/CD** - PR 级别质量门禁

### 业务价值

- 降低维护成本：提前识别问题区域，减少后期修复代价
- 加速开发效率：新开发者快速理解代码结构
- 提升代码可维护性：系统性处理技术债而非零散修复
- 量化技术债 ROI：为重构投入提供数据支撑

## 技术方案

### 1. 代码质量度量引擎 (shared/analyzer)

```typescript
// shared/analyzer/src/metrics/index.ts

export interface CodeQualityMetrics {
  // 复杂度指标
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  nestingDepth: number;
  
  // 耦合度指标
  couplingBetweenObjects: number;
  lackOfCohesion: number;
  afferentCoupling: number;
  efferentCoupling: number;
  
  // 规模指标
  linesOfCode: number;
  numberOfMethods: number;
  numberOfClasses: number;
  
  // 质量指标
  codeDuplication: number;
  testCoverage: number;
  technicalDebtRatio: number;
  maintainabilityIndex: number;
}

export class QualityAnalyzer {
  private parsers: Map<string, LanguageParser>;
  private rules: QualityRule[];
  
  async analyzeRepository(repoPath: string): Promise<QualityReport> {
    const files = await this.discoverFiles(repoPath);
    const metrics: FileMetrics[] = [];
    
    for (const file of files) {
      const parser = this.getParser(file.extension);
      const ast = await parser.parse(file.content);
      const fileMetrics = await this.analyzeFile(ast, file);
      metrics.push(fileMetrics);
    }
    
    return this.aggregateMetrics(metrics);
  }
  
  private async analyzeFile(ast: ASTNode, file: FileInfo): Promise<FileMetrics> {
    return {
      file: file.path,
      metrics: {
        cyclomaticComplexity: this.calculateCyclomaticComplexity(ast),
        cognitiveComplexity: this.calculateCognitiveComplexity(ast),
        codeDuplication: await this.detectDuplication(file),
        // ... 其他指标
      },
      issues: await this.detectIssues(ast, file),
      suggestions: this.generateSuggestions(ast, file)
    };
  }
}
```

### 2. 技术债评分模型

```typescript
// shared/analyzer/src/scoring/debt-scorer.ts

export class TechnicalDebtScorer {
  
  /**
   * SQALE 方法计算技术债
   * Technical Debt = Remediation Effort (hours) × Development Cost (€/hour)
   */
  calculateDebtScore(metrics: CodeQualityMetrics): DebtAssessment {
    const remediationEfforts: RemediationItem[] = [
      {
        category: 'complexity',
        effort: this.estimateComplexityReduction(metrics.cyclomaticComplexity),
        priority: metrics.cyclomaticComplexity > 20 ? 'high' : 'medium'
      },
      {
        category: 'duplication',
        effort: this.estimateDeduplication(metrics.codeDuplication),
        priority: metrics.codeDuplication > 5 ? 'high' : 'low'
      },
      {
        category: 'coverage',
        effort: this.estimateCoverageImprovement(metrics.testCoverage),
        priority: metrics.testCoverage < 60 ? 'high' : 'low'
      }
    ];
    
    const totalEffort = remediationEfforts.reduce((sum, item) => sum + item.effort, 0);
    
    return {
      totalDebtHours: totalEffort,
      debtRatio: totalEffort / (metrics.linesOfCode / 1000),
      remediationItems: remediationEfforts,
      riskLevel: this.calculateRiskLevel(totalEffort, metrics)
    };
  }
  
  private calculateRiskLevel(effort: number, metrics: CodeQualityMetrics): RiskLevel {
    if (effort > 1000 || metrics.maintainabilityIndex < 20) return 'critical';
    if (effort > 500 || metrics.maintainabilityIndex < 40) return 'high';
    if (effort > 200 || metrics.maintainabilityIndex < 60) return 'medium';
    return 'low';
  }
}
```

### 3. 重构建议生成器

```typescript
// shared/analyzer/src/suggestions/refactoring-advisor.ts

export class RefactoringAdvisor {
  
  generateSuggestions(metrics: FileMetrics): RefactoringSuggestion[] {
    const suggestions: RefactoringSuggestion[] = [];
    
    // 高圈复杂度建议
    if (metrics.metrics.cyclomaticComplexity > 15) {
      suggestions.push({
        type: 'extract-method',
        severity: 'high',
        message: `函数圈复杂度 ${metrics.metrics.cyclomaticComplexity} 超过阈值 15`,
        locations: this.findComplexFunctions(metrics.ast),
        estimatedEffort: Math.ceil((metrics.metrics.cyclomaticComplexity - 10) * 0.5),
        beforeExample: this.generateBeforeExample(metrics),
        afterExample: this.generateAfterExample('extract-method'),
        references: [
          'https://refactoring.guru/extract-method',
          'Clean Code - Chapter 3'
        ]
      });
    }
    
    // 代码重复建议
    if (metrics.metrics.codeDuplication > 3) {
      suggestions.push({
        type: 'extract-class',
        severity: 'medium',
        message: `检测到 ${metrics.metrics.codeDuplication} 处代码重复`,
        locations: await this.findDuplicateBlocks(metrics.file),
        estimatedEffort: metrics.metrics.codeDuplication * 2
      });
    }
    
    // 大类建议
    if (metrics.metrics.linesOfCode > 500) {
      suggestions.push({
        type: 'extract-class',
        severity: 'medium',
        message: `文件过大 (${metrics.metrics.linesOfCode} 行)，建议拆分`,
        estimatedEffort: 4
      });
    }
    
    return this.prioritizeSuggestions(suggestions);
  }
}
```

### 4. 质量趋势追踪

```typescript
// shared/analyzer/src/trends/trend-analyzer.ts

export class QualityTrendAnalyzer {
  private storage: MetricsStorage;
  
  async recordSnapshot(repoId: string, branch: string): Promise<void> {
    const metrics = await this.analyzer.analyzeRepository(repoPath);
    await this.storage.save({
      repoId,
      branch,
      commit: await this.getCommitHash(),
      timestamp: new Date(),
      metrics: metrics.summary
    });
  }
  
  async getTrend(repoId: string, period: TrendPeriod): Promise<QualityTrend> {
    const snapshots = await this.storage.query({
      repoId,
      from: this.getStartDate(period),
      to: new Date()
    });
    
    return {
      period,
      metrics: {
        maintainabilityIndex: this.calculateTrend(snapshots, 'maintainabilityIndex'),
        technicalDebt: this.calculateTrend(snapshots, 'technicalDebtRatio'),
        testCoverage: this.calculateTrend(snapshots, 'testCoverage'),
        codeDuplication: this.calculateTrend(snapshots, 'codeDuplication')
      },
      projectedDepletion: this.projectDepletion(snapshots),
      alerts: this.detectAnomalies(snapshots)
    };
  }
  
  private detectAnomalies(snapshots: Snapshot[]): AnomalyAlert[] {
    const alerts: AnomalyAlert[] = [];
    
    // 检测质量快速下降
    const recentTrend = this.calculateTrend(snapshots.slice(-7), 'maintainabilityIndex');
    if (recentTrend.slope < -5) {
      alerts.push({
        type: 'quality-degradation',
        severity: 'warning',
        message: '近7天可维护性指数下降超过5点',
        recommendation: '检查近期合并的PR是否引入了复杂代码'
      });
    }
    
    return alerts;
  }
}
```

### 5. CI/CD 集成

```yaml
# .github/workflows/quality-gate.yml

name: Quality Gate

on:
  pull_request:
    branches: [main, develop]

jobs:
  quality-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # 需要完整历史用于比较
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install Analyzer
        run: npm install -g @minego/code-analyzer
      
      - name: Run Quality Analysis
        id: analysis
        run: |
          minego-analyze \
            --changed-files="$(git diff --name-only origin/main...HEAD)" \
            --threshold-file=".minego/quality-thresholds.json" \
            --output-format=json \
            --output-file=quality-report.json
          
          echo "debt_score=$(jq '.debtScore' quality-report.json)" >> $GITHUB_OUTPUT
          echo "passed=$(jq '.passed' quality-report.json)" >> $GITHUB_OUTPUT
      
      - name: Quality Gate Check
        if: steps.analysis.outputs.passed != 'true'
        run: |
          echo "::error::Quality gate failed. Technical debt exceeds threshold."
          jq '.failures[]' quality-report.json
          exit 1
      
      - name: Upload Report
        uses: actions/upload-artifact@v4
        with:
          name: quality-report
          path: quality-report.json
      
      - name: PR Comment
        uses: actions/github-script@v7
        with:
          script: |
            const report = require('./quality-report.json');
            const body = `## 📊 Code Quality Report
            
            | Metric | Value | Status |
            |--------|-------|--------|
            | Maintainability Index | ${report.maintainabilityIndex} | ${report.maintainabilityIndex >= 65 ? '✅' : '⚠️'} |
            | Technical Debt | ${report.debtHours}h | ${report.debtHours <= 10 ? '✅' : '⚠️'} |
            | New Duplications | ${report.newDuplications} | ${report.newDuplications === 0 ? '✅' : '⚠️'} |
            
            ${report.suggestions.length > 0 ? '### 📝 Suggestions\n' + report.suggestions.map(s => `- [${s.severity}] ${s.message}`).join('\n') : ''}
            `;
            
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body
            });
```

### 6. 管理后台仪表板 (admin-dashboard)

```typescript
// admin-dashboard/src/pages/quality-dashboard/index.tsx

export function QualityDashboard() {
  const { data: qualityData } = useQuery(['quality', 'overview'], 
    () => fetch('/api/quality/overview').then(r => r.json())
  );
  
  const { data: trends } = useQuery(['quality', 'trends'],
    () => fetch('/api/quality/trends?period=30d').then(r => r.json())
  );
  
  return (
    <DashboardLayout>
      <Grid container spacing={3}>
        {/* 总览卡片 */}
        <Grid item xs={12} md={3}>
          <MetricCard
            title="可维护性指数"
            value={qualityData?.maintainabilityIndex ?? 0}
            unit="/100"
            trend={trends?.maintainabilityTrend}
            threshold={{ warning: 50, critical: 30 }}
          />
        </Grid>
        
        <Grid item xs={12} md={3}>
          <MetricCard
            title="技术债"
            value={qualityData?.debtHours ?? 0}
            unit="小时"
            trend={trends?.debtTrend}
            inverseColor
          />
        </Grid>
        
        {/* 趋势图表 */}
        <Grid item xs={12}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6">质量趋势 (30天)</Typography>
            <LineChart
              data={trends?.daily}
              xField="date"
              yFields={['maintainabilityIndex', 'debtRatio', 'coverage']}
            />
          </Paper>
        </Grid>
        
        {/* 热点文件 */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6">热点文件 TOP 10</Typography>
            <HotspotsTable data={qualityData?.hotspots} />
          </Paper>
        </Grid>
        
        {/* 重构建议 */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6">优先重构建议</Typography>
            <SuggestionsList 
              suggestions={qualityData?.suggestions}
              onAccept={handleAcceptSuggestion}
            />
          </Paper>
        </Grid>
      </Grid>
    </DashboardLayout>
  );
}
```

### 7. API 端点

```typescript
// admin-dashboard/src/api/quality.ts

router.get('/api/quality/overview', async (req, res) => {
  const overview = await qualityService.getOverview();
  res.json({
    maintainabilityIndex: overview.maintainabilityIndex,
    debtHours: overview.totalDebtHours,
    debtRatio: overview.debtRatio,
    testCoverage: overview.avgCoverage,
    codeDuplication: overview.duplicationPercent,
    hotspots: overview.topHotspots,
    suggestions: overview.prioritizedSuggestions
  });
});

router.get('/api/quality/file/:path', async (req, res) => {
  const metrics = await qualityService.getFileMetrics(req.params.path);
  res.json(metrics);
});

router.get('/api/quality/trends', async (req, res) => {
  const period = req.query.period || '30d';
  const trends = await qualityService.getTrends(period);
  res.json(trends);
});

router.post('/api/quality/snapshot', authenticateAdmin, async (req, res) => {
  await qualityService.recordSnapshot();
  res.json({ status: 'ok' });
});
```

## 验收标准

- [ ] 圈复杂度分析准确率 ≥ 95%
- [ ] 代码重复检测准确率 ≥ 90%
- [ ] 技术债估算与实际修复时间偏差 ≤ 30%
- [ ] 重构建议具体可执行（包含代码位置和示例）
- [ ] CI/CD 质量门禁正常工作
- [ ] 管理后台仪表板显示完整质量数据
- [ ] 趋势追踪保留 180 天历史数据
- [ ] 单次全量分析耗时 ≤ 5 分钟（10 万行代码）
- [ ] PR 增量分析耗时 ≤ 30 秒
- [ ] 提供质量报告导出功能（PDF/JSON）

## 影响范围

### 新增文件
- `shared/analyzer/` - 质量分析器核心
- `admin-dashboard/src/pages/quality-dashboard/` - 管理后台仪表板
- `.github/workflows/quality-gate.yml` - CI 质量门禁

### 修改文件
- `shared/package.json` - 添加 analyzer 包
- `admin-dashboard/src/api/` - 新增质量 API 端点
- 各服务的 `.eslintrc.js` - 集成质量规则

## 参考

- [SQALE 方法论](http://www.sqale.org/)
- [SonarQube 技术债计算](https://docs.sonarqube.org/latest/user-guide/metric-definitions/)
- [重构：改善既有代码的设计](https://book.douban.com/subject/4262627/)
- [代码整洁之道](https://book.douban.com/subject/4197842/)
- Understand 团队质量度量最佳实践
