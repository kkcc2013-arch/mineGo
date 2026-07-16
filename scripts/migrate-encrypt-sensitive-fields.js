#!/usr/bin/env node
/**
 * REQ-00565: 数据库敏感字段透明加密系统
 * 
 * 数据迁移脚本：将现有明文敏感字段加密
 * 
 * 使用方法：
 * node scripts/migrate-encrypt-sensitive-fields.js --dry-run
 * node scripts/migrate-encrypt-sensitive-fields.js --batch-size 100
 */

'use strict';

const path = require('path');
const { Sequelize } = require('sequelize');

// 加载环境变量
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { initializeEncryption, getEncryptionEngine, decryptBatchData } = require('../backend/shared/crypto');
const { createLogger } = require('../backend/shared/logger');

const logger = createLogger('migrate-encrypt');

// 配置
const CONFIG = {
  batchSize: parseInt(process.env.MIGRATION_BATCH_SIZE) || 100,
  dryRun: process.argv.includes('--dry-run'),
  verify: process.argv.includes('--verify')
};

/**
 * 敏感字段配置
 * 定义需要加密的表和字段
 */
const SENSITIVE_FIELDS = {
  users: {
    primaryKey: 'id',
    fields: {
      phone: { context: 'users.phone', searchable: true },
      email: { context: 'users.email', searchable: true },
      real_name: { context: 'users.real_name', searchable: false }
    }
  },
  payment_methods: {
    primaryKey: 'id',
    fields: {
      card_last_four: { context: 'payment_methods.card_last_four', searchable: true },
      billing_address: { context: 'payment_methods.billing_address', searchable: false }
    }
  },
  social_messages: {
    primaryKey: 'id',
    fields: {
      content: { context: 'social_messages.content', searchable: false }
    }
  }
};

/**
 * 主迁移函数
 */
async function migrateEncrypt() {
  logger.info('Starting encryption migration', CONFIG);

  // 初始化数据库连接
  const sequelize = new Sequelize(process.env.DATABASE_URL, {
    logging: false,
    dialect: 'postgres'
  });

  try {
    // 测试数据库连接
    await sequelize.authenticate();
    logger.info('Database connected');

    // 初始化加密引擎
    await initializeEncryption();
    const engine = getEncryptionEngine();

    // 检查加密引擎健康状态
    const health = await engine.healthCheck();
    logger.info('Encryption engine health', health);

    if (health.status !== 'healthy') {
      throw new Error('Encryption engine not healthy');
    }

    // 迁移每个表
    for (const [tableName, tableConfig] of Object.entries(SENSITIVE_FIELDS)) {
      await migrateTable(sequelize, tableName, tableConfig);
    }

    logger.info('Migration completed successfully');
  } catch (error) {
    logger.error('Migration failed', { error: error.message, stack: error.stack });
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

/**
 * 迁移单个表
 */
async function migrateTable(sequelize, tableName, tableConfig) {
  const { primaryKey, fields } = tableConfig;
  const fieldNames = Object.keys(fields);

  logger.info(`Migrating table: ${tableName}`, { fields: fieldNames });

  // 检查是否已有加密数据
  const sampleRow = await sequelize.query(
    `SELECT ${fieldNames.join(', ')} FROM ${tableName} LIMIT 1`,
    { type: Sequelize.QueryTypes.SELECT }
  );

  if (sampleRow.length > 0) {
    // 检查是否已加密（加密格式以版本字节 0x01 开头，Base64 编码后）
    const firstField = fieldNames[0];
    const sampleValue = sampleRow[0][firstField];
    
    if (sampleValue && sampleValue.startsWith('AQ')) {
      logger.info(`Table ${tableName} already encrypted, skipping`);
      return;
    }
  }

  // 获取总行数
  const countResult = await sequelize.query(
    `SELECT COUNT(*) as count FROM ${tableName}`,
    { type: Sequelize.QueryTypes.SELECT }
  );
  const totalRows = parseInt(countResult[0].count);
  
  logger.info(`Total rows to migrate: ${totalRows}`);

  let processedRows = 0;
  let offset = 0;

  while (offset < totalRows) {
    // 分批查询
    const rows = await sequelize.query(
      `SELECT ${primaryKey}, ${fieldNames.join(', ')} FROM ${tableName} 
       ORDER BY ${primaryKey} 
       LIMIT ${CONFIG.batchSize} OFFSET ${offset}`,
      { type: Sequelize.QueryTypes.SELECT }
    );

    if (rows.length === 0) break;

    // 加密并更新
    for (const row of rows) {
      await migrateRow(sequelize, tableName, primaryKey, row, fields);
      processedRows++;
    }

    offset += CONFIG.batchSize;
    
    logger.info(`Progress: ${processedRows}/${totalRows} rows processed`);
  }

  logger.info(`Table ${tableName} migration completed`, { processedRows });
}

/**
 * 迁移单行数据
 */
async function migrateRow(sequelize, tableName, primaryKey, row, fields) {
  const engine = getEncryptionEngine();
  const updates = {};
  const originalValues = {};

  for (const [fieldName, fieldConfig] of Object.entries(fields)) {
    const value = row[fieldName];
    
    if (value === null || value === undefined || value === '') {
      continue;
    }

    originalValues[fieldName] = value;

    // 加密
    const encrypted = fieldConfig.searchable
      ? await engine.encryptDeterministic(value, fieldConfig.context)
      : await engine.encryptRandom(value, fieldConfig.context);

    updates[fieldName] = encrypted;
  }

  if (Object.keys(updates).length === 0) {
    return; // 无需更新
  }

  if (CONFIG.dryRun) {
    logger.info('Dry run: would update', {
      table: tableName,
      primaryKey: row[primaryKey],
      fields: Object.keys(updates)
    });
    return;
  }

  // 更新数据库
  const setClauses = Object.keys(updates)
    .map(field => `${field} = :${field}`)
    .join(', ');

  await sequelize.query(
    `UPDATE ${tableName} SET ${setClauses} WHERE ${primaryKey} = :id`,
    {
      replacements: { ...updates, id: row[primaryKey] },
      type: Sequelize.QueryTypes.UPDATE
    }
  );
}

/**
 * 验证迁移结果
 */
async function verifyMigration(sequelize, tableName, tableConfig) {
  const { primaryKey, fields } = tableConfig;
  const fieldNames = Object.keys(fields);
  const engine = getEncryptionEngine();

  logger.info(`Verifying table: ${tableName}`);

  // 随机抽样验证
  const rows = await sequelize.query(
    `SELECT ${primaryKey}, ${fieldNames.join(', ')} FROM ${tableName} 
     ORDER BY RANDOM() LIMIT 10`,
    { type: Sequelize.QueryTypes.SELECT }
  );

  for (const row of rows) {
    for (const [fieldName, fieldConfig] of Object.entries(fields)) {
      const encrypted = row[fieldName];
      
      if (!encrypted) continue;

      // 尝试解密
      try {
        const decrypted = await engine.decrypt(encrypted, fieldConfig.context);
        logger.info('Verification passed', {
          table: tableName,
          field: fieldName,
          decryptedLength: decrypted.length
        });
      } catch (error) {
        logger.error('Verification failed', {
          table: tableName,
          field: fieldName,
          error: error.message
        });
      }
    }
  }
}

/**
 * 回滚加密（紧急情况）
 */
async function rollbackEncryption(sequelize) {
  logger.warn('Rollback not implemented - keys must be preserved for decryption');
  logger.warn('To rollback: export data, then restore from backup');
}

// 执行迁移
if (require.main === module) {
  migrateEncrypt().catch(error => {
    console.error('Migration error:', error);
    process.exit(1);
  });
}

module.exports = {
  migrateEncrypt,
  migrateTable,
  migrateRow,
  SENSITIVE_FIELDS
};