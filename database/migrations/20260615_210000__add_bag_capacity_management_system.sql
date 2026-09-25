-- REQ-00110: 精灵背包容量管理与扩展系统
-- 创建时间: 2026-06-15 21:10
-- 描述: 实现完整的精灵背包容量管理，包括初始容量、扩展机制、整理排序、预警通知

-- ═══════════════════════════════════════════════════════════
-- 1. 背包容量配置表
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bag_capacity_config (
    id SERIAL PRIMARY KEY,
    player_level_min INT NOT NULL DEFAULT 1,
    player_level_max INT,
    base_capacity INT NOT NULL DEFAULT 300,
    max_capacity INT NOT NULL DEFAULT 3000,
    expansion_unit INT NOT NULL DEFAULT 50,
    gold_cost_per_unit INT NOT NULL DEFAULT 200,
    diamond_cost_per_unit INT NOT NULL DEFAULT 100,
    vip_bonus_capacity JSONB DEFAULT '{"1": 50, "2": 100, "3": 150, "4": 200, "5": 300}',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS player_level_min INT DEFAULT 1;
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS player_level_max INT;
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS base_capacity INT DEFAULT 300;
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS max_capacity INT DEFAULT 3000;
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS expansion_unit INT DEFAULT 50;
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS gold_cost_per_unit INT DEFAULT 200;
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS diamond_cost_per_unit INT DEFAULT 100;
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS vip_bonus_capacity JSONB DEFAULT '{"1": 50, "2": 100, "3": 150, "4": 200, "5": 300}';
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE bag_capacity_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.bag_capacity_config') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('player_level_min', 'player_level_max', 'base_capacity', 'max_capacity', 'expansion_unit', 'gold_cost_per_unit', 'diamond_cost_per_unit', 'vip_bonus_capacity', 'is_active', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE bag_capacity_config ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 插入默认配置
INSERT INTO bag_capacity_config 
    (player_level_min, player_level_max, base_capacity, gold_cost_per_unit, diamond_cost_per_unit)
VALUES 
    (1, 10, 300, 200, 100),
    (11, 20, 350, 250, 120),
    (21, 30, 400, 300, 150),
    (31, 40, 450, 350, 180),
    (41, NULL, 500, 400, 200)
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- 2. 玩家背包容量表
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS player_bag_capacity (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE,
    current_capacity INT NOT NULL DEFAULT 300,
    max_ever_purchased INT NOT NULL DEFAULT 0,
    used_slots INT NOT NULL DEFAULT 0,
    bonus_capacity INT NOT NULL DEFAULT 0,
    last_capacity_check TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE player_bag_capacity ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE player_bag_capacity ADD COLUMN IF NOT EXISTS current_capacity INT DEFAULT 300;
ALTER TABLE player_bag_capacity ADD COLUMN IF NOT EXISTS max_ever_purchased INT DEFAULT 0;
ALTER TABLE player_bag_capacity ADD COLUMN IF NOT EXISTS used_slots INT DEFAULT 0;
ALTER TABLE player_bag_capacity ADD COLUMN IF NOT EXISTS bonus_capacity INT DEFAULT 0;
ALTER TABLE player_bag_capacity ADD COLUMN IF NOT EXISTS last_capacity_check TIMESTAMP DEFAULT NOW();
ALTER TABLE player_bag_capacity ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE player_bag_capacity ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.player_bag_capacity') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('user_id', 'current_capacity', 'max_ever_purchased', 'used_slots', 'bonus_capacity', 'last_capacity_check', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE player_bag_capacity ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_player_bag_capacity_user ON player_bag_capacity(user_id);
CREATE INDEX IF NOT EXISTS idx_player_bag_capacity_check ON player_bag_capacity(last_capacity_check);

-- ═══════════════════════════════════════════════════════════
-- 3. 背包扩展历史表
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bag_expansion_history (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    expansion_type VARCHAR(20) NOT NULL CHECK (expansion_type IN ('gold', 'diamond', 'item', 'vip', 'event', 'system')),
    units INT NOT NULL,
    capacity_before INT NOT NULL,
    capacity_after INT NOT NULL,
    cost_amount INT NOT NULL,
    cost_currency VARCHAR(20) NOT NULL,
    transaction_id VARCHAR(100),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE bag_expansion_history ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE bag_expansion_history ADD COLUMN IF NOT EXISTS expansion_type VARCHAR(20);
ALTER TABLE bag_expansion_history ADD COLUMN IF NOT EXISTS units INT;
ALTER TABLE bag_expansion_history ADD COLUMN IF NOT EXISTS capacity_before INT;
ALTER TABLE bag_expansion_history ADD COLUMN IF NOT EXISTS capacity_after INT;
ALTER TABLE bag_expansion_history ADD COLUMN IF NOT EXISTS cost_amount INT;
ALTER TABLE bag_expansion_history ADD COLUMN IF NOT EXISTS cost_currency VARCHAR(20);
ALTER TABLE bag_expansion_history ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100);
ALTER TABLE bag_expansion_history ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE bag_expansion_history ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.bag_expansion_history') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('user_id', 'expansion_type', 'units', 'capacity_before', 'capacity_after', 'cost_amount', 'cost_currency', 'transaction_id', 'metadata', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE bag_expansion_history ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_bag_expansion_history_user ON bag_expansion_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bag_expansion_history_type ON bag_expansion_history(expansion_type, created_at DESC);

-- ═══════════════════════════════════════════════════════════
-- 4. 背包预警配置表
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bag_alert_config (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE,
    enable_alert BOOLEAN DEFAULT TRUE,
    alert_thresholds INT[] DEFAULT '{85, 90, 95, 99}',
    auto_transfer_to_storage BOOLEAN DEFAULT FALSE,
    auto_transfer_threshold INT DEFAULT 95,
    notification_method VARCHAR(20) DEFAULT 'push' CHECK (notification_method IN ('push', 'email', 'both', 'none')),
    last_alert_sent TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE bag_alert_config ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE bag_alert_config ADD COLUMN IF NOT EXISTS enable_alert BOOLEAN DEFAULT TRUE;
ALTER TABLE bag_alert_config ADD COLUMN IF NOT EXISTS alert_thresholds INT[] DEFAULT '{85, 90, 95, 99}';
ALTER TABLE bag_alert_config ADD COLUMN IF NOT EXISTS auto_transfer_to_storage BOOLEAN DEFAULT FALSE;
ALTER TABLE bag_alert_config ADD COLUMN IF NOT EXISTS auto_transfer_threshold INT DEFAULT 95;
ALTER TABLE bag_alert_config ADD COLUMN IF NOT EXISTS notification_method VARCHAR(20) DEFAULT 'push';
ALTER TABLE bag_alert_config ADD COLUMN IF NOT EXISTS last_alert_sent TIMESTAMP;
ALTER TABLE bag_alert_config ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE bag_alert_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.bag_alert_config') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('user_id', 'enable_alert', 'alert_thresholds', 'auto_transfer_to_storage', 'auto_transfer_threshold', 'notification_method', 'last_alert_sent', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE bag_alert_config ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_bag_alert_config_user ON bag_alert_config(user_id);
CREATE INDEX IF NOT EXISTS idx_bag_alert_config_enabled ON bag_alert_config(enable_alert) WHERE enable_alert = TRUE;

-- ═══════════════════════════════════════════════════════════
-- 5. 扩展 pokemon 表 - 添加收藏标记字段
-- ═══════════════════════════════════════════════════════════

ALTER TABLE pokemon_instances 
ADD COLUMN IF NOT EXISTS is_favorited BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS favorite_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS bag_sort_order INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS storage_status VARCHAR(20) DEFAULT 'bag' CHECK (storage_status IN ('bag', 'storage', 'transfer')),
-- 放生标记：下方背包计数触发器与 bagCapacityService 依赖（原迁移引用但未创建，导致每次捕捉入库都失败）
ADD COLUMN IF NOT EXISTS is_released BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS released_at TIMESTAMP;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_pokemon_bag_sort ON pokemon_instances(user_id, bag_sort_order);
CREATE INDEX IF NOT EXISTS idx_pokemon_favorited ON pokemon_instances(user_id, is_favorited) WHERE is_favorited = TRUE;
CREATE INDEX IF NOT EXISTS idx_pokemon_storage_status ON pokemon_instances(user_id, storage_status);

-- ═══════════════════════════════════════════════════════════
-- 6. 触发器：自动更新 updated_at
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_player_bag_capacity_updated_at ON player_bag_capacity;
CREATE TRIGGER update_player_bag_capacity_updated_at
    BEFORE UPDATE ON player_bag_capacity
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bag_alert_config_updated_at ON bag_alert_config;
CREATE TRIGGER update_bag_alert_config_updated_at
    BEFORE UPDATE ON bag_alert_config
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ═══════════════════════════════════════════════════════════
-- 7. 触发器：自动更新背包使用量
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_bag_used_slots()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.is_released = FALSE AND NEW.storage_status = 'bag' THEN
        UPDATE player_bag_capacity 
        SET used_slots = used_slots + 1, updated_at = NOW()
        WHERE user_id = NEW.user_id;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.is_released = FALSE AND NEW.is_released = TRUE THEN
            -- 释放精灵
            UPDATE player_bag_capacity 
            SET used_slots = GREATEST(used_slots - 1, 0), updated_at = NOW()
            WHERE user_id = NEW.user_id;
        ELSIF OLD.storage_status = 'bag' AND NEW.storage_status = 'storage' THEN
            -- 移入仓库
            UPDATE player_bag_capacity 
            SET used_slots = GREATEST(used_slots - 1, 0), updated_at = NOW()
            WHERE user_id = NEW.user_id;
        ELSIF OLD.storage_status = 'storage' AND NEW.storage_status = 'bag' THEN
            -- 从仓库移回背包
            UPDATE player_bag_capacity 
            SET used_slots = used_slots + 1, updated_at = NOW()
            WHERE user_id = NEW.user_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_bag_used_slots_trigger ON pokemon_instances;
CREATE TRIGGER update_bag_used_slots_trigger
    AFTER INSERT OR UPDATE ON pokemon_instances
    FOR EACH ROW
    EXECUTE FUNCTION update_bag_used_slots();

-- ═══════════════════════════════════════════════════════════
-- 8. 注释
-- ═══════════════════════════════════════════════════════════

COMMENT ON TABLE bag_capacity_config IS '背包容量配置表 - 定义不同等级的容量基准和扩展成本';
COMMENT ON TABLE player_bag_capacity IS '玩家背包容量表 - 记录每个玩家的背包容量状态';
COMMENT ON TABLE bag_expansion_history IS '背包扩展历史表 - 记录所有容量扩展操作';
COMMENT ON TABLE bag_alert_config IS '背包预警配置表 - 玩家的容量预警设置';
