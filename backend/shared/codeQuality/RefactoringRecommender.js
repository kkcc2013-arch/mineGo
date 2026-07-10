// backend/shared/codeQuality/RefactoringRecommender.js
// Intelligent refactoring priority recommendation engine
'use strict';

/**
 * Refactoring Recommender
 * 
 * Analyzes code complexity results and generates prioritized refactoring recommendations
 * based on multiple factors:
 * - Complexity metrics
 * - Change frequency (Git history)
 * - Bug history
 * - Test coverage
 * - Dependency count
 */
class RefactoringRecommender {
  constructor(config = {}) {
    this.config = {
      weights: {
        complexity: 0.30,           // Weight for complexity score
        changeFrequency: 0.25,     // Weight for how often file changes
        bugHistory: 0.20,           // Weight for historical bugs
        testCoverage: 0.15,         // Weight for test coverage impact
        dependencyCount: 0.10      // Weight for number of dependents
      },
      priorityThreshold: {
        critical: 0.85,             // Score >= 0.85 is critical
        high: 0.70,                 // Score >= 0.70 is high
        medium: 0.50,               // Score >= 0.50 is medium
        low: 0.30                   // Score >= 0.30 is low
      },
      ...config
    };

    this.recommendations = [];
  }

  /**
   * Generate refactoring recommendations from analysis results
   * 
   * @param {Object} analysisResults - Results from CodeComplexityAnalyzer
   * @param {Object} gitHistory - Git history data (optional)
   * @param {Object} bugTracking - Bug tracking data (optional)
   * @param {Object} testCoverage - Test coverage data (optional)
   * @returns {Array} Sorted list of refactoring recommendations
   */
  async generateRecommendations(analysisResults, gitHistory = {}, bugTracking = {}, testCoverage = {}) {
    this.recommendations = [];

    for (const file of analysisResults.files) {
      const score = this._calculateRefactoringScore(
        file,
        gitHistory[file.path] || {},
        bugTracking[file.path] || {},
        testCoverage[file.path] || {}
      );

      if (score.priority > this.config.priorityThreshold.low) {
        this.recommendations.push({
          file: file.path,
          fileName: file.fileName,
          priority: score.priority,
          priorityLevel: this._getPriorityLevel(score.priority),
          score: score,
          reasons: this._identifyReasons(file, gitHistory[file.path], bugTracking[file.path]),
          suggestedActions: this._suggestRefactoringActions(file),
          estimatedEffort: this._estimateEffort(file),
          impact: this._estimateImpact(file, gitHistory[file.path]),
          metrics: {
            cyclomaticComplexity: file.cyclomaticComplexity,
            cognitiveComplexity: file.cognitiveComplexity,
            maintainabilityIndex: file.maintainabilityIndex,
            linesOfCode: file.linesOfCode,
            functionCount: file.functions.length,
            technicalDebtScore: file.technicalDebtScore
          }
        });
      }
    }

    // Sort by priority (descending)
    this.recommendations.sort((a, b) => b.priority - a.priority);

    return this.recommendations;
  }

  /**
   * Calculate refactoring priority score
   * 
   * @returns {Object} Score breakdown
   */
  _calculateRefactoringScore(file, gitData, bugData, coverageData) {
    const weights = this.config.weights;

    // Complexity score (0-1)
    const complexityScore = this._normalizeComplexity(file);

    // Change frequency score (0-1)
    const changeScore = this._normalizeChangeFrequency(gitData);

    // Bug history score (0-1)
    const bugScore = this._normalizeBugHistory(bugData);

    // Test coverage impact (0-1, inverted - low coverage = high score)
    const coverageScore = this._normalizeTestCoverage(coverageData);

    // Dependency count score (0-1)
    const dependencyScore = this._normalizeDependencies(file);

    // Calculate weighted total
    const totalScore = 
      complexityScore * weights.complexity +
      changeScore * weights.changeFrequency +
      bugScore * weights.bugHistory +
      coverageScore * weights.testCoverage +
      dependencyScore * weights.dependencyCount;

    return {
      total: Math.min(1, totalScore),
      breakdown: {
        complexity: complexityScore,
        changeFrequency: changeScore,
        bugHistory: bugScore,
        testCoverage: coverageScore,
        dependency: dependencyScore
      }
    };
  }

  /**
   * Normalize complexity to 0-1 scale
   */
  _normalizeComplexity(file) {
    // Combine multiple complexity metrics
    const cycloScore = Math.min(1, file.cyclomaticComplexity / 50);
    const cognitiveScore = Math.min(1, file.cognitiveComplexity / 100);
    const miScore = Math.max(0, (100 - file.maintainabilityIndex) / 100);
    const debtScore = Math.min(1, file.technicalDebtScore / 100);

    return (cycloScore + cognitiveScore + miScore + debtScore) / 4;
  }

  /**
   * Normalize change frequency to 0-1 scale
   */
  _normalizeChangeFrequency(gitData) {
    if (!gitData.commitCount) return 0.3; // Default medium score

    // Files changed very frequently are hot spots
    // Files changed rarely might be stable or neglected
    const commits = gitData.commitCount;
    
    if (commits > 100) return 1.0;    // Very high churn
    if (commits > 50) return 0.8;    // High churn
    if (commits > 20) return 0.6;    // Medium churn
    if (commits > 10) return 0.4;    // Low churn
    return 0.2;                       // Stable
  }

  /**
   * Normalize bug history to 0-1 scale
   */
  _normalizeBugHistory(bugData) {
    if (!bugData.bugCount) return 0.2; // Default low score

    const bugs = bugData.bugCount;
    const severity = bugData.avgSeverity || 1;

    // More bugs = higher refactoring priority
    const bugScore = Math.min(1, bugs / 20);
    const severityScore = severity / 5;

    return (bugScore + severityScore) / 2;
  }

  /**
   * Normalize test coverage impact
   */
  _normalizeTestCoverage(coverageData) {
    if (!coverageData.coverage) return 0.5; // Unknown coverage

    // Low coverage = higher refactoring need (risky)
    return 1 - Math.min(1, coverageData.coverage / 100);
  }

  /**
   * Normalize dependency count impact
   */
  _normalizeDependencies(file) {
    // Files imported by many others are high impact
    const importCount = file.imports?.length || 0;
    const exportCount = file.exports?.length || 0;

    // Simple heuristic: more exports = more likely to be used
    return Math.min(1, exportCount / 10);
  }

  /**
   * Identify reasons for refactoring recommendation
   */
  _identifyReasons(file, gitData, bugData) {
    const reasons = [];

    // Complexity reasons
    if (file.cyclomaticComplexity > 15) {
      reasons.push({
        type: 'high_complexity',
        message: `High cyclomatic complexity (${file.cyclomaticComplexity})`,
        severity: 'high'
      });
    }

    if (file.cognitiveComplexity > 20) {
      reasons.push({
        type: 'high_cognitive_complexity',
        message: `High cognitive complexity (${file.cognitiveComplexity})`,
        severity: 'high'
      });
    }

    if (file.maintainabilityIndex < 65) {
      reasons.push({
        type: 'low_maintainability',
        message: `Low maintainability index (${file.maintainabilityIndex})`,
        severity: 'medium'
      });
    }

    // Long functions
    const longFunctions = file.functions.filter(f => f.linesOfCode > 50);
    if (longFunctions.length > 0) {
      reasons.push({
        type: 'long_functions',
        message: `${longFunctions.length} functions exceed 50 lines`,
        severity: 'medium',
        details: longFunctions.map(f => f.name)
      });
    }

    // Deep nesting
    if (file.maxNestingDepth > 4) {
      reasons.push({
        type: 'deep_nesting',
        message: `Maximum nesting depth is ${file.maxNestingDepth}`,
        severity: 'medium'
      });
    }

    // Git history reasons
    if (gitData?.commitCount > 50) {
      reasons.push({
        type: 'high_churn',
        message: `File changed ${gitData.commitCount} times`,
        severity: 'low'
      });
    }

    // Bug history reasons
    if (bugData?.bugCount > 5) {
      reasons.push({
        type: 'bug_prone',
        message: `${bugData.bugCount} bugs reported in this file`,
        severity: 'high'
      });
    }

    return reasons;
  }

  /**
   * Suggest specific refactoring actions
   */
  _suggestRefactoringActions(file) {
    const actions = [];

    // Extract method suggestions
    const longFunctions = file.functions.filter(f => f.linesOfCode > 50);
    for (const func of longFunctions) {
      actions.push({
        type: 'extract_method',
        message: `Extract logic from "${func.name}" into smaller functions`,
        function: func.name,
        estimatedLinesReduced: Math.floor(func.linesOfCode / 2)
      });
    }

    // Reduce complexity
    if (file.cyclomaticComplexity > 15) {
      actions.push({
        type: 'reduce_complexity',
        message: 'Break down complex conditional logic using guard clauses or strategy pattern',
        estimatedComplexityReduction: Math.floor(file.cyclomaticComplexity * 0.3)
      });
    }

    // Flatten nesting
    if (file.maxNestingDepth > 4) {
      actions.push({
        type: 'flatten_nesting',
        message: 'Use early returns or extract methods to reduce nesting depth'
      });
    }

    // Split file
    if (file.functions.length > 15) {
      actions.push({
        type: 'split_file',
        message: `Split ${file.functions.length} functions into multiple modules by responsibility`,
        suggestedModules: Math.ceil(file.functions.length / 10)
      });
    }

    // Add tests
    if (!file.hasTests) {
      actions.push({
        type: 'add_tests',
        message: 'Add unit tests to ensure safe refactoring',
        suggestedTestCount: Math.ceil(file.functions.length * 0.8)
      });
    }

    return actions;
  }

  /**
   * Estimate refactoring effort in hours
   */
  _estimateEffort(file) {
    let hours = 0;

    // Base effort for complexity
    hours += Math.ceil(file.cyclomaticComplexity / 5);

    // Effort for long functions
    const longFunctions = file.functions.filter(f => f.linesOfCode > 50);
    hours += longFunctions.length * 2;

    // Effort for deep nesting
    if (file.maxNestingDepth > 4) {
      hours += (file.maxNestingDepth - 4) * 2;
    }

    // Effort for large files
    if (file.linesOfCode > 500) {
      hours += Math.ceil((file.linesOfCode - 500) / 100);
    }

    // Testing effort
    hours += Math.ceil(file.functions.length * 0.5);

    return {
      hours: Math.max(1, hours),
      level: this._getEffortLevel(hours),
      confidence: this._getEffortConfidence(file)
    };
  }

  /**
   * Get effort level label
   */
  _getEffortLevel(hours) {
    if (hours <= 2) return 'trivial';
    if (hours <= 4) return 'small';
    if (hours <= 8) return 'medium';
    if (hours <= 16) return 'large';
    return 'extra-large';
  }

  /**
   * Estimate impact of refactoring
   */
  _estimateImpact(file, gitData) {
    return {
      risk: this._assessRisk(file),
      benefit: this._assessBenefit(file),
      affectedFiles: gitData?.dependents?.length || 0,
      breakingChangeProbability: this._assessBreakingChange(file)
    };
  }

  /**
   * Assess refactoring risk
   */
  _assessRisk(file) {
    const factors = [];
    let riskScore = 0;

    if (file.exports.length > 5) {
      factors.push('Public API');
      riskScore += 2;
    }

    if (!file.hasTests) {
      factors.push('No tests');
      riskScore += 3;
    }

    if (file.functions.length > 10) {
      factors.push('Many functions');
      riskScore += 1;
    }

    return {
      level: riskScore > 4 ? 'high' : riskScore > 2 ? 'medium' : 'low',
      score: riskScore,
      factors
    };
  }

  /**
   * Assess refactoring benefit
   */
  _assessBenefit(file) {
    let benefitScore = 0;

    if (file.cyclomaticComplexity > 15) benefitScore += 2;
    if (file.maintainabilityIndex < 65) benefitScore += 2;
    if (file.technicalDebtScore > 20) benefitScore += 2;
    if (file.functions.some(f => f.linesOfCode > 100)) benefitScore += 1;

    return {
      score: benefitScore,
      level: benefitScore >= 5 ? 'high' : benefitScore >= 3 ? 'medium' : 'low'
    };
  }

  /**
   * Assess probability of breaking changes
   */
  _assessBreakingChange(file) {
    if (file.exports.length > 5) return 'high';
    if (file.exports.length > 2) return 'medium';
    return 'low';
  }

  /**
   * Get effort confidence level
   */
  _getEffortConfidence(file) {
    // Higher confidence for files with clear issues
    if (file.issues.length > 3) return 'high';
    if (file.issues.length > 0) return 'medium';
    return 'low';
  }

  /**
   * Get priority level label
   */
  _getPriorityLevel(score) {
    const thresholds = this.config.priorityThreshold;

    if (score >= thresholds.critical) return 'critical';
    if (score >= thresholds.high) return 'high';
    if (score >= thresholds.medium) return 'medium';
    return 'low';
  }

  /**
   * Generate prioritized action plan
   */
  generateActionPlan() {
    const plan = {
      critical: [],
      high: [],
      medium: [],
      low: []
    };

    for (const rec of this.recommendations) {
      plan[rec.priorityLevel].push(rec);
    }

    return {
      plan,
      summary: {
        total: this.recommendations.length,
        critical: plan.critical.length,
        high: plan.high.length,
        medium: plan.medium.length,
        low: plan.low.length,
        estimatedTotalHours: this.recommendations.reduce((sum, r) => sum + r.estimatedEffort.hours, 0)
      }
    };
  }

  /**
   * Export recommendations to different formats
   */
  export(format = 'json') {
    if (format === 'json') {
      return JSON.stringify(this.recommendations, null, 2);
    }

    if (format === 'markdown') {
      return this._exportMarkdown();
    }

    if (format === 'csv') {
      return this._exportCSV();
    }

    return this.recommendations;
  }

  /**
   * Export as Markdown report
   */
  _exportMarkdown() {
    const lines = [];
    lines.push('# Refactoring Recommendations Report\n');
    lines.push(`Generated: ${new Date().toISOString()}\n`);

    const plan = this.generateActionPlan();

    for (const level of ['critical', 'high', 'medium', 'low']) {
      if (plan.plan[level].length > 0) {
        lines.push(`\n## ${level.toUpperCase()} Priority (${plan.plan[level].length})\n`);

        for (const rec of plan.plan[level]) {
          lines.push(`\n### ${rec.fileName}`);
          lines.push(`- **Priority Score**: ${rec.priority.toFixed(3)}`);
          lines.push(`- **Estimated Effort**: ${rec.estimatedEffort.hours} hours (${rec.estimatedEffort.level})`);
          lines.push(`- **Reasons**:`);
          for (const reason of rec.reasons) {
            lines.push(`  - ${reason.message}`);
          }
          lines.push(`- **Suggested Actions**:`);
          for (const action of rec.suggestedActions) {
            lines.push(`  - ${action.message}`);
          }
        }
      }
    }

    lines.push('\n## Summary\n');
    lines.push(`- Total Recommendations: ${plan.summary.total}`);
    lines.push(`- Critical: ${plan.summary.critical}`);
    lines.push(`- High: ${plan.summary.high}`);
    lines.push(`- Medium: ${plan.summary.medium}`);
    lines.push(`- Low: ${plan.summary.low}`);
    lines.push(`- Estimated Total Hours: ${plan.summary.estimatedTotalHours}`);

    return lines.join('\n');
  }

  /**
   * Export as CSV
   */
  _exportCSV() {
    const headers = ['file', 'priority', 'priorityLevel', 'hours', 'complexity', 'maintainability', 'reasons'];
    const rows = [headers.join(',')];

    for (const rec of this.recommendations) {
      const row = [
        rec.file,
        rec.priority.toFixed(3),
        rec.priorityLevel,
        rec.estimatedEffort.hours,
        rec.metrics.cyclomaticComplexity,
        rec.metrics.maintainabilityIndex,
        `"${rec.reasons.map(r => r.message).join('; ')}"`
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }
}

module.exports = RefactoringRecommender;