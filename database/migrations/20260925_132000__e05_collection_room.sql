-- migrate:up
-- Epic E05：精灵收藏室与装饰（REQ-00359 精灵收藏室与个性化装饰 + REQ-00403 精灵收藏室与个性化展示，合并为一套）
--
-- 一人一个收藏室：主题/背景/网格布局、精灵展示位（兼 REQ-00403 collection_items 与 REQ-00359 展示台）、
-- 装饰物品（定义 ≥ 50 种、三语名称、商店/成就/活动/收藏室升级获得）、访问记录（次数+时长）、点赞、留言、
-- 收藏室经验与等级（经验按"原因+对象"去重，防止反复摆放/取消点赞刷经验）、主题/背景解锁（等级或金币购买）。

-- ============================================================
-- 1. 主题 / 背景
-- ============================================================
CREATE TABLE IF NOT EXISTS collection_themes (
  id                VARCHAR(50) PRIMARY KEY,
  name_i18n         JSONB NOT NULL,
  description_i18n  JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview_image     VARCHAR(255),
  palette           JSONB NOT NULL DEFAULT '{}'::jsonb,        -- 客户端渲染用配色 {"floor": "#…", "wall": "#…", "accent": "#…"}
  unlock_condition  JSONB NOT NULL DEFAULT '{}'::jsonb,        -- {"roomLevel": 3} / {"achievementId": "…"} / {} 默认可用
  is_premium        BOOLEAN NOT NULL DEFAULT FALSE,
  price_coins       INTEGER CHECK (price_coins IS NULL OR price_coins > 0),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collection_backgrounds (
  id                VARCHAR(50) PRIMARY KEY,
  name_i18n         JSONB NOT NULL,
  description_i18n  JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview_image     VARCHAR(255),
  background_image  VARCHAR(255),
  css_gradient      VARCHAR(200),
  unlock_condition  JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_premium        BOOLEAN NOT NULL DEFAULT FALSE,
  price_coins       INTEGER CHECK (price_coins IS NULL OR price_coins > 0),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO collection_themes (id, name_i18n, description_i18n, palette, unlock_condition, is_premium, price_coins, sort_order) VALUES
  ('default', '{"zh": "默认", "en": "Default", "ja": "デフォルト"}', '{"zh": "简洁的展厅", "en": "A clean gallery", "ja": "シンプルな展示室"}', '{"floor": "#E8E1D5", "wall": "#FAF7F2", "accent": "#5C6BC0"}', '{}', FALSE, NULL, 1),
  ('classic', '{"zh": "经典", "en": "Classic", "ja": "クラシック"}', '{"zh": "木地板与暖色灯光", "en": "Wooden floors and warm light", "ja": "木の床と暖かい光"}', '{"floor": "#A1887F", "wall": "#EFEBE9", "accent": "#8D6E63"}', '{}', FALSE, NULL, 2),
  ('forest', '{"zh": "森林", "en": "Forest", "ja": "森"}', '{"zh": "绿意盎然的林间小屋", "en": "A cozy forest cabin", "ja": "森の中の小屋"}', '{"floor": "#7CB342", "wall": "#DCEDC8", "accent": "#33691E"}', '{"roomLevel": 3}', FALSE, NULL, 3),
  ('ocean', '{"zh": "海洋", "en": "Ocean", "ja": "海"}', '{"zh": "海底水族馆", "en": "An undersea aquarium", "ja": "海底の水族館"}', '{"floor": "#4FC3F7", "wall": "#E1F5FE", "accent": "#0277BD"}', '{"roomLevel": 5}', FALSE, NULL, 4),
  ('volcano', '{"zh": "火山", "en": "Volcano", "ja": "火山"}', '{"zh": "熔岩洞窟", "en": "A lava cavern", "ja": "溶岩の洞窟"}', '{"floor": "#5D4037", "wall": "#FFCCBC", "accent": "#D84315"}', '{"roomLevel": 5}', FALSE, NULL, 5),
  ('cyber', '{"zh": "赛博", "en": "Cyber", "ja": "サイバー"}', '{"zh": "霓虹未来展厅", "en": "A neon future hall", "ja": "ネオンの未来ホール"}', '{"floor": "#212121", "wall": "#311B92", "accent": "#00E5FF"}', '{"roomLevel": 7}', FALSE, NULL, 6),
  ('legendary', '{"zh": "传说殿堂", "en": "Legendary Hall", "ja": "伝説の殿堂"}', '{"zh": "只有最资深的收藏家才能进入", "en": "Only for the finest collectors", "ja": "最高のコレクターのために"}', '{"floor": "#FFD54F", "wall": "#FFF8E1", "accent": "#FF6F00"}', '{"roomLevel": 10}', FALSE, NULL, 7),
  ('sakura', '{"zh": "樱花庭院", "en": "Sakura Garden", "ja": "桜の庭"}', '{"zh": "限定主题，金币购买", "en": "Premium theme", "ja": "プレミアムテーマ"}', '{"floor": "#F8BBD0", "wall": "#FCE4EC", "accent": "#C2185B"}', '{}', TRUE, 3000, 8)
ON CONFLICT (id) DO NOTHING;

INSERT INTO collection_backgrounds (id, name_i18n, css_gradient, unlock_condition, is_premium, price_coins, sort_order) VALUES
  ('classic', '{"zh": "经典墙纸", "en": "Classic Wallpaper", "ja": "クラシック壁紙"}', 'linear-gradient(#FAF7F2,#E8E1D5)', '{}', FALSE, NULL, 1),
  ('meadow', '{"zh": "草原", "en": "Meadow", "ja": "草原"}', 'linear-gradient(#B3E5FC,#C5E1A5)', '{}', FALSE, NULL, 2),
  ('night_sky', '{"zh": "星空", "en": "Night Sky", "ja": "星空"}', 'linear-gradient(#0D47A1,#1A237E)', '{"roomLevel": 2}', FALSE, NULL, 3),
  ('beach', '{"zh": "沙滩", "en": "Beach", "ja": "ビーチ"}', 'linear-gradient(#81D4FA,#FFE082)', '{"roomLevel": 4}', FALSE, NULL, 4),
  ('snowfield', '{"zh": "雪原", "en": "Snowfield", "ja": "雪原"}', 'linear-gradient(#ECEFF1,#B0BEC5)', '{"roomLevel": 6}', FALSE, NULL, 5),
  ('galaxy', '{"zh": "银河", "en": "Galaxy", "ja": "銀河"}', 'linear-gradient(#4A148C,#000000)', '{}', TRUE, 5000, 6)
ON CONFLICT (id) DO NOTHING;

-- 金币购买的主题/背景
CREATE TABLE IF NOT EXISTS user_room_unlocks (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        VARCHAR(20) NOT NULL CHECK (kind IN ('theme', 'background')),
  ref_id      VARCHAR(50) NOT NULL,
  price_paid  INTEGER NOT NULL DEFAULT 0,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind, ref_id)
);

-- ============================================================
-- 2. 收藏室
-- ============================================================
CREATE TABLE IF NOT EXISTS collection_rooms (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  room_name            VARCHAR(100) NOT NULL DEFAULT 'My Collection Room',
  theme_id             VARCHAR(50) NOT NULL DEFAULT 'default' REFERENCES collection_themes(id),
  background_id        VARCHAR(50) NOT NULL DEFAULT 'classic' REFERENCES collection_backgrounds(id),
  background_image_url TEXT,
  layout_config        JSONB NOT NULL DEFAULT '{"gridSize": {"width": 10, "height": 8}}'::jsonb,
  level                INTEGER NOT NULL DEFAULT 1,
  experience           INTEGER NOT NULL DEFAULT 0,
  visitor_count        INTEGER NOT NULL DEFAULT 0,
  like_count           INTEGER NOT NULL DEFAULT 0,
  comment_count        INTEGER NOT NULL DEFAULT 0,
  is_public            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collection_rooms_public_likes ON collection_rooms (like_count DESC) WHERE is_public;
CREATE INDEX IF NOT EXISTS idx_collection_rooms_public_visitors ON collection_rooms (visitor_count DESC) WHERE is_public;
CREATE INDEX IF NOT EXISTS idx_collection_rooms_public_level ON collection_rooms (level DESC, experience DESC) WHERE is_public;

-- 展示中的精灵（REQ-00403 collection_items + REQ-00359 pokemon_display_pedestals）
CREATE TABLE IF NOT EXISTS collection_room_pokemon (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id             UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
  pokemon_instance_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  position_x          INTEGER NOT NULL DEFAULT 0,
  position_y          INTEGER NOT NULL DEFAULT 0,
  position_z          INTEGER NOT NULL DEFAULT 0,
  scale               NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (scale BETWEEN 0.5 AND 2.0),
  rotation            SMALLINT NOT NULL DEFAULT 0 CHECK (rotation BETWEEN 0 AND 359),
  display_mode        VARCHAR(20) NOT NULL DEFAULT 'idle'
                        CHECK (display_mode IN ('idle', 'walk', 'pose', 'battle', 'shiny', 'card', '3d')),
  pedestal_type       VARCHAR(20) NOT NULL DEFAULT 'basic' CHECK (pedestal_type IN ('basic', 'bronze', 'silver', 'gold', 'diamond')),
  animation_speed     NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (animation_speed BETWEEN 0.25 AND 3.0),
  custom_label        VARCHAR(100),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  added_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, pokemon_instance_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_room_pokemon_room ON collection_room_pokemon (room_id);
CREATE INDEX IF NOT EXISTS idx_collection_room_pokemon_instance ON collection_room_pokemon (pokemon_instance_id);

-- ============================================================
-- 3. 装饰物品
-- ============================================================
CREATE TABLE IF NOT EXISTS decoration_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code           VARCHAR(100) NOT NULL UNIQUE,
  name_i18n           JSONB NOT NULL,
  description_i18n    JSONB NOT NULL DEFAULT '{}'::jsonb,
  category            VARCHAR(30) NOT NULL CHECK (category IN ('furniture', 'statue', 'banner', 'floor', 'wall', 'plant', 'effect')),
  rarity              VARCHAR(20) NOT NULL CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  width               SMALLINT NOT NULL DEFAULT 1 CHECK (width BETWEEN 1 AND 4),
  height              SMALLINT NOT NULL DEFAULT 1 CHECK (height BETWEEN 1 AND 4),
  icon                VARCHAR(16),
  image_url           TEXT NOT NULL,
  thumbnail_url       TEXT,
  animation_url       TEXT,
  interaction_type    VARCHAR(20) NOT NULL DEFAULT 'static' CHECK (interaction_type IN ('static', 'rotate', 'animate', 'interactive')),
  source              VARCHAR(20) NOT NULL DEFAULT 'shop' CHECK (source IN ('shop', 'achievement', 'event', 'level', 'gift')),
  price_coins         INTEGER CHECK (price_coins IS NULL OR price_coins > 0),
  unlock_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,       -- {"roomLevel": 3} 购买/摆放前置条件
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_decoration_items_category ON decoration_items (category);
CREATE INDEX IF NOT EXISTS idx_decoration_items_rarity ON decoration_items (rarity);

-- 商店装饰：18 种基础款 × 木质/银色/金色 = 54 种
INSERT INTO decoration_items (item_code, name_i18n, description_i18n, category, rarity, width, height, icon, image_url,
                              interaction_type, source, price_coins, unlock_requirements)
SELECT b.code || '_' || m.code,
       jsonb_build_object('zh', m.zh || b.zh, 'en', m.en || ' ' || b.en, 'ja', m.ja || b.ja),
       jsonb_build_object('zh', '收藏室装饰：' || m.zh || b.zh, 'en', 'Room decoration: ' || m.en || ' ' || b.en, 'ja', 'ルーム用デコレーション'),
       b.category, m.rarity, b.w, b.h, b.icon, '/assets/decorations/' || b.code || '_' || m.code || '.png',
       b.interaction, 'shop', b.price * m.mult, m.req::jsonb
  FROM (VALUES
    ('chair', '椅子', 'Chair', 'イス', 'furniture', 1, 1, '🪑', 'static', 100),
    ('table', '桌子', 'Table', 'テーブル', 'furniture', 2, 2, '🍽️', 'static', 150),
    ('shelf', '展示架', 'Display Shelf', '陳列棚', 'furniture', 2, 1, '🗄️', 'static', 150),
    ('lamp', '台灯', 'Lamp', 'ランプ', 'furniture', 1, 1, '💡', 'animate', 100),
    ('sofa', '沙发', 'Sofa', 'ソファ', 'furniture', 2, 1, '🛋️', 'static', 200),
    ('statue_pokeball', '精灵球雕像', 'Poké Ball Statue', 'ボール像', 'statue', 1, 1, '🔴', 'rotate', 200),
    ('statue_star', '星星雕像', 'Star Statue', '星の像', 'statue', 1, 1, '⭐', 'rotate', 200),
    ('statue_dragon', '神龙雕像', 'Dragon Statue', 'ドラゴン像', 'statue', 2, 2, '🐉', 'static', 300),
    ('banner_team', '队伍旗帜', 'Team Banner', 'チームの旗', 'banner', 1, 1, '🚩', 'animate', 120),
    ('banner_victory', '胜利旗帜', 'Victory Banner', '勝利の旗', 'banner', 1, 1, '🏁', 'animate', 150),
    ('floor_carpet', '地毯', 'Carpet', 'カーペット', 'floor', 3, 2, '🟥', 'static', 150),
    ('floor_tiles', '地砖', 'Floor Tiles', '床タイル', 'floor', 2, 2, '🟫', 'static', 100),
    ('wall_frame', '相框', 'Photo Frame', 'フォトフレーム', 'wall', 1, 1, '🖼️', 'static', 100),
    ('wall_clock', '挂钟', 'Wall Clock', '掛け時計', 'wall', 1, 1, '🕰️', 'animate', 120),
    ('plant_bonsai', '盆景', 'Bonsai', '盆栽', 'plant', 1, 1, '🪴', 'static', 100),
    ('plant_flowerbed', '花坛', 'Flower Bed', '花壇', 'plant', 2, 1, '🌷', 'static', 150),
    ('effect_bubbles', '泡泡特效', 'Bubbles', 'あわ', 'effect', 1, 1, '🫧', 'animate', 200),
    ('effect_lights', '彩灯', 'Fairy Lights', 'イルミネーション', 'effect', 2, 1, '✨', 'animate', 200)
  ) AS b(code, zh, en, ja, category, w, h, icon, interaction, price)
  CROSS JOIN (VALUES
    ('wood', '木质', 'Wooden', '木の', 'common', 1, '{}'),
    ('silver', '银色', 'Silver', 'シルバー', 'rare', 4, '{"roomLevel": 3}'),
    ('gold', '金色', 'Golden', 'ゴールド', 'epic', 10, '{"roomLevel": 5}')
  ) AS m(code, zh, en, ja, rarity, mult, req)
ON CONFLICT (item_code) DO NOTHING;

-- 成就 / 活动 / 收藏室升级奖励（不可购买）
INSERT INTO decoration_items (item_code, name_i18n, description_i18n, category, rarity, width, height, icon, image_url, interaction_type, source) VALUES
  ('plant_potted_fern', '{"zh": "蕨类盆栽", "en": "Potted Fern", "ja": "シダの鉢植え"}', '{"zh": "成就「开馆大吉」奖励", "en": "Reward: Grand Opening", "ja": "実績報酬"}', 'plant', 'common', 1, 1, '🌿', '/assets/decorations/plant_potted_fern.png', 'static', 'achievement'),
  ('statue_bronze_trophy', '{"zh": "铜奖杯", "en": "Bronze Trophy", "ja": "銅のトロフィー"}', '{"zh": "成就「铜牌收藏家」奖励", "en": "Reward: Bronze Collector", "ja": "実績報酬"}', 'statue', 'uncommon', 1, 1, '🥉', '/assets/decorations/statue_bronze_trophy.png', 'rotate', 'achievement'),
  ('statue_silver_trophy', '{"zh": "银奖杯", "en": "Silver Trophy", "ja": "銀のトロフィー"}', '{"zh": "成就「银牌收藏家」奖励", "en": "Reward: Silver Collector", "ja": "実績報酬"}', 'statue', 'rare', 1, 1, '🥈', '/assets/decorations/statue_silver_trophy.png', 'rotate', 'achievement'),
  ('statue_gold_trophy', '{"zh": "金奖杯", "en": "Gold Trophy", "ja": "金のトロフィー"}', '{"zh": "成就「金牌收藏家」奖励", "en": "Reward: Gold Collector", "ja": "実績報酬"}', 'statue', 'epic', 1, 1, '🥇', '/assets/decorations/statue_gold_trophy.png', 'rotate', 'achievement'),
  ('statue_golden_pokeball', '{"zh": "黄金精灵球", "en": "Golden Poké Ball", "ja": "黄金のボール"}', '{"zh": "成就「精英训练师」奖励", "en": "Reward: Elite Trainer", "ja": "実績報酬"}', 'statue', 'legendary', 2, 2, '🏆', '/assets/decorations/statue_golden_pokeball.png', 'rotate', 'achievement'),
  ('effect_sparkle_aura', '{"zh": "闪光光环", "en": "Sparkle Aura", "ja": "キラキラオーラ"}', '{"zh": "成就「闪光收藏家」奖励", "en": "Reward: Shiny Collector", "ja": "実績報酬"}', 'effect', 'epic', 2, 2, '🌟', '/assets/decorations/effect_sparkle_aura.png', 'animate', 'achievement'),
  ('banner_fan_club', '{"zh": "粉丝团横幅", "en": "Fan Club Banner", "ja": "ファンクラブの旗"}', '{"zh": "成就「小有名气」奖励", "en": "Reward: Getting Noticed", "ja": "実績報酬"}', 'banner', 'uncommon', 2, 1, '📣', '/assets/decorations/banner_fan_club.png', 'animate', 'achievement'),
  ('fountain_crystal', '{"zh": "水晶喷泉", "en": "Crystal Fountain", "ja": "クリスタルの噴水"}', '{"zh": "成就「布置达人」奖励", "en": "Reward: Decorator", "ja": "実績報酬"}', 'furniture', 'rare', 2, 2, '⛲', '/assets/decorations/fountain_crystal.png', 'animate', 'achievement'),
  ('banner_summer_festival', '{"zh": "夏日祭旗帜", "en": "Summer Festival Banner", "ja": "夏祭りの旗"}', '{"zh": "夏日活动奖励", "en": "Summer event reward", "ja": "夏イベント報酬"}', 'banner', 'uncommon', 1, 1, '🎏', '/assets/decorations/banner_summer_festival.png', 'animate', 'event'),
  ('lantern_halloween', '{"zh": "南瓜灯", "en": "Jack-o''-Lantern", "ja": "ジャック・オー・ランタン"}', '{"zh": "万圣节活动奖励", "en": "Halloween event reward", "ja": "ハロウィンイベント報酬"}', 'effect', 'rare', 1, 1, '🎃', '/assets/decorations/lantern_halloween.png', 'animate', 'event'),
  ('level_3_reward', '{"zh": "展馆铭牌", "en": "Gallery Plaque", "ja": "ギャラリーの銘板"}', '{"zh": "收藏室 3 级奖励", "en": "Room level 3 reward", "ja": "ルームLv3報酬"}', 'wall', 'uncommon', 1, 1, '🪧', '/assets/decorations/level_3_reward.png', 'static', 'level'),
  ('level_5_reward', '{"zh": "聚光灯", "en": "Spotlight", "ja": "スポットライト"}', '{"zh": "收藏室 5 级奖励", "en": "Room level 5 reward", "ja": "ルームLv5報酬"}', 'effect', 'rare', 1, 1, '🔦', '/assets/decorations/level_5_reward.png', 'animate', 'level'),
  ('level_7_reward', '{"zh": "红毯", "en": "Red Carpet", "ja": "レッドカーペット"}', '{"zh": "收藏室 7 级奖励", "en": "Room level 7 reward", "ja": "ルームLv7報酬"}', 'floor', 'epic', 3, 1, '🟥', '/assets/decorations/level_7_reward.png', 'static', 'level'),
  ('level_10_reward', '{"zh": "传说王座", "en": "Legendary Throne", "ja": "伝説の玉座"}', '{"zh": "收藏室 10 级奖励", "en": "Room level 10 reward", "ja": "ルームLv10報酬"}', 'furniture', 'legendary', 2, 2, '👑', '/assets/decorations/level_10_reward.png', 'static', 'level')
ON CONFLICT (item_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_decorations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES decoration_items(id) ON DELETE CASCADE,
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  obtained_from VARCHAR(20) NOT NULL DEFAULT 'shop',
  obtained_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_user_decorations_user ON user_decorations (user_id);

CREATE TABLE IF NOT EXISTS room_decorations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES decoration_items(id) ON DELETE CASCADE,
  position_x    SMALLINT NOT NULL CHECK (position_x >= 0),
  position_y    SMALLINT NOT NULL CHECK (position_y >= 0),
  rotation      SMALLINT NOT NULL DEFAULT 0 CHECK (rotation IN (0, 90, 180, 270)),
  scale         NUMERIC(3,2) NOT NULL DEFAULT 1.0 CHECK (scale BETWEEN 0.5 AND 2.0),
  z_index       SMALLINT NOT NULL DEFAULT 0,
  custom_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  placed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, position_x, position_y)
);
CREATE INDEX IF NOT EXISTS idx_room_decorations_room ON room_decorations (room_id);

-- ============================================================
-- 4. 访问 / 点赞 / 留言 / 经验流水
-- ============================================================
CREATE TABLE IF NOT EXISTS room_visits (
  id               BIGSERIAL PRIMARY KEY,
  room_id          UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
  visitor_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visit_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  visit_count      INTEGER NOT NULL DEFAULT 1,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  first_visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_visited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, visitor_id, visit_date)
);
CREATE INDEX IF NOT EXISTS idx_room_visits_room_time ON room_visits (room_id, last_visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_visits_visitor ON room_visits (visitor_id, last_visited_at DESC);

-- 取消点赞只置 active = FALSE（行保留），经验只在第一次点赞时发放
CREATE TABLE IF NOT EXISTS room_likes (
  room_id    UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    VARCHAR(200) NOT NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_room_comments_room ON room_comments (room_id, created_at DESC) WHERE NOT is_deleted;

CREATE TABLE IF NOT EXISTS room_exp_log (
  room_id    UUID NOT NULL REFERENCES collection_rooms(id) ON DELETE CASCADE,
  reason     VARCHAR(30) NOT NULL,
  ref_key    VARCHAR(120) NOT NULL,
  amount     INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, reason, ref_key)
);

COMMENT ON TABLE collection_rooms IS '精灵收藏室（REQ-00359/REQ-00403）：一人一个，等级由 room_exp_log 去重后的经验换算';
COMMENT ON TABLE collection_room_pokemon IS '收藏室展示中的精灵（展示台）；精灵放生/删除时级联移除';

-- migrate:down
DROP TABLE IF EXISTS room_exp_log;
DROP TABLE IF EXISTS room_comments;
DROP TABLE IF EXISTS room_likes;
DROP TABLE IF EXISTS room_visits;
DROP TABLE IF EXISTS room_decorations;
DROP TABLE IF EXISTS user_decorations;
DROP TABLE IF EXISTS decoration_items;
DROP TABLE IF EXISTS collection_room_pokemon;
DROP TABLE IF EXISTS collection_rooms;
DROP TABLE IF EXISTS user_room_unlocks;
DROP TABLE IF EXISTS collection_backgrounds;
DROP TABLE IF EXISTS collection_themes;
