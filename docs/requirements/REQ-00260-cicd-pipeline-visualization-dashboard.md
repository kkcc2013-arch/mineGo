# REQ-00260：CI/CD 管道执行可视化与实时监控仪表板系统

- **编号**：REQ-00260
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：.github/workflows、admin-dashboard、backend/shared/PipelineMonitor.js、backend/jobs、infrastructure/k8s
- **创建时间**：2026-06-18 16:00
- **依赖需求**：REQ-00006（K8s 滚动更新与回滚自动化）、REQ-00024（蓝绿部署策略实现）

## 1. 背景与问题

当前 mineGo 项目已实现完整的 CI/CD 流水线（ci-cd.yml），包含测试、安全扫描、构建、金丝雀发布、完整部署等阶段。然而，CI/CD 执行状态分散在 GitHub Actions 界面中，运维人员需要：

1. **缺乏统一视图**：无法在 admin-dashboard 中直接查看当前部署状态、历史执行记录、失败原因统计
2. **实时监控不足**：构建失败、部署超时等问题无法及时告警，需要手动刷新 GitHub 页面
3. **历史追溯困难**：无法快速定位某次部署引入的问题，缺乏与 git commit/PR 的关联视图
4. **失败分析缺失**：构建失败后无智能建议，需人工排查日志

## 2. 目标

构建统一的 CI/CD 管道可视化与监控系统：
- 在 admin-dashboard 提供实时 CI/CD 执行仪表板
- 实现管道执行状态 WebSocket 推送
- 提供失败原因智能分析与修复建议
- 支持部署历史追溯与回滚一键操作

## 3. 范围

- **包含**：
  - GitHub Actions Webhook 接收与状态解析
  - 管道执行数据存储（PostgreSQL）
  - 实时状态 WebSocket 推送
  - admin-dashboard 仪表板页面
  - 失败原因分析与建议生成
  - 部署历史 API 接口

- **不包含**：
  - CI/CD 流水线本身修改（已有 ci-cd.yml）
  - 自动修复功能（仅提供建议）
  - 多项目支持（仅限 mineGo）

## 4. 详细需求

### 4.1 GitHub Webhook 接收服务
```javascript
// backend/shared/PipelineMonitor.js
POST /api/pipeline/webhook
- 接收 GitHub Actions workflow_run 事件
- 解析执行状态：queued, in_progress, completed
- 存储到 pipeline_executions 表
- 触发 WebSocket 广播
```

### 4.2 数据模型
```sql
CREATE TABLE pipeline_executions (
  id SERIAL PRIMARY KEY,
  workflow_name VARCHAR(255) NOT NULL,
  run_id BIGINT NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL, -- queued, in_progress, success, failure, cancelled
  conclusion VARCHAR(50), -- success, failure, cancelled, timed_out
  trigger_actor VARCHAR(255),
  head_branch VARCHAR(255),
  head_sha VARCHAR(40),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  duration_seconds INTEGER,
  jobs JSONB, -- 各 job 执行详情
  failure_reason TEXT,
  suggested_fix TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4.3 WebSocket 实时推送
```javascript
// 客户端订阅
ws.send({ type: 'subscribe', channel: 'pipeline' })

// 服务端推送格式
{
  type: 'pipeline_update',
  data: {
    run_id: 123456,
    workflow_name: 'CI/CD Pipeline',
    status: 'in_progress',
    current_job: 'build',
    progress: 45
  }
}
```

### 4.4 失败分析引擎
```javascript
// 常见失败模式识别
const failurePatterns = [
  { pattern: /ENOSPC/, suggestion: '磁盘空间不足，请清理 runner 缓存' },
  { pattern: /ETIMEDOUT/, suggestion: '网络超时，检查依赖源或重试' },
  { pattern: /SyntaxError/, suggestion: '代码语法错误，请检查最近提交' },
  { pattern: /Test failed/, suggestion: '单元测试失败，查看测试报告' },
  { pattern: /Security scan failed/, suggestion: '安全漏洞检测失败，检查依赖版本' }
];
```

### 4.5 Admin Dashboard 仪表板
- 当前执行状态卡片（运行中/最近失败/最近成功）
- 执行历史列表（分页、筛选、搜索）
- 单次执行详情页（job 时间线、日志片段、失败分析）
- 部署趋势图表（成功率、平均耗时）

### 4.6 API 接口
```
GET  /api/pipeline/executions       - 列表查询（分页、状态筛选）
GET  /api/pipeline/executions/:id   - 单次详情
GET  /api/pipeline/stats            - 统计数据（成功率、趋势）
POST /api/pipeline/rerun/:run_id    - 触发重新执行
GET  /api/pipeline/rollback/:run_id - 获取可回滚版本
```

## 5. 验收标准（可测试）

- [ ] GitHub Webhook 能正确接收 workflow_run 事件并存储到数据库
- [ ] WebSocket 客户端能实时收到管道状态更新（延迟 < 1s）
- [ ] admin-dashboard 能展示当前执行状态和历史记录
- [ ] 失败执行能自动生成修复建议（准确率 > 80%）
- [ ] 统计 API 返回正确的成功率和平均耗时
- [ ] 支持按状态、时间范围、分支筛选执行记录
- [ ] 回滚操作能在 30s 内完成并更新状态

## 6. 工作量估算

**L** - 需要实现 Webhook 接收、WebSocket 推送、数据模型、失败分析引擎、前端仪表板等多个组件，预计 3-5 天。

## 7. 优先级理由

P1 级别：CI/CD 可视化是运维效率的关键提升点，当前每次部署需要手动查看 GitHub 页面，严重影响问题排查效率。与已完成的金丝雀发布、蓝绿部署形成闭环，是"运维与交付"维度成熟度提升的重要一环。
