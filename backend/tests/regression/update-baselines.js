#!/usr/bin/env node
/**
 * 更新性能基准线脚本
 * REQ-00490: API性能回归测试自动化与基准线管理系统
 * 
 * 用于在 main 分支上更新基准线数据
 */

'use strict';

const { Pool } = require('pg');
const Redis = require('ioredis');
const PerformanceBaselineManager = require('./shared/performanceBaselineManager');

async function main() {
  console.log('更新性能基准线...');
  
  const db = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://localhost/minego'
  });

  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  try {
    const manager = new PerformanceBaselineManager(db, redis);

    // 获取当前所有基准线
    const baselines = await manager.getBaselineSummary();
    console.log(`当前基准线数量: ${baselines.length}`);

    // 清理过期数据
    const cleanupResult = await manager.cleanupOldData(90);
    console.log(`清理过期数据: ${cleanupResult.deleted} 条`);

    // 获取健康状态
    const health = await manager.getHealthStatus();
    console.log(`健康得分: ${health.score}`);
    console.log(`基准线新鲜度: ${health.baselines.fresh}/${health.baselines.total}`);

    // 导出当前基准线（备份）
    const exportData = await manager.exportBaselines('json');
    console.log('基准线数据已导出');

    console.log('✅ 基准线更新完成');

  } catch (error) {
    console.error('❌ 更新失败:', error.message);
    process.exit(1);
  } finally {
    await db.end();
    redis.disconnect();
  }
}

main();