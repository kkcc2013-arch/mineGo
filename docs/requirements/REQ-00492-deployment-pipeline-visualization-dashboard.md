# REQ-00492：部署流水线可视化看板与状态追踪系统

- **编号**：REQ-00492
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：.github/workflows、backend/admin-dashboard、k8s/monitoring
- **创建时间**：2026-07-08 02:00 UTC
- **依赖需求**：REQ-00078（金丝雀发布系统）、REQ-00176（部署流水线状态追踪与回滚管理）

## 1. 背景与问题

mineGo 项目已有完善的 CI/CD 流水线（ci-cd.yml）、金丝雀发布（canary-deploy.yml）、带回滚的部署流程（deploy-with-rollback.yml），但缺乏统一的状态可视化和追踪系统：

**当前痛点：**
1. **部署状态不透明**：无法直观查看当前生产环境运行的服务版本、部署时间、健康状态
2. **历史追溯困难**：排查问题时需要手动查询 GitHub Actions 日志，无统一时间线
3. **缺少实时监控**：部署过程中的进度、错误、警告无实时反馈
4. **多服务协调困难**：9 个微服务的部署顺序、依赖关系、并发状态无全局视图
5. **告警分散**：部署失败的告警分散在邮件、Slack、GitHub，无统一入口

**真实代码现状：**
- `.github/workflows/ci-cd.yml` 有详细的部署步骤，但无状态导出
- `canary-deploy.yml` 支持流量分割和回滚，但缺少状态 API
- admin-dashboard 有基础管理页面，但无部署看板模块
- 缺少部署历史的结构化存储

**影响范围：**
- 排查故障时间：平均增加 30 分钟（需手动查找日志）
- 部署协调：多服务部署时无法实时监控进度
- 运维效率：无法快速了解"当前生产环境是什么状态"

## 2. 目标

建立完整的部署流水线可视化与追踪系统：

- **实时部署看板**：Web UI 展示当前部署状态、进度、版本信息
- **历史时间线**：可视化展示部署历史、变更内容、回滚记录
- **多服务视图**：展示 9 个微服务的部署状态、依赖关系、并发情况
- **实时日志流**：部署过程中的实时日志推送（WebSocket）
- **告警聚合**：部署相关告警统一展示在看板

**可量化目标：**
- 部署状态查询响应时间：< 500ms
- 历史记录保存时长：≥ 90 天
- 实时日志延迟：< 2 秒
- 状态更新覆盖率：100%（所有部署事件）

## 3. 范围

**包含：**
- 部署状态 API 端点
- PostgreSQL 部署历史表
- admin-dashboard 看板页面
- GitHub Actions 状态上报
- WebSocket 实时日志推送
- 告警聚合模块

**不包含：**
- 自动回滚决策（由现有 canary-deploy 处理）
- 部署审批流程（已有 approve 机制）
- 多环境管理（仅支持 staging/production）

## 4. 详细需求

### 4.1 部署状态数据模型

创建数据库迁移：

```sql
-- 部署记录表
CREATE TABLE IF NOT EXISTS deployment_records (
  id SERIAL PRIMARY KEY,
  deployment_id VARCHAR(100) NOT NULL UNIQUE,
  service VARCHAR(50) NOT NULL,
  environment VARCHAR(20) NOT NULL, -- staging/production
  version VARCHAR(100) NOT NULL,
  commit_sha VARCHAR(40),
  branch VARCHAR(100),
  status VARCHAR(30) NOT NULL, -- pending/running/success/failed/rolled_back
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  triggered_by VARCHAR(100),
  trigger_type VARCHAR(30), -- manual/scheduled/auto
  rollback_from VARCHAR(100), -- 如果是回滚，记录原部署 ID
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deployments_service ON deployment_records(service);
CREATE INDEX idx_deployments_status ON deployment_records(status);
CREATE INDEX idx_deployments_env ON deployment_records(environment);
CREATE INDEX idx_deployments_time ON deployment_records(started_at DESC);

-- 部署步骤表
CREATE TABLE IF NOT EXISTS deployment_steps (
  id SERIAL PRIMARY KEY,
  deployment_id VARCHAR(100) NOT NULL,
  step_name VARCHAR(100) NOT NULL,
  step_order INTEGER NOT NULL,
  status VARCHAR(30) NOT NULL, -- pending/running/success/failed/skipped
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  log_text TEXT,
  error_message TEXT,
  FOREIGN KEY (deployment_id) REFERENCES deployment_records(deployment_id)
);

CREATE INDEX idx_steps_deployment ON deployment_steps(deployment_id);
CREATE INDEX idx_steps_status ON deployment_steps(status);

-- 部署告警表
CREATE TABLE IF NOT EXISTS deployment_alerts (
  id SERIAL PRIMARY KEY,
  deployment_id VARCHAR(100) NOT NULL,
  alert_type VARCHAR(50) NOT NULL, -- error/warning/info
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by VARCHAR(100),
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  FOREIGN KEY (deployment_id) REFERENCES deployment_records(deployment_id)
);

CREATE INDEX idx_alerts_deployment ON deployment_alerts(deployment_id);
CREATE INDEX idx_alerts_ack ON deployment_alerts(acknowledged);
```

### 4.2 部署状态服务

创建 `backend/admin/services/deploymentService.js`：

```javascript
/**
 * 部署状态管理服务
 */
class DeploymentService {
  constructor(db, wsGateway) {
    this.db = db;
    this.wsGateway = wsGateway;
  }

  /**
   * 创建新部署记录
   */
  async createDeployment(data) {
    const deploymentId = data.deploymentId || `deploy-${Date.now()}-${data.service}`;
    
    const result = await this.db.query(`
      INSERT INTO deployment_records 
        (deployment_id, service, environment, version, commit_sha, branch, 
         status, started_at, triggered_by, trigger_type, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, 'running', NOW(), $7, $8, $9)
      RETURNING *
    `, [deploymentId, data.service, data.environment, data.version,
        data.commitSha, data.branch, data.triggeredBy, data.triggerType,
        JSON.stringify(data.metadata || {})]);

    // 广播状态更新
    this.wsGateway.broadcast('deployment', {
      type: 'created',
      deployment: result.rows[0]
    });

    return result.rows[0];
  }

  /**
   * 更新部署状态
   */
  async updateStatus(deploymentId, status, metadata = {}) {
    const updateFields = ['status = $2'];
    const params = [deploymentId, status];

    if (status === 'success' || status === 'failed' || status === 'rolled_back') {
      updateFields.push('completed_at = NOW()');
    }

    if (metadata.duration) {
      updateFields.push(`duration_seconds = ${metadata.duration}`);
    }

    const result = await this.db.query(`
      UPDATE deployment_records SET ${updateFields.join(', ')}
      WHERE deployment_id = $1
      RETURNING *
    `, params);

    // 广播状态更新
    this.wsGateway.broadcast('deployment', {
      type: 'status_update',
      deployment: result.rows[0]
    });

    return result.rows[0];
  }

  /**
   * 添加部署步骤
   */
  async addStep(deploymentId, step) {
    const result = await this.db.query(`
      INSERT INTO deployment_steps 
        (deployment_id, step_name, step_order, status, started_at, log_text)
      VALUES ($1, $2, $3, $4, NOW(), $5)
      RETURNING *
    `, [deploymentId, step.name, step.order, 'running', step.log || '']);

    this.wsGateway.broadcast('deployment', {
      type: 'step_started',
      step: result.rows[0]
    });

    return result.rows[0];
  }

  /**
   * 完成部署步骤
   */
  async completeStep(deploymentId, stepOrder, status, data = {}) {
    const result = await this.db.query(`
      UPDATE deployment_steps SET
        status = $3,
        completed_at = NOW(),
        log_text = COALESCE($4, log_text),
        error_message = $5
      WHERE deployment_id = $1 AND step_order = $2
      RETURNING *
    `, [deploymentId, stepOrder, status, data.log, data.error || null]);

    this.wsGateway.broadcast('deployment', {
      type: 'step_completed',
      step: result.rows[0]
    });

    return result.rows[0];
  }

  /**
   * 添加告警
   */
  async addAlert(deploymentId, type, message) {
    const result = await this.db.query(`
      INSERT INTO deployment_alerts (deployment_id, alert_type, message)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [deploymentId, type, message]);

    this.wsGateway.broadcast('deployment', {
      type: 'alert',
      alert: result.rows[0]
    });

    return result.rows[0];
  }

  /**
   * 获取当前活跃部署
   */
  async getActiveDeployments(environment = null) {
    let query = `
      SELECT * FROM deployment_records
      WHERE status IN ('pending', 'running')
    `;
    const params = [];

    if (environment) {
      params.push(environment);
      query += ` AND environment = $${params.length}`;
    }

    query += ' ORDER BY started_at DESC';
    
    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * 获取服务部署历史
   */
  async getServiceHistory(service, limit = 20) {
    const result = await this.db.query(`
      SELECT * FROM deployment_records
      WHERE service = $1
      ORDER BY started_at DESC
      LIMIT $2
    `, [service, limit]);
    return result.rows;
  }

  /**
   * 获取部署详情（含步骤）
   */
  async getDeploymentDetails(deploymentId) {
    const deployment = await this.db.query(`
      SELECT * FROM deployment_records WHERE deployment_id = $1
    `, [deploymentId]);

    const steps = await this.db.query(`
      SELECT * FROM deployment_steps
      WHERE deployment_id = $1
      ORDER BY step_order
    `, [deploymentId]);

    const alerts = await this.db.query(`
      SELECT * FROM deployment_alerts
      WHERE deployment_id = $1
      ORDER BY created_at
    `, [deploymentId]);

    return {
      deployment: deployment.rows[0],
      steps: steps.rows,
      alerts: alerts.rows
    };
  }

  /**
   * 获取所有服务最新状态概览
   */
  async getServicesOverview(environment = 'production') {
    const result = await this.db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (service) deployment_id
        FROM deployment_records
        WHERE environment = $1
        ORDER BY service, started_at DESC
      )
      SELECT 
        dr.*,
        COUNT(ds.id) FILTER (WHERE ds.status = 'success') as success_steps,
        COUNT(ds.id) FILTER (WHERE ds.status = 'failed') as failed_steps,
        COUNT(ds.id) as total_steps
      FROM deployment_records dr
      LEFT JOIN deployment_steps ds ON dr.deployment_id = ds.deployment_id
      WHERE dr.deployment_id IN (SELECT deployment_id FROM latest)
      GROUP BY dr.id
      ORDER BY dr.service
    `, [environment]);

    return result.rows;
  }
}

module.exports = DeploymentService;
```

### 4.3 API 端点

创建 `backend/admin/routes/deployments.js`：

```javascript
const express = require('express');
const router = express.Router();
const DeploymentService = require('../services/deploymentService');

// GET /api/deployments/overview - 获取所有服务状态概览
router.get('/overview', async (req, res) => {
  const { environment = 'production' } = req.query;
  const overview = await req.deploymentService.getServicesOverview(environment);
  res.json({ services: overview });
});

// GET /api/deployments/active - 获取活跃部署
router.get('/active', async (req, res) => {
  const { environment } = req.query;
  const deployments = await req.deploymentService.getActiveDeployments(environment);
  res.json({ deployments });
});

// GET /api/deployments/:service/history - 获取服务历史
router.get('/:service/history', async (req, res) => {
  const { limit = 20 } = req.query;
  const history = await req.deploymentService.getServiceHistory(
    req.params.service, 
    parseInt(limit)
  );
  res.json({ history });
});

// GET /api/deployments/:deploymentId - 获取部署详情
router.get('/:deploymentId', async (req, res) => {
  const details = await req.deploymentService.getDeploymentDetails(
    req.params.deploymentId
  );
  res.json(details);
});

// POST /api/deployments - 创建部署记录（CI 调用）
router.post('/', async (req, res) => {
  const deployment = await req.deploymentService.createDeployment(req.body);
  res.status(201).json(deployment);
});

// PATCH /api/deployments/:deploymentId/status - 更新状态（CI 调用）
router.patch('/:deploymentId/status', async (req, res) => {
  const deployment = await req.deploymentService.updateStatus(
    req.params.deploymentId,
    req.body.status,
    req.body.metadata || {}
  );
  res.json(deployment);
});

// POST /api/deployments/:deploymentId/steps - 添加步骤（CI 调用）
router.post('/:deploymentId/steps', async (req, res) => {
  const step = await req.deploymentService.addStep(
    req.params.deploymentId,
    req.body
  );
  res.status(201).json(step);
});

// PATCH /api/deployments/:deploymentId/steps/:order - 完成步骤（CI 调用）
router.patch('/:deploymentId/steps/:order', async (req, res) => {
  const step = await req.deploymentService.completeStep(
    req.params.deploymentId,
    parseInt(req.params.order),
    req.body.status,
    req.body
  );
  res.json(step);
});

// POST /api/deployments/:deploymentId/alerts - 添加告警
router.post('/:deploymentId/alerts', async (req, res) => {
  const alert = await req.deploymentService.addAlert(
    req.params.deploymentId,
    req.body.type,
    req.body.message
  );
  res.status(201).json(alert);
});

// PATCH /api/deployments/alerts/:alertId/acknowledge - 确认告警
router.patch('/alerts/:alertId/acknowledge', async (req, res) => {
  const result = await req.db.query(`
    UPDATE deployment_alerts SET
      acknowledged = true,
      acknowledged_by = $2,
      acknowledged_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [req.params.alertId, req.user.username]);
  res.json(result.rows[0]);
});

module.exports = router;
```

### 4.4 GitHub Actions 集成

修改 `.github/workflows/ci-cd.yml`，添加状态上报步骤：

```yaml
# 在部署 Job 中添加：
env:
  DEPLOYMENT_ID: deploy-${{ github.run_id }}-${{ matrix.service }}

steps:
  - name: Report deployment start
    run: |
      curl -X POST "${{ secrets.ADMIN_API_URL }}/api/deployments" \
        -H "Authorization: Bearer ${{ secrets.DEPLOY_TOKEN }}" \
        -H "Content-Type: application/json" \
        -d '{
          "deploymentId": "${{ env.DEPLOYMENT_ID }}",
          "service": "${{ matrix.service }}",
          "environment": "${{ inputs.environment }}",
          "version": "${{ steps.version.outputs.version }}",
          "commitSha": "${{ github.sha }}",
          "branch": "${{ github.ref_name }}",
          "triggeredBy": "${{ github.actor }}",
          "triggerType": "manual"
        }'

  - name: Report step: Build
    run: |
      curl -X POST "${{ secrets.ADMIN_API_URL }}/api/deployments/${{ env.DEPLOYMENT_ID }}/steps" \
        -H "Authorization: Bearer ${{ secrets.DEPLOY_TOKEN }}" \
        -d '{"name": "Build", "order": 1}'
      # ... actual build command ...
      curl -X PATCH "${{ secrets.ADMIN_API_URL }}/api/deployments/${{ env.DEPLOYMENT_ID }}/steps/1" \
        -H "Authorization: Bearer ${{ secrets.DEPLOY_TOKEN }}" \
        -d '{"status": "success"}'

  - name: Report deployment status on completion
    if: always()
    run: |
      curl -X PATCH "${{ secrets.ADMIN_API_URL }}/api/deployments/${{ env.DEPLOYMENT_ID }}/status" \
        -H "Authorization: Bearer ${{ secrets.DEPLOY_TOKEN }}" \
        -d "{\"status\": \"${{ job.status == 'success' && 'success' || 'failed' }}\"}"
```

### 4.5 前端看板页面

创建 `admin-dashboard/deployments.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>部署看板 - mineGo Admin</title>
  <link rel="stylesheet" href="/css/dashboard.css">
  <script src="/socket.io/socket.io.js"></script>
</head>
<body>
  <div class="container">
    <header>
      <h1>部署看板</h1>
      <div class="env-selector">
        <button class="env-btn active" data-env="production">生产环境</button>
        <button class="env-btn" data-env="staging">预发环境</button>
      </div>
    </header>

    <!-- 服务状态概览 -->
    <section class="services-overview">
      <h2>服务状态</h2>
      <div id="services-grid" class="services-grid">
        <!-- 动态填充 -->
      </div>
    </section>

    <!-- 活跃部署 -->
    <section class="active-deployments">
      <h2>进行中的部署</h2>
      <div id="active-list">
        <p class="empty">暂无进行中的部署</p>
      </div>
    </section>

    <!-- 部署历史 -->
    <section class="deployment-history">
      <h2>部署历史</h2>
      <div class="filters">
        <select id="service-filter">
          <option value="">所有服务</option>
        </select>
        <select id="status-filter">
          <option value="">所有状态</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
          <option value="rolled_back">已回滚</option>
        </select>
      </div>
      <table id="history-table">
        <thead>
          <tr>
            <th>服务</th>
            <th>版本</th>
            <th>状态</th>
            <th>开始时间</th>
            <th>耗时</th>
            <th>操作人</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="history-body"></tbody>
      </table>
    </section>
  </div>

  <!-- 部署详情模态框 -->
  <div id="detail-modal" class="modal hidden">
    <div class="modal-content">
      <div class="modal-header">
        <h3 id="modal-title">部署详情</h3>
        <button class="close-btn">&times;</button>
      </div>
      <div id="modal-body">
        <!-- 步骤时间线 -->
        <div id="steps-timeline"></div>
        <!-- 实时日志 -->
        <div id="log-viewer"></div>
        <!-- 告警列表 -->
        <div id="alerts-list"></div>
      </div>
    </div>
  </div>

  <script src="/js/deployment-board.js"></script>
</body>
</html>
```

### 4.6 WebSocket 实时推送

创建 `backend/admin/ws/deploymentGateway.js`：

```javascript
class DeploymentGateway {
  constructor(io) {
    this.io = io;
    this.clients = new Map();
    this.setupHandlers();
  }

  setupHandlers() {
    this.io.of('/deployments').on('connection', (socket) => {
      console.log(`[WS] Client connected: ${socket.id}`);

      // 订阅环境更新
      socket.on('subscribe', (environment) => {
        socket.join(`env:${environment}`);
        socket.environment = environment;
      });

      // 订阅特定部署
      socket.on('watch', (deploymentId) => {
        socket.join(`deployment:${deploymentId}`);
      });

      // 请求历史日志
      socket.on('get-logs', async (deploymentId) => {
        const logs = await this.fetchLogs(deploymentId);
        socket.emit('logs', logs);
      });

      socket.on('disconnect', () => {
        this.clients.delete(socket.id);
      });
    });
  }

  broadcast(type, data) {
    if (data.deployment) {
      // 发送到特定部署房间
      this.io.of('/deployments')
        .to(`deployment:${data.deployment.deployment_id}`)
        .emit(type, data);
    }
    
    if (data.deployment?.environment) {
      // 发送到环境房间
      this.io.of('/deployments')
        .to(`env:${data.deployment.environment}`)
        .emit(type, data);
    }
  }

  async fetchLogs(deploymentId) {
    // 从存储或流式日志服务获取
    return [];
  }
}

module.exports = DeploymentGateway;
```

## 5. 验收标准（可测试）

- [ ] API 可创建、查询、更新部署记录
- [ ] 部署状态变更通过 WebSocket 实时推送到前端
- [ ] 看板页面显示所有服务的当前版本和健康状态
- [ ] 点击历史记录可查看详细步骤时间线和日志
- [ ] CI 流水线自动上报部署状态到 API
- [ ] 告警在失败时自动创建并在看板显示
- [ ] 历史记录保存至少 90 天
- [ ] 页面加载时间 < 1 秒（首次加载）

## 6. 工作量估算

L - 需要实现后端服务、数据库迁移、前端页面、CI 集成和 WebSocket，预计需要 3-4 天。

## 7. 优先级理由

作为运维/CICD 类需求，这是系统"可运维"标准的关键组成部分。部署状态不透明会严重影响故障排查效率和团队协作，特别是 9 个微服务的协调部署场景。定为 P1 是因为这是生产环境稳定运行的必要工具。
