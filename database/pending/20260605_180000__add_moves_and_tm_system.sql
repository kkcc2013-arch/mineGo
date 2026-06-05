-- REQ-00019: 精灵技能学习与技能机器系统
-- 创建时间: 2026-06-05 18:00
-- 说明: 创建 moves、pokemon_moves、technical_machines、tm_inventory 表，并修改 pokemon_instances 表

-- 1. 技能主表
CREATE TABLE IF NOT EXISTS moves (
  id VARCHAR(32) PRIMARY KEY,           -- 'TACKLE', 'THUNDERBOLT', 'HYPER_BEAM'
  name_zh VARCHAR(64) NOT NULL,         -- 中文名：撞击、十万伏特、破坏光线
  name_en VARCHAR(64) NOT NULL,         -- 英文名
  type VARCHAR(16) NOT NULL,            -- 属性：NORMAL, FIRE, WATER, ELECTRIC, etc.
  category VARCHAR(16) NOT NULL,        -- 类别：FAST, CHARGE
  power INT,                            -- 威力（快速技能通常 0-20，蓄力技能 40-200）
  energy_delta INT NOT NULL,            -- 能量变化（快速技能为正，蓄力技能为负）
  duration_ms INT NOT NULL,             -- 施放时间（毫秒）
  cooldown_ms INT NOT NULL,             -- 冷却时间
  dodge_window_ms INT,                  -- 闪避窗口
  accuracy_pct INT DEFAULT 100,         -- 命中率
  crit_chance_pct INT DEFAULT 0,        -- 暴击率
  effect_type VARCHAR(32),              -- 特效类型：STUN, BURN, POISON, etc.
  effect_chance_pct INT,                -- 特效触发概率
  description_zh TEXT,                  -- 技能描述
  is_legacy BOOLEAN DEFAULT false,      -- 是否为遗产技能（无法通过 TM 学习）
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_moves_type ON moves(type);
CREATE INDEX idx_moves_category ON moves(category);
CREATE INDEX idx_moves_type_category ON moves(type, category);

-- 2. 精灵种族可学习技能池
CREATE TABLE IF NOT EXISTS pokemon_moves (
  species_id INT NOT NULL REFERENCES pokemon_species(id) ON DELETE CASCADE,
  move_id VARCHAR(32) NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  learn_method VARCHAR(16) NOT NULL,    -- TM, LEVEL_UP, LEGACY, ELITE
  tm_id VARCHAR(32),                    -- 对应的 TM ID（如果通过 TM 学习）
  PRIMARY KEY (species_id, move_id)
);

CREATE INDEX idx_pokemon_moves_species ON pokemon_moves(species_id);
CREATE INDEX idx_pokemon_moves_move ON pokemon_moves(move_id);
CREATE INDEX idx_pokemon_moves_learn_method ON pokemon_moves(learn_method);

-- 3. TM 技能机器表
CREATE TABLE IF NOT EXISTS technical_machines (
  id VARCHAR(32) PRIMARY KEY,           -- 'TM01', 'TM02', ... 'TM200'
  move_id VARCHAR(32) NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  rarity VARCHAR(16) NOT NULL,          -- COMMON, RARE, EPIC, LEGENDARY
  source VARCHAR(64),                   -- 获取来源描述
  is_elite BOOLEAN DEFAULT false,       -- 是否为精英 TM（可学习遗产技能）
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_technical_machines_move ON technical_machines(move_id);
CREATE INDEX idx_technical_machines_rarity ON technical_machines(rarity);

-- 4. 玩家 TM 背包
CREATE TABLE IF NOT EXISTS tm_inventory (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tm_id VARCHAR(32) NOT NULL REFERENCES technical_machines(id) ON DELETE CASCADE,
  quantity INT NOT NULL DEFAULT 1,
  obtained_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, tm_id)
);

CREATE INDEX idx_tm_inventory_user ON tm_inventory(user_id);

-- 5. 修改 pokemon_instances 表，添加技能栏字段
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS learned_fast_moves TEXT[] DEFAULT '{}';
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS learned_charge_moves TEXT[] DEFAULT '{}';
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS move_reset_count INT DEFAULT 0;

-- 6. 插入基础技能数据（50+ 技能）
INSERT INTO moves (id, name_zh, name_en, type, category, power, energy_delta, duration_ms, cooldown_ms, dodge_window_ms, accuracy_pct, crit_chance_pct, effect_type, effect_chance_pct, description_zh) VALUES
-- 快速技能（Fast Moves）
('TACKLE', '撞击', 'Tackle', 'NORMAL', 'FAST', 5, 8, 1000, 500, 300, 100, 0, NULL, NULL, '用身体撞击对手'),
('QUICK_ATTACK', '电光一闪', 'Quick Attack', 'NORMAL', 'FAST', 8, 10, 800, 400, 250, 100, 0, NULL, NULL, '以惊人速度撞向对手'),
('SCRATCH', '抓', 'Scratch', 'NORMAL', 'FAST', 6, 8, 900, 500, 300, 100, 0, NULL, NULL, '用坚硬的爪子抓对手'),
('EMBER', '火花', 'Ember', 'FIRE', 'FAST', 10, 8, 1000, 500, 300, 100, 0, 'BURN', 10, '吐出小火焰攻击对手，可能造成灼伤'),
('FIRE_SPIN', '火焰旋涡', 'Fire Spin', 'FIRE', 'FAST', 14, 10, 1100, 600, 350, 90, 0, NULL, NULL, '用火焰旋涡困住对手'),
('WATER_GUN', '水枪', 'Water Gun', 'WATER', 'FAST', 5, 8, 900, 500, 300, 100, 0, NULL, NULL, '向对手喷射水流'),
('BUBBLE', '泡沫', 'Bubble', 'WATER', 'FAST', 12, 10, 1200, 600, 350, 100, 0, NULL, NULL, '吐出大量泡沫攻击'),
('WATERFALL', '攀瀑', 'Waterfall', 'WATER', 'FAST', 16, 8, 1200, 600, 350, 100, 0, NULL, NULL, '用巨大的瀑布冲击对手'),
('THUNDER_SHOCK', '电击', 'Thunder Shock', 'ELECTRIC', 'FAST', 6, 8, 900, 500, 300, 100, 0, 'STUN', 10, '释放电流攻击对手，可能造成麻痹'),
('SPARK', '电火花', 'Spark', 'ELECTRIC', 'FAST', 6, 9, 800, 500, 300, 100, 0, NULL, NULL, '放出电火花攻击对手'),
('VINE_WHIP', '藤鞭', 'Vine Whip', 'GRASS', 'FAST', 7, 8, 900, 500, 300, 100, 0, NULL, NULL, '用细长的藤鞭抽打对手'),
('RAZOR_LEAF', '飞叶快刀', 'Razor Leaf', 'GRASS', 'FAST', 13, 7, 1000, 600, 350, 95, 0, NULL, NULL, '发射锋利的叶子攻击'),
('ZEN_HEADBUTT', '念力头锤', 'Zen Headbutt', 'PSYCHIC', 'FAST', 12, 9, 1100, 600, 350, 90, 0, NULL, NULL, '将念力集中于头部撞向对手'),
('CONFUSION', '念力', 'Confusion', 'PSYCHIC', 'FAST', 20, 9, 1600, 800, 500, 100, 0, 'STUN', 10, '使用念力攻击对手，可能造成混乱'),
('ROCK_THROW', '落石', 'Rock Throw', 'ROCK', 'FAST', 12, 7, 1000, 600, 350, 90, 0, NULL, NULL, '向对手投掷岩石'),
('ROCK_SMASH', '碎岩', 'Rock Smash', 'FIGHTING', 'FAST', 15, 7, 1100, 600, 350, 100, 0, NULL, NULL, '用拳头击碎岩石攻击对手'),
('POISON_JAB', '毒击', 'Poison Jab', 'POISON', 'FAST', 12, 8, 1000, 500, 300, 100, 0, 'POISON', 30, '用毒触手攻击对手，可能造成中毒'),
('BITE', '咬住', 'Bite', 'DARK', 'FAST', 6, 8, 900, 500, 300, 100, 0, 'STUN', 10, '用锋利的牙齿咬住对手，可能造成畏缩'),
('FEINT_ATTACK', '突袭', 'Feint Attack', 'DARK', 'FAST', 12, 8, 1000, 500, 300, 100, 0, NULL, NULL, '趁对手不备发动攻击'),
('DRAGON_BREATH', '龙息', 'Dragon Breath', 'DRAGON', 'FAST', 6, 9, 800, 500, 300, 100, 0, 'STUN', 30, '吐出龙之气息，可能造成麻痹'),
('SHADOW_CLAW', '暗影爪', 'Shadow Claw', 'GHOST', 'FAST', 9, 11, 800, 400, 250, 100, 0, NULL, NULL, '用暗影之爪撕裂对手'),
('HEX', '祸不单行', 'Hex', 'GHOST', 'FAST', 10, 12, 1000, 500, 300, 100, 0, NULL, NULL, '对异常状态对手造成更大伤害'),
('ICE_SHARD', '冰砾', 'Ice Shard', 'ICE', 'FAST', 12, 8, 1000, 500, 300, 100, 0, NULL, NULL, '用尖锐的冰块攻击对手'),
('FROST_BREATH', '冰冻之风', 'Frost Breath', 'ICE', 'FAST', 10, 6, 1000, 600, 350, 90, 0, NULL, NULL, '吹出冰冷的气息攻击对手'),
('METAL_CLAW', '金属爪', 'Metal Claw', 'STEEL', 'FAST', 8, 7, 900, 500, 300, 100, 0, NULL, NULL, '用钢铁之爪攻击对手'),

-- 蓄力技能（Charge Moves）
('THUNDERBOLT', '十万伏特', 'Thunderbolt', 'ELECTRIC', 'CHARGE', 80, -50, 2500, 1500, 800, 100, 0, 'STUN', 10, '释放强力电流攻击对手，可能造成麻痹'),
('THUNDER', '打雷', 'Thunder', 'ELECTRIC', 'CHARGE', 100, -60, 3000, 2000, 1000, 70, 0, 'STUN', 30, '召唤雷电轰击对手，可能造成麻痹'),
('DISCHARGE', '放电', 'Discharge', 'ELECTRIC', 'CHARGE', 65, -33, 2200, 1200, 700, 100, 0, 'STUN', 20, '释放电流攻击范围内所有对手'),
('FLAMETHROWER', '喷射火焰', 'Flamethrower', 'FIRE', 'CHARGE', 90, -55, 2700, 1500, 800, 100, 0, 'BURN', 10, '喷出猛烈的火焰，可能造成灼伤'),
('FIRE_BLAST', '大字爆炎', 'Fire Blast', 'FIRE', 'CHARGE', 140, -80, 3500, 2500, 1200, 90, 0, 'BURN', 30, '发射大字形火焰攻击对手'),
('HEAT_WAVE', '热风', 'Heat Wave', 'FIRE', 'CHARGE', 80, -50, 2500, 1500, 800, 95, 0, 'BURN', 20, '吹出灼热的气息攻击对手'),
('HYDRO_PUMP', '水炮', 'Hydro Pump', 'WATER', 'CHARGE', 130, -75, 3300, 2300, 1100, 85, 0, NULL, NULL, '喷射强力水流攻击对手'),
('SURF', '冲浪', 'Surf', 'WATER', 'CHARGE', 65, -40, 2400, 1400, 750, 100, 0, NULL, NULL, '召唤巨浪攻击对手'),
('ICE_BEAM', '冰冻光束', 'Ice Beam', 'ICE', 'CHARGE', 90, -55, 2700, 1500, 800, 100, 0, 'FREEZE', 10, '发射冰冻光线，可能冻结对手'),
('BLIZZARD', '暴风雪', 'Blizzard', 'ICE', 'CHARGE', 130, -75, 3300, 2300, 1100, 70, 0, 'FREEZE', 20, '召唤暴风雪攻击对手'),
('PSYCHIC', '精神强念', 'Psychic', 'PSYCHIC', 'CHARGE', 90, -55, 2800, 1500, 800, 100, 0, NULL, NULL, '使用强大的念力攻击对手'),
('PSYCHO_CUT', '精神利刃', 'Psycho Cut', 'PSYCHIC', 'CHARGE', 70, -35, 2000, 1200, 700, 100, 25, NULL, NULL, '用精神之刃切开对手'),
('SOLAR_BEAM', '阳光烈焰', 'Solar Beam', 'GRASS', 'CHARGE', 180, -100, 4000, 3000, 1500, 100, 0, NULL, NULL, '聚集阳光发射强力光束'),
('ENERGY_BALL', '能量球', 'Energy Ball', 'GRASS', 'CHARGE', 90, -50, 2600, 1500, 800, 100, 0, NULL, NULL, '发射能量球攻击对手'),
('SLUDGE_BOMB', '污泥炸弹', 'Sludge Bomb', 'POISON', 'CHARGE', 80, -50, 2500, 1500, 800, 100, 0, 'POISON', 30, '投掷污泥炸弹，可能造成中毒'),
('HYPER_BEAM', '破坏光线', 'Hyper Beam', 'NORMAL', 'CHARGE', 150, -80, 3800, 2800, 1400, 90, 0, NULL, NULL, '发射强力破坏光线攻击对手'),
('GIGA_IMPACT', '破坏冲撞', 'Giga Impact', 'NORMAL', 'CHARGE', 200, -100, 4500, 3500, 1700, 90, 0, NULL, NULL, '全身力气撞向对手'),
('STONE_EDGE', '尖石攻击', 'Stone Edge', 'ROCK', 'CHARGE', 100, -55, 2700, 1500, 800, 80, 25, NULL, NULL, '用尖锐的岩石攻击对手，高暴击率'),
('ROCK_SLIDE', '岩崩', 'Rock Slide', 'ROCK', 'CHARGE', 80, -45, 2400, 1400, 750, 90, 0, 'STUN', 20, '降下岩石攻击对手'),
('EARTHQUAKE', '地震', 'Earthquake', 'GROUND', 'CHARGE', 120, -65, 3000, 2000, 1000, 100, 0, NULL, NULL, '引发强烈地震攻击对手'),
('CLOSE_COMBAT', '近身战', 'Close Combat', 'FIGHTING', 'CHARGE', 100, -45, 2500, 1400, 750, 100, 0, NULL, NULL, '近距离猛烈攻击对手'),
('AURA_SPHERE', '波导弹', 'Aura Sphere', 'FIGHTING', 'CHARGE', 90, -50, 2600, 1500, 800, 100, 0, NULL, NULL, '发射波动弹攻击对手，必中'),
('DARK_PULSE', '恶之波动', 'Dark Pulse', 'DARK', 'CHARGE', 80, -50, 2500, 1500, 800, 100, 0, 'STUN', 20, '释放恶念波动攻击对手，可能畏缩'),
('FOUL_PLAY', '欺诈', 'Foul Play', 'DARK', 'CHARGE', 70, -35, 2000, 1200, 700, 100, 0, NULL, NULL, '利用对手的力量攻击对手'),
('DRAGON_PULSE', '龙之波动', 'Dragon Pulse', 'DRAGON', 'CHARGE', 90, -50, 2600, 1500, 800, 100, 0, NULL, NULL, '释放龙之波动攻击对手'),
('OUTRAGE', '逆鳞', 'Outrage', 'DRAGON', 'CHARGE', 110, -60, 3000, 1800, 900, 100, 0, 'CONFUSE', 100, '释放龙之怒火，攻击后自身混乱'),
('SHADOW_BALL', '暗影球', 'Shadow Ball', 'GHOST', 'CHARGE', 100, -55, 2700, 1500, 800, 100, 0, NULL, NULL, '发射暗影球攻击对手'),
('DAZZLING_GLEAM', '魔法闪耀', 'Dazzling Gleam', 'FAIRY', 'CHARGE', 110, -60, 3000, 1800, 900, 100, 0, NULL, NULL, '释放耀眼光芒攻击对手'),
('FLASH_CANNON', '加农光炮', 'Flash Cannon', 'STEEL', 'CHARGE', 100, -55, 2700, 1500, 800, 100, 0, NULL, NULL, '发射光束攻击对手'),
('IRON_HEAD', '铁头', 'Iron Head', 'STEEL', 'CHARGE', 80, -50, 2500, 1500, 800, 100, 0, 'STUN', 30, '用钢铁之头撞向对手，可能畏缩')
ON CONFLICT (id) DO NOTHING;

-- 7. 插入 TM 数据
INSERT INTO technical_machines (id, move_id, rarity, source, is_elite) VALUES
-- 普通 TM (COMMON)
('TM01', 'TACKLE', 'COMMON', '补给站掉落', false),
('TM02', 'SCRATCH', 'COMMON', '补给站掉落', false),
('TM03', 'QUICK_ATTACK', 'COMMON', '补给站掉落', false),
('TM04', 'EMBER', 'COMMON', '补给站掉落', false),
('TM05', 'WATER_GUN', 'COMMON', '补给站掉落', false),
('TM06', 'THUNDER_SHOCK', 'COMMON', '补给站掉落', false),
('TM07', 'VINE_WHIP', 'COMMON', '补给站掉落', false),
('TM08', 'BITE', 'COMMON', '补给站掉落', false),
('TM09', 'POISON_JAB', 'COMMON', '补给站掉落', false),
('TM10', 'ICE_SHARD', 'COMMON', '补给站掉落', false),

-- 稀有 TM (RARE)
('TM13', 'THUNDERBOLT', 'RARE', '3星 Raid 奖励', false),
('TM14', 'FLAMETHROWER', 'RARE', '3星 Raid 奖励', false),
('TM15', 'ICE_BEAM', 'RARE', '3星 Raid 奖励', false),
('TM16', 'PSYCHIC', 'RARE', '3星 Raid 奖励', false),
('TM17', 'SLUDGE_BOMB', 'RARE', '3星 Raid 奖励', false),
('TM18', 'DARK_PULSE', 'RARE', '3星 Raid 奖励', false),
('TM19', 'DRAGON_PULSE', 'RARE', '3星 Raid 奖励', false),
('TM20', 'SHADOW_BALL', 'RARE', '3星 Raid 奖励', false),

-- 史诗 TM (EPIC)
('TM24', 'THUNDER', 'EPIC', '5星 Raid 奖励', false),
('TM25', 'FIRE_BLAST', 'EPIC', '5星 Raid 奖励', false),
('TM26', 'BLIZZARD', 'EPIC', '5星 Raid 奖励', false),
('TM27', 'HYDRO_PUMP', 'EPIC', '5星 Raid 奖励', false),
('TM28', 'HYPER_BEAM', 'EPIC', '5星 Raid 奖励', false),
('TM29', 'EARTHQUAKE', 'EPIC', '5星 Raid 奖励', false),
('TM30', 'STONE_EDGE', 'EPIC', '5星 Raid 奖励', false),
('TM31', 'OUTRAGE', 'EPIC', '5星 Raid 奖励', false),

-- 传奇 TM (LEGENDARY)
('TM50', 'SOLAR_BEAM', 'LEGENDARY', 'Mega Raid 奖励', false),
('TM51', 'GIGA_IMPACT', 'LEGENDARY', 'Mega Raid 奖励', false),
('TM52', 'DAZZLING_GLEAM', 'LEGENDARY', 'Mega Raid 奖励', false),

-- 精英 TM (ELITE - 可学习遗产技能)
('ELITE_TM', 'SOLAR_BEAM', 'LEGENDARY', '精英 Raid 奖励', true)
ON CONFLICT (id) DO NOTHING;

-- 8. 为常见种族插入技能池（示例：皮卡丘、小火龙、杰尼龟、妙蛙种子等）
-- 皮卡丘 (species_id = 25)
INSERT INTO pokemon_moves (species_id, move_id, learn_method, tm_id) VALUES
(25, 'THUNDER_SHOCK', 'LEVEL_UP', NULL),
(25, 'QUICK_ATTACK', 'LEVEL_UP', NULL),
(25, 'THUNDERBOLT', 'TM', 'TM13'),
(25, 'THUNDER', 'TM', 'TM24'),
(25, 'DISCHARGE', 'TM', NULL),
(25, 'IRON_HEAD', 'TM', NULL),
(25, 'THUNDER_PUNCH', 'LEGACY', NULL)
ON CONFLICT (species_id, move_id) DO NOTHING;

-- 小火龙 (species_id = 4)
INSERT INTO pokemon_moves (species_id, move_id, learn_method, tm_id) VALUES
(4, 'EMBER', 'LEVEL_UP', NULL),
(4, 'SCRATCH', 'LEVEL_UP', NULL),
(4, 'FIRE_SPIN', 'LEVEL_UP', NULL),
(4, 'FLAMETHROWER', 'TM', 'TM14'),
(4, 'FIRE_BLAST', 'TM', 'TM25'),
(4, 'HEAT_WAVE', 'TM', NULL),
(4, 'DRAGON_BREATH', 'TM', NULL),
(4, 'ROCK_SLIDE', 'TM', NULL)
ON CONFLICT (species_id, move_id) DO NOTHING;

-- 杰尼龟 (species_id = 7)
INSERT INTO pokemon_moves (species_id, move_id, learn_method, tm_id) VALUES
(7, 'WATER_GUN', 'LEVEL_UP', NULL),
(7, 'TACKLE', 'LEVEL_UP', NULL),
(7, 'BUBBLE', 'LEVEL_UP', NULL),
(7, 'WATERFALL', 'LEVEL_UP', NULL),
(7, 'HYDRO_PUMP', 'TM', 'TM27'),
(7, 'SURF', 'TM', NULL),
(7, 'ICE_BEAM', 'TM', 'TM15'),
(7, 'BLIZZARD', 'TM', 'TM26')
ON CONFLICT (species_id, move_id) DO NOTHING;

-- 妙蛙种子 (species_id = 1)
INSERT INTO pokemon_moves (species_id, move_id, learn_method, tm_id) VALUES
(1, 'VINE_WHIP', 'LEVEL_UP', NULL),
(1, 'TACKLE', 'LEVEL_UP', NULL),
(1, 'RAZOR_LEAF', 'LEVEL_UP', NULL),
(1, 'ENERGY_BALL', 'TM', NULL),
(1, 'SOLAR_BEAM', 'TM', 'TM50'),
(1, 'SLUDGE_BOMB', 'TM', 'TM17')
ON CONFLICT (species_id, move_id) DO NOTHING;

-- 通用技能池（所有精灵都可学习）
INSERT INTO pokemon_moves (species_id, move_id, learn_method, tm_id)
SELECT 
  ps.id,
  m.id,
  CASE 
    WHEN m.id IN ('TACKLE', 'SCRATCH', 'QUICK_ATTACK') THEN 'LEVEL_UP'
    ELSE 'TM'
  END,
  CASE
    WHEN m.id = 'TACKLE' THEN 'TM01'
    WHEN m.id = 'SCRATCH' THEN 'TM02'
    WHEN m.id = 'QUICK_ATTACK' THEN 'TM03'
    ELSE NULL
  END
FROM pokemon_species ps
CROSS JOIN moves m
WHERE m.category = 'FAST' 
  AND m.power <= 10
  AND NOT EXISTS (
    SELECT 1 FROM pokemon_moves pm 
    WHERE pm.species_id = ps.id AND pm.move_id = m.id
  )
ON CONFLICT (species_id, move_id) DO NOTHING;

-- 提交迁移记录
INSERT INTO schema_migrations (version, description, applied_at)
VALUES (
  '20260605_180000',
  'Add moves, pokemon_moves, technical_machines, tm_inventory tables',
  NOW()
)
ON CONFLICT (version) DO NOTHING;
