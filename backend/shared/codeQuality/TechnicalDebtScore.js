// backend/shared/codeQuality/TechnicalDebtScore.js
// Technical debt scoring and tracking system
'use strict';

/**
 * Technical Debt Score Calculator
 * 
 * Calculates and tracks technical debt based on:
 * - Code complexity
 * - Test coverage
 * - Documentation
 * - Code duplication
 * - Known issues
 * - Dependencies health
 */
class TechnicalDebtScore {
  constructor(config = {}) {
    this.config = {
      rules: {
        'high_complexity': {
          threshold: 15,
          points: 5,
          description: 'Cyclomatic complexity exceeds 15'
        },
        'very_high_complexity': {
          threshold: 25,
          points: 10,
          description: 'Cyclomatic complexity exceeds 25'
        },
        'low_maintainability': {
          threshold: 65,
          points: 4,
          description: 'Maintainability index below 65'
        },
        'very_low_maintainability': {
          threshold: 50,
          points: 8,
          description: 'Maintainability index below 50'
        },
        'long_function': {
          threshold: 50,
          points: 3,
          description: 'Function exceeds 50 lines'
        },
        'very_long_function': {
          threshold: 100,
          points: 6,
          description: 'Function exceeds 100 lines'
        },
        'deep_nesting': {
          threshold: 4,
          points: 3,
          description: 'Nesting depth exceeds 4 levels'
        },
        'many_parameters': {
          threshold: 5,
          points: 2,
          description: 'Function has more than 5 parameters'
        },
        'no_tests': {
          threshold: 0,
          points: 4,
          description: 'File has no unit tests'
        },
        'low_coverage': {
          threshold: 50,
          points: 3,
          description: 'Test coverage below 50%'
        },
        'large_file': {
          threshold: 500,
          points: 3,
          description: 'File exceeds 500 lines'
        },
        'too_many_functions': {
          threshold: 20,
          points: 2,
          description: 'File has more than 20 functions'
        },
        'high_cognitive_complexity': {
          threshold: 20,
          points: 4,
          description: 'Cognitive complexity exceeds 20'
        }
      },
      weights: {
        complexity: 1.0,
        maintainability: 0.8,
        functions: 0.6,
        tests: 1.2,
        structure: 0.5
      },
      ...config
    };

    this.scores = {
      files: [],
      summary: {
        totalScore: 0,
        healthScore: 100,
        breakdown: {},
        hotspots: []
      }
    };
  }

  /**
   * Calculate technical debt for a project
   * 
   * @param {Object} analysisResults - Results from CodeComplexityAnalyzer
   * @param {Object} testCoverage - Test coverage data
   * @returns {Object} Debt score results
   */
  calculate(analysisResults, testCoverage = {}) {
    this.scores = {
      files: [],
      summary: {
        totalScore: 0,
        healthScore: 100,
        breakdown: {
          complexity: 0,
          maintainability: 0,
          functions: 0,
          tests: 0,
          structure: 0
        },
        hotspots: [],
        violations: {
          high_complexity: 0,
          very_high_complexity: 0,
          low_maintainability: 0,
          very_low_maintainability: 0,
          long_function: 0,
          very_long_function: 0,
          deep_nesting: 0,
          many_parameters: 0,
          no_tests: 0,
          low_coverage: 0,
          large_file: 0,
          too_many_functions: 0,
          high_cognitive_complexity: 0
        }
      },
      analyzedAt: new Date().toISOString()
    };

    // Calculate debt for each file
    for (const file of analysisResults.files) {
      const fileDebt = this._calculateFileDebt(
        file,
        testCoverage[file.path] || { coverage: 0, hasTests: false }
      );

      if (fileDebt.score > 0) {
        this.scores.files.push({
          path: file.path,
          fileName: file.fileName,
          score: fileDebt.score,
          violations: fileDebt.violations,
          metrics: {
            complexity: file.cyclomaticComplexity,
            maintainability: file.maintainabilityIndex,
            linesOfCode: file.linesOfCode
          }
        });

        this.scores.summary.totalScore += fileDebt.score;

        // Update breakdown
        for (const [category, points] of Object.entries(fileDebt.categories)) {
          this.scores.summary.breakdown[category] = 
            (this.scores.summary.breakdown[category] || 0) + points;
        }

        // Update violations count
        for (const violation of fileDebt.violations) {
          this.scores.summary.violations[violation.type] = 
            (this.scores.summary.violations[violation.type] || 0) + 1;
        }

        // Track hotspots (high debt files)
        if (fileDebt.score > 20) {
          this.scores.summary.hotspots.push({
            path: file.path,
            score: fileDebt.score,
            topViolation: fileDebt.violations[0]?.type || 'unknown'
          });
        }
      }
    }

    // Sort files by debt score
    this.scores.files.sort((a, b) => b.score - a.score);

    // Sort hotspots
    this.scores.summary.hotspots.sort((a, b) => b.score - a.score);
    this.scores.summary.hotspots = this.scores.summary.hotspots.slice(0, 20);

    // Calculate health score (0-100)
    const totalFiles = analysisResults.summary.totalFiles || 1;
    const avgDebtPerFile = this.scores.summary.totalScore / totalFiles;
    this.scores.summary.healthScore = Math.max(0, Math.min(100, 100 - avgDebtPerFile * 2));

    // Add grade
    this.scores.summary.grade = this._calculateGrade(this.scores.summary.healthScore);

    return this.scores;
  }

  /**
   * Calculate debt for a single file
   */
  _calculateFileDebt(file, coverage) {
    const debt = {
      score: 0,
      violations: [],
      categories: {
        complexity: 0,
        maintainability: 0,
        functions: 0,
        tests: 0,
        structure: 0
      }
    };

    const rules = this.config.rules;
    const weights = this.config.weights;

    // Check cyclomatic complexity
    if (file.cyclomaticComplexity > rules.very_high_complexity.threshold) {
      const violation = {
        type: 'very_high_complexity',
        points: rules.very_high_complexity.points,
        description: rules.very_high_complexity.description,
        value: file.cyclomaticComplexity
      };
      debt.violations.push(violation);
      debt.score += violation.points * weights.complexity;
      debt.categories.complexity += violation.points;
    } else if (file.cyclomaticComplexity > rules.high_complexity.threshold) {
      const violation = {
        type: 'high_complexity',
        points: rules.high_complexity.points,
        description: rules.high_complexity.description,
        value: file.cyclomaticComplexity
      };
      debt.violations.push(violation);
      debt.score += violation.points * weights.complexity;
      debt.categories.complexity += violation.points;
    }

    // Check cognitive complexity
    if (file.cognitiveComplexity > rules.high_cognitive_complexity.threshold) {
      const violation = {
        type: 'high_cognitive_complexity',
        points: rules.high_cognitive_complexity.points,
        description: rules.high_cognitive_complexity.description,
        value: file.cognitiveComplexity
      };
      debt.violations.push(violation);
      debt.score += violation.points * weights.complexity;
      debt.categories.complexity += violation.points;
    }

    // Check maintainability index
    if (file.maintainabilityIndex < rules.very_low_maintainability.threshold) {
      const violation = {
        type: 'very_low_maintainability',
        points: rules.very_low_maintainability.points,
        description: rules.very_low_maintainability.description,
        value: file.maintainabilityIndex
      };
      debt.violations.push(violation);
      debt.score += violation.points * weights.maintainability;
      debt.categories.maintainability += violation.points;
    } else if (file.maintainabilityIndex < rules.low_maintainability.threshold) {
      const violation = {
        type: 'low_maintainability',
        points: rules.low_maintainability.points,
        description: rules.low_maintainability.description,
        value: file.maintainabilityIndex
      };
      debt.violations.push(violation);
      debt.score += violation.points * weights.maintainability;
      debt.categories.maintainability += violation.points;
    }

    // Check file size
    if (file.linesOfCode > rules.large_file.threshold) {
      const violation = {
        type: 'large_file',
        points: rules.large_file.points,
        description: rules.large_file.description,
        value: file.linesOfCode
      };
      debt.violations.push(violation);
      debt.score += violation.points * weights.structure;
      debt.categories.structure += violation.points;
    }

    // Check function count
    if (file.functions.length > rules.too_many_functions.threshold) {
      const violation = {
        type: 'too_many_functions',
        points: rules.too_many_functions.points,
        description: rules.too_many_functions.description,
        value: file.functions.length
      };
      debt.violations.push(violation);
      debt.score += violation.points * weights.structure;
      debt.categories.structure += violation.points;
    }

    // Check each function
    for (const func of file.functions) {
      // Long functions
      if (func.linesOfCode > rules.very_long_function.threshold) {
        const violation = {
          type: 'very_long_function',
          points: rules.very_long_function.points,
          description: `${func.name}: ${rules.very_long_function.description}`,
          value: func.linesOfCode,
          function: func.name
        };
        debt.violations.push(violation);
        debt.score += violation.points * weights.functions;
        debt.categories.functions += violation.points;
      } else if (func.linesOfCode > rules.long_function.threshold) {
        const violation = {
          type: 'long_function',
          points: rules.long_function.points,
          description: `${func.name}: ${rules.long_function.description}`,
          value: func.linesOfCode,
          function: func.name
        };
        debt.violations.push(violation);
        debt.score += violation.points * weights.functions;
        debt.categories.functions += violation.points;
      }

      // Too many parameters
      if (func.parameters && func.parameters.length > rules.many_parameters.threshold) {
        const violation = {
          type: 'many_parameters',
          points: rules.many_parameters.points,
          description: `${func.name}: ${rules.many_parameters.description}`,
          value: func.parameters.length,
          function: func.name
        };
        debt.violations.push(violation);
        debt.score += violation.points * weights.functions;
        debt.categories.functions += violation.points;
      }
    }

    // Check nesting depth
    if (file.maxNestingDepth > rules.deep_nesting.threshold) {
      const violation = {
        type: 'deep_nesting',
        points: rules.deep_nesting.points,
        description: rules.deep_nesting.description,
        value: file.maxNestingDepth
      };
      debt.violations.push(violation);
      debt.score += violation.points * weights.structure;
      debt.categories.structure += violation.points;
    }

    // Check test coverage
    if (!coverage.hasTests) {
      const violation = {
        type: 'no_tests',
        points: rules.no_tests.points,
        description: rules.no_tests.description,
        value: 0
      };
      debt.violations.push(violation);
      debt.score += violation.points * weights.tests;
      debt.categories.tests += violation.points;
    } else if (coverage.coverage < rules.low_coverage.threshold) {
      const violation = {
        type: 'low_coverage',
        points: rules.low_coverage.points,
        description: rules.low_coverage.description,
        value: coverage.coverage
      };
      debt.violations.push(violation);
      debt.score += violation.points * weights.tests;
      debt.categories.tests += violation.points;
    }

    return debt;
  }

  /**
   * Calculate project grade based on health score
   */
  _calculateGrade(healthScore) {
    if (healthScore >= 90) return 'A';
    if (healthScore >= 80) return 'B';
    if (healthScore >= 70) return 'C';
    if (healthScore >= 60) return 'D';
    if (healthScore >= 50) return 'E';
    return 'F';
  }

  /**
   * Get debt score history comparison
   */
  async compareWithHistory(currentScore, previousScores = []) {
    if (previousScores.length === 0) {
      return {
        change: 0,
        trend: 'unknown',
        message: 'No historical data available'
      };
    }

    const avgPrevious = previousScores.reduce((sum, s) => sum + s.healthScore, 0) / previousScores.length;
    const change = currentScore.healthScore - avgPrevious;

    let trend = 'stable';
    let message = '';

    if (change > 5) {
      trend = 'improving';
      message = `Health score improved by ${change.toFixed(1)} points`;
    } else if (change < -5) {
      trend = 'degrading';
      message = `Health score decreased by ${Math.abs(change).toFixed(1)} points`;
    } else {
      message = 'Health score is stable';
    }

    return {
      change: Math.round(change * 10) / 10,
      trend,
      message,
      previousAverage: Math.round(avgPrevious * 10) / 10
    };
  }

  /**
   * Generate debt reduction recommendations
   */
  generateReductionPlan(maxHours = 40) {
    const plan = [];
    let hoursRemaining = maxHours;

    // Prioritize by impact (score reduction per hour)
    const prioritizedFiles = this.scores.files
      .map(file => ({
        ...file,
        effort: Math.ceil(file.score / 5),
        impact: file.score
      }))
      .sort((a, b) => b.impact / b.effort - a.impact / b.effort);

    for (const file of prioritizedFiles) {
      if (hoursRemaining <= 0) break;

      if (file.effort <= hoursRemaining) {
        plan.push({
          file: file.path,
          score: file.score,
          effort: file.effort,
          violations: file.violations,
          priority: plan.length + 1
        });
        hoursRemaining -= file.effort;
      }
    }

    return {
      plan,
      summary: {
        totalFiles: plan.length,
        totalEffort: plan.reduce((sum, p) => sum + p.effort, 0),
        potentialScoreReduction: plan.reduce((sum, p) => sum + p.score, 0)
      }
    };
  }

  /**
   * Export debt report
   */
  export(format = 'json') {
    if (format === 'json') {
      return JSON.stringify(this.scores, null, 2);
    }

    if (format === 'markdown') {
      const lines = [
        '# Technical Debt Report',
        '',
        `**Generated**: ${this.scores.analyzedAt}`,
        `**Health Score**: ${this.scores.summary.healthScore.toFixed(1)} (Grade: ${this.scores.summary.grade})`,
        `**Total Debt Score**: ${this.scores.summary.totalScore}`,
        '',
        '## Debt Breakdown',
        '',
        `| Category | Score |`,
        `|----------|-------|`,
        `| Complexity | ${this.scores.summary.breakdown.complexity || 0} |`,
        `| Maintainability | ${this.scores.summary.breakdown.maintainability || 0} |`,
        `| Functions | ${this.scores.summary.breakdown.functions || 0} |`,
        `| Tests | ${this.scores.summary.breakdown.tests || 0} |`,
        `| Structure | ${this.scores.summary.breakdown.structure || 0} |`,
        '',
        '## Top Debt Hotspots',
        ''
      ];

      for (const hotspot of this.scores.summary.hotspots.slice(0, 10)) {
        lines.push(`- ${hotspot.path} (Score: ${hotspot.score})`);
      }

      lines.push('', '## Violation Counts', '');
      for (const [type, count] of Object.entries(this.scores.summary.violations)) {
        if (count > 0) {
          lines.push(`- ${type}: ${count}`);
        }
      }

      return lines.join('\n');
    }

    return this.scores;
  }
}

module.exports = TechnicalDebtScore;