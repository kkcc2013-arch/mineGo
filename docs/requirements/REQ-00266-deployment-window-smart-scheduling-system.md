# REQ-00266：部署窗口智能调度系统

- **编号**：REQ-00266
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：.github/workflows、backend/shared/DeploymentScheduler.js、admin-dashboard、PostgreSQL、Redis
- **创建时间**：2026-06-18 20:00
- **依赖需求**：REQ-00006（K8s 滚动更新与回滚自动化）、REQ-00061（服务健康仪表板）

## 1. 背景与问题

当前 mineGo 的 CI/CD 流程采用推送触发式部署，存在以下问题：

1. **低效时段部署风险高**：在用户活跃高峰期（如周末晚间、节假日）执行部署，一旦失败影响用户量大
2. **缺少智能调度**：无法自动根据历史流量数据、服务负载、用户活跃度选择最佳部署窗口
3. **人工决策负担**：运维人员需手动评估部署时机，决策缺乏数据支撑
4. **故障时段关联分析缺失**：未统计历史故障与部署时段的关联关系
5. **跨时区服务部署优化**：mineGo 服务全球用户，不同时区活跃时段不同，当前无智能调度

现有 `.github/workflows/deploy-with-rollback.yml` 只支持手动 `workflow_dispatch`，没有智能调度能力。

## 2. 目标

构建部署窗口智能调度系统，实现：

1. **智能窗口推荐**：基于历史流量、用户活跃度、故障时段分析，自动推荐最佳部署窗口
2. **自动调度部署**：在配置的安全窗口内自动触发部署，减少人工干预
3. **风险时段规避**：自动识别并规避高风险时段（高峰期、历史故障多发时段）
4. **跨时区优化**：考虑全球用户分布，选择影响最小的部署时机
5. **部署成功率提升**：目标将部署成功率从当前 ~92% 提升至 98%+

## 3. 范围

### 包含
- 部署窗口调度引擎设计与实现
- 历史流量与故障数据分析模块
- 智能窗口推荐算法
- 部署排队与自动触发机制
- 管理后台窗口配置界面
- 与现有 CI/CD 流程集成
- 部署时段统计报表

### 不包含
- 多区域蓝绿部署编排（已有 REQ-00024）
- 金丝雀发布流量控制（已有 REQ-00078）
- 故障自动恢复（已有 REQ-00061）

## 4. 详细需求

### 4.1 部署窗口调度引擎

```javascript
// backend/shared/DeploymentScheduler.js
class DeploymentScheduler {
  constructor(config) {
    this.redis = config.redis;
    this.pg = config.pg;
    this.config = {
      defaultWindowStart: 2,    // 默认窗口开始时间 02:00 UTC
      defaultWindowEnd: 6,      // 默认窗口结束时间 06:00 UTC
      minQuietMinutes: 30,      // 最小静默期
      maxQueueWaitHours: 24,    // 最大排队等待时间
      peakHoursWeight: 0.4,     // 高峰时段权重
      errorHistoryWeight: 0.3,  // 故障历史权重
      weekendPenalty: 0.2       // 周末惩罚因子
    };
  }

  /**
   * 获取推荐部署窗口
   * @param {string} serviceName - 服务名称
   * @param {string} urgency - 紧急程度: routine | important | critical
   * @returns {Object} 推荐窗口信息
   */
  async getRecommendedWindow(serviceName, urgency = 'routine') {
    // 1. 获取服务流量模式
    const trafficPattern = await this.getTrafficPattern(serviceName);
    
    // 2. 获取历史故障时段
    const errorHours = await this.getErrorProneHours(serviceName);
    
    // 3. 获取当前系统负载
    const currentLoad = await this.getCurrentSystemLoad();
    
    // 4. 计算最佳窗口
    const windows = this.calculateOptimalWindows({
      trafficPattern,
      errorHours,
      currentLoad,
      urgency
    });
    
    return {
      recommended: windows[0],
      alternatives: windows.slice(1, 3),
      reasoning: this.explainRecommendation(windows[0]),
      riskScore: windows[0].riskScore
    };
  }

  /**
   * 分析流量模式
   */
  async getTrafficPattern(serviceName) {
    const key = `traffic:pattern:${serviceName}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);

    // 查询最近 30 天的请求量统计
    const result = await this.pg.query(`
      SELECT 
        EXTRACT(HOUR FROM created_at) as hour,
        EXTRACT(DOW FROM created_at) as day_of_week,
        COUNT(*) as request_count,
        AVG(response_time) as avg_response_time
      FROM api_logs
      WHERE service = $1 
        AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY hour, day_of_week
      ORDER BY request_count DESC
    `, [serviceName]);

    const pattern = this.aggregatePattern(result.rows);
    await this.redis.setex(key, 3600, JSON.stringify(pattern));
    return pattern;
  }

  /**
   * 获取故障易发时段
   */
  async getErrorProneHours(serviceName) {
    const result = await this.pg.query(`
      SELECT 
        EXTRACT(HOUR FROM created_at) as hour,
        EXTRACT(DOW FROM created_at) as day_of_week,
        COUNT(*) FILTER (WHERE level = 'error') as error_count,
        COUNT(*) as total_count,
        AVG(duration_ms) as avg_duration
      FROM deployment_history
      WHERE service = $1 
        AND created_at > NOW() - INTERVAL '90 days'
        AND (status = 'failed' OR status = 'rolled_back')
      GROUP BY hour, day_of_week
      HAVING COUNT(*) FILTER (WHERE level = 'error') > 0
      ORDER BY error_count DESC
    `, [serviceName]);

    return result.rows.map(r => ({
      hour: r.hour,
      dayOfWeek: r.day_of_week,
      errorRate: r.error_count / r.total_count,
      avgDuration: r.avg_duration
    }));
  }

  /**
   * 计算最优部署窗口
   */
  calculateOptimalWindows(params) {
    const { trafficPattern, errorHours, currentLoad, urgency } = params;
    const windows = [];
    const now = new Date();

    // 生成未来 24 小时的候选窗口（每小时一个）
    for (let i = 0; i < 24; i++) {
      const windowStart = new Date(now.getTime() + i * 60 * 60 * 1000);
      const hour = windowStart.getUTCHours();
      const dayOfWeek = windowStart.getUTCDay();

      // 计算风险评分（越低越好）
      let riskScore = 0;

      // 流量风险
      const trafficRisk = this.calculateTrafficRisk(hour, dayOfWeek, trafficPattern);
      riskScore += trafficRisk * this.config.peakHoursWeight;

      // 故障历史风险
      const errorRisk = this.calculateErrorRisk(hour, dayOfWeek, errorHours);
      riskScore += errorRisk * this.config.errorHistoryWeight;

      // 周末惩罚
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        riskScore += this.config.weekendPenalty;
      }

      // 当前系统负载
      if (currentLoad > 0.7) {
        riskScore += (currentLoad - 0.7) * 0.5;
      }

      // 紧急程度调整
      if (urgency === 'critical') {
        riskScore *= 0.5; // 紧急部署允许更高风险
      } else if (urgency === 'important') {
        riskScore *= 0.8;
      }

      windows.push({
        start: windowStart,
        end: new Date(windowStart.getTime() + 60 * 60 * 1000),
        hour,
        dayOfWeek,
        riskScore,
        trafficLevel: this.getTrafficLevel(hour, dayOfWeek, trafficPattern),
        estimatedImpact: this.estimateImpact(hour, dayOfWeek, trafficPattern)
      });
    }

    // 按风险评分排序
    return windows.sort((a, b) => a.riskScore - b.riskScore);
  }

  /**
   * 排队部署请求
   */
  async queueDeployment(options) {
    const { serviceName, version, urgency, requestedBy, maxWaitHours } = options;

    // 获取推荐窗口
    const recommendation = await this.getRecommendedWindow(serviceName, urgency);
    
    // 确定部署时间
    let scheduledAt;
    if (urgency === 'critical') {
      scheduledAt = new Date(); // 立即部署
    } else {
      scheduledAt = recommendation.recommended.start;
    }

    // 检查是否超过最大等待时间
    const waitHours = (scheduledAt - new Date()) / (1000 * 60 * 60);
    if (waitHours > (maxWaitHours || this.config.maxQueueWaitHours)) {
      // 选择更早的次优窗口
      const earlier = recommendation.alternatives.find(w => 
        (w.start - new Date()) / (1000 * 60 * 60) <= (maxWaitHours || this.config.maxQueueWaitHours)
      );
      if (earlier) scheduledAt = earlier.start;
    }

    // 创建部署队列记录
    const result = await this.pg.query(`
      INSERT INTO deployment_queue 
        (service_name, version, urgency, scheduled_at, requested_by, status, risk_score, recommendation)
      VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7)
      RETURNING id, scheduled_at
    `, [serviceName, version, urgency, scheduledAt, requestedBy, 
        recommendation.recommended.riskScore, JSON.stringify(recommendation)]);

    // 添加到 Redis 延迟队列
    await this.redis.zadd(
      'deployment:scheduled',
      scheduledAt.getTime(),
      result.rows[0].id
    );

    return {
      queueId: result.rows[0].id,
      scheduledAt: result.rows[0].scheduled_at,
      recommendation
    };
  }

  /**
   * 处理排队部署
   */
  async processQueue() {
    const now = Date.now();
    
    // 获取到期的部署任务
    const due = await this.redis.zrangebyscore(
      'deployment:scheduled',
      0,
      now,
      'LIMIT', 0, 10
    );

    for (const queueId of due) {
      // 检查系统状态
      const systemOk = await this.checkSystemHealth();
      
      if (systemOk) {
        await this.executeDeployment(queueId);
      } else {
        // 推迟 30 分钟
        await this.redis.zadd(
          'deployment:scheduled',
          now + 30 * 60 * 1000,
          queueId
        );
      }
    }
  }
}

module.exports = { DeploymentScheduler };
```

### 4.2 部署窗口配置 API

```javascript
// 部署窗口配置 API
const express = require('express');
const router = express.Router();
const { DeploymentScheduler } = require('../shared/DeploymentScheduler');

const scheduler = new DeploymentScheduler({
  redis: global.redis,
  pg: global.pg
});

// 获取推荐部署窗口
router.get('/api/deployment/window/recommend/:service', async (req, res) => {
  const { service } = req.params;
  const { urgency = 'routine' } = req.query;

  const recommendation = await scheduler.getRecommendedWindow(service, urgency);
  res.json({ success: true, data: recommendation });
});

// 排队部署请求
router.post('/api/deployment/queue', async (req, res) => {
  const { serviceName, version, urgency = 'routine', maxWaitHours } = req.body;

  const result = await scheduler.queueDeployment({
    serviceName,
    version,
    urgency,
    requestedBy: req.user?.id || 'system',
    maxWaitHours
  });

  res.json({ success: true, data: result });
});

// 获取部署队列状态
router.get('/api/deployment/queue', async (req, res) => {
  const { status, service } = req.query;
  
  let query = 'SELECT * FROM deployment_queue WHERE 1=1';
  const params = [];
  
  if (status) {
    params.push(status);
    query += ` AND status = $${params.length}`;
  }
  if (service) {
    params.push(service);
    query += ` AND service_name = $${params.length}`;
  }
  
  query += ' ORDER BY scheduled_at ASC LIMIT 50';
  
  const result = await global.pg.query(query, params);
  res.json({ success: true, data: result.rows });
});

// 取消排队部署
router.delete('/api/deployment/queue/:id', async (req, res) => {
  const { id } = req.params;
  
  await global.pg.query(
    "UPDATE deployment_queue SET status = 'cancelled' WHERE id = $1",
    [id]
  );
  
  await global.redis.zrem('deployment:scheduled', id);
  
  res.json({ success: true });
});

// 获取部署时段统计
router.get('/api/deployment/stats', async (req, res) => {
  const result = await global.pg.query(`
    SELECT 
      EXTRACT(HOUR FROM scheduled_at) as hour,
      COUNT(*) as total_deployments,
      COUNT(*) FILTER (WHERE status = 'success') as successful,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_duration_seconds,
      AVG(risk_score) as avg_risk_score
    FROM deployment_queue
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY hour
    ORDER BY hour
  `);
  
  res.json({ success: true, data: result.rows });
});
```

### 4.3 数据库表结构

```sql
-- 部署队列表
CREATE TABLE deployment_queue (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  version VARCHAR(50) NOT NULL,
  urgency VARCHAR(20) DEFAULT 'routine' CHECK (urgency IN ('routine', 'important', 'critical')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  requested_by VARCHAR(100),
  status VARCHAR(20) DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'success', 'failed', 'cancelled', 'postponed')),
  risk_score DECIMAL(3,2),
  recommendation JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  rollback_performed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_deployment_queue_scheduled ON deployment_queue(scheduled_at);
CREATE INDEX idx_deployment_queue_status ON deployment_queue(status);
CREATE INDEX idx_deployment_queue_service ON deployment_queue(service_name);

-- 部署窗口配置表
CREATE TABLE deployment_window_config (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  window_start_hour INT NOT NULL DEFAULT 2,
  window_end_hour INT NOT NULL DEFAULT 6,
  allowed_days INT[] DEFAULT ARRAY[1,2,3,4,5], -- 周一到周五
  blackout_hours JSONB DEFAULT '[]', -- 禁止部署的时段
  timezone VARCHAR(50) DEFAULT 'UTC',
  min_traffic_threshold INT DEFAULT 100, -- 最低流量阈值
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(service_name)
);

-- 部署历史表（扩展现有）
ALTER TABLE deployment_history ADD COLUMN IF NOT EXISTS risk_score DECIMAL(3,2);
ALTER TABLE deployment_history ADD COLUMN IF NOT EXISTS window_recommendation JSONB;
ALTER TABLE deployment_history ADD COLUMN IF NOT EXISTS was_scheduled BOOLEAN DEFAULT FALSE;
```

### 4.4 GitHub Actions 集成

```yaml
# .github/workflows/smart-deploy.yml
name: Smart Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      urgency:
        description: 'Deployment urgency'
        type: choice
        options: [routine, important, critical]
        default: routine
      force_now:
        description: 'Force immediate deployment (bypass scheduling)'
        type: boolean
        default: false

jobs:
  schedule:
    name: 🗓️ Schedule Deployment
    runs-on: ubuntu-latest
    outputs:
      scheduled_at: ${{ steps.schedule.outputs.scheduled_at }}
      should_deploy: ${{ steps.schedule.outputs.should_deploy }}
    
    steps:
      - uses: actions/checkout@v4

      - name: Get deployment window
        id: schedule
        run: |
          if [ "${{ inputs.force_now }}" = "true" ]; then
            echo "should_deploy=true" >> $GITHUB_OUTPUT
            echo "scheduled_at=now" >> $GITHUB_OUTPUT
          else
            # 调用部署调度 API
            RESPONSE=$(curl -s "${{ secrets.ADMIN_API_URL }}/api/deployment/window/recommend/gateway?urgency=${{ inputs.urgency || 'routine' }}" \
              -H "Authorization: Bearer ${{ secrets.ADMIN_API_TOKEN }}")
            
            SCHEDULED=$(echo $RESPONSE | jq -r '.data.recommended.start')
            RISK=$(echo $RESPONSE | jq -r '.data.recommended.riskScore')
            
            # 如果风险分数低于阈值且在 30 分钟内，立即部署
            NOW=$(date -u +%s)
            SCHEDULE_TS=$(date -u -d "$SCHEDULED" +%s 2>/dev/null || echo $((NOW + 3600)))
            DIFF=$((SCHEDULE_TS - NOW))
            
            if [ "$DIFF" -lt 1800 ] && [ $(echo "$RISK < 0.3" | bc) -eq 1 ]; then
              echo "should_deploy=true" >> $GITHUB_OUTPUT
              echo "scheduled_at=now" >> $GITHUB_OUTPUT
            else
              echo "should_deploy=false" >> $GITHUB_OUTPUT
              echo "scheduled_at=$SCHEDULED" >> $GITHUB_OUTPUT
              echo "::notice::Deployment scheduled for $SCHEDULED (risk: $RISK)"
            fi
          fi

  deploy:
    name: 🚀 Deploy
    needs: schedule
    if: needs.schedule.outputs.should_deploy == 'true'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Execute deployment
        run: |
          echo "Deploying now..."
          # 调用现有部署逻辑

  queue:
    name: 📋 Queue Deployment
    needs: schedule
    if: needs.schedule.outputs.should_deploy == 'false'
    runs-on: ubuntu-latest
    steps:
      - name: Queue for scheduled time
        run: |
          curl -X POST "${{ secrets.ADMIN_API_URL }}/api/deployment/queue" \
            -H "Authorization: Bearer ${{ secrets.ADMIN_API_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{
              "serviceName": "gateway",
              "version": "${{ github.sha }}",
              "urgency": "${{ inputs.urgency || 'routine' }}",
              "maxWaitHours": 24
            }'
          
          echo "::notice::Deployment queued for ${{ needs.schedule.outputs.scheduled_at }}"
```

### 4.5 管理后台界面

```html
<!-- admin-dashboard/deployment-scheduler.html -->
<!DOCTYPE html>
<html>
<head>
  <title>部署窗口调度管理</title>
  <style>
    .window-card { border: 1px solid #ddd; padding: 16px; margin: 8px 0; border-radius: 8px; }
    .window-card.recommended { border-color: #4CAF50; background: #f1f8f1; }
    .risk-low { color: #4CAF50; }
    .risk-medium { color: #FF9800; }
    .risk-high { color: #f44336; }
    .traffic-bar { height: 20px; background: #e0e0e0; border-radius: 4px; overflow: hidden; }
    .traffic-fill { height: 100%; background: linear-gradient(90deg, #4CAF50, #FF9800, #f44336); }
    .queue-item { display: flex; justify-content: space-between; padding: 12px; border-bottom: 1px solid #eee; }
  </style>
</head>
<body>
  <h1>🗓️ 部署窗口调度管理</h1>

  <!-- 推荐窗口 -->
  <section>
    <h2>推荐部署窗口</h2>
    <div id="recommendations"></div>
  </section>

  <!-- 部署队列 -->
  <section>
    <h2>部署队列</h2>
    <div id="queue"></div>
  </section>

  <!-- 时段统计 -->
  <section>
    <h2>部署时段统计</h2>
    <canvas id="statsChart" width="800" height="300"></canvas>
  </section>

  <!-- 窗口配置 -->
  <section>
    <h2>服务窗口配置</h2>
    <form id="windowConfig">
      <label>服务名称：<select id="serviceName"></select></label>
      <label>窗口开始时间：<input type="number" id="windowStart" min="0" max="23" value="2"></label>
      <label>窗口结束时间：<input type="number" id="windowEnd" min="0" max="23" value="6"></label>
      <label>允许天数：
        <input type="checkbox" id="day1" checked> 周一
        <input type="checkbox" id="day2" checked> 周二
        <input type="checkbox" id="day3" checked> 周三
        <input type="checkbox" id="day4" checked> 周四
        <input type="checkbox" id="day5" checked> 周五
        <input type="checkbox" id="day6"> 周六
        <input type="checkbox" id="day0"> 周日
      </label>
      <button type="submit">保存配置</button>
    </form>
  </section>

  <script>
    // 加载推荐窗口
    async function loadRecommendations(service) {
      const res = await fetch(`/api/deployment/window/recommend/${service}`);
      const data = await res.json();
      
      const html = `
        <div class="window-card recommended">
          <h3>✅ 推荐窗口</h3>
          <p><strong>时间：</strong>${new Date(data.data.recommended.start).toLocaleString()}</p>
          <p><strong>风险评分：</strong><span class="${getRiskClass(data.data.recommended.riskScore)}">${data.data.recommended.riskScore.toFixed(2)}</span></p>
          <p><strong>流量水平：</strong>${data.data.recommended.trafficLevel}</p>
          <p><strong>预计影响：</strong>${data.data.recommended.estimatedImpact} 用户</p>
          <p><strong>理由：</strong>${data.data.reasoning}</p>
        </div>
        <h4>备选窗口</h4>
        ${data.data.alternatives.map(alt => `
          <div class="window-card">
            <p>${new Date(alt.start).toLocaleString()} - 风险: <span class="${getRiskClass(alt.riskScore)}">${alt.riskScore.toFixed(2)}</span></p>
          </div>
        `).join('')}
      `;
      
      document.getElementById('recommendations').innerHTML = html;
    }

    function getRiskClass(score) {
      if (score < 0.3) return 'risk-low';
      if (score < 0.6) return 'risk-medium';
      return 'risk-high';
    }

    // 初始化
    loadRecommendations('gateway');
  </script>
</body>
</html>
```

## 5. 验收标准（可测试）

- [ ] 部署调度引擎能基于历史流量数据推荐最佳部署窗口
- [ ] 风险评分算法考虑流量模式、故障历史、周末因素、系统负载
- [ ] 支持紧急程度分级（routine/important/critical），紧急程度影响风险容忍度
- [ ] 部署队列支持排队、取消、推迟操作
- [ ] 与现有 CI/CD 流程集成，支持自动调度和手动触发
- [ ] 管理后台可查看推荐窗口、队列状态、时段统计
- [ ] 系统健康检查异常时自动推迟部署
- [ ] 部署成功率统计可按时段分组展示
- [ ] 跨时区用户分布分析影响部署窗口选择
- [ ] 单元测试覆盖调度算法核心逻辑

## 6. 工作量估算

**L（Large）**

理由：
- 需要设计并实现完整的调度算法
- 需要分析历史数据并建立模型
- 需要与现有 CI/CD 系统深度集成
- 需要构建管理后台界面
- 涉及多个服务模块和数据库表设计

## 7. 优先级理由

**P1 理由**：
1. 当前部署成功率约 92%，影响生产稳定性
2. 减少人工决策负担，提升运维效率
3. 规避高风险时段可显著降低部署失败影响
4. 为后续全自动化部署奠定基础
5. 对"项目可用"有显著贡献（稳定性维度）
