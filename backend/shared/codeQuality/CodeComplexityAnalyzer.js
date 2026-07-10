// backend/shared/codeQuality/CodeComplexityAnalyzer.js
// Code complexity analysis engine for technical debt measurement
'use strict';

const fs = require('fs').promises;
const path = require('path');

/**
 * Code Complexity Analyzer
 * 
 * Analyzes JavaScript code complexity using multiple metrics:
 * - Cyclomatic Complexity (McCabe)
 * - Cognitive Complexity (SonarSource)
 * - Lines of Code
 * - Function metrics
 * - Nesting depth
 * - Maintainability Index
 */
class CodeComplexityAnalyzer {
  constructor(config = {}) {
    this.config = {
      maxFileLines: config.maxFileLines || 500,
      maxFunctionLines: config.maxFunctionLines || 50,
      maxCyclomaticComplexity: config.maxCyclomaticComplexity || 15,
      maxCognitiveComplexity: config.maxCognitiveComplexity || 20,
      maxNestingDepth: config.maxNestingDepth || 4,
      maxParameters: config.maxParameters || 5,
      ignorePatterns: config.ignorePatterns || ['node_modules', 'test', 'spec', '__tests__'],
      ...config
    };

    this.results = {
      files: [],
      summary: {
        totalFiles: 0,
        totalLines: 0,
        totalFunctions: 0,
        avgCyclomaticComplexity: 0,
        avgCognitiveComplexity: 0,
        avgMaintainabilityIndex: 0,
        highComplexityFiles: [],
        highComplexityFunctions: []
      }
    };
  }

  /**
   * Analyze a single file
   * @param {string} filePath - Path to the file
   * @returns {Object} File analysis results
   */
  async analyzeFile(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    
    const fileMetrics = {
      path: filePath,
      fileName: path.basename(filePath),
      linesOfCode: this._countLOC(lines),
      blankLines: this._countBlankLines(lines),
      commentLines: this._countCommentLines(lines),
      totalLines: lines.length,
      functions: [],
      imports: [],
      exports: [],
      classes: [],
      cyclomaticComplexity: 1,
      cognitiveComplexity: 0,
      maxNestingDepth: 0,
      maintainabilityIndex: 100,
      halsteadVolume: 0,
      halsteadDifficulty: 0,
      technicalDebtScore: 0,
      issues: []
    };

    // Parse code structure
    this._parseCodeStructure(content, fileMetrics);
    
    // Calculate complexity for each function
    let totalFuncComplexity = 0;
    let totalFuncCognitive = 0;
    
    for (const func of fileMetrics.functions) {
      const complexity = this._calculateCyclomaticComplexity(func, content);
      const cognitive = this._calculateCognitiveComplexity(func, content);
      const nesting = this._calculateNestingDepth(func, content);
      
      func.cyclomaticComplexity = complexity;
      func.cognitiveComplexity = cognitive;
      func.nestingDepth = nesting;
      func.linesOfCode = func.endLine - func.startLine + 1;
      
      totalFuncComplexity += complexity;
      totalFuncCognitive += cognitive;
      fileMetrics.cyclomaticComplexity += complexity - 1;
      fileMetrics.cognitiveComplexity += cognitive;
      fileMetrics.maxNestingDepth = Math.max(fileMetrics.maxNestingDepth, nesting);

      // Check for function-level issues
      this._checkFunctionIssues(func, fileMetrics);
    }

    // Calculate Halstead metrics (simplified)
    const halstead = this._calculateHalsteadMetrics(content);
    fileMetrics.halsteadVolume = halstead.volume;
    fileMetrics.halsteadDifficulty = halstead.difficulty;

    // Calculate maintainability index
    fileMetrics.maintainabilityIndex = this._calculateMaintainabilityIndex(fileMetrics);

    // Calculate technical debt score
    fileMetrics.technicalDebtScore = this._calculateTechnicalDebtScore(fileMetrics);

    // Check for file-level issues
    this._checkFileIssues(fileMetrics);

    return fileMetrics;
  }

  /**
   * Parse code structure to extract functions, classes, imports, exports
   */
  _parseCodeStructure(content, metrics) {
    const lines = content.split('\n');
    
    // Simple regex-based parsing (production would use proper AST parser)
    const functionPattern = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|(\w+)\s*:\s*(?:async\s*)?\(|(?:async\s+)?(\w+)\s*\([^)]*\)\s*{)/g;
    const arrowFunctionPattern = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g;
    const classPattern = /class\s+(\w+)/g;
    const importPattern = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
    const exportPattern = /export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/g;
    
    let match;
    let braceDepth = 0;
    let inFunction = false;
    let currentFunction = null;
    let functionStartLine = 0;

    lines.forEach((line, lineIndex) => {
      const lineNum = lineIndex + 1;
      
      // Track functions
      if (!inFunction) {
        const funcMatch = line.match(/(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*{/) ||
                          line.match(/(\w+)\s*\([^)]*\)\s*{/);
        if (funcMatch) {
          inFunction = true;
          functionStartLine = lineNum;
          currentFunction = {
            name: funcMatch[1] || funcMatch[2] || 'anonymous',
            startLine: lineNum,
            endLine: lineNum,
            parameters: this._extractParameters(line),
            isAsync: line.includes('async'),
            isArrow: line.includes('=>')
          };
        }
      }

      // Track brace depth
      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;

      if (inFunction && braceDepth === 0 && line.includes('}')) {
        currentFunction.endLine = lineNum;
        metrics.functions.push(currentFunction);
        inFunction = false;
        currentFunction = null;
      }

      // Track imports
      while ((match = importPattern.exec(line)) !== null) {
        metrics.imports.push({
          module: match[1],
          line: lineNum
        });
      }

      // Track exports
      while ((match = exportPattern.exec(line)) !== null) {
        metrics.exports.push({
          name: match[1],
          line: lineNum
        });
      }

      // Track classes
      while ((match = classPattern.exec(line)) !== null) {
        metrics.classes.push({
          name: match[1],
          line: lineNum
        });
      }
    });

    // Handle arrow functions without braces
    lines.forEach((line, lineIndex) => {
      if (line.includes('=>') && !line.includes('{')) {
        metrics.functions.push({
          name: 'anonymous_arrow',
          startLine: lineIndex + 1,
          endLine: lineIndex + 1,
          parameters: this._extractParameters(line),
          isAsync: line.includes('async'),
          isArrow: true,
          linesOfCode: 1,
          cyclomaticComplexity: 1,
          cognitiveComplexity: 0,
          nestingDepth: 0
        });
      }
    });
  }

  /**
   * Extract parameters from function signature
   */
  _extractParameters(line) {
    const match = line.match(/\(([^)]*)\)/);
    if (!match) return [];
    
    return match[1]
      .split(',')
      .map(p => p.trim().split('=')[0].trim())
      .filter(p => p.length > 0);
  }

  /**
   * Calculate cyclomatic complexity (McCabe)
   * Adds 1 for each decision point: if, else, for, while, case, catch, &&, ||, ?
   */
  _calculateCyclomaticComplexity(func, content) {
    const lines = content.split('\n').slice(func.startLine - 1, func.endLine);
    const code = lines.join('\n');
    
    let complexity = 1;
    
    // Decision points that increase complexity
    const patterns = [
      /\bif\s*\(/g,
      /\belse\s+if\s*\(/g,
      /\bfor\s*\(/g,
      /\bwhile\s*\(/g,
      /\bswitch\s*\(/g,
      /\bcase\s+/g,
      /\bcatch\s*\(/g,
      /&&/g,
      /\|\|/g,
      /\?/g  // ternary operator
    ];

    for (const pattern of patterns) {
      const matches = code.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return complexity;
  }

  /**
   * Calculate cognitive complexity (SonarSource)
   * Adds complexity for nested structures and logical operators
   */
  _calculateCognitiveComplexity(func, content) {
    const lines = content.split('\n').slice(func.startLine - 1, func.endLine);
    
    let complexity = 0;
    let nestingLevel = 0;

    for (const line of lines) {
      // Increase nesting for opening braces
      const openBraces = (line.match(/{/g) || []).length;
      const closeBraces = (line.match(/}/g) || []).length;

      // Structures that increase cognitive complexity
      if (/\b(if|else|for|while|switch|catch)\b/.test(line)) {
        complexity += 1 + nestingLevel;
      }

      // Logical operators
      if (/&&|\|\|/.test(line)) {
        complexity += 1;
      }

      // Ternary operator
      if (/\?[^:]*:/.test(line)) {
        complexity += 1 + nestingLevel;
      }

      // Recursion (function calling itself)
      if (line.includes(func.name) && line.includes('(')) {
        complexity += 1;
      }

      nestingLevel += openBraces - closeBraces;
      nestingLevel = Math.max(0, nestingLevel);
    }

    return complexity;
  }

  /**
   * Calculate maximum nesting depth
   */
  _calculateNestingDepth(func, content) {
    const lines = content.split('\n').slice(func.startLine - 1, func.endLine);
    
    let maxDepth = 0;
    let currentDepth = 0;

    for (const line of lines) {
      const openBraces = (line.match(/{/g) || []).length;
      const closeBraces = (line.match(/}/g) || []).length;

      currentDepth += openBraces - closeBraces;
      maxDepth = Math.max(maxDepth, currentDepth);
    }

    return maxDepth;
  }

  /**
   * Calculate Halstead metrics (simplified version)
   */
  _calculateHalsteadMetrics(content) {
    // Simplified calculation - production would use proper token analysis
    const operators = (content.match(/[+\-*/%=<>!&|^~?:;,.\[\]{}()]+/g) || []).length;
    const operands = (content.match(/\b[a-zA-Z_]\w*\b/g) || []).length;
    
    const n1 = operators;  // Unique operators (simplified)
    const n2 = operands;   // Unique operands (simplified)
    const N1 = operators;  // Total operators
    const N2 = operands;   // Total operands

    const vocabulary = n1 + n2;
    const length = N1 + N2;
    const volume = length * Math.log2(vocabulary || 1);
    const difficulty = (n1 / 2) * (N2 / (n2 || 1));

    return {
      volume: Math.round(volume),
      difficulty: Math.round(difficulty * 100) / 100
    };
  }

  /**
   * Calculate Maintainability Index (Microsoft)
   * MI = 171 - 5.2 * ln(V) - 0.23 * G - 16.2 * ln(LOC)
   * Where V = Halstead Volume, G = Cyclomatic Complexity, LOC = Lines of Code
   */
  _calculateMaintainabilityIndex(metrics) {
    const V = metrics.halsteadVolume || 100;
    const G = Math.max(1, metrics.cyclomaticComplexity);
    const LOC = Math.max(1, metrics.linesOfCode);

    let mi = 171 - 5.2 * Math.log(V) - 0.23 * G - 16.2 * Math.log(LOC);
    
    // Normalize to 0-100 scale
    mi = Math.max(0, Math.min(100, mi));
    
    return Math.round(mi * 100) / 100;
  }

  /**
   * Calculate technical debt score
   */
  _calculateTechnicalDebtScore(metrics) {
    let score = 0;

    // High cyclomatic complexity
    if (metrics.cyclomaticComplexity > this.config.maxCyclomaticComplexity) {
      score += 5 * (metrics.cyclomaticComplexity - this.config.maxCyclomaticComplexity);
    }

    // High cognitive complexity
    if (metrics.cognitiveComplexity > this.config.maxCognitiveComplexity) {
      score += 3 * (metrics.cognitiveComplexity - this.config.maxCognitiveComplexity);
    }

    // Deep nesting
    if (metrics.maxNestingDepth > this.config.maxNestingDepth) {
      score += 3 * (metrics.maxNestingDepth - this.config.maxNestingDepth);
    }

    // Long file
    if (metrics.linesOfCode > this.config.maxFileLines) {
      score += 2 * Math.floor((metrics.linesOfCode - this.config.maxFileLines) / 100);
    }

    // Low maintainability
    if (metrics.maintainabilityIndex < 65) {
      score += 4;
    }

    // Long functions
    for (const func of metrics.functions) {
      if (func.linesOfCode > this.config.maxFunctionLines) {
        score += 2;
      }
    }

    return score;
  }

  /**
   * Check for function-level issues
   */
  _checkFunctionIssues(func, metrics) {
    // Long function
    if (func.linesOfCode > this.config.maxFunctionLines) {
      metrics.issues.push({
        type: 'long_function',
        severity: 'medium',
        message: `Function "${func.name}" has ${func.linesOfCode} lines (max: ${this.config.maxFunctionLines})`,
        line: func.startLine,
        function: func.name
      });
    }

    // High complexity
    if (func.cyclomaticComplexity > this.config.maxCyclomaticComplexity) {
      metrics.issues.push({
        type: 'high_complexity',
        severity: 'high',
        message: `Function "${func.name}" has cyclomatic complexity ${func.cyclomaticComplexity} (max: ${this.config.maxCyclomaticComplexity})`,
        line: func.startLine,
        function: func.name
      });
    }

    // Too many parameters
    if (func.parameters.length > this.config.maxParameters) {
      metrics.issues.push({
        type: 'too_many_parameters',
        severity: 'low',
        message: `Function "${func.name}" has ${func.parameters.length} parameters (max: ${this.config.maxParameters})`,
        line: func.startLine,
        function: func.name
      });
    }
  }

  /**
   * Check for file-level issues
   */
  _checkFileIssues(metrics) {
    // Too many lines
    if (metrics.linesOfCode > this.config.maxFileLines) {
      metrics.issues.push({
        type: 'long_file',
        severity: 'medium',
        message: `File has ${metrics.linesOfCode} lines (max: ${this.config.maxFileLines})`
      });
    }

    // Too many functions
    if (metrics.functions.length > 20) {
      metrics.issues.push({
        type: 'too_many_functions',
        severity: 'low',
        message: `File has ${metrics.functions.length} functions (consider splitting)`
      });
    }
  }

  /**
   * Count lines of code (excluding blanks and comments)
   */
  _countLOC(lines) {
    let loc = 0;
    let inBlockComment = false;

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip blank lines
      if (trimmed.length === 0) continue;
      
      // Handle block comments
      if (trimmed.startsWith('/*')) {
        inBlockComment = true;
      }
      if (inBlockComment) {
        if (trimmed.endsWith('*/')) {
          inBlockComment = false;
        }
        continue;
      }
      
      // Skip single-line comments
      if (trimmed.startsWith('//')) continue;
      
      loc++;
    }

    return loc;
  }

  /**
   * Count blank lines
   */
  _countBlankLines(lines) {
    return lines.filter(line => line.trim().length === 0).length;
  }

  /**
   * Count comment lines
   */
  _countCommentLines(lines) {
    let count = 0;
    let inBlockComment = false;

    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('/*')) {
        inBlockComment = true;
        count++;
        continue;
      }
      
      if (inBlockComment) {
        count++;
        if (trimmed.endsWith('*/')) {
          inBlockComment = false;
        }
        continue;
      }
      
      if (trimmed.startsWith('//')) {
        count++;
      }
    }

    return count;
  }

  /**
   * Analyze a directory recursively
   */
  async analyzeDirectory(dirPath, options = {}) {
    const results = {
      files: [],
      summary: {
        totalFiles: 0,
        totalLines: 0,
        totalFunctions: 0,
        totalClasses: 0,
        avgCyclomaticComplexity: 0,
        avgCognitiveComplexity: 0,
        avgMaintainabilityIndex: 0,
        highComplexityFiles: [],
        highComplexityFunctions: [],
        technicalDebtScore: 0,
        analyzedAt: new Date().toISOString()
      }
    };

    const files = await this._getJsFiles(dirPath);
    
    for (const file of files) {
      // Skip ignored patterns
      if (this._shouldIgnore(file)) continue;
      
      try {
        const fileMetrics = await this.analyzeFile(file);
        results.files.push(fileMetrics);
        
        // Update summary
        results.summary.totalFiles++;
        results.summary.totalLines += fileMetrics.linesOfCode;
        results.summary.totalFunctions += fileMetrics.functions.length;
        results.summary.totalClasses += fileMetrics.classes.length;
        results.summary.technicalDebtScore += fileMetrics.technicalDebtScore;

        // Track high complexity
        if (fileMetrics.cyclomaticComplexity > this.config.maxCyclomaticComplexity) {
          results.summary.highComplexityFiles.push({
            path: file,
            complexity: fileMetrics.cyclomaticComplexity
          });
        }

        for (const func of fileMetrics.functions) {
          if (func.cyclomaticComplexity > this.config.maxCyclomaticComplexity) {
            results.summary.highComplexityFunctions.push({
              file: file,
              function: func.name,
              complexity: func.cyclomaticComplexity
            });
          }
        }
      } catch (error) {
        console.error(`Error analyzing ${file}:`, error.message);
      }
    }

    // Calculate averages
    if (results.summary.totalFiles > 0) {
      const totalCyclo = results.files.reduce((sum, f) => sum + f.cyclomaticComplexity, 0);
      const totalCog = results.files.reduce((sum, f) => sum + f.cognitiveComplexity, 0);
      const totalMI = results.files.reduce((sum, f) => sum + f.maintainabilityIndex, 0);

      results.summary.avgCyclomaticComplexity = Math.round(totalCyclo / results.summary.totalFiles * 100) / 100;
      results.summary.avgCognitiveComplexity = Math.round(totalCog / results.summary.totalFiles * 100) / 100;
      results.summary.avgMaintainabilityIndex = Math.round(totalMI / results.summary.totalFiles * 100) / 100;
    }

    this.results = results;
    return results;
  }

  /**
   * Get all JavaScript files in a directory
   */
  async _getJsFiles(dirPath) {
    const files = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        const subFiles = await this._getJsFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts'))) {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * Check if file should be ignored
   */
  _shouldIgnore(filePath) {
    return this.config.ignorePatterns.some(pattern => filePath.includes(pattern));
  }

  /**
   * Generate a report
   */
  generateReport(format = 'json') {
    if (format === 'json') {
      return JSON.stringify(this.results, null, 2);
    }

    // Text report
    const lines = [];
    lines.push('=== Code Complexity Analysis Report ===');
    lines.push(`Generated: ${this.results.summary.analyzedAt}`);
    lines.push('');
    lines.push('Summary:');
    lines.push(`  Total Files: ${this.results.summary.totalFiles}`);
    lines.push(`  Total Lines: ${this.results.summary.totalLines}`);
    lines.push(`  Total Functions: ${this.results.summary.totalFunctions}`);
    lines.push(`  Avg Cyclomatic Complexity: ${this.results.summary.avgCyclomaticComplexity}`);
    lines.push(`  Avg Cognitive Complexity: ${this.results.summary.avgCognitiveComplexity}`);
    lines.push(`  Avg Maintainability Index: ${this.results.summary.avgMaintainabilityIndex}`);
    lines.push(`  Technical Debt Score: ${this.results.summary.technicalDebtScore}`);
    lines.push('');
    
    if (this.results.summary.highComplexityFiles.length > 0) {
      lines.push('High Complexity Files:');
      for (const file of this.results.summary.highComplexityFiles) {
        lines.push(`  ${file.path}: complexity=${file.complexity}`);
      }
    }

    return lines.join('\n');
  }
}

module.exports = CodeComplexityAnalyzer;