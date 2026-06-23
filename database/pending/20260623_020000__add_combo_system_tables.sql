-- 精灵技能连击系统数据库迁移
-- Migration: 20260623_020000__add_combo_system_tables.sql

-- 连击链配置表
CREATE TABLE IF NOT EXISTS combo_chains (
    id SERIAL PRIMARY KEY,
    chain_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,

    -- 触发条件
    trigger_sequence JSONB NOT NULL,  -- ["THUNDER_SHOCK", "THUNDER_WAVE", "THUNDERBOLT"]
    time_window_ms INTEGER DEFAULT 3000,  -- 3秒内完成连击
    element_requirement VARCHAR(50),      -- 可选：需要特定元素类型

    -- 连击效果
    damage_multiplier DECIMAL(3,2) DEFAULT 1.0,
    bonus_effects JSONB,  -- {"status": "paralyzed", "duration": 5}
    cooldown_reduction INTEGER DEFAULT 0,  -- 冷却缩减百分比

    -- 奖励
    combo_points INTEGER DEFAULT 1,
    xp_bonus INTEGER DEFAULT 0,

    -- 解锁条件
    min_trainer_level INTEGER DEFAULT 1,
    required_badges INTEGER DEFAULT 0,

    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 玩家连击统计表
CREATE TABLE IF NOT EXISTS user_combo_stats (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    chain_id VARCHAR(50) NOT NULL REFERENCES combo_chains(chain_id),
    times_executed INTEGER DEFAULT 0,
    perfect_executions INTEGER DEFAULT 0,
    last_executed_at TIMESTAMP,
    highest_damage_dealt INTEGER DEFAULT 0,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(user_id, chain_id)
);

-- 连击记录表（用于排行榜）
CREATE TABLE IF NOT EXISTS combo_records (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    chain_id VARCHAR(50) NOT NULL,
    pokemon_id VARCHAR(36),
    battle_type VARCHAR(20), -- 'pvp', 'raid', 'gym'
    quality VARCHAR(20) NOT NULL, -- 'perfect', 'excellent', 'normal'
    damage_dealt INTEGER,
    combo_points_earned INTEGER,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- 元数据
    battle_id VARCHAR(36),
    opponent_id VARCHAR(36)
);

-- 索引
CREATE INDEX idx_user_combo_stats_user ON user_combo_stats(user_id);
CREATE INDEX idx_user_combo_stats_chain ON user_combo_stats(chain_id);
CREATE INDEX idx_combo_records_user ON combo_records(user_id);
CREATE INDEX idx_combo_records_time ON combo_records(executed_at DESC);
CREATE INDEX idx_combo_records_damage ON combo_records(damage_dealt DESC);

-- 注释
COMMENT ON TABLE combo_chains IS '连击链配置表';
COMMENT ON TABLE user_combo_stats IS '玩家连击统计表';
COMMENT ON TABLE combo_records IS '连击记录表，用于排行榜和数据分析';
