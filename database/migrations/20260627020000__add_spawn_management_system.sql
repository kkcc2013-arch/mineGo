-- ============================================================================
-- 精灵资源管理系统与动态刷新控制
-- REQ-00069
-- ============================================================================

-- 区域刷新配置表
CREATE TABLE IF NOT EXISTS spawn_cell_configs (
  id SERIAL PRIMARY KEY,
  geohash VARCHAR(12) UNIQUE NOT NULL,
  base_spawn_count INTEGER DEFAULT 3,
  min_spawn INTEGER DEFAULT 1,
  max_spawn INTEGER DEFAULT 10,
  spawn_pool_override TEXT, -- JSON: 覆盖默认精灵池
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spawn_cell_configs_geohash ON spawn_cell_configs(geohash);
CREATE INDEX IF NOT EXISTS idx_spawn_cell_configs_enabled ON spawn_cell_configs(enabled) WHERE enabled = true;

COMMENT ON TABLE spawn_cell_configs IS '区域刷新配置表，控制各区域的精灵刷新策略';
COMMENT ON COLUMN spawn_cell_configs.geohash IS '区域 Geohash 编码（精度 6，约 1.2km x 0.6km）';
COMMENT ON COLUMN spawn_cell_configs.base_spawn_count IS '基础刷新数量';
COMMENT ON COLUMN spawn_cell_configs.min_spawn IS '最小刷新数量';
COMMENT ON COLUMN spawn_cell_configs.max_spawn IS '最大刷新数量';
COMMENT ON COLUMN spawn_cell_configs.spawn_pool_override IS 'JSON 格式的精灵池覆盖配置';

-- 刷新事件表
CREATE TABLE IF NOT EXISTS spawn_events (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL, -- community_day, spotlight_hour, raid_hour, custom
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  affected_areas TEXT, -- JSON: geohash 列表或 null 表示全局
  spawn_multiplier DECIMAL(3,2) DEFAULT 1.0,
  featured_pokemon INTEGER[], -- 特色精灵 ID 列表
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spawn_events_time ON spawn_events(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_spawn_events_enabled ON spawn_events(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_spawn_events_type ON spawn_events(type);

COMMENT ON TABLE spawn_events IS '刷新事件表，管理特殊活动期间的刷新策略';
COMMENT ON COLUMN spawn_events.type IS '活动类型：community_day, spotlight_hour, raid_hour, custom';
COMMENT ON COLUMN spawn_events.affected_areas IS '受影响的区域 Geohash 列表（JSON 数组），null 表示全局';
COMMENT ON COLUMN spawn_events.spawn_multiplier IS '刷新倍率，例如 2.0 表示刷新数量翻倍';

-- 精灵池配置表
CREATE TABLE IF NOT EXISTS spawn_pools (
  id SERIAL PRIMARY KEY,
  biome VARCHAR(50) NOT NULL, -- grass, water, forest, urban, mountain, cave
  pokemon_id INTEGER NOT NULL,
  weight DECIMAL(5,4) DEFAULT 1.0, -- 刷新权重
  min_level INTEGER DEFAULT 1,
  max_level INTEGER DEFAULT 30,
  weather_boost JSONB, -- 天气加成配置
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(biome, pokemon_id)
);

CREATE INDEX IF NOT EXISTS idx_spawn_pools_biome ON spawn_pools(biome);
CREATE INDEX IF NOT EXISTS idx_spawn_pools_enabled ON spawn_pools(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_spawn_pools_weight ON spawn_pools(weight DESC);

COMMENT ON TABLE spawn_pools IS '精灵池配置表，定义各生物群系的精灵分布';
COMMENT ON COLUMN spawn_pools.biome IS '生物群系：grass, water, forest, urban, mountain, cave';
COMMENT ON COLUMN spawn_pools.weight IS '刷新权重，数值越高刷新概率越大';
COMMENT ON COLUMN spawn_pools.weather_boost IS '天气加成配置，JSON 格式';

-- 刷新统计表
CREATE TABLE IF NOT EXISTS spawn_statistics (
  id SERIAL PRIMARY KEY,
  geohash VARCHAR(12) NOT NULL,
  date DATE NOT NULL,
  hour INTEGER NOT NULL CHECK (hour >= 0 AND hour < 24),
  total_spawns INTEGER DEFAULT 0,
  spawns_by_rarity JSONB,
  captures INTEGER DEFAULT 0,
  despawns INTEGER DEFAULT 0,
  avg_active_players DECIMAL(5,2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(geohash, date, hour)
);

CREATE INDEX IF NOT EXISTS idx_spawn_statistics_geohash_date ON spawn_statistics(geohash, date);
CREATE INDEX IF NOT EXISTS idx_spawn_statistics_date ON spawn_statistics(date);
CREATE INDEX IF NOT EXISTS idx_spawn_statistics_hour ON spawn_statistics(hour);

COMMENT ON TABLE spawn_statistics IS '刷新统计表，记录历史刷新数据用于分析';
COMMENT ON COLUMN spawn_statistics.spawns_by_rarity IS '按稀有度分组的刷新数量，JSON 格式';

-- 运营操作日志表
CREATE TABLE IF NOT EXISTS spawn_admin_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  action VARCHAR(50) NOT NULL, -- create_event, update_config, manual_spawn
  target_type VARCHAR(50), -- cell, event, pool
  target_id VARCHAR(100),
  changes JSONB,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spawn_admin_logs_admin ON spawn_admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_spawn_admin_logs_created ON spawn_admin_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_spawn_admin_logs_action ON spawn_admin_logs(action);

COMMENT ON TABLE spawn_admin_logs IS '运营操作日志表，记录管理员对刷新系统的修改';
COMMENT ON COLUMN spawn_admin_logs.action IS '操作类型：create_event, update_event, update_config, update_pool, manual_spawn';
COMMENT ON COLUMN spawn_admin_logs.target_type IS '目标类型：cell, event, pool';
COMMENT ON COLUMN spawn_admin_logs.target_id IS '目标 ID';

-- 插入默认精灵池数据（示例）
INSERT INTO spawn_pools (biome, pokemon_id, weight) VALUES
-- 草地生物群系
('grass', 1, 10.0),   -- 妙蛙种子
('grass', 16, 15.0),  -- 绿毛虫
('grass', 19, 12.0),  -- 小拉达
('grass', 25, 3.0),   -- 皮卡丘（稀有）
('grass', 43, 8.0),   -- 走路草
('grass', 63, 6.0)    -- 凯西
ON CONFLICT (biome, pokemon_id) DO UPDATE SET weight = EXCLUDED.weight;

INSERT INTO spawn_pools (biome, pokemon_id, weight) VALUES
-- 水域生物群系
('water', 7, 8.0),    -- 杰尼龟
('water', 54, 12.0),  -- 哥达鸭
('water', 60, 10.0),  -- 蚊香蝌蚪
('water', 72, 7.0),   -- 玛瑙水母
('water', 86, 5.0),   -- 小海狮
('water', 98, 4.0)    -- 大钳蟹
ON CONFLICT (biome, pokemon_id) DO UPDATE SET weight = EXCLUDED.weight;

INSERT INTO spawn_pools (biome, pokemon_id, weight) VALUES
-- 城市生物群系
('urban', 52, 15.0),  -- 喵喵
('urban', 63, 10.0),  -- 凯西
('urban', 92, 8.0),   -- 鬼斯
('urban', 109, 6.0),  -- 瓦斯弹
('urban', 133, 2.0)   -- 伊布（稀有）
ON CONFLICT (biome, pokemon_id) DO UPDATE SET weight = EXCLUDED.weight;

INSERT INTO spawn_pools (biome, pokemon_id, weight) VALUES
-- 森林生物群系
('forest', 10, 10.0), -- 绿毛虫
('forest', 11, 8.0),  -- 铁甲蛹
('forest', 25, 5.0),  -- 皮卡丘
('forest', 69, 12.0), -- 喇叭芽
('forest', 123, 1.5)  -- 飞天螳螂（稀有）
ON CONFLICT (biome, pokemon_id) DO UPDATE SET weight = EXCLUDED.weight;

INSERT INTO spawn_pools (biome, pokemon_id, weight) VALUES
-- 山地生物群系
('mountain', 66, 8.0),  -- 腕力
('mountain', 74, 10.0), -- 小拳石
('mountain', 95, 3.0),  -- 大岩蛇（稀有）
('mountain', 111, 5.0), -- 铁甲犀牛
('mountain', 126, 1.0)  -- 鸭嘴火兽（稀有）
ON CONFLICT (biome, pokemon_id) DO UPDATE SET weight = EXCLUDED.weight;

INSERT INTO spawn_pools (biome, pokemon_id, weight) VALUES
-- 洞穴生物群系
('cave', 41, 12.0),   -- 超音蝠
('cave', 46, 8.0),    -- 派拉斯
('cave', 66, 6.0),    -- 腕力
('cave', 74, 10.0),   -- 小拳石
('cave', 88, 4.0)     -- 臭泥
ON CONFLICT (biome, pokemon_id) DO UPDATE SET weight = EXCLUDED.weight;

-- 插入默认区域配置（示例热门区域）
INSERT INTO spawn_cell_configs (geohash, base_spawn_count, min_spawn, max_spawn) VALUES
('wm4ez', 5, 3, 12),  -- 示例城市中心区域
('wm4ey', 4, 2, 10),  -- 示例公园区域
('wm4ex', 3, 2, 8)    -- 示例郊区区域
ON CONFLICT (geohash) DO UPDATE SET
  base_spawn_count = EXCLUDED.base_spawn_count,
  min_spawn = EXCLUDED.min_spawn,
  max_spawn = EXCLUDED.max_spawn;

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_spawn_cell_configs_updated_at
    BEFORE UPDATE ON spawn_cell_configs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_spawn_events_updated_at
    BEFORE UPDATE ON spawn_events
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_spawn_statistics_updated_at
    BEFORE UPDATE ON spawn_statistics
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
