# REQ-00491：监控指标生命周期管理与废弃治理系统

- **编号**：REQ-00491
- **类别**：可观测性/监控
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：backend/shared/metrics、gateway/middleware、k8s/monitoring
- **创建时间**：2026-07-08 01:17 UTC
- **依赖需求**：REQ-00002（Prometheus 指标系统）、REQ-00005（告警规则）

## 1. 背景与问题

mineGo 项目已有完善的 Prometheus 指标系统（REQ-00002），但缺乏指标生命周期管理机制：

**当前痛点：**
1. **指标膨胀**：长期迭代积累大量废弃指标，增加 Prometheus 存储成本和查询延迟
2. **缺少废弃流程**：代码重构后遗留的指标无人清理，变成"僵尸指标"
3. **无版本管理**：指标名称/标签变更无追踪，导致历史数据断层
4. **使用情况不透明**：无法知道哪些指标实际在用、哪些被查询
5. **缺乏元数据管理**：指标缺少描述、负责人、废弃时间等元信息

**真实代码现状：**
- `backend/shared/metrics.js` 注册了 100+ 指标，但部分已随代码删除
- 缺少指标注册中心，无法追踪指标来源
- Grafana 仪表板引用了大量不存在或已废弃的指标
- 告警规则中引用的指标名称变更后导致静默失败

**影响范围：**
- Prometheus 存储：每多一个指标增加约 100KB/天的存储开销
- 查询性能：废弃指标增加聚合查询的计算负担
- 维护成本：排查指标问题需要人工追溯代码历史

## 2. 目标

建立完整的指标生命周期管理系统：

- **指标注册中心**：统一管理所有指标的元数据
- **废弃治理流程**：标记→通知→过渡期→清理的完整流程
- **使用追踪**：监控指标在 Grafana/告警中的引用情况
- **自动清理**：根据使用情况自动清理僵尸指标
- **变更审计**：指标名称/标签变更的版本追踪

**可量化目标：**
- 废弃指标清理率：> 95%
- 僵尸指标检出准确率：> 90%
- 指标元数据覆盖率：100%
- 告警引用检查覆盖：100%

## 3. 范围

**包含：**
- 指标注册中心核心模块
- 指标元数据存储（PostgreSQL）
- 废弃指标检测与清理工具
- Grafana 仪表板引用分析
- 告警规则引用检查
- CI 集成检查脚本

**不包含：**
- Grafana 仪表板自动更新（仅报告不兼容）
- Prometheus 远程存储优化
- 自定义指标 SDK（使用现有 prom-client）

## 4. 详细需求

### 4.1 指标注册中心

创建 `backend/shared/metricRegistry.js`：

```javascript
/**
 * 指标注册中心
 * 管理指标元数据、废弃流程、使用追踪
 */
class MetricRegistry {
  constructor(db, config = {}) {
    this.db = db;
    this.config = {
      deprecationPeriodDays: config.deprecationPeriodDays || 30,
      unusedThresholdDays: config.unusedThresholdDays || 90,
      ...config
    };
    this.registry = new Map();
  }

  /**
   * 注册新指标
   * @param {Object} metricDef - 指标定义
   */
  async register(metricDef) {
    const entry = {
      name: metricDef.name,
      type: metricDef.type,
      help: metricDef.help,
      labels: metricDef.labels || [],
      unit: metricDef.unit,
      owner: metricDef.owner || 'unknown',
      service: metricDef.service,
      created_at: new Date(),
      deprecated: false,
      deprecated_at: null,
      deprecated_reason: null,
      replacement: null,
      removal_date: null,
      last_used: new Date(),
      usage_count: 0
    };

    // 存储到数据库
    await this.db.query(`
      INSERT INTO metric_registry 
        (name, type, help, labels, unit, owner, service, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (name) DO UPDATE SET
        last_used = NOW(),
        usage_count = metric_registry.usage_count + 1
    `, [entry.name, entry.type, entry.help, entry.labels, 
        entry.unit, entry.owner, entry.service]);

    this.registry.set(entry.name, entry);
    return entry;
  }

  /**
   * 标记指标为废弃
   */
  async deprecate(name, reason, replacement = null) {
    const removalDate = new Date();
    removalDate.setDate(removalDate.getDate() + this.config.deprecationPeriodDays);

    await this.db.query(`
      UPDATE metric_registry SET
        deprecated = true,
        deprecated_at = NOW(),
        deprecated_reason = $2,
        replacement = $3,
        removal_date = $4
      WHERE name = $1
    `, [name, reason, replacement, removalDate]);

    // 发送通知
    await this._notifyDeprecation(name, reason, replacement, removalDate);
  }

  /**
   * 清理废弃指标
   */
  async cleanupDeprecated() {
    const result = await this.db.query(`
      SELECT name, replacement FROM metric_registry
      WHERE deprecated = true
        AND removal_date < NOW()
    `);

    const cleaned = [];
    for (const row of result.rows) {
      await this._removeMetric(row.name);
      cleaned.push(row.name);
    }

    return cleaned;
  }

  /**
   * 检测僵尸指标（长时间未使用）
   */
  async detectZombieMetrics() {
    const result = await this.db.query(`
      SELECT name, last_used, usage_count
      FROM metric_registry
      WHERE deprecated = false
        AND last_used < NOW() - INTERVAL '${this.config.unusedThresholdDays} days'
    `);

    return result.rows;
  }

  /**
   * 获取指标元数据
   */
  async getMetadata(name) {
    const result = await this.db.query(`
      SELECT * FROM metric_registry WHERE name = $1
    `, [name]);
    return result.rows[0] || null;
  }

  /**
   * 列出所有指标
   */
  async list(filter = {}) {
    let query = 'SELECT * FROM metric_registry WHERE 1=1';
    const params = [];

    if (filter.deprecated !== undefined) {
      params.push(filter.deprecated);
      query += ` AND deprecated = $${params.length}`;
    }
    if (filter.service) {
      params.push(filter.service);
      query += ` AND service = $${params.length}`;
    }

    query += ' ORDER BY name';
    const result = await this.db.query(query, params);
    return result.rows;
  }

  async _removeMetric(name) {
    // 从 registry 移除
    this.registry.delete(name);
    
    // 从数据库删除
    await this.db.query('DELETE FROM metric_registry WHERE name = $1', [name]);
  }

  async _notifyDeprecation(name, reason, replacement, removalDate) {
    // 发送 Slack/邮件通知
    console.log(`[MetricRegistry] 指标 ${name} 已废弃，将在 ${removalDate.toISOString()} 移除`);
  }
}

module.exports = MetricRegistry;
```

### 4.2 指标元数据表

创建数据库迁移：

```sql
-- 指标注册中心表
CREATE TABLE IF NOT EXISTS metric_registry (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  type VARCHAR(50) NOT NULL, -- counter, gauge, histogram, summary
  help TEXT,
  labels TEXT[],
  unit VARCHAR(50),
  owner VARCHAR(100),
  service VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  deprecated BOOLEAN NOT NULL DEFAULT FALSE,
  deprecated_at TIMESTAMP WITH TIME ZONE,
  deprecated_reason TEXT,
  replacement VARCHAR(255),
  removal_date TIMESTAMP WITH TIME ZONE,
  last_used TIMESTAMP WITH TIME ZONE,
  usage_count INTEGER NOT NULL DEFAULT 0
);

-- 指标引用追踪表
CREATE TABLE IF NOT EXISTS metric_references (
  id SERIAL PRIMARY KEY,
  metric_name VARCHAR(255) NOT NULL,
  reference_type VARCHAR(50) NOT NULL, -- grafana, alert, code
  reference_location TEXT NOT NULL, -- dashboard uid, alert name, file path
  last_checked TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_metric_refs_name ON metric_references(metric_name);
CREATE INDEX idx_metric_refs_type ON metric_references(reference_type);
```

### 4.3 Grafana 引用分析

创建 `backend/scripts/analyze-metric-usage.js`：

```javascript
/**
 * 分析 Grafana 仪表板中的指标引用
 */
async function analyzeGrafanaUsage(grafanaUrl, apiKey) {
  const dashboards = await fetchDashboards(grafanaUrl, apiKey);
  const metricUsage = new Map();

  for (const dashboard of dashboards) {
    const panels = dashboard.dashboard?.panels || [];
    for (const panel of panels) {
      const targets = panel.targets || [];
      for (const target of targets) {
        if (target.expr) {
          const metrics = extractMetricsFromExpr(target.expr);
          metrics.forEach(m => {
            if (!metricUsage.has(m)) {
              metricUsage.set(m, []);
            }
            metricUsage.get(m).push({
              dashboard: dashboard.meta.slug,
              panel: panel.title,
              type: 'grafana'
            });
          });
        }
      }
    }
  }

  return metricUsage;
}

function extractMetricsFromExpr(expr) {
  // 匹配 Prometheus 指标名称
  const metricRegex = /\b(minego_[a-z_]+)/g;
  return [...expr.matchAll(metricRegex)].map(m => m[1]);
}
```

### 4.4 告警规则检查

```javascript
/**
 * 检查告警规则中的指标引用
 */
async function checkAlertRules(alertFiles) {
  const issues = [];
  
  for (const file of alertFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const rules = yaml.parse(content);
    
    for (const group of rules.groups || []) {
      for (const rule of group.rules || []) {
        const metrics = extractMetricsFromExpr(rule.expr);
        for (const metric of metrics) {
          const meta = await metricRegistry.getMetadata(metric);
          if (!meta) {
            issues.push({
              file,
              rule: rule.alert,
              metric,
              issue: '指标未注册'
            });
          } else if (meta.deprecated) {
            issues.push({
              file,
              rule: rule.alert,
              metric,
              issue: `指标已废弃，将在 ${meta.removal_date} 移除`,
              replacement: meta.replacement
            });
          }
        }
      }
    }
  }
  
  return issues;
}
```

### 4.5 CI 集成检查

创建 `.github/workflows/metric-lifecycle-check.yml`：

```yaml
name: Metric Lifecycle Check

on:
  pull_request:
    paths:
      - 'backend/shared/metrics.js'
      - 'k8s/monitoring/**'
  schedule:
    - cron: '0 0 * * 0'  # 每周检查

jobs:
  check-metrics:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Check deprecated metrics
        run: node scripts/check-deprecated-metrics.js
      
      - name: Analyze Grafana usage
        run: node scripts/analyze-metric-usage.js
        env:
          GRAFANA_URL: ${{ secrets.GRAFANA_URL }}
          GRAFANA_API_KEY: ${{ secrets.GRAFANA_API_KEY }}
      
      - name: Check alert rules
        run: node scripts/check-alert-metrics.js
      
      - name: Generate report
        run: node scripts/generate-metric-report.js
      
      - name: Upload report
        uses: actions/upload-artifact@v4
        with:
          name: metric-lifecycle-report
          path: metric-report.md
```

## 5. 验收标准（可测试）

- [ ] 指标注册中心可注册、查询、废弃指标
- [ ] 废弃指标有 30 天过渡期，期间仍可使用
- [ ] 清理脚本能自动移除过期废弃指标
- [ ] 僵尸指标检测准确率 > 90%（对比 Prometheus 查询数据）
- [ ] Grafana 引用分析覆盖所有仪表板
- [ ] 告警规则检查能发现未注册/废弃指标
- [ ] CI 流水线自动检测不兼容变更
- [ ] 提供指标生命周期状态查询 API

## 6. 工作量估算

M - 需要实现注册中心、数据库迁移、分析脚本和 CI 集成，预计需要 2-3 天。

## 7. 优先级理由

作为可观测性类需求，这是系统"可维护"标准的关键组成部分。指标膨胀会直接影响监控效率和成本，随着项目长期迭代，及时清理废弃指标是保持系统健康的重要措施，因此定为 P2。