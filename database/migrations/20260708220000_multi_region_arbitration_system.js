/**
 * REQ-00514: 多区域服务状态同步与智能仲裁系统
 * 数据库迁移脚本
 * 
 * 创建时间: 2026-07-08 22:00 UTC
 */

'use strict';

module.exports = {
  up: async (pool) => {
    // 仲裁决策表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS arbitration_decisions (
        id SERIAL PRIMARY KEY,
        decision_id VARCHAR(100) UNIQUE NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        fault_type VARCHAR(50) NOT NULL,
        fault_severity INTEGER,
        decision_type VARCHAR(50) NOT NULL,
        action VARCHAR(100),
        priority INTEGER,
        
        affected_region VARCHAR(50),
        affected_service VARCHAR(50),
        
        healthy_regions TEXT[],
        recovery_plan JSONB,
        
        execution_status VARCHAR(50),
        execution_result JSONB,
        execution_duration_ms INTEGER,
        
        escalation_level INTEGER DEFAULT 0,
        
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    // 创建索引
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_decisions_timestamp ON arbitration_decisions(timestamp DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_decisions_fault_type ON arbitration_decisions(fault_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_decisions_decision_type ON arbitration_decisions(decision_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_decisions_region ON arbitration_decisions(affected_region)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_decisions_service ON arbitration_decisions(affected_service)`);
    
    // 审计日志表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS arbitration_audit_log (
        id SERIAL PRIMARY KEY,
        decision_id VARCHAR(100) NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        event_timestamp TIMESTAMPTZ NOT NULL,
        event_data JSONB,
        user_id VARCHAR(100),
        ip_address VARCHAR(50),
        
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_audit_decision_id ON arbitration_audit_log(decision_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_arb_audit_event_type ON arbitration_audit_log(event_type)`);
    
    // 区域健康状态表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS region_health_status (
        id SERIAL PRIMARY KEY,
        region VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL,
        services JSONB,
        latency_ms INTEGER,
        last_update TIMESTAMPTZ NOT NULL,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        UNIQUE(region)
      );
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_region_health_status ON region_health_status(region)`);
    
    // 降级状态表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS degradation_states (
        id SERIAL PRIMARY KEY,
        degradation_id VARCHAR(100) UNIQUE NOT NULL,
        region VARCHAR(50) NOT NULL,
        service VARCHAR(50) NOT NULL,
        fault_type VARCHAR(50) NOT NULL,
        strategy VARCHAR(50) NOT NULL,
        status VARCHAR(30) NOT NULL,
        
        attempt_count INTEGER DEFAULT 0,
        max_attempts INTEGER,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ,
        escalated_to VARCHAR(50),
        
        result JSONB,
        
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_degradation_region ON degradation_states(region)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_degradation_service ON degradation_states(service)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_degradation_status ON degradation_states(status)`);
    
    // 投票会话表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS voting_sessions (
        id SERIAL PRIMARY KEY,
        voting_id VARCHAR(100) UNIQUE NOT NULL,
        decision JSONB NOT NULL,
        initiator VARCHAR(50) NOT NULL,
        status VARCHAR(30) NOT NULL,
        
        quorum_reached BOOLEAN DEFAULT FALSE,
        total_votes INTEGER DEFAULT 0,
        yes_votes INTEGER DEFAULT 0,
        no_votes INTEGER DEFAULT 0,
        
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ,
        
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_voting_status ON voting_sessions(status)`);
    
    // 投票记录表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vote_records (
        id SERIAL PRIMARY KEY,
        voting_id VARCHAR(100) NOT NULL,
        region VARCHAR(50) NOT NULL,
        vote VARCHAR(10) NOT NULL,
        reason TEXT,
        vote_time TIMESTAMPTZ NOT NULL,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        UNIQUE(voting_id, region)
      );
    `);
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vote_voting_id ON vote_records(voting_id)`);
    
    // 视图：最近仲裁决策视图
    await pool.query(`
      CREATE OR REPLACE VIEW recent_arbitration_decisions AS
      SELECT 
        decision_id,
        timestamp,
        fault_type,
        fault_severity,
        decision_type,
        action,
        affected_region,
        affected_service,
        execution_status,
        escalation_level
      FROM arbitration_decisions
      ORDER BY timestamp DESC
      LIMIT 100;
    `);
    
    // 视图：区域健康概览视图
    await pool.query(`
      CREATE OR REPLACE VIEW region_health_overview AS
      SELECT 
        region,
        status,
        latency_ms,
        last_update,
        EXTRACT(EPOCH FROM (NOW() - last_update)) as seconds_since_update
      FROM region_health_status
      ORDER BY region;
    `);
    
    console.log('Multi-region arbitration system tables created successfully');
  },
  
  down: async (pool) => {
    await pool.query('DROP VIEW IF EXISTS region_health_overview');
    await pool.query('DROP VIEW IF EXISTS recent_arbitration_decisions');
    await pool.query('DROP TABLE IF EXISTS vote_records');
    await pool.query('DROP TABLE IF EXISTS voting_sessions');
    await pool.query('DROP TABLE IF EXISTS degradation_states');
    await pool.query('DROP TABLE IF EXISTS region_health_status');
    await pool.query('DROP TABLE IF EXISTS arbitration_audit_log');
    await pool.query('DROP TABLE IF EXISTS arbitration_decisions');
    
    console.log('Multi-region arbitration system tables dropped');
  }
};