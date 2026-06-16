# REQ-00254: 数据库查询执行计划缓存与智能优化器系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00254 |
| 标题 | 数据库查询执行计划缓存与智能优化器系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | postgresql、backend/shared、所有微服务、database/migrations |
| 创建时间 | 2026-06-16 15:05 |

## 需求描述

### 背景
当前 PostgreSQL 在执行复杂查询（特别是多表 JOIN、子查询、聚合操作）时，每次都需要重新生成查询执行计划，导致：
1. **高并发场景下 CPU 开销大**：相同的查询反复生成执行计划，浪费数据库资源
2. **性能波动明显**：参数化查询在不同值情况下执行计划不稳定
3. **缺少优化建议反馈**：开发者难以获知查询瓶颈和优化方向

### 目标
1. 建立查询执行计划缓存层，减少重复计算开销
2. 实现智能查询优化器，自动选择最优执行计划
3. 提供查询性能分析报告和优化建议
4. 建立慢查询自动优化工作流

### 核心功能
1. **查询计划缓存**：缓存高频查询的执行计划，命中率 ≥ 70%
2. **参数嗅探优化**：针对参数化查询选择最优执行计划
3. **自动索引建议**：基于查询模式自动推荐索引
4. **性能回归检测**：对比历史执行计划，检测性能退化

## 技术方案

### 1. 查询执行计划缓存层

**实现策略：**

```javascript
// backend/shared/QueryPlanCache.js
const { Pool } = require('pg');
const crypto = require('crypto');
const Redis = require('ioredis');

class QueryPlanCache {
  constructor(pool, redisClient) {
    this.pool = pool;
    this.redis = redisClient;
    this.cacheEnabled = true;
    this.hitCount = 0;
    this.missCount = 0;
    this.planCache = new Map(); // 本地内存缓存（L1）
    
    // 缓存策略配置
    this.config = {
      maxLocalCacheSize: 1000,
      cacheTTL: 3600, // 1小时
      minExecutionTime: 50, // 执行时间 > 50ms 才缓存
      maxParameterValues: 100, // 参数嗅探样本数
    };
  }

  /**
   * 生成查询指纹（规范化 SQL + 参数类型）
   */
  generateQueryFingerprint(sql, params = []) {
    // 规范化 SQL（移除多余空格、统一大小写）
    const normalizedSQL = sql.trim().toLowerCase().replace(/\s+/g, ' ');
    
    // 提取参数类型签名
    const paramTypes = params.map(p => {
      if (p === null) return 'null';
      if (typeof p === 'number') return 'num';
      if (typeof p === 'string') return 'str';
      if (p instanceof Date) return 'date';
      if (Array.isArray(p)) return 'arr';
      return 'obj';
    }).join(',');
    
    const fingerprint = crypto.createHash('sha256')
      .update(`${normalizedSQL}:${paramTypes}`)
      .digest('hex');
    
    return fingerprint;
  }

  /**
   * 执行查询（带计划缓存）
   */
  async query(sql, params = [], options = {}) {
    const fingerprint = this.generateQueryFingerprint(sql, params);
    const startTime = Date.now();
    
    // 1. 尝试从缓存获取执行计划
    const cachedPlan = await this.getPlanFromCache(fingerprint);
    
    if (cachedPlan && this.shouldUseCachedPlan(cachedPlan, params)) {
      this.hitCount++;
      
      // 使用缓存的执行计划（通过 PREPARE 语句）
      const result = await this.executeWithCachedPlan(cachedPlan, params);
      
      const duration = Date.now() - startTime;
      await this.recordQueryMetrics(fingerprint, duration, true);
      
      return result;
    }
    
    // 2. 缓存未命中，执行查询并分析
    this.missCount++;
    const result = await this.executeAndAnalyze(sql, params, fingerprint);
    
    return result;
  }

  /**
   * 从多级缓存获取计划
   */
  async getPlanFromCache(fingerprint) {
    // L1: 本地内存缓存
    if (this.planCache.has(fingerprint)) {
      return this.planCache.get(fingerprint);
    }
    
    // L2: Redis 缓存
    try {
      const cachedData = await this.redis.get(`query_plan:${fingerprint}`);
      if (cachedData) {
        const plan = JSON.parse(cachedData);
        this.planCache.set(fingerprint, plan); // 回填 L1
        return plan;
      }
    } catch (err) {
      console.error('Redis cache error:', err);
    }
    
    return null;
  }

  /**
   * 执行并分析查询计划
   */
  async executeAndAnalyze(sql, params, fingerprint) {
    const client = await this.pool.connect();
    
    try {
      // 1. 获取查询执行计划
      const explainResult = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      const executionPlan = explainResult.rows[0];
      const actualDuration = executionPlan['QUERY PLAN'][0]['Execution Time'];
      
      // 2. 执行实际查询
      const result = await client.query(sql, params);
      
      // 3. 如果执行时间超过阈值，缓存执行计划
      if (actualDuration > this.config.minExecutionTime) {
        const planData = {
          fingerprint,
          sql,
          params: params.slice(0, 5), // 只存储前 5 个参数样本
          plan: executionPlan,
          avgExecutionTime: actualDuration,
          hitCount: 0,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        };
        
        await this.cachePlan(fingerprint, planData);
      }
      
      // 4. 记录查询指标
      await this.recordQueryMetrics(fingerprint, actualDuration, false);
      
      // 5. 检测性能问题并生成建议
      await this.analyzeAndSuggest(sql, executionPlan, fingerprint);
      
      return result;
    } finally {
      client.release();
    }
  }

  /**
   * 缓存执行计划
   */
  async cachePlan(fingerprint, planData) {
    // 存储到 L1
    if (this.planCache.size >= this.config.maxLocalCacheSize) {
      // LRU 淘汰
      const oldestKey = this.planCache.keys().next().value;
      this.planCache.delete(oldestKey);
    }
    this.planCache.set(fingerprint, planData);
    
    // 存储到 L2 (Redis)
    try {
      await this.redis.setex(
        `query_plan:${fingerprint}`,
        this.config.cacheTTL,
        JSON.stringify(planData)
      );
    } catch (err) {
      console.error('Failed to cache plan in Redis:', err);
    }
  }

  /**
   * 使用缓存的执行计划执行查询
   */
  async executeWithCachedPlan(cachedPlan, params) {
    const client = await this.pool.connect();
    
    try {
      // 创建 Prepared Statement
      const stmtName = `plan_${cachedPlan.fingerprint.substring(0, 16)}`;
      
      await client.query({
        name: stmtName,
        text: cachedPlan.sql,
        values: params,
      });
      
      return await client.query({
        name: stmtName,
        values: params,
      });
    } finally {
      client.release();
    }
  }

  /**
   * 判断是否应使用缓存的执行计划
   */
  shouldUseCachedPlan(cachedPlan, params) {
    // 检查缓存是否过期
    if (Date.now() - cachedPlan.lastUsedAt > this.config.cacheTTL * 1000) {
      return false;
    }
    
    // 检查参数范围是否合理（参数嗅嗅探）
    const selectivity = this.estimateSelectivity(params);
    if (selectivity > 0.3 && cachedPlan.planType === 'IndexScan') {
      // 高选择度时，索引扫描可能不是最优
      return false;
    }
    
    return true;
  }

  /**
   * 估算参数选择度
   */
  estimateSelectivity(params) {
    // 简化实现：基于参数值范围估算
    // 实际应查询 pg_stats 表获取统计信息
    return params.length > 0 ? 0.1 : 1.0;
  }

  /**
   * 记录查询指标
   */
  async recordQueryMetrics(fingerprint, duration, cacheHit) {
    const metricsKey = `query_metrics:${fingerprint}`;
    const metrics = {
      fingerprint,
      duration,
      cacheHit,
      timestamp: Date.now(),
    };
    
    // 存储到 Redis（用于后续分析）
    await this.redis.lpush(metricsKey, JSON.stringify(metrics));
    await this.redis.ltrim(metricsKey, 0, 999); // 保留最近 1000 条
  }

  /**
   * 分析性能并生成优化建议
   */
  async analyzeAndSuggest(sql, executionPlan, fingerprint) {
    const planNode = executionPlan['QUERY PLAN'][0].Plan;
    const suggestions = [];
    
    // 1. 检测全表扫描
    if (planNode['Node Type'] === 'Seq Scan') {
      const tableName = planNode['Relation Name'];
      suggestions.push({
        type: 'missing_index',
        severity: 'high',
        message: `检测到全表扫描: ${tableName}`,
        suggestion: `建议为 ${tableName} 表添加索引，过滤条件: ${planNode['Filter'] || '未知'}`,
      });
    }
    
    // 2. 检测高代价排序
    if (planNode['Sort Method']) {
      const sortCost = planNode['Sort Space Used'];
      if (sortCost > 1024 * 1024) { // > 1MB
        suggestions.push({
          type: 'expensive_sort',
          severity: 'medium',
          message: `排序操作消耗大量内存: ${(sortCost / 1024 / 1024).toFixed(2)} MB`,
          suggestion: '考虑添加索引以避免排序，或增加 work_mem 配置',
        });
      }
    }
    
    // 3. 检测嵌套循环连接（高行数）
    if (planNode['Node Type'] === 'Nested Loop') {
      const actualRows = planNode['Actual Rows'];
      const planRows = planNode['Plan Rows'];
      
      if (actualRows / planRows > 10) {
        suggestions.push({
          type: 'cardinality_mismatch',
          severity: 'high',
          message: '查询优化器行数估计严重偏差',
          suggestion: '执行 ANALYZE 更新统计信息，或调整统计目标',
        });
      }
    }
    
    // 4. 检测高代价 JOIN
    const joinNodes = this.findNodesByType(planNode, ['Hash Join', 'Merge Join', 'Nested Loop']);
    for (const join of joinNodes) {
      const hashCost = join['Hash Cond'];
      if (hashCost && join['Actual Total Time'] > 100) {
        suggestions.push({
          type: 'expensive_join',
          severity: 'medium',
          message: `高代价 JOIN 操作: ${join['Node Type']}`,
          suggestion: '检查 JOIN 条件是否有索引支持',
        });
      }
    }
    
    // 5. 存储优化建议
    if (suggestions.length > 0) {
      await this.redis.setex(
        `query_suggestions:${fingerprint}`,
        86400, // 24小时
        JSON.stringify({
          sql: sql.substring(0, 200),
          suggestions,
          createdAt: Date.now(),
        })
      );
      
      // 发送到监控系统
      this.emitOptimizationEvent(fingerprint, suggestions);
    }
  }

  /**
   * 递归查找特定类型的节点
   */
  findNodesByType(node, types, results = []) {
    if (types.includes(node['Node Type'])) {
      results.push(node);
    }
    
    if (node.Plans) {
      for (const child of node.Plans) {
        this.findNodesByType(child, types, results);
      }
    }
    
    return results;
  }

  /**
   * 发送优化事件到监控系统
   */
  emitOptimizationEvent(fingerprint, suggestions) {
    const Prometheus = require('./metrics');
    
    Prometheus.queryOptimizationSuggestionsTotal.inc({
      severity: suggestions[0].severity,
    });
    
    // 发送到 Kafka 用于异步处理
    const KafkaProducer = require('./kafkaProducer');
    KafkaProducer.send('query-optimization', {
      fingerprint,
      suggestions,
      timestamp: Date.now(),
    });
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    const total = this.hitCount + this.missCount;
    const hitRate = total > 0 ? (this.hitCount / total * 100).toFixed(2) : 0;
    
    return {
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: `${hitRate}%`,
      cacheSize: this.planCache.size,
    };
  }

  /**
   * 清空缓存
   */
  async clearCache() {
    this.planCache.clear();
    
    try {
      const keys = await this.redis.keys('query_plan:*');
      if (keys.length > 0) {
        await this.redis.del(keys);
      }
    } catch (err) {
      console.error('Failed to clear Redis cache:', err);
    }
    
    this.hitCount = 0;
    this.missCount = 0;
  }
}

module.exports = QueryPlanCache;
```

### 2. 智能索引推荐系统

```javascript
// backend/shared/IndexAdvisor.js
const { Pool } = require('pg');

class IndexAdvisor {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * 分析查询并推荐索引
   */
  async analyzeAndSuggest(sql, params = []) {
    const suggestions = [];
    
    // 1. 解析 WHERE 子句
    const whereColumns = this.extractWhereColumns(sql);
    
    // 2. 解析 JOIN 条件
    const joinColumns = this.extractJoinColumns(sql);
    
    // 3. 解析 ORDER BY 子句
    const orderByColumns = this.extractOrderByColumns(sql);
    
    // 4. 解析 GROUP BY 子句
    const groupByColumns = this.extractGroupByColumns(sql);
    
    // 5. 检查现有索引
    const existingIndexes = await this.getExistingIndexes();
    
    // 6. 生成索引建议
    for (const col of whereColumns) {
      const indexName = `idx_${col.table}_${col.column}`;
      
      if (!this.hasIndex(existingIndexes, col.table, col.column)) {
        suggestions.push({
          type: 'where_index',
          priority: 'high',
          table: col.table,
          column: col.column,
          sql: `CREATE INDEX ${indexName} ON ${col.table} (${col.column});`,
          reason: 'WHERE 条件列缺少索引',
        });
      }
    }
    
    // 7. 推荐复合索引（WHERE + ORDER BY 组合）
    if (whereColumns.length > 0 && orderByColumns.length > 0) {
      const compoundCols = [...new Set([...whereColumns, ...orderByColumns])];
      
      suggestions.push({
        type: 'compound_index',
        priority: 'medium',
        table: compoundCols[0].table,
        columns: compoundCols.map(c => c.column),
        sql: `CREATE INDEX idx_compound ON ${compoundCols[0].table} (${compoundCols.map(c => c.column).join(', ')});`,
        reason: 'WHERE + ORDER BY 组合可使用复合索引优化',
      });
    }
    
    return suggestions;
  }

  /**
   * 提取 WHERE 子句中的列
   */
  extractWhereColumns(sql) {
    const columns = [];
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:ORDER|GROUP|LIMIT|$)/is);
    
    if (whereMatch) {
      const whereClause = whereMatch[1];
      const colPattern = /(\w+)\.(\w+)\s*(?:=|>|<|>=|<=|<>|LIKE|IN|BETWEEN)/gi;
      
      let match;
      while ((match = colPattern.exec(whereClause)) !== null) {
        columns.push({
          table: match[1],
          column: match[2],
        });
      }
    }
    
    return columns;
  }

  /**
   * 提取 JOIN 条件中的列
   */
  extractJoinColumns(sql) {
    const columns = [];
    const joinPattern = /JOIN\s+(\w+)\s+ON\s+(.+?)(?:WHERE|ORDER|GROUP|LIMIT|JOIN|$)/gis;
    
    let match;
    while ((match = joinPattern.exec(sql)) !== null) {
      const table = match[1];
      const condition = match[2];
      const colPattern = /(\w+)\.(\w+)/g;
      
      let colMatch;
      while ((colMatch = colPattern.exec(condition)) !== null) {
        columns.push({
          table: colMatch[1],
          column: colMatch[2],
        });
      }
    }
    
    return columns;
  }

  /**
   * 提取 ORDER BY 子句中的列
   */
  extractOrderByColumns(sql) {
    const columns = [];
    const orderMatch = sql.match(/ORDER\s+BY\s+(.+?)(?:LIMIT|$)/is);
    
    if (orderMatch) {
      const orderClause = orderMatch[1];
      const colPattern = /(\w+)\.(\w+)/g;
      
      let match;
      while ((match = colPattern.exec(orderClause)) !== null) {
        columns.push({
          table: match[1],
          column: match[2],
        });
      }
    }
    
    return columns;
  }

  /**
   * 提取 GROUP BY 子句中的列
   */
  extractGroupByColumns(sql) {
    const columns = [];
    const groupMatch = sql.match(/GROUP\s+BY\s+(.+?)(?:HAVING|ORDER|LIMIT|$)/is);
    
    if (groupMatch) {
      const groupClause = groupMatch[1];
      const colPattern = /(\w+)\.(\w+)/g;
      
      let match;
      while ((match = colPattern.exec(groupClause)) !== null) {
        columns.push({
          table: match[1],
          column: match[2],
        });
      }
    }
    
    return columns;
  }

  /**
   * 获取现有索引
   */
  async getExistingIndexes() {
    const query = `
      SELECT 
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
    `;
    
    const result = await this.pool.query(query);
    return result.rows;
  }

  /**
   * 检查是否存在索引
   */
  hasIndex(existingIndexes, table, column) {
    return existingIndexes.some(idx => {
      return idx.tablename === table && 
             idx.indexdef.includes(`(${column})`);
    });
  }

  /**
   * 分析索引使用率
   */
  async analyzeIndexUsage() {
    const query = `
      SELECT
        schemaname,
        tablename,
        indexname,
        idx_scan,
        idx_tup_read,
        idx_tup_fetch,
        pg_size_pretty(pg_relation_size(indexrelid)) as size
      FROM pg_stat_user_indexes
      WHERE schemaname = 'public'
      ORDER BY idx_scan ASC
    `;
    
    const result = await this.pool.query(query);
    const unusedIndexes = result.rows.filter(idx => idx.idx_scan === '0');
    
    return {
      all: result.rows,
      unused: unusedIndexes,
      recommendation: unusedIndexes.length > 0 
        ? `发现 ${unusedIndexes.length} 个未使用索引，建议删除以节省存储空间`
        : '所有索引都在使用中',
    };
  }
}

module.exports = IndexAdvisor;
```

### 3. 慢查询自动优化工作流

```javascript
// backend/jobs/slowQueryOptimizer.js
const cron = require('node-cron');
const QueryPlanCache = require('../shared/QueryPlanCache');
const IndexAdvisor = require('../shared/IndexAdvisor');
const Prometheus = require('../shared/metrics');
const SlackNotifier = require('../shared/SlackNotifier');

class SlowQueryOptimizer {
  constructor(config) {
    this.pool = config.pool;
    this.redis = config.redis;
    this.queryPlanCache = new QueryPlanCache(this.pool, this.redis);
    this.indexAdvisor = new IndexAdvisor(this.pool);
    this.slowQueryThreshold = 1000; // 1秒
  }

  /**
   * 启动定时任务
   */
  start() {
    // 每小时分析慢查询
    cron.schedule('0 * * * *', async () => {
      await this.analyzeSlowQueries();
    });
    
    // 每天生成优化报告
    cron.schedule('0 9 * * *', async () => {
      await this.generateDailyReport();
    });
    
    console.log('Slow query optimizer started');
  }

  /**
   * 分析慢查询
   */
  async analyzeSlowQueries() {
    try {
      // 1. 从 PostgreSQL 获取慢查询
      const slowQueries = await this.fetchSlowQueries();
      
      console.log(`Found ${slowQueries.length} slow queries`);
      
      // 2. 分析每个慢查询
      for (const query of slowQueries) {
        const analysis = await this.analyzeQuery(query);
        
        // 3. 如果有优化建议，发送通知
        if (analysis.suggestions.length > 0) {
          await this.sendOptimizationAlert(query, analysis);
          
          Prometheus.slowQueryDetected.inc({
            severity: analysis.severity,
          });
        }
      }
      
      // 4. 更新缓存统计
      const stats = this.queryPlanCache.getStats();
      Prometheus.queryPlanCacheHitRate.set(parseFloat(stats.hitRate));
      
    } catch (err) {
      console.error('Failed to analyze slow queries:', err);
    }
  }

  /**
   * 从 PostgreSQL 获取慢查询
   */
  async fetchSlowQueries() {
    const query = `
      SELECT 
        query,
        calls,
        total_time,
        mean_time,
        rows,
        100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0) AS hit_percent
      FROM pg_stat_statements
      WHERE mean_time > $1
      ORDER BY total_time DESC
      LIMIT 50
    `;
    
    const result = await this.pool.query(query, [this.slowQueryThreshold]);
    return result.rows;
  }

  /**
   * 分析单个查询
   */
  async analyzeQuery(query) {
    const suggestions = [];
    let severity = 'low';
    
    // 1. 索引建议
    const indexSuggestions = await this.indexAdvisor.analyzeAndSuggest(query.query);
    suggestions.push(...indexSuggestions);
    
    if (indexSuggestions.some(s => s.priority === 'high')) {
      severity = 'high';
    }
    
    // 2. 检查缓存命中率
    if (query.hit_percent < 80) {
      suggestions.push({
        type: 'low_cache_hit',
        severity: 'medium',
        message: `缓存命中率低: ${query.hit_percent.toFixed(2)}%`,
        suggestion: '考虑增加 shared_buffers 配置或优化查询减少数据扫描',
      });
    }
    
    // 3. 检查返回行数过多
    if (query.rows > 10000) {
      suggestions.push({
        type: 'large_result_set',
        severity: 'medium',
        message: `查询返回大量行: ${query.rows}`,
        suggestion: '考虑添加 LIMIT 或分页查询',
      });
    }
    
    // 4. 检查高频调用
    if (query.calls > 1000 && query.mean_time > 100) {
      suggestions.push({
        type: 'high_frequency_slow',
        severity: 'high',
        message: `高频慢查询: 调用 ${query.calls} 次，平均耗时 ${query.mean_time.toFixed(2)}ms`,
        suggestion: '优先优化此查询，将显著提升整体性能',
      });
    }
    
    return { suggestions, severity };
  }

  /**
   * 发送优化告警
   */
  async sendOptimizationAlert(query, analysis) {
    const message = {
      text: '🐌 慢查询检测告警',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '慢查询优化建议',
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*平均耗时:* ${query.mean_time.toFixed(2)}ms`,
            },
            {
              type: 'mrkdwn',
              text: `*调用次数:* ${query.calls}`,
            },
            {
              type: 'mrkdwn',
              text: `*严重程度:* ${analysis.severity.toUpperCase()}`,
            },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*SQL:*\n\`\`\`${query.query.substring(0, 500)}\`\`\``,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*优化建议:*\n${analysis.suggestions.map(s => `• ${s.message}\n  → ${s.suggestion}`).join('\n')}`,
          },
        },
      ],
    };
    
    await SlackNotifier.send(message);
  }

  /**
   * 生成每日报告
   */
  async generateDailyReport() {
    const stats = this.queryPlanCache.getStats();
    const indexUsage = await this.indexAdvisor.analyzeIndexUsage();
    
    const report = {
      date: new Date().toISOString().split('T')[0],
      queryPlanCache: stats,
      indexUsage: {
        total: indexUsage.all.length,
        unused: indexUsage.unused.length,
        recommendation: indexUsage.recommendation,
      },
    };
    
    // 存储报告
    await this.redis.set(
      `daily_report:${report.date}`,
      JSON.stringify(report),
      'EX',
      86400 * 30 // 保留 30 天
    );
    
    console.log('Daily report generated:', report);
    
    // 发送摘要通知
    await SlackNotifier.send({
      text: '📊 每日查询优化报告',
      blocks: [
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*查询计划缓存命中率:* ${stats.hitRate}`,
            },
            {
              type: 'mrkdwn',
              text: `*未使用索引:* ${indexUsage.unused.length}`,
            },
          ],
        },
      ],
    });
  }
}

module.exports = SlowQueryOptimizer;
```

### 4. Prometheus 指标定义

```javascript
// backend/shared/metrics.js (追加)
const client = require('prom-client');

// 查询计划缓存命中率
const queryPlanCacheHitRate = new client.Gauge({
  name: 'query_plan_cache_hit_rate',
  help: 'Query plan cache hit rate percentage',
});

// 慢查询检测计数
const slowQueryDetected = new client.Counter({
  name: 'slow_query_detected_total',
  help: 'Total number of slow queries detected',
  labelNames: ['severity'],
});

// 查询优化建议计数
const queryOptimizationSuggestionsTotal = new client.Counter({
  name: 'query_optimization_suggestions_total',
  help: 'Total number of query optimization suggestions',
  labelNames: ['severity'],
});

// 索引使用统计
const indexUsageStats = new client.Gauge({
  name: 'index_usage_stats',
  help: 'Index usage statistics',
  labelNames: ['table', 'index_name', 'metric'],
});

module.exports = {
  queryPlanCacheHitRate,
  slowQueryDetected,
  queryOptimizationSuggestionsTotal,
  indexUsageStats,
  // ... 其他指标
};
```

### 5. 数据库迁移脚本

```sql
-- database/migrations/20260616_create_query_optimization_tables.sql

-- 查询执行历史表
CREATE TABLE IF NOT EXISTS query_execution_history (
    id SERIAL PRIMARY KEY,
    query_fingerprint VARCHAR(64) NOT NULL,
    query_text TEXT NOT NULL,
    execution_time_ms INTEGER NOT NULL,
    cache_hit BOOLEAN DEFAULT FALSE,
    rows_affected INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 查询优化建议表
CREATE TABLE IF NOT EXISTS query_optimization_suggestions (
    id SERIAL PRIMARY KEY,
    query_fingerprint VARCHAR(64) NOT NULL,
    suggestion_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    suggestion TEXT NOT NULL,
    applied BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引建议历史表
CREATE TABLE IF NOT EXISTS index_suggestions (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(100) NOT NULL,
    column_names TEXT[] NOT NULL,
    suggested_sql TEXT NOT NULL,
    reason TEXT,
    applied BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_query_history_fingerprint ON query_execution_history(query_fingerprint);
CREATE INDEX idx_query_history_time ON query_execution_history(execution_time_ms DESC);
CREATE INDEX idx_query_suggestions_type ON query_optimization_suggestions(suggestion_type);
CREATE INDEX idx_query_suggestions_applied ON query_optimization_suggestions(applied);

-- 分区表（按月分区）
CREATE TABLE IF NOT EXISTS query_execution_history_partitioned (
    id SERIAL,
    query_fingerprint VARCHAR(64) NOT NULL,
    query_text TEXT NOT NULL,
    execution_time_ms INTEGER NOT NULL,
    cache_hit BOOLEAN DEFAULT FALSE,
    rows_affected INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 创建最近 3 个月的分区
CREATE TABLE query_history_202606 PARTITION OF query_execution_history_partitioned
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE query_history_202607 PARTITION OF query_execution_history_partitioned
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE query_history_202608 PARTITION OF query_execution_history_partitioned
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- 启用 pg_stat_statements 扩展（如果未启用）
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 重置统计信息函数
CREATE OR REPLACE FUNCTION reset_query_stats()
RETURNS VOID AS $$
BEGIN
    SELECT pg_stat_statements_reset();
END;
$$ LANGUAGE plpgsql;
```

### 6. 集成到现有服务

```javascript
// backend/shared/db.js (修改现有文件)
const { Pool } = require('pg');
const Redis = require('ioredis');
const QueryPlanCache = require('./QueryPlanCache');
const IndexAdvisor = require('./IndexAdvisor');

// 创建连接池
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 创建 Redis 客户端
const redis = new Redis(process.env.REDIS_URL);

// 创建查询计划缓存实例
const queryPlanCache = new QueryPlanCache(pool, redis);
const indexAdvisor = new IndexAdvisor(pool);

// 包装 query 方法
const originalQuery = pool.query.bind(pool);

pool.query = async function(sql, params, options = {}) {
  // 如果禁用缓存，直接执行
  if (options.skipCache) {
    return originalQuery(sql, params);
  }
  
  // 使用查询计划缓存
  return queryPlanCache.query(sql, params, options);
};

// 导出增强后的 pool
module.exports = {
  pool,
  queryPlanCache,
  indexAdvisor,
  query: pool.query.bind(pool),
};
```

### 7. 管理员仪表板集成

```javascript
// admin-dashboard/src/components/QueryOptimizationDashboard.js
import React, { useState, useEffect } from 'react';
import { Line, Bar, Pie } from 'react-chartjs-2';
import { Card, Grid, Typography, Chip, Button, Table, TableBody, TableCell, TableHead, TableRow } from '@material-ui/core';
import { Alert, AlertTitle } from '@material-ui/lab';

const QueryOptimizationDashboard = () => {
  const [stats, setStats] = useState(null);
  const [slowQueries, setSlowQueries] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [indexUsage, setIndexUsage] = useState(null);
  
  useEffect(() => {
    fetchStats();
    fetchSlowQueries();
    fetchSuggestions();
    fetchIndexUsage();
    
    // 每 30 秒刷新
    const interval = setInterval(() => {
      fetchStats();
      fetchSlowQueries();
    }, 30000);
    
    return () => clearInterval(interval);
  }, []);
  
  const fetchStats = async () => {
    const response = await fetch('/api/admin/query-cache/stats');
    const data = await response.json();
    setStats(data);
  };
  
  const fetchSlowQueries = async () => {
    const response = await fetch('/api/admin/slow-queries?limit=20');
    const data = await response.json();
    setSlowQueries(data.queries);
  };
  
  const fetchSuggestions = async () => {
    const response = await fetch('/api/admin/query-suggestions');
    const data = await response.json();
    setSuggestions(data.suggestions);
  };
  
  const fetchIndexUsage = async () => {
    const response = await fetch('/api/admin/index-usage');
    const data = await response.json();
    setIndexUsage(data);
  };
  
  const renderCacheStats = () => {
    if (!stats) return <div>加载中...</div>;
    
    const chartData = {
      labels: ['命中', '未命中'],
      datasets: [{
        data: [stats.hitCount, stats.missCount],
        backgroundColor: ['#4CAF50', '#F44336'],
      }],
    };
    
    return (
      <Card style={{ padding: 20 }}>
        <Typography variant="h6" gutterBottom>
          查询计划缓存统计
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={6}>
            <Pie data={chartData} />
          </Grid>
          <Grid item xs={6}>
            <Typography variant="body1">
              <strong>命中率:</strong> {stats.hitRate}
            </Typography>
            <Typography variant="body1">
              <strong>缓存大小:</strong> {stats.cacheSize}
            </Typography>
            <Typography variant="body1">
              <strong>命中次数:</strong> {stats.hitCount}
            </Typography>
            <Typography variant="body1">
              <strong>未命中次数:</strong> {stats.missCount}
            </Typography>
          </Grid>
        </Grid>
      </Card>
    );
  };
  
  const renderSlowQueries = () => {
    return (
      <Card style={{ padding: 20, marginTop: 20 }}>
        <Typography variant="h6" gutterBottom>
          慢查询列表 (TOP 20)
        </Typography>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>查询</TableCell>
              <TableCell align="right">平均耗时(ms)</TableCell>
              <TableCell align="right">调用次数</TableCell>
              <TableCell align="right">返回行数</TableCell>
              <TableCell align="right">缓存命中率</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {slowQueries.map((query, index) => (
              <TableRow key={index}>
                <TableCell>
                  <code style={{ fontSize: 12 }}>
                    {query.query.substring(0, 100)}...
                  </code>
                </TableCell>
                <TableCell align="right">
                  <Chip 
                    label={query.mean_time.toFixed(2)} 
                    color={query.mean_time > 2000 ? 'secondary' : 'primary'}
                    size="small"
                  />
                </TableCell>
                <TableCell align="right">{query.calls}</TableCell>
                <TableCell align="right">{query.rows}</TableCell>
                <TableCell align="right">
                  {query.hit_percent ? `${query.hit_percent.toFixed(1)}%` : 'N/A'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    );
  };
  
  const renderSuggestions = () => {
    const highPriority = suggestions.filter(s => s.severity === 'high');
    const mediumPriority = suggestions.filter(s => s.severity === 'medium');
    
    return (
      <Card style={{ padding: 20, marginTop: 20 }}>
        <Typography variant="h6" gutterBottom>
          优化建议 ({suggestions.length} 条)
        </Typography>
        
        {highPriority.length > 0 && (
          <Alert severity="error" style={{ marginBottom: 10 }}>
            <AlertTitle>高优先级建议 ({highPriority.length})</AlertTitle>
            <ul>
              {highPriority.slice(0, 5).map((s, i) => (
                <li key={i}>
                  <strong>{s.message}</strong><br />
                  <span style={{ fontSize: 12 }}>{s.suggestion}</span>
                </li>
              ))}
            </ul>
          </Alert>
        )}
        
        {mediumPriority.length > 0 && (
          <Alert severity="warning" style={{ marginBottom: 10 }}>
            <AlertTitle>中优先级建议 ({mediumPriority.length})</AlertTitle>
            <ul>
              {mediumPriority.slice(0, 3).map((s, i) => (
                <li key={i}>{s.message}</li>
              ))}
            </ul>
          </Alert>
        )}
      </Card>
    );
  };
  
  const renderIndexUsage = () => {
    if (!indexUsage) return null;
    
    return (
      <Card style={{ padding: 20, marginTop: 20 }}>
        <Typography variant="h6" gutterBottom>
          索引使用情况
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={4}>
            <Typography variant="h3">{indexUsage.total}</Typography>
            <Typography variant="body2">总索引数</Typography>
          </Grid>
          <Grid item xs={4}>
            <Typography variant="h3" style={{ color: '#FF9800' }}>
              {indexUsage.unused}
            </Typography>
            <Typography variant="body2">未使用索引</Typography>
          </Grid>
          <Grid item xs={4}>
            <Typography variant="h3" style={{ color: '#4CAF50' }}>
              {indexUsage.total - indexUsage.unused}
            </Typography>
            <Typography variant="body2">活跃索引</Typography>
          </Grid>
        </Grid>
        {indexUsage.unused > 0 && (
          <Alert severity="warning" style={{ marginTop: 10 }}>
            发现 {indexUsage.unused} 个未使用索引，建议删除以节省存储空间
          </Alert>
        )}
      </Card>
    );
  };
  
  return (
    <div>
      <Typography variant="h4" gutterBottom>
        📊 查询优化仪表板
      </Typography>
      
      {renderCacheStats()}
      {renderSlowQueries()}
      {renderSuggestions()}
      {renderIndexUsage()}
    </div>
  );
};

export default QueryOptimizationDashboard;
```

### 8. API 端点

```javascript
// backend/services/admin-service/src/routes/queryOptimization.js
const express = require('express');
const router = express.Router();
const { pool, queryPlanCache, indexAdvisor } = require('../../../shared/db');

/**
 * 获取查询计划缓存统计
 */
router.get('/query-cache/stats', async (req, res) => {
  try {
    const stats = queryPlanCache.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 获取慢查询列表
 */
router.get('/slow-queries', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const query = `
      SELECT 
        query,
        calls,
        total_time,
        mean_time,
        rows,
        100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0) AS hit_percent
      FROM pg_stat_statements
      WHERE mean_time > 1000
      ORDER BY total_time DESC
      LIMIT $1
    `;
    
    const result = await pool.query(query, [limit]);
    res.json({ queries: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 获取优化建议
 */
router.get('/query-suggestions', async (req, res) => {
  try {
    const query = `
      SELECT 
        query_fingerprint,
        suggestion_type,
        severity,
        message,
        suggestion,
        applied,
        created_at
      FROM query_optimization_suggestions
      WHERE applied = false
      ORDER BY 
        CASE severity 
          WHEN 'high' THEN 1 
          WHEN 'medium' THEN 2 
          WHEN 'low' THEN 3 
        END,
        created_at DESC
      LIMIT 100
    `;
    
    const result = await pool.query(query);
    res.json({ suggestions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 获取索引使用情况
 */
router.get('/index-usage', async (req, res) => {
  try {
    const usage = await indexAdvisor.analyzeIndexUsage();
    res.json({
      total: usage.all.length,
      unused: usage.unused.length,
      details: usage.all.slice(0, 50),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 清空查询计划缓存
 */
router.post('/query-cache/clear', async (req, res) => {
  try {
    await queryPlanCache.clearCache();
    res.json({ message: 'Cache cleared successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 标记建议为已应用
 */
router.post('/suggestions/:id/apply', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      'UPDATE query_optimization_suggestions SET applied = true WHERE id = $1',
      [id]
    );
    res.json({ message: 'Suggestion marked as applied' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

## 验收标准

- [ ] 查询计划缓存命中率 ≥ 70%
- [ ] 慢查询（>1s）自动检测并生成优化建议
- [ ] 管理员仪表板实时显示缓存统计和慢查询列表
- [ ] 索引使用率分析功能可用，准确识别未使用索引
- [ ] 优化建议自动发送到 Slack（高优先级）
- [ ] 每日生成查询优化报告
- [ ] 复杂查询（3+ JOIN）执行时间减少 30%
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 管理员 API 端点有适当的权限控制（需 admin 角色）
- [ ] Redis 故障时不影响查询执行（降级到直接查询）
- [ ] 分区表自动创建（每月）
- [ ] 查询执行历史保留 90 天

## 影响范围

### 新增文件
- `backend/shared/QueryPlanCache.js` - 查询计划缓存核心逻辑
- `backend/shared/IndexAdvisor.js` - 索引推荐系统
- `backend/jobs/slowQueryOptimizer.js` - 慢查询优化定时任务
- `database/migrations/20260616_create_query_optimization_tables.sql` - 数据库迁移
- `admin-dashboard/src/components/QueryOptimizationDashboard.js` - 管理仪表板
- `backend/services/admin-service/src/routes/queryOptimization.js` - API 端点

### 修改文件
- `backend/shared/db.js` - 集成查询计划缓存
- `backend/shared/metrics.js` - 新增 Prometheus 指标
- `backend/services/admin-service/src/index.js` - 挂载新路由

### 配置变更
- PostgreSQL: 启用 `pg_stat_statements` 扩展
- Redis: 新增查询计划缓存键空间
- Prometheus: 新增查询优化相关指标

## 参考

- [PostgreSQL Query Plan Caching](https://www.postgresql.org/docs/current/sql-prepare.html)
- [Understanding PostgreSQL Query Plans](https://www.postgresql.org/docs/current/using-explain.html)
- [pg_stat_statements Extension](https://www.postgresql.org/docs/current/pgstatstatements.html)
- [Index Advisor Design Patterns](https://use-the-index-luke.com/)
- [Query Optimization Techniques](https://postgrespro.com/blog/pgsql/5969619)
