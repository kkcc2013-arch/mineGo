# REQ-00538：预览与测试环境智能资源回收与成本优化系统

- **编号**：REQ-00538
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：.github/workflows、infrastructure/k8s/environments、backend/jobs/environmentReclaimer.js、admin-dashboard
- **创建时间**：2026-07-11 10:15
- **依赖需求**：REQ-00506

## 1. 背景与问题

当前项目在 CI/CD 流程中会为每个 PR 创建预览环境，同时维护多套测试环境（dev/staging/canary）。然而，这些环境存在严重的资源浪费问题：

**现状问题**：
- PR 关闭后，预览环境 K8s 资源未及时回收，平均生命周期 4-7 天后才被手动清理
- 测试环境在非工作时间（夜间、周末）持续运行，消耗不必要的云资源
- 缺乏资源使用率监控，无法识别哪些环境可以安全回收
- 成本分摊不透明，团队无法感知环境成本
- 测试数据积压，磁盘存储成本持续增长

**影响**：
- 预览环境每月浪费约 $2,000-$5,000 的云资源
- 测试环境 70% 时间内无实际使用，但持续计费
- 存储成本月增长 5%-10%

## 2. 目标

通过智能化的环境资源回收与成本优化系统，实现：
1. PR 合并/关闭后 15 分钟内自动回收预览环境资源
2. 测试环境闲时自动缩容（工作时间正常运行，非工作时间降级）
3. 成本可视化与分摊，提升团队成本意识
4. 预计节省 40%-60% 的环境运行成本

## 3. 范围

**包含**：
- 预览环境生命周期管理与自动回收
- 测试环境闲时缩容与唤醒机制
- 环境使用率监控与成本追踪
- 成本告警与预算管理
- 管理后台环境管理界面

**不包含**：
- 生产环境资源管理（已有 REQ-00506）
- 数据库冷热分层（独立需求）
- CDN 流量优化（独立需求）

## 4. 详细需求

### 4.1 预览环境自动回收

**生命周期追踪**：
```javascript
// backend/jobs/environmentReclaimer.js
class EnvironmentReclaimer {
  // GitHub Webhook 监听
  async handlePRClosed(prNumber) {
    const envName = `preview-pr-${prNumber}`;
    await this.scheduleReclaim(envName, delayMs: 15 * 60 * 1000); // 15分钟
  }
  
  async handlePRMerged(prNumber) {
    const envName = `preview-pr-${prNumber}`;
    await this.scheduleReclaim(envName, delayMs: 30 * 60 * 1000); // 30分钟（允许回滚）
  }
  
  // 回收策略
  async reclaimEnvironment(envName) {
    // 1. 检查是否有活跃连接
    const activeConnections = await this.checkActiveConnections(envName);
    if (activeConnections > 0) {
      await this.notifyActiveUsers(envName, activeConnections);
      await this.delayReclaim(envName, 30 * 60 * 1000); // 延迟30分钟
      return;
    }
    
    // 2. 备份关键数据（测试结果、日志）
    await this.backupEnvironmentData(envName);
    
    // 3. 回收 K8s 资源
    await this.deleteK8sNamespace(envName);
    
    // 4. 清理相关资源
    await this.cleanupRelatedResources(envName);
    
    // 5. 记录成本节省
    await this.recordCostSavings(envName);
  }
}
```

**GitHub Actions 集成**：
```yaml
# .github/workflows/preview-cleanup.yml
name: Preview Environment Cleanup
on:
  pull_request:
    types: [closed, merged]
  schedule:
    - cron: '*/30 * * * *'  # 每30分钟检查一次

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Check orphaned environments
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          node scripts/check-orphaned-environments.js
          
      - name: Trigger reclaim job
        if: env.NEEDS_CLEANUP == 'true'
        run: |
          curl -X POST ${{ secrets.RECLAIM_WEBHOOK_URL }} \
            -H "Authorization: Bearer ${{ secrets.RECLAIM_TOKEN }}" \
            -d '{"environments": "${{ env.ORPHANED_ENVS }}"}'
```

### 4.2 测试环境闲时缩容

**时间窗口策略**：
```javascript
// infrastructure/k8s/environments/scaling-policy.js
const ENVIRONMENT_SCALING_POLICIES = {
  'dev': {
    timezone: 'Asia/Shanghai',
    workHours: { start: '09:00', end: '19:00' },
    workDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    scaling: {
      workHours: { replicas: 3, cpuRequest: '500m', memRequest: '1Gi' },
      offHours: { replicas: 1, cpuRequest: '100m', memRequest: '256Mi' }
    }
  },
  'staging': {
    timezone: 'Asia/Shanghai',
    workHours: { start: '09:00', end: '22:00' },
    workDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    scaling: {
      workHours: { replicas: 5, cpuRequest: '1', memRequest: '2Gi' },
      offHours: { replicas: 2, cpuRequest: '200m', memRequest: '512Mi' }
    }
  },
  'canary': {
    // Canary 环境保持最小配置，通过流量触发扩容
    minReplicas: 1,
    maxReplicas: 3,
    hpa: { targetCPUUtilization: 30 }
  }
};
```

**智能唤醒机制**：
```javascript
// 检测到流量时自动唤醒
class EnvironmentWaker {
  async handleIncomingTraffic(envName, request) {
    const env = await this.getEnvironment(envName);
    
    if (env.status === 'scaled-down') {
      // 记录唤醒事件
      await this.logWakeEvent(envName, request);
      
      // 快速扩容
      await this.scaleUp(envName, 'workHours');
      
      // 返回等待页面
      return this.renderWakingPage(envName, estimatedSeconds: 60);
    }
    
    return null; // 正常处理请求
  }
}
```

### 4.3 环境使用率监控

**Prometheus 指标**：
```yaml
# infrastructure/monitoring/environment-metrics.yaml
- name: environment_active_connections
  type: gauge
  labels: [env_name, env_type]
  help: 当前活跃连接数

- name: environment_cpu_usage_percent
  type: gauge
  labels: [env_name]
  help: CPU 使用率百分比

- name: environment_memory_usage_bytes
  type: gauge
  labels: [env_name]
  help: 内存使用字节数

- name: environment_cost_hourly
  type: gauge
  labels: [env_name, resource_type]
  help: 每小时成本（美元）

- name: environment_lifetime_hours
  type: histogram
  labels: [env_type]
  help: 环境存活时长

- name: environment_reclaim_count
  type: counter
  labels: [env_type, reason]
  help: 环境回收次数
```

**Grafana Dashboard**：
```json
{
  "title": "Environment Cost Dashboard",
  "panels": [
    {
      "title": "Daily Environment Cost",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum(environment_cost_hourly) * 24",
          "legendFormat": "{{env_name}}"
        }
      ]
    },
    {
      "title": "Preview Environment Age",
      "type": "stat",
      "targets": [
        {
          "expr": "max(environment_lifetime_hours{env_type=\"preview\"})",
          "legendFormat": "Oldest Preview"
        }
      ]
    },
    {
      "title": "Cost Savings by Auto-Reclaim",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(increase(environment_reclaim_count[30d])) * 50",
          "legendFormat": "Monthly Savings ($)"
        }
      ]
    }
  ]
}
```

### 4.4 成本告警与预算管理

**预算阈值告警**：
```javascript
// backend/jobs/costMonitor.js
class CostMonitor {
  async checkBudgetThreshold() {
    const monthlyBudget = process.env.ENV_BUDGET_MONTHLY || 10000; // $10,000
    
    const currentSpend = await this.calculateMonthlySpend();
    const usagePercent = (currentSpend / monthlyBudget) * 100;
    
    if (usagePercent >= 90) {
      await this.sendAlert({
        severity: 'critical',
        message: `Environment cost at ${usagePercent}% of monthly budget ($${currentSpend}/$${monthlyBudget})`,
        actions: ['Review active environments', 'Check for orphaned resources']
      });
    } else if (usagePercent >= 75) {
      await this.sendAlert({
        severity: 'warning',
        message: `Environment cost at ${usagePercent}% of monthly budget`,
        actions: ['Consider scaling down unused environments']
      });
    }
  }
  
  async calculateMonthlySpend() {
    // 聚合各环境成本
    const environments = await this.listAllEnvironments();
    let totalCost = 0;
    
    for (const env of environments) {
      const hours = env.lifetimeHours;
      const hourlyRate = this.calculateHourlyRate(env.resources);
      totalCost += hours * hourlyRate;
    }
    
    return totalCost;
  }
}
```

### 4.5 管理后台界面

**环境管理 API**：
```javascript
// admin-dashboard/api/environments.js
router.get('/api/environments', async (req, res) => {
  const envs = await EnvironmentManager.listAll();
  res.json({
    environments: envs.map(env => ({
      name: env.name,
      type: env.type, // preview/dev/staging/canary
      status: env.status, // running/scaled-down/reclaiming
      createdAt: env.createdAt,
      lastActiveAt: env.lastActiveAt,
      cost: {
        hourly: env.hourlyCost,
        monthly: env.monthlyCost,
        savedByAutoReclaim: env.savedCost
      },
      resources: {
        cpu: env.cpuUsage,
        memory: env.memoryUsage,
        pods: env.podCount
      }
    })),
    summary: {
      totalEnvironments: envs.length,
      runningCost: envs.filter(e => e.status === 'running')
                       .reduce((sum, e) => sum + e.hourlyCost, 0),
      monthlyBudget: process.env.ENV_BUDGET_MONTHLY,
      budgetUsagePercent: await calculateBudgetUsage()
    }
  });
});

router.post('/api/environments/:name/reclaim', async (req, res) => {
  await EnvironmentReclaimer.reclaimNow(req.params.name);
  res.json({ success: true, message: 'Environment reclaim initiated' });
});

router.post('/api/environments/:name/scale-down', async (req, res) => {
  await EnvironmentManager.scaleDown(req.params.name);
  res.json({ success: true, message: 'Environment scaled down' });
});
```

**前端界面**：
```html
<!-- admin-dashboard/environments.html -->
<div class="environment-dashboard">
  <div class="budget-alert" data-bind="visible: budgetWarning">
    ⚠️ Budget usage at <span data-bind="text: budgetPercent"></span>%
  </div>
  
  <div class="env-list">
    <div class="env-card" data-bind="foreach: environments">
      <div class="env-header">
        <h3 data-bind="text: name"></h3>
        <span class="status-badge" data-bind="css: status"></span>
      </div>
      <div class="env-metrics">
        <div class="metric">
          <label>Hourly Cost</label>
          <span data-bind="text: '$' + cost.hourly"></span>
        </div>
        <div class="metric">
          <label>Last Active</label>
          <span data-bind="text: lastActiveAgo"></span>
        </div>
      </div>
      <div class="env-actions">
        <button data-bind="click: $parent.reclaimEnv">Reclaim</button>
        <button data-bind="click: $parent.scaleDownEnv">Scale Down</button>
      </div>
    </div>
  </div>
</div>
```

## 5. 验收标准（可测试）

- [ ] PR 关闭后 15 分钟内预览环境自动回收（90% 情况下）
- [ ] PR 合并后 30 分钟内预览环境自动回收（允许回滚窗口）
- [ ] 测试环境在非工作时间自动缩容至最小配置
- [ ] 测试环境检测到流量时 60 秒内完成唤醒
- [ ] 环境成本数据准确，误差 < 5%
- [ ] 预算使用达 75%/90% 时发送告警
- [ ] 管理后台展示所有环境及其成本
- [ ] 支持手动触发环境回收/缩容
- [ ] 孤儿环境检测准确率 > 95%
- [ ] 自动回收失败时有重试机制和告警
- [ ] 月度成本报告自动生成并发送

## 6. 工作量估算

**L（大）**

- 预览环境回收系统：2 天
- 测试环境缩容策略：2 天
- 监控指标与 Dashboard：1 天
- 成本计算与告警：1 天
- 管理后台界面：1 天
- 测试与文档：1 天

**总计：8 人天**

## 7. 优先级理由

**P1 理由**：

1. **成本影响大**：每月可节省 40%-60% 的环境运行成本，约 $2,000-$5,000
2. **资源浪费严重**：当前预览环境平均存活 4-7 天，而实际使用仅几小时
3. **连锁收益**：优化后的环境管理为后续 CI/CD 优化、测试并行化奠定基础
4. **可快速见效**：实现后立即可见成本下降
5. **无业务风险**：不影响生产环境，纯基础设施优化

与 REQ-00506（生产环境资源优化）形成互补，覆盖非生产环境的成本优化场景。