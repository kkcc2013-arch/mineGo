/**
 * 密钥迁移脚本
 * 
 * 将现有环境变量中的密钥迁移到 KMS 系统。
 * 
 * 使用方式：
 *   node scripts/migrate-to-kms.js [--dry-run]
 */

'use strict';

const path = require('path');

// 添加项目根目录到 module.paths
const projectRoot = path.resolve(__dirname, '../../');
module.paths.unshift(path.join(projectRoot, 'shared'));

const kms = require('../shared/kms');
const logger = require('../shared/logger');

/**
 * 迁移配置
 */
const migrations = [
  {
    keyName: 'jwt-access-secret',
    keyType: 'jwt_secret',
    sensitivity: 'high',
    envVar: 'JWT_ACCESS_SECRET',
    rotationDays: 90,
    description: 'JWT 访问令牌签名密钥'
  },
  {
    keyName: 'jwt-refresh-secret',
    keyType: 'jwt_secret',
    sensitivity: 'high',
    envVar: 'JWT_REFRESH_SECRET',
    rotationDays: 90,
    description: 'JWT 刷新令牌签名密钥'
  },
  {
    keyName: 'openweathermap-api-key',
    keyType: 'api_key',
    sensitivity: 'medium',
    envVar: 'OPENWEATHERMAP_API_KEY',
    rotationDays: 180,
    description: 'OpenWeatherMap API 密钥'
  },
  {
    keyName: 'database-password',
    keyType: 'db_password',
    sensitivity: 'high',
    envVar: 'DATABASE_PASSWORD',
    rotationDays: 90,
    description: 'PostgreSQL 数据库密码'
  },
  {
    keyName: 'redis-password',
    keyType: 'redis_password',
    sensitivity: 'high',
    envVar: 'REDIS_PASSWORD',
    rotationDays: 90,
    description: 'Redis 密码'
  },
  {
    keyName: 'catch-secret-key',
    keyType: 'encryption_key',
    sensitivity: 'high',
    envVar: 'CATCH_SECRET_KEY',
    rotationDays: 90,
    description: '捕捉系统签名密钥'
  },
  {
    keyName: 'jwt-secret',
    keyType: 'jwt_secret',
    sensitivity: 'high',
    envVar: 'JWT_SECRET',
    rotationDays: 90,
    description: '通用 JWT 密钥'
  }
];

/**
 * 迁移密钥
 */
async function migrateKeys(dryRun = false) {
  console.log('========================================');
  console.log('密钥迁移脚本');
  console.log(`模式: ${dryRun ? '预演 (Dry Run)' : '执行迁移'}`);
  console.log('========================================\n');

  const results = [];
  const keyService = kms.getKeyService();

  for (const migration of migrations) {
    const { keyName, keyType, sensitivity, envVar, rotationDays, description } = migration;
    
    console.log(`处理: ${keyName}`);
    console.log(`  描述: ${description}`);
    console.log(`  敏感级别: ${sensitivity}`);
    console.log(`  轮换周期: ${rotationDays} 天`);

    const value = process.env[envVar];
    
    if (!value) {
      console.log(`  状态: ⏭️  跳过（环境变量 ${envVar} 未设置）\n`);
      results.push({ keyName, status: 'skipped', reason: 'env_not_set' });
      continue;
    }

    // 检查是否是默认值（开发环境的弱密钥）
    const weakKeys = [
      'pmg-access-secret-change-in-prod',
      'pmg-refresh-secret-change-in-prod',
      'default-catch-secret-key',
      'mineGo-secret-key',
      'dev-secret'
    ];
    
    if (weakKeys.includes(value)) {
      console.log(`  状态: ⚠️  警告（使用默认弱密钥，建议立即轮换）`);
    }

    if (dryRun) {
      console.log(`  状态: 📋 预演 - 将创建密钥\n`);
      results.push({ keyName, status: 'dry_run', value: '***' });
      continue;
    }

    try {
      // 检查密钥是否已存在
      try {
        const existing = await keyService.getKeyMeta(keyName);
        if (existing) {
          console.log(`  状态: ⏭️  跳过（密钥已存在）\n`);
          results.push({ keyName, status: 'exists' });
          continue;
        }
      } catch (err) {
        // 密钥不存在，继续创建
      }

      // 创建密钥
      await keyService.createKey({
        keyName,
        keyType,
        sensitivity,
        value,
        rotationPeriodDays: rotationDays
      });

      console.log(`  状态: ✅ 成功迁移\n`);
      results.push({ keyName, status: 'success' });
    } catch (error) {
      console.log(`  状态: ❌ 失败: ${error.message}\n`);
      results.push({ keyName, status: 'error', error: error.message });
    }
  }

  // 输出汇总
  console.log('========================================');
  console.log('迁移汇总');
  console.log('========================================');
  
  const success = results.filter(r => r.status === 'success').length;
  const skipped = results.filter(r => r.status === 'skipped' || r.status === 'exists').length;
  const errors = results.filter(r => r.status === 'error').length;

  console.log(`总计: ${results.length} 个密钥`);
  console.log(`成功: ${success}`);
  console.log(`跳过: ${skipped}`);
  console.log(`失败: ${errors}`);
  console.log('');

  if (errors > 0) {
    console.log('失败的密钥:');
    results.filter(r => r.status === 'error').forEach(r => {
      console.log(`  - ${r.keyName}: ${r.error}`);
    });
    process.exit(1);
  }

  return results;
}

/**
 * 验证迁移结果
 */
async function verifyMigration() {
  console.log('\n验证迁移结果...\n');
  
  const keyService = kms.getKeyService();
  
  for (const migration of migrations) {
    const { keyName, envVar } = migration;
    
    try {
      const keyValue = await keyService.getKey(keyName);
      const envValue = process.env[envVar];
      
      if (keyValue === envValue) {
        console.log(`✅ ${keyName}: 验证通过`);
      } else {
        console.log(`⚠️  ${keyName}: 值不匹配`);
      }
    } catch (error) {
      console.log(`❌ ${keyName}: 验证失败 - ${error.message}`);
    }
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');

  try {
    if (verify) {
      await verifyMigration();
    } else {
      await migrateKeys(dryRun);
    }
  } catch (error) {
    console.error('迁移失败:', error);
    process.exit(1);
  }

  process.exit(0);
}

// 执行
if (require.main === module) {
  main();
}

module.exports = {
  migrateKeys,
  verifyMigration,
  migrations
};
