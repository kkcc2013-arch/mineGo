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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS achievement_id VARCHAR(50);
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS category VARCHAR(30);
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS name JSONB;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS description JSONB;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS icon_url VARCHAR(500);
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS rarity VARCHAR(20);
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 10;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT FALSE;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS trigger_conditions JSONB;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS rewards JSONB;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS prerequisite_achievement_id VARCHAR(50);
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.achievements') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('achievement_id', 'category', 'name', 'description', 'icon_url', 'rarity', 'points', 'is_hidden', 'trigger_conditions', 'rewards', 'prerequisite_achievement_id', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE achievements ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS user_id VARCHAR(50);
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS achievement_id VARCHAR(50);
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS target INTEGER;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT FALSE;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS rewards_claimed BOOLEAN DEFAULT FALSE;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS rewards_claimed_at TIMESTAMP;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.user_achievements') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('user_id', 'achievement_id', 'progress', 'target', 'completed', 'completed_at', 'rewards_claimed', 'rewards_claimed_at', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE user_achievements ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 成就进度快照
CREATE TABLE IF NOT EXISTS achievement_progress_snapshots (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) UNIQUE NOT NULL,
    category_progress JSONB NOT NULL DEFAULT '{}',
    total_points INTEGER DEFAULT 0,
    achievements_completed INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE achievement_progress_snapshots ADD COLUMN IF NOT EXISTS user_id VARCHAR(50);
ALTER TABLE achievement_progress_snapshots ADD COLUMN IF NOT EXISTS category_progress JSONB DEFAULT '{}';
ALTER TABLE achievement_progress_snapshots ADD COLUMN IF NOT EXISTS total_points INTEGER DEFAULT 0;
ALTER TABLE achievement_progress_snapshots ADD COLUMN IF NOT EXISTS achievements_completed INTEGER DEFAULT 0;
ALTER TABLE achievement_progress_snapshots ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.achievement_progress_snapshots') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('user_id', 'category_progress', 'total_points', 'achievements_completed', 'last_updated', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE achievement_progress_snapshots ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 成就触发事件日志
CREATE TABLE IF NOT EXISTS achievement_events (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE achievement_events ADD COLUMN IF NOT EXISTS user_id VARCHAR(50);
ALTER TABLE achievement_events ADD COLUMN IF NOT EXISTS event_type VARCHAR(50);
ALTER TABLE achievement_events ADD COLUMN IF NOT EXISTS event_data JSONB;
ALTER TABLE achievement_events ADD COLUMN IF NOT EXISTS processed BOOLEAN DEFAULT FALSE;
ALTER TABLE achievement_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.achievement_events') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('user_id', 'event_type', 'event_data', 'processed', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE achievement_events ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE user_titles ADD COLUMN IF NOT EXISTS user_id VARCHAR(50);
ALTER TABLE user_titles ADD COLUMN IF NOT EXISTS title_id VARCHAR(50);
ALTER TABLE user_titles ADD COLUMN IF NOT EXISTS title_name JSONB;
ALTER TABLE user_titles ADD COLUMN IF NOT EXISTS source_achievement_id VARCHAR(50);
ALTER TABLE user_titles ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT FALSE;
ALTER TABLE user_titles ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.user_titles') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('user_id', 'title_id', 'title_name', 'source_achievement_id', 'is_active', 'unlocked_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE user_titles ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
