-- REQ-00355: 精灵进化路径可视化系统
-- 创建进化链数据结构和可视化支持表

-- 进化链定义表
CREATE TABLE IF NOT EXISTS evolution_chains (
    id SERIAL PRIMARY KEY,
    chain_name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE evolution_chains ADD COLUMN IF NOT EXISTS chain_name VARCHAR(100);
ALTER TABLE evolution_chains ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE evolution_chains ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE evolution_chains ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.evolution_chains') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('chain_name', 'description', 'created_at', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE evolution_chains ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 进化节点表（每个精灵作为节点）
CREATE TABLE IF NOT EXISTS evolution_nodes (
    id SERIAL PRIMARY KEY,
    chain_id INTEGER REFERENCES evolution_chains(id) ON DELETE CASCADE,
    pokemon_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    node_position JSONB DEFAULT '{"x": 0, "y": 0, "level": 1}',
    is_root BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE evolution_nodes ADD COLUMN IF NOT EXISTS chain_id INTEGER;
ALTER TABLE evolution_nodes ADD COLUMN IF NOT EXISTS pokemon_species_id INTEGER;
ALTER TABLE evolution_nodes ADD COLUMN IF NOT EXISTS node_position JSONB DEFAULT '{"x": 0, "y": 0, "level": 1}';
ALTER TABLE evolution_nodes ADD COLUMN IF NOT EXISTS is_root BOOLEAN DEFAULT FALSE;
ALTER TABLE evolution_nodes ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.evolution_nodes') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('chain_id', 'pokemon_species_id', 'node_position', 'is_root', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE evolution_nodes ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 进化路径表（节点之间的连接）
CREATE TABLE IF NOT EXISTS evolution_paths (
    id SERIAL PRIMARY KEY,
    from_node_id INTEGER REFERENCES evolution_nodes(id) ON DELETE CASCADE,
    to_node_id INTEGER REFERENCES evolution_nodes(id) ON DELETE CASCADE,
    evolution_type VARCHAR(50) NOT NULL CHECK (evolution_type IN ('level', 'item', 'friendship', 'time', 'location', 'trade', 'special')),
    
    -- 进化条件
    conditions JSONB NOT NULL DEFAULT '{}',
    /*
    示例：
    {
        "min_level": 16,
        "item_id": 123,
        "min_friendship": 220,
        "time_range": ["day", "night"],
        "location_ids": [1, 2, 3],
        "held_item_id": 456,
        "trade_required": false,
        "special_conditions": ["know_move_123", "gender_male"],
        "probability": 1.0
    }
    */
    
    -- 进化后属性变化预览
    stat_changes JSONB DEFAULT '{}',
    /*
    示例：
    {
        "hp": 10,
        "attack": 5,
        "defense": 3,
        "speed": 8,
        "types_added": ["flying"],
        "types_removed": [],
        "abilities": ["new_ability_1", "new_ability_2"]
    }
    */
    
    is_hidden BOOLEAN DEFAULT FALSE, -- 隐藏进化路径
    created_at TIMESTAMP DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE evolution_paths ADD COLUMN IF NOT EXISTS from_node_id INTEGER;
ALTER TABLE evolution_paths ADD COLUMN IF NOT EXISTS to_node_id INTEGER;
ALTER TABLE evolution_paths ADD COLUMN IF NOT EXISTS evolution_type VARCHAR(50);
ALTER TABLE evolution_paths ADD COLUMN IF NOT EXISTS conditions JSONB DEFAULT '{}';
ALTER TABLE evolution_paths ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.evolution_paths') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('from_node_id', 'to_node_id', 'evolution_type', 'conditions', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE evolution_paths ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 进化条件说明多语言表
CREATE TABLE IF NOT EXISTS evolution_condition_descriptions (
    id SERIAL PRIMARY KEY,
    evolution_path_id INTEGER REFERENCES evolution_paths(id) ON DELETE CASCADE,
    language_code VARCHAR(10) NOT NULL,
    description TEXT NOT NULL,
    hint TEXT, -- 提示文本
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(evolution_path_id, language_code)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE evolution_condition_descriptions ADD COLUMN IF NOT EXISTS evolution_path_id INTEGER;
ALTER TABLE evolution_condition_descriptions ADD COLUMN IF NOT EXISTS language_code VARCHAR(10);
ALTER TABLE evolution_condition_descriptions ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE evolution_condition_descriptions ADD COLUMN IF NOT EXISTS hint TEXT;
ALTER TABLE evolution_condition_descriptions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.evolution_condition_descriptions') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('evolution_path_id', 'language_code', 'description', 'hint', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE evolution_condition_descriptions ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 用户进化预览缓存表（用于快速显示进化后属性）
CREATE TABLE IF NOT EXISTS user_evolution_previews (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    target_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    preview_data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours',
    UNIQUE(user_id, pokemon_instance_id, target_species_id)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE user_evolution_previews ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE user_evolution_previews ADD COLUMN IF NOT EXISTS pokemon_instance_id UUID;
ALTER TABLE user_evolution_previews ADD COLUMN IF NOT EXISTS target_species_id INTEGER;
ALTER TABLE user_evolution_previews ADD COLUMN IF NOT EXISTS preview_data JSONB;
ALTER TABLE user_evolution_previews ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE user_evolution_previews ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours';
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.user_evolution_previews') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('user_id', 'pokemon_instance_id', 'target_species_id', 'preview_data', 'created_at', 'expires_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE user_evolution_previews ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 索引
CREATE INDEX IF NOT EXISTS idx_evolution_nodes_species ON evolution_nodes(pokemon_species_id);
CREATE INDEX IF NOT EXISTS idx_evolution_nodes_chain ON evolution_nodes(chain_id);
CREATE INDEX IF NOT EXISTS idx_evolution_paths_from ON evolution_paths(from_node_id);
CREATE INDEX IF NOT EXISTS idx_evolution_paths_to ON evolution_paths(to_node_id);
CREATE INDEX IF NOT EXISTS idx_evolution_paths_type ON evolution_paths(evolution_type);
CREATE INDEX IF NOT EXISTS idx_evolution_previews_user ON user_evolution_previews(user_id, expires_at);

-- 插入示例进化链数据
-- 皮卡丘进化链
INSERT INTO evolution_chains (chain_name, description) VALUES
('Pikachu Family', 'Pichu → Pikachu → Raichu evolution chain')
ON CONFLICT DO NOTHING;

-- 获取刚插入的 chain_id
DO $$
DECLARE
    pikachu_chain_id INTEGER;
BEGIN
    SELECT id INTO pikachu_chain_id FROM evolution_chains WHERE chain_name = 'Pikachu Family';
    
    -- 插入进化节点
    INSERT INTO evolution_nodes (chain_id, pokemon_species_id, node_position, is_root)
    SELECT * FROM (VALUES
    (pikachu_chain_id, (SELECT id FROM pokemon_species WHERE name_en = 'Pichu' LIMIT 1), '{"x": 0, "y": 0, "level": 1}'::jsonb, true),
    (pikachu_chain_id, (SELECT id FROM pokemon_species WHERE name_en = 'Pikachu' LIMIT 1), '{"x": 200, "y": 0, "level": 2}'::jsonb, false),
    (pikachu_chain_id, (SELECT id FROM pokemon_species WHERE name_en = 'Raichu' LIMIT 1), '{"x": 400, "y": 0, "level": 3}'::jsonb, false)
    ) AS v(chain_id, pokemon_species_id, node_position, is_root)
    WHERE v.pokemon_species_id IS NOT NULL  -- 种子数据中未收录的物种跳过
    ON CONFLICT DO NOTHING;
END $$;

-- 伊布进化链（多分支）
INSERT INTO evolution_chains (chain_name, description) VALUES
('Eevee Family', 'Eevee multiple evolution branches')
ON CONFLICT DO NOTHING;

DO $$
DECLARE
    eevee_chain_id INTEGER;
BEGIN
    SELECT id INTO eevee_chain_id FROM evolution_chains WHERE chain_name = 'Eevee Family';
    
    -- 伊布节点
    INSERT INTO evolution_nodes (chain_id, pokemon_species_id, node_position, is_root)
    SELECT * FROM (VALUES
    (eevee_chain_id, (SELECT id FROM pokemon_species WHERE name_en = 'Eevee' LIMIT 1), '{"x": 200, "y": 200, "level": 1}'::jsonb, true)
    ) AS v(chain_id, pokemon_species_id, node_position, is_root)
    WHERE v.pokemon_species_id IS NOT NULL  -- 种子数据中未收录的物种跳过
    ON CONFLICT DO NOTHING;
    
    -- 伊布进化分支节点
    INSERT INTO evolution_nodes (chain_id, pokemon_species_id, node_position, is_root)
    SELECT * FROM (VALUES
    (eevee_chain_id, (SELECT id FROM pokemon_species WHERE name_en = 'Vaporeon' LIMIT 1), '{"x": 0, "y": 100, "level": 2}'::jsonb, false),
    (eevee_chain_id, (SELECT id FROM pokemon_species WHERE name_en = 'Jolteon' LIMIT 1), '{"x": 100, "y": 100, "level": 2}'::jsonb, false),
    (eevee_chain_id, (SELECT id FROM pokemon_species WHERE name_en = 'Flareon' LIMIT 1), '{"x": 200, "y": 100, "level": 2}'::jsonb, false),
    (eevee_chain_id, (SELECT id FROM pokemon_species WHERE name_en = 'Espeon' LIMIT 1), '{"x": 300, "y": 100, "level": 2}'::jsonb, false),
    (eevee_chain_id, (SELECT id FROM pokemon_species WHERE name_en = 'Umbreon' LIMIT 1), '{"x": 400, "y": 100, "level": 2}'::jsonb, false)
    ) AS v(chain_id, pokemon_species_id, node_position, is_root)
    WHERE v.pokemon_species_id IS NOT NULL  -- 种子数据中未收录的物种跳过
    ON CONFLICT DO NOTHING;
END $$;

COMMENT ON TABLE evolution_chains IS '进化链定义表，定义精灵的进化链';
COMMENT ON TABLE evolution_nodes IS '进化节点表，每个精灵作为节点';
COMMENT ON TABLE evolution_paths IS '进化路径表，节点之间的进化连接';
COMMENT ON TABLE evolution_condition_descriptions IS '进化条件多语言描述表';
COMMENT ON TABLE user_evolution_previews IS '用户进化预览缓存表';
