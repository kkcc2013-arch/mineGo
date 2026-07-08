#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

// 确保模块路径正确
const sharedPath = path.join(__dirname, '..');
process.chdir(sharedPath);

const TestCoverageCollector = require('./TestCoverageCollector');
const IncrementalCoverageAnalyzer = require('./IncrementalCoverageAnalyzer');
const CoverageThresholdChecker = require('./CoverageThresholdChecker');
const CoverageBadgeGenerator = require('./CoverageBadgeGenerator');
const { createLogger } = require('../logger');

const logger = createLogger('coverage-cli');

/**
 * CLI 命令处理器
 */
class CoverageCLI {
  constructor() {
    this.collector = new TestCoverageCollector();
    this.analyzer = new IncrementalCoverageAnalyzer();
    this.checker = new CoverageThresholdChecker();
    this.badgeGenerator = new CoverageBadgeGenerator();
  }

  /**
   * 解析命令行参数
   */
  parseArgs(args) {
    const command = args[0] || 'help';
    const options = {};

    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      
      if (arg.startsWith('--')) {
        const key = arg.substring(2);
        const value = args[i + 1];
        
        if (value && !value.startsWith('--')) {
          options[key] = value;
          i++;
        } else {
          options[key] = true;
        }
      }
    }

    return { command, options };
  }

  /**
   * 执行命令
   */
  async run(args) {
    const { command, options } = this.parseArgs(args);

    try {
      switch (command) {
        case 'collect':
          return await this.handleCollect(options);
        case 'analyze':
          return await this.handleAnalyze(options);
        case 'incremental':
          return await this.handleIncremental(options);
        case 'check-threshold':
          return await this.handleCheckThreshold(options);
        case 'badge':
          return await this.handleBadge(options);
        case 'gaps':
          return await this.handleGaps(options);
        case 'help':
          return this.handleHelp();
        default:
          console.error(`Unknown command: ${command}`);
          return this.handleHelp();
      }
    } catch (err) {
      logger.error({ command, err: err.message }, 'CLI command failed');
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  /**
   * 收集覆盖率
   */
  async handleCollect(options) {
    const buildId = options['build-id'] || `local-${Date.now()}`;
    const branch = options.branch || 'local';
    const commit = options.commit || 'unknown';
    const output = options.output || 'json';

    const result = await this.collector.collectAll(buildId, branch, commit);

    if (output === 'json') {
      const outputPath = path.join(process.cwd(), 'coverage', 'coverage-report.json');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
      console.log(`Coverage report saved to: ${outputPath}`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }

    return result;
  }

  /**
   * 分析覆盖率
   */
  async handleAnalyze(options) {
    const coveragePath = options.path || path.join(process.cwd(), 'coverage', 'coverage-report.json');

    if (!fs.existsSync(coveragePath)) {
      console.error(`Coverage report not found: ${coveragePath}`);
      process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));

    console.log('\n📊 Coverage Analysis\n');
    console.log(`Build: ${data.buildId}`);
    console.log(`Branch: ${data.branch}`);
    console.log(`Commit: ${data.commitSha}`);
    console.log(`Time: ${data.timestamp}`);
    console.log('');

    console.log('Total Coverage:');
    console.log(`  Lines:      ${data.total.lines.toFixed(1)}%`);
    console.log(`  Functions:  ${data.total.functions.toFixed(1)}%`);
    console.log(`  Branches:   ${data.total.branches.toFixed(1)}%`);
    console.log('');

    console.log('Service Coverage:');
    for (const [service, coverage] of Object.entries(data.services)) {
      if (coverage.error) {
        console.log(`  ${service}: ⚠️ ${coverage.error}`);
      } else {
        const status = coverage.lines >= 60 ? '✅' : '⚠️';
        console.log(`  ${service}: ${status} Lines ${coverage.lines.toFixed(1)}%`);
      }
    }

    return data;
  }

  /**
   * 增量覆盖率分析
   */
  async handleIncremental(options) {
    const base = options.base || 'main';
    const head = options.head || 'HEAD';
    const minLines = parseInt(options['min-lines'] || '80', 10);
    const minFunctions = parseInt(options['min-functions'] || '80', 10);

    this.analyzer.threshold.lines = minLines;
    this.analyzer.threshold.functions = minFunctions;

    const result = await this.analyzer.analyze(base, head);

    console.log(this.analyzer.generateSummary(result));

    // 保存结果
    const outputPath = path.join(process.cwd(), 'coverage', 'incremental-report.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

    if (!result.passes) {
      process.exit(1);
    }

    return result;
  }

  /**
   * 检查覆盖率阈值
   */
  async handleCheckThreshold(options) {
    const coveragePath = options.path || path.join(process.cwd(), 'coverage', 'coverage-report.json');
    const minLines = parseInt(options['min-lines'] || '60', 10);
    const minFunctions = parseInt(options['min-functions'] || '50', 10);
    const minBranches = parseInt(options['min-branches'] || '40', 10);

    this.checker.defaultThreshold = {
      lines: minLines,
      statements: minLines,
      functions: minFunctions,
      branches: minBranches
    };

    if (!fs.existsSync(coveragePath)) {
      console.error(`Coverage report not found: ${coveragePath}`);
      process.exit(1);
    }

    const coverageData = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    const result = await this.checker.check(coverageData);

    console.log(this.checker.generateCliOutput(result));

    // 保存检查结果
    const outputPath = path.join(process.cwd(), 'coverage', 'threshold-check.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

    // 输出 passed 状态供 CI 使用
    console.log(`::set-output name=passed::${result.passes}`);

    if (!result.passes) {
      process.exit(1);
    }

    return result;
  }

  /**
   * 生成 Badge
   */
  async handleBadge(options) {
    const coveragePath = options.path || path.join(process.cwd(), 'coverage', 'coverage-report.json');
    const output = options.output || path.join(process.cwd(), 'coverage-badge.svg');
    const format = options.format || 'svg';

    let coverage = 0;

    if (fs.existsSync(coveragePath)) {
      const data = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
      coverage = data.total?.lines || 0;
    } else {
      // 从 coverage-summary.json 获取
      const summaryPath = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
      if (fs.existsSync(summaryPath)) {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        coverage = summary.total?.lines?.pct || 0;
      }
    }

    if (format === 'svg') {
      const svg = this.badgeGenerator.generateSVG(coverage);
      fs.writeFileSync(output, svg);
      console.log(`Badge saved to: ${output}`);
    } else if (format === 'url') {
      const url = this.badgeGenerator.generateUrl(coverage);
      console.log(`Badge URL: ${url}`);
    } else if (format === 'json') {
      const jsonBadge = this.badgeGenerator.generateJsonBadge(coverage);
      fs.writeFileSync(output, JSON.stringify(jsonBadge, null, 2));
      console.log(`Badge JSON saved to: ${output}`);
    } else if (format === 'markdown') {
      const markdown = this.badgeGenerator.generateMarkdown(coverage);
      console.log(markdown);
    }

    return { coverage, output };
  }

  /**
   * 分析覆盖率缺口
   */
  async handleGaps(options) {
    const service = options.service;
    const output = options.output || 'json';

    if (!service) {
      console.error('Service name required. Use: --service <service-name>');
      process.exit(1);
    }

    const result = await this.collector.analyzeGaps(service);

    if (output === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n📊 Coverage Gaps Analysis for ${service}\n`);
      console.log(`Total Files: ${result.totalFiles}`);
      console.log(`Files with Gaps: ${result.filesWithGaps}`);
      console.log('');

      if (result.gaps && result.gaps.length > 0) {
        console.log('Top Gaps (by severity):');
        for (const gap of result.gaps.slice(0, 10)) {
          console.log(`  ${gap.file}`);
          console.log(`    Severity: ${gap.severity.toFixed(1)}%`);
          if (gap.uncoveredFunctions.length > 0) {
            console.log(`    Uncovered Functions: ${gap.uncoveredFunctions.map(f => f.name).join(', ')}`);
          }
        }
      }
    }

    return result;
  }

  /**
   * 显示帮助
   */
  handleHelp() {
    console.log(`
Test Coverage CLI

Usage: node cli.js <command> [options]

Commands:
  collect              Collect coverage from all services
  analyze              Analyze existing coverage report
  incremental          Analyze incremental coverage for PR
  check-threshold      Check if coverage meets threshold
  badge                Generate coverage badge
  gaps                 Analyze coverage gaps for a service
  help                 Show this help message

Options:
  --build-id <id>      Build ID for collection
  --branch <name>      Branch name
  --commit <sha>       Commit SHA
  --base <branch>      Base branch for incremental analysis
  --head <sha>         HEAD commit for incremental analysis
  --min-lines <num>    Minimum lines coverage threshold
  --min-functions <num> Minimum functions coverage threshold
  --min-branches <num> Minimum branches coverage threshold
  --service <name>     Service name for gaps analysis
  --path <path>        Coverage report path
  --output <path>      Output file path
  --format <format>    Badge format (svg|url|json|markdown)

Examples:
  node cli.js collect --build-id 1234 --branch main
  node cli.js check-threshold --min-lines 60
  node cli.js incremental --base main --head abc123
  node cli.js badge --output coverage-badge.svg
  node cli.js gaps --service user-service
`);
  }
}

// 主入口
if (require.main === module) {
  const cli = new CoverageCLI();
  const args = process.argv.slice(2);
  cli.run(args).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = CoverageCLI;