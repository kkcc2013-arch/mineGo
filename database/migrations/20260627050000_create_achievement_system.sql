-- REQ-00076: Achievement System Migration
-- Created: 2026-06-27 05:00 UTC

-- 成就定义表
CREATE TABLE IF NOT EXISTS achievements (
    id SERIAL PRIMARY KEY,
    achievement_id VARCHAR(50) UNIQUE NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category IN ('catch', 'breed', 'battle', 'social', 'explore')),
    name JSONB NOT NULL,
    description JSONB NOT NULL,
    icon_url VARCHAR(500),
    rarity VARCHAR(20) NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
    points INTEGER NOT NULL DEFAULT 10,
    is_hidden BOOLEAN DEFAULT FALSE,
    trigger_conditions JSONB NOT NULL,
    rewards JSONB NOT NULL,
    prerequisite_achievement_id VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 用户成就表
CREATE TABLE IF NOT EXISTS user_achievements (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    achievement_id VARCHAR(50) NOT NULL REFERENCES achievements(achievement_id),
    progress INTEGER DEFAULT 0,
    target INTEGER NOT NULL,
    completed BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP,
    rewards_claimed BOOLEAN DEFAULT FALSE,
    rewards_claimed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, achievement_id)
);

-- 成就进度快照
CREATE TABLE IF NOT EXISTS achievement_progress_snapshots (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) UNIQUE NOT NULL,
    category_progress JSONB NOT NULL DEFAULT '{}',
    total_points INTEGER DEFAULT 0,
    achievements_completed INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT NOW()
);

-- 成就触发事件日志
CREATE TABLE IF NOT EXISTS achievement_events (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 称号表
CREATE TABLE IF NOT EXISTS user_titles (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    title_id VARCHAR(50) NOT NULL,
    title_name JSONB NOT NULL,
    source_achievement_id VARCHAR(50),
    is_active BOOLEAN DEFAULT FALSE,
    unlocked_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, title_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);
CREATE INDEX IF NOT EXISTS idx_user_achievements_completed ON user_achievements(completed) WHERE completed = TRUE;
CREATE INDEX IF NOT EXISTS idx_achievement_progress_user ON achievement_progress_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_achievement_events_user ON achievement_events(user_id, processed);
CREATE INDEX IF NOT EXISTS idx_achievements_category ON achievements(category);
CREATE INDEX IF NOT EXISTS idx_achievements_hidden ON achievements(is_hidden);
CREATE INDEX IF NOT EXISTS idx_user_titles_user ON user_titles(user_id);

-- 注释
COMMENT ON TABLE achievements IS '成就定义表 - REQ-00076';
COMMENT ON TABLE user_achievements IS '用户成就进度表 - REQ-00076';
COMMENT ON TABLE achievement_progress_snapshots IS '成就进度快照，用于快速查询 - REQ-00076';
COMMENT ON TABLE achievement_events IS '成就触发事件日志 - REQ-00076';
COMMENT ON TABLE user_titles IS '用户称号表 - REQ-00076';
