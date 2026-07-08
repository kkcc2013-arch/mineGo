# REQ-00507：测试覆盖率自动化度量与 CI 集成系统

- **编号**：REQ-00507
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：backend/shared/testCoverage、所有后端服务、GitHub Actions、infrastructure/ci、admin-dashboard
- **创建时间**：2026-07-08 15:00
- **依赖需求**：无

## 1. 背景与问题

mineGo 项目作为一款全球化 AR 精灵捕捉手游，当前测试覆盖存在严重不足：

### 1.1 测试覆盖现状分析
通过代码审查发现：
- **测试文件数量极少**：全项目仅发现 1 个测试文件（排除 node_modules）
- **无覆盖率度量系统**：缺少 Jest/JaCoCo 等覆盖率工具集成
- **CI 未强制覆盖率门槛**：GitHub Actions 流程不检查覆盖率，低质量代码可随意合并
- **覆盖率报告缺失**：无可视化覆盖率报告，开发者无法了解覆盖缺口
- **测试类型不均衡**：单元测试极少，集成测试缺失，E2E 测试框架未落地

### 1.2 相关已有需求
- REQ-00366（微服务核心业务单元测试覆盖提升）已创建，但侧重编写测试用例
- REQ-00292（混沌测试框架）已创建，侧重可靠性测试
- REQ-00257（API回归测试系统）已完成，侧重 API 测试
- REQ-00490（API性能回归测试自动化）已完成，侧重性能测试

**缺少**：覆盖率自动化度量、CI 强制门槛、可视化报告、增量覆盖率检测。

### 1.3 风险影响
- **回归风险高**：核心功能修改后无法快速验证影响范围
- **代码质量不可控**：无覆盖率指标辅助代码评审
- **重构受阻**：缺少测试保护，大规模重构风险极高
- **成熟度评分低**：测试覆盖维度权重 10，当前得分仅 12，远低于目标 90+

## 2. 目标

构建完整的测试覆盖率自动化度量与 CI 集成系统，实现：

1. **自动化覆盖率采集**：每次 CI 构建，自动收集单元/集成测试覆盖率
2. **覆盖率可视化报告**：HTML 报告 + Dashboard 展示，支持按服务/文件/函数分析
3. **CI 强制门槛**：主分支合并要求覆盖率不低于阈值（如 60%），新代码增量覆盖率不低于阈值（如 80%）
4. **覆盖率趋势追踪**：记录历史覆盖率变化，支持趋势分析和异常预警
5. **增量覆盖率检测**：PR 仅检查变更代码的覆盖率，避免旧代码拖累新贡献
6. **覆盖率缺口分析**：自动识别未覆盖的关键代码路径，生成测试建议

## 3. 范围

### 包含
- Jest 覆盖率配置（9 个微服务 + backend/shared）
- 覆盖率数据收集服务：`TestCoverageCollector`
- 覆率率报告生成器：HTML + JSON + Badge
- GitHub Actions 覆盖率检查步骤：强制门槛 + PR 评论
- 覆盖率历史数据存储：PostgreSQL 表 + Grafana 可视化
- 增量覆盖率检测：基于 git diff 的精准覆盖率分析
- Admin Dashboard 覆盖率管理页面：阈值配置、报告查看

### 不包含
- 具体测试用例编写（REQ-00366 负责）
- E2E 测试框架实现（可后续独立需求）
- Mock/Stub 系统实现（可后续独立需求）
- 测试数据管理（可后续独立需求）

## 4. 详细需求

### 4.1 Jest 覆盖率配置

每个微服务配置 Jest 覆盖率收集：

```javascript
// backend/services/user-service/jest.config.js
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  collectCoverage: true,
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['json', 'lcov', 'text', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50
    }
  },
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!src/**/*.spec.js',
    '!src/migrations/**',
    '!src/config/**'
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js']
};
```

### 4.2 TestCoverageCollector 服务

```javascript
// backend/shared/testCoverage/TestCoverageCollector.js
'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const { createLogger } = require('../logger');

const logger = createLogger('test-coverage-collector');

class TestCoverageCollector {
  constructor() {
    this.services = [
      'gateway', 'user-service', 'location-service',
      'pokemon-service', 'catch-service', 'gym-service',
      'social-service', 'reward-service', 'payment-service'
    ];
  }

  /**
   * 收集所有服务的覆盖率数据
   * @param {string} buildId - CI 构建 ID
   * @param {string} branch - 分支名
   * @param {string} commitSha - Git commit SHA
   * @returns {object} 汇总数据
   */
  async collectAll(buildId, branch, commitSha) {
    const results = {};
    
    for (const service of this.services) {
      const coveragePath = path.join(
        process.cwd(),
        'backend/services',
        service,
        'coverage',
        'coverage-summary.json'
      );
      
      if (fs.existsSync(coveragePath)) {
        const data = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
        results[service] = this.parseCoverageData(data);
        
        // 存入数据库
        await this.saveCoverage(service, data, buildId, branch, commitSha);
      } else {
        logger.warn({ service }, 'Coverage file not found');
        results[service] = { error: 'coverage_not_found' };
      }
    }
    
    // 计算总覆盖率
    const totalCoverage = this.calculateTotalCoverage(results);
    
    // 存入汇总表
    await this.saveTotalCoverage(totalCoverage, buildId, branch, commitSha);
    
    return {
      services: results,
      total: totalCoverage,
      buildId,
      branch,
      commitSha,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 解析覆盖率数据
   */
  parseCoverageData(data) {
    const total = data.total || {};
    
    return {
      lines: total.lines?.pct || 0,
      statements: total.statements?.pct || 0,
      functions: total.functions?.pct || 0,
      branches: total.branches?.pct || 0,
      filesCovered: Object.keys(data).length - 1, // exclude 'total'
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 计算总覆盖率
   */
  calculateTotalCoverage(results) {
    const validServices = Object.values(results)
      .filter(r => !r.error);
    
    if (validServices.length === 0) {
      return { lines: 0, statements: 0, functions: 0, branches: 0 };
    }
    
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    
    return {
      lines: avg(validServices.map(s => s.lines)),
      statements: avg(validServices.map(s => s.statements)),
      functions: avg(validServices.map(s => s.functions)),
      branches: avg(validServices.map(s => s.branches)),
      servicesCovered: validServices.length,
      totalServices: Object.keys(results).length
    };
  }

  /**
   * 存储服务覆盖率
   */
  async saveCoverage(service, data, buildId, branch, commitSha) {
    const total = data.total || {};
    
    await query(`
      INSERT INTO test_coverage_records (
        service_name, build_id, branch, commit_sha,
        lines_pct, statements_pct, functions_pct, branches_pct,
        files_covered, total_lines, covered_lines,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    `, [
      service, buildId, branch, commitSha,
      total.lines?.pct || 0,
      total.statements?.pct || 0,
      total.functions?.pct || 0,
      total.branches?.pct || 0,
      Object.keys(data).length - 1,
      total.lines?.total || 0,
      total.lines?.covered || 0
    ]);
    
    logger.info({ service, buildId, lines: total.lines?.pct }, 'Coverage saved');
  }

  /**
   * 存储总覆盖率
   */
  async saveTotalCoverage(total, buildId, branch, commitSha) {
    await query(`
      INSERT INTO test_coverage_summary (
        build_id, branch, commit_sha,
        avg_lines_pct, avg_statements_pct, avg_functions_pct, avg_branches_pct,
        services_covered, total_services, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `, [
      buildId, branch, commitSha,
      total.lines, total.statements, total.functions, total.branches,
      total.servicesCovered, total.totalServices
    ]);
  }

  /**
   * 获取覆盖率历史趋势
   */
  async getHistory(service = null, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    if (service) {
      const { rows } = await query(`
        SELECT build_id, branch, lines_pct, statements_pct, functions_pct, branches_pct, created_at
        FROM test_coverage_records
        WHERE service_name = $1 AND created_at >= $2
        ORDER BY created_at DESC
        LIMIT 100
      `, [service, since]);
      
      return rows;
    }
    
    const { rows } = await query(`
      SELECT build_id, branch, avg_lines_pct, avg_statements_pct, avg_functions_pct, avg_branches_pct, created_at
      FROM test_coverage_summary
      WHERE created_at >= $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [since]);
    
    return rows;
  }

  /**
   * 获取覆盖率缺口分析
   */
  async analyzeGaps(service) {
    const coveragePath = path.join(
      process.cwd(),
      'backend/services',
      service,
      'coverage',
      'coverage-final.json'
    );
    
    if (!fs.existsSync(coveragePath)) {
      return { error: 'coverage_file_not_found' };
    }
    
    const data = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    const gaps = [];
    
    for (const [filePath, fileCoverage] of Object.entries(data)) {
      const uncoveredFunctions = [];
      const uncoveredBranches = [];
      
      // 分析未覆盖函数
      if (fileCoverage.f) {
        for (const [fnId, count] of Object.entries(fileCoverage.f)) {
          if (count === 0) {
            const fnMap = fileCoverage.fnMap[fnId];
            if (fnMap) {
              uncoveredFunctions.push({
                name: fnMap.name,
                line: fnMap.loc.start.line
              });
            }
          }
        }
      }
      
      // 分析未覆盖分支
      if (fileCoverage.b) {
        for (const [branchId, counts] of Object.entries(fileCoverage.b)) {
          const anyCovered = counts.some(c => c > 0);
          if (!anyCovered) {
            const branchMap = fileCoverage.branchMap[branchId];
            if (branchMap) {
              uncoveredBranches.push({
                type: branchMap.type,
                line: branchMap.loc.start.line
              });
            }
          }
        }
      }
      
      if (uncoveredFunctions.length > 0 || uncoveredBranches.length > 0) {
        gaps.push({
          file: filePath,
          uncoveredFunctions,
          uncoveredBranches,
          severity: this.calculateGapSeverity(fileCoverage)
        });
      }
    }
    
    // 按严重程度排序
    gaps.sort((a, b) => b.severity - a.severity);
    
    return {
      service,
      totalFiles: Object.keys(data).length,
      filesWithGaps: gaps.length,
      gaps: gaps.slice(0, 50) // 返回前 50 个缺口
    };
  }

  /**
   * 计算缺口严重程度
   */
  calculateGapSeverity(fileCoverage) {
    const lines = fileCoverage.l || {};
    const totalLines = Object.keys(lines).length;
    const coveredLines = Object.values(lines).filter(c => c > 0).length;
    
    const coverageRatio = totalLines > 0 ? coveredLines / totalLines : 0;
    
    // 未覆盖率越高，严重程度越高
    return (1 - coverageRatio) * 100;
  }
}

module.exports = TestCoverageCollector;
```

### 4.3 IncrementalCoverageAnalyzer 增量覆盖率分析

```javascript
// backend/shared/testCoverage/IncrementalCoverageAnalyzer.js
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logger');

const logger = createLogger('incremental-coverage');

class IncrementalCoverageAnalyzer {
  constructor() {
    this.threshold = {
      lines: 80,
      statements: 80,
      functions: 80,
      branches: 70
    };
  }

  /**
   * 分析 PR 的增量覆盖率
   * @param {string} baseBranch - 基础分支（如 main）
   * @param {string} headSha - PR HEAD commit SHA
   * @returns {object} 增量覆盖率结果
   */
  async analyze(baseBranch, headSha) {
    // 1. 获取变更文件列表
    const changedFiles = this.getChangedFiles(baseBranch, headSha);
    
    // 2. 筛选 JS 文件
    const jsFiles = changedFiles.filter(f => 
      f.startsWith('backend/') && 
      f.endsWith('.js') && 
      !f.includes('.test.') && 
      !f.includes('.spec.') &&
      !f.includes('node_modules')
    );
    
    if (jsFiles.length === 0) {
      return {
        hasJsChanges: false,
        message: 'No JavaScript files changed'
      };
    }
    
    // 3. 加载覆盖率数据
    const coverageData = this.loadCoverageData();
    
    // 4. 计算变更文件的覆盖率
    const fileCoverages = [];
    
    for (const file of jsFiles) {
      const coverage = this.getFileCoverage(coverageData, file);
      if (coverage) {
        fileCoverages.push({
          file,
          lines: coverage.lines,
          statements: coverage.statements,
          functions: coverage.functions,
          branches: coverage.branches,
          meetsThreshold: this.checkThreshold(coverage)
        });
      } else {
        fileCoverages.push({
          file,
          hasCoverage: false,
          message: 'No coverage data for new file'
        });
      }
    }
    
    // 5. 汇总结果
    const avgCoverage = this.calculateAverage(fileCoverages.filter(f => f.hasCoverage));
    const filesBelowThreshold = fileCoverages.filter(f => f.hasCoverage && !f.meetsThreshold);
    
    return {
      hasJsChanges: true,
      totalFiles: jsFiles.length,
      filesWithCoverage: fileCoverages.filter(f => f.hasCoverage).length,
      filesWithoutCoverage: fileCoverages.filter(f => !f.hasCoverage).length,
      averageCoverage: avgCoverage,
      filesBelowThreshold,
      passes: filesBelowThreshold.length === 0,
      threshold: this.threshold,
      fileCoverages
    };
  }

  /**
   * 获取变更文件列表
   */
  getChangedFiles(baseBranch, headSha) {
    try {
      const output = execSync(
        `git diff --name-only origin/${baseBranch} ${headSha}`,
        { encoding: 'utf8' }
      );
      
      return output.trim().split('\n').filter(f => f);
    } catch (err) {
      logger.error({ err, baseBranch, headSha }, 'Failed to get changed files');
      return [];
    }
  }

  /**
   * 加载覆盖率数据
   */
  loadCoverageData() {
    const data = {};
    const services = [
      'gateway', 'user-service', 'location-service',
      'pokemon-service', 'catch-service', 'gym-service',
      'social-service', 'reward-service', 'payment-service'
    ];
    
    for (const service of services) {
      const coveragePath = path.join(
        process.cwd(),
        'backend/services',
        service,
        'coverage',
        'coverage-final.json'
      );
      
      if (fs.existsSync(coveragePath)) {
        const serviceData = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
        
        // 合并覆盖率数据
        for (const [filePath, coverage] of Object.entries(serviceData)) {
          const normalizedPath = path.join('backend/services', service, filePath);
          data[normalizedPath] = coverage;
        }
      }
    }
    
    // backend/shared
    const sharedPath = path.join(
      process.cwd(),
      'backend/shared',
      'coverage',
      'coverage-final.json'
    );
    
    if (fs.existsSync(sharedPath)) {
      const sharedData = JSON.parse(fs.readFileSync(sharedPath, 'utf8'));
      for (const [filePath, coverage] of Object.entries(sharedData)) {
        const normalizedPath = path.join('backend/shared', filePath);
        data[normalizedPath] = coverage;
      }
    }
    
    return data;
  }

  /**
   * 获取单个文件覆盖率
   */
  getFileCoverage(coverageData, filePath) {
    const normalizedPath = path.normalize(filePath);
    const fileCoverage = coverageData[normalizedPath];
    
    if (!fileCoverage) return null;
    
    const lines = fileCoverage.l || {};
    const statements = fileCoverage.s || {};
    const functions = fileCoverage.f || {};
    const branches = fileCoverage.b || {};
    
    return {
      lines: this.calculatePercentage(lines),
      statements: this.calculatePercentage(statements),
      functions: this.calculatePercentage(Object.values(functions)),
      branches: this.calculatePercentageBranches(branches)
    };
  }

  /**
   * 计算覆盖率百分比
   */
  calculatePercentage(coverage) {
    const values = Object.values(coverage);
    if (values.length === 0) return 0;
    
    const covered = values.filter(v => v > 0).length;
    return (covered / values.length) * 100;
  }

  /**
   * 计算分支覆盖率
   */
  calculatePercentageBranches(branches) {
    const allCounts = Object.values(branches).flat();
    if (allCounts.length === 0) return 0;
    
    const covered = allCounts.filter(c => c > 0).length;
    return (covered / allCounts.length) * 100;
  }

  /**
   * 检查是否满足阈值
   */
  checkThreshold(coverage) {
    return coverage.lines >= this.threshold.lines &&
           coverage.statements >= this.threshold.statements &&
           coverage.functions >= this.threshold.functions &&
           coverage.branches >= this.threshold.branches;
  }

  /**
   * 计算平均覆盖率
   */
  calculateAverage(fileCoverages) {
    if (fileCoverages.length === 0) return null;
    
    const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    
    return {
      lines: avg(fileCoverages.map(f => f.lines)),
      statements: avg(fileCoverages.map(f => f.statements)),
      functions: avg(fileCoverages.map(f => f.functions)),
      branches: avg(fileCoverages.map(f => f.branches))
    };
  }
}

module.exports = IncrementalCoverageAnalyzer;
```

### 4.4 GitHub Actions 覆盖率检查步骤

```yaml
# .github/workflows/test-coverage.yml
name: Test Coverage Check

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

jobs:
  coverage:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests with coverage
        run: npm run test:coverage
        env:
          CI: true
      
      - name: Collect coverage data
        run: node backend/shared/testCoverage/cli.js collect --build-id ${{ github.run_id }} --branch ${{ github.ref_name }} --commit ${{ github.sha }}
      
      - name: Analyze incremental coverage
        if: github.event_name == 'pull_request'
        run: node backend/shared/testCoverage/cli.js incremental --base ${{ github.base_ref }} --head ${{ github.sha }}
        id: incremental
      
      - name: Check coverage threshold
        run: node backend/shared/testCoverage/cli.js check-threshold --min-lines 60 --min-functions 50
        id: threshold
      
      - name: Generate coverage badge
        run: node backend/shared/testCoverage/cli.js badge --output coverage-badge.svg
      
      - name: Upload coverage reports
        uses: actions/upload-artifact@v4
        with:
          name: coverage-reports
          path: |
            coverage/
            backend/services/*/coverage/
            coverage-badge.svg
      
      - name: Comment PR with coverage
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const reportPath = 'coverage/coverage-report.json';
            if (fs.existsSync(reportPath)) {
              const report = JSON.parse(fs.readFileSync(reportPath));
              const body = `
            ## 📊 Coverage Report
            
            | Metric | Coverage | Threshold | Status |
            |--------|----------|-----------|--------|
            | Lines | ${report.total.lines.toFixed(1)}% | ${report.threshold.lines}% | ${report.total.lines >= report.threshold.lines ? '✅' : '❌'} |
            | Functions | ${report.total.functions.toFixed(1)}% | ${report.threshold.functions}% | ${report.total.functions >= report.threshold.functions ? '✅' : '❌'} |
            | Branches | ${report.total.branches.toFixed(1)}% | ${report.threshold.branches}% | ${report.total.branches >= report.threshold.branches ? '✅' : '❌'} |
            
            ${report.filesBelowThreshold && report.filesBelowThreshold.length > 0 ? 
              '### ⚠️ Files below threshold\\n' + report.filesBelowThreshold.map(f => `- ${f.file} (${f.lines.toFixed(1)}%)`).join('\\n') : 
              ''}
            
            [View detailed report](https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }})
              `;
              github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body: body
              });
            }
      
      - name: Fail if coverage below threshold
        if: steps.threshold.outputs.passed == 'false'
        run: exit 1
```

### 4.5 数据库表设计

```sql
-- database/migrations/20260708_150000_test_coverage_system.sql

-- 测试覆盖率记录表（按服务）
CREATE TABLE test_coverage_records (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  build_id VARCHAR(100) NOT NULL,
  branch VARCHAR(100) NOT NULL,
  commit_sha VARCHAR(40) NOT NULL,
  lines_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  statements_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  functions_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  branches_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  files_covered INTEGER NOT NULL DEFAULT 0,
  total_lines INTEGER NOT NULL DEFAULT 0,
  covered_lines INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_coverage_service ON test_coverage_records(service_name);
CREATE INDEX idx_coverage_build ON test_coverage_records(build_id);
CREATE INDEX idx_coverage_branch ON test_coverage_records(branch);
CREATE INDEX idx_coverage_created ON test_coverage_records(created_at);

-- 测试覆盖率汇总表（全项目）
CREATE TABLE test_coverage_summary (
  id SERIAL PRIMARY KEY,
  build_id VARCHAR(100) NOT NULL UNIQUE,
  branch VARCHAR(100) NOT NULL,
  commit_sha VARCHAR(40) NOT NULL,
  avg_lines_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  avg_statements_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  avg_functions_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  avg_branches_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  services_covered INTEGER NOT NULL DEFAULT 0,
  total_services INTEGER NOT NULL DEFAULT 9,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_coverage_summary_build ON test_coverage_summary(build_id);
CREATE INDEX idx_coverage_summary_branch ON test_coverage_summary(branch);
CREATE INDEX idx_coverage_summary_created ON test_coverage_summary(created_at);

-- 覆盖率阈值配置表
CREATE TABLE coverage_threshold_config (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL UNIQUE,
  min_lines_pct DECIMAL(5,2) NOT NULL DEFAULT 50,
  min_statements_pct DECIMAL(5,2) NOT NULL DEFAULT 50,
  min_functions_pct DECIMAL(5,2) NOT NULL DEFAULT 50,
  min_branches_pct DECIMAL(5,2) NOT NULL DEFAULT 40,
  incremental_min_lines_pct DECIMAL(5,2) NOT NULL DEFAULT 80,
  incremental_min_functions_pct DECIMAL(5,2) NOT NULL DEFAULT 80,
  is_active BOOLEAN DEFAULT true,
  updated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 初始阈值配置
INSERT INTO coverage_threshold_config (service_name, min_lines_pct, min_statements_pct, min_functions_pct, min_branches_pct)
VALUES
  ('gateway', 50, 50, 50, 40),
  ('user-service', 60, 60, 60, 50),
  ('pokemon-service', 60, 60, 60, 50),
  ('catch-service', 70, 70, 70, 60),
  ('gym-service', 50, 50, 50, 40),
  ('social-service', 50, 50, 50, 40),
  ('reward-service', 60, 60, 60, 50),
  ('payment-service', 80, 80, 80, 70),
  ('location-service', 50, 50, 50, 40);

-- 覆盖率缺口分析结果表
CREATE TABLE coverage_gap_analysis (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  build_id VARCHAR(100) NOT NULL,
  file_path TEXT NOT NULL,
  uncovered_functions JSONB,
  uncovered_branches JSONB,
  severity_score DECIMAL(5,2) NOT NULL,
  suggested_tests TEXT[],
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_gap_service ON coverage_gap_analysis(service_name);
CREATE INDEX idx_gap_build ON coverage_gap_analysis(build_id);
CREATE INDEX idx_gap_severity ON coverage_gap_analysis(severity_score DESC);

COMMENT ON TABLE test_coverage_records IS '服务测试覆盖率记录';
COMMENT ON TABLE test_coverage_summary IS '全项目覆盖率汇总';
COMMENT ON TABLE coverage_threshold_config IS '覆盖率阈值配置';
COMMENT ON TABLE coverage_gap_analysis IS '覆盖率缺口分析结果';
```

### 4.6 Admin Dashboard 覆盖率管理页面

新增管理界面功能：
- **覆盖率报告查看**：按服务/时间范围查看覆盖率
- **阈值配置管理**：设置各服务的覆盖率门槛
- **历史趋势图表**：可视化覆盖率变化趋势
- **缺口分析报告**：查看未覆盖的关键代码路径
- **Badge 展示**：显示项目覆盖率徽章

### 4.7 API 设计

```
GET /api/admin/coverage/history?service={service}&days={days}
Response: {
  "records": [
    { "buildId": "1234", "lines": 65.5, "functions": 58.2, "timestamp": "2026-07-08T10:00:00Z" }
  ],
  "trend": { "improving": true, "avgChange": 2.5 }
}

GET /api/admin/coverage/gaps?service={service}&limit={limit}
Response: {
  "service": "user-service",
  "totalFiles": 45,
  "filesWithGaps": 12,
  "gaps": [
    { "file": "src/routes/auth.js", "severity": 85.3, "uncoveredFunctions": ["validateToken", "refreshSession"] }
  ]
}

POST /api/admin/coverage/threshold
Body: {
  "serviceName": "payment-service",
  "minLinesPct": 80,
  "minFunctionsPct": 80
}

GET /api/admin/coverage/badge?service={service}
Response: {
  "badgeUrl": "https://img.shields.io/badge/coverage-65%25-yellow",
  "lines": 65.2
}
```

## 5. 验收标准（可测试）

- [ ] 数据库表创建成功，包含所有索引和约束
- [ ] Jest 配置正确，9 个微服务 + backend/shared 能收集覆盖率
- [ ] TestCoverageCollector 能收集所有服务覆盖率并存入数据库
- [ ] IncrementalCoverageAnalyzer 能分析 PR 变更文件的覆盖率
- [ ] GitHub Actions 流程集成覆盖率检查步骤
- [ ] PR 低于覆盖率阈值时 CI 失败
- [ ] PR 评论自动展示覆盖率报告
- [ ] Admin Dashboard 可查看覆盖率历史趋势图表
- [ ] Admin Dashboard 可配置覆盖率阈值
- [ ] 覆盖率缺口分析能识别未覆盖的关键函数
- [ ] Coverage Badge 正确生成并显示
- [ ] 单元测试覆盖率 ≥ 75%（本需求自身测试）

## 6. 工作量估算

**L - 大型工作量**
- Jest 覆盖率配置（9 服务）：2 小时
- TestCoverageCollector 服务：3 小时
- IncrementalCoverageAnalyzer：3 小时
- GitHub Actions 流程集成：2 小时
- 数据库表设计 + 迁移：1 小时
- Admin Dashboard 界面：3 小时
- API 路由 + 集成：2 小时
- PR 评论机器人集成：1 小时
- Badge 生成器：1 小时
- 单元测试：3 小时

总计约 18 小时，需 2-3 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **质量保障基础**：测试覆盖率是代码质量的核心指标，无覆盖率度量系统，代码质量无法保障
2. **CI 强制门槛缺失**：当前 CI 不检查覆盖率，低质量代码可随意合并，风险极高
3. **成熟度评分提升**：测试覆盖维度权重 10，当前得分仅 12，完成后预计提升至 25+
4. **重构前提条件**：后续大规模重构（如微服务拆分、架构优化）必须依赖测试覆盖
5. **覆盖率极低现状**：仅 1 个测试文件，是当前项目最大的质量缺口

此需求是建立测试质量保障体系的基础设施，应立即启动。