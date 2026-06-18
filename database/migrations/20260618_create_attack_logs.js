/**
 * 创建安全审计日志表
 * 用于记录注入攻击、异常访问等安全事件
 * 
 * @migration 20260618_create_attack_logs
 */

exports.up = async (db) => {
  // 创建 security schema
  await db.query(`CREATE SCHEMA IF NOT EXISTS security`);
  
  // 创建攻击日志表
  await db.query(`
    CREATE TABLE IF NOT EXISTS security.attack_logs (
      id SERIAL PRIMARY KEY,
      type VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      ip INET NOT NULL,
      user_id INTEGER,
      endpoint VARCHAR(255) NOT NULL,
      method VARCHAR(10) NOT NULL,
      param VARCHAR(100),
      value TEXT,
      pattern VARCHAR(500),
      user_agent TEXT,
      blocked BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  // 创建索引
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_attack_logs_type_created 
      ON security.attack_logs (type, created_at DESC)
  `);
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_attack_logs_ip 
      ON security.attack_logs (ip, created_at DESC)
  `);
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_attack_logs_severity 
      ON security.attack_logs (severity, created_at DESC)
  `);
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_attack_logs_user 
      ON security.attack_logs (user_id, created_at DESC)
  `);
  
  // 创建攻击统计视图（24小时）
  await db.query(`
    CREATE OR REPLACE VIEW security.attack_stats_24h AS
    SELECT 
      type,
      severity,
      COUNT(*) as count,
      COUNT(DISTINCT ip) as unique_ips,
      COUNT(DISTINCT user_id) as unique_users,
      MAX(created_at) as last_occurrence
    FROM security.attack_logs
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY type, severity
    ORDER BY count DESC
  `);
  
  // 创建攻击统计视图（7天）
  await db.query(`
    CREATE OR REPLACE VIEW security.attack_stats_7d AS
    SELECT 
      type,
      DATE(created_at) as date,
      COUNT(*) as count,
      COUNT(DISTINCT ip) as unique_ips
    FROM security.attack_logs
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY type, DATE(created_at)
    ORDER BY date DESC, count DESC
  `);
  
  // 创建 IP 黑名单表
  await db.query(`
    CREATE TABLE IF NOT EXISTS security.ip_blacklist (
      id SERIAL PRIMARY KEY,
      ip INET NOT NULL UNIQUE,
      reason VARCHAR(255) NOT NULL,
      attack_count INTEGER DEFAULT 0,
      blocked_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      blocked_by VARCHAR(100)
    )
  `);
  
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ip_blacklist_expires 
      ON security.ip_blacklist (expires_at) 
      WHERE expires_at IS NOT NULL
  `);
  
  // 创建攻击阈值配置表
  await db.query(`
    CREATE TABLE IF NOT EXISTS security.attack_thresholds (
      id SERIAL PRIMARY KEY,
      type VARCHAR(50) NOT NULL UNIQUE,
      severity VARCHAR(20) NOT NULL,
      threshold INTEGER NOT NULL DEFAULT 10,
      window_seconds INTEGER NOT NULL DEFAULT 3600,
      action VARCHAR(50) NOT NULL DEFAULT 'alert',
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  // 插入默认阈值配置
  await db.query(`
    INSERT INTO security.attack_thresholds (type, severity, threshold, window_seconds, action) VALUES
    ('SQL_INJECTION', 'critical', 5, 3600, 'block_ip'),
    ('NOSQL_INJECTION', 'critical', 5, 3600, 'block_ip'),
    ('XSS', 'high', 10, 3600, 'alert'),
    ('PATH_TRAVERSAL', 'critical', 5, 3600, 'block_ip'),
    ('COMMAND_INJECTION', 'critical', 3, 3600, 'block_ip')
    ON CONFLICT (type) DO NOTHING
  `);
  
  console.log('✅ Security attack logs tables created');
};

exports.down = async (db) => {
  await db.query(`DROP VIEW IF EXISTS security.attack_stats_24h`);
  await db.query(`DROP VIEW IF EXISTS security.attack_stats_7d`);
  await db.query(`DROP TABLE IF EXISTS security.attack_thresholds`);
  await db.query(`DROP TABLE IF EXISTS security.ip_blacklist`);
  await db.query(`DROP TABLE IF EXISTS security.attack_logs`);
  await db.query(`DROP SCHEMA IF EXISTS security CASCADE`);
  
  console.log('✅ Security attack logs tables dropped');
};
