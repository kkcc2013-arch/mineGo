// backend/shared/indexOptimizer/IndexRecommender.js
'use strict';

const { createLogger } = require('../logger');

const logger = createLogger('index-recommender');

/**
 * 索引建议生成器
 * 基于查询模式和数据分布生成智能索引建议
 */
class IndexRecommender {
  constructor() {
    this.patternAnalyzer = new QueryPatternAnalyzer();
    this.columnAnalyzer = new ColumnImportanceAnalyzer();
  }

  /**
   * 分析慢查询并生成索引建议
   */
  async analyzeAndRecommend(slowQuery, tableStats, existingIndexes) {
    const recommendations = [];
    
    try {
      // 解析查询模式
      const pattern = this.patternAnalyzer.analyze(slowQuery.query);
      if (!pattern || !pattern.table) {
        return recommendations;
      }
      
      // 分析列重要性
      const columnImportance = this.columnAnalyzer.analyze(pattern, slowQuery, tableStats);
      
      // 生成单列索引建议
      for (const col of columnImportance.singleColumnCandidates) {
        const recommendation = this.generateSingleColumnIndexRecommendation(
          pattern.table,
          col,
          slowQuery,
          existingIndexes
        );
        if (recommendation) {
          recommendations.push(recommendation);
        }
      }
      
      // 生成复合索引建议
      if (columnImportance.multiColumnCandidate && columnImportance.multiColumnCandidate.length >= 2) {
        const recommendation = this.generateCompositeIndexRecommendation(
          pattern.table,
          columnImportance.multiColumnCandidate,
          slowQuery,
          existingIndexes
        );
        if (recommendation) {
          recommendations.push(recommendation);
        }
      }
      
      // 生成部分索引建议（针对特定条件）
      if (pattern.whereClause && pattern.whereClause.selective && pattern.whereClause.conditions.length === 1) {
        const partialIndex = this.generatePartialIndexRecommendation(
          pattern.table,
          pattern.whereClause.conditions[0],
          slowQuery
        );
        if (partialIndex) {
          recommendations.push(partialIndex);
        }
      }
      
      // 去重并按优先级排序
      const uniqueRecommendations = this.deduplicateRecommendations(recommendations);
      return uniqueRecommendations.sort((a, b) => b.priority - a.priority);
      
    } catch (error) {
      logger.error({ error: error.message, query: slowQuery.query?.substring(0, 100) }, '生成索引建议失败');
      return recommendations;
    }
  }

  /**
   * 生成单列索引建议
   */
  generateSingleColumnIndexRecommendation(tableName, column, slowQuery, existingIndexes) {
    // 检查是否已存在该列的索引
    const existingIndex = existingIndexes.find(idx => 
      idx.table === tableName && 
      idx.columns.length === 1 && 
      idx.columns[0] === column.name
    );
    
    if (existingIndex) {
      return null;
    }
    
    // 低基数字段不适合建索引
    if (column.cardinality < 10) {
      logger.debug({ column: column.name, cardinality: column.cardinality }, '基数值太低，跳过索引建议');
      return null;
    }
    
    // 检查是否有复合索引已覆盖该列
    const coveredByComposite = existingIndexes.find(idx =>
      idx.table === tableName &&
      idx.columns.length > 1 &&
      idx.columns[0] === column.name
    );
    
    if (coveredByComposite) {
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
      priority: this.calculatePriority(slowQuery.meanExecTime, column.cardinality),
      reason: `列 '${column.name}' 在慢查询中频繁出现，基数 ${column.cardinality.toFixed(0)}，预计可提升查询性能`,
      estimatedImprovement: {
        queryTimeReduction: `${Math.min(slowQuery.meanExecTime * 0.7, 100).toFixed(0)}ms`,
        affectedQueries: 1
      },
      risks: ['索引创建期间可能影响写入性能'],
      safeWindow: '建议在低峰期执行',
      queryId: slowQuery.queryId
    };
  }

  /**
   * 生成复合索引建议
   */
  generateCompositeIndexRecommendation(tableName, columns, slowQuery, existingIndexes) {
    // 确定列顺序（基数高的放前面）
    const orderedColumns = [...columns].sort((a, b) => b.cardinality - a.cardinality);
    const columnNames = orderedColumns.map(c => c.name);
    
    // 检查是否已存在覆盖这些列的索引
    const existingIndex = existingIndexes.find(idx => {
      if (idx.table !== tableName) return false;
      
      const idxCols = idx.columns;
      // 完全匹配或前缀匹配
      return columnNames.join(',') === idxCols.join(',') ||
             idxCols.join(',').startsWith(columnNames.slice(0, idxCols.length).join(','));
    });
    
    if (existingIndex) {
      return null;
    }
    
    const indexName = `idx_${tableName}_${columnNames.join('_')}`;
    const sql = `CREATE INDEX CONCURRENTLY ${indexName} ON ${tableName} (${columnNames.join(', ')})`;
    
    const avgCardinality = columns.reduce((sum, c) => sum + c.cardinality, 0) / columns.length;
    
    return {
      type: 'CREATE',
      indexName,
      tableName,
      columns: columnNames,
      sql,
      priority: this.calculatePriority(slowQuery.meanExecTime, avgCardinality) + 10, // 复合索引优先级略高
      reason: `复合查询条件，${columnNames.length} 列组合索引可显著提升性能`,
      estimatedImprovement: {
        queryTimeReduction: `${(slowQuery.meanExecTime * 0.8).toFixed(0)}ms`,
        affectedQueries: 1
      },
      risks: ['复合索引占用空间较大', '写入开销增加'],
      safeWindow: '建议在低峰期执行',
      queryId: slowQuery.queryId
    };
  }

  /**
   * 生成部分索引建议
   */
  generatePartialIndexRecommendation(tableName, condition, slowQuery) {
    const column = condition.column;
    const operator = condition.operator;
    
    // 只对等值查询和范围查询建议部分索引
    if (!['=', '<', '>', '<=', '>='].includes(operator)) {
      return null;
    }
    
    const indexName = `idx_${tableName}_${column}_partial`;
    const sql = `CREATE INDEX CONCURRENTLY ${indexName} ON ${tableName} (${column}) WHERE ${column} ${operator} ?`;
    
    return {
      type: 'CREATE',
      indexName,
      tableName,
      columns: [column],
      sql,
      partial: true,
      condition: `${column} ${operator} ?`,
      priority: 75,
      reason: `选择性条件，部分索引可减少索引大小并提升性能`,
      estimatedImprovement: {
        queryTimeReduction: `${(slowQuery.meanExecTime * 0.6).toFixed(0)}ms`,
        indexSizeReduction: '60-80%'
      },
      risks: ['仅对特定查询有效'],
      safeWindow: '建议在低峰期执行',
      queryId: slowQuery.queryId
    };
  }

  /**
   * 计算优先级（0-100）
   */
  calculatePriority(meanExecTime, cardinality) {
    const timeScore = Math.min((meanExecTime / 1000) * 20, 40); // 时间得分最高 40 分
    const cardinalityScore = Math.min((cardinality / 1000) * 20, 40); // 基数得分最高 40 分
    return Math.min(timeScore + cardinalityScore + 20, 100);
  }

  /**
   * 去重建议
   */
  deduplicateRecommendations(recommendations) {
    const seen = new Map();
    
    return recommendations.filter(rec => {
      const key = `${rec.tableName}:${rec.columns.join(',')}`;
      if (seen.has(key)) {
        // 保留优先级更高的
        const existing = seen.get(key);
        if (rec.priority > existing.priority) {
          seen.set(key, rec);
          return true;
        }
        return false;
      }
      seen.set(key, rec);
      return true;
    });
  }
}

/**
 * 查询模式分析器
 */
class QueryPatternAnalyzer {
  /**
   * 分析查询模式
   */
  analyze(query) {
    if (!query || typeof query !== 'string') {
      return null;
    }
    
    const normalized = query.trim().toUpperCase();
    
    try {
      const result = {
        table: null,
        whereClause: null,
        joinTables: [],
        orderBy: null,
        groupBy: null,
        queryType: this.detectQueryType(normalized)
      };
      
      // 提取表名
      const tableMatch = normalized.match(/FROM\s+(\w+)/i);
      if (tableMatch) {
        result.table = tableMatch[1].toLowerCase();
      }
      
      // 解析 WHERE 子句
      const whereMatch = query.match(/WHERE\s+(.*?)(?:ORDER|GROUP|LIMIT|$)/i);
      if (whereMatch) {
        result.whereClause = this.parseWhereClause(whereMatch[1]);
      }
      
      // 解析 JOIN
      const joinMatches = query.matchAll(/JOIN\s+(\w+)\s+ON\s+(.*?)(?:WHERE|GROUP|ORDER|LIMIT|$)/gi);
      for (const match of joinMatches) {
        result.joinTables.push({
          table: match[1].toLowerCase(),
          condition: match[2]
        });
      }
      
      // 解析 ORDER BY
      const orderMatch = query.match(/ORDER\s+BY\s+(.*?)(?:LIMIT|$)/i);
      if (orderMatch) {
        result.orderBy = orderMatch[1].split(',').map(s => s.trim());
      }
      
      return result;
      
    } catch (error) {
      logger.debug({ error: error.message }, '解析查询失败');
      return null;
    }
  }

  /**
   * 解析 WHERE 子句
   */
  parseWhereClause(whereStr) {
    const conditions = [];
    const operators = ['<=', '>=', '!=', '<>', '=', '<', '>', 'LIKE', 'IN', 'BETWEEN'];
    
    // 简化解析：识别列名和操作符
    for (const op of operators) {
      const regex = new RegExp(`(\\w+)\\s*${op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      const match = whereStr.match(regex);
      if (match) {
        conditions.push({
          column: match[1].toLowerCase(),
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

  /**
   * 检测查询类型
   */
  detectQueryType(query) {
    if (/INSERT/i.test(query)) return 'INSERT';
    if (/UPDATE/i.test(query)) return 'UPDATE';
    if (/DELETE/i.test(query)) return 'DELETE';
    return 'SELECT';
  }
}

/**
 * 列重要性分析器
 */
class ColumnImportanceAnalyzer {
  /**
   * 分析列重要性
   */
  analyze(pattern, slowQuery, tableStats) {
    const result = {
      singleColumnCandidates: [],
      multiColumnCandidate: null
    };
    
    if (!pattern || !pattern.whereClause) {
      return result;
    }
    
    // 分析 WHERE 子句中的列
    for (const cond of pattern.whereClause.conditions) {
      const stat = tableStats.find(s => s.attname === cond.column);
      
      if (stat) {
        // 计算基数（不同值的数量）
        const cardinality = this.calculateCardinality(stat, slowQuery.rows);
        
        result.singleColumnCandidates.push({
          name: cond.column,
          cardinality,
          correlation: Math.abs(stat.correlation || 0),
          operator: cond.operator,
          nullFrac: stat.null_frac || 0
        });
      } else {
        // 如果没有统计信息，使用默认值
        result.singleColumnCandidates.push({
          name: cond.column,
          cardinality: 1000, // 默认基数
          correlation: 0.5,
          operator: cond.operator,
          nullFrac: 0
        });
      }
    }
    
    // 按基数排序
    result.singleColumnCandidates.sort((a, b) => b.cardinality - a.cardinality);
    
    // 如果有多个列，考虑复合索引（最多 4 列）
    if (result.singleColumnCandidates.length >= 2) {
      result.multiColumnCandidate = result.singleColumnCandidates.slice(0, 4);
    }
    
    return result;
  }

  /**
   * 计算基数
   */
  calculateCardinality(stat, queryRows) {
    // n_distinct: 负值表示比例，正值表示绝对数量
    let cardinality;
    
    if (stat.n_distinct < 0) {
      // 负值：比例
      cardinality = Math.abs(stat.n_distinct) * (queryRows || 10000);
    } else if (stat.n_distinct > 0) {
      // 正值：绝对数量
      cardinality = stat.n_distinct;
    } else {
      // 无统计信息，使用默认值
      cardinality = 1000;
    }
    
    return Math.max(1, cardinality);
  }
}

module.exports = { IndexRecommender, QueryPatternAnalyzer, ColumnImportanceAnalyzer };
