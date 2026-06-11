-- database/pending/20260609_233000__add_spawn_management_system.sql
-- REQ-00069: 精灵资源管理系统与动态刷新控制

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
CREATE INDEX IF NOT EXISTS idx_spawn_pools_pokemon ON spawn_pools(pokemon_id);

COMMENT ON TABLE spawn_pools IS '精灵池配置表，定义各生物群系的精灵分布';

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
  UNIQUE(geohash, date, hour)
);

CREATE INDEX IF NOT EXISTS idx_spawn_statistics_geohash_date ON spawn_statistics(geohash, date);
CREATE INDEX IF NOT EXISTS idx_spawn_statistics_date ON spawn_statistics(date);

COMMENT ON TABLE spawn_statistics IS '刷新统计表，记录历史刷新数据用于分析';

-- 运营操作日志表
CREATE TABLE IF NOT EXISTS spawn_admin_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  action VARCHAR(50) NOT NULL, -- create_event, update_config, manual_spawn, update_pool
  target_type VARCHAR(50), -- cell, event, pool, pokemon
  target_id VARCHAR(100),
  changes JSONB,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spawn_admin_logs_admin ON spawn_admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_spawn_admin_logs_created ON spawn_admin_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_spawn_admin_logs_action ON spawn_admin_logs(action);

COMMENT ON TABLE spawn_admin_logs IS '运营操作日志表，记录管理员对刷新系统的修改';

-- 热力图统计表（持久化）
CREATE TABLE IF NOT EXISTS heatmap_statistics (
  id SERIAL PRIMARY KEY,
  geohash VARCHAR(12) NOT NULL,
  date DATE NOT NULL,
  hour INTEGER NOT NULL CHECK (hour >= 0 AND hour < 24),
  avg_active_players DECIMAL(5,2) DEFAULT 0,
  peak_players INTEGER DEFAULT 0,
  total_movements INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(geohash, date, hour)
);

CREATE INDEX IF NOT EXISTS idx_heatmap_statistics_geohash_date ON heatmap_statistics(geohash, date);
CREATE INDEX IF NOT EXISTS idx_heatmap_statistics_date ON heatmap_statistics(date);

COMMENT ON TABLE heatmap_statistics IS '热力图统计表，持久化玩家活动数据';

-- 插入默认精灵池数据（示例）
INSERT INTO spawn_pools (biome, pokemon_id, weight, min_level, max_level) VALUES
-- 草地生物群系
('grass', 1, 10.0, 1, 30),   -- 妙蛙种子
('grass', 2, 8.0, 16, 30),   -- 妙蛙草
('grass', 3, 5.0, 32, 50),   -- 妙蛙花
('grass', 16, 15.0, 1, 20),  -- 绿毛虫
('grass', 17, 12.0, 7, 25),  -- 铁甲蛹
('grass', 18, 3.0, 10, 35),  -- 巴大蝶
('grass', 19, 12.0, 1, 25),  -- 小拉达
('grass', 20, 8.0, 20, 40),  -- 拉达
('grass', 25, 3.0, 5, 35),   -- 皮卡丘（稀有）
('grass', 43, 8.0, 1, 30),   -- 走路草
('grass', 63, 6.0, 1, 25),   -- 凯西
ON CONFLICT (biome, pokemon_id) DO NOTHING;

-- 水域生物群系
INSERT INTO spawn_pools (biome, pokemon_id, weight, min_level, max_level) VALUES
('water', 7, 8.0, 1, 30),    -- 杰尼龟
('water', 8, 6.0, 16, 35),   -- 卡咪龟
('water', 9, 4.0, 36, 55),   -- 水箭龟
('water', 54, 12.0, 1, 35),  -- 哥达鸭
('water', 60, 10.0, 1, 30),  -- 蚊香蝌蚪
('water', 61, 8.0, 25, 45),  -- 蚊香君
('water', 72, 7.0, 1, 30),   -- 玛瑙水母
('water', 73, 5.0, 30, 50),  -- 毒刺水母
('water', 86, 5.0, 1, 35),   -- 小海狮
('water', 98, 4.0, 1, 30),   -- 大钳蟹
ON CONFLICT (biome, pokemon_id) DO NOTHING;

-- 城市生物群系
INSERT INTO spawn_pools (biome, pokemon_id, weight, min_level, max_level) VALUES
('urban', 52, 15.0, 1, 35),  -- 喵喵
('urban', 53, 8.0, 28, 45),  -- 猫老大
('urban', 63, 10.0, 1, 25),  -- 凯西
('urban', 64, 6.0, 16, 35),  -- 勇基拉
('urban', 92, 8.0, 1, 30),   -- 鬼斯
('urban', 93, 5.0, 25, 40),  -- 鬼斯通
('urban', 109, 6.0, 1, 30),  -- 瓦斯弹
('urban', 133, 2.0, 5, 40),  -- 伊布（稀有）
ON CONFLICT (biome, pokemon_id) DO NOTHING;

-- 森林生物群系
INSERT INTO spawn_pools (biome, pokemon_id, weight, min_level, max_level) VALUES
('forest', 10, 10.0, 1, 20), -- 绿毛虫
('forest', 11, 8.0, 7, 25),  -- 铁甲蛹
('forest', 12, 5.0, 10, 35), -- 巴大蝶
('forest', 13, 10.0, 1, 20), -- 独角虫
('forest', 14, 8.0, 7, 25),  -- 铁壳昆
('forest', 15, 5.0, 10, 35), -- 大针蜂
('forest', 25, 5.0, 3, 40),  -- 皮卡丘
('forest', 69, 12.0, 1, 30), -- 喇叭芽
('forest', 70, 8.0, 21, 40), -- 口呆花
('forest', 123, 1.5, 15, 50), -- 飞天螳螂（稀有）
ON CONFLICT (biome, pokemon_id) DO NOTHING;

-- 山地生物群系
INSERT INTO spawn_pools (biome, pokemon_id, weight, min_level, max_level) VALUES
('mountain', 66, 8.0, 1, 35),  -- 腕力
('mountain', 67, 5.0, 28, 50), -- 豪力
('mountain', 74, 10.0, 1, 30), -- 小拳石
('mountain', 75, 7.0, 25, 45), -- 隆隆石
('mountain', 95, 3.0, 10, 55), -- 大岩蛇（稀有）
('mountain', 111, 5.0, 1, 40), -- 铁甲犀牛
('mountain', 126, 1.0, 20, 50), -- 鸭嘴火兽（稀有）
ON CONFLICT (biome, pokemon_id) DO NOTHING;

-- 洞穴生物群系
INSERT INTO spawn_pools (biome, pokemon_id, weight, min_level, max_level) VALUES
('cave', 41, 12.0, 1, 35),   -- 超音蝠
('cave', 42, 8.0, 22, 45),   -- 大嘴蝠
('cave', 46, 8.0, 1, 30),    -- 派拉斯
('cave', 47, 4.0, 24, 40),   -- 派拉斯特
('cave', 66, 6.0, 1, 35),    -- 腕力
('cave', 74, 10.0, 1, 30),   -- 小拳石
('cave', 88, 4.0, 1, 35),    -- 臭泥
('cave', 89, 2.5, 38, 50),   -- 臭臭泥
ON CONFLICT (biome, pokemon_id) DO NOTHING;

-- 插入默认区域配置（示例热门区域）
INSERT INTO spawn_cell_configs (geohash, base_spawn_count, min_spawn, max_spawn) VALUES
('wm4ez', 5, 3, 12),  -- 示例城市中心区域
('wm4ey', 4, 2, 10),  -- 示例公园区域
('wm4ex', 3, 2, 8)    -- 示例郊区区域
ON CONFLICT (geohash) DO NOTHING;

-- 插入示例活动
INSERT INTO spawn_events (name, type, start_time, end_time, spawn_multiplier, featured_pokemon) VALUES
('皮卡丘社区日', 'community_day', 
 NOW() + INTERVAL '7 days', 
 NOW() + INTERVAL '7 days 6 hours',
 2.0, 
 ARRAY[25])
ON CONFLICT DO NOTHING;

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_spawn_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER spawn_cell_configs_updated_at
BEFORE UPDATE ON spawn_cell_configs
FOR EACH ROW EXECUTE FUNCTION update_spawn_updated_at();

CREATE TRIGGER spawn_events_updated_at
BEFORE UPDATE ON spawn_events
FOR EACH ROW EXECUTE FUNCTION update_spawn_updated_at();

-- 创建统计视图
CREATE OR REPLACE VIEW spawn_stats_summary AS
SELECT 
  geohash,
  COUNT(*) as total_hours,
  SUM(total_spawns) as total_spawns,
  AVG(avg_active_players) as avg_players,
  MAX(avg_active_players) as peak_players
FROM spawn_statistics
WHERE date >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY geohash
ORDER BY total_spawns DESC;

COMMENT ON VIEW spawn_stats_summary IS '刷新统计汇总视图（最近7天）';

-- 创建热力图视图
CREATE OR REPLACE VIEW heatmap_summary AS
SELECT 
  geohash,
  AVG(avg_active_players) as avg_active_players,
  MAX(peak_players) as peak_players,
  SUM(total_movements) as total_movements
FROM heatmap_statistics
WHERE date >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY geohash
ORDER BY avg_active_players DESC;

COMMENT ON VIEW heatmap_summary IS '热力图汇总视图（最近7天）';
