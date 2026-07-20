// backend/shared/testing/MutationTestRunner.js
// 变异测试运行器

'use strict';

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { createLogger } = require('../logger');

const logger = createLogger('mutation-test-runner');

/**
 * 变异测试运行器
 * 集成 Stryker.js 进行变异测试
 */
class MutationTestRunner {
  constructor(options = {}) {
    this.options = {
      configPath: options.configPath || './stryker.conf.js',
      mutate: options.mutate || ['backend/shared/**/*.js'],
      reporters: options.reporters || ['json', 'html', 'clear-text'],
      concurrency: options.concurrency || 4,
      timeout: options.timeout || 60000,
      thresholds: options.thresholds || {
        high: 80,
        low: 60,
        break: 70
      },
      ...options
    };
    
    this.results = null;
  }

  /**
   * 运行变异测试
   * @param {string[]} files - 要变异的文件列表
   * @returns {Object} - 测试结果
   */
  async run(files = this.options.mutate) {
    logger.info('Starting mutation testing', { files });
    
    const startTime = Date.now();
    
    try {
      // 检查 Stryker 是否安装
      await this.ensureStrykerInstalled();
      
      // 运行 Stryker
      const output = await this.runStryker(files);
      
      // 解析结果
      this.results = this.parseResults(output);
      
      const duration = Date.now() - startTime;
      
      logger.info('Mutation testing completed', {
        mutationScore: this.results.mutationScore,
        duration: `${(duration / 1000).toFixed(1)}s`
      });
      
      return this.results;
      
    } catch (error) {
      logger.error('Mutation testing failed', { error: error.message });
      throw error;
    }
  }

  /**
   * 确保 Stryker 已安装
   */
  async ensureStrykerInstalled() {
    try {
      execSync('npx stryker --version', { stdio: 'ignore' });
    } catch (error) {
      logger.info('Installing Stryker...');
      execSync('npm install --save-dev @stryker-mutator/core @stryker-mutator/jest-runner', {
        stdio: 'inherit'
      });
    }
  }

  /**
   * 运行 Stryker
   */
  async runStryker(files) {
    return new Promise((resolve, reject) => {
      const args = [
        'run',
        '--mutate', files.join(','),
        '--reporters', this.options.reporters.join(','),
        '--concurrency', this.options.concurrency.toString(),
        '--timeout', this.options.timeout.toString()
      ];
      
      if (this.options.configPath) {
        args.push('--configFile', this.options.configPath);
      }
      
      const stryker = spawn('npx', ['stryker', ...args], {
        cwd: process.cwd(),
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      stryker.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      stryker.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      stryker.on('close', (code) => {
        if (code === 0 || stdout.includes('mutation score')) {
          resolve(stdout);
        } else {
          reject(new Error(`Stryker exited with code ${code}: ${stderr}`));
        }
      });
      
      stryker.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * 解析测试结果
   */
  parseResults(output) {
    // 从输出中提取变异分数
    const scoreMatch = output.match(/Mutation score:\s*([0-9.]+)%/);
    const mutationScore = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    
    // 从输出中提取统计
    const killedMatch = output.match(/Killed:\s*(\d+)/);
    const survivedMatch = output.match(/Survived:\s*(\d+)/);
    const timeoutMatch = output.match(/Timeout:\s*(\d+)/);
    const noCoverageMatch = output.match(/No coverage:\s*(\d+)/);
    const syntaxErrorMatch = output.match(/Syntax errors:\s*(\d+)/);
    
    const killed = killedMatch ? parseInt(killedMatch[1]) : 0;
    const survived = survivedMatch ? parseInt(survivedMatch[1]) : 0;
    const timeout = timeoutMatch ? parseInt(timeoutMatch[1]) : 0;
    const noCoverage = noCoverageMatch ? parseInt(noCoverageMatch[1]) : 0;
    const syntaxErrors = syntaxErrorMatch ? parseInt(syntaxErrorMatch[1]) : 0;
    
    const totalMutants = killed + survived + timeout + noCoverage + syntaxErrors;
    
    // 提取存活的变异体
    const survivedMutants = this.extractSurvivedMutants(output);
    
    return {
      mutationScore,
      killed,
      survived,
      timeout,
      noCoverage,
      syntaxErrors,
      totalMutants,
      killedRate: totalMutants > 0 ? (killed / totalMutants * 100).toFixed(1) : 0,
      survivedMutants,
      passed: mutationScore >= this.options.thresholds.break
    };
  }

  /**
   * 提取存活的变异体
   */
  extractSurvivedMutants(output) {
    const survived = [];
    
    // 匹配存活的变异体信息
    const mutantRegex = /#\d+\.\s*\[Survived\]\s*(.+?)\s*in\s*file\s*`(.+?)`\s*at\s*line\s*(\d+)/g;
    const matches = output.matchAll(mutantRegex);
    
    for (const match of matches) {
      survived.push({
        mutation: match[1].trim(),
        file: match[2],
        line: parseInt(match[3])
      });
    }
    
    return survived;
  }

  /**
   * 生成配置文件
   */
  async generateConfig() {
    const config = {
      "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
      "packageManager": "npm",
      "testRunner": "jest",
      "mutator": {
        "plugins": [
          "arithmetic",
          "boolean",
          "conditional",
          "equality",
          "logical",
          "string",
          "array",
          "object"
        ]
      },
      "reporters": this.options.reporters,
      "coverageAnalysis": "off",
      "mutate": this.options.mutate,
      "thresholds": {
        "high": this.options.thresholds.high,
        "low": this.options.thresholds.low,
        "break": this.options.thresholds.break
      },
      "concurrency": this.options.concurrency,
      "timeoutMS": this.options.timeout
    };
    
    await fs.writeFile(
      this.options.configPath,
      `module.exports = function(config) {\n  config.set(${JSON.stringify(config, null, 2)});\n};`
    );
    
    logger.info('Stryker config generated', { path: this.options.configPath });
  }

  /**
   * 为特定服务运行变异测试
   */
  async runForService(serviceName) {
    const servicePath = `backend/${serviceName}`;
    const files = [
      `${servicePath}/src/**/*.js`,
      `!${servicePath}/src/**/*.test.js`
    ];
    
    return this.run(files);
  }

  /**
   * 批量运行多个服务
   */
  async runForServices(serviceNames) {
    const results = {};
    
    for (const service of serviceNames) {
      try {
        results[service] = await this.runForService(service);
      } catch (error) {
        results[service] = {
          error: error.message,
          passed: false
        };
      }
    }
    
    return {
      services: results,
      summary: this.calculateSummary(results)
    };
  }

  /**
   * 计算摘要
   */
  calculateSummary(results) {
    const services = Object.keys(results);
    const passed = services.filter(s => results[s].passed).length;
    
    const avgScore = services.reduce((sum, s) => 
      sum + (results[s].mutationScore || 0), 0
    ) / services.length;
    
    return {
      totalServices: services.length,
      passedServices: passed,
      failedServices: services.length - passed,
      averageMutationScore: Math.round(avgScore * 10) / 10,
      status: passed === services.length ? 'pass' : 'fail'
    };
  }

  /**
   * 生成报告
   */
  async generateReport(outputPath) {
    if (!this.results) {
      throw new Error('No results available. Run mutation tests first.');
    }
    
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        mutationScore: this.results.mutationScore,
        killed: this.results.killed,
        survived: this.results.survived,
        timeout: this.results.timeout,
        totalMutants: this.results.totalMutants
      },
      survivedMutants: this.results.survivedMutants,
      recommendations: this.generateRecommendations()
    };
    
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
    
    logger.info('Mutation report generated', { path: outputPath });
    
    return report;
  }

  /**
   * 生成改进建议
   */
  generateRecommendations() {
    const recommendations = [];
    
    if (!this.results) {
      return recommendations;
    }
    
    if (this.results.mutationScore < 80) {
      recommendations.push({
        type: 'mutation_coverage',
        priority: 'high',
        message: `变异测试覆盖率 (${this.results.mutationScore.toFixed(1)}%) 低于目标 (80%)`,
        details: `${this.results.survived} 个变异体存活，需要增强测试断言`
      });
    }
    
    // 按文件分组存活变异
    const byFile = {};
    for (const mutant of this.results.survivedMutants) {
      byFile[mutant.file] = (byFile[mutant.file] || 0) + 1;
    }
    
    // 找出问题最多的文件
    const sortedFiles = Object.entries(byFile)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    if (sortedFiles.length > 0) {
      recommendations.push({
        type: 'priority_files',
        priority: 'medium',
        message: '优先修复以下文件的测试',
        files: sortedFiles.map(([file, count]) => ({
          file,
          survivedMutants: count
        }))
      });
    }
    
    return recommendations;
  }
}

module.exports = MutationTestRunner;