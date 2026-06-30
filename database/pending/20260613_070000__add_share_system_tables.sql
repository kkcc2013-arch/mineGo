-- REQ-00153: 游戏内截图分享与社交传播系统
-- 分享记录表和统计表

-- 分享记录表
CREATE TABLE IF NOT EXISTS share_records (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  scene VARCHAR(32) NOT NULL, -- catch/achievement/battle/pokedex/friend/custom
  platform VARCHAR(32) NOT NULL, -- wechat/weibo/twitter/facebook/system
  success BOOLEAN NOT NULL DEFAULT false,
  content_title TEXT,
  content_description TEXT,
  image_url TEXT,
  click_count INTEGER DEFAULT 0,
  last_click_at TIMESTAMPTZ,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT valid_scene CHECK (scene IN ('catch', 'achievement', 'battle', 'pokedex', 'friend', 'custom')),
  CONSTRAINT valid_platform CHECK (platform IN ('wechat', 'weibo', 'twitter', 'facebook', 'system'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_share_records_user ON share_records(user_id);
CREATE INDEX IF NOT EXISTS idx_share_records_scene ON share_records(scene);
CREATE INDEX IF NOT EXISTS idx_share_records_platform ON share_records(platform);
CREATE INDEX IF NOT EXISTS idx_share_records_created ON share_records(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_records_user_scene ON share_records(user_id, scene);

-- 分享统计汇总表（每日聚合）
CREATE TABLE IF NOT EXISTS share_daily_stats (
  id SERIAL PRIMARY KEY,
  stat_date DATE NOT NULL,
  scene VARCHAR(32) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  share_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  unique_users INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT uq_share_daily_stats UNIQUE (stat_date, scene, platform)
);

CREATE INDEX IF NOT EXISTS idx_share_daily_stats_date ON share_daily_stats(stat_date DESC);

-- 分享预设模板表
CREATE TABLE IF NOT EXISTS share_templates (
  id SERIAL PRIMARY KEY,
  template_id VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(128) NOT NULL,
  scene VARCHAR(32) NOT NULL,
  title_template TEXT,
  description_template TEXT,
  hashtags TEXT[], -- 默认标签数组
  watermark_text VARCHAR(256),
  watermark_position VARCHAR(32) DEFAULT 'bottom-right',
  platforms TEXT[] DEFAULT ARRAY['wechat', 'weibo', 'twitter', 'facebook', 'system'],
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 插入默认模板
INSERT INTO share_templates (template_id, name, scene, title_template, description_template, hashtags, watermark_text, watermark_position) VALUES
  ('catch-default', '捕捉分享', 'catch', '我捕捉到了 {pokemonName}！', '{isShiny} CP: {cp}, IV: {ivPercent}%', ARRAY['mineGo', 'PokemonGo'], 'mineGo Catch!', 'bottom-right'),
  ('achievement-default', '成就分享', 'achievement', '我完成了成就：{achievementName}！', '{description}', ARRAY['mineGo', 'Achievement'], 'mineGo Achievement', 'top-right'),
  ('battle-default', '战斗分享', 'battle', '我在道馆战斗中获胜了！', '击败了 {defenderName} 的 {defenderPokemon}', ARRAY['mineGo', 'GymBattle'], 'mineGo Battle', 'bottom-left'),
  ('pokedex-default', '图鉴分享', 'pokedex', '我的图鉴完成度：{completionPercent}%', '已收集 {collected}/{total} 种精灵', ARRAY['mineGo', 'Pokedex'], 'mineGo Pokedex', 'bottom-right'),
  ('friend-default', '好友分享', 'friend', '我在 mineGo 有 {friendCount} 个好友！', '一起探索精灵世界吧！', ARRAY['mineGo', 'Friends'], 'mineGo Friends', 'bottom-right'),
  ('custom-default', '自定义分享', 'custom', 'mineGo 游戏截图', '来自 mineGo 的分享', ARRAY['mineGo'], 'mineGo', 'bottom-right')
ON CONFLICT (template_id) DO NOTHING;

-- 用户分享偏好表
CREATE TABLE IF NOT EXISTS user_share_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_platform VARCHAR(32) DEFAULT 'system',
  show_watermark BOOLEAN DEFAULT true,
  show_player_info BOOLEAN DEFAULT true,
  auto_share_achievements BOOLEAN DEFAULT false,
  auto_share_shiny_catch BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 分享链接追踪表
CREATE TABLE IF NOT EXISTS share_links (
  id SERIAL PRIMARY KEY,
  share_code VARCHAR(32) UNIQUE NOT NULL,
  share_record_id INTEGER REFERENCES share_records(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  scene VARCHAR(32) NOT NULL,
  target_url TEXT,
  click_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_links_code ON share_links(share_code);
CREATE INDEX IF NOT EXISTS idx_share_links_user ON share_links(user_id);

-- 添加注释
COMMENT ON TABLE share_records IS '分享事件记录表';
COMMENT ON TABLE share_daily_stats IS '每日分享统计汇总表';
COMMENT ON TABLE share_templates IS '分享模板配置表';
COMMENT ON TABLE user_share_preferences IS '用户分享偏好设置表';
COMMENT ON TABLE share_links IS '分享链接追踪表';
