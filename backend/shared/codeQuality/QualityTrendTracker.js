// backend/shared/codeQuality/QualityTrendTracker.js
// Track code quality metrics over time for trend analysis
'use strict';

/**
 * Quality Trend Tracker
 * 
 * Stores and analyzes code quality snapshots over time to:
 * - Track quality metrics trends
 * - Detect quality degradation
 * - Generate historical reports
 * - Predict future quality based on trends
 */
class QualityTrendTracker {
  constructor(pgPool, config = {}) {
    this.pool = pgPool;
    this.config = {
      retentionDays: config.retentionDays || 365,
      aggregationIntervals: config.aggregationIntervals || ['daily', 'weekly', 'monthly'],
      ...config
    };
  }

  /**
   * Save a quality snapshot
   * 
   * @param {Object} analysisResults - Results from CodeComplexityAnalyzer
   * @param {string} commitHash - Git commit hash (optional)
   * @param {string} branch - Git branch name
   */
  async saveSnapshot(analysisResults, commitHash = null, branch = 'main') {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Insert main snapshot
      const snapshotResult = await client.query(`
        INSERT INTO code_quality_snapshots (
          snapshot_date, commit_hash, branch, total_files, total_lines,
          total_functions, total_classes, avg_cyclomatic_complexity,
          avg_cognitive_complexity, avg_maintainability_index,
          high_complexity_files_count, technical_debt_score
        ) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `, [
        commitHash,
        branch,
        analysisResults.summary.totalFiles,
        analysisResults.summary.totalLines,
        analysisResults.summary.totalFunctions,
        analysisResults.summary.totalClasses || 0,
        analysisResults.summary.avgCyclomaticComplexity,
        analysisResults.summary.avgCognitiveComplexity,
        analysisResults.summary.avgMaintainabilityIndex,
        analysisResults.summary.highComplexityFiles.length,
        analysisResults.summary.technicalDebtScore
      ]);

      const snapshotId = snapshotResult.rows[0].id;

      // Insert file-level details
      for (const file of analysisResults.files) {
        await client.query(`
          INSERT INTO code_quality_file_details (
            snapshot_id, file_path, file_name, lines_of_code, cyclomatic_complexity,
            cognitive_complexity, maintainability_index, technical_debt_score,
            function_count, max_nesting_depth, issues
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          snapshotId,
          file.path,
          file.fileName,
          file.linesOfCode,
          file.cyclomaticComplexity,
          file.cognitiveComplexity,
          file.maintainabilityIndex,
          file.technicalDebtScore,
          file.functions.length,
          file.maxNestingDepth,
          JSON.stringify(file.issues)
        ]);
      }

      // Update aggregations
      await this._updateAggregations(client, analysisResults);

      await client.query('COMMIT');
      
      return snapshotId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update aggregation tables
   */
  async _updateAggregations(client, results) {
    const date = new Date();
    const weekStart = this._getWeekStart(date);
    const monthStart = this._getMonthStart(date);

    // Daily aggregation (upsert)
    await client.query(`
      INSERT INTO code_quality_daily (
        snapshot_date, avg_complexity, avg_maintainability, total_debt
      ) VALUES (CURRENT_DATE, $1, $2, $3)
      ON CONFLICT (snapshot_date) DO UPDATE SET
        avg_complexity = EXCLUDED.avg_complexity,
        avg_maintainability = EXCLUDED.avg_maintainability,
        total_debt = EXCLUDED.total_debt
    `, [
      results.summary.avgCyclomaticComplexity,
      results.summary.avgMaintainabilityIndex,
      results.summary.technicalDebtScore
    ]);

    // Weekly aggregation
    await client.query(`
      INSERT INTO code_quality_weekly (week_start, avg_complexity, avg_maintainability, total_debt)
      SELECT $1, AVG(avg_complexity), AVG(avg_maintainability), SUM(total_debt)
      FROM code_quality_daily
      WHERE snapshot_date >= $1 AND snapshot_date < $1 + INTERVAL '7 days'
      ON CONFLICT (week_start) DO UPDATE SET
        avg_complexity = EXCLUDED.avg_complexity,
        avg_maintainability = EXCLUDED.avg_maintainability,
        total_debt = EXCLUDED.total_debt
    `, [weekStart]);

    // Monthly aggregation
    await client.query(`
      INSERT INTO code_quality_monthly (month_start, avg_complexity, avg_maintainability, total_debt)
      SELECT $1, AVG(avg_complexity), AVG(avg_maintainability), SUM(total_debt)
      FROM code_quality_daily
      WHERE snapshot_date >= $1 AND snapshot_date < $1 + INTERVAL '1 month'
      ON CONFLICT (month_start) DO UPDATE SET
        avg_complexity = EXCLUDED.avg_complexity,
        avg_maintainability = EXCLUDED.avg_maintainability,
        total_debt = EXCLUDED.total_debt
    `, [monthStart]);
  }

  /**
   * Get quality trend data
   */
  async getTrend(interval = 'daily', days = 30) {
    let tableName, dateColumn;

    switch (interval) {
      case 'weekly':
        tableName = 'code_quality_weekly';
        dateColumn = 'week_start';
        break;
      case 'monthly':
        tableName = 'code_quality_monthly';
        dateColumn = 'month_start';
        break;
      default:
        tableName = 'code_quality_daily';
        dateColumn = 'snapshot_date';
    }

    const result = await this.pool.query(`
      SELECT ${dateColumn} as date, avg_complexity, avg_maintainability, total_debt
      FROM ${tableName}
      WHERE ${dateColumn} >= NOW() - INTERVAL '${days} days'
      ORDER BY ${dateColumn} ASC
    `);

    return result.rows;
  }

  /**
   * Detect quality degradation
   */
  async detectDegradation(thresholds = {}) {
    const defaults = {
      complexityIncrease: 20,    // Alert if complexity increased by 20%
      maintainabilityDecrease: 15,  // Alert if MI decreased by 15%
      debtIncrease: 25          // Alert if debt increased by 25%
    };

    const config = { ...defaults, ...thresholds };

    // Get last two snapshots
    const result = await this.pool.query(`
      SELECT 
        s1.snapshot_date as current_date,
        s1.avg_cyclomatic_complexity as current_complexity,
        s1.avg_maintainability_index as current_maintainability,
        s1.technical_debt_score as current_debt,
        s2.snapshot_date as previous_date,
        s2.avg_cyclomatic_complexity as previous_complexity,
        s2.avg_maintainability_index as previous_maintainability,
        s2.technical_debt_score as previous_debt
      FROM code_quality_snapshots s1
      CROSS JOIN LATERAL (
        SELECT * FROM code_quality_snapshots
        WHERE snapshot_date < s1.snapshot_date
        ORDER BY snapshot_date DESC
        LIMIT 1
      ) s2
      ORDER BY s1.snapshot_date DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return { degraded: false, reasons: [] };
    }

    const data = result.rows[0];
    const alerts = [];

    // Check complexity increase
    const complexityChange = ((data.current_complexity - data.previous_complexity) / data.previous_complexity) * 100;
    if (complexityChange > config.complexityIncrease) {
      alerts.push({
        type: 'complexity_increase',
        message: `Cyclomatic complexity increased by ${complexityChange.toFixed(1)}%`,
        severity: 'high',
        currentValue: data.current_complexity,
        previousValue: data.previous_complexity
      });
    }

    // Check maintainability decrease
    const maintainabilityChange = ((data.previous_maintainability - data.current_maintainability) / data.previous_maintainability) * 100;
    if (maintainabilityChange > config.maintainabilityDecrease) {
      alerts.push({
        type: 'maintainability_decrease',
        message: `Maintainability index decreased by ${maintainabilityChange.toFixed(1)}%`,
        severity: 'high',
        currentValue: data.current_maintainability,
        previousValue: data.previous_maintainability
      });
    }

    // Check debt increase
    const debtChange = ((data.current_debt - data.previous_debt) / Math.max(1, data.previous_debt)) * 100;
    if (debtChange > config.debtIncrease) {
      alerts.push({
        type: 'debt_increase',
        message: `Technical debt increased by ${debtChange.toFixed(1)}%`,
        severity: 'medium',
        currentValue: data.current_debt,
        previousValue: data.previous_debt
      });
    }

    return {
      degraded: alerts.length > 0,
      alerts,
      comparison: {
        current: {
          date: data.current_date,
          complexity: data.current_complexity,
          maintainability: data.current_maintainability,
          debt: data.current_debt
        },
        previous: {
          date: data.previous_date,
          complexity: data.previous_complexity,
          maintainability: data.previous_maintainability,
          debt: data.previous_debt
        }
      }
    };
  }

  /**
   * Generate historical report
   */
  async generateHistoricalReport(startDate, endDate) {
    const snapshots = await this.pool.query(`
      SELECT *
      FROM code_quality_snapshots
      WHERE snapshot_date >= $1 AND snapshot_date <= $2
      ORDER BY snapshot_date ASC
    `, [startDate, endDate]);

    const fileChanges = await this.pool.query(`
      SELECT
        file_path,
        COUNT(DISTINCT snapshot_id) as snapshot_count,
        AVG(cyclomatic_complexity) as avg_complexity,
        MAX(cyclomatic_complexity) as max_complexity,
        MIN(cyclomatic_complexity) as min_complexity,
        AVG(maintainability_index) as avg_maintainability
      FROM code_quality_file_details
      WHERE snapshot_id IN (
        SELECT id FROM code_quality_snapshots
        WHERE snapshot_date >= $1 AND snapshot_date <= $2
      )
      GROUP BY file_path
      ORDER BY avg_complexity DESC
      LIMIT 50
    `, [startDate, endDate]);

    return {
      period: { startDate, endDate },
      snapshots: snapshots.rows,
      topFiles: fileChanges.rows,
      summary: this._calculateSummary(snapshots.rows)
    };
  }

  /**
   * Calculate summary statistics
   */
  _calculateSummary(snapshots) {
    if (snapshots.length === 0) {
      return null;
    }

    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];

    return {
      snapshotsCount: snapshots.length,
      complexityChange: last.avg_cyclomatic_complexity - first.avg_cyclomatic_complexity,
      maintainabilityChange: last.avg_maintainability_index - first.avg_maintainability_index,
      debtChange: last.technical_debt_score - first.technical_debt_score,
      filesChange: last.total_files - first.total_files,
      linesChange: last.total_lines - first.total_lines,
      trend: this._determineTrend(snapshots)
    };
  }

  /**
   * Determine overall quality trend
   */
  _determineTrend(snapshots) {
    if (snapshots.length < 2) return 'stable';

    const recent = snapshots.slice(-5);
    const older = snapshots.slice(0, -5);

    if (older.length === 0) return 'stable';

    const recentAvgM = recent.reduce((sum, s) => sum + s.avg_maintainability_index, 0) / recent.length;
    const olderAvgM = older.reduce((sum, s) => sum + s.avg_maintainability_index, 0) / older.length;

    const change = recentAvgM - olderAvgM;

    if (change > 3) return 'improving';
    if (change < -3) return 'degrading';
    return 'stable';
  }

  /**
   * Predict future quality (simple linear regression)
   */
  async predictQuality(daysAhead = 30) {
    const result = await this.pool.query(`
      SELECT snapshot_date, avg_maintainability_index, technical_debt_score
      FROM code_quality_daily
      WHERE snapshot_date >= NOW() - INTERVAL '90 days'
      ORDER BY snapshot_date ASC
    `);

    if (result.rows.length < 10) {
      return { predicted: false, reason: 'Insufficient data' };
    }

    const data = result.rows;
    const n = data.length;

    // Simple linear regression for maintainability
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    data.forEach((row, i) => {
      const x = i;
      const y = row.avg_maintainability_index;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    });

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    const predictedMaintainability = intercept + slope * (n + daysAhead);

    // Predict debt
    sumX = 0; sumY = 0; sumXY = 0; sumX2 = 0;
    data.forEach((row, i) => {
      const x = i;
      const y = row.technical_debt_score;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    });

    const debtSlope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const debtIntercept = (sumY - debtSlope * sumX) / n;
    const predictedDebt = debtIntercept + debtSlope * (n + daysAhead);

    return {
      predicted: true,
      predictionDate: new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString(),
      maintainabilityIndex: Math.round(predictedMaintainability * 100) / 100,
      technicalDebtScore: Math.round(predictedDebt),
      confidence: Math.max(0.5, 1 - Math.abs(slope) * 0.1),
      trend: slope > 0.1 ? 'improving' : slope < -0.1 ? 'degrading' : 'stable'
    };
  }

  /**
   * Clean old snapshots based on retention policy
   */
  async cleanOldSnapshots() {
    const result = await this.pool.query(`
      DELETE FROM code_quality_snapshots
      WHERE snapshot_date < NOW() - INTERVAL '${this.config.retentionDays} days'
      RETURNING id
    `);

    return result.rowCount;
  }

  /**
   * Helper: Get start of week
   */
  _getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
  }

  /**
   * Helper: Get start of month
   */
  _getMonthStart(date) {
    const d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
}

module.exports = QualityTrendTracker;