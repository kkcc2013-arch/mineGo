# REQ-00486: CI/CD流水线实时可视化与智能诊断系统

- **编号**：REQ-00486
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务**：admin-dashboard/ci-cd-monitor/github-actions-webhook
- **创建时间**：2026-07-07 14:00 UTC
- **依赖需求**：REQ-00078（金丝雀发布系统）、REQ-00176（部署管道追踪）

## 1. 背景与问题

mineGo 项目已有12个 GitHub Actions 工作流（ci-cd.yml、deploy.yml、canary-deploy.yml、blue-green-deploy.yml等），但运维团队缺乏统一的实时监控和诊断能力：

**当前痛点：**
1. **构建状态分散**：需逐个查看 GitHub Actions 页面，无法一目了然掌握所有流水线状态
2. **构建失败诊断困难**：失败原因需人工分析日志，耗时且容易遗漏关键信息
3. **缺乏实时告警**：关键流水线失败无法第一时间通知，影响响应速度
4. **无法追踪部署进度**：金丝雀发布、蓝绿部署等多阶段部署进度难以实时监控
5. **构建性能趋势缺失**：无法分析构建耗时趋势，难以发现性能退化

**真实代码现状：**
- `.github/workflows/` 有12个工作流，但无统一的监控聚合
- admin-dashboard 仅展示应用状态，不包含 CI/CD 监控
- GitHub Actions Webhook 未接入内部告警系统
- 缺乏构建历史数据分析和趋势展示

**影响范围：**
- 运维人员需频繁刷新 GitHub 页面查看状态
- 构建失败平均诊断时间 > 30分钟
- 关键部署失败响应时间 > 15分钟
- 无法预防性发现构建性能问题

## 2. 目标

构建统一的 CI/CD 流水线实时监控和智能诊断平台：

- **实时可视化仪表盘**：聚合展示所有流水线状态、进度、健康指标
- **智能失败诊断**：自动分析失败日志，识别根因并提供建议
- **多渠道实时告警**：支持 Slack、Email、Webhook 等多渠道通知
- **部署进度追踪**：实时展示金丝雀/蓝绿等多阶段部署进度
- **构建性能分析**：历史数据趋势分析，发现性能退化

**可量化目标：**
- 构建状态聚合覆盖率：100%（12个工作流）
- 失败诊断准确率：> 85%
- 关键失败告警延迟：< 30秒
- 部署进度实时更新：< 5秒延迟
- 构建性能趋势分析覆盖：30天历史

## 3. 范围

**包含：**
- GitHub Actions Webhook 接收与状态同步
- CI/CD 实时可视化仪表盘（Web UI）
- 智能失败日志分析与根因诊断
- 多渠道实时告警集成（Slack/Email/Webhook）
- 多阶段部署进度追踪（金丝雀/蓝绿）
- 构建历史数据存储与趋势分析
- 构建性能退化检测与预警
- API 接口供外部系统集成

**不包含：**
- CI/CD 流水线配置编辑（仅监控）
- 自动修复构建问题（仅诊断建议）
- 第三方 CI 系统集成（仅 GitHub Actions）
- 构建产物存储管理

## 4. 详细需求

### 4.1 GitHub Actions Webhook 接收器

创建 `backend/services/admin/src/webhooks/githubActionsWebhook.js`：

```javascript
/**
 * GitHub Actions Webhook 接收器
 * 接收 workflow_run 事件并同步状态
 */
class GitHubActionsWebhookHandler {
  constructor(db, redis, eventBus, alertService) {
    this.db = db;
    this.redis = redis;
    this.eventBus = eventBus;
    this.alertService = alertService;
    
    // 关注的工作流列表
    this.monitoredWorkflows = [
      'ci-cd.yml',
      'deploy.yml',
      'canary-deploy.yml',
      'blue-green-deploy.yml',
      'deploy-with-rollback.yml',
      'security-scan.yml',
      'performance-tests.yml',
      'integration-test.yml',
      'e2e-tests.yml',
      'contract-tests.yml',
      'dependency-check.yml',
      'backup.yml'
    ];
    
    // 关键工作流（失败需立即告警）
    this.criticalWorkflows = [
      'deploy.yml',
      'canary-deploy.yml',
      'blue-green-deploy.yml',
      'security-scan.yml'
    ];
  }

  /**
   * 处理 workflow_run 事件
   */
  async handleWorkflowRun(payload) {
    const { action, workflow_run } = payload;
    
    // 过滤非关注工作流
    if (!this.monitoredWorkflows.includes(workflow_run.name)) {
      return { skipped: true, reason: 'not_monitored' };
    }
    
    const runId = workflow_run.id;
    const status = workflow_run.status;
    const conclusion = workflow_run.conclusion;
    
    // 存储运行记录
    await this._storeRunRecord(workflow_run);
    
    // 更新实时状态缓存
    await this._updateRealtimeStatus(workflow_run);
    
    // 发布状态变更事件
    await this.eventBus.publish('cicd.run.updated', {
      runId,
      workflow: workflow_run.name,
      status,
      conclusion,
      action
    });
    
    // 关键状态告警
    if (this._shouldAlert(workflow_run)) {
      await this._triggerAlert(workflow_run);
    }
    
    // 失败时启动诊断
    if (conclusion === 'failure') {
      await this._triggerDiagnosis(workflow_run);
    }
    
    return {
      processed: true,
      runId,
      status,
      conclusion
    };
  }

  /**
   * 存储运行记录
   */
  async _storeRunRecord(run) {
    await this.db.query(`
      INSERT INTO cicd_run_history
        (run_id, workflow_name, status, conclusion, 
         trigger_event, branch, commit_sha, actor,
         started_at, completed_at, duration_seconds,
         run_url, raw_payload, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      ON CONFLICT (run_id) DO UPDATE SET
        status = EXCLUDED.status,
        conclusion = EXCLUDED.conclusion,
        completed_at = EXCLUDED.completed_at,
        duration_seconds = EXCLUDED.duration_seconds,
        raw_payload = EXCLUDED.raw_payload
    `, [
      run.id,
      run.name,
      run.status,
      run.conclusion,
      run.event,
      run.head_branch,
      run.head_sha,
      run.actor.login,
      run.run_started_at,
      run.updated_at,
      this._calculateDuration(run),
      run.html_url,
      JSON.stringify(run)
    ]);
  }

  /**
   * 更新实时状态
   */
  async _updateRealtimeStatus(run) {
    const key = `cicd:status:${run.name}`;
    
    await this.redis.hset(key, {
      run_id: run.id,
      status: run.status,
      conclusion: run.conclusion || '',
      branch: run.head_branch,
      commit: run.head_sha.slice(0, 7),
      actor: run.actor.login,
      started_at: run.run_started_at,
      updated_at: run.updated_at,
      duration: this._calculateDuration(run) || 0
    });
    
    // 设置过期时间（24小时）
    await this.redis.expire(key, 24 * 3600);
    
    // 更新全局仪表盘状态
    await this._updateDashboardSummary();
  }

  /**
   * 更新仪表盘摘要
   */
  async _updateDashboardSummary() {
    const summary = {
      total_workflows: this.monitoredWorkflows.length,
      running: 0,
      success: 0,
      failure: 0,
      pending: 0,
      last_updated: new Date().toISOString()
    };
    
    for (const workflow of this.monitoredWorkflows) {
      const key = `cicd:status:${workflow}`;
      const status = await this.redis.hgetall(key);
      
      if (status.status === 'in_progress') {
        summary.running++;
      } else if (status.conclusion === 'success') {
        summary.success++;
      } else if (status.conclusion === 'failure') {
        summary.failure++;
      } else {
        summary.pending++;
      }
    }
    
    await this.redis.set('cicd:dashboard:summary', JSON.stringify(summary), 3600);
  }

  /**
   * 判断是否需要告警
   */
  _shouldAlert(run) {
    // 关键工作流失败
    if (this.criticalWorkflows.includes(run.name) && run.conclusion === 'failure') {
      return true;
    }
    
    // 关键工作流完成
    if (this.criticalWorkflows.includes(run.name) && run.status === 'completed') {
      return true;
    }
    
    return false;
  }

  /**
   * 触发告警
   */
  async _triggerAlert(run) {
    const alertType = run.conclusion === 'failure' ? 'critical' : 'info';
    const message = this._buildAlertMessage(run);
    
    await this.alertService.send({
      type: alertType,
      source: 'cicd',
      workflow: run.name,
      runId: run.id,
      message,
      channels: ['slack', 'email'],
      recipients: ['ops-team', 'dev-team']
    });
  }

  _buildAlertMessage(run) {
    if (run.conclusion === 'failure') {
      return `🚨 CI/CD 失败: ${run.name} on ${run.head_branch} by ${run.actor.login}\n` +
             `Commit: ${run.head_sha.slice(0, 7)}\n` +
             `URL: ${run.html_url}`;
    }
    
    return `✅ CI/CD 完成: ${run.name} on ${run.head_branch}\n` +
           `Duration: ${this._formatDuration(this._calculateDuration(run))}`;
  }

  /**
   * 触发诊断
   */
  async _triggerDiagnosis(run) {
    await this.eventBus.publish('cicd.diagnosis.requested', {
      runId: run.id,
      workflow: run.name,
      commit: run.head_sha,
      branch: run.head_branch
    });
  }

  _calculateDuration(run) {
    if (!run.run_started_at || !run.updated_at) return null;
    
    const start = new Date(run.run_started_at);
    const end = new Date(run.updated_at);
    
    return Math.floor((end - start) / 1000);
  }

  _formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    
    return `${minutes}m ${secs}s`;
  }
}

module.exports = GitHubActionsWebhookHandler;
```

### 4.2 智能失败诊断引擎

创建 `backend/services/admin/src/diagnostics/buildFailureDiagnostic.js`：

```javascript
/**
 * 构建失败智能诊断引擎
 * 自动分析失败日志，识别根因并提供修复建议
 */
class BuildFailureDiagnostic {
  constructor(db, githubClient) {
    this.db = db;
    this.githubClient = githubClient;
    
    // 常见错误模式库
    this.errorPatterns = {
      // 编译错误
      syntax_error: {
        pattern: /SyntaxError|Unexpected token|Parse error/i,
        category: 'compile',
        severity: 'high',
        suggestion: '检查代码语法，运行本地 lint 验证'
      },
      
      // 依赖错误
      dependency_missing: {
        pattern: /Cannot find module|MODULE_NOT_FOUND|package not found/i,
        category: 'dependency',
        severity: 'high',
        suggestion: '检查 package.json，确保依赖已正确安装'
      },
      
      // 测试失败
      test_failure: {
        pattern: /FAIL|Test failed|AssertionError/i,
        category: 'test',
        severity: 'medium',
        suggestion: '检查测试断言，修复相关代码逻辑'
      },
      
      // 超时错误
      timeout_error: {
        pattern: /Timeout|ETIMEDOUT|timeout exceeded/i,
        category: 'timeout',
        severity: 'medium',
        suggestion: '检查网络连接或增加超时时间配置'
      },
      
      // 内存溢出
      memory_error: {
        pattern: /Out of memory|heap out of memory|OOM/i,
        category: 'resource',
        severity: 'high',
        suggestion: '优化内存使用或增加 runner 内存限制'
      },
      
      // 权限错误
      permission_error: {
        pattern: /Permission denied|EACCES|Access denied/i,
        category: 'permission',
        severity: 'medium',
        suggestion: '检查文件权限或 GitHub token 配置'
      },
      
      // 网络错误
      network_error: {
        pattern: /ENETUNREACH|ECONNREFUSED|Network error/i,
        category: 'network',
        severity: 'medium',
        suggestion: '检查网络配置或使用代理'
      },
      
      // 安全扫描失败
      security_vulnerability: {
        pattern: /vulnerability found|CVE|security issue/i,
        category: 'security',
        severity: 'critical',
        suggestion: '检查依赖版本，更新有漏洞的包'
      },
      
      // 部署失败
      deployment_failed: {
        pattern: /deployment failed|rollback triggered|service unavailable/i,
        category: 'deployment',
        severity: 'critical',
        suggestion: '检查目标环境状态，查看部署日志详情'
      },
      
      // 数据库错误
      database_error: {
        pattern: /database connection failed|query error|PostgreSQL error/i,
        category: 'database',
        severity: 'high',
        suggestion: '检查数据库连接配置或数据迁移脚本'
      }
    };
    
    // 历史失败关联分析
    this.historyWindow = 30; // 分析30天内失败记录
  }

  /**
   * 诊断构建失败
   */
  async diagnose(runId) {
    // 1. 获取失败日志
    const logs = await this._fetchRunLogs(runId);
    
    // 2. 掷取运行详情
    const run = await this._getRunRecord(runId);
    
    // 3. 分析错误模式
    const detectedErrors = await this._detectErrorPatterns(logs);
    
    // 4. 关联历史分析
    const historicalContext = await this._analyzeHistoricalContext(run);
    
    // 5. 生成诊断报告
    const diagnosis = this._generateDiagnosis(detectedErrors, historicalContext, run);
    
    // 6. 存储诊断结果
    await this._storeDiagnosis(runId, diagnosis);
    
    return diagnosis;
  }

  /**
   * 获取运行日志
   */
  async _fetchRunLogs(runId) {
    try {
      // 通过 GitHub API 获取日志
      const logs = await this.githubClient.getWorkflowRunLogs(runId);
      
      // 解析日志内容
      return this._parseLogs(logs);
    } catch (error) {
      // 备用方案：从数据库获取已存储的日志片段
      const result = await this.db.query(`
        SELECT log_content FROM cicd_run_logs WHERE run_id = $1
      `, [runId]);
      
      return result.rows.map(r => r.log_content).join('\n');
    }
  }

  /**
   * 解析日志
   */
  _parseLogs(logContent) {
    // 提取关键失败信息
    const lines = logContent.split('\n');
    const errorLines = [];
    
    for (const line of lines) {
      // 标记错误行
      if (/error|fail|exception|Error|FAIL/i.test(line)) {
        errorLines.push(line);
      }
    }
    
    return errorLines.join('\n');
  }

  /**
   * 检测错误模式
   */
  async _detectErrorPatterns(logs) {
    const detected = [];
    
    for (const [name, config] of Object.entries(this.errorPatterns)) {
      const matches = logs.match(config.pattern);
      
      if (matches) {
        detected.push({
          name,
          category: config.category,
          severity: config.severity,
          pattern: config.pattern.toString(),
          matchedText: matches[0],
          suggestion: config.suggestion,
          confidence: this._calculateConfidence(matches, logs)
        });
      }
    }
    
    // 按严重程度排序
    detected.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
    
    return detected;
  }

  /**
   * 计算置信度
   */
  _calculateConfidence(matches, logs) {
    // 基于匹配次数和位置计算置信度
    const matchCount = matches.length || 1;
    const logLength = logs.length;
    
    // 简化计算：匹配次数越多置信度越高
    return Math.min(0.5 + matchCount * 0.1, 0.95);
  }

  /**
   * 分析历史上下文
   */
  async _analyzeHistoricalContext(run) {
    // 获取最近同工作流失败记录
    const result = await this.db.query(`
      SELECT 
        run_id, 
        conclusion, 
        commit_sha, 
        started_at,
        diagnosis_result
      FROM cicd_run_history
      WHERE workflow_name = $1
        AND conclusion = 'failure'
        AND started_at > NOW() - INTERVAL '${this.historyWindow} days'
      ORDER BY started_at DESC
      LIMIT 10
    `, [run.workflow_name]);
    
    const historicalFailures = result.rows;
    
    // 分析失败频率趋势
    const failureRate = await this._calculateFailureRate(run.workflow_name);
    
    // 分析常见失败原因
    const commonCauses = this._identifyCommonCauses(historicalFailures);
    
    return {
      recentFailureCount: historicalFailures.length,
      failureRate,
      commonCauses,
      similarFailures: this._findSimilarFailures(run, historicalFailures)
    };
  }

  /**
   * 计算失败率
   */
  async _calculateFailureRate(workflowName) {
    const result = await this.db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE conclusion = 'failure') as failures,
        COUNT(*) FILTER (WHERE conclusion = 'success') as successes,
        COUNT(*) as total
      FROM cicd_run_history
      WHERE workflow_name = $1
        AND started_at > NOW() - INTERVAL '7 days'
    `, [workflowName]);
    
    const stats = result.rows[0];
    
    return {
      weeklyFailureRate: stats.total > 0 
        ? (parseInt(stats.failures) / parseInt(stats.total) * 100).toFixed(2)
        : 0,
      weeklySuccessRate: stats.total > 0
        ? (parseInt(stats.successes) / parseInt(stats.total) * 100).toFixed(2)
        : 0
    };
  }

  /**
   * 识别常见原因
   */
  _identifyCommonCauses(failures) {
    const causes = {};
    
    for (const failure of failures) {
      if (failure.diagnosis_result) {
        const diagnosis = JSON.parse(failure.diagnosis_result);
        
        for (const error of diagnosis.detectedErrors || []) {
          causes[error.name] = (causes[error.name] || 0) + 1;
        }
      }
    }
    
    // 排序返回前5个
    return Object.entries(causes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
  }

  /**
   * 查找相似失败
   */
  _findSimilarFailures(currentRun, historicalFailures) {
    return historicalFailures.filter(f => 
      f.commit_sha !== currentRun.commit_sha // 排除当前失败
    ).slice(0, 3).map(f => ({
      runId: f.run_id,
      commit: f.commit_sha,
      date: f.started_at
    }));
  }

  /**
   * 生成诊断报告
   */
  _generateDiagnosis(detectedErrors, historicalContext, run) {
    // 确定最可能的根因
    const rootCause = detectedErrors[0] || {
      name: 'unknown',
      category: 'unknown',
      severity: 'medium',
      suggestion: '请查看完整日志进行人工分析'
    };
    
    // 生成修复步骤
    const fixSteps = this._generateFixSteps(detectedErrors);
    
    return {
      runId: run.run_id,
      workflow: run.workflow_name,
      branch: run.branch,
      commit: run.commit_sha,
      
      diagnosisTime: new Date().toISOString(),
      
      // 根因分析
      rootCause,
      detectedErrors,
      
      // 历史上下文
      historicalContext,
      
      // 修复建议
      fixSteps,
      
      // 风险评估
      riskLevel: this._assessRisk(detectedErrors, historicalContext),
      
      // 自动化程度评估
      automationLevel: this._assessAutomationLevel(rootCause.category),
      
      // 相关资源
      resources: this._getRelatedResources(rootCause.category)
    };
  }

  /**
   * 生成修复步骤
   */
  _generateFixSteps(errors) {
    const steps = [];
    
    for (const error of errors) {
      steps.push({
        order: steps.length + 1,
        errorType: error.name,
        action: error.suggestion,
        priority: error.severity === 'critical' ? 'immediate' : 
                  error.severity === 'high' ? 'high' : 'normal',
        estimatedTime: this._estimateFixTime(error.category)
      });
    }
    
    return steps;
  }

  /**
   * 估算修复时间
   */
  _estimateFixTime(category) {
    const estimates = {
      compile: '5-15分钟',
      dependency: '10-30分钟',
      test: '15-60分钟',
      timeout: '5-20分钟',
      resource: '30-60分钟',
      permission: '5-10分钟',
      network: '10-30分钟',
      security: '30-120分钟',
      deployment: '30-90分钟',
      database: '15-60分钟',
      unknown: '需人工评估'
    };
    
    return estimates[category] || estimates.unknown;
  }

  /**
   * 评估风险级别
   */
  _assessRisk(errors, history) {
    // 有critical级别错误
    if (errors.some(e => e.severity === 'critical')) {
      return 'high';
    }
    
    // 最近频繁失败
    if (history.recentFailureCount >= 3) {
      return 'medium';
    }
    
    return 'low';
  }

  /**
   * 评估自动化程度
   */
  _assessAutomationLevel(category) {
    // 可自动修复的类别
    const automatable = ['dependency', 'permission'];
    
    if (automatable.includes(category)) {
      return 'high';
    }
    
    // 需人工干预的类别
    const manual = ['compile', 'test', 'security', 'deployment'];
    
    if (manual.includes(category)) {
      return 'low';
    }
    
    return 'medium';
  }

  /**
   * 获取相关资源
   */
  _getRelatedResources(category) {
    const resources = {
      compile: [
        { type: 'doc', url: '/docs/troubleshooting#compile-errors', title: '编译错误排查指南' }
      ],
      dependency: [
        { type: 'doc', url: '/docs/troubleshooting#dependency-errors', title: '依赖错误排查指南' }
      ],
      security: [
        { type: 'doc', url: '/docs/security#vulnerabilities', title: '安全漏洞处理指南' }
      ],
      deployment: [
        { type: 'tool', url: '/admin/deployment-tracker', title: '部署追踪工具' }
      ]
    };
    
    return resources[category] || [];
  }

  /**
   * 存储诊断结果
   */
  async _storeDiagnosis(runId, diagnosis) {
    await this.db.query(`
      UPDATE cicd_run_history
      SET diagnosis_result = $2,
          diagnosis_time = NOW()
      WHERE run_id = $1
    `, [runId, JSON.stringify(diagnosis)]);
  }

  /**
   * 获取运行记录
   */
  async _getRunRecord(runId) {
    const result = await this.db.query(`
      SELECT * FROM cicd_run_history WHERE run_id = $1
    `, [runId]);
    
    return result.rows[0];
  }
}

module.exports = BuildFailureDiagnostic;
```

### 4.3 实时可视化仪表盘 API

创建 `backend/services/admin/src/routes/cicdDashboardRoutes.js`：

```javascript
/**
 * CI/CD 仪表盘 API 路由
 */
const express = require('express');
const router = express.Router();
const authMiddleware = require('../../../shared/authMiddleware');
const cicdService = require('../services/cicdService');

/**
 * 获取仪表盘摘要
 */
router.get('/summary', async (req, res) => {
  try {
    const summary = await cicdService.getDashboardSummary();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取所有工作流状态
 */
router.get('/workflows', async (req, res) => {
  try {
    const workflows = await cicdService.getAllWorkflowStatuses();
    res.json(workflows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取特定工作流历史
 */
router.get('/workflows/:name/history', async (req, res) => {
  try {
    const { name } = req.params;
    const { limit = 20, offset = 0 } = req.query;
    
    const history = await cicdService.getWorkflowHistory(name, limit, offset);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取运行详情
 */
router.get('/runs/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const run = await cicdService.getRunDetails(runId);
    
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    
    res.json(run);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取诊断报告
 */
router.get('/runs/:runId/diagnosis', async (req, res) => {
  try {
    const { runId } = req.params;
    const diagnosis = await cicdService.getDiagnosis(runId);
    
    if (!diagnosis) {
      return res.status(404).json({ error: 'Diagnosis not found' });
    }
    
    res.json(diagnosis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 手动触发诊断（管理员）
 */
router.post('/runs/:runId/diagnose', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { runId } = req.params;
    const diagnosis = await cicdService.triggerDiagnosis(runId);
    res.json(diagnosis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取性能趋势
 */
router.get('/performance/:workflowName', async (req, res) => {
  try {
    const { workflowName } = req.params;
    const { days = 30 } = req.query;
    
    const trend = await cicdService.getPerformanceTrend(workflowName, days);
    res.json(trend);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取失败率趋势
 */
router.get('/failure-rate/:workflowName', async (req, res) => {
  try {
    const { workflowName } = req.params;
    const { days = 30 } = req.query;
    
    const trend = await cicdService.getFailureRateTrend(workflowName, days);
    res.json(trend);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取部署进度
 */
router.get('/deployment/progress/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const progress = await cicdService.getDeploymentProgress(runId);
    res.json(progress);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * WebSocket 实时状态流（通过 SSE 实现）
 */
router.get('/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // 定期推送状态更新
  const intervalId = setInterval(async () => {
    try {
      const summary = await cicdService.getDashboardSummary();
      res.write(`data: ${JSON.stringify(summary)}\n\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    }
  }, 5000); // 每5秒更新
  
  // 客户端断开连接时清理
  req.on('close', () => {
    clearInterval(intervalId);
  });
});

module.exports = router;
```

### 4.4 构建性能趋势分析

创建 `backend/services/admin/src/analytics/buildPerformanceAnalyzer.js`：

```javascript
/**
 * 构建性能趋势分析器
 * 分析构建耗时趋势，检测性能退化
 */
class BuildPerformanceAnalyzer {
  constructor(db) {
    this.db = db;
    
    // 性能退化检测阈值
    this.degradationThresholds = {
      // 平均耗时增长超过 20% 触发警告
      durationIncrease: 0.2,
      
      // 连续3次耗时超过历史均值50% 触发警告
      consecutiveSlow: 3,
      slowFactor: 1.5
    };
  }

  /**
   * 分析性能趋势
   */
  async analyzeTrend(workflowName, days = 30) {
    // 获取历史数据
    const history = await this._fetchHistory(workflowName, days);
    
    if (history.length < 5) {
      return { insufficientData: true, message: '数据不足，需要至少5次成功运行' };
    }
    
    // 计算基础统计
    const stats = this._calculateStats(history);
    
    // 检测退化
    const degradation = this._detectDegradation(history, stats);
    
    // 分析趋势方向
    const trendDirection = this._analyzeTrendDirection(history);
    
    // 生成可视化数据点
    const chartData = this._generateChartData(history);
    
    return {
      workflow: workflowName,
      periodDays: days,
      sampleSize: history.length,
      
      // 统计摘要
      stats: {
        avgDuration: stats.avg,
        medianDuration: stats.median,
        minDuration: stats.min,
        maxDuration: stats.max,
        stdDev: stats.stdDev
      },
      
      // 退化检测
      degradation,
      
      // 趋势方向
      trendDirection,
      
      // 可视化数据
      chartData,
      
      // 建议
      recommendations: this._generateRecommendations(degradation, trendDirection)
    };
  }

  /**
   * 获取历史数据
   */
  async _fetchHistory(workflowName, days) {
    const result = await this.db.query(`
      SELECT 
        run_id,
        duration_seconds,
        started_at,
        commit_sha,
        actor
      FROM cicd_run_history
      WHERE workflow_name = $1
        AND conclusion = 'success'
        AND duration_seconds IS NOT NULL
        AND started_at > NOW() - INTERVAL '${days} days'
      ORDER BY started_at ASC
    `, [workflowName]);
    
    return result.rows;
  }

  /**
   * 计算统计值
   */
  _calculateStats(history) {
    const durations = history.map(h => h.duration_seconds);
    
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    
    const sorted = durations.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    
    // 标准差
    const variance = durations.reduce((sum, d) => sum + Math.pow(d - avg, 2), 0) / durations.length;
    const stdDev = Math.sqrt(variance);
    
    return { avg, median, min, max, stdDev };
  }

  /**
   * 检测性能退化
   */
  _detectDegradation(history, stats) {
    const issues = [];
    
    // 1. 检测整体耗时增长
    const recent = history.slice(-10);
    const older = history.slice(0, history.length - 10);
    
    if (older.length >= 5 && recent.length >= 5) {
      const recentAvg = this._calculateAvg(recent);
      const olderAvg = this._calculateAvg(older);
      
      const increaseRate = (recentAvg - olderAvg) / olderAvg;
      
      if (increaseRate > this.degradationThresholds.durationIncrease) {
        issues.push({
          type: 'DURATION_INCREASE',
          severity: increaseRate > 0.5 ? 'high' : 'medium',
          message: `构建耗时增长 ${(increaseRate * 100).toFixed(1)}%`,
          recentAvg: this._formatDuration(recentAvg),
          olderAvg: this._formatDuration(olderAvg),
          increaseRate: (increaseRate * 100).toFixed(1)
        });
      }
    }
    
    // 2. 检测连续慢构建
    const slowThreshold = stats.avg * this.degradationThresholds.slowFactor;
    const consecutiveSlowCount = this._countConsecutiveSlow(history, slowThreshold);
    
    if (consecutiveSlowCount >= this.degradationThresholds.consecutiveSlow) {
      issues.push({
        type: 'CONSECUTIVE_SLOW',
        severity: 'high',
        message: `连续 ${consecutiveSlowCount} 次构建耗时异常`,
        threshold: this._formatDuration(slowThreshold),
        count: consecutiveSlowCount
      });
    }
    
    // 3. 检测异常峰值
    const peakThreshold = stats.avg + 2 * stats.stdDev;
    const peaks = history.filter(h => h.duration_seconds > peakThreshold);
    
    if (peaks.length > 0) {
      issues.push({
        type: 'PEAK_DETECTED',
        severity: 'medium',
        message: `检测到 ${peaks.length} 次构建耗时异常峰值`,
        threshold: this._formatDuration(peakThreshold),
        peakRuns: peaks.slice(-3).map(p => ({
          runId: p.run_id,
          duration: this._formatDuration(p.duration_seconds),
          date: p.started_at
        }))
      });
    }
    
    return {
      hasDegradation: issues.length > 0,
      issues,
      riskLevel: this._assessRisk(issues)
    };
  }

  /**
   * 分析趋势方向
   */
  _analyzeTrendDirection(history) {
    // 使用线性回归分析趋势
    const n = history.length;
    const x = history.map((h, i) => i);
    const y = history.map(h => h.duration_seconds);
    
    // 计算 slope
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    
    // 判断方向
    if (slope > 5) {
      return { direction: 'increasing', slope, message: '构建耗时呈上升趋势' };
    } else if (slope < -5) {
      return { direction: 'decreasing', slope, message: '构建耗时呈下降趋势（改善）' };
    }
    
    return { direction: 'st