# REQ-00312：数据库容量规划与智能预警系统

- **编号**：REQ-00312
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared、所有微服务、PostgreSQL、infrastructure/k8s、admin-dashboard、backend/jobs
- **创建时间**：2026-06-24 06:00
- **依赖需求**：REQ-00005（Prometheus 告警规则）、REQ-00040（云成本监控与预算告警）

## 1. 背景与问题

mineGo 项目采用 PostgreSQL 作为主数据库，随着用户增长和业务扩展，数据库存储需求持续增长。当前存在以下问题：

### 1.1 容量规划缺失
- **被动响应**：存储空间不足时才发现，影响业务连续性
- **无增长预测**：无法预测数据库增长趋势，难以提前规划扩容
- **缺乏容量基线**：没有明确的数据库容量指标和阈值

### 1.2 预警机制不完善
- **预警滞后**：磁盘空间告警阈值设置过高，告警时已影响业务
- **无分级预警**：缺乏多级预警机制（注意/警告/紧急）
- **预警粒度粗**：只监控整体磁盘空间，未细化到表/索引级别

### 1.3 成本优化困难
- **资源浪费**：无法识别历史数据占比，无法制定归档策略
- **扩容盲目**：扩容决策缺乏数据支撑，可能过度或不足
- **无成本分摊**：无法量化各业务模块的存储成本

### 1.4 运维效率低
- **人工巡检**：定期手动检查数据库大小，效率低且易遗漏
- **报表缺失**：缺乏数据库容量趋势报表，管理层难以决策
- **多实例管理难**：9 个微服务对应多个数据库实例，管理分散

## 2. 目标

建立完整的数据库容量规划与智能预警系统，实现：

1. **自动容量监控**：实时监控数据库、表、索引的存储使用情况
2. **智能增长预测**：基于历史数据预测未来 30/60/90 天的存储需求
3. **多级预警机制**：建立四级预警（正常/注意/警告/紧急），提前预警容量风险
4. **容量优化建议**：自动识别可优化的表/索引，提供清理/归档建议
5. **成本分析与分摊**：量化各业务模块存储成本，支持成本优化决策

**预期收益**：
- 存储容量预测准确率 ≥ 85%
- 预警提前量 ≥ 7 天
- 减少 70% 的存储紧急扩容事件
- 降低存储成本 20%

## 3. 范围

### 包含
- 数据库容量数据采集器（采集表大小、索引大小、增长趋势）
- 容量预测引擎（基于时间序列预测未来存储需求）
- 多级预警系统（四级预警 + 通知渠道）
- 容量优化建议生成器（识别大表、膨胀索引、可归档数据）
- 容量报表与可视化（Dashboard + 定期报表）
- 存储成本分析器（按服务/表量化存储成本）

### 不包含
- 数据库实际扩容操作（由运维手动执行）
- 数据归档执行（由 REQ-00186 负责）
- 数据库性能优化（由 REQ-00063 负责）

## 4. 详细需求

### 4.1 容量数据采集

```javascript
// backend/shared/capacity/CapacityCollector.js
class CapacityCollector {
  constructor() {
    this.metrics = {
      dbSize: new Gauge({
        name: 'minego_db_size_bytes',
        help: 'Database size in bytes',
        labelNames: ['database', 'service']
      }),
      tableSize: new Gauge({
        name: 'minego_table_size_bytes',
        help: 'Table size in bytes',
        labelNames: ['database', 'schema', 'table']
      }),
      indexSize: new Gauge({
        name: 'minego_index_size_bytes',
        help: 'Index size in bytes',
        labelNames: ['database', 'table', 'index']
      }),
      tableRowCount: new Gauge({
        name: 'minego_table_row_count',
        help: 'Number of rows in table',
        labelNames: ['database', 'table']
      }),
      bloatRatio: new Gauge({
        name: 'minego_table_bloat_ratio',
        help: 'Table bloat ratio (dead tuples / total)',
        labelNames: ['database', 'table']
      })
    };
  }

  async collectDatabaseStats(pool, database) {
    // 采集数据库大小
    const dbSizeResult = await pool.query(`
      SELECT pg_database_size($1) as size
    `, [database]);
    
    // 采集表大小和行数
    const tableStatsResult = await pool.query(`
      SELECT 
        schemaname,
        tablename,
        pg_total_relation_size(schemaname || '.' || tablename) as total_size,
        pg_relation_size(schemaname || '.' || tablename) as table_size,
        pg_indexes_size(schemaname || '.' || tablename) as index_size,
        n_live_tup as row_count,
        n_dead_tup as dead_tup
      FROM pg_stat_user_tables
      ORDER BY total_size DESC
      LIMIT 50
    `);
    
    // 采集膨胀率
    const bloatResult = await pool.query(`
      SELECT 
        schemaname || '.' || tablename as table,
        CASE WHEN n_live_tup > 0 
          THEN n_dead_tup::float / (n_live_tup + n_dead_tup)
          ELSE 0 
        END as bloat_ratio
      FROM pg_stat_user_tables
      WHERE n_dead_tup > 1000
      ORDER BY bloat_ratio DESC
    `);
    
    return { dbSize, tableStats, bloatStats };
  }
}
```

### 4.2 容量预测引擎

```javascript
// backend/shared/capacity/CapacityPredictor.js
class CapacityPredictor {
  constructor() {
    this.historyDays = 90;  // 使用 90 天历史数据
    this.predictDays = [7, 30, 60, 90];  // 预测未来 7/30/60/90 天
  }

  // 线性回归预测
  linearRegression(data) {
    const n = data.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += data[i];
      sumXY += i * data[i];
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return { slope, intercept };
  }

  // Holt-Winters 指数平滑（考虑季节性）
  holtWinters(data, alpha = 0.3, beta = 0.1, gamma = 0.1, seasonLength = 7) {
    // 实现带季节性的指数平滑预测
    // ...
  }

  async predictCapacity(historyData) {
    const predictions = {};
    
    for (const days of this.predictDays) {
      // 使用多种算法预测
      const linearPred = this.linearExtrapolate(historyData, days);
      const hwPred = this.holtWinters(historyData, days);
      
      // 取加权平均
      predictions[days] = {
        linear: linearPred,
        holtWinters: hwPred,
        recommended: 0.6 * hwPred + 0.4 * linearPred,
        confidence: this.calculateConfidence(historyData, days)
      };
    }
    
    return predictions;
  }

  // 计算预测置信度
  calculateConfidence(data, days) {
    // 基于历史波动性计算预测置信度
    const volatility = this.calculateVolatility(data);
    const confidence = Math.max(0.5, 1 - (volatility * days / 30));
    return Math.min(confidence, 0.95);
  }
}
```

### 4.3 多级预警系统

```javascript
// backend/shared/capacity/CapacityAlerter.js
class CapacityAlerter {
  constructor() {
    this.thresholds = {
      normal: 0.50,    // < 50% 使用率
      notice: 0.70,    // 50-70% 使用率
      warning: 0.85,   // 70-85% 使用率
      critical: 0.95   // > 85% 使用率
    };
    
    this.alertChannels = {
      notice: ['slack'],
      warning: ['slack', 'email'],
      critical: ['slack', 'email', 'sms', 'pagerduty']
    };
  }

  async evaluateAlerts(currentUsage, predictions, config) {
    const alerts = [];
    const totalCapacity = config.totalCapacity;
    
    // 当前使用率预警
    const currentRate = currentUsage / totalCapacity;
    const currentLevel = this.getAlertLevel(currentRate);
    
    if (currentLevel !== 'normal') {
      alerts.push({
        type: 'current_usage',
        level: currentLevel,
        message: `当前数据库使用率 ${(currentRate * 100).toFixed(1)}%`,
        recommendation: this.getRecommendation(currentLevel, 'current')
      });
    }
    
    // 预测预警
    for (const [days, prediction] of Object.entries(predictions)) {
      const predictedRate = prediction.recommended / totalCapacity;
      const predictedLevel = this.getAlertLevel(predictedRate);
      
      if (predictedLevel !== 'normal') {
        alerts.push({
          type: 'predicted_usage',
          level: predictedLevel,
          days: parseInt(days),
          message: `预计 ${days} 天后使用率达 ${(predictedRate * 100).toFixed(1)}%`,
          confidence: prediction.confidence,
          recommendation: this.getRecommendation(predictedLevel, 'predicted', days)
        });
      }
    }
    
    return alerts;
  }

  getAlertLevel(rate) {
    if (rate >= this.thresholds.critical) return 'critical';
    if (rate >= this.thresholds.warning) return 'warning';
    if (rate >= this.thresholds.notice) return 'notice';
    return 'normal';
  }

  getRecommendation(level, type, days = null) {
    const recommendations = {
      notice: {
        current: '建议评估数据归档策略，清理历史数据',
        predicted: `建议在 ${days} 天内规划扩容或数据归档`
      },
      warning: {
        current: '需要立即制定数据清理或扩容计划',
        predicted: `需要在 ${days} 天内完成扩容或数据迁移`
      },
      critical: {
        current: '紧急！需要立即扩容或停止非关键写入',
        predicted: `紧急！预计 ${days} 天内达到容量上限`
      }
    };
    return recommendations[level]?.[type] || '';
  }
}
```

### 4.4 容量优化建议

```javascript
// backend/shared/capacity/OptimizationAdvisor.js
class OptimizationAdvisor {
  async analyzeOptimizationOpportunities(dbStats) {
    const recommendations = [];
    
    // 1. 识别大表
    const largeTables = dbStats.tableStats
      .filter(t => t.total_size > 1024 * 1024 * 1024) // > 1GB
      .sort((a, b) => b.total_size - a.total_size)
      .slice(0, 10);
    
    for (const table of largeTables) {
      recommendations.push({
        type: 'large_table',
        table: table.tablename,
        size: table.total_size,
        suggestion: `考虑对 ${table.tablename} 表进行分区或归档`,
        potentialSavings: table.total_size * 0.3
      });
    }
    
    // 2. 识别膨胀严重的表
    const bloatedTables = dbStats.tableStats
      .filter(t => t.bloat_ratio > 0.2);
    
    for (const table of bloatedTables) {
      recommendations.push({
        type: 'table_bloat',
        table: table.tablename,
        bloatRatio: table.bloat_ratio,
        suggestion: `执行 VACUUM FULL 或 pg_repack 回收空间`,
        potentialSavings: table.total_size * table.bloat_ratio
      });
    }
    
    // 3. 识别未使用索引
    const unusedIndexes = await this.findUnusedIndexes(dbStats);
    
    for (const idx of unusedIndexes) {
      recommendations.push({
        type: 'unused_index',
        index: idx.indexname,
        table: idx.tablename,
        size: idx.index_size,
        suggestion: `考虑删除未使用的索引 ${idx.indexname}`,
        potentialSavings: idx.index_size
      });
    }
    
    // 4. 识别可归档数据
    const archiveCandidates = await this.findArchiveCandidates(dbStats);
    
    for (const table of archiveCandidates) {
      recommendations.push({
        type: 'archive_candidate',
        table: table.tablename,
        oldRowCount: table.old_row_count,
        suggestion: `表 ${table.tablename} 有 ${table.old_row_count} 行超过 90 天的数据可归档`,
        potentialSavings: table.old_row_size
      });
    }
    
    // 汇总优化潜力
    const totalPotentialSavings = recommendations
      .reduce((sum, r) => sum + (r.potentialSavings || 0), 0);
    
    return {
      recommendations,
      summary: {
        totalRecommendations: recommendations.length,
        totalPotentialSavings,
        savingsPercent: (totalPotentialSavings / dbStats.dbSize) * 100
      }
    };
  }

  async findUnusedIndexes(dbStats) {
    // 查询索引扫描次数为 0 的索引
    const result = await dbStats.pool.query(`
      SELECT
        schemaname,
        tablename,
        indexname,
        pg_relation_size(indexrelid) as index_size
      FROM pg_stat_user_indexes
      WHERE idx_scan = 0
        AND indexrelname NOT LIKE '%_pkey'
        AND pg_relation_size(indexrelid) > 1024 * 1024
      ORDER BY index_size DESC
      LIMIT 20
    `);
    return result.rows;
  }
}
```

### 4.5 定时任务与报表

```javascript
// backend/jobs/capacity-monitor.js
const cron = require('node-cron');
const CapacityCollector = require('../shared/capacity/CapacityCollector');
const CapacityPredictor = require('../shared/capacity/CapacityPredictor');
const CapacityAlerter = require('../shared/capacity/CapacityAlerter');
const OptimizationAdvisor = require('../shared/capacity/OptimizationAdvisor');

// 每小时采集一次容量数据
cron.schedule('0 * * * *', async () => {
  const collector = new CapacityCollector();
  const predictor = new CapacityPredictor();
  const alerter = new CapacityAlerter();
  
  for (const service of services) {
    const pool = getPool(service);
    const currentStats = await collector.collectDatabaseStats(pool, service.database);
    
    // 保存历史数据
    await saveCapacityHistory(service.name, currentStats);
    
    // 加载历史数据进行预测
    const history = await loadCapacityHistory(service.name, 90);
    const predictions = await predictor.predictCapacity(history);
    
    // 评估预警
    const alerts = await alerter.evaluateAlerts(
      currentStats.dbSize,
      predictions,
      service.capacityConfig
    );
    
    // 发送预警
    for (const alert of alerts) {
      await sendAlert(alert, service);
    }
  }
});

// 每日生成容量报表
cron.schedule('0 8 * * *', async () => {
  const advisor = new OptimizationAdvisor();
  
  for (const service of services) {
    const stats = await collectFullStats(service);
    const optimization = await advisor.analyzeOptimizationOpportunities(stats);
    
    // 生成报表
    const report = {
      date: new Date().toISOString(),
      service: service.name,
      currentUsage: stats.dbSize,
      predictions: stats.predictions,
      recommendations: optimization.recommendations,
      potentialSavings: optimization.summary.totalPotentialSavings
    };
    
    // 发送邮件报表
    await sendCapacityReport(report);
    
    // 保存报表历史
    await saveReportHistory(report);
  }
});
```

### 4.6 Admin Dashboard 集成

```html
<!-- admin-dashboard/capacity.html -->
<div class="capacity-dashboard">
  <h1>数据库容量监控</h1>
  
  <!-- 总览卡片 -->
  <div class="capacity-overview">
    <div class="card" v-for="db in databases">
      <h3>{{ db.name }}</h3>
      <div class="usage-bar">
        <div class="used" :style="{ width: db.usagePercent + '%' }"></div>
      </div>
      <p>{{ db.usedSize | formatSize }} / {{ db.totalSize | formatSize }}</p>
      <p class="prediction" v-if="db.predictions">
        预计 {{ db.predictions.daysToFull }} 天后满
      </p>
    </div>
  </div>
  
  <!-- 趋势图表 -->
  <div class="capacity-trend">
    <canvas id="trendChart"></canvas>
  </div>
  
  <!-- 优化建议 -->
  <div class="optimization-recommendations">
    <h2>优化建议</h2>
    <table>
      <thead>
        <tr>
          <th>类型</th>
          <th>对象</th>
          <th>建议</th>
          <th>预计节省</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="rec in recommendations">
          <td>{{ rec.type }}</td>
          <td>{{ rec.table || rec.index }}</td>
          <td>{{ rec.suggestion }}</td>
          <td>{{ rec.potentialSavings | formatSize }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>
```

## 5. 验收标准

- [ ] 容量数据采集器完成，支持采集数据库/表/索引大小
- [ ] 容量预测引擎完成，支持 7/30/60/90 天预测
- [ ] 多级预警系统完成，支持四级预警和多种通知渠道
- [ ] 优化建议生成器完成，能识别大表/膨胀表/未使用索引
- [ ] 定时采集任务完成，每小时采集一次
- [ ] 每日容量报表自动生成并发送
- [ ] Admin Dashboard 集成容量监控页面
- [ ] 预测准确率测试通过（≥ 85%）
- [ ] 预警提前量测试通过（≥ 7 天）
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**L（Large）**

理由：
- 涉及多个新模块开发（采集器、预测引擎、预警系统、优化建议器）
- 需要与 9 个微服务集成
- 需要实现预测算法（线性回归、Holt-Winters）
- 需要开发 Dashboard 页面
- 需要充分测试预测准确性

预计工期：5-7 个工作日

## 7. 优先级理由

**P1 理由**：

1. **业务连续性保障**：数据库容量耗尽会导致服务不可用，影响所有用户
2. **生产环境风险**：当前缺乏容量预警，存在生产事故风险
3. **成本优化潜力大**：通过优化建议可降低存储成本 20%
4. **运维效率提升**：自动化监控替代人工巡检，效率提升 90%
5. **成熟度评分贡献**：完善"稳定性与高可用"维度（权重 15%）

此需求是生产环境稳定运行的重要保障，应优先实现。
