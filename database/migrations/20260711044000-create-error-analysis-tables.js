/**
 * 错误分析系统数据库迁移
 * 
 * 创建错误聚合、快照、根因分析等相关表
 */

const migration = {
  up: async (client) => {
    // 错误聚合组表
    await client.query(`
      CREATE TABLE IF NOT EXISTS error_groups (
        id VARCHAR(36) PRIMARY KEY,
        fingerprint VARCHAR(64) NOT NULL,
        error_code VARCHAR(64),
        error_name VARCHAR(128),
        message_pattern TEXT,
        key_frames JSONB,
        service VARCHAR(64) NOT NULL,
        status VARCHAR(32) DEFAULT 'active',
        first_seen TIMESTAMP NOT NULL,
        last_seen TIMESTAMP NOT NULL,
        occurrence_count INTEGER DEFAULT 1,
        affected_users INTEGER DEFAULT 0,
        sample_error JSONB,
        root_cause JSONB,
        resolution TEXT,
        resolved_at TIMESTAMP,
        resolved_by VARCHAR(64),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    // 创建索引
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_groups_fingerprint ON error_groups(fingerprint);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_groups_service ON error_groups(service);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_groups_status ON error_groups(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_groups_first_seen ON error_groups(first_seen);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_groups_last_seen ON error_groups(last_seen);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_groups_occurrence ON error_groups(occurrence_count DESC);`);
    
    // 错误事件表
    await client.query(`
      CREATE TABLE IF NOT EXISTS error_events (
        id VARCHAR(36) PRIMARY KEY,
        group_id VARCHAR(36) REFERENCES error_groups(id) ON DELETE SET NULL,
        error_code VARCHAR(64),
        error_name VARCHAR(128),
        message TEXT,
        stack_trace TEXT,
        service VARCHAR(64) NOT NULL,
        user_id VARCHAR(64),
        request_id VARCHAR(64),
        trace_id VARCHAR(64),
        occurred_at TIMESTAMP NOT NULL,
        context JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_events_group_id ON error_events(group_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_events_occurred_at ON error_events(occurred_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_events_user_id ON error_events(user_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_events_service ON error_events(service);`);
    
    // 错误快照表
    await client.query(`
      CREATE TABLE IF NOT EXISTS error_snapshots (
        id VARCHAR(36) PRIMARY KEY,
        group_id VARCHAR(36) REFERENCES error_groups(id) ON DELETE CASCADE,
        error_event_id VARCHAR(36) REFERENCES error_events(id) ON DELETE SET NULL,
        request JSONB,
        "user" JSONB,
        trace JSONB,
        environment JSONB,
        system JSONB,
        custom_data JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL
      );
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_snapshots_group_id ON error_snapshots(group_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_snapshots_expires_at ON error_snapshots(expires_at);`);
    
    // 根因分析历史表
    await client.query(`
      CREATE TABLE IF NOT EXISTS root_cause_analyses (
        id VARCHAR(36) PRIMARY KEY,
        group_id VARCHAR(36) REFERENCES error_groups(id) ON DELETE CASCADE,
        causes JSONB NOT NULL,
        recommendation TEXT,
        analyzed_at TIMESTAMP DEFAULT NOW(),
        analyzed_by VARCHAR(64) DEFAULT 'system'
      );
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_root_cause_group_id ON root_cause_analyses(group_id);`);
    
    // 告警记录表
    await client.query(`
      CREATE TABLE IF NOT EXISTS error_alerts (
        id VARCHAR(36) PRIMARY KEY,
        group_id VARCHAR(36) REFERENCES error_groups(id) ON DELETE SET NULL,
        severity VARCHAR(32) NOT NULL,
        channel VARCHAR(32) NOT NULL,
        title TEXT,
        sent_at TIMESTAMP NOT NULL,
        acknowledged_at TIMESTAMP,
        acknowledged_by VARCHAR(64),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_alerts_group_id ON error_alerts(group_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_alerts_sent_at ON error_alerts(sent_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_alerts_severity ON error_alerts(severity);`);
    
    // 错误统计日表（按服务）
    await client.query(`
      CREATE TABLE IF NOT EXISTS error_stats_daily (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        service VARCHAR(64) NOT NULL,
        error_code VARCHAR(64),
        total_count INTEGER DEFAULT 0,
        unique_users INTEGER DEFAULT 0,
        avg_rate NUMERIC(10, 4) DEFAULT 0,
        max_rate NUMERIC(10, 4) DEFAULT 0,
        min_rate NUMERIC(10, 4) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(date, service, error_code)
      );
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_stats_daily_date ON error_stats_daily(date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_stats_daily_service ON error_stats_daily(service);`);
    
    // 错误模式表（已知问题）
    await client.query(`
      CREATE TABLE IF NOT EXISTS error_patterns (
        id VARCHAR(36) PRIMARY KEY,
        fingerprint VARCHAR(64) NOT NULL UNIQUE,
        error_name VARCHAR(128),
        message_pattern TEXT,
        resolution TEXT,
        resolution_steps JSONB,
        created_by VARCHAR(64),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT true
      );
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_error_patterns_fingerprint ON error_patterns(fingerprint);`);
    
    console.log('Error analysis tables created successfully');
  },
  
  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS error_alerts;');
    await client.query('DROP TABLE IF EXISTS root_cause_analyses;');
    await client.query('DROP TABLE IF EXISTS error_snapshots;');
    await client.query('DROP TABLE IF EXISTS error_events;');
    await client.query('DROP TABLE IF EXISTS error_groups;');
    await client.query('DROP TABLE IF EXISTS error_stats_daily;');
    await client.query('DROP TABLE IF EXISTS error_patterns;');
    
    console.log('Error analysis tables dropped successfully');
  }
};

module.exports = migration;