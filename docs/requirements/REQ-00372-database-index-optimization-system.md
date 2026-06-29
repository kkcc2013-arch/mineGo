# REQ-00372: 数据库索引智能分析与自动优化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00372 |
| 标题 | 数据库索引智能分析与自动优化系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | postgresql、backend/shared、所有微服务、database/migrations、admin-dashboard、backend/jobs |
| 创建时间 | 2026-06-29 20:00 UTC |

## 需求描述

构建一套数据库索引智能分析与自动优化系统，通过分析 PostgreSQL 慢查询日志、查询执行计划和表统计信息，自动识别索引优化机会，生成索引创建/删除建议，并支持一键执行优化操作。

### 核心目标

1. **慢查询分析**：自动捕获和分析慢查询，识别缺失索引的查询
2. **索引建议生成**：基于查询模式和数据分布，智能生成索引建议
3. **索引健康评估**：检测冗余索引、未使用索引、碎片化索引
4. **自动优化执行**：支持安全地自动创建/删除/重建索引
5. **影响预测**：预估索引变更对查询性能和数据写入的影响

### 应用场景

- 精灵列表查询性能优化（按等级、类型、稀有度筛选）
- 社交关系查询优化（好友列表、排行榜）
- 道馆战斗历史查询优化
- 用户活动日志查询优化
- 精灵交易记录查询优化

## 技术方案

### 1. 慢查询捕获与分析模块

```javascript
// backend/shared/indexOptimizer/SlowQueryCollector.js
const { Pool } = require('pg');
const EventEmitter = require('events');

class SlowQueryCollector extends EventEmitter {
  constructor(config = {}) {
    super();
    this.pool = new Pool(config.database);
    this.slowQueryThreshold = config.slowQueryThreshold || 500; // 500ms
    this.collectionInterval = config.collectionInterval || 60000; // 1分钟
    this.queryBuffer = [];
    this.maxBufferSize = config.maxBufferSize || 10000;
  }

  async initialize() {
    // 启用 pg_stat_statements 扩展
    await this.pool.query(`
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    `);

    // 配置慢查询日志
    await this.pool.query(`
      ALTER SYSTEM SET log_min_duration_statement = ${this.slowQueryThreshold};
      ALTER SYSTEM SET log_statement_stats = on;
    `);

    // 开始定时收集
    this.startCollection();
  }

  startCollection() {
    this.collectionTimer = setInterval(async () => {
      try {
        await this.collectSlowQueries();
      } catch (error) {
        this.emit('error', error);
      }
    }, this.collectionInterval);
  }

  async collectSlowQueries() {
    const result = await this.pool.query(`
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
        shared_blks_read,
        temp_blks_written,
        blk_read_time,
        blk_write_time
      FROM pg_stat_statements
      WHERE mean_exec_time > $1
      ORDER BY total_exec_time DESC
      LIMIT 100
    `, [this.slowQueryThreshold]);

    for (const row of result.rows) {
      const slowQuery = {
        queryId: row.queryid,
        query: this.normalizeQuery(row.query),
        calls: row.calls,
        totalExecTime: row.total_exec_time,
        meanExecTime: row.mean_exec_time,
        minExecTime: row.min_exec_time,
        maxExecTime: row.max_exec_time,
        rows: row.rows,
        cacheHitRatio: this.calculateCacheHitRatio(
          row.shared_blks_hit,
          row.shared_blks_read
        ),
        tempBlocks: row.temp_blks_written,
        readTime: row.blk_read_time,
        writeTime: row.blk_write_time,
        timestamp: Date.now()
      };

      this.queryBuffer.push(slowQuery);
      this.emit('slowQuery', slowQuery);
    }

    // 限制缓冲区大小
    if (this.queryBuffer.length > this.maxBufferSize) {
      this.queryBuffer = this.queryBuffer.slice(-this.maxBufferSize);
    }
  }

  normalizeQuery(query) {
    return query
      .replace(/\$\d+/g, '?')  // 参数化
      .replace(/\d+/g, '?')    // 数字常量
      .replace(/'[^']*'/g, '?') // 字符串常量
      .replace(/\s+/g, ' ')    // 空白字符
      .trim();
  }

  calculateCacheHitRatio(hit, read) {
    const total = hit + read;
    return total > 0 ? (hit / total * 100).toFixed(2) : 100;
  }

  async getQueryPlan(query) {
    try {
      const result = await this.pool.query(`EXPLAIN ANALYZE ${query}`);
      return result.rows.map(r => r['QUERY PLAN']).join('\n');
    } catch (error) {
      return null;
    }
  }

  async getTableStats(tableName) {
    const result = await this.pool.query(`
      SELECT 
        schemaname,
        tablename,
        attname,
        n_distinct,
        correlation,
        most_common_vals,
        most_common_freqs
      FROM pg_stats
      WHERE tablename = $1
    `, [tableName]);

    return result.rows;
  }

  stop() {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }
  }
}

module.exports = { SlowQueryCollector };
```

### 2. 索引建议生成器

```javascript
// backend/shared/indexOptimizer/IndexRecommender.js
class IndexRecommender {
  constructor() {
    this.queryPatternAnalyzer = new QueryPatternAnalyzer();
    this.columnImportanceAnalyzer = new ColumnImportanceAnalyzer();
  }

  async analyzeAndRecommend(slowQuery, tableStats, existingIndexes) {
    const recommendations = [];

    // 解析查询模式
    const pattern = this.queryPatternAnalyzer.analyze(slowQuery.query);
    if (!pattern) return recommendations;

    // 分析列重要性
    const columnImportance = this.columnImportanceAnalyzer.analyze(
      pattern,
      slowQuery,
      tableStats
    );

    // 生成单列索引建议
    for (const col of columnImportance.singleColumnCandidates) {
      const recommendation = await this.generateSingleColumnIndexRecommendation(
        pattern.table,
        col,
        col.cardinality,
        slowQuery.meanExecTime,
        existingIndexes
      );
      if (recommendation) {
        recommendations.push(recommendation);
      }
    }

    // 生成复合索引建议
    if (columnImportance.multiColumnCandidate) {
      const recommendation = await this.generateCompositeIndexRecommendation(
        pattern.table,
        columnImportance.multiColumnCandidate,
        slowQuery.meanExecTime,
        existingIndexes
      );
      if (recommendation) {
        recommendations.push(recommendation);
      }
    }

    // 生成部分索引建议（针对特定条件）
    if (pattern.whereClause && pattern.whereClause.selective) {
      const partialIndex = this.generatePartialIndexRecommendation(
        pattern.table,
        pattern.whereClause,
        slowQuery.meanExecTime
      );
      if (partialIndex) {
        recommendations.push(partialIndex);
      }
    }

    // 按优先级排序
    return recommendations.sort((a, b) => b.priority - a.priority);
  }

  async generateSingleColumnIndexRecommendation(
    tableName,
    column,
    cardinality,
    meanExecTime,
    existingIndexes
  ) {
    // 检查是否已存在该列的索引
    if (existingIndexes.some(idx => 
      idx.table === tableName && 
      idx.columns.length === 1 && 
      idx.columns[0] === column.name
    )) {
      return null;
    }

    // 低基数字段不适合建索引
    if (cardinality < 10) {
      return null;
    }

    const indexName = `idx_${tableName}_${column.name}`;
    const sql = `CREATE INDEX CONCURRENTLY ${indexName} ON ${tableName} (${column.name})`;

    return {
      type: 'CREATE',
      indexName,
      tableName,
      columns: [column.name],
      sql,
      priority: this.calculatePriority(meanExecTime, cardinality),
      reason: `列 '${column.name}' 在慢查询中频繁出现，基数 ${cardinality}，预计可提升查询性能`,
      estimatedImprovement: {
        queryTimeReduction: `${Math.min(meanExecTime * 0.7, 100).toFixed(0)}ms`,
        affectedQueries: 1
      },
      risks: ['索引创建期间可能影响写入性能'],
      safeWindow: '建议在低峰期执行'
    };
  }

  async generateCompositeIndexRecommendation(
    tableName,
    columns,
    meanExecTime,
    existingIndexes
  ) {
    // 检查是否已存在覆盖这些列的索引
    const columnNames = columns.map(c => c.name).sort();
    if (existingIndexes.some(idx => {
      const idxCols = idx.columns.sort();
      return idxCols.join(',') === columnNames.join(',') ||
             idxCols.join(',').startsWith(columnNames.join(','));
    })) {
      return null;
    }

    // 确定列顺序（基数高的放前面）
    const orderedColumns = columns.sort((a, b) => b.cardinality - a.cardinality);
    const columnList = orderedColumns.map(c => c.name).join(', ');
    const indexName = `idx_${tableName}_${orderedColumns.map(c => c.name).join('_')}`;
    const sql = `CREATE INDEX CONCURRENTLY ${indexName} ON ${tableName} (${columnList})`;

    return {
      type: 'CREATE',
      indexName,
      tableName,
      columns: orderedColumns.map(c => c.name),
      sql,
      priority: this.calculatePriority(meanExecTime, columns.reduce((sum, c) => sum + c.cardinality, 0) / columns.length),
      reason: `复合查询条件，多列组合索引可显著提升性能`,
      estimatedImprovement: {
        queryTimeReduction: `${(meanExecTime * 0.8).toFixed(0)}ms`,
        affectedQueries: 1
      },
      risks: ['复合索引占用空间较大', '写入开销增加'],
      safeWindow: '建议在低峰期执行'
    };
  }

  generatePartialIndexRecommendation(tableName, whereClause, meanExecTime) {
    const condition = whereClause.condition;
    const column = whereClause.column;

    const indexName = `idx_${tableName}_${column}_partial`;
    const sql = `CREATE INDEX CONCURRENTLY ${indexName} ON ${tableName} (${column}) WHERE ${condition}`;

    return {
      type: 'CREATE',
      indexName,
      tableName,
      columns: [column],
      sql,
      partial: true,
      condition,
      priority: 75,
      reason: `选择性条件，部分索引可减少索引大小`,
      estimatedImprovement: {
        queryTimeReduction: `${(meanExecTime * 0.6).toFixed(0)}ms`,
        indexSizeReduction: '60-80%'
      },
      risks: ['仅对特定查询有效'],
      safeWindow: '建议在低峰期执行'
    };
  }

  calculatePriority(meanExecTime, cardinality) {
    // 时间越长优先级越高，基数越高优先级越高
    const timeScore = Math.min(meanExecTime / 1000 * 20, 40);
    const cardinalityScore = Math.min(cardinality / 1000 * 20, 40);
    return Math.min(timeScore + cardinalityScore + 20, 100);
  }
}

// 查询模式分析器
class QueryPatternAnalyzer {
  analyze(query) {
    const patterns = {
      select: /SELECT\s+.*?\s+FROM\s+(\w+)/i,
      where: /WHERE\s+(.*?)(?:ORDER|GROUP|LIMIT|$)/i,
      join: /JOIN\s+(\w+)\s+ON\s+(.*?)(?:WHERE|GROUP|ORDER|LIMIT|$)/i,
      orderBy: /ORDER\s+BY\s+(.*?)(?:LIMIT|$)/i,
      groupBy: /GROUP\s+BY\s+(.*?)(?:HAVING|ORDER|LIMIT|$)/i
    };

    const tableMatch = query.match(patterns.select);
    if (!tableMatch) return null;

    const result = {
      table: tableMatch[1],
      whereClause: null,
      joinTables: [],
      orderBy: null,
      groupBy: null,
      queryType: this.detectQueryType(query)
    };

    // 解析 WHERE 子句
    const whereMatch = query.match(patterns.where);
    if (whereMatch) {
      result.whereClause = this.parseWhereClause(whereMatch[1]);
    }

    // 解析 JOIN
    const joinMatches = query.matchAll(patterns.join);
    for (const match of joinMatches) {
      result.joinTables.push({
        table: match[1],
        condition: match[2]
      });
    }

    return result;
  }

  parseWhereClause(whereStr) {
    const conditions = [];
    const operators = ['=', '<', '>', '<=', '>=', '!=', 'LIKE', 'IN', 'BETWEEN'];
    
    // 简化解析：识别列名和操作符
    for (const op of operators) {
      const regex = new RegExp(`(\\w+)\\s*${op}`, 'i');
      const match = whereStr.match(regex);
      if (match) {
        conditions.push({
          column: match[1],
          operator: op,
          original: match[0]
        });
      }
    }

    return {
      original: whereStr,
      conditions,
      selective: conditions.length < 3 // 少量条件通常选择性更高
    };
  }

  detectQueryType(query) {
    if (/INSERT/i.test(query)) return 'INSERT';
    if (/UPDATE/i.test(query)) return 'UPDATE';
    if (/DELETE/i.test(query)) return 'DELETE';
    return 'SELECT';
  }
}

// 列重要性分析器
class ColumnImportanceAnalyzer {
  analyze(pattern, slowQuery, tableStats) {
    const result = {
      singleColumnCandidates: [],
      multiColumnCandidate: null
    };

    // 分析 WHERE 子句中的列
    if (pattern.whereClause) {
      for (const cond of pattern.whereClause.conditions) {
        const stat = tableStats.find(s => s.attname === cond.column);
        if (stat) {
          result.singleColumnCandidates.push({
            name: cond.column,
            cardinality: Math.abs(stat.n_distinct) * 100,
            correlation: stat.correlation,
            operator: cond.operator
          });
        }
      }
    }

    // 如果有多个列，考虑复合索引
    if (result.singleColumnCandidates.length >= 2) {
      result.multiColumnCandidate = result.singleColumnCandidates.slice(0, 4);
    }

    return result;
  }
}

module.exports = { IndexRecommender };
```

### 3. 索引健康评估模块

```javascript
// backend/shared/indexOptimizer/IndexHealthChecker.js
class IndexHealthChecker {
  constructor(pool) {
    this.pool = pool;
  }

  async checkIndexHealth() {
    const report = {
      unusedIndexes: [],
      duplicateIndexes: [],
      fragmentedIndexes: [],
      oversizedIndexes: [],
      recommendations: []
    };

    // 检测未使用的索引
    report.unusedIndexes = await this.findUnusedIndexes();

    // 检测重复索引
    report.duplicateIndexes = await this.findDuplicateIndexes();

    // 检测碎片化索引
    report.fragmentedIndexes = await this.findFragmentedIndexes();

    // 检测过大的索引
    report.oversizedIndexes = await this.findOversizedIndexes();

    // 生成建议
    report.recommendations = this.generateRecommendations(report);

    return report;
  }

  async findUnusedIndexes() {
    const result = await this.pool.query(`
      SELECT
        schemaname,
        relname as table_name,
        indexrelname as index_name,
        idx_scan as scans,
        idx_tup_read as tuples_read,
        idx_tup_fetch as tuples_fetched,
        pg_size_pretty(pg_relation_size(indexrelid)) as index_size
      FROM pg_stat_user_indexes
      WHERE idx_scan = 0
        AND indexrelname NOT LIKE '%_pkey'
      ORDER BY pg_relation_size(indexrelid) DESC
      LIMIT 50
    `);

    return result.rows.map(row => ({
      schema: row.schemaname,
      table: row.table_name,
      indexName: row.index_name,
      scans: row.scans,
      tuplesRead: row.tuples_read,
      tuplesFetched: row.tuples_fetched,
      size: row.index_size,
      recommendation: 'DROP',
      sql: `DROP INDEX CONCURRENTLY ${row.schemaname}.${row.index_name}`,
      reason: '索引从未被使用，占用存储空间',
      priority: 60
    }));
  }

  async findDuplicateIndexes() {
    const result = await this.pool.query(`
      WITH index_info AS (
        SELECT
          schemaname,
          tablename,
          indexname,
          array_agg(attname ORDER BY array_position(indkey, attnum)) as columns,
          pg_relation_size(indexrelid) as size
        FROM pg_indexes
        JOIN pg_attribute ON pg_attribute.attrelid = pg_indexes.indexrelid
        JOIN pg_class ON pg_class.oid = pg_indexes.indexrelid
        WHERE schemaname = 'public'
        GROUP BY schemaname, tablename, indexname, size
      )
      SELECT
        a.schemaname,
        a.tablename,
        a.indexname as index1,
        b.indexname as index2,
        a.columns as columns1,
        b.columns as columns2,
        a.size as size1,
        b.size as size2
      FROM index_info a
      JOIN index_info b ON a.tablename = b.tablename AND a.indexname < b.indexname
      WHERE a.columns = b.columns
         OR a.columns <@ b.columns
      ORDER BY a.size + b.size DESC
    `);

    return result.rows.map(row => ({
      schema: row.schemaname,
      table: row.tablename,
      index1: row.index1,
      index2: row.index2,
      columns1: row.columns1,
      columns2: row.columns2,
      size1: row.size1,
      size2: row.size2,
      recommendation: 'DROP',
      sql: `DROP INDEX CONCURRENTLY ${row.schemaname}.${row.index1}`,
      reason: `索引 '${row.index1}' 被 '${row.index2}' 覆盖`,
      priority: 70
    }));
  }

  async findFragmentedIndexes() {
    const result = await this.pool.query(`
      SELECT
        schemaname,
        tablename,
        indexname,
        pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
        100 - (idx_scan::float / NULLIF(idx_tup_read, 0) * 100) as fragmentation_ratio
      FROM pg_stat_user_indexes
      WHERE pg_relation_size(indexrelid) > 10 * 1024 * 1024
        AND idx_scan > 0
        AND idx_tup_read > 0
      ORDER BY fragmentation_ratio DESC
      LIMIT 20
    `);

    return result.rows.filter(row => row.fragmentation_ratio > 30).map(row => ({
      schema: row.schemaname,
      table: row.tablename,
      indexName: row.indexname,
      size: row.index_size,
      fragmentationRatio: row.fragmentation_ratio,
      recommendation: 'REINDEX',
      sql: `REINDEX INDEX CONCURRENTLY ${row.schemaname}.${row.indexname}`,
      reason: `索引碎片率 ${row.fragmentation_ratio.toFixed(1)}%，建议重建`,
      priority: 50
    }));
  }

  async findOversizedIndexes() {
    const result = await this.pool.query(`
      SELECT
        schemaname,
        tablename,
        indexname,
        pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
        pg_size_pretty(pg_relation_size(tablerelid)) as table_size,
        pg_relation_size(indexrelid)::float / NULLIF(pg_relation_size(tablerelid), 0) as ratio
      FROM pg_stat_user_indexes
      WHERE pg_relation_size(indexrelid) > 100 * 1024 * 1024
      ORDER BY ratio DESC
      LIMIT 20
    `);

    return result.rows.filter(row => row.ratio > 0.3).map(row => ({
      schema: row.schemaname,
      table: row.tablename,
      indexName: row.indexname,
      indexSize: row.index_size,
      tableSize: row.table_size,
      ratio: row.ratio,
      recommendation: 'REVIEW',
      reason: `索引大小 ${row.index_size}，占表大小 ${(row.ratio * 100).toFixed(1)}%，建议审查是否必要`,
      priority: 40
    }));
  }

  generateRecommendations(report) {
    const recommendations = [];

    // 未使用索引 - 可安全删除
    for (const idx of report.unusedIndexes.slice(0, 10)) {
      recommendations.push({
        action: 'DROP_INDEX',
        index: idx,
        priority: idx.priority
      });
    }

    // 重复索引 - 删除较小的
    for (const idx of report.duplicateIndexes.slice(0, 5)) {
      recommendations.push({
        action: 'DROP_DUPLICATE',
        index: idx,
        priority: idx.priority
      });
    }

    // 碎片化索引 - 重建
    for (const idx of report.fragmentedIndexes.slice(0, 5)) {
      recommendations.push({
        action: 'REINDEX',
        index: idx,
        priority: idx.priority
      });
    }

    return recommendations.sort((a, b) => b.priority - a.priority);
  }
}

module.exports = { IndexHealthChecker };
```

### 4. 自动优化执行器

```javascript
// backend/shared/indexOptimizer/IndexOptimizationExecutor.js
class IndexOptimizationExecutor {
  constructor(pool, config = {}) {
    this.pool = pool;
    this.config = {
      maxConcurrentOperations: config.maxConcurrentOperations || 1,
      executionWindow: config.executionWindow || { start: 2, end: 6 }, // 2:00-6:00 AM
      dryRun: config.dryRun !== false,
      notificationWebhook: config.notificationWebhook
    };
    this.executionLog = [];
  }

  async executeOptimization(recommendation) {
    // 检查执行窗口
    if (!this.isInExecutionWindow()) {
      return {
        success: false,
        reason: '当前不在执行窗口内',
        recommendation
      };
    }

    // 检查数据库负载
    const loadCheck = await this.checkDatabaseLoad();
    if (!loadCheck.safe) {
      return {
        success: false,
        reason: `数据库负载过高: ${loadCheck.reason}`,
        recommendation
      };
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      recommendation,
      status: 'STARTED',
      sql: recommendation.sql
    };

    try {
      if (this.config.dryRun) {
        logEntry.status = 'DRY_RUN';
        logEntry.result = '模拟执行成功（dry-run 模式）';
      } else {
        // 实际执行
        await this.pool.query('SET statement_timeout = 3600000'); // 1小时超时
        const result = await this.pool.query(recommendation.sql);
        
        logEntry.status = 'COMPLETED';
        logEntry.result = result;
        logEntry.duration = Date.now() - new Date(logEntry.timestamp).getTime();
      }

      this.executionLog.push(logEntry);
      await this.notifyExecution(logEntry);

      return {
        success: true,
        log: logEntry
      };
    } catch (error) {
      logEntry.status = 'FAILED';
      logEntry.error = error.message;
      this.executionLog.push(logEntry);
      await this.notifyExecution(logEntry);

      return {
        success: false,
        error: error.message,
        log: logEntry
      };
    }
  }

  isInExecutionWindow() {
    const now = new Date();
    const hour = now.getHours();
    const { start, end } = this.config.executionWindow;
    return hour >= start && hour < end;
  }

  async checkDatabaseLoad() {
    const result = await this.pool.query(`
      SELECT
        count(*) as active_connections,
        (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') as active_queries,
        (SELECT avg(extract(epoch from now() - query_start)) 
         FROM pg_stat_activity 
         WHERE state = 'active' AND query_start < now() - interval '10 seconds') as avg_query_age
      FROM pg_stat_activity
    `);

    const stats = result.rows[0];

    // 活跃连接数检查
    if (parseInt(stats.active_connections) > 50) {
      return { safe: false, reason: `活跃连接数过高: ${stats.active_connections}` };
    }

    // 活跃查询数检查
    if (parseInt(stats.active_queries) > 20) {
      return { safe: false, reason: `活跃查询数过高: ${stats.active_queries}` };
    }

    return { safe: true };
  }

  async notifyExecution(logEntry) {
    if (!this.config.notificationWebhook) return;

    try {
      const axios = require('axios');
      await axios.post(this.config.notificationWebhook, {
        text: `索引优化执行: ${logEntry.status}`,
        attachments: [{
          color: logEntry.status === 'COMPLETED' ? 'good' : 'danger',
          fields: [
            { title: '操作', value: logEntry.recommendation.type, short: true },
            { title: '状态', value: logEntry.status, short: true },
            { title: 'SQL', value: `\`\`\`${logEntry.sql}\`\`\``, short: false },
            ...(logEntry.error ? [{ title: '错误', value: logEntry.error, short: false }] : [])
          ]
        }]
      });
    } catch (error) {
      console.error('通知发送失败:', error.message);
    }
  }

  getExecutionLog(limit = 100) {
    return this.executionLog.slice(-limit);
  }
}

module.exports = { IndexOptimizationExecutor };
```

### 5. 定时优化任务

```javascript
// backend/jobs/indexOptimizationJob.js
const { SlowQueryCollector } = require('../shared/indexOptimizer/SlowQueryCollector');
const { IndexRecommender } = require('../shared/indexOptimizer/IndexRecommender');
const { IndexHealthChecker } = require('../shared/indexOptimizer/IndexHealthChecker');
const { IndexOptimizationExecutor } = require('../shared/indexOptimizer/IndexOptimizationExecutor');

class IndexOptimizationJob {
  constructor(config) {
    this.slowQueryCollector = new SlowQueryCollector(config);
    this.indexRecommender = new IndexRecommender();
    this.healthChecker = new IndexHealthChecker(config.database);
    this.executor = new IndexOptimizationExecutor(config.database, config.executor);
  }

  async run() {
    console.log('开始索引优化任务...');
    
    // 1. 收集慢查询
    console.log('收集慢查询...');
    await this.slowQueryCollector.collectSlowQueries();
    
    // 2. 检查索引健康状态
    console.log('检查索引健康状态...');
    const healthReport = await this.healthChecker.checkIndexHealth();
    console.log(`发现 ${healthReport.unusedIndexes.length} 个未使用索引`);
    console.log(`发现 ${healthReport.duplicateIndexes.length} 个重复索引`);
    console.log(`发现 ${healthReport.fragmentedIndexes.length} 个碎片化索引`);
    
    // 3. 生成优化建议
    const recommendations = [];
    
    // 添加健康检查建议
    recommendations.push(...healthReport.recommendations);
    
    // 4. 执行优化（如果在窗口内）
    const results = [];
    for (const rec of recommendations.slice(0, 5)) { // 每次最多执行5个优化
      const result = await this.executor.executeOptimization(rec);
      results.push(result);
      
      // 如果执行失败，暂停后续执行
      if (!result.success && result.error) {
        console.error('优化执行失败:', result.error);
        break;
      }
    }
    
    console.log('索引优化任务完成');
    return {
      healthReport,
      recommendations,
      executionResults: results
    };
  }
}

// 定时任务入口
async function main() {
  const job = new IndexOptimizationJob({
    database: {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    },
    slowQueryThreshold: 500,
    executor: {
      dryRun: process.env.INDEX_OPT_DRY_RUN !== 'false',
      executionWindow: { start: 2, end: 6 }
    }
  });
  
  const result = await job.run();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { IndexOptimizationJob };
```

### 6. Admin Dashboard API

```javascript
// backend/routes/admin/indexOptimization.js
const express = require('express');
const router = express.Router();
const { SlowQueryCollector } = require('../../shared/indexOptimizer/SlowQueryCollector');
const { IndexHealthChecker } = require('../../shared/indexOptimizer/IndexHealthChecker');

// 获取慢查询列表
router.get('/slow-queries', async (req, res) => {
  try {
    const collector = new SlowQueryCollector(req.app.locals.dbConfig);
    const slowQueries = collector.queryBuffer.slice(-100);
    res.json({ success: true, data: slowQueries });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取索引健康报告
router.get('/health', async (req, res) => {
  try {
    const checker = new IndexHealthChecker(req.app.locals.pool);
    const report = await checker.checkIndexHealth();
    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取执行日志
router.get('/logs', async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const logs = req.app.locals.indexOptimizer.getExecutionLog(parseInt(limit));
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

## 验收标准

- [ ] 慢查询捕获率 > 95%，能正确解析复杂 SQL
- [ ] 索引建议生成准确率 > 80%，经 DBA 审核确认
- [ ] 能检测出未使用索引、重复索引、碎片化索引
- [ ] 执行优化时数据库负载检查通过
- [ ] 支持 dry-run 模式，不实际执行 SQL
- [ ] 优化执行窗口可配置（默认凌晨 2-6 点）
- [ ] 执行结果通知推送到 Slack/Email
- [ ] Admin Dashboard 可查看慢查询、健康报告、执行日志
- [ ] 执行操作有完整审计日志
- [ ] 所有索引操作使用 CONCURRENTLY，避免锁表

## 影响范围

### 新增文件
- `backend/shared/indexOptimizer/SlowQueryCollector.js`
- `backend/shared/indexOptimizer/IndexRecommender.js`
- `backend/shared/indexOptimizer/IndexHealthChecker.js`
- `backend/shared/indexOptimizer/IndexOptimizationExecutor.js`
- `backend/jobs/indexOptimizationJob.js`
- `backend/routes/admin/indexOptimization.js`
- `backend/tests/unit/indexOptimizer/*.test.js`
- `backend/tests/integration/indexOptimizer.test.js`

### 修改文件
- `backend/shared/index.js` - 导出索引优化模块
- `backend/jobs/index.js` - 添加定时任务
- `admin-dashboard/src/pages/DatabaseHealth.js` - 新增管理页面

### 数据库依赖
- 需启用 `pg_stat_statements` 扩展
- 需配置 `log_min_duration_statement` 参数
- 建议配置 `shared_preload_libraries = 'pg_stat_statements'`

## 参考

- [PostgreSQL Index Documentation](https://www.postgresql.org/docs/current/indexes.html)
- [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html)
- [Index Optimization Best Practices](https://use-the-index-luke.com/)
