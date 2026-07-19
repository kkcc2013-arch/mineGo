# REQ-00590：CI/CD 流水线执行效率分析与瓶颈定位系统

- **编号**：REQ-00590
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：.github/workflows、backend/jobs/pipelineAnalyzer.js、admin-dashboard、infrastructure/monitoring
- **创建时间**：2026-07-19 04:00
- **依赖需求**：无

## 1. 背景与问题

当前项目拥有多条 CI/CD 流水线（ci-cd.yml、deploy.yml、canary-deploy.yml、security-scan.yml 等），但缺乏对流水线执行效率的系统化分析：

1. **执行时间不透明**：无法快速识别哪些 job/step 占用时间最长
2. **瓶颈定位困难**：构建缓慢、测试超时等问题需要人工排查
3. **趋势追踪缺失**：无法感知流水线效率随时间的变化
4. **优化决策缺乏数据支撑**：不知道优化哪些环节收益最大

GitHub Actions 提供的执行日志分散，缺乏聚合分析和可视化能力。

## 2. 目标

建立 CI/CD 流水线执行效率分析系统，实现：

1. 自动收集并分析每次流水线执行的耗时数据
2. 识别性能瓶颈（最慢的 job/step）
3. 提供优化建议与预期收益评估
4. 追踪效率趋势，发现性能退化
5. 在管理后台提供可视化看板

## 3. 范围

- **包含**：
  - GitHub Actions Workflow 运行数据采集器
  - 耗时分析引擎（job 级别 + step 级别）
  - 瓶颈识别算法（基于历史数据）
  - 效率趋势追踪与预警
  - 管理后台可视化看板
  - 优化建议生成器

- **不包含**：
  - 自动执行优化（仅提供建议）
  - 其他 CI 平台支持（仅 GitHub Actions）

## 4. 详细需求

### 4.1 数据采集层

```javascript
// backend/jobs/pipelineAnalyzer.js
{
  // GitHub API 集成
  githubClient: {
    baseUrl: 'https://api.github.com',
    auth: 'GITHUB_TOKEN'
  },
  
  // 采集数据结构
  pipelineRun: {
    id: 'string',
    workflowId: 'string',
    workflowName: 'string',
    runNumber: 'number',
    status: 'completed|in_progress|queued',
    conclusion: 'success|failure|cancelled|skipped',
    createdAt: 'ISO8601',
    updatedAt: 'ISO8601',
    durationMs: 'number',
    jobs: [{
      id: 'string',
      name: 'string',
      status: 'string',
      conclusion: 'string',
      durationMs: 'number',
      steps: [{
        name: 'string',
        number: 'number',
        status: 'string',
        conclusion: 'string',
        durationMs: 'number'
      }]
    }]
  }
}
```

### 4.2 分析引擎

```javascript
// backend/shared/pipelineAnalysisEngine.js
{
  // 瓶颈识别
  detectBottlenecks: (runs, options) => {
    // 按耗时排序
    // 识别慢于阈值的 job/step
    // 计算影响权重
  },
  
  // 趋势分析
  analyzeTrends: (runs, timeRange) => {
    // 计算效率变化率
    // 检测性能退化
    // 预测未来趋势
  },
  
  // 优化建议
  generateRecommendations: (bottlenecks) => {
    // 基于瓶颈类型生成建议
    // 预估优化收益
    // 按优先级排序
  }
}
```

### 4.3 数据库设计

```sql
-- 流水线运行记录
CREATE TABLE pipeline_runs (
  id VARCHAR(50) PRIMARY KEY,
  workflow_name VARCHAR(100) NOT NULL,
  run_number INTEGER NOT NULL,
  status VARCHAR(20),
  conclusion VARCHAR(20),
  duration_ms BIGINT,
  trigger_actor VARCHAR(100),
  head_branch VARCHAR(200),
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  raw_data JSONB
);

-- Job 级别统计
CREATE TABLE pipeline_job_stats (
  id SERIAL PRIMARY KEY,
  run_id VARCHAR(50) REFERENCES pipeline_runs(id),
  job_name VARCHAR(200),
  duration_ms BIGINT,
  status VARCHAR(20),
  step_count INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 瓶颈记录
CREATE TABLE pipeline_bottlenecks (
  id SERIAL PRIMARY KEY,
  workflow_name VARCHAR(100),
  job_name VARCHAR(200),
  step_name VARCHAR(200),
  avg_duration_ms BIGINT,
  occurrence_count INTEGER,
  severity VARCHAR(20), -- 'critical'|'high'|'medium'|'low'
  recommendation TEXT,
  estimated_savings_ms BIGINT,
  last_detected_at TIMESTAMP
);
```

### 4.4 API 接口

```
GET /api/pipeline-analysis/runs
  ?workflow={name}
  &startDate={ISO8601}
  &endDate={ISO8601}
  &limit={number}

GET /api/pipeline-analysis/bottlenecks
  ?minSeverity={level}
  &limit={number}

GET /api/pipeline-analysis/trends
  ?workflow={name}
  &period={7d|30d|90d}

GET /api/pipeline-analysis/recommendations
  ?priority={P0|P1|P2}
```

### 4.5 定时任务

```javascript
// backend/jobs/pipelineAnalyzer.js
// 每 5 分钟采集一次 GitHub Actions 运行数据
// 每小时执行一次效率分析
// 每日生成效率报告
```

## 5. 验收标准（可测试）

- [ ] 能够自动采集 GitHub Actions Workflow 运行数据，延迟不超过 5 分钟
- [ ] 能够识别最慢的 Top 10 job 和 step，准确率 >= 95%
- [ ] 能够检测效率趋势变化，预警阈值可配置
- [ ] 管理后台展示流水线效率看板，包含：
  - 最近 7 天执行次数与成功率
  - 平均执行时间趋势图
  - 瓶颈排行榜
  - 优化建议列表
- [ ] 优化建议包含预估收益（节省时间）
- [ ] 单元测试覆盖率 >= 80%

## 6. 工作量估算

**L**（Large）
- 理由：涉及数据采集、分析引擎、数据库设计、API 开发、前端看板等多个模块

## 7. 优先级理由

P1 理由：
- CI/CD 效率直接影响开发体验和发布速度
- 当前缺乏系统化分析手段，优化靠经验猜测
- 解决后可显著提升团队效率，每次流水线节省 1-5 分钟将带来可观的时间节省