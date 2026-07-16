-- AR 安全相关表迁移
-- 创建时间: 2026-07-16 04:00
-- 需求: REQ-00521 AR 防作弊系统

-- AR 安全报告表
CREATE TABLE IF NOT EXISTS ar_security_reports (
  id UUID PRIMARY KEY,
  report_id VARCHAR(100) UNIQUE NOT NULL,
  device_id VARCHAR(100) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  validation_results JSONB,
  risk_score INTEGER DEFAULT 0,
  risk_level VARCHAR(20) DEFAULT 'LOW',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ar_reports_user ON ar_security_reports(user_id);
CREATE INDEX idx_ar_reports_device ON ar_security_reports(device_id);
CREATE INDEX idx_ar_reports_risk_level ON ar_security_reports(risk_level);
CREATE INDEX idx_ar_reports_created ON ar_security_reports(created_at DESC);

-- AR 传感器异常表
CREATE TABLE IF NOT EXISTS ar_sensor_anomalies (
  id UUID PRIMARY KEY,
  device_id VARCHAR(100) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  anomaly_type VARCHAR(100) NOT NULL,
  sensor_data JSONB,
  anomaly_details JSONB,
  detected_at BIGINT,
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ar_anomalies_user ON ar_sensor_anomalies(user_id);
CREATE INDEX idx_ar_anomalies_type ON ar_sensor_anomalies(anomaly_type);
CREATE INDEX idx_ar_anomalies_resolved ON ar_sensor_anomalies(resolved);

-- GPS 欺骗事件表
CREATE TABLE IF NOT EXISTS gps_spoof_incidents (
  id UUID PRIMARY KEY,
  device_id VARCHAR(100) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  gps_data JSONB,
  spoof_evidence JSONB,
  confidence INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'INVESTIGATING',
  resolved BOOLEAN DEFAULT false,
  resolved_by INTEGER,
  resolution_note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP
);

CREATE INDEX idx_gps_spoof_user ON gps_spoof_incidents(user_id);
CREATE INDEX idx_gps_spoof_status ON gps_spoof_incidents(status);
CREATE INDEX idx_gps_spoof_created ON gps_spoof_incidents(created_at DESC);

-- 摄像头注入事件表
CREATE TABLE IF NOT EXISTS camera_injection_incidents (
  id UUID PRIMARY KEY,
  device_id VARCHAR(100) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  injection_type VARCHAR(100) NOT NULL,
  detection_method VARCHAR(100),
  evidence JSONB,
  confidence INTEGER DEFAULT 0,
  action_taken VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_camera_injection_user ON camera_injection_incidents(user_id);
CREATE INDEX idx_camera_injection_type ON camera_injection_incidents(injection_type);
CREATE INDEX idx_camera_injection_created ON camera_injection_incidents(created_at DESC);

-- 用户警告表
CREATE TABLE IF NOT EXISTS user_warnings (
  id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  type VARCHAR(100) NOT NULL,
  message TEXT,
  details JSONB,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_warnings_user ON user_warnings(user_id);
CREATE INDEX idx_user_warnings_type ON user_warnings(type);
CREATE INDEX idx_user_warnings_unack ON user_warnings(acknowledged) WHERE acknowledged = false;

-- 用户限制表（如果不存在）
CREATE TABLE IF NOT EXISTS user_restrictions (
  id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  device_id VARCHAR(100),
  type VARCHAR(100) NOT NULL,
  reason JSONB,
  active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP,
  lifted_at TIMESTAMP,
  lifted_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_restrictions_user ON user_restrictions(user_id);
CREATE INDEX idx_user_restrictions_active ON user_restrictions(active);
CREATE INDEX idx_user_restrictions_type ON user_restrictions(type);

-- 添加 users 表风险评分字段（如果不存在）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'risk_score'
  ) THEN
    ALTER TABLE users ADD COLUMN risk_score INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'suspended_at'
  ) THEN
    ALTER TABLE users ADD COLUMN suspended_at TIMESTAMP;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'suspension_reason'
  ) THEN
    ALTER TABLE users ADD COLUMN suspension_reason VARCHAR(255);
  END IF;
END $$;

-- 创建更新时间触发器函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

-- 添加视图：用户 AR 安全概览
CREATE OR REPLACE VIEW user_ar_security_overview AS
SELECT 
  u.id as user_id,
  u.username,
  u.risk_score,
  COUNT(DISTINCT ar.id) as total_reports,
  COUNT(DISTINCT CASE WHEN ar.risk_level IN ('HIGH', 'CRITICAL') THEN ar.id END) as high_risk_reports,
  COUNT(DISTINCT gs.id) as gps_spoof_incidents,
  COUNT(DISTINCT ci.id) as camera_injection_incidents,
  MAX(ar.created_at) as last_report_time
FROM users u
LEFT JOIN ar_security_reports ar ON u.id = ar.user_id
LEFT JOIN gps_spoof_incidents gs ON u.id = gs.user_id
LEFT JOIN camera_injection_incidents ci ON u.id = ci.user_id
GROUP BY u.id, u.username, u.risk_score;