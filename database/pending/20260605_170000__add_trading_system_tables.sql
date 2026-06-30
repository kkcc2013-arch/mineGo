-- database/pending/20260605_170000__add_trading_system_tables.sql
-- 精灵交易系统表结构

-- 交易表（如果不存在则创建）
CREATE TABLE IF NOT EXISTS pokemon_trades (
  id SERIAL PRIMARY KEY,
  initiator_id UUID NOT NULL REFERENCES users(id),
  receiver_id UUID NOT NULL REFERENCES users(id),
  offered_pokemon INTEGER NOT NULL,
  received_pokemon INTEGER,
  stardust_cost INTEGER NOT NULL DEFAULT 100,
  is_remote BOOLEAN NOT NULL DEFAULT FALSE,
  is_lucky BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
  distance_meters DECIMAL(10, 2),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  traded_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  cancelled_by VARCHAR(36),
  cancel_reason TEXT
);

-- 为交易表创建索引
CREATE INDEX IF NOT EXISTS idx_trades_initiator ON pokemon_trades(initiator_id);
CREATE INDEX IF NOT EXISTS idx_trades_receiver ON pokemon_trades(receiver_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON pokemon_trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON pokemon_trades(created_at DESC);

-- 可疑交易记录表
CREATE TABLE IF NOT EXISTS suspicious_trades (
  id SERIAL PRIMARY KEY,
  trade_id UUID NOT NULL REFERENCES pokemon_trades(id),
  flags JSONB NOT NULL DEFAULT '[]',
  severity VARCHAR(20) NOT NULL DEFAULT 'LOW' CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by VARCHAR(36),
  reviewed_at TIMESTAMP,
  action_taken VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 为可疑交易表创建索引
CREATE INDEX IF NOT EXISTS idx_suspicious_trades_trade_id ON suspicious_trades(trade_id);
CREATE INDEX IF NOT EXISTS idx_suspicious_trades_severity ON suspicious_trades(severity);
CREATE INDEX IF NOT EXISTS idx_suspicious_trades_reviewed ON suspicious_trades(reviewed);
CREATE INDEX IF NOT EXISTS idx_suspicious_trades_created_at ON suspicious_trades(created_at DESC);

-- 用户会话表（用于IP地址检测）
CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  ip_address VARCHAR(45) NOT NULL,
  user_agent TEXT,
  device_id VARCHAR(100),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

-- 为用户会话表创建索引
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_ip_address ON user_sessions(ip_address);
CREATE INDEX IF NOT EXISTS idx_user_sessions_created_at ON user_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);

-- 交易统计视图
CREATE OR REPLACE VIEW trade_statistics AS
SELECT 
  u.id AS user_id,
  u.nickname,
  COUNT(DISTINCT CASE WHEN pt.initiator_id = u.id THEN pt.id END) AS trades_initiated,
  COUNT(DISTINCT CASE WHEN pt.receiver_id = u.id THEN pt.id END) AS trades_received,
  COUNT(DISTINCT CASE WHEN pt.status = 'COMPLETED' AND (pt.initiator_id = u.id OR pt.receiver_id = u.id) THEN pt.id END) AS trades_completed,
  SUM(CASE WHEN pt.status = 'COMPLETED' AND pt.initiator_id = u.id THEN pt.stardust_cost ELSE 0 END) AS total_stardust_spent,
  COUNT(DISTINCT CASE WHEN pt.is_lucky = TRUE AND (pt.initiator_id = u.id OR pt.receiver_id = u.id) THEN pt.id END) AS lucky_trades,
  MAX(pt.created_at) AS last_trade_at
FROM users u
LEFT JOIN pokemon_trades pt ON pt.initiator_id = u.id OR pt.receiver_id = u.id
GROUP BY u.id, u.nickname;

-- 注释
COMMENT ON TABLE pokemon_trades IS '精灵交易记录表';
COMMENT ON TABLE suspicious_trades IS '可疑交易记录表';
COMMENT ON TABLE user_sessions IS '用户会话表，用于反作弊检测';
COMMENT ON VIEW trade_statistics IS '交易统计视图';
