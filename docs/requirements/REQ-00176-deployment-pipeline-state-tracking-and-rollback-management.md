# REQ-00176：部署流水线状态跟踪与回滚管理系统

- **编号**：REQ-00176
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、.github/workflows、backend/shared、infrastructure/k8s、backend/jobs
- **创建时间**：2026-06-14 01:00 UTC
- **依赖需求**：REQ-00006（K8s 滚动更新与回滚自动化）

## 1. 背景与问题

当前项目使用 GitHub Actions + SSH/PM2 进行部署，存在以下问题：

1. **缺少部署历史记录**：无法查看历史部署记录、状态和耗时，难以追溯问题
2. **回滚操作手动化**：生产环境回滚需要手动执行 git reset 和 pm2 reload，风险高且耗时长
3. **部署失败诊断困难**：部署失败时缺少自动诊断和告警，需要手动查看日志
4. **缺少部署审批流程**：生产环境部署缺少审批机制，存在误部署风险
5. **环境配置散乱**：开发/测试/预发布/生产环境配置分散，缺少统一管理

当前代码分析：
- `.github/workflows/deploy.yml` 只执行部署，不记录状态
- `.github/workflows/deploy-with-rollback.yml` 有回滚脚本但缺少状态管理
- PM2 生态配置文件没有版本跟踪
- K8s deployment 文件缺少部署注解和回滚策略

## 2. 目标

构建完整的部署流水线状态跟踪与回滚管理系统：

1. **部署状态数据库**：记录每次部署的状态、版本、提交、操作人、耗时
2. **一键回滚机制**：支持通过 Web UI 或 CLI 一键回滚到任意历史版本
3. **部署健康检查**：部署后自动执行健康检查，失败时自动回滚或告警
4. **部署审批流程**：生产环境部署需要审批，支持多级审批配置
5. **部署可视化仪表板**：admin-dashboard 展示部署历史、状态和回滚操作

## 3. 范围

### 包含

- 部署状态数据库表设计和迁移脚本
- GitHub Actions 部署流程改造，集成状态记录
- 回滚 REST API 和 CLI 工具（`scripts/rollback.js`）
- 部署健康检查自动化脚本
- admin-dashboard 部署管理页面（历史、状态、回滚）
- 部署审批 GitHub Actions workflow
- 部署状态告警集成（Slack/钉钉/Webhook）

### 不包含

- GitOps 工具集成（ArgoCD、Flux）
- 多集群部署管理（REQ-00041 已覆盖）
- 部署性能优化（REQ-00078 已覆盖）

## 4. 详细需求

### 4.1 数据库设计

创建 `deployments` 表：

```sql
CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment VARCHAR(50) NOT NULL, -- development/staging/production
  service_name VARCHAR(100), -- null for full deployment
  status VARCHAR(50) NOT NULL, -- pending/running/success/failed/rolled_back
  commit_sha VARCHAR(40) NOT NULL,
  commit_message TEXT,
  deployed_by VARCHAR(255) NOT NULL,
  deployed_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_seconds INT,
  rollback_from UUID REFERENCES deployments(id),
  rollback_reason TEXT,
  approval_status VARCHAR(50), -- pending/approved/rejected
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_deployments_env_status ON deployments(environment, status);
CREATE INDEX idx_deployments_commit ON deployments(commit_sha);
CREATE INDEX idx_deployments_service ON deployments(service_name);
```

### 4.2 GitHub Actions 改造

**`.github/workflows/deploy-tracked.yml`**：

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        default: 'staging'
        type: choice
        options: [staging, production]
      require_approval:
        description: 'Require approval for production'
        required: false
        default: true
        type: boolean

jobs:
  # Job 1: Record deployment start
  record-start:
    runs-on: ubuntu-latest
    outputs:
      deployment_id: ${{ steps.record.outputs.deployment_id }}
    steps:
      - uses: actions/checkout@v4
      - name: Record deployment start
        id: record
        run: |
          DEPLOYMENT_ID=$(node scripts/deployment-tracker.js start \
            --env ${{ inputs.environment }} \
            --commit ${{ github.sha }} \
            --by ${{ github.actor }} \
            --message "${{ github.event.head_commit.message }}")
          echo "deployment_id=$DEPLOYMENT_ID" >> $GITHUB_OUTPUT

  # Job 2: Approval (if required)
  approval:
    needs: record-start
    if: inputs.environment == 'production' && inputs.require_approval
    runs-on: ubuntu-latest
    environment: production-approval
    steps:
      - name: Approved
        run: node scripts/deployment-tracker.js approve ${{ needs.record-start.outputs.deployment_id }} ${{ github.actor }}

  # Job 3: Deploy
  deploy:
    needs: [record-start, approval]
    if: always() && (needs.approval.result == 'success' || needs.approval.result == 'skipped')
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: |
          # 部署逻辑
          node scripts/deploy.js --env ${{ inputs.environment }}
          
      - name: Health check
        run: |
          node scripts/health-check.js --env ${{ inputs.environment }} \
            --timeout 120 --interval 5
          
      - name: Record success
        if: success()
        run: node scripts/deployment-tracker.js complete ${{ needs.record-start.outputs.deployment_id }} --status success
          
      - name: Auto rollback on failure
        if: failure()
        run: |
          node scripts/deployment-tracker.js complete ${{ needs.record-start.outputs.deployment_id }} --status failed
          node scripts/rollback.js --to-last-success --env ${{ inputs.environment }}

  # Job 4: Notify
  notify:
    needs: [record-start, deploy]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Send notification
        run: |
          node scripts/deployment-notify.js \
            --deployment ${{ needs.record-start.outputs.deployment_id }} \
            --status ${{ needs.deploy.result }}
```

### 4.3 回滚 REST API

**`backend/shared/routes/deployment.js`**：

```javascript
/**
 * 部署管理 REST API
 * GET    /api/v1/deployments         - 查询部署历史
 * GET    /api/v1/deployments/:id     - 查询单次部署详情
 * POST   /api/v1/deployments/:id/rollback - 执行回滚
 * POST   /api/v1/deployments/:id/approve   - 审批部署
 */

const express = require('express');
const { Pool } = require('pg');
const { execSync } = require('child_process');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 查询部署历史
router.get('/', async (req, res) => {
  const { environment, service, status, limit = 50 } = req.query;
  
  const result = await pool.query(`
    SELECT d.*, 
           u.username as deployer_name,
           a.username as approver_name
    FROM deployments d
    LEFT JOIN users u ON d.deployed_by = u.id::text
    LEFT JOIN users a ON d.approved_by = a.id::text
    WHERE ($1::text IS NULL OR d.environment = $1)
      AND ($2::text IS NULL OR d.service_name = $2)
      AND ($3::text IS NULL OR d.status = $3)
    ORDER BY d.deployed_at DESC
    LIMIT $4
  `, [environment, service, status, limit]);
  
  res.json({ success: true, data: result.rows });
});

// 执行回滚
router.post('/:id/rollback', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const userId = req.user.id;
  
  // 1. 获取目标部署记录
  const targetResult = await pool.query(
    'SELECT * FROM deployments WHERE id = $1',
    [id]
  );
  
  if (targetResult.rows.length === 0) {
    return res.status(404).json({ error: 'Deployment not found' });
  }
  
  const target = targetResult.rows[0];
  
  if (target.status !== 'success') {
    return res.status(400).json({ error: 'Can only rollback from successful deployment' });
  }
  
  // 2. 创建回滚部署记录
  const rollbackResult = await pool.query(`
    INSERT INTO deployments (
      environment, service_name, status, commit_sha, commit_message,
      deployed_by, rollback_from, rollback_reason
    ) VALUES ($1, $2, 'running', $3, $4, $5, $6, $7)
    RETURNING *
  `, [
    target.environment,
    target.service_name,
    target.commit_sha,
    `Rollback from ${id}`,
    userId,
    id,
    reason
  ]);
  
  const rollback = rollbackResult.rows[0];
  
  // 3. 执行回滚（异步）
  executeRollback(target, rollback.id)
    .then(() => {
      pool.query(
        'UPDATE deployments SET status = $1, completed_at = NOW() WHERE id = $2',
        ['success', rollback.id]
      );
    })
    .catch(err => {
      pool.query(
        'UPDATE deployments SET status = $1, error_message = $2, completed_at = NOW() WHERE id = $3',
        ['failed', err.message, rollback.id]
      );
    });
  
  res.json({ success: true, data: rollback });
});

async function executeRollback(target, rollbackId) {
  // 执行 git reset + pm2 reload / kubectl rollout undo
  if (process.env.DEPLOY_METHOD === 'pm2') {
    execSync(`git reset --hard ${target.commit_sha}`);
    execSync(`pm2 reload ecosystem.config.js --update-env`);
  } else {
    execSync(`kubectl rollout undo deployment/${target.service_name || 'all'} -n minego`);
  }
}

module.exports = router;
```

### 4.4 回滚 CLI 工具

**`scripts/rollback.js`**：

```javascript
#!/usr/bin/env node
/**
 * 部署回滚 CLI 工具
 * 
 * 用法：
 *   node scripts/rollback.js --to <commit-sha>
 *   node scripts/rollback.js --to-last-success
 *   node scripts/rollback.js --deployment <deployment-id>
 *   node scripts/rollback.js --list
 */

const { Pool } = require('pg');
const { execSync } = require('child_process');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const args = require('minimist')(process.argv.slice(2));
  
  if (args.list) {
    // 列出可回滚的部署
    const result = await pool.query(`
      SELECT id, environment, commit_sha, deployed_at, status
      FROM deployments
      WHERE status = 'success'
      ORDER BY deployed_at DESC
      LIMIT 10
    `);
    
    console.log('\n可回滚的部署：\n');
    result.rows.forEach(row => {
      console.log(`${row.id} | ${row.environment} | ${row.commit_sha.slice(0, 7)} | ${row.deployed_at.toISOString()}`);
    });
    process.exit(0);
  }
  
  let targetCommit;
  
  if (args['to-last-success']) {
    const result = await pool.query(`
      SELECT commit_sha FROM deployments
      WHERE environment = $1 AND status = 'success'
      ORDER BY deployed_at DESC
      LIMIT 2 OFFSET 1
    `, [args.env || 'production']);
    
    if (result.rows.length === 0) {
      console.error('No previous successful deployment found');
      process.exit(1);
    }
    
    targetCommit = result.rows[0].commit_sha;
  } else if (args.to) {
    targetCommit = args.to;
  } else if (args.deployment) {
    const result = await pool.query(
      'SELECT commit_sha FROM deployments WHERE id = $1',
      [args.deployment]
    );
    targetCommit = result.rows[0]?.commit_sha;
  }
  
  if (!targetCommit) {
    console.error('Please specify --to, --to-last-success, or --deployment');
    process.exit(1);
  }
  
  console.log(`Rolling back to commit: ${targetCommit}`);
  
  // 执行回滚
  try {
    console.log('\n[1/3] Fetching code...');
    execSync('git fetch --all', { stdio: 'inherit' });
    
    console.log('\n[2/3] Resetting to target commit...');
    execSync(`git reset --hard ${targetCommit}`, { stdio: 'inherit' });
    
    console.log('\n[3/3] Reloading services...');
    if (process.env.DEPLOY_METHOD === 'pm2') {
      execSync('pm2 reload ecosystem.config.js --update-env', { stdio: 'inherit' });
    } else {
      execSync('kubectl rollout restart deployment -n minego', { stdio: 'inherit' });
    }
    
    console.log('\n✅ Rollback complete!');
  } catch (err) {
    console.error('\n❌ Rollback failed:', err.message);
    process.exit(1);
  }
  
  await pool.end();
}

main();
```

### 4.5 部署健康检查

**`scripts/health-check.js`**：

```javascript
/**
 * 部署后健康检查
 * 
 * 检查项：
 * 1. Gateway 健康端点
 * 2. 所有微服务健康端点
 * 3. 数据库连接
 * 4. Redis 连接
 * 5. 关键业务接口（登录、捕捉、支付）
 */

const SERVICES = {
  'gateway': 'http://localhost:8080/health',
  'user-service': 'http://localhost:8081/health',
  'location-service': 'http://localhost:8082/health',
  'pokemon-service': 'http://localhost:8083/health',
  'catch-service': 'http://localhost:8084/health',
  'gym-service': 'http://localhost:8085/health',
  'social-service': 'http://localhost:8086/health',
  'reward-service': 'http://localhost:8087/health',
  'payment-service': 'http://localhost:8088/health'
};

async function healthCheck(options = {}) {
  const timeout = options.timeout || 120;
  const interval = options.interval || 5;
  const startTime = Date.now();
  
  const results = {};
  
  while (Date.now() - startTime < timeout * 1000) {
    let allHealthy = true;
    
    for (const [name, url] of Object.entries(SERVICES)) {
      try {
        const res = await fetch(url, { timeout: 5000 });
        const data = await res.json();
        results[name] = { status: 'healthy', data };
      } catch (err) {
        results[name] = { status: 'unhealthy', error: err.message };
        allHealthy = false;
      }
    }
    
    if (allHealthy) {
      console.log('\n✅ All services healthy!\n');
      console.log(JSON.stringify(results, null, 2));
      return true;
    }
    
    console.log(`Waiting... (${Math.round((Date.now() - startTime) / 1000)}s)`);
    await new Promise(r => setTimeout(r, interval * 1000));
  }
  
  console.log('\n❌ Health check timeout\n');
  console.log(JSON.stringify(results, null, 2));
  return false;
}

module.exports = { healthCheck };
```

### 4.6 Admin Dashboard 部署管理页面

**`frontend/admin-dashboard/deployments.html`**：

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>部署管理 - mineGo Admin</title>
  <link href="styles.css" rel="stylesheet">
</head>
<body>
  <div class="container">
    <h1>🚀 部署管理</h1>
    
    <!-- 环境选择 -->
    <div class="tabs">
      <button class="tab active" data-env="all">全部</button>
      <button class="tab" data-env="development">开发环境</button>
      <button class="tab" data-env="staging">预发布环境</button>
      <button class="tab" data-env="production">生产环境</button>
    </div>
    
    <!-- 部署历史 -->
    <table id="deployments-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>环境</th>
          <th>服务</th>
          <th>Commit</th>
          <th>状态</th>
          <th>部署人</th>
          <th>时间</th>
          <th>耗时</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="deployments-body"></tbody>
    </table>
    
    <!-- 回滚确认对话框 -->
    <div id="rollback-modal" class="modal hidden">
      <div class="modal-content">
        <h2>确认回滚</h2>
        <p>将回滚到部署：<span id="rollback-target"></span></p>
        <textarea id="rollback-reason" placeholder="回滚原因（必填）"></textarea>
        <div class="actions">
          <button id="cancel-rollback">取消</button>
          <button id="confirm-rollback" class="danger">确认回滚</button>
        </div>
      </div>
    </div>
  </div>
  
  <script src="deployments.js"></script>
</body>
</html>
```

### 4.7 部署告警

**`backend/shared/deploymentAlert.js`**：

```javascript
/**
 * 部署状态告警
 * 
 * 支持渠道：
 * - Slack Webhook
 * - 钉钉 Webhook
 * - 自定义 Webhook
 */

const ALERT_TEMPLATES = {
  'deployment.started': {
    color: '#36a64f',
    title: '🚀 部署开始',
    fields: ['environment', 'commit_sha', 'deployed_by']
  },
  'deployment.success': {
    color: '#36a64f',
    title: '✅ 部署成功',
    fields: ['environment', 'commit_sha', 'duration_seconds', 'deployed_by']
  },
  'deployment.failed': {
    color: '#dc3545',
    title: '❌ 部署失败',
    fields: ['environment', 'commit_sha', 'error_message', 'deployed_by']
  },
  'deployment.rollback': {
    color: '#ffc107',
    title: '⏪ 执行回滚',
    fields: ['environment', 'rollback_from', 'rollback_reason']
  }
};

class DeploymentAlerter {
  constructor(config = {}) {
    this.slackWebhook = config.slackWebhook || process.env.SLACK_WEBHOOK_URL;
    this.dingtalkWebhook = config.dingtalkWebhook || process.env.DINGTALK_WEBHOOK_URL;
    this.customWebhook = config.customWebhook || process.env.DEPLOYMENT_WEBHOOK_URL;
  }
  
  async notify(eventType, deployment) {
    const template = ALERT_TEMPLATES[eventType];
    if (!template) return;
    
    const message = {
      title: template.title,
      color: template.color,
      fields: template.fields.map(field => ({
        title: field,
        value: String(deployment[field] || 'N/A'),
        short: true
      })),
      timestamp: new Date().toISOString()
    };
    
    // 发送到所有配置的渠道
    await Promise.all([
      this.slackWebhook && this.sendToSlack(message),
      this.dingtalkWebhook && this.sendToDingtalk(message),
      this.customWebhook && this.sendToCustom(message)
    ]);
  }
  
  async sendToSlack(message) {
    await fetch(this.slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments: [message] })
    });
  }
  
  async sendToDingtalk(message) {
    await fetch(this.dingtalkWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          title: message.title,
          text: `### ${message.title}\n\n${message.fields.map(f => `- **${f.title}**: ${f.value}`).join('\n')}`
        }
      })
    });
  }
  
  async sendToCustom(message) {
    await fetch(this.customWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });
  }
}

module.exports = { DeploymentAlerter };
```

## 5. 验收标准（可测试）

- [ ] 部署记录保存到数据库，包含完整元数据（commit、操作人、环境、服务）
- [ ] 支持通过 API 查询部署历史，按环境/服务/状态过滤
- [ ] 支持一键回滚到指定部署版本，自动执行 git reset 和服务重载
- [ ] 回滚操作生成新的部署记录，关联原部署和回滚原因
- [ ] 部署失败时自动执行回滚（可配置），并发送告警通知
- [ ] 生产环境部署需要审批，审批状态记录在数据库
- [ ] admin-dashboard 可查看部署历史、执行回滚操作
- [ ] 部署健康检查覆盖所有微服务和关键依赖（数据库、Redis）
- [ ] 告警通知支持 Slack、钉钉和自定义 Webhook
- [ ] CLI 工具 `scripts/rollback.js` 支持列出可回滚版本、回滚到指定版本

## 6. 工作量估算

**L（大型）**

理由：
- 需要设计数据库表和迁移脚本
- 需要改造多个 GitHub Actions workflow
- 需要实现完整的 REST API 和 CLI 工具
- 需要开发 admin-dashboard 前端页面
- 需要集成告警系统
- 涉及多个组件协同工作

预估工作量：3-5 人天

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **生产稳定性保障**：部署回滚是生产环境的关键能力，缺少将导致故障恢复时间过长
2. **运维效率提升**：自动化回滚可减少 80% 的手动操作时间
3. **故障追溯能力**：部署历史记录是排查生产问题的重要依据
4. **审批流程合规**：生产环境审批是企业级应用的必备功能
5. **与其他需求互补**：与 REQ-00006（滚动更新）、REQ-00024（蓝绿部署）互补，形成完整的部署体系

对"项目可用"的贡献：提升运维效率和稳定性，降低生产环境风险。
