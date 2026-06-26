/**
 * 分区查询优化器
 * REQ-00323: 数据库分区表与大数据量表分区策略
 */

class PartitionQueryOptimizer {
  /**
   * 为查询添加分区裁剪提示
   * @param {string} query - SQL 查询语句
   * @param {Array} params - 查询参数
   * @param {string} partitionKey - 分区键字段名
   * @param {Object} dateRange - 日期范围 { start, end }
   */
  static optimizeQuery(query, params, partitionKey = 'created_at', dateRange = null) {
    // 如果查询包含时间范围，确保分区裁剪生效
    if (dateRange) {
      const { start, end } = dateRange;
      
      // 检查查询是否已经包含 WHERE 子句
      const hasWhere = /\bWHERE\b/i.test(query);
      
      if (hasWhere) {
        return {
          query: query.replace(/WHERE/i, `WHERE ${partitionKey} >= $${params.length + 1} AND ${partitionKey} < $${params.length + 2} AND`),
          params: [...params, start, end]
        };
      } else {
        return {
          query: query.replace(/FROM\s+(\w+)/i, `FROM $1 WHERE ${partitionKey} >= $${params.length + 1} AND ${partitionKey} < $${params.length + 2}`),
          params: [...params, start, end]
        };
      }
    }

    // 如果没有明确的时间范围，默认查询最近3个月
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const hasWhere = /\bWHERE\b/i.test(query);
    
    if (hasWhere) {
      return {
        query: query.replace(/WHERE/i, `WHERE ${partitionKey} >= $${params.length + 1} AND`),
        params: [...params, threeMonthsAgo]
      };
    } else {
      return {
        query: query.replace(/FROM\s+(\w+)/i, `FROM $1 WHERE ${partitionKey} >= $${params.length + 1}`),
        params: [...params, threeMonthsAgo]
      };
    }
  }

  /**
   * 强制查询使用特定分区
   * @param {string} query - SQL 查询语句
   * @param {string} partitionName - 分区名称
   */
  static forcePartition(query, partitionName) {
    // 替换表名为特定分区名
    return query.replace(/FROM\s+(\w+)/i, `FROM ${partitionName}`);
  }

  /**
   * 分析查询并推荐最优分区策略
   * @param {string} query - SQL 查询语句
   * @param {Object} context - 查询上下文
   */
  static analyzeQuery(query, context = {}) {
    const analysis = {
      usesPartitionKey: false,
      partitionKeyUsed: null,
      recommendedDateRange: null,
      canUsePartitionPruning: false,
      suggestions: []
    };

    // 检查是否使用了分区键
    const partitionKeys = ['created_at', 'battle_time', 'activity_time', 'recorded_at'];
    
    for (const key of partitionKeys) {
      if (new RegExp(`\\b${key}\\b`, 'i').test(query)) {
        analysis.usesPartitionKey = true;
        analysis.partitionKeyUsed = key;
        break;
      }
    }

    // 检查是否有时间范围条件
    const hasDateRange = /\b(BETWEEN|>=|<=|>|<)\s*['"]?\d{4}-\d{2}-\d{2}/i.test(query);
    analysis.canUsePartitionPruning = analysis.usesPartitionKey && hasDateRange;

    // 生成优化建议
    if (!analysis.usesPartitionKey) {
      analysis.suggestions.push('查询未使用分区键，建议添加时间范围条件以利用分区裁剪');
    }

    if (analysis.usesPartitionKey && !hasDateRange) {
      analysis.suggestions.push('查询使用了分区键但未指定时间范围，建议添加时间范围条件');
      
      // 推荐默认时间范围（最近3个月）
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      analysis.recommendedDateRange = {
        start: threeMonthsAgo.toISOString(),
        end: new Date().toISOString()
      };
    }

    return analysis;
  }

  /**
   * 生成优化的查询计划
   * @param {string} baseQuery - 基础查询
   * @param {Object} options - 优化选项
   */
  static generateOptimizedQuery(baseQuery, options = {}) {
    const {
      partitionKey = 'created_at',
      dateRange = null,
      forceDefaultRange = true,
      maxMonthsBack = 3
    } = options;

    let optimizedQuery = baseQuery;
    let optimizedParams = options.params || [];

    // 分析查询
    const analysis = this.analyzeQuery(baseQuery);

    // 如果查询已经可以分区裁剪，直接返回
    if (analysis.canUsePartitionPruning) {
      return {
        query: baseQuery,
        params: optimizedParams,
        analysis
      };
    }

    // 添加时间范围条件
    if (dateRange) {
      const result = this.optimizeQuery(baseQuery, optimizedParams, partitionKey, dateRange);
      return {
        query: result.query,
        params: result.params,
        analysis: {
          ...analysis,
          optimized: true,
          optimizationType: 'added_date_range'
        }
      };
    }

    // 如果启用默认范围，添加默认时间条件
    if (forceDefaultRange && analysis.usesPartitionKey) {
      const defaultDate = new Date();
      defaultDate.setMonth(defaultDate.getMonth() - maxMonthsBack);
      
      const result = this.optimizeQuery(baseQuery, optimizedParams, partitionKey, {
        start: defaultDate,
        end: new Date()
      });
      
      return {
        query: result.query,
        params: result.params,
        analysis: {
          ...analysis,
          optimized: true,
          optimizationType: 'added_default_range'
        }
      };
    }

    return {
      query: baseQuery,
      params: optimizedParams,
      analysis
    };
  }

  /**
   * 构建分区扫描范围
   * @param {Date} startDate - 开始日期
   * @param {Date} endDate - 结束日期
   */
  static buildPartitionRange(startDate, endDate) {
    const partitions = [];
    const current = new Date(startDate);

    while (current <= endDate) {
      partitions.push({
        name: `y${current.getFullYear()}_m${String(current.getMonth() + 1).padStart(2, '0')}`,
        year: current.getFullYear(),
        month: current.getMonth() + 1,
        startDate: new Date(current.getFullYear(), current.getMonth(), 1),
        endDate: new Date(current.getFullYear(), current.getMonth() + 1, 0)
      });

      current.setMonth(current.getMonth() + 1);
    }

    return partitions;
  }

  /**
   * 获取查询应该扫描的分区列表
   * @param {string} tableName - 表名
   * @param {Date} startDate - 开始日期
   * @param {Date} endDate - 结束日期
   */
  static getApplicablePartitions(tableName, startDate, endDate) {
    const range = this.buildPartitionRange(startDate, endDate);
    return range.map(r => `${tableName}_${r.name}`);
  }
}

module.exports = PartitionQueryOptimizer;