/**
 * 灾难演练 API 服务器
 * 
 * 提供演练管理 API：
 * - 创建/启动/停止演练
 * - 查询演练状态和结果
 * - 生成演练报告
 * 
 * @module backend/services/drillApiServer
 */

'use strict';

const express = require('express');
const logger = require('../shared/logger')('drill-api');
const { DrillExecutor, DrillReportGenerator, DrillScenarioLibrary } = require('../shared/drillEngine');
const { KubernetesClient } = require('../shared/k8sClient');
const { PrometheusClient } = require('../shared/prometheusClient');

// 配置
const CONFIG = {
  port: parseInt(process.env.DRILL_API_PORT) || 3002,
  enableAuth: process.env.ENABLE_AUTH !== 'false',
  maxConcurrentDrills: parseInt(process.env.MAX_CONCURRENT_DRILLS) || 1
};

// 应用实例
const app = express();
app.use(express.json());

// 客户端
let k8sClient = null;
let prometheusClient = null;
let executor = null;
let reportGenerator = null;
let scenarioLibrary = null;

// 演练记录存储（生产环境应使用数据库）
const drillStore = {
  active: new Map(),
  completed: []
};

/**
 * 初始化
 */
async function initialize() {
  try {
    logger.info('初始化演练 API 服务器...');

    // 初始化客户端
    k8sClient = new KubernetesClient();
    prometheusClient = new PrometheusClient(process.env.PROMETHEUS_URL || 'http://prometheus:9090');
    
    // 初始化演练组件
    executor = new DrillExecutor(k8sClient, prometheusClient);
    reportGenerator = new DrillReportGenerator();
    scenarioLibrary = new DrillScenarioLibrary(process.env.DRILL_SCENARIOS_DIR || './drill-scenarios');

    // 设置路由
    setupRoutes();

    logger.info({ port: CONFIG.port }, '演练 API 服务器初始化完成');

  } catch (error) {
    logger.error({ error: error.message }, '初始化失败');
    throw error;
  }
}

/**
 * 设置路由
 */
function setupRoutes() {
  // 健康检查
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      activeDrills: drillStore.active.size
    });
  });

  app.get('/ready', (req, res) => {
    if (executor && reportGenerator && scenarioLibrary) {
      res.json({ status: 'ready' });
    } else {
      res.status(503).json({ status: 'not-ready' });
    }
  });

  // === 演练场景管理 ===

  // 获取所有演练场景
  app.get('/api/drill/scenarios', (req, res) => {
    try {
      const scenarios = scenarioLibrary.getAllScenarios();
      res.json({
        count: scenarios.length,
        scenarios: scenarios.map(s => s.toJSON())
      });
    } catch (error) {
      logger.error({ error: error.message }, '获取演练场景失败');
      res.status(500).json({ error: error.message });
    }
  });

  // 获取单个演练场景
  app.get('/api/drill/scenarios/:scenarioId', (req, res) => {
    try {
      const scenario = scenarioLibrary.getScenario(req.params.scenarioId);
      
      if (!scenario) {
        return res.status(404).json({ error: '场景不存在' });
      }

      res.json(scenario.toJSON());
    } catch (error) {
      logger.error({ error: error.message }, '获取演练场景失败');
      res.status(500).json({ error: error.message });
    }
  });

  // === 演练执行管理 ===

  // 创建新演练
  app.post('/api/drill/execute', async (req, res) => {
    try {
      // 检查并发限制
      if (drillStore.active.size >= CONFIG.maxConcurrentDrills) {
        return res.status(429).json({ 
          error: '已达最大并发演练数',
          maxConcurrent: CONFIG.maxConcurrentDrills,
          current: drillStore.active.size
        });
      }

      const { scenarioId, customConfig } = req.body;
      
      // 获取场景
      const scenario = scenarioLibrary.getScenario(scenarioId);
      if (!scenario) {
        return res.status(404).json({ error: '场景不存在' });
      }

      // 应用自定义配置
      if (customConfig) {
        Object.assign(scenario, customConfig);
      }

      logger.info({ scenarioId: scenario.id, name: scenario.name }, '开始执行演练');

      // 异步执行演练
      const drillId = `drill-${Date.now()}`;
      drillStore.active.set(drillId, {
        id: drillId,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        startTime: new Date().toISOString(),
        status: 'running'
      });

      // 在后台执行
      executor.executeScenario(scenario)
        .then(execution => {
          // 移动到完成列表
          drillStore.active.delete(drillId);
          drillStore.completed.unshift(execution);
          
          // 保持最多 100 条历史记录
          if (drillStore.completed.length > 100) {
            drillStore.completed = drillStore.completed.slice(0, 100);
          }

          logger.info({ drillId, status: 'completed' }, '演练完成');
        })
        .catch(error => {
          logger.error({ error: error.message, drillId }, '演练执行失败');
          
          // 更新状态
          const drill = drillStore.active.get(drillId);
          if (drill) {
            drill.status = 'failed';
            drill.error = error.message;
            drill.endTime = new Date().toISOString();
            
            drillStore.active.delete(drillId);
            drillStore.completed.unshift(drill);
          }
        });

      res.status(202).json({
        drillId,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        status: 'started',
        message: '演练已启动',
        estimatedDuration: scenario.duration
      });

    } catch (error) {
      logger.error({ error: error.message }, '创建演练失败');
      res.status(500).json({ error: error.message });
    }
  });

  // 获取活跃演练
  app.get('/api/drill/active', (req, res) => {
    try {
      const activeDrills = Array.from(drillStore.active.values());
      res.json({
        count: activeDrills.length,
        drills: activeDrills
      });
    } catch (error) {
      logger.error({ error: error.message }, '获取活跃演练失败');
      res.status(500).json({ error: error.message });
    }
  });

  // 获取演练历史
  app.get('/api/drill/history', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const offset = parseInt(req.query.offset) || 0;
      
      const history = drillStore.completed.slice(offset, offset + limit);
      
      res.json({
        total: drillStore.completed.length,
        offset,
        limit,
        drills: history
      });
    } catch (error) {
      logger.error({ error: error.message }, '获取演练历史失败');
      res.status(500).json({ error: error.message });
    }
  });

  // 获取演练详情
  app.get('/api/drill/:drillId', (req, res) => {
    try {
      const drillId = req.params.drillId;
      
      // 先检查活跃演练
      let drill = drillStore.active.get(drillId);
      
      // 如果不是活跃的，查找历史记录
      if (!drill) {
        drill = drillStore.completed.find(d => d.id === drillId);
      }

      if (!drill) {
        return res.status(404).json({ error: '演练不存在' });
      }

      res.json(drill);
    } catch (error) {
      logger.error({ error: error.message }, '获取演练详情失败');
      res.status(500).json({ error: error.message });
    }
  });

  // 停止演练
  app.post('/api/drill/:drillId/stop', async (req, res) => {
    try {
      const drillId = req.params.drillId;
      const drill = drillStore.active.get(drillId);

      if (!drill) {
        return res.status(404).json({ error: '演练不存在或已完成' });
      }

      logger.info({ drillId }, '停止演练');

      // 回滚所有混沌实验
      await executor.rollbackAll();

      // 更新状态
      drill.status = 'stopped';
      drill.endTime = new Date().toISOString();
      drill.manualStop = true;

      drillStore.active.delete(drillId);
      drillStore.completed.unshift(drill);

      res.json({
        drillId,
        status: 'stopped',
        message: '演练已停止'
      });

    } catch (error) {
      logger.error({ error: error.message }, '停止演练失败');
      res.status(500).json({ error: error.message });
    }
  });

  // === 演练报告 ===

  // 生成演练报告
  app.get('/api/drill/:drillId/report', async (req, res) => {
    try {
      const drillId = req.params.drillId;
      const format = req.query.format || 'standard';

      // 查找演练
      const drill = drillStore.completed.find(d => d.id === drillId);
      
      if (!drill) {
        return res.status(404).json({ error: '演练不存在' });
      }

      // 生成报告
      const report = await reportGenerator.generateReport(drill, format);

      res.json(report);

    } catch (error) {
      logger.error({ error: error.message }, '生成演练报告失败');
      res.status(500).json({ error: error.message });
    }
  });

  // 导出报告为 Markdown
  app.get('/api/drill/:drillId/report/markdown', async (req, res) => {
    try {
      const drillId = req.params.drillId;
      
      // 查找演练
      const drill = drillStore.completed.find(d => d.id === drillId);
      
      if (!drill) {
        return res.status(404).json({ error: '演练不存在' });
      }

      // 生成报告
      const report = await reportGenerator.generateReport(drill, 'detailed');

      // 转换为 Markdown
      const markdown = generateMarkdownReport(report);

      res.type('text/markdown').send(markdown);

    } catch (error) {
      logger.error({ error: error.message }, '导出 Markdown 报告失败');
      res.status(500).json({ error: error.message });
    }
  });

  // === 监控指标 ===

  // 获取演练统计
  app.get('/api/drill/statistics', (req, res) => {
    try {
      const completed = drillStore.completed;
      
      const stats = {
        total: completed.length,
        successful: completed.filter(d => d.status === 'completed').length,
        failed: completed.filter(d => d.status === 'failed').length,
        stopped: completed.filter(d => d.status === 'stopped').length,
        averageRTO: 0,
        averageDuration: 0,
        sloComplianceRate: 0
      };

      // 计算平均值
      const successfulDrills = completed.filter(d => d.results);
      if (successfulDrills.length > 0) {
        stats.averageRTO = successfulDrills.reduce((sum, d) => sum + (d.results.rto || 0), 0) / successfulDrills.length;
        stats.averageDuration = successfulDrills.reduce((sum, d) => sum + (d.duration || 0), 0) / successfulDrills.length;
        stats.sloComplianceRate = successfulDrills.filter(d => {
          const slo = d.results.sloCompliance;
          return Object.keys(slo).every(key => slo[key].passed);
        }).length / successfulDrills.length;
      }

      res.json(stats);

    } catch (error) {
      logger.error({ error: error.message }, '获取演练统计失败');
      res.status(500).json({ error: error.message });
    }
  });

  // Prometheus 指标端点
  app.get('/metrics', (req, res) => {
    const metrics = [
      '# HELP drill_total Total number of drills',
      '# TYPE drill_total counter',
      `drill_total{status="completed"} ${drillStore.completed.filter(d => d.status === 'completed').length}`,
      `drill_total{status="failed"} ${drillStore.completed.filter(d => d.status === 'failed').length}`,
      `drill_total{status="stopped"} ${drillStore.completed.filter(d => d.status === 'stopped').length}`,
      '',
      '# HELP drill_active Current active drills',
      '# TYPE drill_active gauge',
      `drill_active ${drillStore.active.size}`,
      '',
      '# HELP drill_duration_seconds Average drill duration in seconds',
      '# TYPE drill_duration_seconds gauge',
      `drill_duration_seconds ${drillStore.completed.length > 0 ? drillStore.completed.reduce((sum, d) => sum + (d.duration || 0), 0) / drillStore.completed.length / 1000 : 0}`
    ].join('\n');

    res.type('text/plain').send(metrics);
  });
}

/**
 * 生成 Markdown 报告
 */
function generateMarkdownReport(report) {
  const lines = [
    `# 灾难恢复演练报告`,
    ``,
    `**演练ID**: ${report.metadata.executionId}`,
    `**生成时间**: ${report.metadata.generatedAt}`,
    ``,
    `## 演练摘要`,
    ``,
    `- **状态**: ${report.summary.status}`,
    `- **开始时间**: ${report.summary.startTime}`,
    `- **结束时间**: ${report.summary.endTime}`,
    `- **持续时间**: ${(report.summary.duration / 1000 / 60).toFixed(2)} 分钟`,
    ``,
    `## SLO 合规性`,
    ``,
    `| 指标 | 基线值 | 最低值 | 恢复值 | 是否通过 |`,
    `|------|--------|--------|--------|----------|`,
  ];

  for (const [key, value] of Object.entries(report.sloCompliance)) {
    lines.push(`| ${key} | ${value.baseline || '-'} | ${value.minimum || value.peak || '-'} | ${value.recovered || '-'} | ${value.passed ? '✅' : '❌'} |`);
  }

  lines.push(
    ``,
    `## 影响分析`,
    ``,
    `- **总体影响**: ${report.impact.overallImpact || 'unknown'}`,
    `- **受影响服务数**: ${report.impact.affectedServices || 0}`,
    `- **RTO (恢复时间目标)**: ${(report.recovery.rto / 1000 / 60).toFixed(2)} 分钟`,
    `- **RPO (恢复点目标)**: ${(report.recovery.rpo / 1000 / 60).toFixed(2)} 分钟`,
    ``,
    `## 建议`,
    ``
  );

  if (report.recommendations && report.recommendations.length > 0) {
    for (const rec of report.recommendations) {
      lines.push(`- **[${rec.severity.toUpperCase()}]** ${rec.message}`);
    }
  } else {
    lines.push(`- 无`);
  }

  lines.push(
    ``,
    `---`,
    `*此报告由 mineGo 灾难演练系统自动生成*`
  );

  return lines.join('\n');
}

/**
 * 启动服务器
 */
async function start() {
  try {
    await initialize();
    
    app.listen(CONFIG.port, () => {
      logger.info({ port: CONFIG.port }, '演练 API 服务器已启动');
    });

  } catch (error) {
    logger.error({ error: error.message }, '启动失败');
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGTERM', async () => {
  logger.info('收到 SIGTERM，准备关闭...');
  
  // 回滚所有活跃演练
  if (executor && drillStore.active.size > 0) {
    logger.info('回滚所有活跃演练...');
    await executor.rollbackAll();
  }
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('收到 SIGINT，准备关闭...');
  process.exit(0);
});

// 运行
if (require.main === module) {
  start();
}

module.exports = { app, initialize, start };
