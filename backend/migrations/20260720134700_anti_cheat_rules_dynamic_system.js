/**
 * 数据库迁移：反作弊规则动态更新与灰度测试系统
 * REQ-00608
 * 创建时间：2026-07-20 13:47
 */

'use strict';

module.exports = {
  up: async (db) => {
    // 反作弊规则表
    await db.query(`
      CREATE TABLE anti_cheat_rules (
        id SERIAL PRIMARY KEY,
        rule_id VARCHAR(50) UNIQUE NOT NULL,
        rule_name VARCHAR(200) NOT NULL,
        category VARCHAR(50) NOT NULL,
        description TEXT,
        
        -- 规则配置（JSON格式）
        config JSONB NOT NULL DEFAULT '{}',
        
        -- 灰度配置
        rollout_strategy VARCHAR(20) DEFAULT 'instant',
        rollout_percentage INT DEFAULT 100 CHECK (rollout_percentage BETWEEN 0 AND 100),
        rollout_plan JSONB DEFAULT '{}',
        
        -- A/B 测试配置
        ab_test_enabled BOOLEAN DEFAULT FALSE,
        ab_test_variants JSONB DEFAULT '[]',
        
        -- 元数据
        priority INT DEFAULT 50,
        status VARCHAR(20) DEFAULT 'active',
        version INT DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        created_by INT,
        
        -- 效果统计（定时更新）
        stats JSONB DEFAULT '{}'
      );
    `);

    // 规则变更历史表
    await db.query(`
      CREATE TABLE anti_cheat_rule_history (
        id SERIAL PRIMARY KEY,
        rule_id VARCHAR(50) NOT NULL,
        action VARCHAR(50) NOT NULL,
        old_config JSONB,
        new_config JSONB,
        reason TEXT,
        changed_by INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // A/B 测试结果表
    await db.query(`
      CREATE TABLE anti_cheat_ab_test_results (
        id SERIAL PRIMARY KEY,
        test_id VARCHAR(100) NOT NULL,
        rule_id VARCHAR(50) NOT NULL,
        variant_id VARCHAR(50) NOT NULL,
        user_id INT NOT NULL,
        result VARCHAR(50) NOT NULL,
        score INT,
        details JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 索引
    await db.query(`
      CREATE INDEX idx_rules_category ON anti_cheat_rules(category);
      CREATE INDEX idx_rules_status ON anti_cheat_rules(status);
      CREATE INDEX idx_rule_history_rule ON anti_cheat_rule_history(rule_id, created_at DESC);
      CREATE INDEX idx_ab_test ON anti_cheat_ab_test_results(test_id, variant_id);
      CREATE INDEX idx_ab_test_user ON anti_cheat_ab_test_results(user_id, created_at DESC);
    `);

    // 插入示例规则数据
    await db.query(`
      INSERT INTO anti_cheat_rules (rule_id, rule_name, category, description, config, priority) VALUES
      ('SPEED_HACK_001', '速度异常检测', 'location', '检测移动速度是否超过物理限制', 
       '{"thresholds": {"maxSpeed": 100, "avgSpeed": 30}, "weights": {"severity": "high", "score": 85}, "enabled": true}', 90),
      ('CATCH_FREQUENCY_001', '捕捉频率异常', 'catch', '检测捕捉频率是否超过合理范围',
       '{"thresholds": {"maxPerMinute": 10, "windowSeconds": 3600}, "weights": {"severity": "high", "score": 80}, "enabled": true}', 85),
      ('GPS_SPOOF_001', 'GPS欺骗检测', 'location', '检测GPS位置跳跃和轨迹异常',
       '{"thresholds": {"maxJumpDistance": 5000, "impossibleSpeed": 500}, "weights": {"severity": "critical", "score": 95}, "enabled": true}', 95);
    `);

    console.log('Migration completed: anti_cheat_rules tables created');
  },

  down: async (db) => {
    await db.query('DROP TABLE IF EXISTS anti_cheat_ab_test_results CASCADE');
    await db.query('DROP TABLE IF EXISTS anti_cheat_rule_history CASCADE');
    await db.query('DROP TABLE IF EXISTS anti_cheat_rules CASCADE');
    console.log('Migration rolled back: anti_cheat_rules tables dropped');
  }
};
