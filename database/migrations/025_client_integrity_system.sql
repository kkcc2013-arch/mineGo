-- REQ-00483: 客户端完整性验证数据库迁移
-- 创建客户端完整性相关表

-- 1. 客户端完整性报告表
CREATE TABLE IF NOT EXISTS client_integrity_reports (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  device_id VARCHAR(255),
  environment_data JSONB,
  risk_factors JSONB,
  risk_score INTEGER DEFAULT 0,
  risk_level VARCHAR(20) DEFAULT 'LOW',
  function_hashes JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_user_id (user_id),
  INDEX idx_device_id (device_id),
  INDEX idx_created_at (created_at),
  INDEX idx_risk_level (risk_level)
);

-- 2. 完整性验证记录表
CREATE TABLE IF NOT EXISTS integrity_verifications (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  challenge_id VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL,  -- SUCCESS, FAILED, EXPIRED
  failure_reason VARCHAR(255),
  verified_at TIMESTAMP,
  attempted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_user_id (user_id),
  INDEX idx_challenge_id (challenge_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
);

-- 3. 白名单申诉表
CREATE TABLE IF NOT EXISTS whitelist_requests (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  reason TEXT,
  details JSONB,
  status VARCHAR(20) DEFAULT 'PENDING',  -- PENDING, APPROVED, REJECTED
  reviewer_id VARCHAR(255),
  review_notes TEXT,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
);

-- 4. 添加用户表字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS integrity_verified BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS integrity_verified_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS integrity_locked BOOLEAN DEFAULT false;

-- 5. 创建完整性审计日志索引
CREATE INDEX IF NOT EXISTS idx_risk_events_integrity ON risk_events(event_type) 
  WHERE event_type LIKE 'INTEGRITY%';

-- 6. 创建视图：高风险用户列表
CREATE OR REPLACE VIEW high_risk_users AS
SELECT 
  user_id,
  COUNT(*) as violation_count,
  MAX(created_at) as last_violation,
  MAX(risk_score) as max_risk_score
FROM client_integrity_reports
WHERE risk_level IN ('HIGH', 'CRITICAL')
GROUP BY user_id
HAVING COUNT(*) >= 3;

-- 7. 创建函数：计算用户完整性评分
CREATE OR REPLACE FUNCTION calculate_user_integrity_score(p_user_id VARCHAR)
RETURNS INTEGER AS $$
DECLARE
  v_score INTEGER := 0;
BEGIN
  -- 基于最近的完整性报告计算评分
  SELECT COALESCE(SUM(
    CASE 
      WHEN risk_level = 'CRITICAL' THEN 100
      WHEN risk_level = 'HIGH' THEN 70
      WHEN risk_level = 'MEDIUM' THEN 40
      ELSE 0
    END
  ), 0)
  INTO v_score
  FROM client_integrity_reports
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '30 days';
  
  RETURN LEAST(v_score, 100);
END;
$$ LANGUAGE plpgsql;

-- 8. 创建触发器：自动更新风险等级
CREATE OR REPLACE FUNCTION update_risk_level()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.risk_score >= 150 THEN
    NEW.risk_level := 'CRITICAL';
  ELSIF NEW.risk_score >= 100 THEN
    NEW.risk_level := 'HIGH';
  ELSIF NEW.risk_score >= 50 THEN
    NEW.risk_level := 'MEDIUM';
  ELSE
    NEW.risk_level := 'LOW';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_risk_level
BEFORE INSERT OR UPDATE ON client_integrity_reports
FOR EACH ROW
EXECUTE FUNCTION update_risk_level();

-- 9. 授权
GRANT SELECT, INSERT, UPDATE ON client_integrity_reports TO minego_user;
GRANT SELECT, INSERT, UPDATE ON integrity_verifications TO minego_user;
GRANT SELECT, INSERT, UPDATE ON whitelist_requests TO minego_user;
GRANT SELECT ON high_risk_users TO minego_user;

-- 10. 注释
COMMENT ON TABLE client_integrity_reports IS '客户端完整性检测报告';
COMMENT ON TABLE integrity_verifications IS '完整性验证记录';
COMMENT ON TABLE whitelist_requests IS '白名单申诉请求';
COMMENT ON COLUMN client_integrity_reports.environment_data IS '客户端环境数据（WebGL、Navigator等）';
COMMENT ON COLUMN client_integrity_reports.risk_factors IS '检测到的风险因素（Root、模拟器、注入等）';
COMMENT ON COLUMN client_integrity_reports.function_hashes IS '关键函数哈希值';
