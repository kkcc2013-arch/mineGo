# REQ-00423: 部署变更日志自动生成系统

## 元信息

| 字段       | 值                                                          |
| ---------- | ----------------------------------------------------------- |
| 编号       | REQ-00423                                                   |
| 标题       | 部署变更日志自动生成系统                                    |
| 类别       | 运维/CICD                                                   |
| 优先级     | P2                                                          |
| 状态       | new                                                         |
| 涉及服务   | github-actions、admin-dashboard、notification-service、api-gateway |
| 创建时间   | 2026-07-02 04:00                                            |

## 需求描述

当前问题：
- 每次部署后，运维人员需要手动编写变更日志，耗时且容易遗漏关键信息
- 变更日志格式不统一，难以追溯历史部署记录
- 缺乏自动化的变更影响分析和风险评估
- 无法快速定位部署失败的根因和回滚影响范围

目标：
- 自动从 Git 提交记录、PR 信息、Jira 任务生成结构化变更日志
- 支持变更影响范围分析（服务依赖、数据库变更、配置变更）
- 自动生成风险评估和回滚计划
- 提供多渠道通知（Slack、邮件、钉钉）和查询 API
- 支持变更日志版本管理和历史追溯

## 技术方案

### 1. 变更信息采集模块 (github-actions)

```yaml
# .github/workflows/deployment-changelog.yml
name: Generate Deployment Changelog

on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Deployment environment'
        required: true
        default: 'staging'
        type: choice
        options:
          - staging
          - production
      previous_commit:
        description: 'Previous deployed commit SHA'
        required: true
      current_commit:
        description: 'Current commit SHA to deploy'
        required: true

jobs:
  generate-changelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Generate changelog
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
          JIRA_BASE_URL: ${{ secrets.JIRA_BASE_URL }}
        run: |
          node scripts/generate-changelog.js \
            --env ${{ inputs.environment }} \
            --previous ${{ inputs.previous_commit }} \
            --current ${{ inputs.current_commit }} \
            --output changelog.json
      
      - name: Analyze impact
        run: |
          node scripts/analyze-deployment-impact.js \
            --changelog changelog.json \
            --output impact-analysis.json
      
      - name: Generate risk assessment
        run: |
          node scripts/assess-deployment-risk.js \
            --changelog changelog.json \
            --impact impact-analysis.json \
            --output risk-assessment.json
      
      - name: Publish changelog
        env:
          CHANGELOG_API_URL: ${{ secrets.CHANGELOG_API_URL }}
        run: |
          curl -X POST "${CHANGELOG_API_URL}/api/v1/changelogs" \
            -H "Authorization: Bearer ${{ secrets.CHANGELOG_API_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d @changelog.json
      
      - name: Send notifications
        run: |
          node scripts/send-deployment-notification.js \
            --changelog changelog.json \
            --risk risk-assessment.json \
            --env ${{ inputs.environment }}
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: deployment-changelog
          path: |
            changelog.json
            impact-analysis.json
            risk-assessment.json
```

### 2. 变更日志生成器核心模块

```typescript
// backend/shared/changelog/src/generator.ts
import { Octokit } from '@octokit/rest';
import { parseCommit, ConventionalCommit } from '@commitlint/parse';
import { JiraClient } from './jira-client';

interface ChangelogEntry {
  commit: string;
  author: string;
  message: string;
  type: 'feat' | 'fix' | 'refactor' | 'perf' | 'test' | 'docs' | 'chore' | 'style';
  scope?: string;
  breaking: boolean;
  issues: string[];
  pr?: number;
  timestamp: Date;
}

interface DeploymentChangelog {
  id: string;
  environment: string;
  previousCommit: string;
  currentCommit: string;
  deployedAt: Date;
  deployedBy: string;
  entries: ChangelogEntry[];
  categories: {
    features: ChangelogEntry[];
    bugFixes: ChangelogEntry[];
    improvements: ChangelogEntry[];
    breakingChanges: ChangelogEntry[];
    dependencies: ChangelogEntry[];
  };
  statistics: {
    totalCommits: number;
    filesChanged: number;
    additions: number;
    deletions: number;
    contributors: string[];
  };
  metadata: {
    services: string[];
    databases: string[];
    configs: string[];
  };
}

export class ChangelogGenerator {
  private octokit: Octokit;
  private jiraClient: JiraClient;

  constructor(
    private config: {
      githubToken: string;
      owner: string;
      repo: string;
      jiraConfig?: { baseUrl: string; token: string };
    }
  ) {
    this.octokit = new Octokit({ auth: config.githubToken });
    this.jiraClient = config.jiraConfig 
      ? new JiraClient(config.jiraConfig) 
      : null;
  }

  async generate(
    environment: string,
    previousCommit: string,
    currentCommit: string
  ): Promise<DeploymentChangelog> {
    // 1. 获取提交范围
    const commits = await this.getCommitRange(previousCommit, currentCommit);
    
    // 2. 解析每个提交
    const entries: ChangelogEntry[] = [];
    for (const commit of commits) {
      const parsed = await this.parseCommit(commit);
      entries.push(parsed);
    }

    // 3. 分类整理
    const categories = this.categorizeEntries(entries);

    // 4. 获取统计信息
    const statistics = await this.getStatistics(previousCommit, currentCommit);

    // 5. 分析影响的服务和资源
    const metadata = await this.analyzeMetadata(previousCommit, currentCommit);

    return {
      id: `changelog-${Date.now()}`,
      environment,
      previousCommit,
      currentCommit,
      deployedAt: new Date(),
      deployedBy: process.env.GITHUB_ACTOR || 'unknown',
      entries,
      categories,
      statistics,
      metadata,
    };
  }

  private async getCommitRange(from: string, to: string) {
    const { data } = await this.octokit.repos.compareCommits({
      owner: this.config.owner,
      repo: this.config.repo,
      base: from,
      head: to,
    });

    return data.commits;
  }

  private async parseCommit(commit: any): Promise<ChangelogEntry> {
    try {
      const parsed = await parseCommit(commit.commit.message);
      
      // 提取 Jira 任务编号
      const issues = this.extractIssues(commit.commit.message);
      
      // 获取关联的 PR
      const pr = await this.getAssociatedPR(commit.sha);

      return {
        commit: commit.sha.substring(0, 7),
        author: commit.author?.login || commit.commit.author.name,
        message: parsed.header,
        type: parsed.type as any || 'chore',
        scope: parsed.scope,
        breaking: parsed.notes?.some(n => n.title === 'BREAKING CHANGE') || false,
        issues,
        pr,
        timestamp: new Date(commit.commit.author.date),
      };
    } catch (error) {
      // 非 conventional commit 格式
      return {
        commit: commit.sha.substring(0, 7),
        author: commit.author?.login || commit.commit.author.name,
        message: commit.commit.message.split('\n')[0],
        type: 'chore',
        breaking: false,
        issues: this.extractIssues(commit.commit.message),
        timestamp: new Date(commit.commit.author.date),
      };
    }
  }

  private extractIssues(message: string): string[] {
    const patterns = [
      /([A-Z]+-\d+)/g,  // Jira: PROJ-123
      /#(\d+)/g,        // GitHub: #123
    ];

    const issues: string[] = [];
    for (const pattern of patterns) {
      const matches = message.match(pattern);
      if (matches) {
        issues.push(...matches);
      }
    }

    return [...new Set(issues)];
  }

  private categorizeEntries(entries: ChangelogEntry[]) {
    return {
      features: entries.filter(e => e.type === 'feat'),
      bugFixes: entries.filter(e => e.type === 'fix'),
      improvements: [
        ...entries.filter(e => e.type === 'perf'),
        ...entries.filter(e => e.type === 'refactor'),
      ],
      breakingChanges: entries.filter(e => e.breaking),
      dependencies: entries.filter(e => e.scope === 'deps'),
    };
  }

  private async getStatistics(from: string, to: string) {
    const { data } = await this.octokit.repos.compareCommits({
      owner: this.config.owner,
      repo: this.config.repo,
      base: from,
      head: to,
    });

    const contributors = new Set(
      data.commits.map(c => c.author?.login || c.commit.author.name)
    );

    return {
      totalCommits: data.commits.length,
      filesChanged: data.files?.length || 0,
      additions: data.files?.reduce((sum, f) => sum + (f.additions || 0), 0) || 0,
      deletions: data.files?.reduce((sum, f) => sum + (f.deletions || 0), 0) || 0,
      contributors: Array.from(contributors),
    };
  }

  private async analyzeMetadata(from: string, to: string) {
    const { data } = await this.octokit.repos.compareCommits({
      owner: this.config.owner,
      repo: this.config.repo,
      base: from,
      head: to,
    });

    const files = data.files || [];
    
    // 分析影响的服务
    const services = new Set<string>();
    const databases = new Set<string>();
    const configs = new Set<string>();

    for (const file of files) {
      const path = file.filename;
      
      // 服务检测
      const serviceMatch = path.match(/backend\/services\/([^\/]+)/);
      if (serviceMatch) {
        services.add(serviceMatch[1]);
      }

      // 数据库迁移检测
      if (path.includes('migrations/')) {
        const dbMatch = path.match(/([^\/]+)\/migrations/);
        if (dbMatch) {
          databases.add(dbMatch[1]);
        }
      }

      // 配置文件检测
      if (path.includes('.env') || path.includes('config/') || path.match(/\.(ya?ml|json|toml)$/)) {
        configs.add(path);
      }
    }

    return {
      services: Array.from(services),
      databases: Array.from(databases),
      configs: Array.from(configs),
    };
  }

  private async getAssociatedPR(commitSha: string): Promise<number | undefined> {
    try {
      const { data } = await this.octokit.repos.listPullRequestsAssociatedWithCommit({
        owner: this.config.owner,
        repo: this.config.repo,
        commit_sha: commitSha,
      });

      return data[0]?.number;
    } catch {
      return undefined;
    }
  }
}
```

### 3. 影响范围分析模块

```typescript
// backend/shared/changelog/src/impact-analyzer.ts
import { DeploymentChangelog } from './generator';

interface ImpactAnalysis {
  services: {
    name: string;
    changes: ('api' | 'database' | 'config' | 'dependencies')[];
    risk: 'low' | 'medium' | 'high';
    dependentServices: string[];
  }[];
  databases: {
    name: string;
    migrations: {
      file: string;
      type: 'create_table' | 'alter_table' | 'drop_table' | 'index';
      reversible: boolean;
    }[];
    risk: 'low' | 'medium' | 'high';
  }[];
  configs: {
    file: string;
    changes: string[];
    requiresRestart: boolean;
  }[];
  dependencies: {
    name: string;
    from: string;
    to: string;
    breaking: boolean;
  }[];
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  recommendations: string[];
}

export class ImpactAnalyzer {
  async analyze(changelog: DeploymentChangelog): Promise<ImpactAnalysis> {
    const services = await this.analyzeServices(changelog);
    const databases = await this.analyzeDatabases(changelog);
    const configs = await this.analyzeConfigs(changelog);
    const dependencies = await this.analyzeDependencies(changelog);
    
    const overallRisk = this.calculateOverallRisk(services, databases, dependencies);
    const recommendations = this.generateRecommendations(
      services, 
      databases, 
      configs, 
      dependencies
    );

    return {
      services,
      databases,
      configs,
      dependencies,
      overallRisk,
      recommendations,
    };
  }

  private async analyzeServices(changelog: DeploymentChangelog) {
    return changelog.metadata.services.map(serviceName => {
      const changes: string[] = [];
      let risk: 'low' | 'medium' | 'high' = 'low';

      // 检查是否有 API 变更
      const hasApiChanges = changelog.entries.some(e => 
        e.scope === 'api' && e.message.includes(serviceName)
      );
      if (hasApiChanges) {
        changes.push('api');
        risk = 'medium';
      }

      // 检查是否有数据库变更
      const hasDbChanges = changelog.metadata.databases.includes(serviceName);
      if (hasDbChanges) {
        changes.push('database');
        risk = 'high';
      }

      // 检查是否有配置变更
      const hasConfigChanges = changelog.metadata.configs.some(c => 
        c.includes(serviceName)
      );
      if (hasConfigChanges) {
        changes.push('config');
      }

      // 检查是否有依赖变更
      const hasDepChanges = changelog.categories.dependencies.some(e => 
        e.scope === serviceName
      );
      if (hasDepChanges) {
        changes.push('dependencies');
      }

      // 查找依赖此服务的其他服务
      const dependentServices = this.findDependentServices(serviceName);

      return {
        name: serviceName,
        changes,
        risk,
        dependentServices,
      };
    });
  }

  private async analyzeDatabases(changelog: DeploymentChangelog) {
    // 分析数据库迁移
    return changelog.metadata.databases.map(dbName => ({
      name: dbName,
      migrations: [], // 从迁移文件中解析
      risk: 'medium' as const,
    }));
  }

  private async analyzeConfigs(changelog: DeploymentChangelog) {
    return changelog.metadata.configs.map(configFile => ({
      file: configFile,
      changes: [], // 从 diff 中解析
      requiresRestart: this.checkRequiresRestart(configFile),
    }));
  }

  private async analyzeDependencies(changelog: DeploymentChangelog) {
    // 从 package.json, go.mod 等解析依赖变更
    return [];
  }

  private calculateOverallRisk(
    services: any[], 
    databases: any[], 
    dependencies: any[]
  ): 'low' | 'medium' | 'high' | 'critical' {
    const highRiskCount = services.filter(s => s.risk === 'high').length;
    const dbMigrationCount = databases.length;
    const breakingChanges = dependencies.filter(d => d.breaking).length;

    if (breakingChanges > 0 || highRiskCount > 2) {
      return 'critical';
    }
    if (highRiskCount > 0 || dbMigrationCount > 0) {
      return 'high';
    }
    if (services.some(s => s.risk === 'medium')) {
      return 'medium';
    }
    return 'low';
  }

  private generateRecommendations(
    services: any[],
    databases: any[],
    configs: any[],
    dependencies: any[]
  ): string[] {
    const recommendations: string[] = [];

    if (databases.some(d => !d.migrations.every(m => m.reversible))) {
      recommendations.push('⚠️ 存在不可逆的数据库迁移，建议先备份数据库');
    }

    if (configs.some(c => c.requiresRestart)) {
      recommendations.push('🔄 存在需要重启服务的配置变更');
    }

    if (dependencies.some(d => d.breaking)) {
      recommendations.push('🚨 存在 Breaking Changes 的依赖更新，建议进行回归测试');
    }

    if (services.some(s => s.dependentServices.length > 3)) {
      recommendations.push('🔗 部分服务被多个服务依赖，建议进行集成测试');
    }

    return recommendations;
  }

  private findDependentServices(serviceName: string): string[] {
    // 从服务依赖图中查找
    // TODO: 实现服务依赖图查询
    return [];
  }

  private checkRequiresRestart(configFile: string): boolean {
    const restartRequiredPatterns = [
      /server\.(port|host)/,
      /database\.(host|port|username|password)/,
      /redis\.(host|port)/,
      /kafka\.(brokers)/,
    ];

    return restartRequiredPatterns.some(p => p.test(configFile));
  }
}
```

### 4. 风险评估模块

```typescript
// backend/shared/changelog/src/risk-assessor.ts
import { DeploymentChangelog } from './generator';
import { ImpactAnalysis } from './impact-analyzer';

interface RiskAssessment {
  overallScore: number; // 0-100
  level: 'low' | 'medium' | 'high' | 'critical';
  factors: {
    name: string;
    score: number;
    weight: number;
    description: string;
  }[];
  rollbackPlan: {
    steps: string[];
    estimatedTime: string;
    dataLossRisk: boolean;
  };
  testRecommendations: {
    type: 'smoke' | 'regression' | 'integration' | 'e2e';
    priority: 'high' | 'medium' | 'low';
    services: string[];
  }[];
  approval: {
    required: boolean;
    approvers: string[];
    reason: string;
  };
}

export class RiskAssessor {
  async assess(
    changelog: DeploymentChangelog,
    impact: ImpactAnalysis
  ): Promise<RiskAssessment> {
    const factors = this.assessRiskFactors(changelog, impact);
    const overallScore = this.calculateOverallScore(factors);
    const level = this.determineRiskLevel(overallScore);
    const rollbackPlan = this.generateRollbackPlan(changelog, impact);
    const testRecommendations = this.generateTestRecommendations(changelog, impact);
    const approval = this.determineApprovalRequirements(overallScore, impact);

    return {
      overallScore,
      level,
      factors,
      rollbackPlan,
      testRecommendations,
      approval,
    };
  }

  private assessRiskFactors(
    changelog: DeploymentChangelog,
    impact: ImpactAnalysis
  ) {
    const factors: RiskAssessment['factors'] = [];

    // 1. Breaking Changes
    const breakingCount = changelog.categories.breakingChanges.length;
    factors.push({
      name: 'Breaking Changes',
      score: Math.min(breakingCount * 25, 100),
      weight: 3,
      description: `${breakingCount} 个破坏性变更`,
    });

    // 2. 数据库变更
    const dbRisk = impact.databases.some(d => d.risk === 'high');
    factors.push({
      name: 'Database Changes',
      score: dbRisk ? 80 : impact.databases.length > 0 ? 40 : 0,
      weight: 4,
      description: `${impact.databases.length} 个数据库变更`,
    });

    // 3. 服务影响范围
    const affectedServices = impact.services.length;
    factors.push({
      name: 'Service Scope',
      score: Math.min(affectedServices * 15, 60),
      weight: 2,
      description: `${affectedServices} 个服务受影响`,
    });

    // 4. 变更数量
    const commitCount = changelog.statistics.totalCommits;
    factors.push({
      name: 'Change Volume',
      score: commitCount > 50 ? 60 : commitCount > 20 ? 40 : commitCount > 10 ? 20 : 0,
      weight: 1,
      description: `${commitCount} 个提交`,
    });

    // 5. 依赖变更
    const depChanges = impact.dependencies.length;
    factors.push({
      name: 'Dependency Updates',
      score: Math.min(depChanges * 10, 50),
      weight: 2,
      description: `${depChanges} 个依赖更新`,
    });

    // 6. 配置变更
    const configChanges = impact.configs.length;
    factors.push({
      name: 'Configuration Changes',
      score: configChanges > 5 ? 40 : configChanges * 8,
      weight: 2,
      description: `${configChanges} 个配置变更`,
    });

    return factors;
  }

  private calculateOverallScore(factors: RiskAssessment['factors']): number {
    const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
    const weightedSum = factors.reduce(
      (sum, f) => sum + f.score * f.weight,
      0
    );

    return Math.round(weightedSum / totalWeight);
  }

  private determineRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score >= 70) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 30) return 'medium';
    return 'low';
  }

  private generateRollbackPlan(
    changelog: DeploymentChangelog,
    impact: ImpactAnalysis
  ) {
    const steps: string[] = [];
    let estimatedTime = '5-10 minutes';
    let dataLossRisk = false;

    // 数据库回滚
    if (impact.databases.length > 0) {
      steps.push('1. 回滚数据库迁移（按相反顺序）');
      estimatedTime = '30-60 minutes';
      dataLossRisk = impact.databases.some(d => 
        !d.migrations.every(m => m.reversible)
      );
    }

    // 服务回滚
    steps.push(`${steps.length + 1}. 部署上一个稳定版本`);
    steps.push(`${steps.length + 1}. 验证服务健康状态`);

    // 缓存清理
    if (impact.configs.some(c => c.file.includes('cache'))) {
      steps.push(`${steps.length + 1}. 清理缓存`);
    }

    return { steps, estimatedTime, dataLossRisk };
  }

  private generateTestRecommendations(
    changelog: DeploymentChangelog,
    impact: ImpactAnalysis
  ) {
    const recommendations: RiskAssessment['testRecommendations'] = [];

    // Smoke Test
    recommendations.push({
      type: 'smoke',
      priority: 'high',
      services: impact.services.map(s => s.name),
    });

    // API 回归测试
    if (impact.services.some(s => s.changes.includes('api'))) {
      recommendations.push({
        type: 'regression',
        priority: 'high',
        services: impact.services.filter(s => s.changes.includes('api')).map(s => s.name),
      });
    }

    // 数据库集成测试
    if (impact.databases.length > 0) {
      recommendations.push({
        type: 'integration',
        priority: 'high',
        services: impact.databases.map(d => d.name),
      });
    }

    // E2E 测试
    if (changelog.categories.breakingChanges.length > 0) {
      recommendations.push({
        type: 'e2e',
        priority: 'high',
        services: ['all'],
      });
    }

    return recommendations;
  }

  private determineApprovalRequirements(
    score: number,
    impact: ImpactAnalysis
  ) {
    const required = score >= 50 || impact.overallRisk === 'critical';
    const approvers: string[] = [];
    let reason = '';

    if (score >= 70) {
      approvers.push('tech-lead', 'ops-lead');
      reason = '高风险部署需要技术负责人和运维负责人审批';
    } else if (score >= 50) {
      approvers.push('tech-lead');
      reason = '中等风险部署需要技术负责人审批';
    } else if (impact.databases.some(d => d.migrations.length > 0)) {
      approvers.push('dba');
      reason = '包含数据库迁移需要 DBA 审批';
    }

    return { required, approvers, reason };
  }
}
```

### 5. 变更日志存储与查询 API

```typescript
// backend/services/changelog-service/src/api.ts
import express from 'express';
import { ChangelogStore } from './store';

const app = express();
const store = new ChangelogStore();

// 创建变更日志
app.post('/api/v1/changelogs', async (req, res) => {
  try {
    const changelog = req.body;
    await store.save(changelog);
    
    res.status(201).json({
      success: true,
      id: changelog.id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 查询变更日志列表
app.get('/api/v1/changelogs', async (req, res) => {
  const { environment, limit = 20, offset = 0 } = req.query;
  
  const changelogs = await store.list({
    environment,
    limit: Number(limit),
    offset: Number(offset),
  });

  res.json(changelogs);
});

// 获取单个变更日志详情
app.get('/api/v1/changelogs/:id', async (req, res) => {
  const changelog = await store.get(req.params.id);
  
  if (!changelog) {
    return res.status(404).json({ error: 'Not found' });
  }

  res.json(changelog);
});

// 获取两个版本之间的差异
app.get('/api/v1/changelogs/diff', async (req, res) => {
  const { from, to, environment } = req.query;
  
  const diff = await store.diff(
    String(from),
    String(to),
    String(environment)
  );

  res.json(diff);
});

// 搜索变更日志
app.get('/api/v1/changelogs/search', async (req, res) => {
  const { query, service, author } = req.query;
  
  const results = await store.search({
    query: String(query),
    service: String(service),
    author: String(author),
  });

  res.json(results);
});

app.listen(3000, () => {
  console.log('Changelog service listening on port 3000');
});
```

### 6. 多渠道通知模块

```typescript
// backend/shared/changelog/src/notifier.ts
import { DeploymentChangelog } from './generator';
import { RiskAssessment } from './risk-assessor';

export class ChangelogNotifier {
  constructor(
    private config: {
      slack: { webhookUrl: string };
      email: { smtp: any };
      dingtalk: { webhookUrl: string };
    }
  ) {}

  async notify(
    changelog: DeploymentChangelog,
    risk: RiskAssessment,
    channels: ('slack' | 'email' | 'dingtalk')[]
  ) {
    const message = this.formatMessage(changelog, risk);

    await Promise.all([
      channels.includes('slack') && this.sendToSlack(message),
      channels.includes('email') && this.sendEmail(message, changelog),
      channels.includes('dingtalk') && this.sendToDingtalk(message),
    ]);
  }

  private formatMessage(changelog: DeploymentChangelog, risk: RiskAssessment) {
    const emoji = {
      low: '✅',
      medium: '⚠️',
      high: '🔶',
      critical: '🚨',
    };

    return {
      title: `${emoji[risk.level]} Deployment to ${changelog.environment}`,
      summary: `${changelog.statistics.totalCommits} commits by ${changelog.statistics.contributors.join(', ')}`,
      risk: `Risk Level: ${risk.level.toUpperCase()} (${risk.overallScore}/100)`,
      highlights: [
        `✨ ${changelog.categories.features.length} new features`,
        `🐛 ${changelog.categories.bugFixes.length} bug fixes`,
        `⚡ ${changelog.categories.improvements.length} improvements`,
        `⚠️ ${changelog.categories.breakingChanges.length} breaking changes`,
      ],
      services: `Affected services: ${changelog.metadata.services.join(', ')}`,
      link: `https://github.com/owner/repo/compare/${changelog.previousCommit}...${changelog.currentCommit}`,
    };
  }

  private async sendToSlack(message: any) {
    await fetch(this.config.slack.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: message.title,
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Risk:* ${message.risk}` },
              { type: 'mrkdwn', text: `*Summary:* ${message.summary}` },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: message.highlights.join('\n'),
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `<${message.link}|View full changelog>`,
            },
          },
        ],
      }),
    });
  }

  private async sendEmail(message: any, changelog: DeploymentChangelog) {
    // 使用 nodemailer 发送邮件
  }

  private async sendToDingtalk(message: any) {
    // 发送钉钉通知
  }
}
```

### 7. Admin Dashboard 界面

```typescript
// frontend/admin-dashboard/src/pages/deployments/ChangelogList.tsx
import React, { useState, useEffect } from 'react';
import { Table, Tag, Button, Modal, Badge, Timeline } from 'antd';
import { RiskBadge } from './components/RiskBadge';
import { ChangelogDetail } from './components/ChangelogDetail';

export const ChangelogList: React.FC = () => {
  const [changelogs, setChangelogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedChangelog, setSelectedChangelog] = useState(null);

  useEffect(() => {
    fetchChangelogs();
  }, []);

  const fetchChangelogs = async () => {
    const response = await fetch('/api/v1/changelogs');
    const data = await response.json();
    setChangelogs(data);
    setLoading(false);
  };

  const columns = [
    {
      title: 'Deployment ID',
      dataIndex: 'id',
      key: 'id',
    },
    {
      title: 'Environment',
      dataIndex: 'environment',
      key: 'environment',
      render: (env: string) => (
        <Tag color={env === 'production' ? 'red' : 'blue'}>
          {env.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Commits',
      dataIndex: ['statistics', 'totalCommits'],
      key: 'commits',
    },
    {
      title: 'Risk',
      dataIndex: 'riskLevel',
      key: 'risk',
      render: (level: string) => <RiskBadge level={level} />,
    },
    {
      title: 'Deployed At',
      dataIndex: 'deployedAt',
      key: 'deployedAt',
      render: (date: string) => new Date(date).toLocaleString(),
    },
    {
      title: 'Deployed By',
      dataIndex: 'deployedBy',
      key: 'deployedBy',
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Button onClick={() => setSelectedChangelog(record)}>
          View Details
        </Button>
      ),
    },
  ];

  return (
    <div>
      <h1>Deployment Changelogs</h1>
      <Table
        dataSource={changelogs}
        columns={columns}
        loading={loading}
        rowKey="id"
      />

      <Modal
        visible={!!selectedChangelog}
        onCancel={() => setSelectedChangelog(null)}
        width={900}
        footer={null}
      >
        {selectedChangelog && (
          <ChangelogDetail changelog={selectedChangelog} />
        )}
      </Modal>
    </div>
  );
};
```

## 验收标准

- [ ] 能够自动从 Git 提交记录生成结构化变更日志
- [ ] 支持 Conventional Commits 规范解析
- [ ] 能够自动关联 Jira/GitHub Issues
- [ ] 能够分析变更影响的服务、数据库、配置
- [ ] 能够生成风险评估和回滚计划
- [ ] 支持 Slack、邮件、钉钉多渠道通知
- [ ] 提供 RESTful API 查询变更日志
- [ ] Admin Dashboard 提供变更日志查看界面
- [ ] 支持变更日志历史查询和搜索
- [ ] 能够自动生成 Markdown 格式的变更日志文档

## 影响范围

- **新增服务**：
  - changelog-service（变更日志存储与查询服务）
  
- **修改文件**：
  - `.github/workflows/deployment-changelog.yml`（新增）
  - `backend/shared/changelog/`（新增模块）
  - `frontend/admin-dashboard/src/pages/deployments/`（新增页面）
  
- **依赖服务**：
  - PostgreSQL（存储变更日志）
  - Redis（缓存查询结果）

## 参考

- [Conventional Commits](https://www.conventionalcommits.org/)
- [GitHub REST API - Compare commits](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
- [Jira REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- [Slack Block Kit](https://api.slack.com/block-kit)
