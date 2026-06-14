-- Day-Night Cycle System Migration
-- REQ-00102: 精灵昼夜循环系统

BEGIN;

-- 时段定义表
CREATE TABLE IF NOT EXISTS time_periods (
    id VARCHAR(20) PRIMARY KEY,  -- dawn, day, dusk, night, late_night
    name_i18n JSONB NOT NULL,     -- {"en": "Dawn", "zh": "黎明", "ja": "夜明け"}
    start_hour SMALLINT NOT NULL, -- 0-23
    end_hour SMALLINT NOT NULL,   -- 0-23
    light_level DECIMAL(3,2) NOT NULL, -- 0.0-1.0 光照强度
    background_tint VARCHAR(7),   -- 十六进制颜色值
    atmosphere JSONB,             -- {"fog": 0.2, "stars": true}
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 精灵时段刷新配置表
CREATE TABLE IF NOT EXISTS pokemon_time_spawn_config (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL,
    time_period_id VARCHAR(20) NOT NULL REFERENCES time_periods(id),
    spawn_multiplier DECIMAL(4,2) DEFAULT 1.0, -- 出现倍率
    is_exclusive BOOLEAN DEFAULT FALSE,        -- 是否仅此时段出现
    active_months BIT(12),                     -- 月份限制（可选）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pokemon_id, time_period_id)
);

-- 属性时段加成表
CREATE TABLE IF NOT EXISTS type_time_bonus (
    id SERIAL PRIMARY KEY,
    pokemon_type VARCHAR(20) NOT NULL, -- fire, water, ghost, etc.
    time_period_id VARCHAR(20) NOT NULL REFERENCES time_periods(id),
    stat_bonus JSONB NOT NULL,         -- {"attack": 1.1, "defense": 1.05}
    experience_bonus DECIMAL(3,2) DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pokemon_type, time_period_id)
);

-- 时段特殊活动表
CREATE TABLE IF NOT EXISTS time_period_events (
    id SERIAL PRIMARY KEY,
    event_id INTEGER,
    time_period_id VARCHAR(20) NOT NULL REFERENCES time_periods(id),
    bonus_multiplier DECIMAL(4,2) DEFAULT 1.0,
    special_pokemon_ids INTEGER[],     -- 特殊精灵ID列表
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 玩家时段活动统计表
CREATE TABLE IF NOT EXISTS player_time_activity_stats (
    user_id INTEGER PRIMARY KEY,
    dawn_catches INTEGER DEFAULT 0,
    day_catches INTEGER DEFAULT 0,
    dusk_catches INTEGER DEFAULT 0,
    night_catches INTEGER DEFAULT 0,
    late_night_catches INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 初始时段数据
INSERT INTO time_periods (id, name_i18n, start_hour, end_hour, light_level, background_tint, atmosphere) VALUES
('dawn', '{"en": "Dawn", "zh": "黎明", "ja": "夜明け"}', 5, 7, 0.6, '#FFE4B5', '{"fog": 0.3}'),
('day', '{"en": "Day", "zh": "白天", "ja": "昼"}', 7, 17, 1.0, '#87CEEB', '{}'),
('dusk', '{"en": "Dusk", "zh": "黄昏", "ja": "夕暮れ"}', 17, 19, 0.5, '#FF8C00', '{"fog": 0.2, "sunset": true}'),
('night', '{"en": "Night", "zh": "夜晚", "ja": "夜"}', 19, 23, 0.2, '#191970', '{"stars": true, "moon": true}'),
('late_night', '{"en": "Late Night", "zh": "深夜", "ja": "深夜"}', 23, 5, 0.1, '#0C0C1E', '{"stars": true}')
ON CONFLICT (id) DO NOTHING;

-- 初始属性时段加成数据
INSERT INTO type_time_bonus (pokemon_type, time_period_id, stat_bonus, experience_bonus) VALUES
-- 火系：白天增强
('fire', 'day', '{"attack": 1.15, "defense": 1.1}', 1.2),
('fire', 'dusk', '{"attack": 1.1}', 1.1),
('fire', 'night', '{"attack": 0.9}', 0.9),

-- 水系：黄昏和夜晚增强
('water', 'dusk', '{"attack": 1.1, "defense": 1.15}', 1.15),
('water', 'night', '{"defense": 1.2}', 1.2),
('water', 'day', '{"attack": 0.95}', 0.95),

-- 幽灵系：夜晚大幅增强
('ghost', 'night', '{"attack": 1.25, "defense": 1.2, "speed": 1.15}', 1.5),
('ghost', 'late_night', '{"attack": 1.3, "defense": 1.25, "speed": 1.2}', 1.6),
('ghost', 'day', '{"attack": 0.85, "defense": 0.9}', 0.8),

-- 暗系：夜晚增强
('dark', 'night', '{"attack": 1.2, "speed": 1.1}', 1.3),
('dark', 'late_night', '{"attack": 1.25, "defense": 1.1}', 1.4),
('dark', 'day', '{"attack": 0.9}', 0.85),

-- 超能系：白天增强
('psychic', 'day', '{"attack": 1.15, "defense": 1.1}', 1.25),
('psychic', 'dawn', '{"attack": 1.2}', 1.3),
('psychic', 'night', '{"attack": 0.9}', 0.85),

-- 草系：白天增强
('grass', 'day', '{"attack": 1.1, "defense": 1.1}', 1.15),
('grass', 'dawn', '{"attack": 1.15}', 1.2),

-- 电系：白天增强
('electric', 'day', '{"attack": 1.15, "speed": 1.1}', 1.2),

-- 冰系：夜晚增强
('ice', 'night', '{"attack": 1.1, "defense": 1.15}', 1.2),
('ice', 'late_night', '{"defense": 1.2}', 1.25),

-- 妖精系：黎明增强
('fairy', 'dawn', '{"attack": 1.2, "defense": 1.15}', 1.3),
('fairy', 'day', '{"attack": 1.1}', 1.1)
ON CONFLICT (pokemon_type, time_period_id) DO NOTHING;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_pokemon_time_spawn ON pokemon_time_spawn_config(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_type_time_bonus ON type_time_bonus(pokemon_type, time_period_id);
CREATE INDEX IF NOT EXISTS idx_time_event ON time_period_events(time_period_id);
CREATE INDEX IF NOT EXISTS idx_player_time_activity ON player_time_activity_stats(user_id);

COMMIT;
