-- REQ-00469: 游戏实时对战回放录制与分享系统
-- 创建时间: 2026-07-07 17:05 UTC

-- 1. 扩展战斗回放表
CREATE TABLE IF NOT EXISTS battle_replay_records (
  id SERIAL PRIMARY KEY,
  battle_id UUID UNIQUE NOT NULL,
  gym_id INTEGER REFERENCES gyms(id),
  battle_type VARCHAR(20) DEFAULT 'gym', -- gym/pvp/raid
  
  -- 参与者信息
  attacker_user_id INTEGER NOT NULL REFERENCES users(id),
  attacker_team JSONB NOT NULL, -- [{pokemon_id, species, level, moves, hp_stats}]
  defender_info JSONB NOT NULL, -- {type: 'gym/pvp', user_id?, team: [...]}
  
  -- 战斗结果
  result VARCHAR(20) NOT NULL, -- win/lose/draw
  final_turns INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  
  -- 回放数据（完整事件流）
  event_stream JSONB NOT NULL, -- [{turn, timestamp, actions: [...], status_effects: [...]}]
  
  -- 元数据
  replay_version INTEGER DEFAULT 1,
  file_size_bytes INTEGER,
  compression VARCHAR(20) DEFAULT 'none', -- none/gzip/brotli
  
  -- 统计数据
  view_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '30 days'),
  
  INDEX idx_battle_replay_user (attacker_user_id, created_at DESC),
  INDEX idx_battle_replay_gym (gym_id, created_at DESC),
  INDEX idx_battle_replay_result (result, created_at DESC)
);

-- 2. 回放分享链接表
CREATE TABLE IF NOT EXISTS replay_shares (
  id SERIAL PRIMARY KEY,
  replay_id INTEGER NOT NULL REFERENCES battle_replay_records(id) ON DELETE CASCADE,
  share_code VARCHAR(12) UNIQUE NOT NULL, -- 短链接码
  
  -- 分享者信息
  shared_by_user_id INTEGER NOT NULL REFERENCES users(id),
  
  -- 分享设置
  is_public BOOLEAN DEFAULT true,
  password_hash VARCHAR(255), -- 可选密码保护
  max_views INTEGER DEFAULT 0, -- 0 表示无限制
  current_views INTEGER DEFAULT 0,
  
  -- 社交平台
  platform VARCHAR(30), -- wechat/weibo/twitter/facebook/discord/null
  share_url TEXT,
  og_image_url TEXT, -- Open Graph 图片
  
  -- 有效期
  expires_at TIMESTAMP,
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT NOW(),
  last_viewed_at TIMESTAMP,
  
  INDEX idx_replay_share_code (share_code),
  INDEX idx_replay_share_user (shared_by_user_id, created_at DESC)
);

-- 3. 回放精彩片段表（高光时刻）
CREATE TABLE IF NOT EXISTS replay_highlights (
  id SERIAL PRIMARY KEY,
  replay_id INTEGER NOT NULL REFERENCES battle_replay_records(id) ON DELETE CASCADE,
  
  -- 片段信息
  start_turn INTEGER NOT NULL,
  end_turn INTEGER NOT NULL,
  highlight_type VARCHAR(30) NOT NULL, -- critical_hit/faint/comeback/last_stand/type_effectiveness
  
  -- 描述
  title VARCHAR(200),
  description TEXT,
  
  -- 缩略图
  thumbnail_url TEXT,
  
  -- 社交统计
  share_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_replay_highlights_replay (replay_id)
);

-- 4. 回放标签表
CREATE TABLE IF NOT EXISTS replay_tags (
  id SERIAL PRIMARY KEY,
  replay_id INTEGER NOT NULL REFERENCES battle_replay_records(id) ON DELETE CASCADE,
  tag VARCHAR(50) NOT NULL,
  
  UNIQUE(replay_id, tag),
  INDEX idx_replay_tags_tag (tag)
);

-- 5. 回放评论表
CREATE TABLE IF NOT EXISTS replay_comments (
  id SERIAL PRIMARY KEY,
  replay_id INTEGER NOT NULL REFERENCES battle_replay_records(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  
  comment TEXT NOT NULL,
  parent_comment_id INTEGER REFERENCES replay_comments(id),
  
  -- 统计
  like_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_replay_comments_replay (replay_id, created_at DESC)
);

-- 6. 回放点赞表
CREATE TABLE IF NOT EXISTS replay_likes (
  id SERIAL PRIMARY KEY,
  replay_id INTEGER NOT NULL REFERENCES battle_replay_records(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  
  created_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(replay_id, user_id),
  INDEX idx_replay_likes_user (user_id, created_at DESC)
);

-- 插入触发器：自动生成分享码
CREATE OR REPLACE FUNCTION generate_replay_share_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.share_code IS NULL THEN
    NEW.share_code := UPPER(SUBSTRING(MD5(RANDOM()::TEXT || NOW()::TEXT) FROM 1 FOR 8));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_generate_share_code
  BEFORE INSERT ON replay_shares
  FOR EACH ROW
  EXECUTE FUNCTION generate_replay_share_code();

-- 插入触发器：更新回放查看次数
CREATE OR REPLACE FUNCTION update_replay_view_count()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE battle_replay_records
  SET view_count = view_count + 1
  WHERE id = NEW.replay_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_view_count
  AFTER INSERT ON replay_shares
  FOR EACH ROW
  EXECUTE FUNCTION update_replay_view_count();

COMMENT ON TABLE battle_replay_records IS 'REQ-00469: 对战回放记录表';
COMMENT ON TABLE replay_shares IS 'REQ-00469: 回放分享链接表';
COMMENT ON TABLE replay_highlights IS 'REQ-00469: 回放精彩片段表';
