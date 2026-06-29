// backend/shared/indexOptimizer/IndexHealthChecker.js
'use strict';

const { createLogger } = require('../logger');

const logger = createLogger('index-health-checker');

/**
 * 索引健康检查器
 * 检测未使用、重复、碎片化和过大的索引
 */
class IndexHealthChecker {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * 执行完整的索引健康检查
   */
  async checkIndexHealth() {
    const report = {
      timestamp: new Date().toISOString(),
      unusedIndexes: [],
      duplicateIndexes: [],
      fragmentedIndexes: [],
      oversizedIndexes: [],
      recommendations: [],
      summary: {
        totalIndexes: 0,
        healthyIndexes: 0,
        issuesFound: 0
      }
    };

    try {
      // 检测未使用的索引
      report.unusedIndexes = await this.findUnusedIndexes();
      
      // 检测重复索引
      report.duplicateIndexes = await this.findDuplicateIndexes();
      
      // 检测碎片化索引
      report.fragmentedIndexes = await this.findFragmentedIndexes();
      
      // 检测过大的索引
      report.oversizedIndexes = await this.findOversizedIndexes();
      
      // 统计总数
      report.summary.totalIndexes = await this.getTotalIndexCount();
      report.summary.healthyIndexes = report.summary.totalIndexes - 
        report.unusedIndexes.length - 
        report.duplicateIndexes.length - 
        report.fragmentedIndexes.length;
      report.summary.issuesFound = report.unusedIndexes.length + 
        report.duplicateIndexes.length + 
        report.fragmentedIndexes.length + 
        report.oversizedIndexes.length;
      
      // 生成建议
      report.recommendations = this.generateRecommendations(report);
      
      logger.info({
        unused: report.unusedIndexes.length,
        duplicate: report.duplicateIndexes.length,
        fragmented: report.fragmentedIndexes.length,
        oversized: report.oversizedIndexes.length
      }, '索引健康检查完成');
      
      return report;
      
    } catch (error) {
      logger.error({ error: error.message }, '索引健康检查失败');
      throw error;
    }
  }

  /**
   * 查找未使用的索引
   */
  async findUnusedIndexes() {
    try {
      const result = await this.pool.query(`
        SELECT
          schemaname,
          relname as table_name,
          indexrelname as index_name,
          idx_scan as scans,
          idx_tup_read as tuples_read,
          idx_tup_fetch as tuples_fetched,
          pg_relation_size(indexrelid) as index_size_bytes
        FROM pg_stat_user_indexes
        WHERE idx_scan = 0
          AND indexrelname NOT LIKE '%_pkey'
          AND indexrelname NOT LIKE '%_unique'
        ORDER BY pg_relation_size(indexrelid) DESC
        LIMIT 50
      `);
      
      return result.rows.map(row => {
        const indexSize = parseInt(row.index_size_bytes);
        
        return {
          schema: row.schemaname,
          table: row.table_name,
          indexName: row.index_name,
          scans: row.scans,
          tuplesRead: row.tuples_read,
          tuplesFetched: row.tuples_fetched,
          size: this.formatSize(indexSize),
          sizeBytes: indexSize,
          recommendation: 'DROP',
          sql: `DROP INDEX CONCURRENTLY IF EXISTS ${row.schemaname}.${row.index_name}`,
          reason: '索引从未被使用，占用存储空间且影响写入性能',
          priority: this.calculateUnusedPriority(indexSize),
          safeWindow: '建议在低峰期执行'
        };
      });
      
    } catch (error) {
      logger.error({ error: error.message }, '查找未使用索引失败');
      return [];
    }
  }

  /**
   * 查找重复索引
   */
  async findDuplicateIndexes() {
    try {
      const result = await this.pool.query(`
        WITH index_info AS (
          SELECT
            schemaname,
            tablename,
            indexname,
            pg_get_indexdef(indexrelid) as indexdef,
            pg_relation_size(indexrelid) as size
          FROM pg_indexes
          WHERE schemaname = 'public'
        )
        SELECT
          a.schemaname as schema,
          a.tablename as table,
          a.indexname as index1,
          b.indexname as index2,
          a.size as size1,
          b.size as size2,
          a.indexdef as def1,
          b.indexdef as def2
        FROM index_info a
        JOIN index_info b ON 
          a.tablename = b.tablename AND 
          a.indexname != b.indexname AND
          a.size <= b.size
        WHERE 
          -- 检查索引定义是否相似
          a.indexdef LIKE '%' || substring(b.indexdef from 'ON.*') || '%'
          OR b.indexdef LIKE '%' || substring(a.indexdef from 'ON.*') || '%'
        ORDER BY a.size DESC
        LIMIT 20
      `);
      
      return result.rows.map(row => {
        const size1 = parseInt(row.size1);
        const size2 = parseInt(row.size2);
        
        return {
          schema: row.schema,
          table: row.table,
          index1: row.index1,
          index2: row.index2,
          size1: this.formatSize(size1),
          size2: this.formatSize(size2),
          size1Bytes: size1,
          size2Bytes: size2,
          definition1: row.def1,
          definition2: row.def2,
          recommendation: 'DROP',
          sql: `DROP INDEX CONCURRENTLY IF EXISTS ${row.schema}.${row.index1}`,
          reason: `索引 '${row.index1}' 被 '${row.index2}' 覆盖或重复`,
          priority: this.calculateDuplicatePriority(size1),
          safeWindow: '建议在低峰期执行'
        };
      });
      
    } catch (error) {
      logger.error({ error: error.message }, '查找重复索引失败');
      return [];
    }
  }

  /**
   * 查找碎片化索引
   */
  async findFragmentedIndexes() {
    try {
      const result = await this.pool.query(`
        SELECT
          schemaname,
          tablename,
          indexname,
          pg_relation_size(indexrelid) as index_size_bytes,
          idx_scan as scans
        FROM pg_stat_user_indexes
        WHERE pg_relation_size(indexrelid) > 10 * 1024 * 1024  -- 大于 10MB
          AND idx_scan > 100
        ORDER BY pg_relation_size(indexrelid) DESC
        LIMIT 20
      `);
      
      // 对每个索引计算实际的碎片化程度
      const fragmentedIndexes = [];
      
      for (const row of result.rows) {
        const fragmentationRatio = await this.calculateFragmentation(row.indexname);
        
        if (fragmentationRatio > 30) {
          const indexSize = parseInt(row.index_size_bytes);
          
          fragmentedIndexes.push({
            schema: row.schemaname,
            table: row.tablename,
            indexName: row.indexname,
            size: this.formatSize(indexSize),
            sizeBytes: indexSize,
            scans: row.scans,
            fragmentationRatio: fragmentationRatio.toFixed(1),
            recommendation: 'REINDEX',
            sql: `REINDEX INDEX CONCURRENTLY ${row.schemaname}.${row.indexname}`,
            reason: `索引碎片率 ${fragmentationRatio.toFixed(1)}%，建议重建以提升性能`,
            priority: this.calculateFragmentationPriority(fragmentationRatio, indexSize),
            safeWindow: '建议在低峰期执行，预计耗时较长'
          });
        }
      }
      
      return fragmentedIndexes;
      
    } catch (error) {
      logger.error({ error: error.message }, '查找碎片化索引失败');
      return [];
    }
  }

  /**
   * 计算索引碎片化程度
   */
  async calculateFragmentation(indexName) {
    try {
      // 使用 pgstattuple 扩展（如果可用）
      const result = await this.pool.query(`
        SELECT * FROM pgstattuple($1)
      `, [indexName]);
      
      if (result.rows.length > 0) {
        return parseFloat(result.rows[0].dead_tuple_percent) || 0;
      }
      
      // 如果 pgstattuple 不可用，使用估算方法
      // 基于索引大小和扫描次数估算
      const statsResult = await this.pool.query(`
        SELECT
          pg_relation_size(indexrelid) as size,
          idx_scan as scans
        FROM pg_stat_user_indexes
        WHERE indexrelname = $1
      `, [indexName]);
      
      if (statsResult.rows.length > 0) {
        const size = parseInt(statsResult.rows[0].size);
        const scans = parseInt(statsResult.rows[0].scans);
        
        // 简化估算：大型索引且扫描次数少，可能碎片化
        if (size > 50 * 1024 * 1024 && scans < 1000) {
          return 40;
        }
        if (size > 100 * 1024 * 1024) {
          return 25;
        }
        return 15;
      }
      
      return 0;
      
    } catch (error) {
      // pgstattuple 可能不可用
      logger.debug({ error: error.message, indexName }, '计算碎片化程度失败');
      return 0;
    }
  }

  /**
   * 查找过大的索引
   */
  async findOversizedIndexes() {
    try {
      const result = await this.pool.query(`
        SELECT
          i.schemaname as schema,
          i.tablename as table,
          i.indexrelname as index_name,
          pg_relation_size(i.indexrelid) as index_size_bytes,
          pg_relation_size(c.oid) as table_size_bytes,
          pg_stat.idx_scan as scans
        FROM pg_stat_user_indexes i
        JOIN pg_class c ON c.relname = i.tablename
        LEFT JOIN pg_stat_user_indexes pg_stat ON pg_stat.indexrelname = i.indexrelname
        WHERE i.indexrelname NOT LIKE '%_pkey'
          AND pg_relation_size(i.indexrelid) > 50 * 1024 * 1024  -- 大于 50MB
        ORDER BY pg_relation_size(i.indexrelid) DESC
        LIMIT 20
      `);
      
      return result.rows.map(row => {
        const indexSize = parseInt(row.index_size_bytes);
        const tableSize = parseInt(row.table_size_bytes) || 1;
        const ratio = tableSize > 0 ? indexSize / tableSize : 0;
        
        // 只有索引大小占表大小的 30% 以上才报告
        if (ratio < 0.3) {
          return null;
        }
        
        return {
          schema: row.schema,
          table: row.table,
          indexName: row.index_name,
          indexSize: this.formatSize(indexSize),
          indexSizeBytes: indexSize,
          tableSize: this.formatSize(tableSize),
          tableSizeBytes: tableSize,
          ratio: ratio.toFixed(2),
          scans: row.scans || 0,
          recommendation: 'REVIEW',
          reason: `索引大小 ${this.formatSize(indexSize)}，占表大小 ${(ratio * 100).toFixed(1)}%，建议审查是否必要`,
          priority: 40,
          safeWindow: '建议与 DBA 确认后再操作'
        };
      }).filter(item => item !== null);
      
    } catch (error) {
      logger.error({ error: error.message }, '查找过大索引失败');
      return [];
    }
  }

  /**
   * 获取总索引数
   */
  async getTotalIndexCount() {
    try {
      const result = await this.pool.query(`
        SELECT count(*) as count
        FROM pg_indexes
        WHERE schemaname = 'public'
      `);
      
      return parseInt(result.rows[0].count) || 0;
      
    } catch (error) {
      logger.error({ error: error.message }, '获取索引总数失败');
      return 0;
    }
  }

  /**
   * 生成综合建议
   */
  generateRecommendations(report) {
    const recommendations = [];
    
    // 未使用索引 - 可安全删除
    for (const idx of report.unusedIndexes.slice(0, 10)) {
      recommendations.push({
        action: 'DROP_UNUSED',
        index: idx,
        priority: idx.priority,
        category: 'cleanup'
      });
    }
    
    // 重复索引 - 删除较小的
    for (const idx of report.duplicateIndexes.slice(0, 5)) {
      recommendations.push({
        action: 'DROP_DUPLICATE',
        index: idx,
        priority: idx.priority,
        category: 'cleanup'
      });
    }
    
    // 碎片化索引 - 重建
    for (const idx of report.fragmentedIndexes.slice(0, 5)) {
      recommendations.push({
        action: 'REINDEX',
        index: idx,
        priority: idx.priority,
        category: 'optimization'
      });
    }
    
    // 过大索引 - 需审查
    for (const idx of report.oversizedIndexes.slice(0, 3)) {
      recommendations.push({
        action: 'REVIEW_SIZE',
        index: idx,
        priority: idx.priority,
        category: 'review'
      });
    }
    
    return recommendations.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 计算未使用索引的优先级
   */
  calculateUnusedPriority(sizeBytes) {
    // 空间越大优先级越高
    const sizeMB = sizeBytes / (1024 * 1024);
    
    if (sizeMB > 100) return 90;
    if (sizeMB > 50) return 80;
    if (sizeMB > 20) return 70;
    if (sizeMB > 10) return 60;
    return 50;
  }

  /**
   * 计算重复索引的优先级
   */
  calculateDuplicatePriority(sizeBytes) {
    // 空间越大优先级越高
    const sizeMB = sizeBytes / (1024 * 1024);
    
    if (sizeMB > 100) return 85;
    if (sizeMB > 50) return 75;
    if (sizeMB > 20) return 65;
    return 55;
  }

  /**
   * 计算碎片化索引的优先级
   */
  calculateFragmentationPriority(fragmentationRatio, sizeBytes) {
    // 碎片率和空间综合考量
    const fragmentationScore = Math.min(fragmentationRatio * 1.5, 50);
    const sizeScore = Math.min(sizeBytes / (1024 * 1024 * 10), 40);
    
    return Math.min(fragmentationScore + sizeScore + 10, 100);
  }

  /**
   * 格式化大小显示
   */
  formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}

module.exports = { IndexHealthChecker };