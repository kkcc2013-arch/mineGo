-- ============================================================
-- Voice Chat Tables - 语音聊天系统数据表
-- REQ-00116: 精灵团队实时语音聊天系统
-- ============================================================

-- 语音房间表
CREATE TABLE IF NOT EXISTS voice_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100),
  creator_id VARCHAR(50) NOT NULL,
  guild_id VARCHAR(50), -- 如果是公会房间
  max_members INTEGER DEFAULT 10,
  password_hash VARCHAR(255), -- 可选密码（bcrypt hash）
  persistent BOOLEAN DEFAULT FALSE, -- 是否持久化
  config JSONB DEFAULT '{
    "bitrate": 64000,
    "codec": "opus",
    "noiseSuppression": true,
    "echoCancellation": true
  }'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  closed_at TIMESTAMP WITH TIME ZONE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_voice_rooms_creator ON voice_rooms(creator_id);
CREATE INDEX IF NOT EXISTS idx_voice_rooms_guild ON voice_rooms(guild_id);
CREATE INDEX IF NOT EXISTS idx_voice_rooms_active ON voice_rooms(closed_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_voice_rooms_created ON voice_rooms(created_at DESC);

-- 语音房间成员表
CREATE TABLE IF NOT EXISTS voice_room_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES voice_rooms(id) ON DELETE CASCADE,
  user_id VARCHAR(50) NOT NULL,
  role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('host', 'admin', 'member', 'observer')),
  socket_id VARCHAR(100),
  muted BOOLEAN DEFAULT FALSE,
  deafened BOOLEAN DEFAULT FALSE,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  left_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(room_id, user_id) WHERE left_at IS NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_voice_room_members_room ON voice_room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_voice_room_members_user ON voice_room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_room_members_active ON voice_room_members(room_id) WHERE left_at IS NULL;

-- 语音聊天统计表
CREATE TABLE IF NOT EXISTS voice_chat_statistics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  room_id UUID REFERENCES voice_rooms(id) ON DELETE SET NULL,
  duration_seconds INTEGER, -- 通话时长
  bytes_sent BIGINT, -- 发送字节数
  bytes_received BIGINT, -- 接收字节数
  codec VARCHAR(20),
  average_bitrate INTEGER,
  packet_loss REAL, -- 丢包率
  jitter REAL, -- 抖动
  latency_ms INTEGER, -- 平均延迟
  quality_score INTEGER, -- 质量评分 0-100
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_voice_stats_user ON voice_chat_statistics(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_stats_room ON voice_chat_statistics(room_id);
CREATE INDEX IF NOT EXISTS idx_voice_stats_started ON voice_chat_statistics(started_at DESC);

-- TURN 凭证表（用于记录和审计）
CREATE TABLE IF NOT EXISTS turn_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  username VARCHAR(100) NOT NULL,
  credential_hash VARCHAR(255) NOT NULL,
  ip_address INET, -- 客户端 IP
  user_agent TEXT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  revoked_at TIMESTAMP WITH TIME ZONE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_turn_creds_user ON turn_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_turn_creds_expires ON turn_credentials(expires_at);
CREATE INDEX IF NOT EXISTS idx_turn_creds_active ON turn_credentials(user_id) 
  WHERE revoked_at IS NULL AND expires_at > NOW();

-- 语音房间事件日志表
CREATE TABLE IF NOT EXISTS voice_room_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES voice_rooms(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL, -- created, joined, left, kicked, muted, config_changed
  user_id VARCHAR(50),
  target_user_id VARCHAR(50), -- 被操作的用户
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_voice_events_room ON voice_room_events(room_id);
CREATE INDEX IF NOT EXISTS idx_voice_events_type ON voice_room_events(event_type);
CREATE INDEX IF NOT EXISTS idx_voice_events_time ON voice_room_events(created_at DESC);

-- 评论
COMMENT ON TABLE voice_rooms IS '语音房间表 - 存储语音聊天房间信息';
COMMENT ON TABLE voice_room_members IS '语音房间成员表 - 记录房间成员及状态';
COMMENT ON TABLE voice_chat_statistics IS '语音聊天统计表 - 记录通话质量和统计数据';
COMMENT ON TABLE turn_credentials IS 'TURN服务器凭证表 - 记录发放的凭证用于审计';
COMMENT ON TABLE voice_room_events IS '语音房间事件日志表 - 记录房间内发生的事件';

COMMENT ON COLUMN voice_rooms.persistent IS '是否为持久房间（如公会语音频道）';
COMMENT ON COLUMN voice_room_members.role IS '成员角色: host(房主), admin(管理员), member(成员), observer(观众)';
COMMENT ON COLUMN voice_chat_statistics.quality_score IS '通话质量评分 0-100，综合丢包、延迟、抖动计算';
