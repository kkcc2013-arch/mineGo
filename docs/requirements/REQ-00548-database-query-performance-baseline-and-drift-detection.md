# REQ-00548：数据库查询性能基线与漂移检测系统

- **编号**：REQ-00548
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：database, backend/shared, infrastructure/monitoring
- **创建时间**：2026-07-14 07:51
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 数据库层存在以下性能管理问题：

1. **缺乏性能基线**：PostgreSQL 查询性能没有建立明确的基线指标，难以判断性能是否正常退化
2. **无性能漂移告警**：慢查询日志虽然存在，但缺乏智能化的性能漂移检测，无法主动发现性能退化
3. **索引效率不可见**：索引使用率、索引膨胀情况没有监控，可能导致查询性能悄然下降
4. **数据库统计信息缺失**：缺少系统化的 pg_stat_statements 分析，无法量化查询性能变化
5. **运维决策数据不足**：DBA 缺乏足够的历史数据支撑索引优化、表分区调整等决策

随着用户量和数据量增长，数据库性能退化可能导致游戏体验下降，需要建立系统化的性能基线与漂移检测机制。

## 2. 目标

为 mineGo 建立完整的数据库性能基线与漂移检测体系：

1. **性能基线建立**：自动采集关键查询的执行时间基线，支持历史趋势对比
2. **智能漂移检测**：基于统计模型检测查询性能异常漂移，自动触发告警
3. **索引健康监控**：监控索引使用率、索引膨胀率，提供优化建议
4. **pg_stat_statements 集成**：实时采集并分析 PostgreSQL 统计信息
5. **运维决策支撑**：提供可视化的性能仪表板和优化建议报告

## 3. 范围

### 包含
- PostgreSQL pg_stat_statements 扩展集成
- 关键查询性能基线自动采集脚本
- 性能漂移检测算法实现
- 索引健康检查工具
- Prometheus 指标导出
- Grafana 性能仪表板
- 定期性能报告生成

### 不包含
- 自动索引创建/删除（仅提供建议）
- 数据库硬件层面的性能调优
- 其他数据库类型支持（如 MongoDB）
- APM 全链路追踪（由其他需求覆盖）

## 4. 详细需求

### 4.1 pg_stat_statements 集成

#### 4.1.1 启用扩展
```sql
-- database/migrations/0050_enable_pg_stat_statements.sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 重置统计信息（可选，用于建立新基线）
SELECT pg_stat_statements_reset();
```

#### 4.1.2 查询统计采集
```javascript
// backend/shared/db-monitor/QueryStatsCollector.js
class QueryStatsCollector {
  constructor(pgClient) {
    this.pgClient = pgClient;
    this.baseline = new Map(); // queryid -> baseline stats
    this.historyInterval = '7d'; // 基线周期
  }

  async collectStats() {
    const { rows } = await this.pgClient.query(`
      SELECT 
        queryid,
        query,
        calls,
        total_exec_time,
        mean_exec_time,
        min_exec_time,
        max_exec_time,
        rows,
        shared_blks_hit,
        shared_blks_read
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY total_exec_time DESC
      LIMIT 1000
    `);

    return rows.map(row => ({
      queryId: row.queryid,
      queryFingerprint: this.fingerprintQuery(row.query),
      calls: row.calls,
      totalTimeMs: parseFloat(row.total_exec_time),
      meanTimeMs: parseFloat(row.mean_exec_time),
      minTimeMs: parseFloat(row.min_exec_time),
      maxTimeMs: parseFloat(row.max_exec_time),
      rows: row.rows,
      cacheHitRatio: row.shared_blks_hit / (row.shared_blks_hit + row.shared_blks_read + 1),
      timestamp: new Date()
    }));
  }

  fingerprintQuery(sql) {
    // 将参数替换为占位符，生成查询指纹
    return sql
      .replace(/\$\d+/g, '?')
      .replace(/\d+/g, '?')
      .replace(/'[^']*'/g, '?');
  }
}
```

### 4.2 性能基线管理

#### 4.2.1 基线数据结构
```sql
-- database/migrations/0051_create_query_baseline_table.sql
CREATE TABLE query_performance_baseline (
  id SERIAL PRIMARY KEY,
  query_fingerprint TEXT NOT NULL,
  queryid BIGINT,
  service_name VARCHAR(50),
  baseline_mean_time_ms NUMERIC(10,3),
  baseline_p95_time_ms NUMERIC(10,3),
  baseline_calls_per_hour INTEGER,
  sample_count INTEGER DEFAULT 1,
  first_seen_at TIMESTAMP DEFAULT NOW(),
  last_updated_at TIMESTAMP DEFAULT NOW(),
  is_critical BOOLEAN DEFAULT false,
  CONSTRAINT unique_query_fingerprint UNIQUE (query_fingerprint)
);

CREATE INDEX idx_baseline_service ON query_performance_baseline(service_name);
CREATE INDEX idx_baseline_critical ON query_performance_baseline(is_critical);
```

#### 4.2.2 基线更新逻辑
```javascript
// backend/shared/db-monitor/BaselineManager.js
class BaselineManager {
  constructor(db) {
    this.db = db;
    this.baselineWindowDays = 7;
    this.minSampleCount = 100; // 最少样本数才建立基线
  }

  async updateBaselines() {
    // 从最近7天的查询统计计算基线
    const { rows } = await this.db.query(`
      WITH recent_stats AS (
        SELECT 
          query_fingerprint,
          queryid,
          AVG(mean_time_ms) as baseline_mean,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY mean_time_ms) as baseline_p95,
          AVG(calls_per_hour) as avg_calls_per_hour,
          COUNT(*) as sample_count
        FROM query_stats_history
        WHERE collected_at > NOW() - INTERVAL '${this.baselineWindowDays} days'
        GROUP BY query_fingerprint, queryid
        HAVING COUNT(*) >= $1
      )
      INSERT INTO query_performance_baseline (
        query_fingerprint, queryid, baseline_mean_time_ms,
        baseline_p95_time_ms, baseline_calls_per_hour, sample_count
      )
      SELECT 
        query_fingerprint,
        queryid,
        baseline_mean,
        baseline_p95,
        avg_calls_per_hour::INTEGER,
        sample_count::INTEGER
      FROM recent_stats
      ON CONFLICT (query_fingerprint) DO UPDATE SET
        baseline_mean_time_ms = EXCLUDED.baseline_mean_time_ms,
        baseline_p95_time_ms = EXCLUDED.baseline_p95_time_ms,
        baseline_calls_per_hour = EXCLUDED.baseline_calls_per_hour,
        sample_count = EXCLUDED.sample_count,
        last_updated_at = NOW()
    `, [this.minSampleCount]);

    return rows;
  }
}
```

### 4.3 性能漂移检测

#### 4.3.1 漂移检测算法
```javascript
// backend/shared/db-monitor/DriftDetector.js
class DriftDetector {
  constructor(options = {}) {
    this.meanThreshold = 2.0;    // 平均时间超过基线2倍
    this.p95Threshold = 2.5;     // P95超过基线2.5倍
    this.callsThreshold = 3.0;   // 调用次数超过基线3倍
    this.zscoreThreshold = 3.0;  // Z-score阈值
  }

  detect(currentStats, baseline) {
    const alerts = [];

    for (const stat of currentStats) {
      const base = baseline.get(stat.queryFingerprint);
      if (!base) continue;

      // 平均执行时间漂移
      const meanRatio = stat.meanTimeMs / base.baseline_mean_time_ms;
      if (meanRatio > this.meanThreshold) {
        alerts.push({
          type: 'MEAN_TIME_DRIFT',
          queryFingerprint: stat.queryFingerprint,
          baseline: base.baseline_mean_time_ms,
          current: stat.meanTimeMs,
          ratio: meanRatio,
          severity: this.calculateSeverity(meanRatio)
        });
      }

      // P95执行时间漂移
      if (stat.meanTimeMs * 2 > base.baseline_p95_time_ms * this.p95Threshold) {
        alerts.push({
          type: 'P95_TIME_DRIFT',
          queryFingerprint: stat.queryFingerprint,
          baseline: base.baseline_p95_time_ms,
          current: stat.meanTimeMs * 2,
          severity: 'HIGH'
        });
      }

      // 调用频率异常（可能触发性能问题）
      const callsRatio = stat.callsPerHour / base.baseline_calls_per_hour;
      if (callsRatio > this.callsThreshold) {
        alerts.push({
          type: 'CALL_FREQUENCY_SPIKE',
          queryFingerprint: stat.queryFingerprint,
          baseline: base.baseline_calls_per_hour,
          current: stat.callsPerHour,
          ratio: callsRatio,
          severity: 'MEDIUM'
        });
      }
    }

    return alerts;
  }

  calculateSeverity(ratio) {
    if (ratio > 5) return 'CRITICAL';
    if (ratio > 3) return 'HIGH';
    if (ratio > 2) return 'MEDIUM';
    return 'LOW';
  }
}
```

### 4.4 索引健康检查

#### 4.4.1 索引使用率监控
```javascript
// backend/shared/db-monitor/IndexHealthChecker.js
class IndexHealthChecker {
  constructor(db) {
    this.db = db;
  }

  async checkIndexUsage() {
    const { rows } = await this.db.query(`
      SELECT
        schemaname,
        relname AS table_name,
        indexrelname AS index_name,
        idx_scan AS index_scans,
        idx_tup_read AS tuples_read,
        idx_tup_fetch AS tuples_fetched,
        pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
        CASE 
          WHEN idx_scan = 0 THEN 'UNUSED'
          WHEN idx_scan < 50 THEN 'LOW_USAGE'
          ELSE 'NORMAL'
        END AS usage_status
      FROM pg_stat_user_indexes
      ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC
    `);

    return rows;
  }

  async checkIndexBloat() {
    const { rows } = await this.db.query(`
      SELECT
        schemaname,
        relname AS table_name,
        indexrelname AS index_name,
        pg_size_pretty(pg_relation_size(indexrelid)) AS actual_size,
        pg_size_pretty(
          pg_relation_size(indexrelid) * 
          (1 - (idx_scan::FLOAT / GREATEST(idx_scan + 1, 1)))
        ) AS estimated_bloat
      FROM pg_stat_user_indexes
      WHERE pg_relation_size(indexrelid) > 1048576  -- > 1MB
      ORDER BY pg_relation_size(indexrelid) DESC
    `);

    return rows;
  }
}
```

### 4.5 Prometheus 指标导出

#### 4.5.1 指标定义
```javascript
// backend/shared/db-monitor/MetricsExporter.js
const { Registry, Gauge, Histogram } = require('prom-client');

class DBMetricsExporter {
  constructor() {
    this.registry = new Registry();

    // 查询执行时间 Gauge
    this.queryTimeGauge = new Gauge({
      name: 'pg_query_mean_time_ms',
      help: 'Mean execution time of query in milliseconds',
      labelNames: ['query_fingerprint', 'service'],
      registers: [this.registry]
    });

    // 查询调用次数 Histogram
    this.queryCallsHistogram = new Histogram({
      name: 'pg_query_calls_total',
      help: 'Total calls of query',
      labelNames: ['query_fingerprint', 'service'],
      buckets: [1, 10, 100, 1000, 10000],
      registers: [this.registry]
    });

    // 缓存命中率 Gauge
    this.cacheHitGauge = new Gauge({
      name: 'pg_cache_hit_ratio',
      help: 'Buffer cache hit ratio',
      labelNames: ['query_fingerprint'],
      registers: [this.registry]
    });

    // 索引使用率
    this.indexUsageGauge = new Gauge({
      name: 'pg_index_scans_total',
      help: 'Number of index scans',
      labelNames: ['table', 'index'],
      registers: [this.registry]
    });
  }

  async export(stats) {
    for (const stat of stats) {
      this.queryTimeGauge
        .labels(stat.queryFingerprint, stat.serviceName)
        .set(stat.meanTimeMs);

      this.cacheHitGauge
        .labels(stat.queryFingerprint)
        .set(stat.cacheHitRatio);
    }

    return this.registry.metrics();
  }
}
```

### 4.6 定时任务调度

```javascript
// backend/shared/db-monitor/Scheduler.js
const cron = require('node-cron');

class DBMonitorScheduler {
  constructor(collector, baselineManager, driftDetector, alertPublisher) {
    this.collector = collector;
    this.baselineManager = baselineManager;
    this.driftDetector = driftDetector;
    this.alertPublisher = alertPublisher;
  }

  start() {
    // 每5分钟采集一次查询统计
    cron.schedule('*/5 * * * *', async () => {
      const stats = await this.collector.collectStats();
      await this.detectDrift(stats);
    });

    // 每小时更新一次基线
    cron.schedule('0 * * * *', async () => {
      await this.baselineManager.updateBaselines();
    });

    // 每天凌晨2点检查索引健康
    cron.schedule('0 2 * * *', async () => {
      await this.checkIndexHealth();
    });
  }

  async detectDrift(currentStats) {
    const baselines = await this.baselineManager.loadBaselines();
    const alerts = this.driftDetector.detect(currentStats, baselines);

    if (alerts.length > 0) {
      await this.alertPublisher.publish(alerts);
    }
  }
}
```

## 5. 验收标准（可测试）

- [ ] pg_stat_statements 扩展已启用，可通过查询获取 TOP 1000 慢查询统计
- [ ] query_performance_baseline 表包含至少 50 条关键查询的基线数据
- [ ] 漂移检测能够识别平均执行时间超过基线 2 倍的查询
- [ ] Prometheus 指标端点 `/metrics` 返回 pg_query_* 系列指标
- [ ] Grafana 仪表板显示查询性能趋势图、TOP 慢查询列表
- [ ] 索引健康检查报告列出未使用索引和低使用率索引
- [ ] 性能漂移告警通过 Slack/钉钉 通知到达指定频道
- [ ] 集成测试覆盖漂移检测算法，覆盖率 ≥ 80%
- [ ] 文档包含性能基线建立流程、漂移告警响应 SOP

## 6. 工作量估算

**M (Medium)**

- pg_stat_statements 集成与数据采集：1 天
- 性能基线管理模块：1 天
- 漂移检测算法实现：1-2 天
- Prometheus 指标导出：0.5 天
- Grafana 仪表板配置：0.5 天
- 索引健康检查工具：0.5 天
- 测试与文档：1 天

**总计：5-6 天**

## 7. 优先级理由

**P1** 理由：

1. **数据层是性能瓶颈**：随着用户增长，数据库性能直接影响游戏体验，需要主动监控
2. **预防性运维**：通过基线与漂移检测，可以在性能问题影响用户前主动发现
3. **支撑容量规划**：为数据库容量规划、索引优化提供数据支撑
4. **低成本高收益**：一次性投入建立体系，持续受益于性能可视化和主动告警
5. **提升运维成熟度**：从被动响应转向主动预防，提升项目整体运维能力
