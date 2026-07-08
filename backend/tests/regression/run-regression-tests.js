#!/usr/bin/env node
/**
 * 性能回归测试 CLI 工具
 * REQ-00490: API性能回归测试自动化与基准线管理系统
 * 
 * 使用方法:
 *   node tests/regression/run-regression-tests.js [options]
 * 
 * 选项:
 *   --endpoints=<list>   指定要测试的端点（逗号分隔，或 'all'）
 *   --iterations=<n>     每个端点的迭代次数
 *   --threshold=<p>      回归阈值百分比
 *   --output=<dir>       输出目录
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { Pool } = require('pg');
const Redis = require('ioredis');
const PerformanceRegressionTester = require('./shared/performanceRegressionTester');

// 默认测试端点配置
const DEFAULT_ENDPOINTS = [
  { method: 'GET', path: '/api/pokemon/list', priority: 'P0' },
  { method: 'GET', path: '/api/location/nearby', priority: 'P0' },
  { method: 'POST', path: '/api/catch/attempt', priority: 'P0' },
  { method: 'GET', path: '/api/user/profile', priority: 'P1' },
  { method: 'GET', path: '/api/gym/list', priority: 'P1' },
  { method: 'POST', path: '/api/gym/battle', priority: 'P1' },
  { method: 'GET', path: '/api/social/leaderboard', priority: 'P2' },
  { method: 'GET', path: '/api/reward/daily', priority: 'P2' }
];

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('endpoints', {
      alias: 'e',
      describe: 'API endpoints to test (comma-separated, or "all")',
      default: 'all',
      type: 'string'
    })
    .option('iterations', {
      alias: 'i',
      describe: 'Number of test iterations per endpoint',
      default: 50,
      type: 'number'
    })
    .option('threshold', {
      alias: 't',
      describe: 'Regression threshold percentage',
      default: 20,
      type: 'number'
    })
    .option('output', {
      alias: 'o',
      describe: 'Output directory for results',
      default: 'test-results/performance',
      type: 'string'
    })
    .option('concurrency', {
      alias: 'c',
      describe: 'Concurrent requests per batch',
      default: 10,
      type: 'number'
    })
    .option('verbose', {
      alias: 'v',
      describe: 'Verbose output',
      default: false,
      type: 'boolean'
    })
    .help()
    .argv;

  console.log('='.repeat(60));
  console.log('API 性能回归测试');
  console.log('='.repeat(60));
  console.log(`迭代次数: ${argv.iterations}`);
  console.log(`回归阈值: ${argv.threshold}%`);
  console.log(`并发数: ${argv.concurrency}`);
  console.log('='.repeat(60));

  // 初始化数据库连接
  const db = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://localhost/minego_test',
    max: 10
  });

  // 初始化 Redis 连接
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  try {
    // 创建测试器实例
    const tester = new PerformanceRegressionTester(db, redis, {
      iterations: argv.iterations,
      concurrency: argv.concurrency,
      responseTimeThreshold: argv.threshold / 100,
      warmupIterations: 5
    });

    // 确定要测试的端点
    let endpoints = DEFAULT_ENDPOINTS;
    if (argv.endpoints !== 'all') {
      const specifiedEndpoints = argv.endpoints.split(',');
      endpoints = DEFAULT_ENDPOINTS.filter(ep => 
        specifiedEndpoints.includes(ep.path) || 
        specifiedEndpoints.includes(`${ep.method} ${ep.path}`)
      );
    }

    console.log(`\n测试端点数量: ${endpoints.length}`);

    // 执行批量测试
    const testPromises = [];
    const results = [];
    
    for (const endpoint of endpoints) {
      const endpointKey = `${endpoint.method} ${endpoint.path}`;
      console.log(`\n→ 测试: ${endpointKey}`);
      
      const resultPromise = tester.runTest(endpointKey, {
        iterations: argv.iterations,
        concurrency: argv.concurrency
      }).then(result => {
        const status = result.passed ? '✅ 通过' : '❌ 失败';
        console.log(`  ${status}`);
        
        if (result.analysis?.regressions?.length > 0) {
          console.log(`  发现 ${result.analysis.regressions.length} 个退化:`);
          for (const reg of result.analysis.regressions) {
            console.log(`    - ${reg.metric}: +${reg.change.toFixed(1)}% [${reg.severity}]`);
          }
        }
        
        results.push(result);
        return result;
      }).catch(error => {
        console.error(`  ⚠️ 错误: ${error.message}`);
        results.push({
          endpoint: endpointKey,
          passed: false,
          error: error.message
        });
        return null;
      });
      
      testPromises.push(resultPromise);
    }

    await Promise.all(testPromises);

    // 生成汇总报告
    const passedCount = results.filter(r => r.passed).length;
    const failedCount = results.length - passedCount;
    const regressionCount = results.filter(r => r.analysis?.isRegression).length;

    console.log('\n' + '='.repeat(60));
    console.log('测试汇总');
    console.log('='.repeat(60));
    console.log(`总计: ${results.length} 个端点`);
    console.log(`通过: ${passedCount}`);
    console.log(`失败: ${failedCount}`);
    console.log(`性能退化: ${regressionCount}`);
    console.log('='.repeat(60));

    // 确保输出目录存在
    const outputDir = path.resolve(argv.output);
    await fs.mkdir(outputDir, { recursive: true });

    // 保存详细结果
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultFile = path.join(outputDir, `regression-test-${timestamp}.json`);
    await fs.writeFile(resultFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      config: {
        iterations: argv.iterations,
        threshold: argv.threshold,
        concurrency: argv.concurrency
      },
      summary: {
        total: results.length,
        passed: passedCount,
        failed: failedCount,
        regressions: regressionCount
      },
      results
    }, null, 2));

    console.log(`\n详细结果已保存: ${resultFile}`);

    // 生成 Markdown 报告
    const reportPath = path.join(outputDir, 'regression-report.md');
    const reportContent = generateMarkdownReport(results, argv);
    await fs.writeFile(reportPath, reportContent);
    console.log(`Markdown 报告已保存: ${reportPath}`);

    // 退出状态码
    const exitCode = failedCount > 0 ? 1 : 0;
    
    if (exitCode === 1) {
      console.log('\n❌ 性能回归测试未通过');
    } else {
      console.log('\n✅ 性能回归测试全部通过');
    }

    process.exit(exitCode);

  } catch (error) {
    console.error('\n❌ 测试执行失败:', error.message);
    if (argv.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await db.end();
    redis.disconnect();
  }
}

/**
 * 生成 Markdown 报告
 */
function generateMarkdownReport(results, config) {
  const lines = [
    '# API 性能回归测试报告',
    '',
    `**测试时间**: ${new Date().toISOString()}`,
    `**迭代次数**: ${config.iterations}`,
    `**回归阈值**: ${config.threshold}%`,
    '',
    '## 测试摘要',
    '',
    `| 指标 | 数值 |`,
    `|------|------|`,
    `| 总计 | ${results.length} |`,
    `| 通过 | ${results.filter(r => r.passed).length} |`,
    `| 失败 | ${results.filter(r => !r.passed).length} |`,
    `| 性能退化 | ${results.filter(r => r.analysis?.isRegression).length} |`,
    '',
    '## 各端点详情',
    '',
    '| 端点 | 平均响应时间 | P95 响应时间 | 错误率 | 结果 |',
    '|------|-------------|-------------|--------|------|'
  ];

  for (const result of results) {
    const perf = result.performance || {};
    const status = result.passed ? '✅ 通过' : '❌ 失败';
    lines.push(
      `| ${result.endpoint} | ${perf.avgResponseTime?.toFixed(2) || '-'}ms | ` +
      `${perf.p95ResponseTime?.toFixed(2) || '-'}ms | ` +
      `${((perf.errorRate || 0) * 100).toFixed(2)}% | ${status} |`
    );
  }

  // 退化详情
  const regressions = results.filter(r => r.analysis?.regressions?.length > 0);
  if (regressions.length > 0) {
    lines.push('', '## 性能退化详情', '');
    
    for (const result of regressions) {
      lines.push(`### ${result.endpoint}`, '');
      for (const reg of result.analysis.regressions) {
        lines.push(
          `- **${reg.metric}**: ${reg.baseline?.toFixed(2) || '-'} → ${reg.current?.toFixed(2) || '-'} ` +
          `(+${reg.change?.toFixed(1)}%) [${reg.severity}]`
        );
      }
      lines.push('', `**建议**: ${result.analysis.recommendation}`, '');
    }
  }

  // 改进详情
  const improvements = results.filter(r => r.analysis?.improvements?.length > 0);
  if (improvements.length > 0) {
    lines.push('', '## 性能改进详情', '');
    
    for (const result of improvements) {
      lines.push(`### ${result.endpoint}`, '');
      for (const imp of result.analysis.improvements) {
        lines.push(
          `- **${imp.metric}**: ${imp.baseline?.toFixed(2) || '-'} → ${imp.current?.toFixed(2) || '-'} ` +
          `(-${imp.change?.toFixed(1)}%)`
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// 运行主程序
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});