// backend/shared/codeQuality/index.js
// Code Quality module entry point
'use strict';

const CodeComplexityAnalyzer = require('./CodeComplexityAnalyzer');
const RefactoringRecommender = require('./RefactoringRecommender');
const QualityTrendTracker = require('./QualityTrendTracker');
const TechnicalDebtScore = require('./TechnicalDebtScore');

/**
 * Code Quality Management System
 * 
 * Unified entry point for all code quality analysis tools
 */
class CodeQualityManager {
  constructor(config = {}) {
    this.analyzer = new CodeComplexityAnalyzer(config.analyzer);
    this.recommender = new RefactoringRecommender(config.recommender);
    this.debtScorer = new TechnicalDebtScore(config.debtScorer);
    
    // Trend tracker requires database pool
    if (config.dbPool) {
      this.trendTracker = new QualityTrendTracker(config.dbPool, config.trendTracker);
    }

    this.config = config;
  }

  /**
   * Run full analysis pipeline
   */
  async runFullAnalysis(dirPath, options = {}) {
    const startTime = Date.now();

    // Step 1: Analyze code complexity
    console.log('Analyzing code complexity...');
    const analysisResults = await this.analyzer.analyzeDirectory(dirPath, options);

    // Step 2: Generate refactoring recommendations
    console.log('Generating refactoring recommendations...');
    const recommendations = await this.recommender.generateRecommendations(
      analysisResults,
      options.gitHistory || {},
      options.bugTracking || {},
      options.testCoverage || {}
    );

    // Step 3: Calculate technical debt
    console.log('Calculating technical debt...');
    const debtScore = this.debtScorer.calculate(
      analysisResults,
      options.testCoverage || {}
    );

    // Step 4: Save to database if available
    let snapshotId = null;
    if (this.trendTracker && options.saveSnapshot !== false) {
      console.log('Saving quality snapshot...');
      try {
        snapshotId = await this.trendTracker.saveSnapshot(
          analysisResults,
          options.commitHash,
          options.branch || 'main'
        );
      } catch (error) {
        console.error('Failed to save snapshot:', error.message);
      }
    }

    const duration = Date.now() - startTime;

    return {
      analysis: analysisResults,
      recommendations,
      debtScore,
      snapshotId,
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration,
        filesAnalyzed: analysisResults.summary.totalFiles,
        linesAnalyzed: analysisResults.summary.totalLines
      }
    };
  }

  /**
   * Get quick quality summary
   */
  async getQuickSummary(dirPath) {
    const results = await this.analyzer.analyzeDirectory(dirPath);
    const debt = this.debtScorer.calculate(results, {});

    return {
      healthScore: debt.summary.healthScore,
      grade: debt.summary.grade,
      totalDebt: debt.summary.totalScore,
      fileCount: results.summary.totalFiles,
      linesOfCode: results.summary.totalLines,
      avgComplexity: results.summary.avgCyclomaticComplexity,
      avgMaintainability: results.summary.avgMaintainabilityIndex,
      hotspots: debt.summary.hotspots.slice(0, 5),
      topViolations: Object.entries(debt.summary.violations)
        .filter(([_, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
    };
  }

  /**
   * Analyze a single file
   */
  async analyzeFile(filePath) {
    const fileMetrics = await this.analyzer.analyzeFile(filePath);
    return fileMetrics;
  }

  /**
   * Get components
   */
  getAnalyzer() {
    return this.analyzer;
  }

  getRecommender() {
    return this.recommender;
  }

  getDebtScorer() {
    return this.debtScorer;
  }

  getTrendTracker() {
    return this.trendTracker;
  }
}

// Export all components
module.exports = {
  CodeQualityManager,
  CodeComplexityAnalyzer,
  RefactoringRecommender,
  QualityTrendTracker,
  TechnicalDebtScore
};