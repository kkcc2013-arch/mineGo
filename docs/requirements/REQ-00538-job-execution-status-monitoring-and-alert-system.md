# REQ-00538：任务执行状态实时监控与智能告警系统

- **编号**：REQ-00538
- **类别**：运维/CICD
- **优先级**：P1
- **状态**: done
- **涉及服务/模块**：backend/jobs、backend/shared/jobMonitor、infrastructure/monitoring、admin-dashboard
- **创建时间**：2026-07-11 11:00
- **依赖需求**：REQ-00491（监控指标生命周期管理）

## 1. 背景与问题

当前 backend/jobs/ 目录包含 22 个定时任务（自动备份、数据清理、分区管理、索引优化、灾备演练调度器等），各任务独立维护状态，但存在以下痛点：

1. **分散的状态管理**：每个任务使用简单的内存状态对象（如 `jobStatus`），无法全局聚合查看
2. **缺少实时监控仪表板**：运维人员无法直观看到哪些任务正在运行、哪些失败、失败原因是什么
3. **告警机制不统一**：任务失败时没有统一的告警通道，依赖各任务自行处理日志
4. **执行历史缺乏追踪**：任务执行历史分散在日志中，难以追溯和分析趋势
5. **智能诊断缺失**：连续失败时缺少根因分析和智能建议

## 2. 目标

构建统一的任务执行状态监控与智能告警系统，实现：

- 所有定时任务状态的实时聚合与可视化
- 任务失败的智能告警与根因分析
- 执行历史趋势追踪与报表生成
- 告警噪音抑制与智能聚合
- 运维人员可通过管理后台快速定位问题任务

## 3. 范围

- **包含**：
  - JobStatusAggregator 任务状态聚合器（收集所有 jobs/ 目录任务状态）
  - JobExecutionLogger 执行日志持久化（PostgreSQL 存储）
  - JobMonitorDashboard 监控仪表板 API（供 admin-dashboard 使用）
  - SmartAlertEngine 智能告警引擎（失败告警、噪音抑制、聚合）
  - JobHealthChecker 任务健康检查（超时检测、僵尸任务识别）
  - 执行趋势分析与报表生成器

- **不包含**：
  - 任务调度逻辑改造（任务本身保持现有结构）
  - 任务代码重构（仅添加状态上报接口）

## 4. 详细需求

### 4.1 任务状态聚合器（JobStatusAggregator）

```javascript
// backend/shared/jobMonitor/jobStatusAggregator.js

class JobStatusAggregator {
  constructor() {
    this.statusCache = new RedisClient(); // Redis 缓存实时状态
    this.aggregateInterval = 30000; // 30 秒聚合一次
  }

  // 任务注册接口（各任务启动时调用）
  registerJob(jobId, jobName, schedule, category) {}

  // 状态上报接口（任务调用）
  reportStatus(jobId, status, metadata) {
    // status: 'idle' | 'running' | 'success' | 'failed' | 'timeout'
    // metadata: { startTime, endTime, duration, error, progress }
  }

  // 获取所有任务状态
  getAllJobsStatus() {}

  // 按类别筛选
  getJobsByCategory(category) {}

  // 获取失败任务
  getFailedJobs() {}
}
```

### 4.2 执行日志持久化（JobExecutionLogger）

```sql
-- 数据库迁移：job_execution_logs 表
CREATE TABLE job_execution_logs (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(100) NOT NULL,
  job_name VARCHAR(200),
  category VARCHAR(50),
  status VARCHAR(20) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  duration_ms INTEGER,
  error_message TEXT,
  error_stack TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_job_logs_job_id ON job_execution_logs(job_id);
CREATE INDEX idx_job_logs_status ON job_execution_logs(status);
CREATE INDEX idx_job_logs_start_time ON job_execution_logs(start_time DESC);
```

### 4.3 智能告警引擎（SmartAlertEngine）

```javascript
// backend/shared/jobMonitor/smartAlertEngine.js

class SmartAlertEngine {
  constructor() {
    this.alertRules = new Map();
    this.noiseSuppressor = new NoiseSuppressor();
    this.aggregator = new AlertAggregator();
  }

  // 告警规则配置
  addAlertRule(rule) {
    // rule: { jobId, conditions, severity, channels }
    // conditions: { failureCount, timeoutMinutes, consecutiveFailures }
  }

  // 检查并触发告警
  checkAndAlert(jobId, status) {
    // 1. 检查告警条件
    // 2. 噪音抑制（相同告警 10 分钟内不重复）
    // 3. 告警聚合（相关任务失败合并为一条告警）
    // 4. 发送到配置通道（Slack/Email/短信/Push）
  }

  // 根因分析建议
  analyzeRootCause(jobId, errorHistory) {
    // 分析连续失败模式，给出智能诊断建议
    // 如："索引优化任务连续失败，建议检查磁盘空间"
  }
}
```

### 4.4 任务健康检查器（JobHealthChecker）

```javascript
// backend/shared/jobMonitor/jobHealthChecker.js

class JobHealthChecker {
  constructor(aggregator) {
    this.timeoutThresholds = new Map(); // 各任务超时阈值
  }

  // 检测僵尸任务（运行超过阈值）
  detectZombieJobs() {}

  // 检测长期未运行的任务
  detectStaleJobs(staleMinutes) {}

  // 健康评分计算
  calculateHealthScore(jobId) {
    // 基于成功率、平均耗时、最近失败数计算
    // 返回 0-100 分
  }
}
```

### 4.5 监控仪表板 API

```javascript
// backend/gateway/src/routes/jobMonitor.js

// GET /api/admin/jobs/status - 获取所有任务实时状态
// GET /api/admin/jobs/:jobId/history - 获取执行历史
// GET /api/admin/jobs/:jobId/health - 获取健康评分
// GET /api/admin/jobs/statistics - 获取统计报表
// GET /api/admin/jobs/alerts - 获取活跃告警列表
// POST /api/admin/jobs/:jobId/restart - 手动重启失败任务
// POST /api/admin/jobs/:jobId/skip - 跳过本次执行
```

### 4.6 执行趋势分析

```javascript
// backend/shared/jobMonitor/trendAnalyzer.js

class TrendAnalyzer {
  // 按天/周/月统计成功率
  getSuccessRateTrend(jobId, period) {}

  // 平均耗时趋势
  getDurationTrend(jobId, period) {}

  // 失败类型分布
  getFailureTypeDistribution(jobId) {}

  // 热力图数据（任务执行时间分布）
  getExecutionHeatmap(jobId) {}
}
```

## 5. 验收标准（可测试）

- [ ] 所有 backend/jobs/ 目录的任务（22 个）均注册到 JobStatusAggregator
- [ ] 任务状态实时聚合延迟 < 5 秒（从状态变更到仪表板可见）
- [ ] PostgreSQL 表 job_execution_logs 持久化所有执行记录，支持 90 天历史查询
- [ ] 任务失败时，智能告警引擎在 60 秒内发送告警到配置通道
- [ ] 噪音抑制生效：相同告警在 10 分钟内仅发送一次
- [ ] 僵尸任务检测准确率 > 95%（运行超过阈值的任务被正确识别）
- [ ] 健康评分计算覆盖所有任务，评分准确性验证（与实际成功率对比误差 < 10%）
- [ ] admin-dashboard 显示实时任务监控仪表板，包含状态、成功率、趋势图
- [ ] 单元测试覆盖率 > 80%（覆盖聚合器、告警引擎、健康检查器）
- [ ] 端到端测试：模拟任务失败场景，验证告警链路完整性

## 6. 工作量估算

**L（Large）** - 涉及多个模块：
- 任务状态聚合器（核心模块）
- 执行日志持久化（数据库迁移 + ORM）
- 智能告警引擎（规则引擎 + 多通道发送）
- 健康检查器（超时检测 + 评分算法）
- 监控仪表板 API（5+ 端点）
- 趋势分析器（统计算法）
- admin-dashboard 前端页面更新

预计开发时间：3-4 天

## 7. 优先级理由

**P1（高优先级）**：
1. **运维可见性关键**：22 个定时任务是运维核心组件，缺少统一监控导致故障排查困难
2. **告警机制缺失**：任务失败无告警，可能导致数据备份失败、索引优化停止等严重后果
3. **成熟度提升**：当前"运维与交付"维度评分仅 5/5，此需求可显著提升运维可观测性
4. **依赖链上游**：其他需求（如 REQ-00519 任务队列可靠性）可依赖此监控系统

---

**编号**: REQ-00538
**类别**: 运维/CICD
**优先级**: P1
**状态**: new