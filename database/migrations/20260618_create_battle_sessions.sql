/**
 * 数据库迁移：战斗会话相关表
 * REQ-00262: 实时对战 WebSocket 连接系统
 */

-- 战斗会话表
CREATE TABLE IF NOT EXISTS battle_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id VARCHAR(100) UNIQUE NOT NULL,
  battle_type VARCHAR(50) NOT NULL CHECK (battle_type IN ('pvp_duel', 'gym_battle', 'team_battle', 'friendly')),
  player1_id VARCHAR(100) NOT NULL,
  player2_id VARCHAR(100),
  player3_id VARCHAR(100),
  player4_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'ended', 'abandoned')),
  game_state JSONB DEFAULT '{}',
  result JSONB,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 战斗事件日志
CREATE TABLE IF NOT EXISTS battle_events (
  id SERIAL PRIMARY KEY,
  session_id UUID REFERENCES battle_sessions(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  player_id VARCHAR(100) NOT NULL,
  turn_number INT DEFAULT 0,
  event_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 玩家连接历史
CREATE TABLE IF NOT EXISTS player_connection_history (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(100) NOT NULL,
  connection_id VARCHAR(100) NOT NULL,
  room_id VARCHAR(100),
  action VARCHAR(20) NOT NULL CHECK (action IN ('connect', 'disconnect', 'reconnect', 'leave')),
  ip_address INET,
  user_agent TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- WebSocket 统计
CREATE TABLE IF NOT EXISTS websocket_stats (
  id SERIAL PRIMARY KEY,
  stat_time TIMESTAMPTZ DEFAULT NOW(),
  total_connections INT DEFAULT 0,
  active_rooms INT DEFAULT 0,
  messages_received BIGINT DEFAULT 0,
  messages_sent BIGINT DEFAULT 0,
  errors_count INT DEFAULT 0,
  avg_latency_ms DECIMAL(10,2),
  metadata JSONB DEFAULT '{}'
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_battle_sessions_room ON battle_sessions(room_id);
CREATE INDEX IF NOT EXISTS idx_battle_sessions_player ON battle_sessions(player1_id, player2_id);
CREATE INDEX IF NOT EXISTS idx_battle_sessions_status ON battle_sessions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_battle_sessions_type ON battle_sessions(battle_type);

CREATE INDEX IF NOT EXISTS idx_battle_events_session ON battle_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_battle_events_type ON battle_events(event_type);

CREATE INDEX IF NOT EXISTS idx_connection_history_user ON player_connection_history(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_connection_history_room ON player_connection_history(room_id, created_at);

CREATE INDEX IF NOT EXISTS idx_websocket_stats_time ON websocket_stats(stat_time);

-- 注释
COMMENT ON TABLE battle_sessions IS '战斗会话记录';
COMMENT ON TABLE battle_events IS '战斗事件日志';
COMMENT ON TABLE player_connection_history IS '玩家 WebSocket 连接历史';
COMMENT ON TABLE websocket_stats IS 'WebSocket 统计数据';
