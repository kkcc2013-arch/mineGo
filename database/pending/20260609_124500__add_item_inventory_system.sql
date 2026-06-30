-- =====================================================
-- REQ-00047: 精灵道具与背包管理系统
-- 数据库迁移脚本
-- 创建时间: 2026-06-09 12:45
-- =====================================================

-- 1. 道具定义表
-- The items table already exists with a different schema (id VARCHAR(50) PK).
-- We adapt by adding all missing columns and adding item_id as an alias to id.
ALTER TABLE items ADD COLUMN IF NOT EXISTS item_id VARCHAR(50);
UPDATE items SET item_id = id WHERE item_id IS NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS name VARCHAR(100);
UPDATE items SET name = COALESCE(name_en, name_zh, id) WHERE name IS NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS name_localized JSONB;
UPDATE items SET name_localized = jsonb_build_object('en', name_en, 'zh', name_zh, 'ja', name_ja) WHERE name_localized IS NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS subcategory VARCHAR(50);
ALTER TABLE items ADD COLUMN IF NOT EXISTS rarity VARCHAR(20) DEFAULT 'common';
ALTER TABLE items ADD COLUMN IF NOT EXISTS max_stack INTEGER DEFAULT 999;
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_consumable BOOLEAN DEFAULT TRUE;
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_tradable BOOLEAN DEFAULT TRUE;
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_droppable BOOLEAN DEFAULT TRUE;
ALTER TABLE items ADD COLUMN IF NOT EXISTS expires_after_days INTEGER;
ALTER TABLE items ADD COLUMN IF NOT EXISTS use_requirements JSONB;
ALTER TABLE items ADD COLUMN IF NOT EXISTS icon_url VARCHAR(500);
ALTER TABLE items ADD COLUMN IF NOT EXISTS effect_data JSONB;
-- Ensure item_id has a unique constraint for FK references from other tables
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'items_item_id_key' AND conrelid = 'items'::regclass
    ) THEN
        ALTER TABLE items ADD CONSTRAINT items_item_id_key UNIQUE (item_id);
    END IF;
END$$;

-- 索引
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_rarity ON items(rarity);

COMMENT ON TABLE items IS '道具定义表';
COMMENT ON COLUMN items.item_id IS '道具唯一标识符';
COMMENT ON COLUMN items.category IS '道具分类: pokeball, potion, tm, evolution, boost, special, cosmetic';
COMMENT ON COLUMN items.effect_data IS '道具效果数据 JSON';

-- 2. 玩家背包表
CREATE TABLE IF NOT EXISTS player_inventory (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id VARCHAR(50) NOT NULL REFERENCES items(item_id),
    quantity INTEGER NOT NULL DEFAULT 1,
    slot_index INTEGER,                            -- 背包格子索引
    acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,                         -- 过期时间 (NULL 表示永不过期)
    metadata JSONB,                                -- 附加元数据 (来源、状态等)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT chk_quantity_positive CHECK (quantity > 0)
);

-- 创建唯一约束（允许同一道具多个堆叠）
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_inventory_user_item_slot 
ON player_inventory(user_id, item_id, slot_index) 
WHERE slot_index IS NOT NULL;

-- 索引
CREATE INDEX IF NOT EXISTS idx_player_inventory_user ON player_inventory(user_id);
CREATE INDEX IF NOT EXISTS idx_player_inventory_item ON player_inventory(user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_player_inventory_expires ON player_inventory(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE player_inventory IS '玩家背包表';
COMMENT ON COLUMN player_inventory.metadata IS '道具元数据 JSON (来源、特殊属性等)';

-- 3. 背包容量配置表
CREATE TABLE IF NOT EXISTS inventory_capacity (
    id SERIAL PRIMARY KEY,
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    base_capacity INTEGER DEFAULT 350,             -- 基础容量
    pokeball_slots INTEGER DEFAULT 100,            -- 精灵球槽位
    potion_slots INTEGER DEFAULT 100,              -- 药水槽位
    tm_slots INTEGER DEFAULT 50,                   -- TM 槽位
    evolution_slots INTEGER DEFAULT 50,            -- 进化道具槽位
    special_slots INTEGER DEFAULT 50,              -- 特殊道具槽位
    total_used INTEGER DEFAULT 0,                  -- 已使用总量
    last_cleanup_at TIMESTAMP,                     -- 上次清理时间
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE inventory_capacity IS '背包容量配置表';

-- 4. 道具使用记录表
CREATE TABLE IF NOT EXISTS item_usage_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id VARCHAR(50) NOT NULL REFERENCES items(item_id),
    pokemon_id INTEGER,                            -- 使用的精灵ID (如果有)
    action VARCHAR(50) NOT NULL,                   -- use, drop, trade, sell
    quantity INTEGER NOT NULL DEFAULT 1,
    source VARCHAR(100),                           -- 来源: catch, gym, shop, trade, quest
    context JSONB,                                 -- 使用上下文 (坐标、场景等)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_item_usage_user ON item_usage_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_item_usage_item ON item_usage_logs(item_id, created_at DESC);

COMMENT ON TABLE item_usage_logs IS '道具使用记录表';

-- 5. 快速访问栏配置表
CREATE TABLE IF NOT EXISTS quick_access_slots (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot_index INTEGER NOT NULL CHECK (slot_index >= 0 AND slot_index < 8), -- 8个快捷栏位
    item_id VARCHAR(50) REFERENCES items(item_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_user_quick_slot UNIQUE (user_id, slot_index)
);

COMMENT ON TABLE quick_access_slots IS '快速访问栏配置表';

-- 6. 道具商店配置表
CREATE TABLE IF NOT EXISTS shop_items (
    id SERIAL PRIMARY KEY,
    item_id VARCHAR(50) NOT NULL REFERENCES items(item_id),
    price_coins INTEGER,                           -- 金币价格
    price_stardust INTEGER,                        -- 星尘价格
    bundle_quantity INTEGER DEFAULT 1,             -- 捆绑数量
    daily_limit INTEGER,                           -- 每日购买限制
    available_from TIMESTAMP,                      -- 上架时间
    available_until TIMESTAMP,                     -- 下架时间
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shop_items_active ON shop_items(item_id, is_active);

COMMENT ON TABLE shop_items IS '道具商店配置表';

-- =====================================================
-- 种子数据：道具定义
-- =====================================================

-- 精灵球类
INSERT INTO items (id, item_id, name, name_zh, name_en, name_localized, description, category, rarity, max_stack, is_consumable, is_tradable, effect_data) VALUES
('POKE_BALL', 'POKE_BALL', 'Poké Ball', '精灵球', 'Poké Ball', '{"en": "Poké Ball", "zh": "精灵球", "ja": "モンスターボール"}', 'A basic Poké Ball for catching Pokémon.', 'pokeball', 'common', 999, true, true, '{"catch_rate": 1.0}'),
('GREAT_BALL', 'GREAT_BALL', 'Great Ball', '超级球', 'Great Ball', '{"en": "Great Ball", "zh": "超级球", "ja": "スーパーボール"}', 'A better Poké Ball with higher catch rate.', 'pokeball', 'uncommon', 999, true, true, '{"catch_rate": 1.5}'),
('ULTRA_BALL', 'ULTRA_BALL', 'Ultra Ball', '高级球', 'Ultra Ball', '{"en": "Ultra Ball", "zh": "高级球", "ja": "ハイパーボール"}', 'An ultra-high-performance Poké Ball.', 'pokeball', 'rare', 999, true, true, '{"catch_rate": 2.0}'),
('MASTER_BALL', 'MASTER_BALL', 'Master Ball', '大师球', 'Master Ball', '{"en": "Master Ball", "zh": "大师球", "ja": "マスターボール"}', 'A rare Ball that never fails to catch.', 'pokeball', 'legendary', 99, true, false, '{"catch_rate": 255.0}'),
('PREMIER_BALL', 'PREMIER_BALL', 'Premier Ball', '纪念球', 'Premier Ball', '{"en": "Premier Ball", "zh": "纪念球", "ja": "プレミアボール"}', 'A special Ball only given out during raids.', 'pokeball', 'rare', 999, true, false, '{"catch_rate": 1.0, "raid_only": true}')
ON CONFLICT (id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    name_zh = COALESCE(items.name_zh, EXCLUDED.name_zh),
    name_en = COALESCE(items.name_en, EXCLUDED.name_en),
    rarity = COALESCE(items.rarity, EXCLUDED.rarity),
    effect_data = COALESCE(items.effect_data, EXCLUDED.effect_data);

-- 药水类
INSERT INTO items (id, item_id, name, name_zh, name_en, name_localized, description, category, rarity, max_stack, is_consumable, is_tradable, effect_data) VALUES
('POTION', 'POTION', 'Potion', '伤药', 'Potion', '{"en": "Potion", "zh": "伤药", "ja": "キズぐすり"}', 'Restores 20 HP.', 'potion', 'common', 999, true, true, '{"heal_hp": 20}'),
('SUPER_POTION', 'SUPER_POTION', 'Super Potion', '好伤药', 'Super Potion', '{"en": "Super Potion", "zh": "好伤药", "ja": "いいキズぐすり"}', 'Restores 50 HP.', 'potion', 'uncommon', 999, true, true, '{"heal_hp": 50}'),
('HYPER_POTION', 'HYPER_POTION', 'Hyper Potion', '厉害伤药', 'Hyper Potion', '{"en": "Hyper Potion", "zh": "厉害伤药", "ja": "すごいキズぐすり"}', 'Restores 200 HP.', 'potion', 'rare', 999, true, true, '{"heal_hp": 200}'),
('MAX_POTION', 'MAX_POTION', 'Max Potion', '全满药', 'Max Potion', '{"en": "Max Potion", "zh": "全满药", "ja": "まんたんのくすり"}', 'Fully restores HP.', 'potion', 'epic', 99, true, true, '{"heal_percent": 100}'),
('REVIVE', 'REVIVE', 'Revive', '复活药', 'Revive', '{"en": "Revive", "zh": "复活药", "ja": "げんきのかたまり"}', 'Revives with 50% HP.', 'potion', 'rare', 999, true, true, '{"revive_percent": 50}'),
('MAX_REVIVE', 'MAX_REVIVE', 'Max Revive', '全满复活药', 'Max Revive', '{"en": "Max Revive", "zh": "全满复活药", "ja": "げんきのかたまり"}', 'Revives with full HP.', 'potion', 'epic', 99, true, true, '{"revive_percent": 100}')
ON CONFLICT (id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    name_zh = COALESCE(items.name_zh, EXCLUDED.name_zh),
    name_en = COALESCE(items.name_en, EXCLUDED.name_en),
    rarity = COALESCE(items.rarity, EXCLUDED.rarity),
    effect_data = COALESCE(items.effect_data, EXCLUDED.effect_data);

-- 进化石
INSERT INTO items (id, item_id, name, name_zh, name_en, name_localized, description, category, rarity, max_stack, is_consumable, is_tradable, effect_data) VALUES
('SUN_STONE', 'SUN_STONE', 'Sun Stone', '日之石', 'Sun Stone', '{"en": "Sun Stone", "zh": "日之石", "ja": "たいようのいし"}', 'Evolves certain Pokémon.', 'evolution', 'rare', 50, true, true, '{"evolution_items": ["SUNKERN", "GLOOM"]}'),
('MOON_STONE', 'MOON_STONE', 'Moon Stone', '月之石', 'Moon Stone', '{"en": "Moon Stone", "zh": "月之石", "ja": "つきのいし"}', 'Evolves certain Pokémon.', 'evolution', 'rare', 50, true, true, '{"evolution_items": ["NIDORINA", "CLEFAIRY"]}'),
('FIRE_STONE', 'FIRE_STONE', 'Fire Stone', '火之石', 'Fire Stone', '{"en": "Fire Stone", "zh": "火之石", "ja": "ほのおのいし"}', 'Evolves certain Pokémon.', 'evolution', 'rare', 50, true, true, '{"evolution_items": ["VULPIX", "GROWLITHE", "EEVEE"]}'),
('WATER_STONE', 'WATER_STONE', 'Water Stone', '水之石', 'Water Stone', '{"en": "Water Stone", "zh": "水之石", "ja": "みずのいし"}', 'Evolves certain Pokémon.', 'evolution', 'rare', 50, true, true, '{"evolution_items": ["SHELLDER", "STARYU", "EEVEE"]}'),
('THUNDER_STONE', 'THUNDER_STONE', 'Thunder Stone', '雷之石', 'Thunder Stone', '{"en": "Thunder Stone", "zh": "雷之石", "ja": "かみなりのいし"}', 'Evolves certain Pokémon.', 'evolution', 'rare', 50, true, true, '{"evolution_items": ["PIKACHU", "EEVEE"]}'),
('KINGS_ROCK', 'KINGS_ROCK', 'Kings Rock', '王者之证', 'Kings Rock', '{"en": "Kings Rock", "zh": "王者之证", "ja": "おうじゃのしるし"}', 'Evolves certain Pokémon with candy.', 'evolution', 'epic', 20, true, true, '{"evolution_items": ["SLOWPOKE", "POLIWHIRL"]}')
ON CONFLICT (id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    name_zh = COALESCE(items.name_zh, EXCLUDED.name_zh),
    name_en = COALESCE(items.name_en, EXCLUDED.name_en),
    rarity = COALESCE(items.rarity, EXCLUDED.rarity),
    effect_data = COALESCE(items.effect_data, EXCLUDED.effect_data);

-- 强化道具
INSERT INTO items (id, item_id, name, name_zh, name_en, name_localized, description, category, rarity, max_stack, is_consumable, is_tradable, effect_data) VALUES
('RARE_CANDY', 'RARE_CANDY', 'Rare Candy', '稀有糖果', 'Rare Candy', '{"en": "Rare Candy", "zh": "稀有糖果", "ja": "ふしぎなアメ"}', 'Increases CP by one level.', 'boost', 'epic', 99, true, true, '{"cp_boost": 1}'),
('SILVER_PINAP_BERRY', 'SILVER_PINAP_BERRY', 'Silver Pinap Berry', '银凤梨果', 'Silver Pinap Berry', '{"en": "Silver Pinap Berry", "zh": "银凤梨果", "ja": "ぎんのパイルのみ"}', 'Doubles candy and increases catch rate.', 'boost', 'rare', 99, true, true, '{"candy_multiplier": 2.0, "catch_rate_multiplier": 1.8}'),
('GOLDEN_RAZZ_BERRY', 'GOLDEN_RAZZ_BERRY', 'Golden Razz Berry', '金蔓莓果', 'Golden Razz Berry', '{"en": "Golden Razz Berry", "zh": "金蔓莓果", "ja": "きんのズリのみ"}', 'Greatly increases catch rate.', 'boost', 'epic', 99, true, true, '{"catch_rate_multiplier": 2.5}')
ON CONFLICT (id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    name_zh = COALESCE(items.name_zh, EXCLUDED.name_zh),
    name_en = COALESCE(items.name_en, EXCLUDED.name_en),
    rarity = COALESCE(items.rarity, EXCLUDED.rarity),
    effect_data = COALESCE(items.effect_data, EXCLUDED.effect_data);

-- 特殊道具
INSERT INTO items (id, item_id, name, name_zh, name_en, name_localized, description, category, rarity, max_stack, is_consumable, is_tradable, effect_data) VALUES
('INCENSE', 'INCENSE', 'Incense', '熏香', 'Incense', '{"en": "Incense", "zh": "熏香", "ja": "おこう"}', 'Attracts wild Pokémon for 60 minutes.', 'special', 'rare', 99, true, false, '{"duration_minutes": 60, "spawn_rate_multiplier": 1.5}'),
('LUCKY_EGG', 'LUCKY_EGG', 'Lucky Egg', '幸运蛋', 'Lucky Egg', '{"en": "Lucky Egg", "zh": "幸运蛋", "ja": "しあわせタマゴ"}', 'Doubles XP for 30 minutes.', 'special', 'rare', 99, true, false, '{"duration_minutes": 30, "xp_multiplier": 2.0}'),
('LURE_MODULE', 'LURE_MODULE', 'Lure Module', '诱饵模块', 'Lure Module', '{"en": "Lure Module", "zh": "诱饵模块", "ja": "ルアーモジュール"}', 'Attracts Pokémon to a PokéStop for 30 minutes.', 'special', 'uncommon', 99, true, false, '{"duration_minutes": 30, "radius_meters": 100}'),
('STAR_PIECE', 'STAR_PIECE', 'Star Piece', '星之碎片', 'Star Piece', '{"en": "Star Piece", "zh": "星之碎片", "ja": "ほしのかけら"}', 'Increases Stardust gain by 50% for 30 minutes.', 'special', 'rare', 99, true, false, '{"duration_minutes": 30, "stardust_multiplier": 1.5}')
ON CONFLICT (id) DO UPDATE SET
    item_id = EXCLUDED.item_id,
    name_zh = COALESCE(items.name_zh, EXCLUDED.name_zh),
    name_en = COALESCE(items.name_en, EXCLUDED.name_en),
    rarity = COALESCE(items.rarity, EXCLUDED.rarity),
    effect_data = COALESCE(items.effect_data, EXCLUDED.effect_data);

-- =====================================================
-- 创建更新触发器
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_items_updated_at BEFORE UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_player_inventory_updated_at BEFORE UPDATE ON player_inventory
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_inventory_capacity_updated_at BEFORE UPDATE ON inventory_capacity
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_quick_access_slots_updated_at BEFORE UPDATE ON quick_access_slots
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_shop_items_updated_at BEFORE UPDATE ON shop_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 创建定期清理过期道具的函数
-- =====================================================

CREATE OR REPLACE FUNCTION cleanup_expired_inventory()
RETURNS INTEGER AS $$
DECLARE
    cleaned_count INTEGER;
BEGIN
    -- 更新过期道具数量为0
    UPDATE player_inventory 
    SET quantity = 0, updated_at = CURRENT_TIMESTAMP
    WHERE expires_at IS NOT NULL 
      AND expires_at < CURRENT_TIMESTAMP
      AND quantity > 0;
    
    GET DIAGNOSTICS cleaned_count = ROW_COUNT;
    
    -- 更新用户的容量使用统计
    UPDATE inventory_capacity ic
    SET total_used = (
        SELECT COALESCE(SUM(quantity), 0)
        FROM player_inventory pi
        WHERE pi.user_id = ic.user_id
    ),
    last_cleanup_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP;
    
    RETURN cleaned_count;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 创建背包容量检查函数
-- =====================================================

CREATE OR REPLACE FUNCTION check_inventory_capacity(
    p_user_id INTEGER,
    p_category VARCHAR(50),
    p_quantity INTEGER
)
RETURNS TABLE (
    can_add BOOLEAN,
    current_count BIGINT,
    slot_limit INTEGER,
    remaining INTEGER
) AS $$
DECLARE
    v_capacity RECORD;
    v_limit INTEGER;
BEGIN
    -- 获取用户容量配置
    SELECT * INTO v_capacity
    FROM inventory_capacity
    WHERE user_id = p_user_id;
    
    IF NOT FOUND THEN
        v_capacity := ROW(
            NULL, p_user_id, 350, 100, 100, 50, 50, 50, 0, NULL, NULL, NULL
        );
    END IF;
    
    -- 根据分类确定限制
    CASE p_category
        WHEN 'pokeball' THEN v_limit := v_capacity.pokeball_slots;
        WHEN 'potion' THEN v_limit := v_capacity.potion_slots;
        WHEN 'tm' THEN v_limit := v_capacity.tm_slots;
        WHEN 'evolution' THEN v_limit := v_capacity.evolution_slots;
        WHEN 'boost' THEN v_limit := v_capacity.special_slots;
        WHEN 'special' THEN v_limit := v_capacity.special_slots;
        WHEN 'cosmetic' THEN v_limit := v_capacity.special_slots;
        ELSE v_limit := v_capacity.base_capacity;
    END CASE;
    
    RETURN QUERY
    SELECT 
        (current_count + p_quantity <= v_limit) AS can_add,
        current_count,
        v_limit AS slot_limit,
        (v_limit - current_count) AS remaining
    FROM (
        SELECT COALESCE(SUM(pi.quantity), 0) AS current_count
        FROM player_inventory pi
        JOIN items i ON pi.item_id = i.item_id
        WHERE pi.user_id = p_user_id
          AND i.category = p_category
    ) subq;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 创建统计视图
-- =====================================================

CREATE OR REPLACE VIEW inventory_statistics AS
SELECT 
    u.id AS user_id,
    u.nickname,
    ic.base_capacity,
    ic.pokeball_slots,
    ic.potion_slots,
    ic.tm_slots,
    ic.evolution_slots,
    ic.special_slots,
    ic.total_used,
    COUNT(DISTINCT pi.item_id) AS unique_items,
    SUM(CASE WHEN i.category = 'pokeball' THEN pi.quantity ELSE 0 END) AS pokeball_count,
    SUM(CASE WHEN i.category = 'potion' THEN pi.quantity ELSE 0 END) AS potion_count,
    SUM(CASE WHEN i.category = 'evolution' THEN pi.quantity ELSE 0 END) AS evolution_count,
    SUM(CASE WHEN pi.expires_at IS NOT NULL AND pi.expires_at < CURRENT_TIMESTAMP THEN pi.quantity ELSE 0 END) AS expired_count
FROM users u
LEFT JOIN inventory_capacity ic ON ic.user_id = u.id
LEFT JOIN player_inventory pi ON pi.user_id = u.id AND pi.quantity > 0
LEFT JOIN items i ON pi.item_id = i.item_id
GROUP BY u.id, u.nickname, ic.base_capacity, ic.pokeball_slots, ic.potion_slots,
         ic.tm_slots, ic.evolution_slots, ic.special_slots, ic.total_used;

COMMENT ON VIEW inventory_statistics IS '背包统计视图';

-- =====================================================
-- 授权
-- =====================================================

-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO minego_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO minego_user;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO minego_user;

-- =====================================================
-- 迁移完成
-- =====================================================


