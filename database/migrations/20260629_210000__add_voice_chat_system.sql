-- REQ-00116: 精灵团队实时语音聊天系统
-- 创建语音聊天相关表

-- 语音房间表
CREATE TABLE IF NOT EXISTS voice_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100),
  creator_id VARCHAR(50) NOT NULL,
  guild_id VARCHAR(50), -- 如果是公会房间
  max_members INTEGER DEFAULT 10 CHECK (max_members BETWEEN 2 AND 50),
  password_hash VARCHAR(255), -- 可选密码
  persistent BOOLEAN DEFAULT FALSE, -- 是否持久化
  room_type VARCHAR(20) DEFAULT 'temporary' CHECK (room_type IN ('temporary', 'guild', 'battle', 'friend')),
  
  -- 配置
  config JSONB DEFAULT '{
    "bitrate": 64000,
    "codec": "opus",
    "noiseSuppression": true,
    "echoCancellation": true,
    "autoGainControl": true
  }'::jsonb,
  
  -- 状态
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  
  -- 统计
  total_joins INTEGER DEFAULT 0,
  peak_members INTEGER DEFAULT 0,
  
  -- 时间
  created_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

-- 语音房间成员表
CREATE TABLE IF NOT EXISTS voice_room_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES voice_rooms(id) ON DELETE CASCADE,
  user_id VARCHAR(50) NOT NULL,
  role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('host', 'admin', 'member', 'observer')),
  socket_id VARCHAR(100),
  
  -- 状态
  muted BOOLEAN DEFAULT FALSE,
  deafened BOOLEAN DEFAULT FALSE,
  speaking BOOLEAN DEFAULT FALSE,
  
  -- 时间
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  
  UNIQUE (room_id, user_id) WHERE left_at IS NULL
);

-- 语音聊天统计表
CREATE TABLE IF NOT EXISTS voice_chat_statistics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  room_id UUID REFERENCES voice_rooms(id) ON DELETE SET NULL,
  room_type VARCHAR(20),
  
  -- 通话质量
  duration_seconds INTEGER DEFAULT 0,
  bytes_sent BIGINT DEFAULT 0,
  bytes_received BIGINT DEFAULT 0,
  codec VARCHAR(20) DEFAULT 'opus',
  average_bitrate INTEGER DEFAULT 0,
  packet_loss REAL DEFAULT 0.0,
  jitter_ms INTEGER DEFAULT 0,
  
  -- 连接类型
  connection_type VARCHAR(20) CHECK (connection_type IN ('direct', 'turn')),
  
  -- 时间
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- TURN 凭证表（用于记录和审计）
CREATE TABLE IF NOT EXISTS turn_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  username VARCHAR(100) NOT NULL UNIQUE,
  credential_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 语音房间权限配置表
CREATE TABLE IF NOT EXISTS voice_room_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES voice_rooms(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  
  -- 权限配置
  can_speak BOOLEAN DEFAULT TRUE,
  can_hear BOOLEAN DEFAULT TRUE,
  can_kick BOOLEAN DEFAULT FALSE,
  can_ban BOOLEAN DEFAULT FALSE,
  can_change_config BOOLEAN DEFAULT FALSE,
  can_invite BOOLEAN DEFAULT TRUE,
  can_change_role BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE (room_id, role)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_voice_rooms_creator ON voice_rooms(creator_id);
CREATE INDEX IF NOT EXISTS idx_voice_rooms_guild ON voice_rooms(guild_id) WHERE guild_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_rooms_status ON voice_rooms(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_voice_rooms_type ON voice_rooms(room_type);
CREATE INDEX IF NOT EXISTS idx_voice_rooms_active ON voice_rooms(created_at) WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_voice_room_members_room ON voice_room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_voice_room_members_user ON voice_room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_room_members_active ON voice_room_members(room_id, joined_at) WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_voice_stats_user ON voice_chat_statistics(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_stats_room ON voice_chat_statistics(room_id) WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_stats_started ON voice_chat_statistics(started_at);

CREATE INDEX IF NOT EXISTS idx_turn_creds_user ON turn_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_turn_creds_expires ON turn_credentials(expires_at);
CREATE INDEX IF NOT EXISTS idx_turn_creds_username ON turn_credentials(username);

-- 评论
COMMENT ON TABLE voice_rooms IS 'REQ-00116: 语音房间表 - 支持临时/公会/战斗/好友语音房间';
COMMENT ON TABLE voice_room_members IS 'REQ-00116: 语音房间成员表 - 记录成员状态和角色';
COMMENT ON TABLE voice_chat_statistics IS 'REQ-00116: 语音聊天统计表 - 记录通话质量和时长';
COMMENT ON TABLE turn_credentials IS 'REQ-00116: TURN服务器凭证表 - 用于NAT穿透';
COMMENT ON TABLE voice_room_permissions IS 'REQ-00116: 语音房间权限配置表 - 定义各角色权限';

-- 插入默认权限配置
INSERT INTO voice_room_permissions (role, can_speak, can_hear, can_kick, can_ban, can_change_config, can_invite, can_change_role)
VALUES 
  ('host', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE),
  ('admin', TRUE, TRUE, TRUE, FALSE, TRUE, TRUE, FALSE),
  ('member', TRUE, TRUE, FALSE, FALSE, FALSE, TRUE, FALSE),
  ('observer', FALSE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE)
ON CONFLICT DO NOTHING;