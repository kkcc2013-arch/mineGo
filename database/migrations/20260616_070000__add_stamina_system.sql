-- migrations/20260616_070000__add_stamina_system.sql
-- 精灵体力系统与疲劳度管理
-- REQ-00172

-- =====================================================
-- 1. 为 pokemon 表添加体力字段
-- =====================================================
ALTER TABLE pokemon_instances 
ADD COLUMN IF NOT EXISTS max_stamina INTEGER DEFAULT 100,
ADD COLUMN IF NOT EXISTS current_stamina INTEGER DEFAULT 100,
ADD COLUMN IF NOT EXISTS last_stamina_update TIMESTAMP DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS fatigue_level VARCHAR(20) DEFAULT 'fresh';

-- 添加注释
COMMENT ON COLUMN pokemon_instances.max_stamina IS '最大体力值';
COMMENT ON COLUMN pokemon_instances.current_stamina IS '当前体力值';
COMMENT ON COLUMN pokemon_instances.last_stamina_update IS '上次体力更新时间';
COMMENT ON COLUMN pokemon_instances.fatigue_level IS '疲劳等级: fresh/normal/tired/exhausted';

-- =====================================================
-- 2. 创建体力消耗配置表
-- =====================================================
CREATE TABLE IF NOT EXISTS stamina_config (
  id SERIAL PRIMARY KEY,
  activity_type VARCHAR(50) NOT NULL UNIQUE,
  stamina_cost INTEGER NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE stamina_config ADD COLUMN IF NOT EXISTS activity_type VARCHAR(50);
ALTER TABLE stamina_config ADD COLUMN IF NOT EXISTS stamina_cost INTEGER;
ALTER TABLE stamina_config ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE stamina_config ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE stamina_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- 插入默认配置
INSERT INTO stamina_config (activity_type, stamina_cost, description) VALUES
('battle_turn', 5, '每次战斗回合消耗'),
('gym_battle', 20, '道馆战斗消耗'),
('catch_attempt', 10, '捕捉尝试消耗'),
('training', 15, '训练消耗'),
('exploration', 2, '探索消耗'),
('pvp_battle', 25, 'PVP对战消耗'),
('team_battle', 30, '团队战斗消耗')
ON CONFLICT (activity_type) DO NOTHING;

-- =====================================================
-- 3. 创建体力恢复道具配置
-- =====================================================
CREATE TABLE IF NOT EXISTS stamina_recovery_items (
  id SERIAL PRIMARY KEY,
  item_name VARCHAR(100) NOT NULL,
  stamina_amount INTEGER NOT NULL,
  cooldown_seconds INTEGER DEFAULT 0,
  rarity VARCHAR(20) DEFAULT 'common',
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE stamina_recovery_items ADD COLUMN IF NOT EXISTS item_name VARCHAR(100);
ALTER TABLE stamina_recovery_items ADD COLUMN IF NOT EXISTS stamina_amount INTEGER;
ALTER TABLE stamina_recovery_items ADD COLUMN IF NOT EXISTS cooldown_seconds INTEGER DEFAULT 0;
ALTER TABLE stamina_recovery_items ADD COLUMN IF NOT EXISTS rarity VARCHAR(20) DEFAULT 'common';
ALTER TABLE stamina_recovery_items ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE stamina_recovery_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

-- 插入默认恢复道具
INSERT INTO stamina_recovery_items (item_name, stamina_amount, cooldown_seconds, rarity, description) VALUES
('体力药水(小)', 20, 0, 'common', '恢复20点体力'),
('体力药水(中)', 50, 0, 'uncommon', '恢复50点体力'),
('体力药水(大)', 100, 0, 'rare', '恢复100点体力'),
('能量饮料', 30, 300, 'common', '恢复30点体力，5分钟冷却'),
('精灵能量块', 80, 600, 'uncommon', '恢复80点体力，10分钟冷却'),
('神秘糖果', 150, 3600, 'epic', '恢复150点体力，1小时冷却')
ON CONFLICT DO NOTHING;

-- =====================================================
-- 4. 创建精灵休息站表
-- =====================================================
CREATE TABLE IF NOT EXISTS rest_stations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  location_geohash VARCHAR(12),
  recovery_rate INTEGER DEFAULT 5,
  capacity INTEGER DEFAULT 10,
  current_users INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  station_type VARCHAR(30) DEFAULT 'normal',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION;
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION;
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS location_geohash VARCHAR(12);
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS recovery_rate INTEGER DEFAULT 5;
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS capacity INTEGER DEFAULT 10;
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS current_users INTEGER DEFAULT 0;
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS station_type VARCHAR(30) DEFAULT 'normal';
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE rest_stations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- 创建空间索引（如果 PostGIS 可用）
CREATE INDEX IF NOT EXISTS idx_rest_stations_location ON rest_stations(location_geohash);
CREATE INDEX IF NOT EXISTS idx_rest_stations_active ON rest_stations(is_active);

-- 插入示例休息站
INSERT INTO rest_stations (name, description, location_lat, location_lng, location_geohash, recovery_rate, capacity, station_type) VALUES
('中心公园休息站', '位于城市中心的精灵休息区', 39.9042, 116.4074, 'wx4g0b', 5, 15, 'normal'),
('精灵中心', '提供快速恢复服务', 39.9142, 116.4174, 'wx4g0c', 10, 20, 'premium'),
('野外营地', '自然环境中恢复', 39.8842, 116.3974, 'wx4g09', 3, 8, 'basic')
ON CONFLICT DO NOTHING;

-- =====================================================
-- 5. 创建休息记录表
-- =====================================================
CREATE TABLE IF NOT EXISTS rest_records (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  pokemon_id UUID NOT NULL REFERENCES pokemon_instances(id),
  station_id INTEGER NOT NULL REFERENCES rest_stations(id),
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  stamina_recovered INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE rest_records ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE rest_records ADD COLUMN IF NOT EXISTS pokemon_id INTEGER;
ALTER TABLE rest_records ADD COLUMN IF NOT EXISTS station_id INTEGER;
ALTER TABLE rest_records ADD COLUMN IF NOT EXISTS started_at TIMESTAMP DEFAULT NOW();
ALTER TABLE rest_records ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP;
ALTER TABLE rest_records ADD COLUMN IF NOT EXISTS stamina_recovered INTEGER DEFAULT 0;
ALTER TABLE rest_records ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE rest_records ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_rest_records_user ON rest_records(user_id);
CREATE INDEX IF NOT EXISTS idx_rest_records_pokemon ON rest_records(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_rest_records_active ON rest_records(status, started_at);

-- =====================================================
-- 6. 创建体力使用历史记录表
-- =====================================================
CREATE TABLE IF NOT EXISTS stamina_history (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  pokemon_id UUID NOT NULL REFERENCES pokemon_instances(id),
  activity_type VARCHAR(50) NOT NULL,
  stamina_change INTEGER NOT NULL,
  stamina_before INTEGER,
  stamina_after INTEGER,
  source VARCHAR(30) DEFAULT 'activity',
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE stamina_history ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE stamina_history ADD COLUMN IF NOT EXISTS pokemon_id INTEGER;
ALTER TABLE stamina_history ADD COLUMN IF NOT EXISTS activity_type VARCHAR(50);
ALTER TABLE stamina_history ADD COLUMN IF NOT EXISTS stamina_change INTEGER;
ALTER TABLE stamina_history ADD COLUMN IF NOT EXISTS stamina_before INTEGER;
ALTER TABLE stamina_history ADD COLUMN IF NOT EXISTS stamina_after INTEGER;
ALTER TABLE stamina_history ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'activity';
ALTER TABLE stamina_history ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE stamina_history ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_stamina_history_user ON stamina_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stamina_history_pokemon ON stamina_history(pokemon_id, created_at DESC);

-- =====================================================
-- 7. 创建用户体力道具库存表
-- =====================================================
CREATE TABLE IF NOT EXISTS user_stamina_items (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  item_id INTEGER NOT NULL REFERENCES stamina_recovery_items(id),
  quantity INTEGER DEFAULT 0,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, item_id)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE user_stamina_items ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE user_stamina_items ADD COLUMN IF NOT EXISTS item_id INTEGER;
ALTER TABLE user_stamina_items ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 0;
ALTER TABLE user_stamina_items ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP;
ALTER TABLE user_stamina_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE user_stamina_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_user_stamina_items_user ON user_stamina_items(user_id);

-- =====================================================
-- 8. 创建索引优化查询
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_pokemon_stamina ON pokemon_instances(user_id, current_stamina);
CREATE INDEX IF NOT EXISTS idx_pokemon_stamina_update ON pokemon_instances(last_stamina_update);
CREATE INDEX IF NOT EXISTS idx_pokemon_fatigue ON pokemon_instances(fatigue_level);

-- =====================================================
-- 9. 创建触发器自动更新 updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_stamina_config_updated_at ON stamina_config;
CREATE TRIGGER update_stamina_config_updated_at 
    BEFORE UPDATE ON stamina_config 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_rest_stations_updated_at ON rest_stations;
CREATE TRIGGER update_rest_stations_updated_at 
    BEFORE UPDATE ON rest_stations 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_stamina_items_updated_at ON user_stamina_items;
CREATE TRIGGER update_user_stamina_items_updated_at 
    BEFORE UPDATE ON user_stamina_items 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 10. 授权（根据实际用户名调整）
-- =====================================================
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO minego_user;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO minego_user;
