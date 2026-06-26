# REQ-00331：数据库索引智能分析与自动优化系统

- **编号**：REQ-00331
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared、所有微服务、database/migrations、admin-dashboard
- **创建时间**：2026-06-26 02:00 UTC
- **依赖需求**：REQ-00063（慢查询分析）、REQ-00096（事务隔离与死锁检测）

## 1. 背景与问题

mineGo 项目经过长期迭代，数据库规模快速增长，索引管理面临严峻挑战：

**当前状态**：
- 9 个微服务共享 PostgreSQL 集群，数据库表超过 150 张
- 索引数量已达 500+ 个，但缺少系统化管理
- 部分查询因缺少索引导致性能瓶颈（如精灵位置查询、用户活动记录查询）
- 存在大量冗余索引和未使用索引，占用存储空间并降低写入性能
- 查询计划随数据量变化而变化，但索引未同步调整

**问题分析**：
1. **索引缺失检测困难**：缺少自动化工具识别需要新增索引的查询
2. **冗余索引未清理**：部分索引从未使用，但持续消耗写入资源
3. **索引效果无量化**：无法评估索引对查询性能的实际提升
4. **索引维护成本高**：手动分析和优化索引耗时耗力
5. **缺少预测能力**：无法预测索引对写入性能的影响

**影响评估**：
- 15% 的慢查询因缺少合适索引导致（平均响应时间 > 500ms）
- 约 20% 的索引未被使用，占用 10GB+ 存储空间
- 索引相关的写入性能损耗约 15-20%
- 缺少索引导致查询全表扫描，影响系统吞吐量

## 2. 目标

构建智能化的数据库索引分析与优化系统，实现：

1. **自动索引建议**：分析慢查询日志，自动推荐需要创建的索引
2. **索引使用率分析**：识别未使用、低效、冗余的索引
3. **索引效果预测**：通过 EXPLAIN 分析预测索引对查询性能的影响
4. **自动化索引管理**：支持一键创建/删除索引，自动生成迁移脚本
5. **性能影响评估**：评估索引对查询性能和写入性能的双重影响
6. **历史趋势追踪**：追踪索引使用率和性能变化趋势

**预期收益**：
- 减少 80% 的索引相关性能问题
- 清理 90% 的未使用索引，节省存储空间
- 查询性能平均提升 30%
- 写入性能提升 10-15%
- 减少 DBA 人工干预时间 70%

## 3. 范围

### 包含
- 慢查询日志分析引擎（识别需要索引的查询）
- 索引使用率统计与监控（pg_stat_user_indexes 数据收集）
- 索引建议生成器（基于查询模式和数据分布）
- 冗余索引检测器（检测重复、覆盖、未使用索引）
- 索引效果预测器（EXPLAIN ANALYZE 自动化）
- 索引迁移脚本生成器（创建/删除索引的迁移文件）
- 管理后台索引监控面板（可视化展示索引状态）
- 自动化索引优化任务（定时分析、生成报告、应用建议）
- 性能影响评估工具（读写性能对比测试）
- 历史趋势图表（索引使用率、大小、查询性能变化）

### 不包含
- 自动应用索引变更（需人工审批）
- 多数据库实例的分布式索引管理
- 物化视图管理（属于单独需求）
- 分区表索引管理（已在 REQ-00060 中覆盖）
- 全文搜索索引（PostgreSQL FTS）

## 4. 详细需求

### 4.1 数据库索引分析引擎

#### 4.1.1 索引使用率统计
```javascript
// backend/shared/indexAnalyzer/usageStats.js

class IndexUsageStats {
  /**
   * 收集索引使用统计
   */
  async collectStats(serviceName) {
    const pool = getPool(serviceName);
    
    const stats = await pool.query(`
      SELECT
        schemaname,
        relname as table_name,
        indexrelname as index_name,
        idx_scan as index_scans,
        idx_tup_read as tuples_read,
        idx_tup_fetch as tuples_fetched,
        pg_relation_size(indexrelid) as index_size_bytes,
        pg_size_pretty(pg_relation_size(indexrelid)) as index_size
      FROM pg_stat_user_indexes
      ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC
    `);
    
    return {
      totalIndexes: stats.rows.length,
      unusedIndexes: stats.rows.filter(r => r.idx_scan === 0),
      lowUsageIndexes: stats.rows.filter(r => r.idx_scan > 0 && r.idx_scan < 100),
      totalSize: stats.rows.reduce((sum, r) => sum + parseInt(r.index_size_bytes), 0),
      details: stats.rows
    };
  }
  
  /**
   * 分析索引效率
   */
  async analyzeEfficiency(serviceName) {
    const stats = await this.collectStats(serviceName);
    
    const efficiency = {
      unusedCount: stats.unusedIndexes.length,
      lowUsageCount: stats.lowUsageIndexes.length,
      wastedSpace: stats.unusedIndexes.reduce((sum, r) => sum + parseInt(r.index_size_bytes), 0),
      recommendations: []
    };
    
    // 为未使用索引生成删除建议
    for (const idx of stats.unusedIndexes) {
      efficiency.recommendations.push({
        type: 'DROP_UNUSED',
        index: idx.index_name,
        table: idx.table_name,
        size: idx.index_size,
        reason: 'Index has never been used',
        impact: `Recover ${idx.index_size} storage space`,
        risk: 'LOW',
        sql: `DROP INDEX IF EXISTS ${idx.index_name};`
      });
    }
    
    return efficiency;
  }
}
```

#### 4.1.2 慢查询分析器
```javascript
// backend/shared/indexAnalyzer/slowQueryAnalyzer.js

class SlowQueryAnalyzer {
  constructor() {
    this.slowQueryThreshold = 500; // ms
  }
  
  /**
   * 分析慢查询日志
   */
  async analyzeSlowQueries(serviceName) {
    const pool = getPool(serviceName);
    
    // 查询 pg_stat_statements（需启用扩展）
    const slowQueries = await pool.query(`
      SELECT
        query,
        calls,
        total_exec_time,
        mean_exec_time,
        max_exec_time,
        rows,
        shared_blks_hit,
        shared_blks_read
      FROM pg_stat_statements
      WHERE mean_exec_time > $1
      ORDER BY total_exec_time DESC
      LIMIT 50
    `, [this.slowQueryThreshold]);
    
    const recommendations = [];
    
    for (const query of slowQueries.rows) {
      const analysis = await this.analyzeQuery(query.query);
      if (analysis.needsIndex) {
        recommendations.push({
          query: query.query.substring(0, 200),
          avgTime: Math.round(query.mean_exec_time),
          calls: query.calls,
          suggestedIndex: analysis.suggestedIndex,
          reason: analysis.reason,
          impact: `Estimated 50-90% performance improvement`
        });
      }
    }
    
    return recommendations;
  }
  
  /**
   * 分析单个查询的索引需求
   */
  async analyzeQuery(queryText) {
    const pool = getPool();
    
    // 获取查询执行计划
    const explain = await pool.query(`EXPLAIN (FORMAT JSON, ANALYZE) ${queryText}`);
    const plan = explain.rows[0]['QUERY PLAN'][0];
    
    const issues = this.identifyPlanIssues(plan);
    
    return {
      needsIndex: issues.length > 0,
      issues,
      suggestedIndex: issues.length > 0 ? this.generateIndexSuggestion(queryText, issues) : null,
      reason: issues.map(i => i.description).join('; ')
    };
  }
  
  /**
   * 识别执行计划中的问题
   */
  identifyPlanIssues(plan) {
    const issues = [];
    
    // 检测全表扫描
    if (plan['Node Type'] === 'Seq Scan') {
      issues.push({
        type: 'SEQ_SCAN',
        description: 'Full table scan detected',
        table: plan['Relation Name'],
        filter: plan['Filter']
      });
    }
    
    // 检测大表的低效扫描
    if (plan['Plan Rows'] && plan['Plan Rows'] > 10000 && !plan['Index Name']) {
      issues.push({
        type: 'LARGE_SCAN',
        description: 'Large table scan without index',
        rows: plan['Plan Rows']
      });
    }
    
    // 检测低效的 JOIN
    if (plan['Node Type'] === 'Hash Join' && plan['Hash Cond']) {
      // 分析 JOIN 条件是否需要索引
      const joinCond = plan['Hash Cond'];
      if (!this.isIndexedJoin(joinCond)) {
        issues.push({
          type: 'UNINDEXED_JOIN',
          description: 'JOIN condition without index',
          condition: joinCond
        });
      }
    }
    
    return issues;
  }
}
```

### 4.2 索引建议生成器

#### 4.2.1 智能索引推荐
```javascript
// backend/shared/indexAnalyzer/indexRecommender.js

class IndexRecommender {
  /**
   * 基于查询模式生成索引建议
   */
  async generateRecommendations(serviceName) {
    const analyzer = new SlowQueryAnalyzer();
    const usageStats = new IndexUsageStats();
    
    const slowQuerySuggestions = await analyzer.analyzeSlowQueries(serviceName);
    const unusedIndexes = await usageStats.analyzeEfficiency(serviceName);
    
    const recommendations = {
      create: [],
      drop: [],
      modify: []
    };
    
    // 生成创建索引建议
    for (const suggestion of slowQuerySuggestions) {
      recommendations.create.push({
        priority: this.calculatePriority(suggestion),
        table: suggestion.suggestedIndex.table,
        columns: suggestion.suggestedIndex.columns,
        type: suggestion.suggestedIndex.type, // btree, hash, gin, gist
        sql: this.generateCreateIndexSQL(suggestion.suggestedIndex),
        reason: suggestion.reason,
        estimatedImpact: suggestion.impact,
        affectedQueries: [suggestion.query]
      });
    }
    
    // 生成删除索引建议
    for (const drop of unusedIndexes.recommendations) {
      recommendations.drop.push({
        priority: 'LOW',
        index: drop.index,
        table: drop.table,
        sql: drop.sql,
        reason: drop.reason,
        spaceRecovery: drop.size
      });
    }
    
    return recommendations;
  }
  
  /**
   * 生成创建索引 SQL
   */
  generateCreateIndexSQL(suggestion) {
    const indexName = `idx_${suggestion.table}_${suggestion.columns.join('_')}`;
    const columns = suggestion.columns.join(', ');
    
    if (suggestion.type === 'btree') {
      return `CREATE INDEX CONCURRENTLY ${indexName} ON ${suggestion.table} (${columns});`;
    } else if (suggestion.type === 'gin') {
      return `CREATE INDEX CONCURRENTLY ${indexName} ON ${suggestion.table} USING gin (${columns});`;
    }
    
    return `CREATE INDEX CONCURRENTLY ${indexName} ON ${suggestion.table} (${columns});`;
  }
  
  /**
   * 计算优先级
   */
  calculatePriority(suggestion) {
    const score = 0;
    
    // 调用频率高 = 高优先级
    if (suggestion.calls > 1000) score += 30;
    else if (suggestion.calls > 100) score += 20;
    else if (suggestion.calls > 10) score += 10;
    
    // 执行时间长 = 高优先级
    if (suggestion.avgTime > 2000) score += 30;
    else if (suggestion.avgTime > 1000) score += 20;
    else if (suggestion.avgTime > 500) score += 10;
    
    if (score >= 50) return 'HIGH';
    if (score >= 30) return 'MEDIUM';
    return 'LOW';
  }
}
```

### 4.3 索引效果预测器

#### 4.3.1 EXPLAIN 分析自动化
```javascript
// backend/shared/indexAnalyzer/performancePredictor.js

class PerformancePredictor {
  /**
   * 预测索引对查询性能的影响
   */
  async predictImpact(serviceName, queryText, suggestedIndex) {
    const pool = getPool(serviceName);
    
    // 1. 当前查询性能（无索引）
    const currentPlan = await pool.query(`EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${queryText}`);
    const currentStats = this.extractStats(currentPlan.rows[0]['QUERY PLAN'][0]);
    
    // 2. 创建临时索引测试
    const tempIndexName = `temp_test_idx_${Date.now()}`;
    const createSQL = this.generateCreateIndexSQL(suggestedIndex).replace('CONCURRENTLY', '');
    
    try {
      await pool.query(createSQL);
      
      // 3. 使用索引后的查询性能
      const newPlan = await pool.query(`EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${queryText}`);
      const newStats = this.extractStats(newPlan.rows[0]['QUERY PLAN'][0]);
      
      // 4. 计算性能提升
      const improvement = {
        executionTime: {
          before: currentStats.executionTime,
          after: newStats.executionTime,
          improvement: ((currentStats.executionTime - newStats.executionTime) / currentStats.executionTime * 100).toFixed(2)
        },
        rowsScanned: {
          before: currentStats.rowsScanned,
          after: newStats.rowsScanned,
          improvement: ((currentStats.rowsScanned - newStats.rowsScanned) / currentStats.rowsScanned * 100).toFixed(2)
        },
        bufferHits: {
          before: currentStats.bufferHits,
          after: newStats.bufferHits
        },
        indexUsed: newStats.indexUsed,
        planChange: currentStats.nodeType !== newStats.nodeType
      };
      
      return {
        shouldCreate: improvement.executionTime.improvement > 20,
        improvement,
        recommendation: this.generateRecommendation(improvement)
      };
    } finally {
      // 清理临时索引
      await pool.query(`DROP INDEX IF EXISTS ${tempIndexName};`);
    }
  }
  
  /**
   * 提取查询统计信息
   */
  extractStats(plan) {
    return {
      executionTime: plan['Execution Time'] || 0,
      rowsScanned: plan['Plan Rows'] || 0,
      bufferHits: plan['Shared Hit Blocks'] || 0,
      bufferReads: plan['Shared Read Blocks'] || 0,
      nodeType: plan['Node Type'],
      indexUsed: plan['Index Name'] || null
    };
  }
}
```

### 4.4 数据库表结构

```sql
-- 索引分析历史记录表
CREATE TABLE index_analysis_history (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  analysis_type VARCHAR(50) NOT NULL, -- 'usage_stats', 'slow_query', 'recommendation'
  total_indexes INTEGER NOT NULL,
  unused_indexes INTEGER NOT NULL,
  total_size_bytes BIGINT NOT NULL,
  wasted_space_bytes BIGINT NOT NULL,
  slow_queries_analyzed INTEGER DEFAULT 0,
  recommendations JSONB NOT NULL,
  analysis_timestamp TIMESTAMPTZ DEFAULT NOW(),
  analyzed_by VARCHAR(100) DEFAULT 'system',
  
  INDEX idx_analysis_history_service (service_name, analysis_timestamp DESC)
);

-- 索引变更记录表
CREATE TABLE index_changes (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  change_type VARCHAR(20) NOT NULL, -- 'CREATE', 'DROP', 'MODIFY'
  index_name VARCHAR(200) NOT NULL,
  table_name VARCHAR(200) NOT NULL,
  columns TEXT[] NOT NULL,
  index_type VARCHAR(20) DEFAULT 'btree',
  sql_statement TEXT NOT NULL,
  reason TEXT NOT NULL,
  expected_impact TEXT,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'applied', 'rolled_back'
  applied_at TIMESTAMPTZ,
  applied_by VARCHAR(100),
  performance_before JSONB,
  performance_after JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_index_changes_status (status, created_at DESC),
  INDEX idx_index_changes_service (service_name, status)
);

-- 索引使用趋势表
CREATE TABLE index_usage_trends (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  table_name VARCHAR(200) NOT NULL,
  index_name VARCHAR(200) NOT NULL,
  index_scans BIGINT NOT NULL,
  tuples_read BIGINT NOT NULL,
  tuples_fetched BIGINT NOT NULL,
  index_size_bytes BIGINT NOT NULL,
  snapshot_timestamp TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_usage_trends_lookup (service_name, table_name, index_name, snapshot_timestamp DESC)
);

-- 索引性能基准表
CREATE TABLE index_performance_baselines (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  query_fingerprint VARCHAR(64) NOT NULL, -- 查询指纹（MD5）
  query_pattern TEXT NOT NULL,
  avg_execution_time_ms DECIMAL(10,2) NOT NULL,
  max_execution_time_ms DECIMAL(10,2) NOT NULL,
  calls BIGINT NOT NULL,
  recommended_index TEXT,
  baseline_date DATE NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(service_name, query_fingerprint, baseline_date),
  INDEX idx_baseline_query (service_name, query_fingerprint)
);
```

### 4.5 API 接口

```yaml
# 获取索引使用统计
GET /api/v1/index-analysis/stats/:serviceName
Response:
  totalIndexes: integer
  unusedIndexes: array
  lowUsageIndexes: array
  totalSize: integer
  wastedSpace: integer

# 获取索引建议
GET /api/v1/index-analysis/recommendations/:serviceName
Response:
  create: array
  drop: array
  modify: array

# 分析单个查询
POST /api/v1/index-analysis/analyze-query
Request:
  serviceName: string
  query: string
Response:
  needsIndex: boolean
  issues: array
  suggestedIndex: object

# 预测索引效果
POST /api/v1/index-analysis/predict-impact
Request:
  serviceName: string
  query: string
  suggestedIndex: object
Response:
  shouldCreate: boolean
  improvement: object
  recommendation: string

# 应用索引变更
POST /api/v1/index-analysis/apply-change
Request:
  serviceName: string
  changeType: string (CREATE|DROP)
  sql: string
  reason: string
Response:
  success: boolean
  changeId: integer
  message: string

# 生成迁移脚本
POST /api/v1/index-analysis/generate-migration
Request:
  serviceName: string
  recommendations: array
Response:
  migrationFile: string
  content: string

# 获取索引历史
GET /api/v1/index-analysis/history/:serviceName
Query:
  days: integer (default: 30)
Response:
  history: array
  trends: object
```

### 4.6 管理后台监控面板

```javascript
// admin-dashboard/src/pages/IndexAnalysis.js

class IndexAnalysisDashboard {
  constructor() {
    this.charts = {};
    this.autoRefreshInterval = 60000; // 1分钟刷新
  }
  
  async render() {
    const html = `
      <div class="index-analysis-dashboard">
        <div class="dashboard-header">
          <h1>数据库索引分析与优化</h1>
          <div class="service-selector">
            <select id="service-select">
              <option value="gateway">Gateway</option>
              <option value="user-service">User Service</option>
              <option value="catch-service">Catch Service</option>
              <option value="pokemon-service">Pokemon Service</option>
              <option value="gym-service">Gym Service</option>
            </select>
            <button id="analyze-btn">分析索引</button>
          </div>
        </div>
        
        <div class="stats-overview">
          <div class="stat-card">
            <h3>总索引数</h3>
            <div class="stat-value" id="total-indexes">-</div>
          </div>
          <div class="stat-card warning">
            <h3>未使用索引</h3>
            <div class="stat-value" id="unused-indexes">-</div>
            <div class="stat-label">建议删除</div>
          </div>
          <div class="stat-card info">
            <h3>总大小</h3>
            <div class="stat-value" id="total-size">-</div>
          </div>
          <div class="stat-card danger">
            <h3>浪费空间</h3>
            <div class="stat-value" id="wasted-space">-</div>
            <div class="stat-label">可回收</div>
          </div>
        </div>
        
        <div class="recommendations-section">
          <h2>优化建议</h2>
          <div class="tabs">
            <button class="tab-btn active" data-tab="create">建议创建</button>
            <button class="tab-btn" data-tab="drop">建议删除</button>
          </div>
          
          <div id="create-tab" class="tab-content active">
            <table class="recommendations-table">
              <thead>
                <tr>
                  <th>优先级</th>
                  <th>表名</th>
                  <th>列名</th>
                  <th>原因</th>
                  <th>预计效果</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="create-recommendations"></tbody>
            </table>
          </div>
          
          <div id="drop-tab" class="tab-content">
            <table class="recommendations-table">
              <thead>
                <tr>
                  <th>索引名</th>
                  <th>表名</th>
                  <th>大小</th>
                  <th>原因</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="drop-recommendations"></tbody>
            </table>
          </div>
        </div>
        
        <div class="trends-section">
          <h2>使用趋势（最近 30 天）</h2>
          <canvas id="usage-trends-chart"></canvas>
        </div>
        
        <div class="slow-queries-section">
          <h2>慢查询分析（需优化索引）</h2>
          <table class="slow-queries-table">
            <thead>
              <tr>
                <th>查询</th>
                <th>平均执行时间</th>
                <th>调用次数</th>
                <th>建议索引</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="slow-queries-list"></tbody>
          </table>
        </div>
      </div>
    `;
    
    return html;
  }
}
```

### 4.7 自动化任务调度

```javascript
// backend/jobs/indexAnalysisJob.js

const { CronJob } = require('cron');
const IndexRecommender = require('../shared/indexAnalyzer/indexRecommender');

class IndexAnalysisJob {
  constructor() {
    this.job = new CronJob('0 2 * * *', this.runAnalysis.bind(this)); // 每天凌晨2点
  }
  
  async runAnalysis() {
    const services = ['gateway', 'user-service', 'catch-service', 'pokemon-service', 'gym-service'];
    
    for (const service of services) {
      try {
        const recommender = new IndexRecommender();
        const recommendations = await recommender.generateRecommendations(service);
        
        // 保存分析结果
        await this.saveAnalysisResult(service, recommendations);
        
        // 发送通知（如有高优先级建议）
        if (recommendations.create.filter(r => r.priority === 'HIGH').length > 0) {
          await this.sendAlert(service, recommendations);
        }
        
        logger.info(`Index analysis completed for ${service}`, {
          createCount: recommendations.create.length,
          dropCount: recommendations.drop.length
        });
      } catch (error) {
        logger.error(`Index analysis failed for ${service}`, error);
      }
    }
  }
  
  async saveAnalysisResult(service, recommendations) {
    await db.query(`
      INSERT INTO index_analysis_history 
      (service_name, analysis_type, total_indexes, unused_indexes, total_size_bytes, wasted_space_bytes, recommendations)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      service,
      'recommendation',
      recommendations.create.length + recommendations.drop.length,
      recommendations.drop.length,
      recommendations.totalSize || 0,
      recommendations.wastedSpace || 0,
      JSON.stringify(recommendations)
    ]);
  }
}
```

## 5. 验收标准（可测试）

- [ ] 索引使用率统计功能可正确收集所有表的索引使用情况
- [ ] 慢查询分析器能识别需要索引的查询并生成建议
- [ ] 索引建议生成器能生成 CREATE INDEX 和 DROP INDEX 语句
- [ ] 索引效果预测器能准确预测索引对查询性能的影响（误差 < 20%）
- [ ] 冗余索引检测器能识别未使用、重复、被覆盖的索引
- [ ] 管理后台能可视化展示索引状态、使用趋势、优化建议
- [ ] API 接口全部正常工作，响应时间 < 500ms
- [ ] 自动化任务能定时执行索引分析并生成报告
- [ ] 生成的迁移脚本符合 PostgreSQL 最佳实践（CONCURRENTLY、IF EXISTS）
- [ ] 所有功能编写单元测试，覆盖率 ≥ 70%
- [ ] 文档齐全：包括使用指南、API 文档、最佳实践

## 6. 工作量估算

**工作量：L（Large）**

理由：
- 需要实现多个分析引擎（使用率、慢查询、效果预测）
- 需要深入理解 PostgreSQL 查询优化器和索引机制
- 需要创建数据库表和 API 接口
- 需要创建管理后台监控面板
- 需要编写完善的测试和文档

预估工时：
- 核心分析引擎：16 小时
- 效果预测器：8 小时
- API 接口开发：6 小时
- 管理后台页面：12 小时
- 自动化任务：4 小时
- 测试和文档：8 小时
- **总计：54 小时（约 7 个工作日）**

## 7. 优先级理由

**优先级：P1**

理由：
1. **性能问题严重**：15% 的慢查询因索引问题导致，直接影响用户体验
2. **资源浪费**：未使用索引占用 10GB+ 存储空间，增加硬件成本
3. **维护成本高**：手动索引分析耗时耗力，缺少系统化工具
4. **投资回报高**：一次性投入，长期收益，可显著提升数据库性能
5. **生产就绪关键**：数据库性能是生产就绪的基础，直接影响系统稳定性
6. **支撑其他需求**：为慢查询分析、性能优化提供数据支撑

该需求是数据库性能优化的基础设施，完成后将显著提升系统性能和可维护性。
