// database/migrations/20260613150000_config_audit_log.js
'use strict';

/**
 * 配置审计日志表
 * 用于记录配置变更历史，支持审计追踪
 */

exports.up = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS config_audit_log (
      id SERIAL PRIMARY KEY,
      service_name VARCHAR(100) NOT NULL,
      config_key VARCHAR(200) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      changed_by VARCHAR(200) NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  
  // 创建索引
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_config_audit_service 
    ON config_audit_log(service_name);
  `);
  
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_config_audit_created_at 
    ON config_audit_log(created_at DESC);
  `);
  
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_config_audit_key 
    ON config_audit_log(config_key);
  `);
  
  // 添加分区（按月分区，保留 12 个月）
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const month = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
    const tableName = `config_audit_log_${month.getFullYear()}_${String(month.getMonth() + 1).padStart(2, '0')}`;
    
    // 注意：分区表需要额外的设置，这里简化处理
    // 实际生产环境需要完整的分区配置
  }
  
  console.log('✅ config_audit_log table created');
};

exports.down = async (client) => {
  await client.query('DROP TABLE IF EXISTS config_audit_log CASCADE');
  console.log('✅ config_audit_log table dropped');
};
