-- REQ-00240: 精灵放生与资源回收系统
-- 创建时间: 2026-06-18 17:00 UTC

-- 放生资源类型枚举
CREATE TYPE release_resource_type AS ENUM (
    'gold', 'evolution_stone', 'tm_fragment', 'candy', 
    'stardust', 'rare_candy'
);

-- 放生记录表
CREATE TABLE pokemon_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pokemon_instance_id UUID NOT NULL,
    pokemon_species_id UUID NOT NULL REFERENCES pokemon_species(id),
    level INTEGER NOT NULL,
    iv_total INTEGER NOT NULL,
    is_shiny BOOLEAN DEFAULT FALSE,
    rarity VARCHAR(20) NOT NULL,
    resources_returned JSONB NOT NULL,
    released_at TIMESTAMPTZ DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    confirmation_token VARCHAR(64),
    
    CONSTRAINT chk_iv_total CHECK (iv_total >= 0 AND iv_total <= 100)
);

CREATE INDEX idx_pokemon_releases_user ON pokemon_releases(user_id, released_at DESC);
CREATE INDEX idx_pokemon_releases_species ON pokemon_releases(pokemon_species_id);

-- 资源回收规则表
CREATE TABLE release_resource_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rarity VARCHAR(20) NOT NULL,
    level_range VARCHAR(20) NOT NULL, -- '1-10', '11-20', etc.
    iv_range VARCHAR(20) NOT NULL, -- '0-20', '21-40', etc.
    resource_type release_resource_type NOT NULL,
    base_amount DECIMAL(10, 2) NOT NULL,
    multiplier DECIMAL(3, 2) DEFAULT 1.0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT chk_base_amount CHECK (base_amount >= 0),
    CONSTRAINT chk_multiplier CHECK (multiplier >= 0 AND multiplier <= 10)
);

CREATE INDEX idx_release_rules_rarity ON release_resource_rules(rarity, is_active);

-- 待确认放生表
CREATE TABLE pending_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pokemon_ids JSONB NOT NULL,
    token VARCHAR(64) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_pending_releases_token ON pending_releases(token);
CREATE INDEX idx_pending_releases_user ON pending_releases(user_id);

-- 插入默认资源回收规则
INSERT INTO release_resource_rules (rarity, level_range, iv_range, resource_type, base_amount, multiplier) VALUES
-- 普通精灵
('common', '1-10', '0-20', 'gold', 10, 1.0),
('common', '1-10', '0-20', 'stardust', 50, 1.0),
('common', '11-20', '0-20', 'gold', 20, 1.0),
('common', '11-20', '0-20', 'stardust', 100, 1.0),
('common', '21-30', '0-20', 'gold', 30, 1.0),
('common', '21-30', '0-20', 'stardust', 150, 1.0),
('common', '31-40', '0-20', 'gold', 40, 1.0),
('common', '31-40', '0-20', 'stardust', 200, 1.0),
('common', '41-50', '0-20', 'gold', 50, 1.0),
('common', '41-50', '0-20', 'stardust', 250, 1.0),

-- 稀有精灵
('uncommon', '1-10', '0-20', 'gold', 20, 1.0),
('uncommon', '1-10', '0-20', 'stardust', 100, 1.0),
('uncommon', '11-20', '0-20', 'gold', 40, 1.0),
('uncommon', '11-20', '0-20', 'stardust', 200, 1.0),
('uncommon', '21-30', '0-20', 'gold', 60, 1.0),
('uncommon', '21-30', '0-20', 'stardust', 300, 1.0),
('uncommon', '31-40', '0-20', 'gold', 80, 1.0),
('uncommon', '31-40', '0-20', 'stardust', 400, 1.0),
('uncommon', '41-50', '0-20', 'gold', 100, 1.0),
('uncommon', '41-50', '0-20', 'stardust', 500, 1.0),

-- 稀少精灵
('rare', '1-10', '0-20', 'gold', 50, 1.0),
('rare', '1-10', '0-20', 'stardust', 200, 1.0),
('rare', '1-10', '0-20', 'candy', 1, 1.0),
('rare', '21-30', '0-20', 'gold', 100, 1.0),
('rare', '21-30', '0-20', 'stardust', 400, 1.0),
('rare', '21-30', '0-20', 'candy', 2, 1.0),
('rare', '41-50', '0-20', 'gold', 200, 1.0),
('rare', '41-50', '0-20', 'stardust', 800, 1.0),
('rare', '41-50', '0-20', 'candy', 5, 1.0),

-- 史诗精灵
('epic', '1-10', '0-20', 'gold', 100, 1.0),
('epic', '1-10', '0-20', 'stardust', 500, 1.0),
('epic', '1-10', '0-20', 'candy', 3, 1.0),
('epic', '21-30', '0-20', 'gold', 200, 1.0),
('epic', '21-30', '0-20', 'stardust', 1000, 1.0),
('epic', '21-30', '0-20', 'candy', 6, 1.0),
('epic', '41-50', '0-20', 'gold', 500, 1.0),
('epic', '41-50', '0-20', 'stardust', 2000, 1.0),
('epic', '41-50', '0-20', 'candy', 10, 1.0),

-- 传说精灵
('legendary', '1-10', '0-20', 'gold', 500, 1.0),
('legendary', '1-10', '0-20', 'stardust', 2000, 1.0),
('legendary', '1-10', '0-20', 'candy', 10, 1.0),
('legendary', '1-10', '0-20', 'rare_candy', 1, 1.0),
('legendary', '21-30', '0-20', 'gold', 1000, 1.0),
('legendary', '21-30', '0-20', 'stardust', 4000, 1.0),
('legendary', '21-30', '0-20', 'candy', 20, 1.0),
('legendary', '21-30', '0-20', 'rare_candy', 2, 1.0),
('legendary', '41-50', '0-20', 'gold', 2000, 1.0),
('legendary', '41-50', '0-20', 'stardust', 8000, 1.0),
('legendary', '41-50', '0-20', 'candy', 40, 1.0),
('legendary', '41-50', '0-20', 'rare_candy', 5, 1.0),

-- 高IV加成规则
('common', '1-50', '61-80', 'gold', 0, 1.5),
('common', '1-50', '81-100', 'gold', 0, 2.0),
('rare', '1-50', '61-80', 'gold', 0, 1.5),
('rare', '1-50', '81-100', 'gold', 0, 2.0),
('epic', '1-50', '61-80', 'gold', 0, 1.5),
('epic', '1-50', '81-100', 'gold', 0, 2.0),
('legendary', '1-50', '61-80', 'gold', 0, 1.5),
('legendary', '1-50', '81-100', 'gold', 0, 2.0);

-- 创建清理过期待确认放生的函数
CREATE OR REPLACE FUNCTION cleanup_expired_pending_releases()
RETURNS void AS $$
BEGIN
    DELETE FROM pending_releases WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- 创建统计视图
CREATE OR REPLACE VIEW release_stats_view AS
SELECT 
    user_id,
    COUNT(*) as total_releases,
    COUNT(DISTINCT pokemon_species_id) as unique_species_released,
    SUM((resources_returned->>'gold')::numeric) as total_gold_returned,
    SUM((resources_returned->>'stardust')::numeric) as total_stardust_returned,
    COUNT(*) FILTER (WHERE is_shiny) as shiny_releases,
    MAX(released_at) as last_release_at
FROM pokemon_releases
GROUP BY user_id;
