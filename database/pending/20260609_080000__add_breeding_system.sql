-- REQ-00046: 精灵培育系统与遗传机制
-- 创建时间: 2026-06-09 08:00
-- 描述: 实现精灵培育中心、配对、蛋组、孵化系统

-- 精灵培育中心表
CREATE TABLE IF NOT EXISTS breeding_centers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL DEFAULT '培育中心',
    slots INTEGER NOT NULL DEFAULT 4 CHECK (slots >= 1 AND slots <= 10),
    upgraded_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    UNIQUE(user_id)
);

-- 培育配对表
CREATE TABLE IF NOT EXISTS breeding_pairs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    center_id UUID NOT NULL REFERENCES breeding_centers(id) ON DELETE CASCADE,
    slot_index INTEGER NOT NULL CHECK (slot_index >= 0 AND slot_index < 10),
    
    -- 父母精灵
    parent1_pokemon_id UUID NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    parent2_pokemon_id UUID NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    
    -- 培育状态
    status VARCHAR(20) NOT NULL DEFAULT 'breeding' CHECK (status IN ('breeding', 'ready', 'collected', 'cancelled')),
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ready_at TIMESTAMP,
    collected_at TIMESTAMP,
    
    -- 预生成后代数据（JSON）
    offspring_data JSONB NOT NULL DEFAULT '{}',
    offspring_id UUID REFERENCES user_pokemon(id) ON DELETE SET NULL,
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    UNIQUE(center_id, slot_index),
    CONSTRAINT valid_parents CHECK (parent1_pokemon_id != parent2_pokemon_id)
);

-- 精灵蛋组定义
CREATE TABLE IF NOT EXISTS egg_groups (
    id INTEGER PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT
);

-- 插入蛋组数据
INSERT INTO egg_groups (id, name, description) VALUES
    (1, '怪物', '怪兽类精灵'),
    (2, '水中', '水生精灵'),
    (3, '飞行', '飞行类精灵'),
    (4, '妖精', '妖精类精灵'),
    (5, '植物', '植物类精灵'),
    (6, '人形', '人形精灵'),
    (7, '矿物', '矿物类精灵'),
    (8, '不定形', '不定形精灵'),
    (9, '龙', '龙类精灵'),
    (10, '昆虫', '昆虫类精灵'),
    (11, '陆上', '陆上精灵'),
    (12, '未发现', '无法培育的精灵'),
    (13, '百变怪', '可与任何可培育精灵配对'),
    (14, '水域2', '水域精灵第二组'),
    (15, '水域3', '水域精灵第三组')
ON CONFLICT (id) DO NOTHING;

-- 精灵物种蛋组关联表
CREATE TABLE IF NOT EXISTS species_egg_groups (
    species_id INTEGER NOT NULL REFERENCES pokemon_species(id) ON DELETE CASCADE,
    egg_group_id INTEGER NOT NULL REFERENCES egg_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (species_id, egg_group_id)
);

-- 精灵孵化进度表
CREATE TABLE IF NOT EXISTS egg_hatching (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pokemon_id UUID NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    
    -- 孵化进度
    current_steps INTEGER NOT NULL DEFAULT 0,
    required_steps INTEGER NOT NULL CHECK (required_steps > 0),
    
    -- 孵化器加速
    incubator_type VARCHAR(20) NOT NULL DEFAULT 'basic' CHECK (incubator_type IN ('basic', 'super', 'ultra')),
    speed_multiplier DECIMAL(3,2) NOT NULL DEFAULT 1.0,
    
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    hatched_at TIMESTAMP,
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 精灵家族谱系表
CREATE TABLE IF NOT EXISTS pokemon_lineage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    
    -- 父母信息
    parent1_id UUID REFERENCES user_pokemon(id) ON DELETE SET NULL,
    parent1_species_id INTEGER REFERENCES pokemon_species(id),
    parent1_nickname VARCHAR(50),
    
    parent2_id UUID REFERENCES user_pokemon(id) ON DELETE SET NULL,
    parent2_species_id INTEGER REFERENCES pokemon_species(id),
    parent2_nickname VARCHAR(50),
    
    -- 培育信息
    bred_at TIMESTAMP NOT NULL DEFAULT NOW(),
    bred_by_user_id UUID NOT NULL REFERENCES users(id),
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 培育统计表
CREATE TABLE IF NOT EXISTS breeding_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- 统计数据
    total_breeds INTEGER NOT NULL DEFAULT 0,
    total_eggs_hatched INTEGER NOT NULL DEFAULT 0,
    perfect_iv_breeds INTEGER NOT NULL DEFAULT 0, -- 6V 精灵数量
    shiny_breeds INTEGER NOT NULL DEFAULT 0, -- 闪光培育数量
    
    last_bred_at TIMESTAMP,
    last_hatched_at TIMESTAMP,
    
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    UNIQUE(user_id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_breeding_centers_user ON breeding_centers(user_id);
CREATE INDEX IF NOT EXISTS idx_breeding_pairs_center ON breeding_pairs(center_id);
CREATE INDEX IF NOT EXISTS idx_breeding_pairs_status ON breeding_pairs(status);
CREATE INDEX IF NOT EXISTS idx_breeding_pairs_ready_at ON breeding_pairs(ready_at) WHERE status = 'breeding';
CREATE INDEX IF NOT EXISTS idx_species_egg_groups_species ON species_egg_groups(species_id);
CREATE INDEX IF NOT EXISTS idx_egg_hatching_user ON egg_hatching(user_id);
CREATE INDEX IF NOT EXISTS idx_egg_hatching_pokemon ON egg_hatching(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_lineage_pokemon ON pokemon_lineage(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_breeding_stats_user ON breeding_stats(user_id);

-- 插入部分精灵蛋组示例数据
-- 注：实际项目中应该通过种子数据或管理后台配置
INSERT INTO species_egg_groups (species_id, egg_group_id) VALUES
    -- 皮卡丘（陆上 + 妖精）
    (25, 4),
    (25, 11),
    -- 杰尼龟（怪物 + 水中1）
    (7, 1),
    (7, 2),
    -- 小火龙（怪物 + 龙）
    (4, 1),
    (4, 9),
    -- 妙蛙种子（怪物 + 植物）
    (1, 1),
    (1, 5),
    -- 超梦（未发现 - 无法培育）
    (150, 12)
ON CONFLICT DO NOTHING;

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_breeding_centers_updated_at BEFORE UPDATE ON breeding_centers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_breeding_pairs_updated_at BEFORE UPDATE ON breeding_pairs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_egg_hatching_updated_at BEFORE UPDATE ON egg_hatching
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_breeding_stats_updated_at BEFORE UPDATE ON breeding_stats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 注释
COMMENT ON TABLE breeding_centers IS '精灵培育中心 - 每个玩家一个培育中心';
COMMENT ON TABLE breeding_pairs IS '培育配对 - 记录正在培育的精灵对';
COMMENT ON TABLE egg_groups IS '精灵蛋组 - 定义哪些精灵可以互相培育';
COMMENT ON TABLE species_egg_groups IS '精灵物种与蛋组关联';
COMMENT ON TABLE egg_hatching IS '精灵蛋孵化进度';
COMMENT ON TABLE pokemon_lineage IS '精灵家族谱系 - 记录培育历史';
COMMENT ON TABLE breeding_stats IS '培育统计数据';
