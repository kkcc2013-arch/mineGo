#!/usr/bin/env node
/**
 * 生成性能报告脚本
 * REQ-00490: API性能回归测试自动化与基准线管理系统
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');
const Redis = require('ioredis');
const PerformanceBaselineManager = require('./shared/performanceBaselineManager');

async function main() {
  const db = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://localhost/minego_test'
  });

  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  try {
    const manager = new PerformanceBaselineManager(db, redis);

    // 获取基准线摘要
    const baselines = await manager.getBaselineSummary();

    // 获取健康状态
    const health = await manager.getHealthStatus();

    // 获取最近的回归历史
    const regressions = await manager.getRegressionHistory(null, 30);

    // 生成报告
    const report = generateReport(baselines, health, regressions);

    // 保存报告
    await fs.writeFile('performance-report.md', report);
    console.log('✅ 性能报告已生成: performance-report.md');

  } catch (error) {
    console.error('❌ 报告生成失败:', error.message);
    process.exit(1);
  } finally {
    await db.end();
    redis.disconnect();
  }
}

function generateReport(baselines, health, regressions) {
  const lines = [
    '# API 性能基准线报告',
    '',
    `**生成时间**: ${new Date().toISOString()}`,
    '',
    '## 基准线健康状态',
    '',
    `| 指标 | 数值 |`,
    `|------|------|`,
    `| 健康得分 | ${health.score} |`,
    `| 总基准线 | ${health.baselines.total} |`,
    `| 新鲜基准线 | ${health.baselines.fresh} |`,
    `| 过期基准线 | ${health.baselines.stale} |`,
    '',
    '## 基准线详情',
    '',
    '| 端点 | 平均响应时间 | P95 响应时间 | 错误率 | 吞吐量 | 更新时间 |',
    '|------|------------|-------------|--------|--------|----------|'
  ];

  for (const baseline of baselines) {
    lines.push(
      `| ${baseline.endpoint} | ${baseline.avgResponseTime}ms | ` +
      `${baseline.p95ResponseTime}ms | ${baseline.errorRate} | ` +
      `${baseline.throughput} req/s | ${baseline.freshness} |`
    );
  }

  if (regressions.length > 0) {
    lines.push('', '## 最近性能退化', '', 
      '| 端点 | 时间 | P95响应时间 | 严重度 |',
      '|------|------|------------|--------|'
    );

    for (const reg of regressions.slice(0, 10)) {
      lines.push(
        `| ${reg.endpoint} | ${new Date(reg.timestamp).toLocaleDateString()} | ` +
        `${reg.p95ResponseTime?.toFixed(2) || '-'}ms | ${reg.overallScore || '-'} |`
      );
    }
  }

  return lines.join('\n');
}

main();