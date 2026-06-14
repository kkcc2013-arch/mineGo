// backend/shared/RootCauseAnalyzer.js
'use strict';

const { createLogger } = require('./logger');
const fs = require('fs').promises;
const path = require('path');

const logger = createLogger('root-cause-analyzer');

/**
 * 自动化根因分析系统
 * 
 * 功能：
 * 1. 日志分析（最近 1000 条日志）
 * 2. 资源快照（崩溃前 CPU/内存曲线）
 * 3. 依赖链路追踪（上游调用链）
 * 4. 诊断报告生成（Markdown 格式）
 */
class RootCauseAnalyzer {
  constructor(config = {}) {
    this.config = {
      logBufferSize: config.logBufferSize || 1000, // 日志缓冲大小
      metricsWindowSize: config.metricsWindowSize || 3600000, // 指标窗口大小 1小时
      maxTraces: config.maxTraces || 100, // 最大追踪记录数
      reportDir: config.reportDir || path.join(process.cwd(), 'logs', 'diagnostics'),
      ...config
    };
    
    // 日志缓冲
    this.logBuffer = [];
    
    // 指标历史
    this.metricsHistory = [];
    
    // 追踪记录
    this.traces = [];
    
    // 确保报告目录存在
    this.ensureReportDir();
  }
  
  /**
   * 确保报告目录存在
   */
  async ensureReportDir() {
    try {
      await fs.mkdir(this.config.reportDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create report directory', { error: error.message });
    }
  }
  
  /**
   * 添加日志到缓冲
   */
  addLog(logEntry) {
    this.logBuffer.push({
      ...logEntry,
      timestamp: logEntry.timestamp || Date.now()
    });
    
    // 保持缓冲大小
    if (this.logBuffer.length > this.config.logBufferSize) {
      this.logBuffer.shift();
    }
  }
  
  /**
   * 添加指标记录
   */
  addMetric(metricEntry) {
    this.metricsHistory.push({
      ...metricEntry,
      timestamp: metricEntry.timestamp || Date.now()
    });
    
    // 保持窗口大小
    const cutoff = Date.now() - this.config.metricsWindowSize;
    this.metricsHistory = this.metricsHistory.filter(m => m.timestamp > cutoff);
  }
  
  /**
   * 添加追踪记录
   */
  addTrace(traceEntry) {
    this.traces.push({
      ...traceEntry,
      timestamp: traceEntry.timestamp || Date.now()
    });
    
    // 保持最大数量
    if (this.traces.length > this.config.maxTraces) {
      this.traces.shift();
    }
  }
  
  /**
   * 生成诊断报告
   */
  async generateReport(serviceName, crashTime, options = {}) {
    logger.info('Generating diagnostic report', {
      serviceName,
      crashTime: new Date(crashTime).toISOString()
    });
    
    try {
      // 收集数据
      const [logs, metrics, traces, dependencies] = await Promise.all([
        this.fetchRecentLogs(serviceName, crashTime),
        this.fetchResourceMetrics(serviceName, crashTime),
        this.fetchTraces(serviceName, crashTime),
        this.analyzeDependencies(serviceName, crashTime)
      ]);
      
      // 分析根因
      const rootCause = this.identifyRootCause(logs, metrics);
      const severity = this.assessSeverity(logs, metrics, rootCause);
      const affectedUsers = await this.estimateAffectedUsers(serviceName, crashTime);
      
      // 构建报告
      const report = {
        service: serviceName,
        crashTime: crashTime,
        generatedAt: new Date().toISOString(),
        
        summary: {
          rootCause: rootCause,
          severity: severity,
          affectedUsers: affectedUsers
        },
        
        timeline: this.buildTimeline(logs, metrics, crashTime),
        
        resourceSnapshot: {
          cpu: metrics.cpu.slice(-10),
          memory: metrics.memory.slice(-10),
          connections: metrics.connections.slice(-10)
        },
        
        errorAnalysis: {
          errorCount: this.countErrors(logs),
          errorTypes: this.categorizeErrors(logs),
          sampleErrors: this.extractSampleErrors(logs, 5)
        },
        
        dependencyHealth: dependencies,
        
        recommendations: this.generateRecommendations(logs, metrics, dependencies, rootCause)
      };
      
      // 保存报告
      await this.saveReport(report, options.format || 'markdown');
      
      // 发送通知
      if (options.notify !== false) {
        await this.notifyTeam(report);
      }
      
      logger.info('Diagnostic report generated', {
        serviceName,
        reportId: report.id
      });
      
      return report;
    } catch (error) {
      logger.error('Failed to generate diagnostic report', {
        serviceName,
        error: error.message
      });
      
      throw error;
    }
  }
  
  /**
   * 获取最近日志
   */
  async fetchRecentLogs(serviceName, crashTime) {
    const windowStart = crashTime - 300000; // 5分钟前
    const windowEnd = crashTime;
    
    // 从缓冲中获取日志
    const logs = this.logBuffer.filter(log =>
      log.timestamp >= windowStart &&
      log.timestamp <= windowEnd &&
      (!serviceName || log.service === serviceName)
    );
    
    return logs;
  }
  
  /**
   * 获取资源指标
   */
  async fetchResourceMetrics(serviceName, crashTime) {
    const windowStart = crashTime - 3600000; // 1小时前
    const windowEnd = crashTime;
    
    // 从历史中获取指标
    const metrics = this.metricsHistory.filter(m =>
      m.timestamp >= windowStart &&
      m.timestamp <= windowEnd
    );
    
    // 分类指标
    return {
      cpu: metrics.filter(m => m.type === 'cpu'),
      memory: metrics.filter(m => m.type === 'memory'),
      connections: metrics.filter(m => m.type === 'connections'),
      all: metrics
    };
  }
  
  /**
   * 获取追踪记录
   */
  async fetchTraces(serviceName, crashTime) {
    const windowStart = crashTime - 600000; // 10分钟前
    const windowEnd = crashTime;
    
    return this.traces.filter(trace =>
      trace.timestamp >= windowStart &&
      trace.timestamp <= windowEnd
    );
  }
  
  /**
   * 分析依赖服务健康状态
   */
  async analyzeDependencies(serviceName, crashTime) {
    // 这里可以集成实际的服务依赖检查
    return {
      database: {
        status: 'unknown',
        latency: null
      },
      redis: {
        status: 'unknown',
        latency: null
      },
      kafka: {
        status: 'unknown',
        latency: null
      }
    };
  }
  
  /**
   * 识别根因
   */
  identifyRootCause(logs, metrics) {
    // 分析日志中的错误模式
    const errorPatterns = this.extractErrorPatterns(logs);
    
    // 检查资源指标
    const resourceIssues = this.detectResourceIssues(metrics);
    
    // 关联分析
    if (resourceIssues.memory > 90 && errorPatterns.includes('ENOMEM')) {
      return {
        type: 'memory_exhaustion',
        confidence: 0.95,
        evidence: `内存使用率 ${resourceIssues.memory}%，发现 OOM 错误`,
        details: {
          memoryUsage: resourceIssues.memory,
          errorPattern: 'ENOMEM',
          errorCount: errorPatterns.filter(p => p === 'ENOMEM').length
        }
      };
    }
    
    if (resourceIssues.connections > 80 && errorPatterns.includes('ECONNREFUSED')) {
      return {
        type: 'connection_pool_exhaustion',
        confidence: 0.90,
        evidence: `连接池使用率 ${resourceIssues.connections}%，发现连接拒绝错误`,
        details: {
          connectionUsage: resourceIssues.connections,
          errorPattern: 'ECONNREFUSED'
        }
      };
    }
    
    if (errorPatterns.includes('deadlock')) {
      return {
        type: 'database_deadlock',
        confidence: 0.85,
        evidence: '检测到数据库死锁',
        details: {
          errorPattern: 'deadlock'
        }
      };
    }
    
    if (errorPatterns.includes('Redis error')) {
      return {
        type: 'redis_failure',
        confidence: 0.80,
        evidence: '检测到 Redis 连接错误',
        details: {
          errorPattern: 'Redis error'
        }
      };
    }
    
    // 默认返回
    return {
      type: 'unknown',
      confidence: 0.50,
      evidence: '无法确定具体根因，建议人工分析',
      details: {}
    };
  }
  
  /**
   * 评估严重程度
   */
  assessSeverity(logs, metrics, rootCause) {
    const severity = {
      level: 'medium',
      score: 50,
      factors: []
    };
    
    // 根据错误数量评估
    const errorCount = this.countErrors(logs);
    if (errorCount > 100) {
      severity.score += 20;
      severity.factors.push('大量错误日志');
    }
    
    // 根据资源问题评估
    const resourceIssues = this.detectResourceIssues(metrics);
    if (resourceIssues.memory > 90) {
      severity.score += 15;
      severity.factors.push('内存使用率极高');
    }
    
    if (resourceIssues.cpu > 90) {
      severity.score += 10;
      severity.factors.push('CPU 使用率极高');
    }
    
    // 根据根因置信度评估
    if (rootCause.confidence > 0.8) {
      severity.score += 10;
      severity.factors.push('根因明确');
    }
    
    // 确定等级
    if (severity.score >= 80) {
      severity.level = 'critical';
    } else if (severity.score >= 60) {
      severity.level = 'high';
    } else if (severity.score >= 40) {
      severity.level = 'medium';
    } else {
      severity.level = 'low';
    }
    
    return severity;
  }
  
  /**
   * 估算受影响用户数
   */
  async estimateAffectedUsers(serviceName, crashTime) {
    // 这里可以集成实际的用户追踪系统
    return {
      estimated: 0,
      range: '0-10',
      method: 'estimation'
    };
  }
  
  /**
   * 构建时间线
   */
  buildTimeline(logs, metrics, crashTime) {
    const timeline = [];
    
    // 添加日志事件
    for (const log of logs.slice(-20)) {
      timeline.push({
        timestamp: log.timestamp,
        type: 'log',
        level: log.level,
        message: log.message
      });
    }
    
    // 添加关键指标事件
    for (const metric of metrics.all.slice(-10)) {
      timeline.push({
        timestamp: metric.timestamp,
        type: 'metric',
        metric: metric.name,
        value: metric.value
      });
    }
    
    // 按时间排序
    timeline.sort((a, b) => a.timestamp - b.timestamp);
    
    return timeline;
  }
  
  /**
   * 提取错误模式
   */
  extractErrorPatterns(logs) {
    const patterns = [];
    const errorLogs = logs.filter(log => log.level === 'error' || log.level === 'fatal');
    
    for (const log of errorLogs) {
      if (log.message.includes('ENOMEM') || log.message.includes('out of memory')) {
        patterns.push('ENOMEM');
      }
      if (log.message.includes('ECONNREFUSED')) {
        patterns.push('ECONNREFUSED');
      }
      if (log.message.includes('deadlock')) {
        patterns.push('deadlock');
      }
      if (log.message.includes('Redis error') || log.message.includes('Redis connection')) {
        patterns.push('Redis error');
      }
      if (log.message.includes('ECONNRESET')) {
        patterns.push('ECONNRESET');
      }
    }
    
    return patterns;
  }
  
  /**
   * 检测资源问题
   */
  detectResourceIssues(metrics) {
    const issues = {
      memory: 0,
      cpu: 0,
      connections: 0
    };
    
    // 获取最新的内存指标
    const latestMemory = metrics.memory[metrics.memory.length - 1];
    if (latestMemory) {
      issues.memory = latestMemory.value || 0;
    }
    
    // 获取最新的 CPU 指标
    const latestCpu = metrics.cpu[metrics.cpu.length - 1];
    if (latestCpu) {
      issues.cpu = latestCpu.value || 0;
    }
    
    // 获取最新的连接数指标
    const latestConnections = metrics.connections[metrics.connections.length - 1];
    if (latestConnections) {
      issues.connections = latestConnections.value || 0;
    }
    
    return issues;
  }
  
  /**
   * 统计错误数量
   */
  countErrors(logs) {
    return logs.filter(log => log.level === 'error' || log.level === 'fatal').length;
  }
  
  /**
   * 分类错误
   */
  categorizeErrors(logs) {
    const categories = {};
    
    const errorLogs = logs.filter(log => log.level === 'error' || log.level === 'fatal');
    
    for (const log of errorLogs) {
      const category = this.categorizeError(log.message);
      categories[category] = (categories[category] || 0) + 1;
    }
    
    return categories;
  }
  
  /**
   * 分类单个错误
   */
  categorizeError(message) {
    if (message.includes('memory') || message.includes('ENOMEM')) {
      return 'memory_error';
    }
    if (message.includes('connection') || message.includes('ECONNREFUSED')) {
      return 'connection_error';
    }
    if (message.includes('timeout')) {
      return 'timeout_error';
    }
    if (message.includes('database') || message.includes('sql')) {
      return 'database_error';
    }
    if (message.includes('redis')) {
      return 'redis_error';
    }
    return 'unknown_error';
  }
  
  /**
   * 提取示例错误
   */
  extractSampleErrors(logs, count = 5) {
    const errorLogs = logs.filter(log => log.level === 'error' || log.level === 'fatal');
    
    return errorLogs.slice(-count).map(log => ({
      timestamp: log.timestamp,
      message: log.message.substring(0, 200)
    }));
  }
  
  /**
   * 生成推荐建议
   */
  generateRecommendations(logs, metrics, dependencies, rootCause) {
    const recommendations = [];
    
    switch (rootCause.type) {
      case 'memory_exhaustion':
        recommendations.push({
          priority: 'P0',
          action: '增加容器内存限制',
          details: '当前内存不足，建议增加至 1.5 倍',
          estimatedEffort: 'S'
        });
        recommendations.push({
          priority: 'P1',
          action: '检查内存泄漏',
          details: '分析内存增长曲线，排查泄漏点',
          estimatedEffort: 'M'
        });
        break;
        
      case 'connection_pool_exhausted':
        recommendations.push({
          priority: 'P0',
          action: '扩大连接池',
          details: '当前连接池配置不足以支撑负载',
          estimatedEffort: 'S'
        });
        recommendations.push({
          priority: 'P1',
          action: '优化连接复用',
          details: '检查是否有连接未正确释放',
          estimatedEffort: 'M'
        });
        break;
        
      case 'database_deadlock':
        recommendations.push({
          priority: 'P0',
          action: '优化事务逻辑',
          details: '检查事务隔离级别和锁定顺序',
          estimatedEffort: 'M'
        });
        recommendations.push({
          priority: 'P1',
          action: '添加死锁重试机制',
          details: '实现自动死锁检测和重试',
          estimatedEffort: 'S'
        });
        break;
        
      default:
        recommendations.push({
          priority: 'P1',
          action: '人工分析',
          details: '自动分析无法确定根因，建议人工介入',
          estimatedEffort: 'L'
        });
    }
    
    // 添加通用建议
    recommendations.push({
      priority: 'P2',
      action: '增加监控告警',
      details: '在资源使用率达到阈值时提前告警',
      estimatedEffort: 'S'
    });
    
    return recommendations;
  }
  
  /**
   * 保存报告
   */
  async saveReport(report, format = 'markdown') {
    const reportId = `report-${Date.now()}`;
    report.id = reportId;
    
    try {
      if (format === 'markdown') {
        const content = this.formatReportAsMarkdown(report);
        const filePath = path.join(this.config.reportDir, `${reportId}.md`);
        await fs.writeFile(filePath, content, 'utf8');
        report.filePath = filePath;
      } else {
        const content = JSON.stringify(report, null, 2);
        const filePath = path.join(this.config.reportDir, `${reportId}.json`);
        await fs.writeFile(filePath, content, 'utf8');
        report.filePath = filePath;
      }
      
      logger.info('Report saved', { reportId, filePath: report.filePath });
    } catch (error) {
      logger.error('Failed to save report', { error: error.message });
      throw error;
    }
  }
  
  /**
   * 将报告格式化为 Markdown
   */
  formatReportAsMarkdown(report) {
    let md = `# 故障诊断报告

**服务**: ${report.service}  
**崩溃时间**: ${new Date(report.crashTime).toISOString()}  
**生成时间**: ${report.generatedAt}

---

## 📊 摘要

### 根因分析

- **类型**: ${report.summary.rootCause.type}
- **置信度**: ${(report.summary.rootCause.confidence * 100).toFixed(0)}%
- **证据**: ${report.summary.rootCause.evidence}

### 严重程度

- **等级**: ${report.summary.severity.level.toUpperCase()}
- **评分**: ${report.summary.severity.score}/100
- **因素**: ${report.summary.severity.factors.join(', ') || '无'}

---

## 📈 资源快照

### CPU 使用率

\`\`\`
${report.resourceSnapshot.cpu.map(m => `${new Date(m.timestamp).toISOString()}: ${m.value}%`).join('\n')}
\`\`\`

### 内存使用率

\`\`\`
${report.resourceSnapshot.memory.map(m => `${new Date(m.timestamp).toISOString()}: ${m.value}%`).join('\n')}
\`\`\`

### 连接数

\`\`\`
${report.resourceSnapshot.connections.map(m => `${new Date(m.timestamp).toISOString()}: ${m.value}`).join('\n')}
\`\`\`

---

## 🐛 错误分析

- **错误总数**: ${report.errorAnalysis.errorCount}
- **错误类型分布**:

| 类型 | 数量 |
|------|------|
${Object.entries(report.errorAnalysis.errorTypes).map(([type, count]) => `| ${type} | ${count} |`).join('\n')}

### 示例错误

${report.errorAnalysis.sampleErrors.map((e, i) => `
${i + 1}. **时间**: ${new Date(e.timestamp).toISOString()}
   **消息**: \`${e.message}\`
`).join('\n')}

---

## 💡 推荐建议

${report.recommendations.map((r, i) => `
### ${i + 1}. ${r.action} (${r.priority})

${r.details}

**预估工作量**: ${r.estimatedEffort}
`).join('\n')}

---

## 📝 时间线

${report.timeline.slice(-20).map(event => `
- **${new Date(event.timestamp).toISOString()}** [${event.type}] ${event.message || event.metric}
`).join('')}

---

*报告由 RootCauseAnalyzer 自动生成*
`;
    
    return md;
  }
  
  /**
   * 通知团队
   */
  async notifyTeam(report) {
    logger.info('Sending diagnostic report notification', {
      reportId: report.id,
      severity: report.summary.severity.level
    });
    
    // 这里可以集成实际的通知系统
    // 例如发送邮件、Slack、企业微信等
  }
}

module.exports = RootCauseAnalyzer;
