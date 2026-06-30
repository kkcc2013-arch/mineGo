-- ============================================================
-- REQ-00091: Pokémon Equipment System
-- Migration: 20260614_081000__add_equipment_system.sql
-- ============================================================

-- ============================================================
-- 1. EQUIPMENT TEMPLATES TABLE (装备模板)
-- ============================================================

CREATE TABLE IF NOT EXISTS equipment_templates (
  id SERIAL PRIMARY KEY,
  name_zh VARCHAR(100) NOT NULL,
  name_en VARCHAR(100) NOT NULL,
  name_ja VARCHAR(100),
  
  -- 装备类型：weapon(武器), armor(护甲), accessory(饰品), 
  -- skill_disc(技能盘), evolution_stone(进化石), held_item(携带道具)
  type VARCHAR(50) NOT NULL CHECK (type IN (
    'weapon', 'armor', 'accessory', 'skill_disc', 'evolution_stone', 'held_item'
  )),
  
  -- 稀有度：common(普通), uncommon(优秀), rare(稀有), epic(史诗), legendary(传说)
  rarity VARCHAR(20) NOT NULL CHECK (rarity IN (
    'common', 'uncommon', 'rare', 'epic', 'legendary'
  )),
  
  -- 基础属性：{"attack": 10, "defense": 5, "speed": 3, "hp": 20, "critical_rate": 0.05}
  base_stats JSONB NOT NULL DEFAULT '{}',
  
  -- 套装ID（可选）
  set_id INTEGER,
  
  -- 元素亲和：water, fire, grass, electric, psychic, ice, dragon, dark, fairy, null(通用)
  element_affinity VARCHAR(20) CHECK (element_affinity IN (
    'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 
    'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 
    'dragon', 'dark', 'steel', 'fairy'
  )),
  
  -- 强化上限
  max_level SMALLINT DEFAULT 10,
  
  -- 描述
  description_zh TEXT,
  description_en TEXT,
  description_ja TEXT,
  
  -- 图标URL
  icon_url VARCHAR(255),
  
  -- 商店价格（精币）
  shop_price INTEGER,
  
  -- 是否可出售
  sellable BOOLEAN DEFAULT TRUE,
  
  -- 出售价格（精币）
  sell_price INTEGER,
  
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_equipment_templates_type ON equipment_templates(type);
CREATE INDEX IF NOT EXISTS idx_equipment_templates_rarity ON equipment_templates(rarity);
CREATE INDEX IF NOT EXISTS idx_equipment_templates_set ON equipment_templates(set_id) WHERE set_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_equipment_templates_element ON equipment_templates(element_affinity) WHERE element_affinity IS NOT NULL;

COMMENT ON TABLE equipment_templates IS '装备模板表：定义所有装备的基础属性';
COMMENT ON COLUMN equipment_templates.type IS '装备类型：weapon(武器), armor(护甲), accessory(饰品), skill_disc(技能盘), evolution_stone(进化石), held_item(携带道具)';
COMMENT ON COLUMN equipment_templates.rarity IS '稀有度：common(普通), uncommon(优秀), rare(稀有), epic(史诗), legendary(传说)';
COMMENT ON COLUMN equipment_templates.base_stats IS '基础属性JSON：{"attack": 10, "defense": 5, "speed": 3}';
COMMENT ON COLUMN equipment_templates.element_affinity IS '元素亲和：装备仅适用于该属性的精灵，null表示通用';

-- ============================================================
-- 2. EQUIPMENT SETS TABLE (装备套装)
-- ============================================================

CREATE TABLE IF NOT EXISTS equipment_sets (
  id SERIAL PRIMARY KEY,
  name_zh VARCHAR(100) NOT NULL,
  name_en VARCHAR(100) NOT NULL,
  name_ja VARCHAR(100),
  
  -- 激活套装效果所需件数
  pieces_required SMALLINT DEFAULT 2 CHECK (pieces_required BETWEEN 2 AND 6),
  
  -- 2件效果
  bonus_2_pieces JSONB,
  
  -- 4件效果（可选）
  bonus_4_pieces JSONB,
  
  -- 6件效果（可选）
  bonus_6_pieces JSONB,
  
  description_zh TEXT,
  description_en TEXT,
  description_ja TEXT,
  
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE equipment_sets IS '装备套装表：定义套装效果';
COMMENT ON COLUMN equipment_sets.bonus_2_pieces IS '2件套装效果：{"attack": 20, "water_damage_boost": 0.15}';

-- ============================================================
-- 3. PLAYER EQUIPMENT TABLE (玩家装备实例)
-- ============================================================

CREATE TABLE IF NOT EXISTS player_equipment (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES equipment_templates(id),
  
  -- 当前强化等级
  current_level SMALLINT NOT NULL DEFAULT 1,
  
  -- 当前属性（基础属性 × 等级系数）
  current_stats JSONB NOT NULL DEFAULT '{}',
  
  -- 是否已装备
  is_equipped BOOLEAN NOT NULL DEFAULT FALSE,
  
  -- 装备到的精灵ID
  equipped_to_pokemon_id BIGINT REFERENCES pokemon_instances(id) ON DELETE SET NULL,
  
  -- 获取时间
  acquired_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  -- 获取来源：raid, quest, shop, event, drop, gift
  acquired_from VARCHAR(50) DEFAULT 'drop',
  
  -- 来源ID（如raid_id, quest_id等）
  source_id VARCHAR(100),
  
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  -- 约束：同一精灵同一类型只能装备一件
  CONSTRAINT uq_pokemon_equipment_type UNIQUE (equipped_to_pokemon_id, template_id) 
    WHERE is_equipped = TRUE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_player_equipment_user ON player_equipment(user_id);
CREATE INDEX IF NOT EXISTS idx_player_equipment_template ON player_equipment(template_id);
CREATE INDEX IF NOT EXISTS idx_player_equipment_pokemon ON player_equipment(equipped_to_pokemon_id) WHERE is_equipped = TRUE;
CREATE INDEX IF NOT EXISTS idx_player_equipment_equipped ON player_equipment(is_equipped) WHERE is_equipped = TRUE;

COMMENT ON TABLE player_equipment IS '玩家装备实例表：记录玩家拥有的每件装备';

-- ============================================================
-- 4. EQUIPMENT UPGRADES TABLE (装备强化记录)
-- ============================================================

CREATE TABLE IF NOT EXISTS equipment_upgrades (
  id BIGSERIAL PRIMARY KEY,
  equipment_id BIGINT NOT NULL REFERENCES player_equipment(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  from_level SMALLINT NOT NULL,
  to_level SMALLINT NOT NULL,
  
  -- 消耗资源：{"stardust": 1000, "coins": 500}
  cost_resources JSONB NOT NULL,
  
  -- 是否成功
  success BOOLEAN NOT NULL,
  
  -- 失败原因（如果失败）
  failure_reason VARCHAR(100),
  
  upgraded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_equipment_upgrades_equipment ON equipment_upgrades(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_upgrades_user ON equipment_upgrades(user_id, upgraded_at DESC);

COMMENT ON TABLE equipment_upgrades IS '装备强化记录表：记录每次强化尝试';

-- ============================================================
-- 5. INSERT SAMPLE EQUIPMENT SETS
-- ============================================================

INSERT INTO equipment_sets (id, name_zh, name_en, name_ja, pieces_required, bonus_2_pieces, bonus_4_pieces, description_zh, description_en) VALUES
(1, '水之守护者', 'Water Guardian', '水の守護者', 2, 
 '{"water_damage_boost": 0.15, "water_resistance": 0.10}', 
 '{"water_damage_boost": 0.25, "water_resistance": 0.20, "hp": 50}',
 '水系精灵专属套装，提升水系技能伤害和抗性', 'Water-type set boosting water move damage and resistance'),
 
(2, '烈焰战神', 'Flame Warlord', '炎の戦神', 2,
 '{"fire_damage_boost": 0.15, "burn_chance": 0.05}',
 '{"fire_damage_boost": 0.30, "burn_chance": 0.10, "attack": 30}',
 '火系精灵专属套装，提升火系技能伤害和灼烧概率', 'Fire-type set boosting fire move damage and burn chance'),

(3, '雷霆之怒', 'Thunder Wrath', '雷の怒り', 2,
 '{"electric_damage_boost": 0.15, "paralyze_chance": 0.05}',
 '{"electric_damage_boost": 0.25, "paralyze_chance": 0.10, "speed": 20}',
 '电系精灵专属套装，提升电系技能伤害和麻痹概率', 'Electric-type set boosting electric move damage and paralyze chance'),

(4, '自然之力', 'Nature Force', '自然の力', 2,
 '{"grass_damage_boost": 0.15, "heal_bonus": 0.10}',
 '{"grass_damage_boost": 0.25, "heal_bonus": 0.20, "defense": 25}',
 '草系精灵专属套装，提升草系技能伤害和治疗效果', 'Grass-type set boosting grass move damage and healing'),

(5, '冰霜之心', 'Frost Heart', '氷の心', 2,
 '{"ice_damage_boost": 0.15, "freeze_chance": 0.05}',
 '{"ice_damage_boost": 0.25, "freeze_chance": 0.10, "critical_rate": 0.05}',
 '冰系精灵专属套装，提升冰系技能伤害和冻结概率', 'Ice-type set boosting ice move damage and freeze chance'),

(6, '龙之传说', 'Dragon Legend', '龍の伝説', 2,
 '{"dragon_damage_boost": 0.20, "all_resistance": 0.05}',
 '{"dragon_damage_boost": 0.35, "all_resistance": 0.10, "attack": 40, "defense": 30}',
 '龙系精灵专属套装，全面提升战斗能力', 'Dragon-type set with comprehensive combat bonuses'),

(7, '暗影猎手', 'Shadow Hunter', '影の狩人', 2,
 '{"dark_damage_boost": 0.15, "critical_damage": 0.10}',
 '{"dark_damage_boost": 0.25, "critical_damage": 0.20, "critical_rate": 0.08}',
 '恶系精灵专属套装，提升暴击伤害', 'Dark-type set boosting critical damage'),

(8, '妖精之翼', 'Fairy Wings', '妖精の翼', 2,
 '{"fairy_damage_boost": 0.15, "fairy_resistance": 0.15}',
 '{"fairy_damage_boost": 0.25, "fairy_resistance": 0.25, "heal_bonus": 0.15}',
 '妖精系精灵专属套装，提升妖精技能和抗性', 'Fairy-type set boosting fairy moves and resistance')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 6. INSERT SAMPLE EQUIPMENT TEMPLATES
-- ============================================================

-- 武器类装备
INSERT INTO equipment_templates (name_zh, name_en, name_ja, type, rarity, base_stats, set_id, element_affinity, max_level, description_zh, description_en, shop_price, sell_price) VALUES
-- 普通武器
('训练师之剑', 'Trainer Sword', 'トレーナーソード', 'weapon', 'common', '{"attack": 5, "critical_rate": 0.02}', NULL, NULL, 5, '新手训练师的标准装备', 'Standard equipment for new trainers', 100, 30),
('铁质护手', 'Iron Gauntlet', 'アイアンガントレット', 'weapon', 'common', '{"attack": 8}', NULL, NULL, 5, '坚固的铁质护手', 'Sturdy iron gauntlets', 150, 45),

-- 优秀武器
('锐利之刃', 'Sharp Blade', '鋭い刃', 'weapon', 'uncommon', '{"attack": 12, "critical_rate": 0.03}', NULL, NULL, 7, '锋利的刀刃，提升攻击力', 'Sharp blade boosting attack', 300, 90),
('火焰短剑', 'Fire Dagger', 'ファイアダガー', 'weapon', 'uncommon', '{"attack": 10, "fire_damage_boost": 0.05}', 2, 'fire', 7, '蕴含火焰之力的短剑', 'Dagger imbued with fire power', 400, 120),

-- 稀有武器
('水之长剑', 'Water Longsword', '水の長剣', 'weapon', 'rare', '{"attack": 20, "water_damage_boost": 0.10}', 1, 'water', 10, '水系精灵专属武器', 'Water-type exclusive weapon', 800, 240),
('雷电之刃', 'Thunder Blade', '雷電の刃', 'weapon', 'rare', '{"attack": 18, "electric_damage_boost": 0.10, "speed": 5}', 3, 'electric', 10, '蕴含雷电之力的利刃', 'Blade imbued with thunder', 800, 240),
('草叶之剑', 'Grass Blade', '草葉の剣', 'weapon', 'rare', '{"attack": 15, "grass_damage_boost": 0.10, "heal_bonus": 0.05}', 4, 'grass', 10, '自然之力凝聚的剑', 'Sword of natural power', 800, 240),

-- 史诗武器
('冰霜巨剑', 'Frost Greatsword', '氷霜の大剣', 'weapon', 'epic', '{"attack": 35, "ice_damage_boost": 0.15, "freeze_chance": 0.05}', 5, 'ice', 12, '传说中的冰霜之剑', 'Legendary frost sword', 2000, 600),
('龙牙之刃', 'Dragon Fang Blade', '竜牙の刃', 'weapon', 'epic', '{"attack": 40, "dragon_damage_boost": 0.20, "critical_rate": 0.05}', 6, 'dragon', 12, '由龙牙打造的利刃', 'Blade forged from dragon fang', 2500, 750),

-- 传说武器
('神龙之剑', 'Divine Dragon Sword', '神龍の剣', 'weapon', 'legendary', '{"attack": 60, "dragon_damage_boost": 0.30, "critical_rate": 0.10, "critical_damage": 0.20}', 6, 'dragon', 15, '传说中的神龙之剑', 'Legendary divine dragon sword', 10000, 3000),

-- 护甲类装备
('新手护甲', 'Novice Armor', '初心者の鎧', 'armor', 'common', '{"defense": 5, "hp": 20}', NULL, NULL, 5, '训练师的起步护甲', 'Starting armor for trainers', 100, 30),
('铁质护甲', 'Iron Armor', 'アイアンアーマー', 'armor', 'common', '{"defense": 10, "hp": 30}', NULL, NULL, 5, '坚固的铁甲', 'Sturdy iron armor', 200, 60),
('水之护甲', 'Water Armor', '水の鎧', 'armor', 'uncommon', '{"defense": 15, "hp": 40, "water_resistance": 0.10}', 1, 'water', 7, '水系精灵专属护甲', 'Water-type exclusive armor', 400, 120),
('烈焰战甲', 'Flame Armor', '炎の戦甲', 'armor', 'rare', '{"defense": 25, "hp": 60, "fire_resistance": 0.15}', 2, 'fire', 10, '火系精灵专属战甲', 'Fire-type exclusive armor', 800, 240),
('雷霆护甲', 'Thunder Armor', '雷の鎧', 'armor', 'rare', '{"defense": 22, "hp": 50, "electric_resistance": 0.15}', 3, 'electric', 10, '电系精灵专属护甲', 'Electric-type exclusive armor', 800, 240),
('龙鳞护甲', 'Dragon Scale Armor', 'ドラゴンスケイル', 'armor', 'epic', '{"defense": 40, "hp": 100, "all_resistance": 0.10}', 6, 'dragon', 12, '由龙鳞打造的护甲', 'Armor forged from dragon scales', 2500, 750),
('神圣龙甲', 'Holy Dragon Armor', '聖なる龍甲', 'armor', 'legendary', '{"defense": 60, "hp": 150, "all_resistance": 0.20, "defense_boost": 0.15}', 6, 'dragon', 15, '传说中的神圣龙甲', 'Legendary holy dragon armor', 10000, 3000),

-- 饰品类装备
('速度护符', 'Speed Charm', 'スピードチャーム', 'accessory', 'common', '{"speed": 5}', NULL, NULL, 5, '提升移动速度的护符', 'Charm boosting speed', 100, 30),
('暴击戒指', 'Critical Ring', 'クリティカルリング', 'accessory', 'uncommon', '{"critical_rate": 0.05, "critical_damage": 0.10}', NULL, NULL, 7, '提升暴击能力的戒指', 'Ring boosting critical hits', 300, 90),
('水之护符', 'Water Charm', '水の護符', 'accessory', 'rare', '{"speed": 10, "water_damage_boost": 0.08}', 1, 'water', 10, '水系精灵专属护符', 'Water-type exclusive charm', 600, 180),
('火焰项链', 'Flame Necklace', '炎のネックレス', 'accessory', 'rare', '{"attack": 10, "fire_damage_boost": 0.10}', 2, 'fire', 10, '火系精灵专属项链', 'Fire-type exclusive necklace', 600, 180),
('龙之心', 'Dragon Heart', '龍の心', 'accessory', 'epic', '{"attack": 20, "defense": 15, "dragon_damage_boost": 0.15}', 6, 'dragon', 12, '蕴含龙之力量的饰品', 'Accessory with dragon power', 2000, 600),

-- 技能盘类装备
('技能增强盘', 'Move Boost Disc', '技増強ディスク', 'skill_disc', 'common', '{"move_damage_boost": 0.05}', NULL, NULL, 5, '提升技能伤害', 'Boosts move damage', 150, 45),
('水系技能盘', 'Water Move Disc', '水技ディスク', 'skill_disc', 'rare', '{"water_move_damage": 0.15, "move_cooldown_reduction": 0.05}', 1, 'water', 10, '水系技能增强', 'Boosts water moves', 800, 240),
('火系技能盘', 'Fire Move Disc', '炎技ディスク', 'skill_disc', 'rare', '{"fire_move_damage": 0.15, "burn_duration": 1}', 2, 'fire', 10, '火系技能增强', 'Boosts fire moves', 800, 240),

-- 进化石类装备
('经验之石', 'EXP Stone', '経験値の石', 'evolution_stone', 'common', '{"exp_bonus": 0.10}', NULL, NULL, 5, '提升经验获取', 'Boosts EXP gain', 200, 60),
('进化加速石', 'Evolution Accelerator', '進化加速石', 'evolution_stone', 'uncommon', '{"evolution_speed": 0.20, "candy_reduction": 0.10}', NULL, NULL, 7, '加速精灵进化', 'Accelerates evolution', 500, 150),

-- 携带道具类装备
('生命果实', 'HP Berry', 'HPベリー', 'held_item', 'common', '{"hp_restore": 20}', NULL, NULL, 5, '战斗中自动恢复HP', 'Auto HP restore in battle', 100, 30),
('攻击糖果', 'Attack Candy', '攻撃キャンディ', 'held_item', 'uncommon', '{"attack": 5}', NULL, NULL, 7, '永久提升攻击', 'Permanent attack boost', 300, 90),
('防御糖果', 'Defense Candy', '防御キャンディ', 'held_item', 'uncommon', '{"defense": 5}', NULL, NULL, 7, '永久提升防御', 'Permanent defense boost', 300, 90),
('速度糖果', 'Speed Candy', '速度キャンディ', 'held_item', 'uncommon', '{"speed": 3}', NULL, NULL, 7, '永久提升速度', 'Permanent speed boost', 300, 90),
('幸运蛋', 'Lucky Egg', 'ラッキーエッグ', 'held_item', 'rare', '{"exp_bonus": 0.50, "catch_bonus": 0.05}', NULL, NULL, 10, '大幅提升经验获取', 'Greatly boosts EXP gain', 1000, 300),
('护盾碎片', 'Shield Shard', 'シールド破片', 'held_item', 'rare', '{"damage_reduction": 0.10}', NULL, NULL, 10, '减少受到的伤害', 'Reduces damage taken', 800, 240)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 7. CREATE HELPER FUNCTIONS
-- ============================================================

-- 计算装备当前属性
CREATE OR REPLACE FUNCTION calculate_equipment_stats(
  p_template_id INTEGER,
  p_level SMALLINT
) RETURNS JSONB AS $$
DECLARE
  v_base_stats JSONB;
  v_level_multiplier FLOAT;
  v_result JSONB;
  v_key TEXT;
  v_value FLOAT;
BEGIN
  -- 获取基础属性
  SELECT base_stats INTO v_base_stats
  FROM equipment_templates
  WHERE id = p_template_id;
  
  IF v_base_stats IS NULL THEN
    RETURN '{}'::JSONB;
  END IF;
  
  -- 计算等级系数：1 + (level - 1) * 0.1
  v_level_multiplier := 1 + (p_level - 1) * 0.1;
  
  -- 计算每个属性
  v_result := '{}'::JSONB;
  FOR v_key, v_value IN SELECT * FROM jsonb_each_text(v_base_stats)
  LOOP
    v_result := jsonb_set(
      v_result,
      ARRAY[v_key],
      to_jsonb(FLOOR(v_value::FLOAT * v_level_multiplier))
    );
  END LOOP;
  
  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_equipment_stats IS '计算装备在指定等级的属性';

-- 获取精灵已装备的所有装备
CREATE OR REPLACE FUNCTION get_pokemon_equipment(
  p_pokemon_id BIGINT
) RETURNS TABLE (
  equipment_id BIGINT,
  template_id INTEGER,
  type VARCHAR(50),
  rarity VARCHAR(20),
  current_level SMALLINT,
  current_stats JSONB,
  set_id INTEGER,
  element_affinity VARCHAR(20)
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    pe.id,
    pe.template_id,
    et.type,
    et.rarity,
    pe.current_level,
    pe.current_stats,
    et.set_id,
    et.element_affinity
  FROM player_equipment pe
  JOIN equipment_templates et ON pe.template_id = et.id
  WHERE pe.equipped_to_pokemon_id = p_pokemon_id
    AND pe.is_equipped = TRUE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_pokemon_equipment IS '获取精灵已装备的所有装备';

-- ============================================================
-- 8. CREATE TRIGGERS
-- ============================================================

-- 自动更新 updated_at
CREATE OR REPLACE FUNCTION update_equipment_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_player_equipment_updated
  BEFORE UPDATE ON player_equipment
  FOR EACH ROW
  EXECUTE FUNCTION update_equipment_timestamp();

-- 装备时自动计算当前属性
CREATE OR REPLACE FUNCTION calculate_equipment_stats_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  NEW.current_stats := calculate_equipment_stats(NEW.template_id, NEW.current_level);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_player_equipment_calc_stats
  BEFORE INSERT OR UPDATE OF current_level ON player_equipment
  FOR EACH ROW
  EXECUTE FUNCTION calculate_equipment_stats_on_insert();

-- ============================================================
-- 9. GRANT PERMISSIONS (if needed)
-- ============================================================

-- GRANT SELECT, INSERT, UPDATE ON equipment_templates TO game_user;
-- GRANT SELECT, INSERT, UPDATE ON equipment_sets TO game_user;
-- GRANT SELECT, INSERT, UPDATE ON player_equipment TO game_user;
-- GRANT SELECT, INSERT ON equipment_upgrades TO game_user;
