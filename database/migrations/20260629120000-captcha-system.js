'use strict';

/**
 * CAPTCHA 系统数据库迁移
 * 创建验证会话表、统计表和配置表
 */

module.exports = {
  name: 'captcha-system',

  up: async (client) => {
    // 1. 验证会话表
    await client.query(`
      CREATE TABLE IF NOT EXISTS captcha_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INTEGER NOT NULL,
        session_type VARCHAR(20) NOT NULL CHECK (session_type IN ('slide', 'click', 'calculate')),
        difficulty VARCHAR(20) NOT NULL CHECK (difficulty IN ('low', 'medium', 'high')),
        trigger_reason VARCHAR(50) NOT NULL,
        challenge_data JSONB NOT NULL,
        expected_answer JSONB NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'expired')),
        attempt_count INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        client_data JSONB,
        ip_address INET,
        device_fingerprint VARCHAR(128)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_captcha_sessions_user ON captcha_sessions(user_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_captcha_sessions_status ON captcha_sessions(status, expires_at);
    `);

    // 2. 验证历史统计表
    await client.query(`
      CREATE TABLE IF NOT EXISTS captcha_stats (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE,
        total_verifications INTEGER DEFAULT 0,
        passed_verifications INTEGER DEFAULT 0,
        failed_verifications INTEGER DEFAULT 0,
        avg_response_time_ms INTEGER,
        last_verification_at TIMESTAMPTZ,
        last_passed_verification_at TIMESTAMPTZ,
        last_failed_verification_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_captcha_stats_user ON captcha_stats(user_id);
    `);

    // 3. 验证配置表
    await client.query(`
      CREATE TABLE IF NOT EXISTS captcha_config (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        description TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 4. 初始配置数据
    await client.query(`
      INSERT INTO captcha_config (key, value, description) VALUES
        ('trigger_thresholds', '{"high": 40, "medium": 60, "low": 80}', '风险评分触发阈值'),
        ('session_timeout_seconds', '300', '验证会话超时时间（秒）'),
        ('max_attempts', '3', '最大尝试次数'),
        ('difficulty_mapping', '{"low": ["slide"], "medium": ["slide", "click"], "high": ["slide", "click", "calculate"]}', '难度对应验证类型'),
        ('trust_score_recovery', '10', '验证通过后恢复的可信度'),
        ('trust_score_penalty', '10', '验证失败后扣除的可信度'),
        ('cooldown_minutes', '30', '验证触发冷却期（分钟）'),
        ('periodic_high_risk_days', '7', '高风险用户定期验证周期（天）'),
        ('periodic_normal_days', '30', '正常用户定期验证周期（天）')
      ON CONFLICT (key) DO NOTHING;
    `);

    // 5. 验证触发记录表
    await client.query(`
      CREATE TABLE IF NOT EXISTS captcha_trigger_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        trigger_reason VARCHAR(50) NOT NULL,
        difficulty VARCHAR(20) NOT NULL,
        session_id UUID,
        triggered_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        resolution VARCHAR(20) CHECK (resolution IN ('passed', 'failed', 'expired', 'skipped'))
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_captcha_trigger_logs_user ON captcha_trigger_logs(user_id, triggered_at DESC);
    `);

    console.log('✅ CAPTCHA system tables created');
  },

  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS captcha_trigger_logs');
    await client.query('DROP TABLE IF EXISTS captcha_config');
    await client.query('DROP TABLE IF EXISTS captcha_stats');
    await client.query('DROP TABLE IF EXISTS captcha_sessions');
    console.log('✅ CAPTCHA system tables dropped');
  }
};