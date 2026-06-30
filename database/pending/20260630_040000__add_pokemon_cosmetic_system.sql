-- REQ-00125: 精灵外观定制系统
-- 创建时间: 2026-06-30 04:00 UTC
-- 涉及服务: pokemon-service, user-service, reward-service

-- 1. 装饰物定义表
CREATE TABLE IF NOT EXISTS cosmetic_items (
    id VARCHAR(50) PRIMARY KEY,
    name JSONB NOT NULL,                    -- {"en": "Santa Hat", "zh": "圣诞帽", "ja": "サンタ帽"}
    description JSONB NOT NULL,             -- {"en": "...", "zh": "...", "ja": "..."}
    category VARCHAR(30) NOT NULL,          -- hat/glasses/accessory/sticker/aura/trail
    rarity VARCHAR(20) NOT NULL,            -- common/uncommon/rare/epic/legendary
    icon_url VARCHAR(500) NOT NULL,         -- 装饰物图标
    model_url VARCHAR(500),                 -- 3D 模型文件（可选）
    position_data JSONB NOT NULL,           -- {"offset": [0, 10, 5], "scale": 1.0, "rotation": [0, 0, 0]}
    animation_data JSONB,                   -- {"idle": "...", "active": "..."}
    available_from TIMESTAMPTZ,             -- 限时装饰物开始时间
    available_until TIMESTAMPTZ,            -- 限时装饰物结束时间
    source_type VARCHAR(30) NOT NULL,       -- shop/achievement/event/crafting/default
    source_id VARCHAR(100),                 -- 来源 ID（商店物品 ID/成就 ID/活动 ID）
    price_coins INT DEFAULT 0,              -- 金币价格
    price_gems INT DEFAULT 0,               -- 宝石价格（付费货币）
    is_stackable BOOLEAN DEFAULT FALSE,     -- 是否可叠加（贴纸类）
    max_equipped INT DEFAULT 1,             -- 同类最多装备数量
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cosmetic_items_category ON cosmetic_items(category);
CREATE INDEX IF NOT EXISTS idx_cosmetic_items_rarity ON cosmetic_items(rarity);
CREATE INDEX IF NOT EXISTS idx_cosmetic_items_source ON cosmetic_items(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_cosmetic_items_availability ON cosmetic_items(available_from, available_until);

COMMENT ON TABLE cosmetic_items IS 'REQ-00125: 装饰物定义表';
COMMENT ON COLUMN cosmetic_items.category IS '装饰物类别: hat/glasses/accessory/sticker/aura/trail';
COMMENT ON COLUMN cosmetic_items.rarity IS '稀有度: common/uncommon/rare/epic/legendary';

-- 2. 用户装饰物库存表
CREATE TABLE IF NOT EXISTS user_cosmetics (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cosmetic_id VARCHAR(50) NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE,
    quantity INT DEFAULT 1,                 -- 数量（可叠加装饰物）
    obtained_at TIMESTAMPTZ DEFAULT NOW(),
    obtained_from VARCHAR(30) NOT NULL,     -- purchase/achievement/event/crafting/gift
    expires_at TIMESTAMPTZ,                 -- 过期时间（限时装饰物）
    UNIQUE(user_id, cosmetic_id)
);

CREATE INDEX IF NOT EXISTS idx_user_cosmetics_user ON user_cosmetics(user_id);
CREATE INDEX IF NOT EXISTS idx_user_cosmetics_expires ON user_cosmetics(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE user_cosmetics IS 'REQ-00125: 用户装饰物库存表';

-- 3. 精灵装备装饰物表
CREATE TABLE IF NOT EXISTS pokemon_cosmetics (
    id SERIAL PRIMARY KEY,
    pokemon_instance_id VARCHAR(50) NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    cosmetic_id VARCHAR(50) NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE,
    slot_position INT DEFAULT 0,            -- 装饰物槽位
    equipped_at TIMESTAMPTZ DEFAULT NOW(),
    equipped_by INTEGER REFERENCES users(id),
    UNIQUE(pokemon_instance_id, cosmetic_id)
);

CREATE INDEX IF NOT EXISTS idx_pokemon_cosmetics_pokemon ON pokemon_cosmetics(pokemon_instance_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_cosmetics_cosmetic ON pokemon_cosmetics(cosmetic_id);

COMMENT ON TABLE pokemon_cosmetics IS 'REQ-00125: 精灵装备装饰物表';

-- 4. 装饰物组合方案表（预设搭配）
CREATE TABLE IF NOT EXISTS cosmetic_presets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    preset_data JSONB NOT NULL,             -- {"cosmetic_id": slot_position, ...}
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cosmetic_presets_user ON cosmetic_presets(user_id);

COMMENT ON TABLE cosmetic_presets IS 'REQ-00125: 装饰物组合方案表';

-- 5. 装饰物统计表
CREATE TABLE IF NOT EXISTS cosmetic_statistics (
    cosmetic_id VARCHAR(50) PRIMARY KEY REFERENCES cosmetic_items(id) ON DELETE CASCADE,
    total_owned INT DEFAULT 0,              -- 总拥有人数
    total_equipped INT DEFAULT 0,           -- 当前装备数
    total_purchased INT DEFAULT 0,          -- 总购买次数
    total_revenue_coins BIGINT DEFAULT 0,   -- 金币收入
    total_revenue_gems BIGINT DEFAULT 0,    -- 宝石收入
    last_updated TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE cosmetic_statistics IS 'REQ-00125: 装饰物统计表';

-- 6. 插入初始装饰物数据
INSERT INTO cosmetic_items (id, name, description, category, rarity, icon_url, position_data, source_type, price_coins) VALUES
-- 帽子类
('hat_party_hat', '{"en": "Party Hat", "zh": "派对帽", "ja": "パーティハット"}', '{"en": "A colorful party hat", "zh": "多彩的派对帽", "ja": "カラフルなパーティハット"}', 'hat', 'common', 'https://cdn.minego.com/cosmetics/hats/party_hat.png', '{"offset": [0, 15, 0], "scale": 1.0}', 'shop', 500),
('hat_santa_hat', '{"en": "Santa Hat", "zh": "圣诞帽", "ja": "サンタ帽"}', '{"en": "A festive Santa hat", "zh": "节日圣诞帽", "ja": "フェスティブなサンタ帽"}', 'hat', 'rare', 'https://cdn.minego.com/cosmetics/hats/santa_hat.png', '{"offset": [0, 18, 0], "scale": 1.1}', 'event', 0),
('hat_crown', '{"en": "Golden Crown", "zh": "黄金皇冠", "ja": "ゴールデンクラウン"}', '{"en": "A majestic golden crown", "zh": "威严的黄金皇冠", "ja": "堂々たるゴールデンクラウン"}', 'hat', 'legendary', 'https://cdn.minego.com/cosmetics/hats/crown.png', '{"offset": [0, 20, 0], "scale": 1.2}', 'achievement', 0),

-- 眼镜类
('glasses_sunglasses', '{"en": "Sunglasses", "zh": "太阳镜", "ja": "サングラス"}', '{"en": "Cool sunglasses", "zh": "酷炫太阳镜", "ja": "クールなサングラス"}', 'glasses', 'common', 'https://cdn.minego.com/cosmetics/glasses/sunglasses.png', '{"offset": [0, 8, 2], "scale": 1.0}', 'shop', 300),
('glasses_geek_glasses', '{"en": "Geek Glasses", "zh": "极客眼镜", "ja": "オタクグラス"}', '{"en": "Nerdy glasses", "zh": "书呆子眼镜", "ja": "オタクっぽいグラス"}', 'glasses', 'uncommon', 'https://cdn.minego.com/cosmetics/glasses/geek_glasses.png', '{"offset": [0, 7, 2], "scale": 0.9}', 'shop', 400),

-- 饰品类
('accessory_bow_tie', '{"en": "Bow Tie", "zh": "领结", "ja": "リボンタイ"}', '{"en": "A fancy bow tie", "zh": "优雅的领结", "ja": "おしゃれなリボンタイ"}', 'accessory', 'common', 'https://cdn.minego.com/cosmetics/accessories/bow_tie.png', '{"offset": [0, -5, 8], "scale": 0.8}', 'shop', 250),
('accessory_scarf', '{"en": "Winter Scarf", "zh": "冬围巾", "ja": "ウィンタースカーフ"}', '{"en": "A warm winter scarf", "zh": "温暖的冬围巾", "ja": "暖かいウィンタースカーフ"}', 'accessory', 'uncommon', 'https://cdn.minego.com/cosmetics/accessories/scarf.png', '{"offset": [0, -8, 6], "scale": 1.0}', 'event', 0),

-- 贴纸类
('sticker_heart', '{"en": "Heart Sticker", "zh": "爱心贴纸", "ja": "ハートステッカー"}', '{"en": "A cute heart sticker", "zh": "可爱的爱心贴纸", "ja": "かわいいハートステッカー"}', 'sticker', 'common', 'https://cdn.minego.com/cosmetics/stickers/heart.png', '{"offset": [5, 10, 3], "scale": 0.5}', 'shop', 100),
('sticker_star', '{"en": "Star Sticker", "zh": "星星贴纸", "ja": "スターステッカー"}', '{"en": "A shiny star sticker", "zh": "闪亮的星星贴纸", "ja": "キラキラスターステッカー"}', 'sticker', 'common', 'https://cdn.minego.com/cosmetics/stickers/star.png', '{"offset": [-5, 12, 3], "scale": 0.5}', 'shop', 100),

-- 光环类
('aura_legendary_aura', '{"en": "Legendary Aura", "zh": "传说光环", "ja": "レジェンダリーオーラ"}', '{"en": "A legendary aura effect", "zh": "传说级光环效果", "ja": "レジェンダリーオーラエフェクト"}', 'aura', 'legendary', 'https://cdn.minego.com/cosmetics/auras/legendary.png', '{"offset": [0, 0, 0], "scale": 1.5}', 'achievement', 0),
('aura_fire_aura', '{"en": "Fire Aura", "zh": "火焰光环", "ja": "ファイアオーラ"}', '{"en": "A fiery aura effect", "zh": "火焰光环效果", "ja": "ファイアオーラエフェクト"}', 'aura', 'epic', 'https://cdn.minego.com/cosmetics/auras/fire.png', '{"offset": [0, 0, 0], "scale": 1.3}', 'shop', 2000),

-- 轨迹类
('trail_rainbow_trail', '{"en": "Rainbow Trail", "zh": "彩虹轨迹", "ja": "レインボートレイル"}', '{"en": "A colorful rainbow trail", "zh": "多彩的彩虹轨迹", "ja": "カラフルなレインボートレイル"}', 'trail', 'epic', 'https://cdn.minego.com/cosmetics/trails/rainbow.png', '{"offset": [0, -5, -10], "scale": 1.0}', 'shop', 1500),
('trail_fire_trail', '{"en": "Fire Trail", "zh": "火焰轨迹", "ja": "ファイアトレイル"}', '{"en": "A blazing fire trail", "zh": "炽热的火焰轨迹", "ja": "燃えるファイアトレイル"}', 'trail', 'rare', 'https://cdn.minego.com/cosmetics/trails/fire.png', '{"offset": [0, -5, -10], "scale": 1.0}', 'shop', 1000)
ON CONFLICT (id) DO NOTHING;

-- 7. 初始化统计表
INSERT INTO cosmetic_statistics (cosmetic_id, total_owned, total_equipped, total_purchased)
SELECT id, 0, 0, 0 FROM cosmetic_items
ON CONFLICT (cosmetic_id) DO NOTHING;

-- 8. 添加部分付费装饰物
UPDATE cosmetic_items 
SET price_gems = 100 
WHERE rarity = 'legendary' AND source_type = 'shop';

UPDATE cosmetic_items 
SET price_gems = 50 
WHERE rarity = 'epic' AND source_type = 'shop';
