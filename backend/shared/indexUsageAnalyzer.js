/**
 * backend/shared/indexUsageAnalyzer.js
 * REQ-00077: 数据库慢查询分析与自动优化建议系统
 * 索引使用率分析器
 */

'use strict';

const logger = require('./logger');
const { incrementCounter, setGauge } = require('./metrics');

class IndexUsageAnalyzer {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * 分析所有索引使用情况
   */
  async analyze() {
    try {
      const indexStats = await this.getIndexStats();
      const unusedIndexes = await this.findUnusedIndexes(indexStats);
      const duplicateIndexes = await this.findDuplicateIndexes();
      const suggestedIndexes = await this.findSuggestedIndexes();
      const indexBloat = await this.analyzeIndexBloat();

      // 上报指标
      this.reportMetrics(indexStats, unusedIndexes);

      return {
        totalIndexes: indexStats.length,
        usedIndexes: indexStats.filter(i => i.idx_scan > 0).length,
        unusedIndexes: unusedIndexes.length,
        duplicateIndexes: duplicateIndexes.length,
        suggestedIndexes: suggestedIndexes.length,
        bloatedIndexes: indexBloat.length,
        details: {
          indexStats: indexStats.slice(0, 50), // 限制输出
          unusedIndexes,
          duplicateIndexes,
          suggestedIndexes,
          indexBloat
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Index analysis failed', { error: error.message });
      throw error;
    }
  }

  /**
   * 获取索引统计信息
   */
  async getIndexStats() {
    const result = await this.pool.query(`
      SELECT
        schemaname,
        relname as table_name,
        indexrelname as index_name,
        idx_scan as index_scans,
        idx_tup_read as tuples_read,
        idx_tup_fetch as tuples_fetched,
        pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
        pg_relation_size(indexrelid) as index_size_bytes
      FROM pg_stat_user_indexes
      ORDER BY idx_scan DESC, pg_relation_size(indexrelid) DESC
    `);

    return result.rows;
  }

  /**
   * 查找未使用的索引
   */
  async findUnusedIndexes(indexStats) {
    // 扫描次数为 0 的索引
    const unusedByScan = indexStats.filter(i => i.idx_scan === 0);

    // 检查是否是约束索引（主键、唯一约束等）
    const constraintIndexes = await this.getConstraintIndexes();
    const constraintIndexNames = new Set(constraintIndexes.map(i => i.index_name));

    return unusedByScan.filter(i => {
      // 排除约束索引，这些不能删除
      return !constraintIndexNames.has(i.index_name);
    }).map(i => ({
      tableName: i.table_name,
      indexName: i.index_name,
      indexSize: i.index_size,
      indexSizeBytes: i.index_size_bytes,
      reason: 'Never used (0 scans)',
      recommendation: 'Consider dropping to save space'
    }));
  }

  /**
   * 获取约束索引
   */
  async getConstraintIndexes() {
    const result = await this.pool.query(`
      SELECT
        tc.table_name,
        kcu.column_name,
        tc.constraint_name as index_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    `);

    return result.rows;
  }

  /**
   * 查找重复索引
   */
  async findDuplicateIndexes() {
    try {
      const result = await this.pool.query(`
        SELECT
          idx1.relname as index1_name,
          idx2.relname as index2_name,
          tbl.relname as table_name,
          pg_size_pretty(pg_relation_size(idx1.oid)) as index1_size,
          pg_size_pretty(pg_relation_size(idx2.oid)) as index2_size
        FROM pg_index i1
        JOIN pg_class idx1 ON idx1.oid = i1.indexrelid
        JOIN pg_class tbl ON tbl.oid = i1.indrelid
        JOIN pg_index i2 ON i2.indrelid = i1.indrelid AND i2.indexrelid != i1.indexrelid
        JOIN pg_class idx2 ON idx2.oid = i2.indexrelid
        WHERE i1.indkey = i2.indkey
          AND idx1.relname < idx2.relname
      `);

      return result.rows.map(r => ({
        tableName: r.table_name,
        index1Name: r.index1_name,
        index1Size: r.index1_size,
        index2Name: r.index2_name,
        index2Size: r.index2_size,
        recommendation: 'Consider dropping the redundant index'
      }));
    } catch (error) {
      logger.warn('Could not find duplicate indexes', { error: error.message });
      return [];
    }
  }

  /**
   * 查找建议的索引（基于慢查询）
   */
  async findSuggestedIndexes() {
    try {
      // 从 pg_stat_statements 查找未使用索引的频繁查询
      const result = await this.pool.query(`
        SELECT 
          queryid,
          query,
          calls,
          total_exec_time as total_time
        FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_stat%'
          AND query NOT LIKE '%information_schema%'
          AND query NOT LIKE '%pg_catalog%'
        ORDER BY total_exec_time DESC
        LIMIT 20
      `);

      // 简化分析：查找 WHERE 子句中可能的列
      const suggestions = [];
      
      for (const row of result.rows) {
        const whereMatch = row.query.match(/WHERE\s+(\w+)\s*=/i);
        const joinMatch = row.query.match(/JOIN\s+\w+\s+\w+\s+ON\s+\w+\.(\w+)\s*=/i);
        
        if (whereMatch) {
          suggestions.push({
            queryId: row.queryid,
            columnSuggestion: whereMatch[1],
            reason: `Frequent filter on column (${row.calls} calls)`,
            totalTime: row.total_time
          });
        }
        
        if (joinMatch) {
          suggestions.push({
            queryId: row.queryid,
            columnSuggestion: joinMatch[1],
            reason: `Frequent join on column (${row.calls} calls)`,
            totalTime: row.total_time
          });
        }
      }

      // 去重并按总时间排序
      const uniqueSuggestions = [];
      const seen = new Set();
      
      for (const s of suggestions.sort((a, b) => b.totalTime - a.totalTime)) {
        if (!seen.has(s.columnSuggestion)) {
          seen.add(s.columnSuggestion);
          uniqueSuggestions.push(s);
        }
      }

      return uniqueSuggestions.slice(0, 10);
    } catch (error) {
      logger.warn('Could not find suggested indexes', { error: error.message });
      return [];
    }
  }

  /**
   * 分析索引膨胀
   */
  async analyzeIndexBloat() {
    try {
      const result = await this.pool.query(`
        SELECT
          current_database() as database,
          schemaname,
          tablename,
          indexname,
          pg_size_pretty(pg_relation_size(indexname::regclass)) as index_size,
          idx_scan as index_scans,
          idx_tup_read as tuples_read,
          CASE 
            WHEN idx_scan = 0 THEN 'UNUSED'
            WHEN idx_scan < 10 THEN 'RARELY_USED'
            ELSE 'ACTIVELY_USED'
          END as usage_status
        FROM pg_stat_user_indexes
        WHERE pg_relation_size(indexname::regclass) > 1024 * 1024
        ORDER BY pg_relation_size(indexname::regclass) DESC
        LIMIT 20
      `);

      return result.rows.filter(r => r.usage_status !== 'ACTIVELY_USED').map(r => ({
        tableName: r.tablename,
        indexName: r.indexname,
        indexSize: r.index_size,
        usageStatus: r.usage_status,
        scans: r.index_scans,
        recommendation: 'Large index with low usage - consider reviewing'
      }));
    } catch (error) {
      logger.warn('Could not analyze index bloat', { error: error.message });
      return [];
    }
  }

  /**
   * 上报 Prometheus 指标
   */
  reportMetrics(indexStats, unusedIndexes) {
    // 总索引数
    setGauge('database_index_total_count', indexStats.length);
    
    // 未使用索引数
    setGauge('database_index_unused_count', unusedIndexes.length);
    
    // 按表统计索引使用率
    const tableStats = {};
    for (const idx of indexStats) {
      if (!tableStats[idx.table_name]) {
        tableStats[idx.table_name] = { total: 0, used: 0 };
      }
      tableStats[idx.table_name].total++;
      if (idx.idx_scan > 0) {
        tableStats[idx.table_name].used++;
      }
    }
    
    for (const [table, stats] of Object.entries(tableStats)) {
      const ratio = stats.used / stats.total;
      setGauge('database_index_usage_ratio', ratio, { table });
    }

    // 增加分析计数
    incrementCounter('database_index_analysis_total');
  }

  /**
   * 生成索引优化报告
   */
  generateReport(analysis) {
    let report = '=== Database Index Analysis Report ===\n\n';

    report += `Generated: ${analysis.timestamp}\n\n`;
    
    report += '## Summary\n';
    report += `- Total Indexes: ${analysis.totalIndexes}\n`;
    report += `- Used Indexes: ${analysis.usedIndexes} (${(analysis.usedIndexes / analysis.totalIndexes * 100).toFixed(1)}%)\n`;
    report += `- Unused Indexes: ${analysis.unusedIndexes}\n`;
    report += `- Duplicate Indexes: ${analysis.duplicateIndexes}\n`;
    report += `- Bloated Indexes: ${analysis.bloatedIndexes}\n\n`;

    if (analysis.details.unusedIndexes.length > 0) {
      report += '## Unused Indexes (Candidates for Removal)\n';
      for (const idx of analysis.details.unusedIndexes) {
        report += `  - ${idx.tableName}.${idx.indexName} (${idx.indexSize})\n`;
        report += `    Reason: ${idx.reason}\n`;
      }
      report += '\n';
    }

    if (analysis.details.duplicateIndexes.length > 0) {
      report += '## Duplicate Indexes\n';
      for (const dup of analysis.details.duplicateIndexes) {
        report += `  - ${dup.tableName}: ${dup.index1Name} (${dup.index1Size}) duplicates ${dup.index2Name} (${dup.index2Size})\n`;
      }
      report += '\n';
    }

    if (analysis.details.suggestedIndexes.length > 0) {
      report += '## Suggested Indexes\n';
      for (const sug of analysis.details.suggestedIndexes) {
        report += `  - Column: ${sug.columnSuggestion}\n`;
        report += `    Reason: ${sug.reason}\n`;
      }
      report += '\n';
    }

    if (analysis.details.indexBloat.length > 0) {
      report += '## Index Bloat (Large & Low Usage)\n';
      for (const bloat of analysis.details.indexBloat) {
        report += `  - ${bloat.tableName}.${bloat.indexName} (${bloat.indexSize})\n`;
        report += `    Status: ${bloat.usageStatus}\n`;
      }
      report += '\n';
    }

    return report;
  }

  /**
   * 获取特定表的索引信息
   */
  async getTableIndexes(tableName) {
    const result = await this.pool.query(`
      SELECT
        indexrelname as index_name,
        idx_scan as index_scans,
        idx_tup_read as tuples_read,
        idx_tup_fetch as tuples_fetched,
        pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
        pg_get_indexdef(indexrelid) as index_definition
      FROM pg_stat_user_indexes
      WHERE relname = $1
      ORDER BY idx_scan DESC
    `, [tableName]);

    return result.rows;
  }

  /**
   * 生成索引创建建议 SQL
   */
  generateIndexCreationSQL(suggestions) {
    const sqlStatements = [];
    
    for (const sug of suggestions) {
      sqlStatements.push({
        column: sug.columnSuggestion,
        sql: `-- Consider adding index on column: ${sug.columnSuggestion}
-- Reason: ${sug.reason}
-- CREATE INDEX idx_${sug.columnSuggestion} ON table_name (${sug.columnSuggestion});`
      });
    }

    return sqlStatements;
  }

  /**
   * 生成索引删除建议 SQL
   */
  generateIndexDropSQL(unusedIndexes) {
    return unusedIndexes.map(idx => ({
      tableName: idx.tableName,
      indexName: idx.indexName,
      sql: `-- Consider dropping unused index
-- DROP INDEX IF EXISTS ${idx.indexName};
-- Reason: ${idx.reason} (${idx.indexSize})`
    }));
  }
}

module.exports = IndexUsageAnalyzer;
