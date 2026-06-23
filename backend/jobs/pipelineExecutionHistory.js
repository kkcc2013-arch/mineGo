/**
 * Pipeline Execution History Analyzer
 * 分析 GitHub Actions 执行历史和趋势
 * 
 * REQ-00287: CI/CD 管道执行依赖分析与并行优化系统
 */

class PipelineExecutionHistory {
  constructor(options = {}) {
    this.options = options;
    this.mockData = options.mockData || null;
    // 模拟模式下使用 mock 数据，避免依赖真实 GitHub API
  }

  /**
   * 获取执行历史
   * 注意：生产环境需要配置 GITHUB_TOKEN
   */
  async getExecutionHistory(days = 30) {
    // 如果有 mock 数据，使用 mock 数据
    if (this.mockData) {
      return this.analyzeRuns(this.mockData);
    }

    // 尝试使用真实 GitHub API
    if (!process.env.GITHUB_TOKEN) {
      console.warn('GITHUB_TOKEN not set, using simulated data');
      return this.generateSimulatedHistory(days);
    }

    try {
      const { Octokit } = require('@octokit/rest');
      const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
      
      const owner = process.env.GITHUB_REPOSITORY?.split('/')[0] || 'kkcc2013-arch';
      const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'mineGo';
      
      const since = new Date();
      since.setDate(since.getDate() - days);
      
      const runs = await octokit.paginate(
        octokit.rest.actions.listWorkflowRunsForRepo,
        {
          owner,
          repo,
          created: `>=${since.toISOString()}`,
          per_page: 100
        }
      );
      
      return this.analyzeRuns(runs);
    } catch (error) {
      console.error('Failed to fetch GitHub Actions history:', error.message);
      return this.generateSimulatedHistory(days);
    }
  }

  /**
   * 生成模拟历史数据（用于测试和无 token 场景）
   */
  generateSimulatedHistory(days) {
    const runs = [];
    const workflows = [
      'ci-cd.yml',
      'deploy.yml',
      'security-scan.yml',
      'performance-tests.yml',
      'integration-test.yml',
      'e2e-tests.yml'
    ];
    
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    
    for (let i = 0; i < days * 3; i++) {
      const timestamp = new Date(now - i * dayMs / 3);
      const workflow = workflows[Math.floor(Math.random() * workflows.length)];
      const duration = Math.floor(Math.random() * 20 + 5) * 60 * 1000; // 5-25 分钟
      const success = Math.random() > 0.1; // 90% 成功率
      
      runs.push({
        id: i + 1,
        name: workflow,
        status: 'completed',
        conclusion: success ? 'success' : 'failure',
        created_at: timestamp.toISOString(),
        run_duration_ms: duration,
        html_url: `https://github.com/example/actions/runs/${i + 1}`
      });
    }
    
    return this.analyzeRuns(runs);
  }

  /**
   * 分析执行记录
   */
  analyzeRuns(runs) {
    const analysis = {
      total: runs.length,
      successful: 0,
      failed: 0,
      cancelled: 0,
      totalDuration: 0,
      avgDuration: 0,
      byWorkflow: {},
      byDay: {},
      failures: [],
      trends: []
    };
    
    for (const run of runs) {
      // 统计状态
      if (run.status === 'completed') {
        if (run.conclusion === 'success') analysis.successful++;
        else if (run.conclusion === 'failure') {
          analysis.failed++;
          analysis.failures.push({
            id: run.id,
            workflow: run.name,
            date: run.created_at,
            duration: (run.run_duration_ms || 0) / 60000, // 转换为分钟
            url: run.html_url
          });
        }
        else if (run.conclusion === 'cancelled') analysis.cancelled++;
      }
      
      // 计算时长
      if (run.run_duration_ms) {
        const durationMinutes = run.run_duration_ms / 60000;
        analysis.totalDuration += durationMinutes;
      }
      
      // 按工作流分组
      const workflowName = run.name || 'unknown';
      if (!analysis.byWorkflow[workflowName]) {
        analysis.byWorkflow[workflowName] = {
          total: 0,
          successful: 0,
          failed: 0,
          avgDuration: 0,
          totalDuration: 0,
          successRate: 0
        };
      }
      analysis.byWorkflow[workflowName].total++;
      if (run.conclusion === 'success') analysis.byWorkflow[workflowName].successful++;
      if (run.conclusion === 'failure') analysis.byWorkflow[workflowName].failed++;
      if (run.run_duration_ms) {
        analysis.byWorkflow[workflowName].totalDuration += run.run_duration_ms / 60000;
      }
      
      // 按天分组
      const day = run.created_at?.split('T')[0] || 'unknown';
      if (!analysis.byDay[day]) {
        analysis.byDay[day] = { total: 0, successful: 0, failed: 0 };
      }
      analysis.byDay[day].total++;
      if (run.conclusion === 'success') analysis.byDay[day].successful++;
      if (run.conclusion === 'failure') analysis.byDay[day].failed++;
    }
    
    // 计算平均值
    if (runs.length > 0) {
      analysis.avgDuration = analysis.totalDuration / runs.length;
    }
    
    for (const workflow of Object.keys(analysis.byWorkflow)) {
      const w = analysis.byWorkflow[workflow];
      if (w.total > 0) {
        w.avgDuration = w.totalDuration / w.total;
        w.successRate = ((w.successful / w.total) * 100).toFixed(1);
      }
    }
    
    // 分析趋势
    analysis.trends = this.identifyTrends(analysis);
    
    return analysis;
  }

  /**
   * 识别趋势和异常
   */
  identifyTrends(analysis) {
    const trends = [];
    
    // 检查失败率上升
    const failureRate = analysis.failed / analysis.total;
    if (failureRate > 0.1) {
      trends.push({
        type: 'high_failure_rate',
        severity: 'warning',
        message: `失败率 ${((failureRate) * 100).toFixed(1)}% 偏高`,
        recommendation: '检查最近的失败原因并修复'
      });
    }
    
    // 检查执行时间趋势
    for (const [workflow, stats] of Object.entries(analysis.byWorkflow)) {
      if (stats.avgDuration > 30) {
        trends.push({
          type: 'long_execution',
          severity: 'info',
          workflow,
          message: `${workflow} 平均执行时间 ${stats.avgDuration.toFixed(1)} 分钟`,
          recommendation: '考虑优化或拆分工作流'
        });
      }
    }
    
    // 检查失败模式
    const recentFailures = analysis.failures.slice(0, 10);
    const failureByWorkflow = {};
    for (const f of recentFailures) {
      failureByWorkflow[f.workflow] = (failureByWorkflow[f.workflow] || 0) + 1;
    }
    
    for (const [workflow, count] of Object.entries(failureByWorkflow)) {
      if (count >= 3) {
        trends.push({
          type: 'recurring_failure',
          severity: 'critical',
          workflow,
          message: `${workflow} 最近失败 ${count} 次`,
          recommendation: '需要立即调查和修复'
        });
      }
    }
    
    return trends;
  }

  /**
   * 预测下次执行时间
   */
  predictNextExecution(workflowName, analysis) {
    const stats = analysis.byWorkflow[workflowName];
    if (!stats) return null;
    
    // 使用简单移动平均
    const avgDuration = stats.avgDuration || 0;
    const variance = stats.total > 0 ? stats.totalDuration / stats.total - avgDuration * avgDuration : 0;
    const stdDev = Math.sqrt(Math.max(0, variance));
    
    return {
      expected: avgDuration,
      min: Math.max(0, avgDuration - 2 * stdDev),
      max: avgDuration + 2 * stdDev,
      confidence: '95%'
    };
  }

  /**
   * 计算每日执行统计
   */
  calculateDailyStats(analysis) {
    const days = Object.keys(analysis.byDay).sort();
    const dailyStats = [];
    
    for (const day of days) {
      const stats = analysis.byDay[day];
      dailyStats.push({
        date: day,
        total: stats.total,
        successful: stats.successful,
        failed: stats.failed,
        successRate: stats.total > 0 ? ((stats.successful / stats.total) * 100).toFixed(1) : 0
      });
    }
    
    return dailyStats;
  }

  /**
   * 生成执行历史报告
   */
  async generateHistoryReport(days = 30) {
    const history = await this.getExecutionHistory(days);
    
    return {
      summary: {
        period: `${days} days`,
        totalRuns: history.total,
        successRate: ((history.successful / history.total) * 100).toFixed(1),
        avgDuration: history.avgDuration.toFixed(1),
        totalDuration: history.totalDuration.toFixed(1)
      },
      workflowStats: history.byWorkflow,
      dailyStats: this.calculateDailyStats(history),
      trends: history.trends,
      recentFailures: history.failures.slice(0, 5),
      predictions: this.generatePredictions(history)
    };
  }

  /**
   * 为所有工作流生成预测
   */
  generatePredictions(analysis) {
    const predictions = {};
    
    for (const workflow of Object.keys(analysis.byWorkflow)) {
      predictions[workflow] = this.predictNextExecution(workflow, analysis);
    }
    
    return predictions;
  }
}

module.exports = PipelineExecutionHistory;