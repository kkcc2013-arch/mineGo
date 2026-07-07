// shared/indexUsageMonitor.js - Database Index Usage Monitor
'use strict';

const { query } = require('./db');
const { createLogger } = require('./logger');
const { getRedis, getJSON, setJSON } = require('./redis');

const logger = createLogger('index-monitor');

// Configuration constants
const CONFIG = {
  UNUSED_INDEX_THRESHOLD_DAYS: 30,
  LOW_USAGE_THRESHOLD: 100,     // scans below this are considered low usage
  INDEX_SIZE_THRESHOLD_MB: 10,   // indexes larger than this get priority review
  SCAN_INTERVAL_HOURS: 24,       // how often to collect metrics
  RETENTION_DAYS: 90             // keep historical data for 90 days
};

// Index categories
const INDEX_CATEGORIES = {
  PRIMARY: 'PRIMARY',
  UNIQUE: 'UNIQUE',
  FOREIGN_KEY: 'FOREIGN_KEY',
  PERFORMANCE: 'PERFORMANCE',
  UNKNOWN: 'UNKNOWN'
};

// Risk levels for indexes
const RISK_LEVELS = {
  SAFE: { level: 'SAFE', score: 0, action: 'NONE' },
  LOW: { level: 'LOW', score: 25, action: 'MONITOR' },
  MEDIUM: { level: 'MEDIUM', score: 50, action: 'REVIEW' },
  HIGH: { level: 'HIGH', score: 75, action: 'CANDIDATE_FOR_REMOVAL' },
  CRITICAL: { level: 'CRITICAL', score: 100, action: 'REMOVE_IMMEDIATELY' }
};

class IndexUsageMonitor {
  constructor() {
    this.redis = null;
    this.collectionInProgress = false;
  }

  /**
   * Get Redis instance (lazy initialization)
   */
  getRedis() {
    if (!this.redis) {
      this.redis = getRedis();
    }
    return this.redis;
  }

  /**
   * Collect index usage statistics from PostgreSQL
   */
  async collectIndexStats() {
    if (this.collectionInProgress) {
      logger.warn('Index stats collection already in progress, skipping');
      return null;
    }

    this.collectionInProgress = true;
    const startTime = Date.now();

    try {
      // Query for index usage statistics
      const indexUsageQuery = `
        SELECT
          schemaname,
          relname as table_name,
          indexrelname as index_name,
          idx_scan as index_scans,
          idx_tup_read as tuples_read,
          idx_tup_fetch as tuples_fetched,
          pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
          pg_relation_size(indexrelid) as index_size_bytes,
          idx_scan::float / NULLIF(idx_tup_read, 0) as scan_read_ratio
        FROM pg_stat_user_indexes
        ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC
      `;

      const indexUsageResult = await query(indexUsageQuery);

      // Query for index definitions
      const indexDefQuery = `
        SELECT
          t.relname as table_name,
          i.relname as index_name,
          a.attname as column_name,
          ix.indisunique as is_unique,
          ix.indisprimary as is_primary,
          am.amname as index_type,
          pg_get_indexdef(i.oid) as index_def
        FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_am am ON i.relam = am.oid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE t.relkind = 'r'
          AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
        ORDER BY t.relname, i.relname
      `;

      const indexDefResult = await query(indexDefQuery);

      // Query for unused indexes (PostgreSQL 14+ feature)
      const unusedIndexQuery = `
        SELECT
          schemaname,
          relname as table_name,
          indexrelname as index_name
        FROM pg_stat_user_indexes
        WHERE idx_scan = 0
          AND indexrelname NOT LIKE '%_pkey'
          AND indexrelname NOT LIKE '%_idx'
        ORDER BY pg_relation_size(indexrelid) DESC
      `;

      let unusedIndexes = [];
      try {
        const unusedResult = await query(unusedIndexQuery);
        unusedIndexes = unusedResult.rows;
      } catch (e) {
        // Table might not exist in older PostgreSQL versions
        logger.warn('Could not query unused indexes table, using fallback method');
      }

      // Query for duplicate indexes
      const duplicateIndexQuery = `
        SELECT
          pg_size_pretty(sum(pg_relation_size(idx))::bigint) as size,
          (array_agg(idx))[1] as idx1,
          (array_agg(idx))[2] as idx2,
          (array_agg(idx))[3] as idx3
        FROM (
          SELECT
            indexrelid::regclass as idx,
            indrelid::regclass as table,
            indkey,
            indpred,
            indunique::text,
            array_to_string(indkey, ',') as cols,
            pg_relation_size(indexrelid) as index_size
          FROM pg_index
        ) sub
        GROUP BY table, cols, indpred, indunique
        HAVING count(*) > 1
        ORDER BY sum(pg_relation_size(idx)) DESC
      `;

      let duplicateIndexes = [];
      try {
        const duplicateResult = await query(duplicateIndexQuery);
        duplicateIndexes = duplicateResult.rows;
      } catch (e) {
        logger.warn('Could not query duplicate indexes');
      }

      // Process and aggregate the results
      const stats = this.processIndexStats(
        indexUsageResult.rows,
        indexDefResult.rows,
        unusedIndexes,
        duplicateIndexes
      );

      // Cache the results
      const cacheKey = 'index:usage:latest';
      await setJSON(cacheKey, {
        timestamp: new Date().toISOString(),
        stats,
        summary: this.generateSummary(stats)
      }, CONFIG.SCAN_INTERVAL_HOURS * 3600);

      // Save historical data
      await this.saveHistoricalData(stats);

      const duration = Date.now() - startTime;
      logger.info({
        duration,
        totalIndexes: stats.total,
        unusedCount: stats.unused.length,
        lowUsageCount: stats.lowUsage.length,
        duplicateCount: stats.duplicates.length
      }, 'Index stats collection completed');

      return stats;

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to collect index stats');
      throw error;
    } finally {
      this.collectionInProgress = false;
    }
  }

  /**
   * Process raw index statistics
   */
  processIndexStats(usageRows, defRows, unusedIndexes, duplicateIndexes) {
    // Group index definitions by index name
    const indexDefs = {};
    for (const row of defRows) {
      if (!indexDefs[row.index_name]) {
        indexDefs[row.index_name] = {
          table: row.table_name,
          columns: [],
          isPrimary: row.is_primary,
          isUnique: row.is_unique,
          type: row.index_type,
          definition: row.index_def,
          category: this.categorizeIndex(row)
        };
      }
      indexDefs[row.index_name].columns.push(row.column_name);
    }

    // Process usage stats
    const processedIndexes = usageRows.map(row => {
      const def = indexDefs[row.index_name] || {};
      const riskLevel = this.calculateRiskLevel(row, def);

      return {
        schema: row.schemaname,
        table: row.table_name,
        name: row.index_name,
        scans: parseInt(row.index_scans) || 0,
        tuplesRead: parseInt(row.tuples_read) || 0,
        tuplesFetched: parseInt(row.tuples_fetched) || 0,
        size: row.index_size,
        sizeBytes: parseInt(row.index_size_bytes) || 0,
        scanReadRatio: parseFloat(row.scan_read_ratio) || 0,
        columns: def.columns || [],
        isPrimary: def.isPrimary || false,
        isUnique: def.isUnique || false,
        type: def.type || 'unknown',
        category: def.category || INDEX_CATEGORIES.UNKNOWN,
        definition: def.definition || null,
        risk: riskLevel,
        recommendation: this.generateRecommendation(row, def, riskLevel)
      };
    });

    // Categorize indexes
    const result = {
      timestamp: new Date().toISOString(),
      total: processedIndexes.length,
      indexes: processedIndexes,
      unused: processedIndexes.filter(idx =>
        idx.scans === 0 && !idx.isPrimary && idx.category !== INDEX_CATEGORIES.FOREIGN_KEY
      ),
      lowUsage: processedIndexes.filter(idx =>
        idx.scans > 0 && idx.scans < CONFIG.LOW_USAGE_THRESHOLD &&
        !idx.isPrimary && idx.category !== INDEX_CATEGORIES.FOREIGN_KEY
      ),
      duplicates: duplicateIndexes.map(dup => ({
        indexes: [dup.idx1, dup.idx2, dup.idx3].filter(Boolean),
        size: dup.size
      })),
      primaryKeys: processedIndexes.filter(idx => idx.isPrimary),
      foreignKeys: processedIndexes.filter(idx => idx.category === INDEX_CATEGORIES.FOREIGN_KEY),
      unique: processedIndexes.filter(idx => idx.isUnique && !idx.isPrimary),
      performance: processedIndexes.filter(idx => idx.category === INDEX_CATEGORIES.PERFORMANCE)
    };

    return result;
  }

  /**
   * Categorize an index based on its definition
   */
  categorizeIndex(def) {
    if (def.is_primary) return INDEX_CATEGORIES.PRIMARY;
    if (def.is_unique) return INDEX_CATEGORIES.UNIQUE;
    if (def.column_name && def.column_name.endsWith('_id')) return INDEX_CATEGORIES.FOREIGN_KEY;
    if (def.index_type === 'btree' && !def.is_primary && !def.is_unique) {
      return INDEX_CATEGORIES.PERFORMANCE;
    }
    return INDEX_CATEGORIES.UNKNOWN;
  }

  /**
   * Calculate risk level for an index
   */
  calculateRiskLevel(usage, def) {
    let score = 0;

    // Unused indexes (no scans)
    if (usage.index_scans === 0 && !def?.isPrimary && this.categorizeIndex(def) !== INDEX_CATEGORIES.FOREIGN_KEY) {
      score += 70;
    }

    // Low usage
    if (usage.index_scans > 0 && usage.index_scans < CONFIG.LOW_USAGE_THRESHOLD) {
      score += 30;
    }

    // Large unused indexes
    if (usage.index_scans === 0 && usage.index_size_bytes > CONFIG.INDEX_SIZE_THRESHOLD_MB * 1024 * 1024) {
      score += 20;
    }

    // Low scan-to-read ratio (index exists but isn't effective)
    if (usage.scan_read_ratio && usage.scan_read_ratio > 10) {
      score += 15;
    }

    // Cap at 100
    score = Math.min(score, 100);

    // Return appropriate risk level
    if (score === 0) return RISK_LEVELS.SAFE;
    if (score <= 25) return RISK_LEVELS.LOW;
    if (score <= 50) return RISK_LEVELS.MEDIUM;
    if (score <= 75) return RISK_LEVELS.HIGH;
    return RISK_LEVELS.CRITICAL;
  }

  /**
   * Generate recommendation for an index
   */
  generateRecommendation(usage, def, riskLevel) {
    const recommendations = [];

    if (riskLevel.level === 'CRITICAL') {
      recommendations.push({
        type: 'REMOVE',
        reason: `Index has never been used (${usage.index_scans} scans) and can be safely removed`,
        priority: 'HIGH',
        sql: this.generateDropSQL(usage, def)
      });
    }

    if (riskLevel.level === 'HIGH') {
      recommendations.push({
        type: 'REVIEW',
        reason: `Index has very low usage (${usage.index_scans} scans). Consider removing if not needed for future queries.`,
        priority: 'MEDIUM',
        sql: this.generateDropSQL(usage, def)
      });
    }

    if (riskLevel.level === 'MEDIUM') {
      recommendations.push({
        type: 'MONITOR',
        reason: `Index has low usage (${usage.index_scans} scans). Monitor for another ${CONFIG.UNUSED_INDEX_THRESHOLD_DAYS} days.`,
        priority: 'LOW'
      });
    }

    // Check for potential improvements
    if (def?.type === 'btree' && usage.tuples_read > 10000 && usage.scan_read_ratio > 5) {
      recommendations.push({
        type: 'OPTIMIZE',
        reason: 'Index exists but has low efficiency. Consider partial or expression index.',
        priority: 'LOW'
      });
    }

    return recommendations;
  }

  /**
   * Generate DROP INDEX SQL statement
   */
  generateDropSQL(usage, def) {
    if (!usage || !usage.index_name) return null;
    return `DROP INDEX CONCURRENTLY IF EXISTS ${usage.schemaname}.${usage.index_name};`;
  }

  /**
   * Generate summary statistics
   */
  generateSummary(stats) {
    const totalSizeBytes = stats.indexes.reduce((sum, idx) => sum + (idx.sizeBytes || 0), 0);
    const unusedSizeBytes = stats.unused.reduce((sum, idx) => sum + (idx.sizeBytes || 0), 0);
    const potentialSavingsMB = (unusedSizeBytes / 1024 / 1024).toFixed(2);

    return {
      totalIndexes: stats.total,
      totalSize: this.formatBytes(totalSizeBytes),
      unusedCount: stats.unused.length,
      unusedSize: this.formatBytes(unusedSizeBytes),
      potentialSavings: `${potentialSavingsMB} MB`,
      lowUsageCount: stats.lowUsage.length,
      duplicateCount: stats.duplicates.length,
      distributionByRisk: this.calculateRiskDistribution(stats.indexes)
    };
  }

  /**
   * Calculate distribution of indexes by risk level
   */
  calculateRiskDistribution(indexes) {
    const distribution = {
      SAFE: 0,
      LOW: 0,
      MEDIUM: 0,
      HIGH: 0,
      CRITICAL: 0
    };

    for (const idx of indexes) {
      distribution[idx.risk.level]++;
    }

    return distribution;
  }

  /**
   * Save historical index usage data
   */
  async saveHistoricalData(stats) {
    const date = new Date().toISOString().split('T')[0];
    const key = `index:usage:history:${date}`;

    try {
      await setJSON(key, {
        date,
        total: stats.total,
        unusedCount: stats.unused.length,
        lowUsageCount: stats.lowUsage.length,
        duplicateCount: stats.duplicates.length,
        summary: stats.summary
      }, CONFIG.RETENTION_DAYS * 24 * 3600);

      // Cleanup old data (keep only RETENTION_DAYS)
      await this.cleanupOldData();
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to save historical data');
    }
  }

  /**
   * Cleanup old historical data
   */
  async cleanupOldData() {
    const redis = this.getRedis();
    const pattern = 'index:usage:history:*';

    try {
      const keys = await redis.keys(pattern);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - CONFIG.RETENTION_DAYS);
      const cutoffStr = cutoffDate.toISOString().split('T')[0];

      const oldKeys = keys.filter(key => {
        const dateStr = key.split(':').pop();
        return dateStr < cutoffStr;
      });

      if (oldKeys.length > 0) {
        await redis.del(...oldKeys);
        logger.info({ deletedCount: oldKeys.length }, 'Cleaned up old index history');
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to cleanup old data');
    }
  }

  /**
   * Get latest index statistics
   */
  async getLatestStats() {
    const cacheKey = 'index:usage:latest';
    return await getJSON(cacheKey);
  }

  /**
   * Get historical trend data
   */
  async getHistoricalTrend(days = 30) {
    const redis = this.getRedis();
    const trend = [];
    const pattern = 'index:usage:history:*';

    try {
      const keys = await redis.keys(pattern);
      const sortedKeys = keys.sort().slice(-days);

      for (const key of sortedKeys) {
        const data = await getJSON(key);
        if (data) {
          trend.push(data);
        }
      }

      return trend;
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get historical trend');
      return [];
    }
  }

  /**
   * Format bytes to human readable string
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Generate index analysis report
   */
  async generateReport() {
    const latest = await this.getLatestStats();

    if (!latest) {
      return {
        error: 'No index statistics available. Run collectIndexStats first.'
      };
    }

    const report = {
      generatedAt: new Date().toISOString(),
      summary: latest.summary,
      recommendations: []
    };

    // High priority: Remove unused indexes
    for (const idx of latest.stats.unused) {
      if (idx.risk.level === 'CRITICAL' || idx.risk.level === 'HIGH') {
        report.recommendations.push({
          priority: 'HIGH',
          type: 'REMOVE_INDEX',
          index: idx.name,
          table: idx.table,
          reason: `Index has ${idx.scans} scans. Saving: ${idx.size}`,
          sql: idx.recommendation[0]?.sql
        });
      }
    }

    // Medium priority: Review low usage indexes
    for (const idx of latest.stats.lowUsage) {
      if (idx.risk.level === 'MEDIUM') {
        report.recommendations.push({
          priority: 'MEDIUM',
          type: 'REVIEW_INDEX',
          index: idx.name,
          table: idx.table,
          reason: `Index has only ${idx.scans} scans. Monitor before removal.`
        });
      }
    }

    // Duplicates
    for (const dup of latest.stats.duplicates) {
      report.recommendations.push({
        priority: 'MEDIUM',
        type: 'DUPLICATE_INDEX',
        indexes: dup.indexes,
        reason: `Duplicate indexes detected. Size: ${dup.size}`
      });
    }

    // Sort by priority
    report.recommendations.sort((a, b) => {
      const priorityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    return report;
  }
}

// Export singleton instance
const indexMonitor = new IndexUsageMonitor();

module.exports = {
  IndexUsageMonitor,
  indexMonitor,
  collectIndexStats: () => indexMonitor.collectIndexStats(),
  getLatestStats: () => indexMonitor.getLatestStats(),
  getHistoricalTrend: (days) => indexMonitor.getHistoricalTrend(days),
  generateReport: () => indexMonitor.generateReport(),
  CONFIG,
  INDEX_CATEGORIES,
  RISK_LEVELS
};
