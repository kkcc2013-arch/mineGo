-- migrate:up
-- Epic E05：玩家资料与数据统计（REQ-00327）+ 资料卡与档案展示（REQ-00387）
--
-- 资料卡配置（头像框、背景主题、签名、可见性、精选徽章/精灵、统计布局、分享码）、头像框与资料背景资源、
-- 访问日志（资料卡被谁以什么途径查看）、收藏家积分（按规则聚合，排行榜读取）。
-- 与需求文档的偏差：头像框/主题主键用 VARCHAR 代码（与称号/成就一致，便于解锁条件引用）；
-- user_id 按 users.id 使用 UUID；访问日志为普通表 + 90 天清理（原方案按月分区，量级不需要）。

CREATE TABLE IF NOT EXISTS avatar_frames (
  id               VARCHAR(50) PRIMARY KEY,
  name             JSONB NOT NULL,
  description      JSONB NOT NULL DEFAULT '{}'::jsonb,
  image_url        TEXT NOT NULL,
  style            JSONB NOT NULL DEFAULT '{}'::jsonb,      -- 客户端/卡片渲染 {"border": "#…", "glow": true}
  rarity           VARCHAR(20) NOT NULL DEFAULT 'common' CHECK (rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  unlock_condition JSONB NOT NULL DEFAULT '{}'::jsonb,       -- {"minLevel": 10} / {"achievementId": "…"} / {"collectorLevel": 3}
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profile_themes (
  id               VARCHAR(50) PRIMARY KEY,
  name             JSONB NOT NULL,
  description      JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview_url      TEXT NOT NULL,
  full_url         TEXT NOT NULL,
  style            JSONB NOT NULL DEFAULT '{}'::jsonb,       -- {"from": "#…", "to": "#…", "text": "#…"}
  theme_type       VARCHAR(20) NOT NULL DEFAULT 'static' CHECK (theme_type IN ('static', 'animated', 'seasonal')),
  rarity           VARCHAR(20) NOT NULL DEFAULT 'common',
  unlock_condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO avatar_frames (id, name, image_url, style, rarity, unlock_condition, sort_order) VALUES
  ('basic', '{"zh": "基础", "en": "Basic", "ja": "ベーシック"}', '/assets/frames/basic.png', '{"border": "#B0BEC5"}', 'common', '{}', 1),
  ('trainer_blue', '{"zh": "训练师蓝", "en": "Trainer Blue", "ja": "トレーナーブルー"}', '/assets/frames/trainer_blue.png', '{"border": "#1E88E5"}', 'common', '{"minLevel": 5}', 2),
  ('leaf', '{"zh": "新叶", "en": "Leaf", "ja": "若葉"}', '/assets/frames/leaf.png', '{"border": "#43A047"}', 'uncommon', '{"minLevel": 10}', 3),
  ('collector_silver', '{"zh": "收藏家银框", "en": "Collector Silver", "ja": "コレクターシルバー"}', '/assets/frames/collector_silver.png', '{"border": "#90A4AE", "glow": true}', 'rare', '{"collectorLevel": 3}', 4),
  ('shiny_star', '{"zh": "闪光之星", "en": "Shiny Star", "ja": "色違いの星"}', '/assets/frames/shiny_star.png', '{"border": "#FFB300", "glow": true}', 'epic', '{"achievementId": "shiny_hunter"}', 5),
  ('gym_crest', '{"zh": "道馆徽记", "en": "Gym Crest", "ja": "ジムの紋章"}', '/assets/frames/gym_crest.png', '{"border": "#E53935"}', 'rare', '{"achievementId": "first_battle"}', 6),
  ('elite', '{"zh": "精英金框", "en": "Elite Gold", "ja": "エリートゴールド"}', '/assets/frames/elite.png', '{"border": "#FFD700", "glow": true}', 'epic', '{"minLevel": 20}', 7),
  ('legend', '{"zh": "传说", "en": "Legend", "ja": "レジェンド"}', '/assets/frames/legend.png', '{"border": "#FF6F00", "glow": true, "animated": true}', 'legendary', '{"collectorLevel": 5}', 8)
ON CONFLICT (id) DO NOTHING;

INSERT INTO profile_themes (id, name, preview_url, full_url, style, theme_type, rarity, unlock_condition, sort_order) VALUES
  ('default', '{"zh": "默认", "en": "Default", "ja": "デフォルト"}', '/assets/profile-themes/default_s.png', '/assets/profile-themes/default.png', '{"from": "#3949AB", "to": "#1E88E5", "text": "#FFFFFF"}', 'static', 'common', '{}', 1),
  ('sunset', '{"zh": "日落", "en": "Sunset", "ja": "夕焼け"}', '/assets/profile-themes/sunset_s.png', '/assets/profile-themes/sunset.png', '{"from": "#FF7043", "to": "#AB47BC", "text": "#FFFFFF"}', 'static', 'common', '{"minLevel": 5}', 2),
  ('forest', '{"zh": "森林", "en": "Forest", "ja": "森"}', '/assets/profile-themes/forest_s.png', '/assets/profile-themes/forest.png', '{"from": "#2E7D32", "to": "#81C784", "text": "#FFFFFF"}', 'static', 'uncommon', '{"minLevel": 10}', 3),
  ('ocean', '{"zh": "深海", "en": "Deep Sea", "ja": "深海"}', '/assets/profile-themes/ocean_s.png', '/assets/profile-themes/ocean.png', '{"from": "#01579B", "to": "#00ACC1", "text": "#FFFFFF"}', 'animated', 'rare', '{"collectorLevel": 2}', 4),
  ('scholar', '{"zh": "学者书房", "en": "Scholar Study", "ja": "学者の書斎"}', '/assets/profile-themes/scholar_s.png', '/assets/profile-themes/scholar.png', '{"from": "#5D4037", "to": "#A1887F", "text": "#FFF8E1"}', 'static', 'epic', '{"collectorLevel": 4}', 5),
  ('aurora', '{"zh": "极光", "en": "Aurora", "ja": "オーロラ"}', '/assets/profile-themes/aurora_s.png', '/assets/profile-themes/aurora.png', '{"from": "#004D40", "to": "#7C4DFF", "text": "#FFFFFF"}', 'animated', 'legendary', '{"achievementId": "achievement_hunter_30"}', 6)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS player_profile_configs (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  avatar_frame_id     VARCHAR(50) NOT NULL DEFAULT 'basic' REFERENCES avatar_frames(id),
  background_theme_id VARCHAR(50) NOT NULL DEFAULT 'default' REFERENCES profile_themes(id),
  signature           VARCHAR(100) NOT NULL DEFAULT '',
  visibility          VARCHAR(20) NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'friends', 'private')),
  selected_badges     TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(selected_badges) <= 6),   -- 成就 ID，最多 6 个
  selected_pokemon    UUID[] NOT NULL DEFAULT '{}' CHECK (cardinality(selected_pokemon) <= 5),  -- 精选精灵，3 只（收藏家 2 级起 5 只）
  stats_layout        JSONB NOT NULL DEFAULT '{}'::jsonb,
  share_code          VARCHAR(16) UNIQUE,
  share_created_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profile_view_logs (
  id              BIGSERIAL PRIMARY KEY,
  profile_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_id       UUID REFERENCES users(id) ON DELETE SET NULL,     -- NULL 表示匿名（分享链接）
  view_source     VARCHAR(20) NOT NULL DEFAULT 'in_app' CHECK (view_source IN ('in_app', 'share_link', 'qr_code')),
  ip_hash         VARCHAR(64),
  viewed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_profile_view_logs_profile ON profile_view_logs (profile_user_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_view_logs_viewer ON profile_view_logs (viewer_id, viewed_at DESC) WHERE viewer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS collector_scores (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  score           INTEGER NOT NULL DEFAULT 0,
  rank            INTEGER NOT NULL DEFAULT 1,           -- 收藏家等级 1~5
  score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collector_scores_score ON collector_scores (score DESC, last_updated ASC);

-- 收藏家 5 级专属称号（REQ-00327 §4.2 特权）
INSERT INTO title_definitions (title_id, name, description, category, rarity, stat_bonuses, unlock_type, unlock_criteria, special_effects, display_order) VALUES
  ('legendary_collector', '{"zh": "传奇收藏家", "en": "Legendary Collector", "ja": "伝説のコレクター"}',
   '{"zh": "收藏家等级达到 5 级", "en": "Reached collector rank 5", "ja": "コレクターランク5に到達"}',
   'special', 'legendary', '{"exp_bonus": 0.05}', 'milestone', '{"collectorLevel": 5}', '{"color": "#FFD700", "glow": true}', 40)
ON CONFLICT (title_id) DO NOTHING;

-- migrate:down
DELETE FROM title_definitions WHERE title_id = 'legendary_collector';
DROP TABLE IF EXISTS collector_scores;
DROP TABLE IF EXISTS profile_view_logs;
DROP TABLE IF EXISTS player_profile_configs;
DROP TABLE IF EXISTS profile_themes;
DROP TABLE IF EXISTS avatar_frames;
