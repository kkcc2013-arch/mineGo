#!/usr/bin/env node
/**
 * REQ-00016: 数据保留策略清理脚本
 * 自动清理过期数据
 * 
 * 用法：
 *   node scripts/data-retention-cleanup.js
 *   node scripts/data-retention-cleanup.js --dry-run
 */

const { Pool } = require('pg');
const logger = require('../backend/shared/logger');

// 数据库连接
const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'minego',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

// 数据保留策略
const DataRetentionPolicy = {
  users: { retention: null, autoDelete: false, description: '用户数据永久保留' },
  catch_history: { retention: 730, autoDelete: true, description: '捕捉历史保留 2 年' },
  gym_battles: { retention: 365, autoDelete: true, description: '道馆战斗记录保留 1 年' },
  messages: { retention: 90, autoDelete: true, description: '消息记录保留 90 天' },
  payments: { retention: 2555, autoDelete: false, description: '支付记录保留 7 年（法律要求）' },
  audit_logs: { retention: 2555, autoDelete: false, description: '审计日志保留 7 年' },
  encrypted_user_locations: { retention: 30, autoDelete: true, description: '位置历史保留 30 天' }
};

async function cleanupExpiredData(dryRun = false) {
  logger.info({ dryRun }, 'Starting data retention cleanup');
  
  const results = [];
  
  for (const [table, policy] of Object.entries(DataRetentionPolicy)) {
    if (!policy.autoDelete || !policy.retention) {
      logger.info({ table }, `Skipping ${table} (no auto-delete)`);
      continue;
    }
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - policy.retention);
    
    try {
      // 查询要删除的记录数
      const countResult = await db.query(`
        SELECT COUNT(*) as count
        FROM ${table}
        WHERE created_at < $1
      `, [cutoffDate]);
      
      const count = parseInt(countResult.rows[0].count);
      
      if (count === 0) {
        logger.info({ table }, `No expired records in ${table}`);
        continue;
      }
      
      logger.info({ 
        table, 
        count, 
        cutoffDate: cutoffDate.toISOString() 
      }, `Found ${count} expired records in ${table}`);
      
      if (!dryRun) {
        // 执行删除
        const deleteResult = await db.query(`
          DELETE FROM ${table}
          WHERE created_at < $1
          RETURNING id
        `, [cutoffDate]);
        
        const deleted = deleteResult.rowCount;
        
        logger.info({ 
          table, 
          deleted,
          cutoffDate: cutoffDate.toISOString() 
        }, `Deleted ${deleted} records from ${table}`);
        
        results.push({ table, deleted, cutoffDate });
      } else {
        logger.info({ table, count }, `DRY RUN: Would delete ${count} records`);
        results.push({ table, wouldDelete: count, cutoffDate });
      }
    } catch (err) {
      logger.error({ err, table }, `Failed to cleanup ${table}`);
      results.push({ table, error: err.message });
    }
  }
  
  await db.end();
  
  logger.info({ results }, 'Data retention cleanup completed');
  
  console.log('\n=== Data Retention Cleanup Summary ===\n');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);
  
  for (const result of results) {
    if (result.error) {
      console.log(`❌ ${result.table}: ERROR - ${result.error}`);
    } else if (result.deleted !== undefined) {
      console.log(`✅ ${result.table}: Deleted ${result.deleted} records (before ${result.cutoffDate.toISOString().split('T')[0]})`);
    } else if (result.wouldDelete !== undefined) {
      console.log(`🔍 ${result.table}: Would delete ${result.wouldDelete} records (before ${result.cutoffDate.toISOString().split('T')[0]})`);
    }
  }
  
  console.log('\n');
}

// 运行
const dryRun = process.argv.includes('--dry-run');
cleanupExpiredData(dryRun).catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
