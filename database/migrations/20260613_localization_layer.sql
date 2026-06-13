-- ============================================================
-- REQ-00167: Game Content Localization Database Layer
-- Migration: 20260613_localization_layer.sql
-- ============================================================

-- ============================================================
-- 1. EXTEND POKEMON_SPECIES TABLE
-- ============================================================

-- Add Japanese name and multi-language descriptions
ALTER TABLE pokemon_species 
  ADD COLUMN IF NOT EXISTS name_ja VARCHAR(50),
  ADD COLUMN IF NOT EXISTS description_en TEXT,
  ADD COLUMN IF NOT EXISTS description_ja TEXT;

-- Add comment for documentation
COMMENT ON COLUMN pokemon_species.name_ja IS 'Japanese name for Pokémon species';
COMMENT ON COLUMN pokemon_species.description_en IS 'English description for Pokedex';
COMMENT ON COLUMN pokemon_species.description_ja IS 'Japanese description for Pokedex';

-- ============================================================
-- 2. CREATE CONTENT_LOCALIZATIONS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS content_localizations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_type    VARCHAR(50) NOT NULL,  -- 'pokemon', 'move', 'item', 'event', 'achievement'
  content_id      VARCHAR(100) NOT NULL, -- Corresponding content ID (species_id, move_id, etc.)
  field_name      VARCHAR(50) NOT NULL,  -- 'name', 'description', 'flavor_text'
  language        VARCHAR(10) NOT NULL,  -- 'zh-CN', 'en-US', 'ja-JP'
  translation     TEXT NOT NULL,
  metadata        JSONB,                 -- Optional: {verified: true, translator: 'name'}
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  
  CONSTRAINT uq_content_localization 
    UNIQUE (content_type, content_id, field_name, language)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_localization_content 
  ON content_localizations(content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_localization_lang 
  ON content_localizations(language);
CREATE INDEX IF NOT EXISTS idx_localization_type_field 
  ON content_localizations(content_type, field_name);

COMMENT ON TABLE content_localizations IS 'Universal translation storage for all game content types';

-- ============================================================
-- 3. CREATE ITEMS TABLE WITH LOCALIZATION SUPPORT
-- ============================================================

CREATE TABLE IF NOT EXISTS items (
  id              VARCHAR(50) PRIMARY KEY,  -- 'POKE_BALL', 'GREAT_BALL', 'POTION', etc.
  category        VARCHAR(30) NOT NULL,     -- 'BALL', 'POTION', 'BERRY', 'EVOLUTION', 'SPECIAL'
  name_zh         VARCHAR(100) NOT NULL,
  name_en         VARCHAR(100) NOT NULL,
  name_ja         VARCHAR(100),
  description_zh  TEXT,
  description_en  TEXT,
  description_ja  TEXT,
  effect_type     VARCHAR(50),              -- 'CATCH_BONUS', 'HEAL', 'STAT_BOOST'
  effect_value    DECIMAL(10,4),
  shop_price      INTEGER,                  -- Price in coins
  is_premium      BOOLEAN NOT NULL DEFAULT FALSE,
  sprite_url      VARCHAR(500),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_premium ON items(is_premium) WHERE is_premium = TRUE;

COMMENT ON TABLE items IS 'Game items with multi-language support';

-- ============================================================
-- 4. CREATE POKEMON_MOVES TABLE WITH LOCALIZATION
-- ============================================================

CREATE TABLE IF NOT EXISTS pokemon_moves (
  id              VARCHAR(50) PRIMARY KEY,  -- 'TACKLE', 'QUICK_ATTACK', 'THUNDERBOLT'
  move_type       pokemon_type_enum NOT NULL,
  category        VARCHAR(20) NOT NULL,     -- 'FAST', 'CHARGE'
  name_zh         VARCHAR(100) NOT NULL,
  name_en         VARCHAR(100) NOT NULL,
  name_ja         VARCHAR(100),
  description_zh  TEXT,
  description_en  TEXT,
  description_ja  TEXT,
  power           SMALLINT,
  energy_cost     SMALLINT,
  energy_gain     SMALLINT,                 -- For fast moves
  cooldown_ms     INTEGER NOT NULL DEFAULT 1000,
  duration_ms     INTEGER NOT NULL DEFAULT 500,
  accuracy        DECIMAL(5,4) DEFAULT 1.0,
  critical_chance DECIMAL(5,4) DEFAULT 0.05,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_moves_type ON pokemon_moves(move_type);
CREATE INDEX IF NOT EXISTS idx_moves_category ON pokemon_moves(category);

COMMENT ON TABLE pokemon_moves IS 'Pokémon moves/skills with multi-language support';

-- ============================================================
-- 5. UPDATE EVENTS TABLE FOR LOCALIZATION
-- ============================================================

-- Check if events table exists and add localization columns
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'events') THEN
    ALTER TABLE events 
      ADD COLUMN IF NOT EXISTS title_en TEXT,
      ADD COLUMN IF NOT EXISTS title_ja TEXT,
      ADD COLUMN IF NOT EXISTS description_en TEXT,
      ADD COLUMN IF NOT EXISTS description_ja TEXT;
  END IF;
END $$;

-- ============================================================
-- 6. CREATE LOCALIZED VIEW FOR POKEMON
-- ============================================================

CREATE OR REPLACE VIEW v_pokemon_species_localized AS
SELECT 
  ps.id,
  ps.name_zh as name_zh_cn,
  ps.name_en as name_en_us,
  COALESCE(ps.name_ja, ps.name_en) as name_ja_jp,
  ps.type1,
  ps.type2,
  ps.rarity,
  ps.base_attack,
  ps.base_defense,
  ps.base_hp,
  ps.base_catch_rate,
  ps.base_flee_rate,
  ps.candy_to_evolve,
  ps.evolves_to,
  ps.evolves_with_item,
  ps.evolution_level,
  ps.biomes,
  ps.sprite_url,
  ps.sprite_shiny_url,
  ps.description_zh,
  ps.description_en,
  ps.description_ja,
  ps.created_at
FROM pokemon_species ps;

COMMENT ON VIEW v_pokemon_species_localized IS 'Localized view for Pokémon species with fallback logic';

-- ============================================================
-- 7. INSERT SAMPLE LOCALIZATION DATA
-- ============================================================

-- Sample Pokémon names in Japanese (first 10 species as example)
UPDATE pokemon_species SET name_ja = 'フシギダネ', description_ja = '生まれたときから背中に植物の種があって、少しずつ大きく育つ。', description_en = 'A strange seed was planted on its back at birth. The plant sprouts and grows with this Pokémon.' WHERE id = 1;
UPDATE pokemon_species SET name_ja = 'フシギソウ', description_ja = '背中のつぼみが大きくなり、特徴的な香りを放つようになる。', description_en = 'When the bulb on its back grows large, it appears to lose the ability to stand on its hind legs.' WHERE id = 2;
UPDATE pokemon_species SET name_ja = 'フシギバナ', description_ja = '背中の花は太陽の光を浴びると、気持ちよさそうに揺れ動く。', description_en = 'The flower on its back catches the suns rays. The sunlight is then absorbed and used for energy.' WHERE id = 3;
UPDATE pokemon_species SET name_ja = 'ヒトカゲ', description_ja = '生まれたときからしっぽに炎が灯っている。元気な時は炎が強く燃え上がる。', description_en = 'The flame at the tip of its tail makes a sound as it burns. You can only hear it in quiet places.' WHERE id = 4;
UPDATE pokemon_species SET name_ja = 'リザード', description_ja = '激しい戦いを好む荒々しい性格。敵を倒すまで容赦しない。', description_en = 'It is very hot headed by nature, so it constantly seeks opponents. It calms down only when it wins.' WHERE id = 5;
UPDATE pokemon_species SET name_ja = 'リザードン', description_ja = '強い相手を倒すために存在する。炎のブレスで全てを焼き尽くす。', description_en = 'It spits fire that is hot enough to melt boulders. It may cause forest fires by blowing flames.' WHERE id = 6;
UPDATE pokemon_species SET name_ja = 'ゼニガメ', description_ja = '生まれた直後は甲羅が柔らかい。甲羅は時間をかけて硬くなる。', description_en = 'When it retracts its long neck into its shell, it squirts out water with vigorous force.' WHERE id = 7;
UPDATE pokemon_species SET name_ja = 'カメール', description_ja = '甲羅は非常に硬く、鉄板にも匹敵する。激しい水流を噴射できる。', description_en = 'It is recognized as a symbol of longevity. If its shell has algae on it, that Wartortle is very old.' WHERE id = 8;
UPDATE pokemon_species SET name_ja = 'カメックス', description_ja = '甲羅のロケット砲から強力な水流を発射し、厚い鉄板も貫く。', description_en = 'The jets of water it spouts from the rocket cannons on its shell can punch through thick steel.' WHERE id = 9;
UPDATE pokemon_species SET name_ja = 'キャタピー', description_ja = '緑色の体に大きな目のような模様がある。外敵をびっくりさせるため。', description_en = 'For protection, it uses its red antenna to release a stench that drives away enemies.' WHERE id = 10;
UPDATE pokemon_species SET name_ja = 'ピカチュウ', description_ja = '電気ネズミポケモン。頬の電気袋で電気を貯め、敵に放電する。', description_en = 'When several of these Pokémon gather, their electricity could build and cause lightning storms.' WHERE id = 25;
UPDATE pokemon_species SET name_ja = 'ライチュウ', description_ja = '電気袋は強力な電気を蓄える。電気を放つと尻尾が接地する。', description_en = 'If the electric pouches in its cheeks become fully charged, both cheeks will become extremely large.' WHERE id = 26;

-- Insert sample items with localization
INSERT INTO items (id, category, name_zh, name_en, name_ja, description_zh, description_en, description_ja, effect_type, shop_price, sprite_url)
VALUES 
  ('POKE_BALL', 'BALL', '精灵球', 'Poké Ball', 'モンスターボール', '基础的精灵捕捉工具', 'A basic Pokéball for catching Pokémon', 'ポケモンを捕まえるための基本的なボール', 'CATCH_BONUS', 100, '/assets/items/pokeball.png'),
  ('GREAT_BALL', 'BALL', '超级球', 'Great Ball', 'スーパーボール', '比精灵球更好的捕捉效果', 'A better ball with a higher catch rate', 'より高い捕獲率を持つボール', 'CATCH_BONUS', 300, '/assets/items/greatball.png'),
  ('ULTRA_BALL', 'BALL', '高级球', 'Ultra Ball', 'ハイパーボール', '极高质量的精灵球', 'An ultra-high performance ball', '非常に高性能なボール', 'CATCH_BONUS', 600, '/assets/items/ultraball.png'),
  ('POTION', 'POTION', '伤药', 'Potion', 'キズぐすり', '恢复精灵20点HP', 'Restores 20 HP to a Pokémon', 'ポケモンのHPを20回復する', 'HEAL', 100, '/assets/items/potion.png'),
  ('SUPER_POTION', 'POTION', '好伤药', 'Super Potion', 'いいキズぐすり', '恢复精灵50点HP', 'Restores 50 HP to a Pokémon', 'ポケモンのHPを50回復する', 'HEAL', 300, '/assets/items/superpotion.png'),
  ('REVIVE', 'POTION', '复活药', 'Revive', 'げんきのかたまり', '复活濒死的精灵并恢复一半HP', 'Revives a fainted Pokémon with half HP', 'ひんしのポケモンを半分のHPで復活させる', 'REVIVE', 500, '/assets/items/revive.png'),
  ('RAZZ_BERRY', 'BERRY', '木莓果', 'Razz Berry', 'ラズのみ', '喂给精灵后更容易捕捉', 'Makes a Pokémon easier to catch', 'ポケモンに与えると捕まえやすくなる', 'CATCH_BONUS', 50, '/assets/items/razzberry.png'),
  ('SUN_STONE', 'EVOLUTION', '日之石', 'Sun Stone', 'たいようのいし', '用于进化特定精灵', 'Evolves certain species of Pokémon', '特定のポケモンを進化させる', 'EVOLUTION', 1000, '/assets/items/sunstone.png')
ON CONFLICT (id) DO UPDATE SET 
  name_ja = EXCLUDED.name_ja,
  description_en = EXCLUDED.description_en,
  description_ja = EXCLUDED.description_ja;

-- Insert sample moves with localization
INSERT INTO pokemon_moves (id, move_type, category, name_zh, name_en, name_ja, description_zh, description_en, description_ja, power, energy_cost, energy_gain, cooldown_ms)
VALUES 
  ('TACKLE', 'NORMAL', 'FAST', '撞击', 'Tackle', 'たいあたり', '用全身撞击对手', 'A full-body charge attack', '全身で相手にぶつかる', 5, NULL, 5, 1000),
  ('QUICK_ATTACK', 'NORMAL', 'FAST', '电光一闪', 'Quick Attack', 'でんこうせっか', '以肉眼无法看清的速度攻击', 'An extremely fast attack', '目に見えない速さで攻撃', 8, NULL, 8, 800),
  ('SCRATCH', 'NORMAL', 'FAST', '抓', 'Scratch', 'ひっかく', '用爪子抓伤对手', 'Attacks with sharp claws', '鋭い爪で相手をひっかく', 6, NULL, 6, 500),
  ('THUNDERBOLT', 'ELECTRIC', 'CHARGE', '十万伏特', 'Thunderbolt', '１０まんボルト', '释放强大的电流攻击', 'A powerful electric attack', '強力な電流を放つ', 80, 50, NULL, 1500),
  ('FLAMETHROWER', 'FIRE', 'CHARGE', '喷射火焰', 'Flamethrower', 'かえんほうしゃ', '喷射强烈的火焰', 'A fierce fire attack', '激しい炎を吐く', 70, 50, NULL, 1600),
  ('WATER_GUN', 'WATER', 'FAST', '水枪', 'Water Gun', 'みずでっぽう', '喷射水流攻击', 'Shoots water at the target', '水を勢いよく噴射する', 5, NULL, 5, 500),
  ('HYDRO_PUMP', 'WATER', 'CHARGE', '水炮', 'Hydro Pump', 'ハイドロポンプ', '发射巨大的水流', 'A huge blast of water', '巨大な水の砲弾を発射', 90, 60, NULL, 1900),
  ('SOLAR_BEAM', 'GRASS', 'CHARGE', '阳光烈焰', 'Solar Beam', 'ソーラービーム', '积蓄阳光发射强力光束', 'A powerful beam of sunlight', '太陽の光を集めて放つ強力な光線', 100, 65, NULL, 2000)
ON CONFLICT (id) DO UPDATE SET
  name_ja = EXCLUDED.name_ja,
  description_en = EXCLUDED.description_en,
  description_ja = EXCLUDED.description_ja;

-- ============================================================
-- 8. CREATE HELPER FUNCTION FOR LOCALIZATION
-- ============================================================

CREATE OR REPLACE FUNCTION get_localized_content(
  p_content_type VARCHAR(50),
  p_content_id VARCHAR(100),
  p_field_name VARCHAR(50),
  p_language VARCHAR(10)
) RETURNS TEXT AS $$
DECLARE
  v_translation TEXT;
BEGIN
  SELECT translation INTO v_translation
  FROM content_localizations
  WHERE content_type = p_content_type
    AND content_id = p_content_id
    AND field_name = p_field_name
    AND language = p_language;
  
  RETURN v_translation;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_localized_content IS 'Retrieve localized content by type, id, field and language';

-- ============================================================
-- 9. CREATE TRIGGER FOR AUTO-UPDATE TIMESTAMP
-- ============================================================

CREATE OR REPLACE FUNCTION update_localization_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_content_localizations_updated
  BEFORE UPDATE ON content_localizations
  FOR EACH ROW
  EXECUTE FUNCTION update_localization_timestamp();

-- ============================================================
-- 10. GRANT PERMISSIONS (if needed)
-- ============================================================

-- GRANT SELECT, INSERT, UPDATE ON content_localizations TO game_user;
-- GRANT SELECT, INSERT, UPDATE ON items TO game_user;
-- GRANT SELECT, INSERT, UPDATE ON pokemon_moves TO game_user;
