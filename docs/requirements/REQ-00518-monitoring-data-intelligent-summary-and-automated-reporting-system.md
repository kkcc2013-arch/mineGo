# REQ-00518：监控数据智能摘要与自动化报告系统

- **编号**：REQ-00518
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/monitorReport、gateway/src/routes/monitorReport、backend/jobs/monitorReportJobs、infrastructure/monitoring、admin-dashboard
- **创建时间**：2026-07-09 08:46
- **依赖需求**：REQ-00504（全链路监控可视化大屏）、REQ-00480（日志异常检测与智能告警聚合）

## 1. 背景与问题

当前 mineGo 项目已建立完善的监控体系（Prometheus 指标、日志异常检测、全链路可视化大屏），但在运维实践中仍面临以下问题：

**监控信息过载**
- Prometheus 有 200+ 业务指标，运维人员难以全面掌握
- 每日需要手动查看多个 Dashboard 才能了解系统健康状态
- 缺少自动化摘要，关键信息淹没在大量数据中

**报告生成手动化**
- 每日/每周运维报告需要人工编写，耗时约 30-60 分钟
- 报告内容不一致，依赖编写者经验判断
- 缺少历史趋势对比和智能洞察

**关键变化识别困难**
- 指标变化（如错误率上升、延迟增加）依赖人工发现
- 缺少基于历史模式的智能预警（如"本周错误率比上周增加 35%"）
- 正常波动与异常变化难以区分

**跨服务聚合能力不足**
- 各服务独立监控，缺少跨服务健康摘要
- 服务间依赖影响分析依赖人工判断
- 系统级健康评估缺少量化标准

## 2. 目标

构建监控数据智能摘要与自动化报告系统，实现：

1. **智能摘要生成**：自动汇总关键指标变化、异常事件、系统健康评分
2. **自动化报告**：每日/每周自动生成运维报告，发送至指定渠道
3. **智能洞察**：基于历史数据识别趋势变化、预测潜在风险
4. **自定义报告模板**：支持按团队/服务定制报告内容
5. **关键事件突出**：自动识别并突出显示重要异常和变化

**可量化目标**：
- 运维报告生成时间减少 90%（从 30 分钟降至自动生成）
- 关键异常识别准确率 ≥ 85%
- 报告阅读时间 ≤ 5 分钟即可掌握系统状态
- 历史趋势预测准确率 ≥ 70%

## 3. 范围

### 包含
- 监控数据采集器（从 Prometheus/API 采集指标）
- 智能摘要生成引擎（关键指标变化检测、健康评分计算）
- 报告模板管理（支持多种报告格式：Markdown、HTML、邮件）
- 定时报告任务（每日摘要、每周深度报告、紧急事件报告）
- 智能洞察引擎（趋势分析、变化检测、预测）
- 报告发送系统（支持 Slack、Email、钉钉、企业微信）
- 报告历史管理（存储历史报告、支持回溯查询）
- Admin Dashboard 报告管理页面

### 不包含
- Prometheus 指标采集机制（使用现有 prom-client）
- 日志异常检测逻辑（依赖 REQ-00480）
- 全链路可视化（依赖 REQ-00504）
- 实时告警系统（依赖现有 AlertManager）

## 4. 详细需求

### 4.1 监控数据采集器（MonitorDataCollector）

**核心类：`backend/shared/monitorReport/MonitorDataCollector.js`**

```javascript
/**
 * 监控数据采集器
 * 
 * 采集来源：
 * - Prometheus 指标（HTTP 响应时间、错误率、吞吐量）
 * - 服务健康状态（来自 health check）
 * - 日志异常事件（来自 REQ-00480）
 * - 资源使用率（CPU、内存、连接池）
 */
class MonitorDataCollector {
  constructor(config) {
    this.prometheusClient = config.prometheusClient;
    this.healthClient = config.healthClient;
    this.errorAnalysisClient = config.errorAnalysisClient;
    this.services = config.services || [
      'gateway', 'user-service', 'location-service',
      'pokemon-service', 'catch-service', 'gym-service',
      'social-service', 'reward-service', 'payment-service'
    ];
  }

  /**
   * 采集指定时间范围的监控数据
   * @param {Object} timeRange - { start, end }
   * @returns {Object} 监控数据
   */
  async collect(timeRange) {
    const data = {
      metrics: await this._collectMetrics(timeRange),
      health: await this._collectHealth(timeRange),
      errors: await this._collectErrors(timeRange),
      resources: await this._collectResources(timeRange)
    };

    return this._aggregate(data);
  }

  /**
   * 采集 Prometheus 指标
   */
  async _collectMetrics(timeRange) {
    const metrics = {};
    
    for (const service of this.services) {
      // HTTP 响应时间（P50/P95/P99）
      metrics[service] = {
        latencyP50: await this._queryPrometheus(
          `minego_http_request_duration_ms{service="${service}"}`,
          timeRange, 'percentile(50)'
        ),
        latencyP95: await this._queryPrometheus(
          `minego_http_request_duration_ms{service="${service}"}`,
          timeRange, 'percentile(95)'
        ),
        errorRate: await this._queryPrometheus(
          `minego_http_requests_total{service="${service}",status=~"5.."}`,
          timeRange, 'rate'
        ),
        throughput: await this._queryPrometheus(
          `minego_http_requests_total{service="${service}"}`,
          timeRange, 'rate'
        )
      };
    }

    return metrics;
  }
}
```

### 4.2 智能摘要生成引擎（SummaryGenerator）

**核心类：`backend/shared/monitorReport/SummaryGenerator.js`**

```javascript
/**
 * 智能摘要生成引擎
 * 
 * 摘要内容：
 * - 系统健康评分（0-100）
 * - 关键指标变化（与前一时间窗口对比）
 * - 异常事件列表（自动筛选）
 * - 服务健康排名
 * - 建议行动项
 */
class SummaryGenerator {
  constructor(config) {
    this.healthScoreCalculator = new HealthScoreCalculator(config);
    this.changeDetector = new ChangeDetector(config);
    this.eventFilter = new EventFilter(config);
  }

  /**
   * 生成摘要
   * @param {Object} currentData - 当前监控数据
   * @param {Object} baselineData - 基线数据（用于对比）
   * @returns {Object} 摘要对象
   */
  async generate(currentData, baselineData) {
    // 1. 计算系统健康评分
    const healthScore = await this.healthScoreCalculator.calculate(currentData);

    // 2. 检测关键变化
    const changes = await this.changeDetector.detect(currentData, baselineData);

    // 3. 筛选异常事件
    const significantEvents = await this.eventFilter.filter(currentData.errors);

    // 4. 服务健康排名
    const serviceRanking = this._rankServices(currentData);

    // 5. 生成建议行动项
    const actionItems = this._generateActionItems(healthScore, changes, significantEvents);

    return {
      generatedAt: new Date().toISOString(),
      healthScore,
      changes,
      significantEvents,
      serviceRanking,
      actionItems,
      period: currentData.period
    };
  }
}

/**
 * 系统健康评分计算器
 * 
 * 评分维度：
 * - 服务可用性（权重 30%）
 * - 响应时间达标率（权重 25%）
 * - 错误率（权重 20%）
 * - 资源利用率（权重 15%）
 * - 依赖健康度（权重 10%）
 */
class HealthScoreCalculator {
  calculate(data) {
    const scores = {
      availability: this._calcAvailability(data.health),
      latency: this._calcLatencyScore(data.metrics),
      errorRate: this._calcErrorScore(data.metrics),
      resource: this._calcResourceScore(data.resources),
      dependency: this._calcDependencyScore(data.health)
    };

    return {
      total: scores.availability * 0.3 + 
             scores.latency * 0.25 + 
             scores.errorRate * 0.2 + 
             scores.resource * 0.15 + 
             scores.dependency * 0.1,
      breakdown: scores
    };
  }
}
```

### 4.3 变化检测器（ChangeDetector）

**核心类：`backend/shared/monitorReport/ChangeDetector.js`**

```javascript
/**
 * 变化检测器
 * 
 * 检测类型：
 * - 显著变化（超过阈值）
 * - 趋势变化（持续上升/下降）
 * - 异常波动（突然跳变）
 */
class ChangeDetector {
  constructor(config) {
    this.thresholds = {
      latencyChange: 0.2,     // 20% 以上变化
      errorRateChange: 0.3,   // 30% 以上变化
      throughputChange: 0.25  // 25% 以上变化
    };
  }

  /**
   * 检测变化
   * @param {Object} current - 当前数据
   * @param {Object} baseline - 基线数据
   * @returns {Array} 变化列表
   */
  detect(current, baseline) {
    const changes = [];

    for (const [service, metrics] of Object.entries(current.metrics)) {
      const baselineMetrics = baseline.metrics[service];

      // 响应时间变化
      const latencyChange = this._calcChange(
        metrics.latencyP95,
        baselineMetrics.latencyP95
      );
      if (Math.abs(latencyChange) > this.thresholds.latencyChange) {
        changes.push({
          type: 'latency',
          service,
          direction: latencyChange > 0 ? 'increase' : 'decrease',
          magnitude: Math.abs(latencyChange),
          current: metrics.latencyP95,
          baseline: baselineMetrics.latencyP95,
          severity: this._calcSeverity(latencyChange)
        });
      }

      // 错误率变化
      const errorChange = this._calcChange(
        metrics.errorRate,
        baselineMetrics.errorRate
      );
      if (Math.abs(errorChange) > this.thresholds.errorRateChange) {
        changes.push({
          type: 'error_rate',
          service,
          direction: errorChange > 0 ? 'increase' : 'decrease',
          magnitude: Math.abs(errorChange),
          severity: this._calcSeverity(errorChange)
        });
      }
    }

    return changes.sort((a, b) => b.severity - a.severity);
  }
}
```

### 4.4 报告模板管理器（ReportTemplateManager）

**核心类：`backend/shared/monitorReport/ReportTemplateManager.js`**

```javascript
/**
 * 报告模板管理器
 * 
 * 模板类型：
 * - daily_summary：每日摘要（简洁版）
 * - weekly_report：每周深度报告（详细版）
 * - incident_report：紧急事件报告
 * - custom：自定义模板
 */
class ReportTemplateManager {
  constructor() {
    this.templates = {
      daily_summary: {
        format: 'markdown',
        sections: [
          'header',
          'health_score',
          'key_changes',
          'top_events',
          'service_status',
          'action_items'
        ],
        maxLength: 2000  // 字符数限制
      },
      weekly_report: {
        format: 'html',
        sections: [
          'header',
          'weekly_summary',
          'health_trend',
          'service_analysis',
          'incident_review',
          'performance_metrics',
          'recommendations',
          'next_week_focus'
        ],
        attachments: ['charts', 'tables']
      },
      incident_report: {
        format: 'markdown',
        sections: [
          'header',
          'incident_summary',
          'timeline',
          'impact_analysis',
          'root_cause',
          'resolution',
          'lessons_learned'
        ]
      }
    };
  }

  /**
   * 渲染报告
   * @param {string} templateType - 模板类型
   * @param {Object} data - 报告数据
   * @returns {string} 渲染后的报告
   */
  render(templateType, data) {
    const template = this.templates[templateType];
    return this._renderSections(template.sections, data, template.format);
  }

  /**
   * 创建自定义模板
   * @param {Object} templateConfig - 模板配置
   * @returns {string} 模板ID
   */
  async createCustomTemplate(templateConfig) {
    // 支持用户自定义报告内容和格式
  }
}
```

### 4.5 报告发送系统（ReportSender）

**核心类：`backend/shared/monitorReport/ReportSender.js`**

```javascript
/**
 * 报告发送系统
 * 
 * 发送渠道：
 * - Email（SMTP）
 * - Slack（Webhook）
 * - 钉钉（Webhook）
 * - 企业微信（Webhook）
 */
class ReportSender {
  constructor(config) {
    this.channels = {
      email: new EmailSender(config.email),
      slack: new SlackSender(config.slack),
      dingtalk: new DingtalkSender(config.dingtalk),
      wework: new WeworkSender(config.wework)
    };
  }

  /**
   * 发送报告
   * @param {Object} report - 报告对象
   * @param {Array} targetChannels - 目标渠道列表
   * @returns {Object} 发送结果
   */
  async send(report, targetChannels) {
    const results = [];

    for (const channel of targetChannels) {
      const sender = this.channels[channel];
      if (!sender) continue;

      try {
        const result = await sender.send(report);
        results.push({ channel, success: true, result });
      } catch (error) {
        results.push({ channel, success: false, error: error.message });
      }
    }

    return results;
  }
}
```

### 4.6 智能洞察引擎（InsightEngine）

**核心类：`backend/shared/monitorReport/InsightEngine.js`**

```javascript
/**
 * 智能洞察引擎
 * 
 * 洞察类型：
 * - 趋势洞察（持续上升/下降趋势）
 * - 异常模式洞察（周期性异常、突发异常）
 * - 预测洞察（预测未来趋势）
 * - 建议洞察（改进建议）
 */
class InsightEngine {
  constructor(config) {
    this.historyDays = config.historyDays || 30;
    this.predictionHorizon = config.predictionHorizon || 7;
  }

  /**
   * 生成洞察
   * @param {Object} currentData - 当前数据
   * @param {Array} historyData - 历史数据列表
   * @returns {Array} 洞察列表
   */
  async generateInsights(currentData, historyData) {
    const insights = [];

    // 1. 趋势洞察
    const trends = this._detectTrends(historyData);
    insights.push(...trends);

    // 2. 异常模式洞察
    const patterns = this._detectPatterns(historyData);
    insights.push(...patterns);

    // 3. 预测洞察
    const predictions = this._generatePredictions(historyData);
    insights.push(...predictions);

    // 4. 建议洞察
    const recommendations = this._generateRecommendations(currentData, insights);
    insights.push(...recommendations);

    return insights.sort((a, b) => b.importance - a.importance);
  }

  /**
   * 检测趋势
   */
  _detectTrends(historyData) {
    // 使用线性回归检测持续上升/下降趋势
    const insights = [];
    
    for (const metric of ['errorRate', 'latencyP95', 'throughput']) {
      const values = historyData.map(d => d.metrics[metric]);
      const trend = this._linearRegression(values);
      
      if (trend.slope > 0.05) {
        insights.push({
          type: 'trend',
          metric,
          direction: 'increasing',
          slope: trend.slope,
          importance: this._calcImportance(trend),
          message: `${metric} 持续上升，过去 ${this.historyDays} 天增加 ${(trend.slope * this.historyDays * 100).toFixed(1)}%`
        });
      }
    }

    return insights;
  }
}
```

### 4.7 定时报告任务

**任务：`backend/jobs/monitorReportJobs.js`**

```javascript
/**
 * 监控报告定时任务
 * 
 * 任务类型：
 * - daily-summary：每日 9:00 发送摘要
 * - weekly-report：每周一 10:00 发送周报
 * - real-time-alert：紧急事件实时报告
 */
class MonitorReportJobs {
  // 每日摘要任务（cron: 0 9 * * *)
  async dailySummary() {
    const collector = new MonitorDataCollector(config);
    const generator = new SummaryGenerator(config);

    // 采集过去 24 小时数据
    const currentData = await collector.collect({ 
      start: new Date(Date.now() - 24 * 3600 * 1000),
      end: new Date()
    });

    // 采集基线数据（前一天）
    const baselineData = await collector.collect({
      start: new Date(Date.now() - 48 * 3600 * 1000),
      end: new Date(Date.now() - 24 * 3600 * 1000)
    });

    // 生成摘要
    const summary = await generator.generate(currentData, baselineData);

    // 渲染报告
    const report = ReportTemplateManager.render('daily_summary', summary);

    // 发送
    await ReportSender.send(report, ['slack', 'email']);
  }

  // 每周报告任务（cron: 0 10 * * 1）
  async weeklyReport() {
    // 生成更详细的周报，包含趋势分析和预测
  }
}
```

### 4.8 数据库设计

**迁移文件：`database/migrations/YYYYMMDDHHMMSS-create-monitor-report-tables.js`**

```sql
-- 报告历史表
CREATE TABLE monitor_reports (
  id VARCHAR(36) PRIMARY KEY,
  report_type VARCHAR(32) NOT NULL,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  health_score DECIMAL(5,2),
  summary JSONB NOT NULL,
  insights JSONB,
  changes JSONB,
  events JSONB,
  format VARCHAR(16) DEFAULT 'markdown',
  content TEXT NOT NULL,
  sent_channels JSONB,
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_monitor_reports_type ON monitor_reports(report_type);
CREATE INDEX idx_monitor_reports_period ON monitor_reports(period_start, period_end);
CREATE INDEX idx_monitor_reports_created ON monitor_reports(created_at);

-- 报告模板表
CREATE TABLE report_templates (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(32) NOT NULL,
  format VARCHAR(16) NOT NULL,
  sections JSONB NOT NULL,
  config JSONB,
  created_by VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 报告订阅表
CREATE TABLE report_subscriptions (
  id VARCHAR(36) PRIMARY KEY,
  report_type VARCHAR(32) NOT NULL,
  channel VARCHAR(32) NOT NULL,
  recipients JSONB NOT NULL,
  schedule VARCHAR(64) NOT NULL,  -- cron 表达式
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 监控快照表（用于历史对比）
CREATE TABLE monitor_snapshots (
  id VARCHAR(36) PRIMARY KEY,
  snapshot_type VARCHAR(32) NOT NULL,
  snapshot_time TIMESTAMP NOT NULL,
  metrics JSONB NOT NULL,
  health JSONB,
  errors JSONB,
  resources JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_monitor_snapshots_time ON monitor_snapshots(snapshot_time);
CREATE INDEX idx_monitor_snapshots_type ON monitor_snapshots(snapshot_type);
```

### 4.9 API 端点

**网关路由：`gateway/src/routes/monitorReport.js`**

```javascript
/**
 * 监控报告 API
 * 
 * GET /api/monitor-report/reports
 * - 获取历史报告列表
 * - 参数：type, startDate, endDate, limit
 * 
 * GET /api/monitor-report/reports/:id
 * - 获取报告详情
 * 
 * POST /api/monitor-report/generate
 * - 手动生成报告
 * - 参数：type, period, channels
 * 
 * GET /api/monitor-report/templates
 * - 获取报告模板列表
 * 
 * POST /api/monitor-report/templates
 * - 创建自定义模板
 * 
 * GET /api/monitor-report/subscriptions
 * - 获取订阅列表
 * 
 * PUT /api/monitor-report/subscriptions/:id
 * - 更新订阅配置
 * 
 * GET /api/monitor-report/summary/current
 * - 获取当前系统摘要（实时）
 * 
 * GET /api/monitor-report/insights
 * - 获取智能洞察
 * - 参数：service, metric, days
 */
```

## 5. 验收标准（可测试）

- [ ] 每日摘要报告自动生成成功率 ≥ 99%
- [ ] 系统健康评分计算准确率 ≥ 90%（与人工评估对比）
- [ ] 关键变化检测召回率 ≥ 85%，误报率 < 10%
- [ ] 报告生成时间 < 30 秒（从数据采集到报告输出）
- [ ] 报告发送成功率 ≥ 98%（多渠道）
- [ ] 智能洞察准确率 ≥ 70%（预测与实际对比）
- [ ] 历史报告存储完整率 100%（支持 90 天回溯）
- [ ] 自定义模板支持 ≥ 3 种格式（Markdown/HTML/JSON）
- [ ] API 响应时间 < 500ms（P95）
- [ ] 单元测试覆盖率 ≥ 85%

## 6. 工作量估算

**估算：L（预计 5-6 人天）**

**理由**：
- 涉及数据采集、摘要生成、报告渲染、定时任务等多个模块
- 需集成 Prometheus API、现有监控系统
- 多渠道发送系统实现较复杂
- 数据库设计中等复杂度

**分解**：
- 监控数据采集器：1 人天
- 智能摘要生成引擎：1 人天
- 变化检测与洞察引擎：1 人天
- 报告模板与发送系统：1 人天
- 定时任务与 API：1 人天
- 数据库与测试：1 人天

## 7. 优先级理由

**P1 - 高优先级**

**理由**：
1. **运维效率提升**：减少运维人员每日查看监控时间，提升运维效率
2. **生产必需**：自动化报告是成熟系统的标配功能
3. **信息整合**：将分散的监控信息整合为可读性强的摘要
4. **成熟度提升**：提升可观测性维度成熟度评分

**对"项目可用"的贡献**：
- 运维效率提升 50%+
- 可观测性维度成熟度 +2 分
- 支持 SRE 团队日常工作