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
    user_id BIGINT NOT NULL UNIQUE,
    current_capacity INT NOT NULL DEFAULT 300,
    max_ever_purchased INT NOT NULL DEFAULT 0,
    used_slots INT NOT NULL DEFAULT 0,
    bonus_capacity INT NOT NULL DEFAULT 0,
    last_capacity_check TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_bag_capacity_user ON player_bag_capacity(user_id);
CREATE INDEX IF NOT EXISTS idx_player_bag_capacity_check ON player_bag_capacity(last_capacity_check);

-- ═══════════════════════════════════════════════════════════
-- 3. 背包扩展历史表
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bag_expansion_history (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_bag_expansion_history_user ON bag_expansion_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bag_expansion_history_type ON bag_expansion_history(expansion_type, created_at DESC);

-- ═══════════════════════════════════════════════════════════
-- 4. 背包预警配置表
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bag_alert_config (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE,
    enable_alert BOOLEAN DEFAULT TRUE,
    alert_thresholds INT[] DEFAULT '{85, 90, 95, 99}',
    auto_transfer_to_storage BOOLEAN DEFAULT FALSE,
    auto_transfer_threshold INT DEFAULT 95,
    notification_method VARCHAR(20) DEFAULT 'push' CHECK (notification_method IN ('push', 'email', 'both', 'none')),
    last_alert_sent TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bag_alert_config_user ON bag_alert_config(user_id);
CREATE INDEX IF NOT EXISTS idx_bag_alert_config_enabled ON bag_alert_config(enable_alert) WHERE enable_alert = TRUE;

-- ═══════════════════════════════════════════════════════════
-- 5. 扩展 pokemon 表 - 添加收藏标记字段
-- ═══════════════════════════════════════════════════════════

ALTER TABLE pokemon 
ADD COLUMN IF NOT EXISTS is_favorited BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS favorite_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS bag_sort_order INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS storage_status VARCHAR(20) DEFAULT 'bag' CHECK (storage_status IN ('bag', 'storage', 'transfer'));

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_pokemon_bag_sort ON pokemon(user_id, bag_sort_order);
CREATE INDEX IF NOT EXISTS idx_pokemon_favorited ON pokemon(user_id, is_favorited) WHERE is_favorited = TRUE;
CREATE INDEX IF NOT EXISTS idx_pokemon_storage_status ON pokemon(user_id, storage_status);

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

CREATE TRIGGER update_player_bag_capacity_updated_at
    BEFORE UPDATE ON player_bag_capacity
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

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

CREATE TRIGGER update_bag_used_slots_trigger
    AFTER INSERT OR UPDATE ON pokemon
    FOR EACH ROW
    EXECUTE FUNCTION update_bag_used_slots();

-- ═══════════════════════════════════════════════════════════
-- 8. 注释
-- ═══════════════════════════════════════════════════════════

COMMENT ON TABLE bag_capacity_config IS '背包容量配置表 - 定义不同等级的容量基准和扩展成本';
COMMENT ON TABLE player_bag_capacity IS '玩家背包容量表 - 记录每个玩家的背包容量状态';
COMMENT ON TABLE bag_expansion_history IS '背包扩展历史表 - 记录所有容量扩展操作';
COMMENT ON TABLE bag_alert_config IS '背包预警配置表 - 玩家的容量预警设置';
