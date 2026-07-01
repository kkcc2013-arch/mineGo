-- database/migrations/20260701_01_sensitive_operation_guard.sql
-- API 敏感操作访问控制与风险评估系统

-- 风险评估记录表
CREATE TABLE IF NOT EXISTS risk_evaluations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  operation VARCHAR(100) NOT NULL,
  risk_level VARCHAR(20) NOT NULL,
  risk_score INTEGER NOT NULL,
  factors JSONB,
  recommendation TEXT[],
  ip_address VARCHAR(45),
  device_id VARCHAR(100),
  user_agent TEXT,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_risk_evaluations_user ON risk_evaluations(user_id);
CREATE INDEX idx_risk_evaluations_operation ON risk_evaluations(operation);
CREATE INDEX idx_risk_evaluations_level ON risk_evaluations(risk_level);
CREATE INDEX idx_risk_evaluations_created ON risk_evaluations(created_at);
CREATE INDEX idx_risk_evaluations_score ON risk_evaluations(risk_score);

-- 敏感操作审计日志
CREATE TABLE IF NOT EXISTS sensitive_operation_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  operation VARCHAR(100) NOT NULL,
  risk_level VARCHAR(20) NOT NULL,
  risk_score INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL, -- success, failed, blocked, pending_verification
  verification_type VARCHAR(50), -- mfa, sms, email, captcha
  verification_passed BOOLEAN,
  ip_address VARCHAR(45),
  device_id VARCHAR(100),
  request_id VARCHAR(100),
  request_metadata JSONB,
  response_status INTEGER,
  duration_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sensitive_ops_user ON sensitive_operation_logs(user_id);
CREATE INDEX idx_sensitive_ops_operation ON sensitive_operation_logs(operation);
CREATE INDEX idx_sensitive_ops_status ON sensitive_operation_logs(status);
CREATE INDEX idx_sensitive_ops_created ON sensitive_operation_logs(created_at);
CREATE INDEX idx_sensitive_ops_level ON sensitive_operation_logs(risk_level);

-- 设备信任记录
CREATE TABLE IF NOT EXISTS device_trust (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_id VARCHAR(100) NOT NULL UNIQUE,
  device_fingerprint VARCHAR(255),
  is_trusted BOOLEAN DEFAULT false,
  is_suspicious BOOLEAN DEFAULT false,
  is_rooted BOOLEAN DEFAULT false,
  fingerprint_mismatch BOOLEAN DEFAULT false,
  first_seen TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW(),
  usage_count INTEGER DEFAULT 0,
  risk_score INTEGER DEFAULT 0,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_device_trust_user ON device_trust(user_id);
CREATE INDEX idx_device_trust_device ON device_trust(device_id);
CREATE INDEX idx_device_trust_suspicious ON device_trust(is_suspicious);

-- IP 风险记录
CREATE TABLE IF NOT EXISTS ip_risk_records (
  id SERIAL PRIMARY KEY,
  ip_address VARCHAR(45) NOT NULL UNIQUE,
  is_vpn BOOLEAN DEFAULT false,
  is_tor BOOLEAN DEFAULT false,
  is_proxy BOOLEAN DEFAULT false,
  is_blacklisted BOOLEAN DEFAULT false,
  threat_score INTEGER DEFAULT 0,
  country VARCHAR(10),
  city VARCHAR(100),
  isp VARCHAR(255),
  last_updated TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX idx_ip_risk_ip ON ip_risk_records(ip_address);
CREATE INDEX idx_ip_risk_threat ON ip_risk_records(threat_score);
CREATE INDEX idx_ip_risk_blacklisted ON ip_risk_records(is_blacklisted);

-- 敏感操作配置
CREATE TABLE IF NOT EXISTS sensitive_operations_config (
  id SERIAL PRIMARY KEY,
  operation VARCHAR(100) NOT NULL UNIQUE,
  level VARCHAR(20) NOT NULL DEFAULT 'medium',
  weight INTEGER DEFAULT 50,
  description TEXT,
  requires_mfa BOOLEAN DEFAULT false,
  requires_sms BOOLEAN DEFAULT false,
  requires_email BOOLEAN DEFAULT false,
  requires_captcha BOOLEAN DEFAULT false,
  cooldown_ms INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 10,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 插入默认敏感操作配置
INSERT INTO sensitive_operations_config (operation, level, weight, description, requires_mfa, requires_sms, requires_captcha, cooldown_ms, max_attempts)
VALUES
  -- 支付相关
  ('payment.purchase', 'critical', 100, '购买支付', true, false, true, 300000, 1),
  ('payment.refund', 'critical', 100, '退款操作', true, false, true, 300000, 1),
  ('payment.withdraw', 'critical', 100, '提现操作', true, true, true, 300000, 1),
  ('payment.bindCard', 'high', 80, '绑定银行卡', false, true, true, 60000, 2),
  ('payment.unbindCard', 'high', 80, '解绑银行卡', false, true, true, 60000, 2),
  
  -- 账户安全
  ('user.changePassword', 'critical', 100, '修改密码', true, false, true, 300000, 1),
  ('user.bindEmail', 'high', 80, '绑定邮箱', false, false, true, 60000, 2),
  ('user.bindPhone', 'high', 80, '绑定手机', false, true, true, 60000, 2),
  ('user.deleteAccount', 'critical', 100, '注销账户', true, true, true, 600000, 1),
  ('user.exportData', 'high', 80, '导出数据', false, false, true, 60000, 3),
  ('user.updateProfile', 'medium', 50, '更新资料', false, false, true, 30000, 5),
  
  -- 精灵交易
  ('pokemon.trade', 'high', 80, '精灵交易', false, false, true, 60000, 3),
  ('pokemon.transfer', 'medium', 50, '精灵转移', false, false, true, 30000, 5),
  ('pokemon.release', 'low', 20, '放生精灵', false, false, false, 0, 10),
  
  -- 社交
  ('social.addFriend', 'low', 20, '添加好友', false, false, false, 0, 20),
  ('social.removeFriend', 'low', 20, '删除好友', false, false, false, 0, 20),
  ('social.sendMessage', 'low', 20, '发送消息', false, false, false, 0, 50),
  
  -- 道馆
  ('gym.challenge', 'low', 20, '道馆挑战', false, false, false, 0, 20),
  ('gym.claim', 'medium', 50, '占领道馆', false, false, true, 30000, 10)
ON CONFLICT (operation) DO NOTHING;

-- 用户风险统计聚合
CREATE TABLE IF NOT EXISTS user_risk_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  total_operations INTEGER DEFAULT 0,
  high_risk_count INTEGER DEFAULT 0,
  critical_risk_count INTEGER DEFAULT 0,
  failed_operations INTEGER DEFAULT 0,
  last_operation_at TIMESTAMP,
  cumulative_risk_score INTEGER DEFAULT 0,
  risk_trend VARCHAR(20), -- increasing, stable, decreasing
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_user_risk_stats_user ON user_risk_stats(user_id);
CREATE INDEX idx_user_risk_stats_risk ON user_risk_stats(cumulative_risk_score);

-- 注释
COMMENT ON TABLE risk_evaluations IS '风险评估记录';
COMMENT ON TABLE sensitive_operation_logs IS '敏感操作审计日志';
COMMENT ON TABLE device_trust IS '设备信任记录';
COMMENT ON TABLE ip_risk_records IS 'IP 风险记录';
COMMENT ON TABLE sensitive_operations_config IS '敏感操作配置';
COMMENT ON TABLE user_risk_stats IS '用户风险统计聚合';
