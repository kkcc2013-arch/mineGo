-- REQ-00102: 精灵昼夜循环系统
-- 实现昼夜时间管理与精灵生成差异化

-- ============================================================
-- 1. 昼夜时间配置表
-- ============================================================
CREATE TABLE IF NOT EXISTS day_night_config (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    start_hour SMALLINT NOT NULL CHECK (start_hour >= 0 AND start_hour < 24),
    end_hour SMALLINT NOT NULL CHECK (end_hour >= 0 AND end_hour < 24),
    display_name_zh VARCHAR(50) NOT NULL,
    display_name_en VARCHAR(50) NOT NULL,
    description TEXT,
    spawn_bonus_multiplier DECIMAL(4,2) DEFAULT 1.0,
    color_theme VARCHAR(20),
    icon_url VARCHAR(500),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 标准昼夜时间段
INSERT INTO day_night_config (name, start_hour, end_hour, display_name_zh, display_name_en, description, spawn_bonus_multiplier, color_theme) VALUES
('DAWN', 5, 7, '黎明', 'Dawn', '日出前的微光时刻，神秘精灵开始活跃', 1.2, '#FFB6C1'),
('MORNING', 7, 12, '上午', 'Morning', '阳光明媚的上午时段', 1.0, '#FFD700'),
('AFTERNOON', 12, 17, '下午', 'Afternoon', '温暖的午后时光', 1.0, '#FFA500'),
('EVENING', 17, 19, '黄昏', 'Evening', '夕阳西下，光线变化明显', 1.2, '#FF6347'),
('DUSK', 19, 21, '暮色', 'Dusk', '天色渐暗，夜行精灵开始出现', 1.3, '#9370DB'),
('NIGHT', 21, 24, '深夜', 'Night', '漆黑的夜晚，夜行精灵活跃高峰', 1.5, '#191970'),
('MIDNIGHT', 0, 5, '午夜', 'Midnight', '午夜时分，稀有夜行精灵出没', 1.4, '#0D0D2B')
ON CONFLICT (name) DO UPDATE SET
    start_hour = EXCLUDED.start_hour,
    end_hour = EXCLUDED.end_hour,
    display_name_zh = EXCLUDED.display_name_zh,
    display_name_en = EXCLUDED.display_name_en,
    spawn_bonus_multiplier = EXCLUDED.spawn_bonus_multiplier,
    color_theme = EXCLUDED.color_theme;

-- ============================================================
-- 2. 精灵昼夜出现时间表
-- ============================================================
CREATE TABLE IF NOT EXISTS pokemon_day_night_spawn (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    time_period VARCHAR(20) NOT NULL REFERENCES day_night_config(name),
    spawn_weight_multiplier DECIMAL(4,2) DEFAULT 1.0,
    is_exclusive BOOLEAN DEFAULT false,
    min_spawn_level SMALLINT DEFAULT 1,
    max_spawn_level SMALLINT DEFAULT 100,
    special_iv_bonus DECIMAL(3,2) DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(pokemon_id, time_period)
);

CREATE INDEX idx_pokemon_day_night_pokemon ON pokemon_day_night_spawn(pokemon_id);
CREATE INDEX idx_pokemon_day_night_period ON pokemon_day_night_spawn(time_period);
CREATE INDEX idx_pokemon_day_night_exclusive ON pokemon_day_night_spawn(is_exclusive);

-- ============================================================
-- 3. 精灵时间偏好标签（扩展 pokemon_species）
-- ============================================================
ALTER TABLE pokemon_species ADD COLUMN IF NOT EXISTS time_preference VARCHAR(20) DEFAULT 'ANY';
ALTER TABLE pokemon_species ADD COLUMN IF NOT EXISTS is_nocturnal BOOLEAN DEFAULT false;
ALTER TABLE pokemon_species ADD COLUMN IF NOT EXISTS is_diurnal BOOLEAN DEFAULT false;

COMMENT ON COLUMN pokemon_species.time_preference IS '精灵出现时间偏好：ANY/DAWN/DAY/DUSK/NIGHT';
COMMENT ON COLUMN pokemon_species.is_nocturnal IS '是否为夜行精灵（夜间活跃度更高）';
COMMENT ON COLUMN pokemon_species.is_diurnal IS '是否为昼行精灵（白天活跃度更高）';

-- ============================================================
-- 4. 批量插入精灵昼夜配置数据
-- ============================================================

-- 夜行精灵（夜间专属或高权重）
INSERT INTO pokemon_day_night_spawn (pokemon_id, time_period, spawn_weight_multiplier, is_exclusive, special_iv_bonus) VALUES
-- 幽灵系精灵（夜间专属）
(92, 'NIGHT', 3.0, false, 0.1),  -- 鬼斯
(93, 'NIGHT', 3.0, false, 0.1),  -- 鬼斯通
(94, 'NIGHT', 3.5, false, 0.15), -- 耿鬼
(200, 'NIGHT', 2.5, false, 0.1), -- 梦妖
(353, 'NIGHT', 2.5, false, 0.1), -- 怨影娃娃
(355, 'NIGHT', 2.5, false, 0.1), -- 哭哭面具

-- 夜行精灵（夜间高活跃）
(16, 'NIGHT', 2.0, false, 0),    -- 波波（夜间减少）
(19, 'NIGHT', 1.5, false, 0),    -- 小拉达（夜行）
(163, 'NIGHT', 2.0, false, 0.05), -- 咕咕
(198, 'NIGHT', 2.5, false, 0.1), -- 黑暗鸦
(261, 'NIGHT', 2.0, false, 0),   -- 大狼犬

-- 昼行精灵（白天高活跃）
(10, 'MORNING', 1.5, false, 0),  -- 绿毛虫
(11, 'MORNING', 1.3, false, 0),  -- 铁甲蛹
(12, 'MORNING', 1.8, false, 0),  -- 巴大蝶（白天蝴蝶）
(13, 'MORNING', 1.5, false, 0),  -- 独角虫
(14, 'MORNING', 1.3, false, 0),  -- 铁壳蛹
(15, 'MORNING', 1.8, false, 0),  -- 大针蜂

-- 黎明专属精灵
(35, 'DAWN', 2.5, false, 0.15),  -- 皮皮（黎明仙子）
(39, 'DAWN', 2.0, false, 0.1),   -- 胖丁（晨歌）
(40, 'DAWN', 2.2, false, 0.12),  -- 胖可丁

-- 黄昏专属精灵
(183, 'DUSK', 2.0, false, 0.1),  -- 玛力露
(184, 'DUSK', 2.2, false, 0.12), -- 玛力露丽
(283, 'DUSK', 2.5, false, 0.15), -- 溜溜糖球（黄昏水面）
(284, 'DUSK', 2.5, false, 0.15)  -- 雨翅蛾
ON CONFLICT (pokemon_id, time_period) DO UPDATE SET
    spawn_weight_multiplier = EXCLUDED.spawn_weight_multiplier,
    is_exclusive = EXCLUDED.is_exclusive,
    special_iv_bonus = EXCLUDED.special_iv_bonus;

-- 更新精灵时间偏好
UPDATE pokemon_species SET time_preference = 'NIGHT', is_nocturnal = true WHERE id IN (92, 93, 94, 198, 200, 261, 353, 355);
UPDATE pokemon_species SET time_preference = 'DAY', is_diurnal = true WHERE id IN (10, 11, 12, 13, 14, 15, 16);
UPDATE pokemon_species SET time_preference = 'DAWN' WHERE id IN (35, 39, 40);
UPDATE pokemon_species SET time_preference = 'DUSK' WHERE id IN (183, 184, 283, 284);

-- ============================================================
-- 5. 昼夜精灵生成统计表
-- ============================================================
CREATE TABLE IF NOT EXISTS day_night_spawn_statistics (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    time_period VARCHAR(20) NOT NULL,
    total_spawns INTEGER DEFAULT 0,
    unique_species INTEGER DEFAULT 0,
    rare_spawns INTEGER DEFAULT 0,
    shiny_spawns INTEGER DEFAULT 0,
    average_iv DECIMAL(5,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(date, time_period)
);

CREATE INDEX idx_day_night_stats_date ON day_night_spawn_statistics(date);
CREATE INDEX idx_day_night_stats_period ON day_night_spawn_statistics(time_period);

-- ============================================================
-- 6. 游戏时间同步表
-- ============================================================
CREATE TABLE IF NOT EXISTS game_time_state (
    id SERIAL PRIMARY KEY,
    timezone_offset_minutes SMALLINT DEFAULT 0,
    is_manual_override BOOLEAN DEFAULT false,
    manual_time_period VARCHAR(20),
    manual_hour SMALLINT,
    sunrise_hour SMALLINT DEFAULT 6,
    sunset_hour SMALLINT DEFAULT 19,
    last_calculated_at TIMESTAMP,
    current_period VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 插入默认配置
INSERT INTO game_time_state (id, last_calculated_at, current_period) 
VALUES (1, NOW(), 'MORNING')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 7. 触发器：自动更新时间戳
-- ============================================================
CREATE OR REPLACE FUNCTION update_day_night_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_day_night_config_updated_at
    BEFORE UPDATE ON day_night_config
    FOR EACH ROW
    EXECUTE FUNCTION update_day_night_updated_at();

CREATE TRIGGER update_pokemon_day_night_updated_at
    BEFORE UPDATE ON pokemon_day_night_spawn
    FOR EACH ROW
    EXECUTE FUNCTION update_day_night_updated_at();

CREATE TRIGGER update_day_night_spawn_statistics_updated_at
    BEFORE UPDATE ON day_night_spawn_statistics
    FOR EACH ROW
    EXECUTE FUNCTION update_day_night_updated_at();

-- ============================================================
-- 8. 视图：当前时间段的精灵配置
-- ============================================================
CREATE OR REPLACE VIEW current_time_spawn_config AS
SELECT 
    pdns.pokemon_id,
    ps.name_zh,
    ps.name_en,
    ps.type1,
    ps.type2,
    ps.rarity,
    pdns.time_period,
    pdns.spawn_weight_multiplier,
    pdns.is_exclusive,
    pdns.special_iv_bonus,
    dnc.display_name_zh as period_name,
    dnc.spawn_bonus_multiplier as period_bonus
FROM pokemon_day_night_spawn pdns
JOIN pokemon_species ps ON ps.id = pdns.pokemon_id
JOIN day_night_config dnc ON dnc.name = pdns.time_period;

-- ============================================================
-- 9. 函数：获取当前游戏时间
-- ============================================================
CREATE OR REPLACE FUNCTION get_current_game_time(
    p_timezone_offset_minutes INTEGER DEFAULT 0
)
RETURNS TABLE (
    current_hour SMALLINT,
    current_period VARCHAR(20),
    period_display_zh VARCHAR(50),
    period_display_en VARCHAR(50),
    spawn_bonus_multiplier DECIMAL(4,2),
    color_theme VARCHAR(20),
    next_change_hours SMALLINT
) AS $$
DECLARE
    v_current_hour SMALLINT;
    v_current_period VARCHAR(20);
BEGIN
    -- 计算当前小时（考虑时区偏移）
    v_current_hour := EXTRACT(HOUR FROM (NOW() + (p_timezone_offset_minutes || ' minutes')::INTERVAL))::SMALLINT;
    
    -- 根据小时确定时间段
    SELECT dnc.name INTO v_current_period
    FROM day_night_config dnc
    WHERE dnc.is_active = true
      AND (
          (dnc.start_hour <= dnc.end_hour 
           AND v_current_hour >= dnc.start_hour 
           AND v_current_hour < dnc.end_hour)
          OR
          (dnc.start_hour > dnc.end_hour 
           AND (v_current_hour >= dnc.start_hour OR v_current_hour < dnc.end_hour))
      )
    ORDER BY dnc.id
    LIMIT 1;
    
    RETURN QUERY
    SELECT 
        v_current_hour,
        dnc.name,
        dnc.display_name_zh,
        dnc.display_name_en,
        dnc.spawn_bonus_multiplier,
        dnc.color_theme,
        CASE 
            WHEN dnc.end_hour > dnc.start_hour THEN dnc.end_hour - v_current_hour
            ELSE (24 - v_current_hour + dnc.end_hour) % 24
        END::SMALLINT as next_change_hours
    FROM day_night_config dnc
    WHERE dnc.name = v_current_period;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_current_game_time IS '获取当前游戏时间，根据时区偏移计算时间段';

-- ============================================================
-- 10. 函数：获取当前时间的精灵生成权重
-- ============================================================
CREATE OR REPLACE FUNCTION get_pokemon_spawn_weight_for_time(
    p_pokemon_id INTEGER,
    p_time_period VARCHAR(20)
)
RETURNS DECIMAL(4,2) AS $$
DECLARE
    v_weight DECIMAL(4,2);
BEGIN
    SELECT COALESCE(pdns.spawn_weight_multiplier, 1.0) INTO v_weight
    FROM pokemon_day_night_spawn pdns
    WHERE pdns.pokemon_id = p_pokemon_id
      AND pdns.time_period = p_time_period;
    
    RETURN COALESCE(v_weight, 1.0);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_pokemon_spawn_weight_for_time IS '获取指定精灵在特定时间段的生成权重';

-- ============================================================
-- 11. 扩展 wild_pokemon 表支持时间段
-- ============================================================
ALTER TABLE wild_pokemon ADD COLUMN IF NOT EXISTS time_period VARCHAR(20);
ALTER TABLE wild_pokemon ADD COLUMN IF NOT EXISTS day_night_bonus DECIMAL(4,2) DEFAULT 1.0;

CREATE INDEX IF NOT EXISTS idx_wild_pokemon_time_period ON wild_pokemon(time_period);

COMMENT ON COLUMN wild_pokemon.time_period IS '生成时的时间段（REQ-00102）';
COMMENT ON COLUMN wild_pokemon.day_night_bonus IS '昼夜加成倍率（REQ-00102）';