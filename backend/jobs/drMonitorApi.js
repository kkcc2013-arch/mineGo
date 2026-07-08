/**
 * 灾难恢复演练 API 服务
 * 提供手动触发演练、查看报告、配置管理的 API
 */

'use strict';

const express = require('express');
const { DRDrillMonitor, DRILL_SCENARIOS } = require('./drMonitor');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.json());

// 演练报告目录
const REPORTS_DIR = 'docs/dr-drill-reports';

/**
 * 健康检查端点
 */
app.get('/health', async (req, res) => {
  try {
    // 检查关键组件连接
    const checks = {
      api: true,
      reports_dir: await fs.access(REPORTS_DIR).then(() => true).catch(() => false)
    };

    res.json({
      status: checks.api && checks.reports_dir ? 'healthy' : 'degraded',
      checks
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

/**
 * 获取可用演练场景
 */
app.get('/api/scenarios', (req, res) => {
  const scenarios = Object.entries(DRILL_SCENARIOS).map(([key, scenario]) => ({
    id: key,
    name: scenario.name,
    description: scenario.description,
    type: scenario.type,
    metrics: scenario.metrics
  }));

  res.json({ scenarios });
});

/**
 * 手动触发演练
 */
app.post('/api/drills', async (req, res) => {
  try {
    const { scenario } = req.body;

    if (!scenario || !DRILL_SCENARIOS[scenario]) {
      return res.status(400).json({
        error: '无效的演练场景',
        available_scenarios: Object.keys(DRILL_SCENARIOS)
      });
    }

    // 异步执行演练
    const monitor = new DRDrillMonitor();
    const report = await monitor.runDrill(scenario);

    res.json({
      message: '演练已执行完成',
      drill_id: report.drillId,
      summary: report.summary,
      metrics: report.metrics
    });

  } catch (error) {
    res.status(500).json({
      error: '演练执行失败',
      message: error.message,
      stack: error.stack
    });
  }
});

/**
 * 获取演练历史
 */
app.get('/api/drills', async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const files = await fs.readdir(REPORTS_DIR);
    const reportFiles = files.filter(f => f.endsWith('.md')).sort().reverse();

    const reports = [];
    for (let i = offset; i < Math.min(offset + limit, reportFiles.length); i++) {
      const file = reportFiles[i];
      const content = await fs.readFile(path.join(REPORTS_DIR, file), 'utf8');
      
      // 解析报告摘要
      const summary = parseReportSummary(content);
      reports.push({
        drill_id: file.replace('.md', ''),
        file,
        ...summary
      });
    }

    res.json({
      total: reportFiles.length,
      limit,
      offset,
      reports
    });

  } catch (error) {
    res.status(500).json({
      error: '获取演练历史失败',
      message: error.message
    });
  }
});

/**
 * 获取单个演练报告
 */
app.get('/api/drills/:drillId', async (req, res) => {
  try {
    const { drillId } = req.params;
    const filePath = path.join(REPORTS_DIR, `${drillId}.md`);

    const content = await fs.readFile(filePath, 'utf8');
    res.type('text/markdown').send(content);

  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({
        error: '演练报告不存在',
        drill_id: req.params.drillId
      });
    } else {
      res.status(500).json({
        error: '读取报告失败',
        message: error.message
      });
    }
  }
});

/**
 * 删除演练报告
 */
app.delete('/api/drills/:drillId', async (req, res) => {
  try {
    const { drillId } = req.params;
    const filePath = path.join(REPORTS_DIR, `${drillId}.md`);

    await fs.unlink(filePath);
    res.json({
      message: '演练报告已删除',
      drill_id: drillId
    });

  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({
        error: '演练报告不存在',
        drill_id: req.params.drillId
      });
    } else {
      res.status(500).json({
        error: '删除报告失败',
        message: error.message
      });
    }
  }
});

/**
 * Prometheus 指标端点
 */
app.get('/metrics', async (req, res) => {
  try {
    const files = await fs.readdir(REPORTS_DIR);
    const reportFiles = files.filter(f => f.endsWith('.md'));

    // 统计最近演练的成功率
    const recentReports = reportFiles.slice(-10);
    let successCount = 0;
    let avgMttr = 0;
    let avgDataLoss = 0;

    for (const file of recentReports) {
      const content = await fs.readFile(path.join(REPORTS_DIR, file), 'utf8');
      const summary = parseReportSummary(content);
      
      if (summary.success) successCount++;
      if (summary.mttr) avgMttr += parseFloat(summary.mttr);
      if (summary.dataLoss) avgDataLoss += parseFloat(summary.dataLoss);
    }

    const count = recentReports.length || 1;
    avgMttr /= count;
    avgDataLoss /= count;

    const metrics = [
      `# HELP dr_drill_total_total 灾难恢复演练总数`,
      `# TYPE dr_drill_total_total gauge`,
      `dr_drill_total_total ${reportFiles.length}`,
      
      `# HELP dr_drill_success_rate 最近演练成功率`,
      `# TYPE dr_drill_success_rate gauge`,
      `dr_drill_success_rate ${successCount / count}`,
      
      `# HELP dr_drill_mttr_average 平均恢复时间 (秒)`,
      `# TYPE dr_drill_mttr_average gauge`,
      `dr_drill_mttr_average ${avgMttr.toFixed(2)}`,
      
      `# HELP dr_drill_data_loss_average 平均数据丢失率 (%)`,
      `# TYPE dr_drill_data_loss_average gauge`,
      `dr_drill_data_loss_average ${avgDataLoss.toFixed(2)}`,
      
      `# HELP dr_drill_scenarios_available 可用演练场景数量`,
      `# TYPE dr_drill_scenarios_available gauge`,
      `dr_drill_scenarios_available ${Object.keys(DRILL_SCENARIOS).length}`
    ];

    res.type('text/plain').send(metrics.join('\n'));

  } catch (error) {
    res.status(500).send('# ERROR: 无法生成指标\n');
  }
});

/**
 * 解析报告摘要
 */
function parseReportSummary(content) {
  const lines = content.split('\n');
  
  let scenario = '';
  let success = false;
  let mttr = '';
  let dataLoss = '';
  let startTime = '';
  let recoveryTime = '';

  for (const line of lines) {
    if (line.includes('| 演练场景 |')) {
      scenario = line.split('|')[2]?.trim() || '';
    }
    if (line.includes('✅ 演练成功')) {
      success = true;
    }
    if (line.includes('❌ 演练失败')) {
      success = false;
    }
    if (line.includes('| 平均恢复时间 (MTTR) |')) {
      mttr = line.split('|')[2]?.trim().replace('s', '') || '';
    }
    if (line.includes('| 数据丢失率 |')) {
      dataLoss = line.split('|')[2]?.trim().replace('%', '') || '';
    }
    if (line.includes('| 开始时间 |')) {
      startTime = line.split('|')[2]?.trim() || '';
    }
    if (line.includes('| 恢复时间 |')) {
      recoveryTime = line.split('|')[2]?.trim() || '';
    }
  }

  return { scenario, success, mttr, dataLoss, startTime, recoveryTime };
}

/**
 * 启动服务
 */
const PORT = process.env.DR_API_PORT || 8090;
app.listen(PORT, () => {
  console.log(`灾难恢复演练 API 服务已启动，端口: ${PORT}`);
  console.log(`可用端点:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /api/scenarios`);
  console.log(`  POST /api/drills`);
  console.log(`  GET  /api/drills`);
  console.log(`  GET  /api/drills/:drillId`);
  console.log(`  DELETE /api/drills/:drillId`);
  console.log(`  GET  /metrics`);
});

module.exports = app;