/**
 * backend/shared/queryAnalyzer.js
 * REQ-00063: 数据库慢查询分析与自动优化建议系统
 * 查询分析引擎
 */

'use strict';

const logger = require('./logger');

class QueryAnalyzer {
  constructor() {
    this.analysisRules = [
      this.checkMissingIndex.bind(this),
      this.checkFullTableScan.bind(this),
      this.checkInefficientJoin.bind(this),
      this.checkMissingWhereClause.bind(this),
      this.checkSelectStar.bind(this),
      this.checkOrCondition.bind(this),
      this.checkLikePattern.bind(this),
      this.checkOrderByWithoutIndex.bind(this),
      this.checkSubquery.bind(this),
      this.checkDistinct.bind(this)
    ];
  }

  /**
   * 分析查询
   * @param {Object} query - 查询对象
   * @param {Object} explainResult - EXPLAIN ANALYZE 结果
   * @returns {Object} 分析结果
   */
  async analyze(query, explainResult) {
    const issues = [];
    const suggestions = [];
    
    // 运行所有分析规则
    for (const rule of this.analysisRules) {
      try {
        const result = await rule(query, explainResult);
        if (result) {
          issues.push(result.issue);
          suggestions.push(result.suggestion);
        }
      } catch (error) {
        logger.warn('Analysis rule failed', { 
          rule: rule.name, 
          error: error.message 
        });
      }
    }
    
    return {
      queryId: query.queryid || query.query_id,
      queryText: query.query || query.query_text,
      issues,
      suggestions,
      severity: this.calculateSeverity(issues),
      analyzedAt: new Date()
    };
  }

  /**
   * 检查缺失索引
   */
  checkMissingIndex(query, explainResult) {
    const planStr = JSON.stringify(explainResult);
    const queryText = query.query || query.query_text || '';
    const meanTime = query.mean_time || query.mean_time_ms || 0;
    
    // 检查 EXPLAIN 中的 Seq Scan
    if (planStr.includes('Seq Scan') && meanTime > 500) {
      // 提取表名
      const tableMatch = queryText.match(/FROM\s+(\w+)/i);
      const tableName = tableMatch ? tableMatch[1] : 'unknown';
      
      // 提取 WHERE 条件中的列
      const whereMatch = queryText.match(/WHERE\s+(.+?)(?:ORDER|GROUP|LIMIT|$)/i);
      const whereClause = whereMatch ? whereMatch[1] : '';
      const columns = this.extractColumns(whereClause);
      
      return {
        issue: {
          type: 'missing_index',
          severity: 'high',
          table: tableName,
          columns: columns,
          impact: `Sequential scan on ${tableName}, avg ${meanTime}ms`
        },
        suggestion: {
          type: 'create_index',
          sql: this.generateIndexSQL(tableName, columns),
          reason: 'Add index to avoid full table scan',
          estimatedImprovement: '70-90% query time reduction'
        }
      };
    }
    return null;
  }

  /**
   * 检查全表扫描
   */
  checkFullTableScan(query, explainResult) {
    const planStr = JSON.stringify(explainResult);
    const rows = query.rows || query.rows_affected || 0;
    
    // 检查大表全表扫描
    if (planStr.includes('Seq Scan') && rows > 10000) {
      return {
        issue: {
          type: 'full_table_scan',
          severity: 'critical',
          rowsScanned: rows,
          impact: `Scanning ${rows} rows without filter`
        },
        suggestion: {
          type: 'add_where_clause',
          reason: 'Add WHERE clause to limit scanned rows',
          estimatedImprovement: '90%+ row reduction'
        }
      };
    }
    return null;
  }

  /**
   * 检查低效 JOIN
   */
  checkInefficientJoin(query, explainResult) {
    const planStr = JSON.stringify(explainResult);
    const queryText = query.query || query.query_text || '';
    const meanTime = query.mean_time || query.mean_time_ms || 0;
    
    // 检查 Nested Loop 在大表上的使用
    if (planStr.includes('Nested Loop') && meanTime > 1000) {
      const joinCount = (queryText.match(/JOIN/gi) || []).length;
      
      if (joinCount > 2) {
        return {
          issue: {
            type: 'inefficient_join',
            severity: 'medium',
            joinCount,
            impact: 'Multiple joins causing performance degradation'
          },
          suggestion: {
            type: 'optimize_join',
            reason: 'Consider denormalization or materialized view',
            estimatedImprovement: '50-70% query time reduction'
          }
        };
      }
    }
    return null;
  }

  /**
   * 检查缺失 WHERE 子句
   */
  checkMissingWhereClause(query) {
    const queryText = query.query || query.query_text || '';
    
    // 检查没有 WHERE 子句的查询
    if (!queryText.match(/WHERE/i) && 
        (queryText.match(/SELECT/i) && queryText.match(/FROM/i))) {
      return {
        issue: {
          type: 'missing_where_clause',
          severity: 'high',
          impact: 'Query without filter conditions'
        },
        suggestion: {
          type: 'add_filter',
          reason: 'Add WHERE clause to limit result set',
          estimatedImprovement: 'Variable, depends on data volume'
        }
      };
    }
    return null;
  }

  /**
   * 检查 SELECT *
   */
  checkSelectStar(query) {
    const queryText = query.query || query.query_text || '';
    
    // 检查 SELECT *
    if (queryText.match(/SELECT\s+\*\s+FROM/i)) {
      return {
        issue: {
          type: 'select_star',
          severity: 'medium',
          impact: 'Fetching all columns unnecessarily'
        },
        suggestion: {
          type: 'explicit_columns',
          reason: 'Specify required columns instead of SELECT *',
          estimatedImprovement: '20-40% bandwidth reduction'
        }
      };
    }
    return null;
  }

  /**
   * 检查 OR 条件
   */
  checkOrCondition(query) {
    const queryText = query.query || query.query_text || '';
    const meanTime = query.mean_time || query.mean_time_ms || 0;
    
    // 检查 OR 条件可能导致索引失效
    const orCount = (queryText.match(/\bOR\b/gi) || []).length;
    
    if (orCount > 2 && meanTime > 500) {
      return {
        issue: {
          type: 'or_condition',
          severity: 'medium',
          orCount,
          impact: 'OR conditions may prevent index usage'
        },
        suggestion: {
          type: 'use_union',
          sql: this.suggestUnion(queryText),
          reason: 'Convert OR to UNION for better index utilization',
          estimatedImprovement: '50-80% query time reduction'
        }
      };
    }
    return null;
  }

  /**
   * 检查 LIKE 前导通配符
   */
  checkLikePattern(query) {
    const queryText = query.query || query.query_text || '';
    
    // 检查 LIKE '%pattern%' 导致索引失效
    if (queryText.match(/LIKE\s+['"]%/i)) {
      return {
        issue: {
          type: 'leading_wildcard',
          severity: 'medium',
          impact: 'Leading wildcard prevents index usage'
        },
        suggestion: {
          type: 'use_full_text_search',
          reason: 'Consider PostgreSQL full-text search or trigram index',
          estimatedImprovement: '60-80% search improvement'
        }
      };
    }
    return null;
  }

  /**
   * 检查 ORDER BY 无索引
   */
  checkOrderByWithoutIndex(query, explainResult) {
    const planStr = JSON.stringify(explainResult);
    const queryText = query.query || query.query_text || '';
    
    // 检查 filesort
    if (planStr.includes('Sort') && queryText.match(/ORDER BY/i)) {
      const orderMatch = queryText.match(/ORDER\s+BY\s+(\w+)/i);
      const orderColumn = orderMatch ? orderMatch[1] : 'unknown';
      
      return {
        issue: {
          type: 'orderby_without_index',
          severity: 'medium',
          column: orderColumn,
          impact: 'In-memory sort operation'
        },
        suggestion: {
          type: 'add_orderby_index',
          sql: `CREATE INDEX idx_${orderColumn} ON table_name (${orderColumn})`,
          reason: 'Add index on ORDER BY column',
          estimatedImprovement: '40-60% sort time reduction'
        }
      };
    }
    return null;
  }

  /**
   * 检查子查询
   */
  checkSubquery(query) {
    const queryText = query.query || query.query_text || '';
    const meanTime = query.mean_time || query.mean_time_ms || 0;
    
    // 检查子查询
    const subqueryCount = (queryText.match(/\(SELECT/gi) || []).length;
    
    if (subqueryCount > 1 && meanTime > 1000) {
      return {
        issue: {
          type: 'subquery',
          severity: 'medium',
          subqueryCount,
          impact: 'Multiple nested subqueries'
        },
        suggestion: {
          type: 'use_join',
          reason: 'Convert subqueries to JOINs for better performance',
          estimatedImprovement: '30-50% query time reduction'
        }
      };
    }
    return null;
  }

  /**
   * 检查 DISTINCT
   */
  checkDistinct(query) {
    const queryText = query.query || query.query_text || '';
    const meanTime = query.mean_time || query.mean_time_ms || 0;
    
    // 检查 DISTINCT 可能导致的性能问题
    if (queryText.match(/DISTINCT/i) && meanTime > 500) {
      return {
        issue: {
          type: 'distinct_overhead',
          severity: 'low',
          impact: 'DISTINCT operation requires sorting/hashing'
        },
        suggestion: {
          type: 'check_duplicate_data',
          reason: 'Ensure DISTINCT is necessary, consider EXISTS instead',
          estimatedImprovement: '10-30% overhead reduction'
        }
      };
    }
    return null;
  }

  /**
   * 提取 WHERE 子句中的列名
   */
  extractColumns(whereClause) {
    const columnPattern = /(\w+)\s*(?:=|>|<|>=|<=|LIKE|IN)/gi;
    const columns = [];
    let match;
    
    while ((match = columnPattern.exec(whereClause)) !== null) {
      if (!columns.includes(match[1])) {
        columns.push(match[1]);
      }
    }
    
    return columns;
  }

  /**
   * 生成索引创建 SQL
   */
  generateIndexSQL(tableName, columns) {
    if (columns.length === 0) {
      return `-- Cannot generate index: no columns detected`;
    }
    
    const indexName = `idx_${tableName}_${columns.join('_')}`;
    return `CREATE INDEX ${indexName} ON ${tableName} (${columns.join(', ')})`;
  }

  /**
   * 建议 UNION 替代 OR
   */
  suggestUnion(query) {
    return `-- Consider converting OR conditions to UNION:
-- SELECT ... WHERE condition1
-- UNION
-- SELECT ... WHERE condition2`;
  }

  /**
   * 计算严重程度
   */
  calculateSeverity(issues) {
    if (issues.some(i => i.severity === 'critical')) return 'critical';
    if (issues.some(i => i.severity === 'high')) return 'high';
    if (issues.some(i => i.severity === 'medium')) return 'medium';
    return 'low';
  }
}

module.exports = QueryAnalyzer;