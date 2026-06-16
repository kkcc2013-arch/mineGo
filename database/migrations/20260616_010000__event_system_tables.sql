-- REQ-00057: 游戏活动系统与限时活动管理
-- 创建活动相关的数据库表

-- 活动类型配置表
CREATE TABLE IF NOT EXISTS event_types (
    id SERIAL PRIMARY KEY,
    type_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    config_schema JSONB NOT NULL DEFAULT '{}',
    default_config JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 活动主表
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    event_key VARCHAR(100) UNIQUE NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    event_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled')),
    
    -- 时间配置
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    timezone VARCHAR(50) DEFAULT 'UTC',
    is_recurring BOOLEAN DEFAULT FALSE,
    recurrence_rule JSONB,
    
    -- 范围配置
    scope_type VARCHAR(20) DEFAULT 'global' CHECK (scope_type IN ('global', 'region', 'location', 'user_segment')),
    scope_config JSONB DEFAULT '{}',
    
    -- 活动配置
    event_config JSONB NOT NULL DEFAULT '{}',
    rewards JSONB DEFAULT '[]',
    
    -- 显示配置
    banner_image VARCHAR(500),
    icon VARCHAR(255),
    display_priority INTEGER DEFAULT 0,
    show_countdown BOOLEAN DEFAULT TRUE,
    show_progress BOOLEAN DEFAULT TRUE,
    
    -- 统计数据
    participant_count INTEGER DEFAULT 0,
    completion_count INTEGER DEFAULT 0,
    
    -- 元数据
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP,
    
    CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

-- 活动参与记录表
CREATE TABLE IF NOT EXISTS event_participations (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
    progress JSONB DEFAULT '{}',
    rewards_claimed BOOLEAN DEFAULT FALSE,
    rewards_claimed_at TIMESTAMP,
    completed_at TIMESTAMP,
    UNIQUE(event_id, user_id)
);

-- 活动奖励发放记录
CREATE TABLE IF NOT EXISTS event_reward_claims (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    reward_type VARCHAR(50) NOT NULL,
    reward_data JSONB NOT NULL,
    claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- 奖励内容快照
    items JSONB,
    pokemon_id INTEGER,
    currency_amount INTEGER,
    
    UNIQUE(event_id, user_id, reward_type)
);

-- 活动精灵刷新配置表
CREATE TABLE IF NOT EXISTS event_spawns (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    pokemon_species_id INTEGER NOT NULL,
    spawn_rate_multiplier DECIMAL(10,2) DEFAULT 1.0,
    shiny_rate_multiplier DECIMAL(10,2) DEFAULT 1.0,
    min_iv INTEGER DEFAULT 0,
    max_iv INTEGER DEFAULT 100,
    level_range JSONB DEFAULT '{"min": 1, "max": 35}',
    location_restrictions JSONB,
    time_restrictions JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 活动任务表
CREATE TABLE IF NOT EXISTS event_tasks (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    task_key VARCHAR(100) NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    task_type VARCHAR(50) NOT NULL,
    requirement JSONB NOT NULL,
    rewards JSONB NOT NULL,
    display_order INTEGER DEFAULT 0,
    is_required BOOLEAN DEFAULT TRUE,
    is_repeatable BOOLEAN DEFAULT FALSE,
    max_completions INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, task_key)
);

-- 用户活动任务完成记录
CREATE TABLE IF NOT EXISTS user_event_tasks (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    progress JSONB DEFAULT '{}',
    completed_count INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, task_id, user_id)
);

-- 活动商店表
CREATE TABLE IF NOT EXISTS event_shops (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    item_key VARCHAR(100) NOT NULL,
    item_name VARCHAR(200) NOT NULL,
    item_type VARCHAR(50) NOT NULL,
    item_data JSONB NOT NULL,
    cost_type VARCHAR(20) NOT NULL,
    cost_amount INTEGER NOT NULL,
    purchase_limit INTEGER,
    daily_limit INTEGER,
    total_stock INTEGER,
    sold_count INTEGER DEFAULT 0,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    available_from TIMESTAMP,
    available_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, item_key)
);

-- 活动商店购买记录
CREATE TABLE IF NOT EXISTS event_shop_purchases (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    shop_item_id INTEGER NOT NULL REFERENCES event_shops(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    purchase_count INTEGER DEFAULT 1,
    total_cost INTEGER NOT NULL,
    purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 活动统计缓存
CREATE TABLE IF NOT EXISTS event_stats_cache (
    event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    participant_count INTEGER DEFAULT 0,
    completion_count INTEGER DEFAULT 0,
    total_rewards_distributed INTEGER DEFAULT 0,
    unique_users INTEGER DEFAULT 0,
    avg_completion_time_seconds INTEGER,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_event_participations_user ON event_participations(user_id);
CREATE INDEX IF NOT EXISTS idx_event_participations_event ON event_participations(event_id);
CREATE INDEX IF NOT EXISTS idx_event_spawns_event ON event_spawns(event_id);
CREATE INDEX IF NOT EXISTS idx_event_tasks_event ON event_tasks(event_id);
CREATE INDEX IF NOT EXISTS idx_user_event_tasks_user ON user_event_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_event_shops_event ON event_shops(event_id);
CREATE INDEX IF NOT EXISTS idx_event_shop_purchases_user ON event_shop_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_event_reward_claims_user ON event_reward_claims(user_id);

-- 插入默认活动类型配置
INSERT INTO event_types (type_key, name, description, config_schema, default_config) VALUES
('spawn_boost', '精灵刷新率提升', '提升特定精灵的出现率', 
 '{"type": "object", "properties": {"spawns": {"type": "array"}}}', 
 '{"spawns": []}'),
('shiny_boost', '闪光精灵活动', '提升闪光精灵出现概率', 
 '{"type": "object", "properties": {"shinyMultiplier": {"type": "number"}}}', 
 '{"shinyMultiplier": 10}'),
('double_xp', '双倍经验活动', '所有活动获得双倍经验', 
 '{"type": "object", "properties": {"xpMultiplier": {"type": "number"}}}', 
 '{"xpMultiplier": 2}'),
('double_stardust', '双倍星尘活动', '所有活动获得双倍星尘', 
 '{"type": "object", "properties": {"stardustMultiplier": {"type": "number"}}}', 
 '{"stardustMultiplier": 2}'),
('catch_challenge', '捕捉挑战活动', '捕捉目标精灵获得奖励', 
 '{"type": "object", "properties": {"targets": {"type": "array"}}}', 
 '{"targets": []}'),
('raid_boss', 'Raid Boss 活动', '限时 Boss 团队战', 
 '{"type": "object", "properties": {"bossId": {"type": "integer"}, "level": {"type": "integer"}}}', 
 '{"level": 5}'),
('holiday', '节日活动', '节日主题特殊活动', 
 '{"type": "object", "properties": {"theme": {"type": "string"}}}', 
 '{"theme": "default"}'),
('migration', '精灵迁徙活动', '地区限定精灵全球出现', 
 '{"type": "object", "properties": {"region": {"type": "string"}}}', 
 '{"region": "all"}'),
('catch_competition', '捕捉竞赛活动', '排行榜竞赛活动', 
 '{"type": "object", "properties": {"duration": {"type": "integer"}}}', 
 '{"duration": 7}')
ON CONFLICT (type_key) DO NOTHING;

-- 创建示例活动
INSERT INTO events (event_key, title, description, event_type, status, start_time, end_time, event_config, rewards) VALUES
('summer-festival-2026', '2026 夏日祭', '参加夏日祭活动，捕捉限定精灵，获取丰厚奖励！', 
 'holiday', 'active', 
 CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP + INTERVAL '6 days',
 '{"theme": "summer", "specialSpawns": [25, 26, 27]}',
 '[{"type": "pokemon", "speciesId": 25, "quantity": 1}, {"type": "stardust", "amount": 5000}]'),
('shiny-charmander-boost', '闪光小火龙活动', '闪光小火龙出现率提升 10 倍！',
 'shiny_boost', 'scheduled',
 CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP + INTERVAL '8 days',
 '{"shinyMultiplier": 10, "targetSpecies": [4]}',
 '[]')
ON CONFLICT (event_key) DO NOTHING;

-- 添加注释
COMMENT ON TABLE events IS '游戏活动主表';
COMMENT ON TABLE event_types IS '活动类型配置';
COMMENT ON TABLE event_participations IS '用户活动参与记录';
COMMENT ON TABLE event_reward_claims IS '活动奖励领取记录';
COMMENT ON TABLE event_spawns IS '活动精灵刷新配置';
COMMENT ON TABLE event_tasks IS '活动任务配置';
COMMENT ON TABLE user_event_tasks IS '用户活动任务完成记录';
COMMENT ON TABLE event_shops IS '活动商店配置';
COMMENT ON TABLE event_shop_purchases IS '活动商店购买记录';
COMMENT ON TABLE event_stats_cache IS '活动统计缓存';
