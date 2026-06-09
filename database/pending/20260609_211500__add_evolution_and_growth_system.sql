-- ============================================
-- REQ-00065: 精灵进化与成长系统
-- ============================================

-- 进化规则表（定义所有精灵的进化路径）
CREATE TABLE IF NOT EXISTS evolution_rules (
    id SERIAL PRIMARY KEY,
    from_species_id INTEGER NOT NULL,
    to_species_id INTEGER NOT NULL,
    evolution_type VARCHAR(30) NOT NULL CHECK (evolution_type IN ('level', 'item', 'trade', 'condition')),
    
    -- 等级进化参数
    min_level INTEGER,
    
    -- 道具进化参数
    required_item_id INTEGER,
    item_consumed BOOLEAN DEFAULT TRUE,
    
    -- 交换进化参数
    requires_trade BOOLEAN DEFAULT FALSE,
    trade_item_id INTEGER, -- 交换时携带的道具
    
    -- 条件进化参数（JSON 格式存储复杂条件）
    conditions JSONB, -- {"friendship": 220, "time": "day", "location": "magnetic_field", "weather": "rain", "moves": ["AncientPower"]}
    
    -- 进化分支（用于分支进化）
    branch_group VARCHAR(50), -- 同一组内的进化路径互斥
    branch_priority INTEGER DEFAULT 0, -- 优先级高的优先触发
    
    -- 进化特效
    evolution_animation VARCHAR(50) DEFAULT 'standard', -- 'standard', 'special', 'legendary'
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT valid_level_evolution CHECK (
        evolution_type != 'level' OR min_level IS NOT NULL
    ),
    CONSTRAINT unique_evolution_path UNIQUE(from_species_id, to_species_id)
);

CREATE INDEX IF NOT EXISTS idx_evolution_rules_from_species ON evolution_rules(from_species_id);
CREATE INDEX IF NOT EXISTS idx_evolution_rules_to_species ON evolution_rules(to_species_id);
CREATE INDEX IF NOT EXISTS idx_evolution_rules_type ON evolution_rules(evolution_type);
CREATE INDEX IF NOT EXISTS idx_evolution_rules_branch ON evolution_rules(branch_group);

-- 精灵种族值表扩展（如果列不存在则添加）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_species' AND column_name = 'base_hp') THEN
        ALTER TABLE pokemon_species ADD COLUMN base_hp INTEGER DEFAULT 100;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_species' AND column_name = 'base_attack') THEN
        ALTER TABLE pokemon_species ADD COLUMN base_attack INTEGER DEFAULT 100;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_species' AND column_name = 'base_defense') THEN
        ALTER TABLE pokemon_species ADD COLUMN base_defense INTEGER DEFAULT 100;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_species' AND column_name = 'base_sp_attack') THEN
        ALTER TABLE pokemon_species ADD COLUMN base_sp_attack INTEGER DEFAULT 100;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_species' AND column_name = 'base_sp_defense') THEN
        ALTER TABLE pokemon_species ADD COLUMN base_sp_defense INTEGER DEFAULT 100;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_species' AND column_name = 'base_speed') THEN
        ALTER TABLE pokemon_species ADD COLUMN base_speed INTEGER DEFAULT 100;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_species' AND column_name = 'growth_rate') THEN
        ALTER TABLE pokemon_species ADD COLUMN growth_rate VARCHAR(20) DEFAULT 'medium_fast';
    END IF;
END $$;

-- 精灵实例表扩展
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_instances' AND column_name = 'experience') THEN
        ALTER TABLE pokemon_instances ADD COLUMN experience INTEGER DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_instances' AND column_name = 'friendship') THEN
        ALTER TABLE pokemon_instances ADD COLUMN friendship INTEGER DEFAULT 70 CHECK (friendship BETWEEN 0 AND 255);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_instances' AND column_name = 'total_hp') THEN
        ALTER TABLE pokemon_instances ADD COLUMN total_hp INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_instances' AND column_name = 'current_hp') THEN
        ALTER TABLE pokemon_instances ADD COLUMN current_hp INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_instances' AND column_name = 'attack') THEN
        ALTER TABLE pokemon_instances ADD COLUMN attack INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_instances' AND column_name = 'defense') THEN
        ALTER TABLE pokemon_instances ADD COLUMN defense INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_instances' AND column_name = 'sp_attack') THEN
        ALTER TABLE pokemon_instances ADD COLUMN sp_attack INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_instances' AND column_name = 'sp_defense') THEN
        ALTER TABLE pokemon_instances ADD COLUMN sp_defense INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokemon_instances' AND column_name = 'speed') THEN
        ALTER TABLE pokemon_instances ADD COLUMN speed INTEGER;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pokemon_instances_experience ON pokemon_instances(experience);
CREATE INDEX IF NOT EXISTS idx_pokemon_instances_friendship ON pokemon_instances(friendship);

-- 进化历史记录表
CREATE TABLE IF NOT EXISTS evolution_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    pokemon_instance_id INTEGER NOT NULL,
    from_species_id INTEGER NOT NULL,
    to_species_id INTEGER NOT NULL,
    evolution_type VARCHAR(30) NOT NULL,
    used_item_id INTEGER,
    
    -- 进化前属性快照
    before_cp INTEGER,
    before_level INTEGER,
    before_stats JSONB,
    
    -- 进化后属性
    after_cp INTEGER,
    after_level INTEGER,
    after_stats JSONB,
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evolution_history_user ON evolution_history(user_id);
CREATE INDEX IF NOT EXISTS idx_evolution_history_pokemon ON evolution_history(pokemon_instance_id);
CREATE INDEX IF NOT EXISTS idx_evolution_history_created ON evolution_history(created_at DESC);

-- 经验值来源日志表
CREATE TABLE IF NOT EXISTS experience_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    pokemon_instance_id INTEGER,
    source_type VARCHAR(30) NOT NULL CHECK (source_type IN ('catch', 'battle', 'task', 'item', 'evolution', 'gym', 'raid', 'trade')),
    source_id INTEGER, -- 关联的捕捉/战斗/任务 ID
    experience_gained INTEGER NOT NULL,
    bonus_multiplier DECIMAL(3,2) DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_experience_logs_user ON experience_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_experience_logs_pokemon ON experience_logs(pokemon_instance_id);
CREATE INDEX IF NOT EXISTS idx_experience_logs_source ON experience_logs(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_experience_logs_created ON experience_logs(created_at DESC);

-- 亲密度变化日志表
CREATE TABLE IF NOT EXISTS friendship_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    pokemon_instance_id INTEGER NOT NULL,
    change_type VARCHAR(30) NOT NULL CHECK (change_type IN ('walk', 'battle', 'level_up', 'item', 'gym_battle', 'raid', 'faint', 'herbal_medicine')),
    change_amount INTEGER NOT NULL,
    before_value INTEGER NOT NULL,
    after_value INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_friendship_logs_user ON friendship_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_friendship_logs_pokemon ON friendship_logs(pokemon_instance_id);

-- 进化道具表（如果不存在）
CREATE TABLE IF NOT EXISTS evolution_items (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    image_url VARCHAR(500),
    rarity VARCHAR(20) DEFAULT 'uncommon',
    created_at TIMESTAMP DEFAULT NOW()
);

-- 插入进化道具种子数据
INSERT INTO evolution_items (name, description, rarity) VALUES
('Fire Stone', 'A stone that can evolve certain Fire-type Pokemon', 'uncommon'),
('Water Stone', 'A stone that can evolve certain Water-type Pokemon', 'uncommon'),
('Thunder Stone', 'A stone that can evolve certain Electric-type Pokemon', 'uncommon'),
('Leaf Stone', 'A stone that can evolve certain Grass-type Pokemon', 'uncommon'),
('Moon Stone', 'A stone that can evolve certain Pokemon under moonlight', 'rare'),
('Sun Stone', 'A stone that can evolve certain Pokemon in sunlight', 'rare'),
('Shiny Stone', 'A stone that can evolve certain Pokemon with a bright glow', 'rare'),
('Dusk Stone', 'A stone that can evolve certain Pokemon in darkness', 'rare'),
('Dawn Stone', 'A stone that can evolve certain Pokemon at dawn', 'rare'),
('Ice Stone', 'A stone that can evolve certain Ice-type Pokemon', 'uncommon')
ON CONFLICT (name) DO NOTHING;

-- 插入进化规则种子数据（部分示例）
-- 御三家进化链
INSERT INTO evolution_rules (from_species_id, to_species_id, evolution_type, min_level, conditions, branch_group, branch_priority) VALUES
-- 妙蛙种子 → 妙蛙草 → 妙蛙花
(1, 2, 'level', 16, NULL, NULL, 0),
(2, 3, 'level', 32, NULL, NULL, 0),
-- 小火龙 → 火恐龙 → 喷火龙
(4, 5, 'level', 16, NULL, NULL, 0),
(5, 6, 'level', 32, NULL, NULL, 0),
-- 杰尼龟 → 卡咪龟 → 水箭龟
(7, 8, 'level', 16, NULL, NULL, 0),
(8, 9, 'level', 32, NULL, NULL, 0),
-- 皮卡丘 → 雷丘（道具进化）
(25, 26, 'item', NULL, NULL, NULL, 0),
-- 伊布分支进化
(133, 134, 'item', NULL, '{"item_name": "water_stone"}', 'eevee', 1),
(133, 135, 'item', NULL, '{"item_name": "thunder_stone"}', 'eevee', 1),
(133, 136, 'item', NULL, '{"item_name": "fire_stone"}', 'eevee', 1),
(133, 196, 'condition', NULL, '{"friendship": 220, "time": "day"}', 'eevee', 2),
(133, 197, 'condition', NULL, '{"friendship": 220, "time": "night"}', 'eevee', 2),
-- 胖丁 → 胖可丁
(39, 40, 'item', NULL, '{"item_name": "moon_stone"}', NULL, 0),
-- 超音蝠 → 大嘴蝠 → 叉字蝠
(41, 42, 'level', 22, NULL, NULL, 0),
(42, 169, 'condition', NULL, '{"friendship": 220}', NULL, 0),
-- 凯西 → 勇基拉 → 胡地（交换进化）
(63, 64, 'level', 16, NULL, NULL, 0),
(64, 65, 'trade', NULL, NULL, NULL, 0),
-- 鬼斯 → 鬼斯通 → 耿鬼（交换进化）
(92, 93, 'level', 25, NULL, NULL, 0),
(93, 94, 'trade', NULL, NULL, NULL, 0),
-- 小拳石 → 隆隆石 → 隆隆岩（交换进化）
(74, 75, 'level', 25, NULL, NULL, 0),
(75, 76, 'trade', NULL, NULL, NULL, 0),
-- 鲤鱼王 → 暴鲤龙
(129, 130, 'level', 20, NULL, NULL, 0),
-- 波波 → 比比鸟 → 比雕
(16, 17, 'level', 18, NULL, NULL, 0),
(17, 18, 'level', 36, NULL, NULL, 0),
-- 绿毛虫 → 铁甲蛹 → 巴大蝶
(10, 11, 'level', 7, NULL, NULL, 0),
(11, 12, 'level', 10, NULL, NULL, 0),
-- 独角虫 → 铁壳蛹 → 大针蜂
(13, 14, 'level', 7, NULL, NULL, 0),
(14, 15, 'level', 10, NULL, NULL, 0),
-- 走路草 → 臭臭花 → 霸王花/美丽花
(43, 44, 'level', 21, NULL, NULL, 0),
(44, 45, 'item', NULL, '{"item_name": "leaf_stone"}', 'gloom', 1),
(44, 182, 'item', NULL, '{"item_name": "sun_stone"}', 'gloom', 1),
-- 皮皮 → 皮可西
(35, 36, 'item', NULL, '{"item_name": "moon_stone"}', NULL, 0),
-- 六尾 → 九尾
(37, 38, 'item', NULL, '{"item_name": "fire_stone"}', NULL, 0),
-- 可达鸭 → 哥达鸭
(54, 55, 'level', 33, NULL, NULL, 0),
-- 喵喵 → 猫老大
(52, 53, 'level', 28, NULL, NULL, 0),
-- 小火马 → 烈焰马
(77, 78, 'level', 40, NULL, NULL, 0),
-- 呆呆兽 → 呆壳兽
(79, 80, 'level', 37, NULL, NULL, 0),
-- 大舌贝 → 刺甲贝
(90, 91, 'item', NULL, '{"item_name": "water_stone"}', NULL, 0),
-- 海星星 → 宝石海星
(120, 121, 'item', NULL, '{"item_name": "water_stone"}', NULL, 0),
-- 吸盘魔偶
(122, 876, 'condition', NULL, '{"move_learned": "Mimic"}', NULL, 0)
ON CONFLICT (from_species_id, to_species_id) DO NOTHING;

-- 更新部分精灵种族值示例
UPDATE pokemon_species SET 
    base_hp = 45, base_attack = 49, base_defense = 49, 
    base_sp_attack = 65, base_sp_defense = 65, base_speed = 45,
    growth_rate = 'medium_slow'
WHERE id = 1 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 60, base_attack = 62, base_defense = 63, 
    base_sp_attack = 80, base_sp_defense = 80, base_speed = 60,
    growth_rate = 'medium_slow'
WHERE id = 2 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 80, base_attack = 82, base_defense = 83, 
    base_sp_attack = 100, base_sp_defense = 100, base_speed = 80,
    growth_rate = 'medium_slow'
WHERE id = 3 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 39, base_attack = 52, base_defense = 43, 
    base_sp_attack = 60, base_sp_defense = 50, base_speed = 65,
    growth_rate = 'medium_slow'
WHERE id = 4 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 58, base_attack = 64, base_defense = 58, 
    base_sp_attack = 80, base_sp_defense = 65, base_speed = 80,
    growth_rate = 'medium_slow'
WHERE id = 5 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 78, base_attack = 84, base_defense = 78, 
    base_sp_attack = 109, base_sp_defense = 85, base_speed = 100,
    growth_rate = 'medium_slow'
WHERE id = 6 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 44, base_attack = 48, base_defense = 65, 
    base_sp_attack = 50, base_sp_defense = 64, base_speed = 43,
    growth_rate = 'medium_slow'
WHERE id = 7 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 59, base_attack = 63, base_defense = 80, 
    base_sp_attack = 65, base_sp_defense = 80, base_speed = 58,
    growth_rate = 'medium_slow'
WHERE id = 8 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 79, base_attack = 83, base_defense = 100, 
    base_sp_attack = 85, base_sp_defense = 105, base_speed = 78,
    growth_rate = 'medium_slow'
WHERE id = 9 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 35, base_attack = 55, base_defense = 40, 
    base_sp_attack = 50, base_sp_defense = 50, base_speed = 90,
    growth_rate = 'medium_fast'
WHERE id = 25 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 60, base_attack = 90, base_defense = 55, 
    base_sp_attack = 90, base_sp_defense = 80, base_speed = 110,
    growth_rate = 'medium_fast'
WHERE id = 26 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 55, base_attack = 55, base_defense = 50, 
    base_sp_attack = 45, base_sp_defense = 65, base_speed = 55,
    growth_rate = 'medium_fast'
WHERE id = 133 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 20, base_attack = 10, base_defense = 55, 
    base_sp_attack = 15, base_sp_defense = 20, base_speed = 80,
    growth_rate = 'slow'
WHERE id = 129 AND base_hp IS NULL;

UPDATE pokemon_species SET 
    base_hp = 95, base_attack = 125, base_defense = 79, 
    base_sp_attack = 60, base_sp_defense = 100, base_speed = 81,
    growth_rate = 'slow'
WHERE id = 130 AND base_hp IS NULL;

-- 注释
COMMENT ON TABLE evolution_rules IS 'REQ-00065: 进化规则表，定义所有精灵的进化路径';
COMMENT ON TABLE evolution_history IS 'REQ-00065: 进化历史记录表';
COMMENT ON TABLE experience_logs IS 'REQ-00065: 经验值来源日志表';
COMMENT ON TABLE friendship_logs IS 'REQ-00065: 亲密度变化日志表';
COMMENT ON TABLE evolution_items IS 'REQ-00065: 进化道具表';
