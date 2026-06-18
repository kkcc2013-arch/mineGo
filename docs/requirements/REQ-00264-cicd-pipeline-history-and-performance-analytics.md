# REQ-00264：CI/CD 流水线运行历史与性能分析系统

- **编号**：REQ-00264
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：.github/workflows、backend/shared/PipelineAnalyzer.js、admin-dashboard、backend/jobs、PostgreSQL
- **创建时间**：2026-06-18 19:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目已有完善的 CI/CD 流水线，包括：
- ci-cd.yml：主流水线（测试 → 安全扫描 → 构建 → 金丝雀部署 → 全量部署）
- deploy-with-rollback.yml：支持自动回滚的部署流水线
- blue-green-deploy.yml：蓝绿部署策略
- contract-tests.yml、e2e-tests.yml、performance-tests.yml：测试流水线

**当前痛点：**
1. **无运行历史追踪**：GitHub Actions 只保留有限历史，无法进行长期趋势分析
2. **性能瓶颈不可见**：不知道哪个 Job 最耗时、哪个步骤最容易失败
3. **失败模式缺乏分析**：常见失败原因没有统计，难以针对性优化
4. **资源消耗不透明**：不知道 CI/CD 每月消耗多少 GitHub Actions minutes
5. **部署频率缺乏度量**：DORA 指标中的部署频率无法统计

## 2. 目标

建立完整的 CI/CD 流水线可观测性系统：
- 运行历史持久化存储（至少保留 1 年）
- 性能分析报告（P50/P95/P99 耗时、失败率趋势）
- 自动识别瓶颈和优化建议
- 支持 DORA 指标度量（部署频率、变更前置时间）

## 3. 范围

- **包含**：
  - GitHub Actions Webhook 接收器（接收 workflow_run 事件）
  - 运行历史数据模型与存储
  - 性能分析引擎（PipelineAnalyzer.js）
  - Admin Dashboard 展示页面
  - 周期性报告生成任务
  - 优化建议生成器

- **不包含**：
  - 替代 GitHub Actions 原生 UI
  - 实时日志流分析
  - 跨仓库分析

## 4. 详细需求

### 4.1 数据模型

```sql
-- CI/CD 运行历史
CREATE TABLE pipeline_runs (
  id SERIAL PRIMARY KEY,
  github_run_id BIGINT UNIQUE NOT NULL,
  workflow_name VARCHAR(255) NOT NULL,
  workflow_file VARCHAR(255) NOT NULL,
  repository VARCHAR(255) NOT NULL,
  branch VARCHAR(255) NOT NULL,
  commit_sha VARCHAR(40) NOT NULL,
  commit_message TEXT,
  author VARCHAR(255),
  status VARCHAR(50) NOT NULL, -- queued, in_progress, completed
  conclusion VARCHAR(50), -- success, failure, cancelled, timed_out
  trigger_event VARCHAR(50), -- push, pull_request, workflow_dispatch
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_seconds INT,
  github_run_number INT,
  run_attempt INT DEFAULT 1,
  labels JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Job 级别详情
CREATE TABLE pipeline_jobs (
  id SERIAL PRIMARY KEY,
  run_id INT REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  github_job_id BIGINT,
  job_name VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL,
  conclusion VARCHAR(50),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_seconds INT,
  steps JSONB DEFAULT '[]',
  runner_labels JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 失败分析
CREATE TABLE pipeline_failures (
  id SERIAL PRIMARY KEY,
  run_id INT REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  job_id INT REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
  failure_type VARCHAR(100), -- timeout, test_failure, build_error, deploy_error
  failure_message TEXT,
  failure_step VARCHAR(255),
  stack_trace TEXT,
  resolved BOOLEAN DEFAULT FALSE,
  resolution_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 性能统计汇总
CREATE TABLE pipeline_stats_daily (
  id SERIAL PRIMARY KEY,
  stat_date DATE NOT NULL,
  workflow_name VARCHAR(255) NOT NULL,
  total_runs INT DEFAULT 0,
  successful_runs INT DEFAULT 0,
  failed_runs INT DEFAULT 0,
  cancelled_runs INT DEFAULT 0,
  avg_duration_seconds INT,
  p50_duration_seconds INT,
  p95_duration_seconds INT,
  p99_duration_seconds INT,
  total_github_minutes DECIMAL(10,2),
  UNIQUE(stat_date, workflow_name)
);

-- DORA 指标
CREATE TABLE dora_metrics (
  id SERIAL PRIMARY KEY,
  metric_date DATE NOT NULL,
  deployment_frequency DECIMAL(10,2), -- 每日部署次数
  lead_time_hours DECIMAL(10,2), -- 变更前置时间（小时）
  change_failure_rate DECIMAL(5,4), -- 变更失败率
  mean_time_to_recovery_hours DECIMAL(10,2), -- MTTR（小时）
  UNIQUE(metric_date)
);

CREATE INDEX idx_pipeline_runs_workflow ON pipeline_runs(workflow_name);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status, conclusion);
CREATE INDEX idx_pipeline_runs_date ON pipeline_runs(started_at DESC);
CREATE INDEX idx_pipeline_jobs_run ON pipeline_jobs(run_id);
CREATE INDEX idx_pipeline_failures_type ON pipeline_failures(failure_type);
```

### 4.2 Webhook 接收器

```javascript
// backend/shared/PipelineWebhookHandler.js
const crypto = require('crypto');
const { Pool } = require('pg');

class PipelineWebhookHandler {
  constructor(config) {
    this.pool = new Pool(config.database);
    this.webhookSecret = config.githubWebhookSecret;
  }

  // 验证 GitHub Webhook 签名
  verifySignature(payload, signature) {
    const expected = `sha256=${crypto
      .createHmac('sha256', this.webhookSecret)
      .update(payload)
      .digest('hex')}`;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  // 处理 workflow_run 事件
  async handleWorkflowRun(event) {
    const { action, workflow_run, repository, sender } = event;
    
    const runData = {
      github_run_id: workflow_run.id,
      workflow_name: workflow_run.name,
      workflow_file: workflow_run.path,
      repository: repository.full_name,
      branch: workflow_run.head_branch,
      commit_sha: workflow_run.head_sha,
      commit_message: workflow_run.head_commit?.message,
      author: sender.login,
      status: workflow_run.status,
      conclusion: workflow_run.conclusion,
      trigger_event: workflow_run.event,
      started_at: workflow_run.run_started_at || workflow_run.created_at,
      completed_at: workflow_run.updated_at,
      github_run_number: workflow_run.run_number,
      run_attempt: workflow_run.run_attempt || 1,
      labels: workflow_run.labels || {},
      metadata: {
        actor: workflow_run.actor?.login,
        triggering_actor: workflow_run.triggering_actor?.login
      }
    };

    // 计算持续时间
    if (runData.started_at && runData.completed_at) {
      runData.duration_seconds = Math.floor(
        (new Date(runData.completed_at) - new Date(runData.started_at)) / 1000
      );
    }

    // Upsert 运行记录
    await this.upsertRun(runData);

    // 如果完成，触发统计分析
    if (runData.status === 'completed') {
      await this.analyzeRun(workflow_run.id);
    }
  }

  // 处理 workflow_job 事件
  async handleWorkflowJob(event) {
    const { action, workflow_job } = event;
    
    const jobData = {
      github_job_id: workflow_job.id,
      job_name: workflow_job.name,
      status: workflow_job.status,
      conclusion: workflow_job.conclusion,
      started_at: workflow_job.started_at,
      completed_at: workflow_job.completed_at,
      steps: workflow_job.steps || [],
      runner_labels: workflow_job.labels || []
    };

    // 计算持续时间
    if (jobData.started_at && jobData.completed_at) {
      jobData.duration_seconds = Math.floor(
        (new Date(jobData.completed_at) - new Date(jobData.started_at)) / 1000
      );
    }

    await this.upsertJob(jobData, workflow_job.run_id);
  }

  async upsertRun(data) {
    const query = `
      INSERT INTO pipeline_runs (
        github_run_id, workflow_name, workflow_file, repository, branch,
        commit_sha, commit_message, author, status, conclusion,
        trigger_event, started_at, completed_at, duration_seconds,
        github_run_number, run_attempt, labels, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (github_run_id) DO UPDATE SET
        status = EXCLUDED.status,
        conclusion = EXCLUDED.conclusion,
        completed_at = EXCLUDED.completed_at,
        duration_seconds = EXCLUDED.duration_seconds,
        updated_at = NOW()
      RETURNING id
    `;
    const result = await this.pool.query(query, [
      data.github_run_id, data.workflow_name, data.workflow_file,
      data.repository, data.branch, data.commit_sha, data.commit_message,
      data.author, data.status, data.conclusion, data.trigger_event,
      data.started_at, data.completed_at, data.duration_seconds,
      data.github_run_number, data.run_attempt, data.labels, data.metadata
    ]);
    return result.rows[0].id;
  }

  async analyzeRun(githubRunId) {
    // 分析失败原因
    const run = await this.getRunByGithubId(githubRunId);
    if (run.conclusion === 'failure') {
      await this.analyzeFailure(run.id);
    }
    
    // 更新统计
    await this.updateDailyStats(new Date());
    await this.updateDoraMetrics(new Date());
  }

  async analyzeFailure(runId) {
    const jobs = await this.getJobsForRun(runId);
    for (const job of jobs) {
      if (job.conclusion === 'failure') {
        const failure = this.classifyFailure(job);
        await this.recordFailure(runId, job.id, failure);
      }
    }
  }

  classifyFailure(job) {
    const steps = job.steps || [];
    const failedStep = steps.find(s => s.conclusion === 'failure');
    
    let failureType = 'unknown';
    let failureStep = failedStep?.name || 'unknown';
    
    // 根据步骤名分类失败类型
    if (failureStep.includes('test') || failureStep.includes('Test')) {
      failureType = 'test_failure';
    } else if (failureStep.includes('build') || failureStep.includes('Build')) {
      failureType = 'build_error';
    } else if (failureStep.includes('deploy') || failureStep.includes('Deploy')) {
      failureType = 'deploy_error';
    } else if (failureStep.includes('security') || failureStep.includes('Security')) {
      failureType = 'security_scan_failure';
    } else if (failureStep.includes('lint') || failureStep.includes('Lint')) {
      failureType = 'lint_error';
    }

    return {
      failure_type: failureType,
      failure_step: failureStep,
      failure_message: failedStep?.output?.message
    };
  }
}

module.exports = PipelineWebhookHandler;
```

### 4.3 性能分析引擎

```javascript
// backend/shared/PipelineAnalyzer.js
class PipelineAnalyzer {
  constructor(pool) {
    this.pool = pool;
  }

  // 获取运行趋势
  async getRunTrends(workflowName, days = 30) {
    const query = `
      SELECT
        DATE(started_at) as date,
        COUNT(*) as total_runs,
        COUNT(*) FILTER (WHERE conclusion = 'success') as successful,
        COUNT(*) FILTER (WHERE conclusion = 'failure') as failed,
        AVG(duration_seconds) as avg_duration,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_seconds) as p50_duration,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_seconds) as p95_duration
      FROM pipeline_runs
      WHERE workflow_name = $1
        AND started_at >= NOW() - INTERVAL '${days} days'
        AND status = 'completed'
      GROUP BY DATE(started_at)
      ORDER BY date DESC
    `;
    const result = await this.pool.query(query, [workflowName]);
    return result.rows;
  }

  // 获取失败分析
  async getFailureAnalysis(days = 30) {
    const query = `
      SELECT
        pf.failure_type,
        COUNT(*) as count,
        ROUND(COUNT(*)::DECIMAL / SUM(COUNT(*)) OVER () * 100, 2) as percentage,
        ARRAY_AGG(DISTINCT pr.workflow_name) as affected_workflows,
        AVG(pr.duration_seconds) as avg_time_to_failure
      FROM pipeline_failures pf
      JOIN pipeline_runs pr ON pf.run_id = pr.id
      WHERE pf.created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY pf.failure_type
      ORDER BY count DESC
    `;
    const result = await this.pool.query(query);
    return result.rows;
  }

  // 获取最耗时的 Job
  async getSlowestJobs(workflowName, days = 30, limit = 10) {
    const query = `
      SELECT
        pj.job_name,
        COUNT(*) as run_count,
        AVG(pj.duration_seconds) as avg_duration,
        MAX(pj.duration_seconds) as max_duration,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY pj.duration_seconds) as p95_duration
      FROM pipeline_jobs pj
      JOIN pipeline_runs pr ON pj.run_id = pr.id
      WHERE pr.workflow_name = $1
        AND pr.started_at >= NOW() - INTERVAL '${days} days'
        AND pj.duration_seconds IS NOT NULL
      GROUP BY pj.job_name
      ORDER BY avg_duration DESC
      LIMIT $2
    `;
    const result = await this.pool.query(query, [workflowName, limit]);
    return result.rows;
  }

  // 生成优化建议
  async generateOptimizationSuggestions(workflowName) {
    const suggestions = [];
    
    // 分析失败率
    const failureRate = await this.getFailureRate(workflowName);
    if (failureRate > 0.1) {
      suggestions.push({
        type: 'reliability',
        severity: 'high',
        message: `失败率 ${ (failureRate * 100).toFixed(1) }% 偏高，建议优先解决失败问题`,
        details: await this.getFailureAnalysis(7)
      });
    }

    // 分析耗时
    const slowJobs = await this.getSlowestJobs(workflowName);
    if (slowJobs.length > 0 && slowJobs[0].avg_duration > 300) {
      suggestions.push({
        type: 'performance',
        severity: 'medium',
        message: `Job "${slowJobs[0].job_name}" 平均耗时 ${slowJobs[0].avg_duration}秒，建议优化`,
        details: slowJobs
      });
    }

    // 分析超时
    const timeoutRate = await this.getTimeoutRate(workflowName);
    if (timeoutRate > 0.05) {
      suggestions.push({
        type: 'timeout',
        severity: 'medium',
        message: `超时率 ${(timeoutRate * 100).toFixed(1) }% 偏高，建议增加超时时间或优化任务`,
        details: null
      });
    }

    return suggestions;
  }

  // 计算 DORA 指标
  async calculateDoraMetrics(dateRange) {
    const { start, end } = dateRange;

    // 部署频率
    const deployFreqQuery = `
      SELECT
        DATE(completed_at) as date,
        COUNT(*) as deployments
      FROM pipeline_runs
      WHERE workflow_name LIKE '%deploy%'
        AND conclusion = 'success'
        AND completed_at BETWEEN $1 AND $2
      GROUP BY DATE(completed_at)
      ORDER BY date
    `;

    // 变更前置时间
    const leadTimeQuery = `
      SELECT
        AVG(EXTRACT(EPOCH FROM (pr.completed_at - pc.committed_at)) / 3600) as lead_time_hours
      FROM pipeline_runs pr
      JOIN commits pc ON pr.commit_sha = pc.sha
      WHERE pr.conclusion = 'success'
        AND pr.completed_at BETWEEN $1 AND $2
    `;

    // 变更失败率
    const changeFailureQuery = `
      SELECT
        COUNT(*) FILTER (WHERE conclusion = 'failure')::DECIMAL / COUNT(*) as rate
      FROM pipeline_runs
      WHERE trigger_event = 'push'
        AND completed_at BETWEEN $1 AND $2
    `;

    // MTTR
    const mttrQuery = `
      WITH failures AS (
        SELECT
          pr.id,
          pr.completed_at as failure_time,
          LEAD(pr.completed_at) OVER (
            PARTITION BY pr.workflow_name 
            ORDER BY pr.completed_at
          ) as recovery_time
        FROM pipeline_runs pr
        WHERE pr.conclusion = 'failure'
          AND pr.completed_at BETWEEN $1 AND $2
      )
      SELECT AVG(EXTRACT(EPOCH FROM (recovery_time - failure_time)) / 3600) as mttr_hours
      FROM failures
      WHERE recovery_time IS NOT NULL
    `;

    const [deployFreq, leadTime, changeFailure, mttr] = await Promise.all([
      this.pool.query(deployFreqQuery, [start, end]),
      this.pool.query(leadTimeQuery, [start, end]),
      this.pool.query(changeFailureQuery, [start, end]),
      this.pool.query(mttrQuery, [start, end])
    ]);

    return {
      deploymentFrequency: deployFreq.rows,
      avgLeadTimeHours: leadTime.rows[0]?.lead_time_hours,
      changeFailureRate: changeFailure.rows[0]?.rate,
      mttrHours: mttr.rows[0]?.mttr_hours
    };
  }

  async getFailureRate(workflowName, days = 30) {
    const query = `
      SELECT
        COUNT(*) FILTER (WHERE conclusion = 'failure')::DECIMAL / COUNT(*) as rate
      FROM pipeline_runs
      WHERE workflow_name = $1
        AND started_at >= NOW() - INTERVAL '${days} days'
        AND status = 'completed'
    `;
    const result = await this.pool.query(query, [workflowName]);
    return parseFloat(result.rows[0]?.rate || 0);
  }

  async getTimeoutRate(workflowName, days = 30) {
    const query = `
      SELECT
        COUNT(*) FILTER (WHERE conclusion = 'timed_out')::DECIMAL / COUNT(*) as rate
      FROM pipeline_runs
      WHERE workflow_name = $1
        AND started_at >= NOW() - INTERVAL '${days} days'
        AND status = 'completed'
    `;
    const result = await this.pool.query(query, [workflowName]);
    return parseFloat(result.rows[0]?.rate || 0);
  }
}

module.exports = PipelineAnalyzer;
```

### 4.4 API 接口

```javascript
// 后端 API 路由
router.get('/api/pipeline/runs', async (req, res) => {
  const { workflow, status, limit = 50, offset = 0 } = req.query;
  // 返回运行历史列表
});

router.get('/api/pipeline/runs/:id', async (req, res) => {
  // 返回单次运行详情（含 Jobs）
});

router.get('/api/pipeline/trends/:workflow', async (req, res) => {
  // 返回指定工作流的趋势数据
});

router.get('/api/pipeline/failures', async (req, res) => {
  // 返回失败分析
});

router.get('/api/pipeline/suggestions/:workflow', async (req, res) => {
  // 返回优化建议
});

router.get('/api/pipeline/dora', async (req, res) => {
  // 返回 DORA 指标
});

// GitHub Webhook 端点
router.post('/webhooks/github/pipeline', async (req, res) => {
  const handler = new PipelineWebhookHandler(config);
  
  // 验证签名
  const signature = req.headers['x-hub-signature-256'];
  if (!handler.verifySignature(req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];
  
  if (event === 'workflow_run') {
    await handler.handleWorkflowRun(req.body);
  } else if (event === 'workflow_job') {
    await handler.handleWorkflowJob(req.body);
  }

  res.json({ received: true });
});
```

### 4.5 Admin Dashboard 页面

```html
<!-- admin-dashboard/pipeline-history.html -->
<!DOCTYPE html>
<html>
<head>
  <title>CI/CD Pipeline Analytics</title>
  <link href="/css/dashboard.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="dashboard-container">
    <h1>🚀 CI/CD Pipeline Analytics</h1>
    
    <!-- DORA 指标卡片 -->
    <div class="dora-metrics">
      <div class="metric-card">
        <h3>Deployment Frequency</h3>
        <span id="deploy-freq" class="metric-value">--</span>
        <span class="metric-unit">per day</span>
      </div>
      <div class="metric-card">
        <h3>Lead Time</h3>
        <span id="lead-time" class="metric-value">--</span>
        <span class="metric-unit">hours</span>
      </div>
      <div class="metric-card">
        <h3>Change Failure Rate</h3>
        <span id="failure-rate" class="metric-value">--</span>
        <span class="metric-unit">%</span>
      </div>
      <div class="metric-card">
        <h3>MTTR</h3>
        <span id="mttr" class="metric-value">--</span>
        <span class="metric-unit">hours</span>
      </div>
    </div>

    <!-- 工作流选择 -->
    <select id="workflow-select">
      <option value="">All Workflows</option>
    </select>

    <!-- 运行趋势图 -->
    <div class="chart-container">
      <canvas id="trends-chart"></canvas>
    </div>

    <!-- 失败分析 -->
    <div class="failure-analysis">
      <h2>Failure Analysis</h2>
      <canvas id="failure-chart"></canvas>
    </div>

    <!-- 优化建议 -->
    <div class="suggestions">
      <h2>Optimization Suggestions</h2>
      <ul id="suggestions-list"></ul>
    </div>

    <!-- 最近运行 -->
    <div class="recent-runs">
      <h2>Recent Runs</h2>
      <table id="runs-table">
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Branch</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <script src="/js/pipeline-dashboard.js"></script>
</body>
</html>
```

## 5. 验收标准（可测试）

- [ ] GitHub Webhook 能正确接收 workflow_run 和 workflow_job 事件
- [ ] 运行历史数据能正确持久化到 PostgreSQL
- [ ] 能查询指定工作流的运行趋势（至少包含成功/失败/耗时统计）
- [ ] 能正确分类失败类型（test_failure、build_error、deploy_error 等）
- [ ] 能生成优化建议（至少包含失败率、耗时、超时三类建议）
- [ ] DORA 指标能正确计算（部署频率、前置时间、失败率、MTTR）
- [ ] Admin Dashboard 能正确展示所有数据
- [ ] 数据保留策略生效（历史数据自动归档，至少保留 1 年）
- [ ] Webhook 签名验证正确（防止伪造请求）

## 6. 工作量估算

**L** - 需要实现：
- 数据库迁移脚本（4 张表）
- Webhook 接收器
- 性能分析引擎
- 5+ API 接口
- Admin Dashboard 页面
- 定期统计任务

预计 3-5 天完成。

## 7. 优先级理由

**P1** 理由：
1. **运维效率**：CI/CD 是开发流程核心，性能直接影响开发效率
2. **成本控制**：GitHub Actions 按分钟计费，了解消耗情况很重要
3. **质量保障**：失败分析能快速定位问题，减少排查时间
4. **DORA 指标**：业界认可的 DevOps 成熟度度量标准，帮助团队改进
