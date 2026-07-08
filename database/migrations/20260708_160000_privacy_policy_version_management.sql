-- REQ-00497: 用户协议变更版本管理与强制确认通知系统
-- 创建隐私政策版本管理、用户确认记录和相关功能

-- ============================================================
-- 1. 隐私政策版本表
-- ============================================================

CREATE TABLE IF NOT EXISTS privacy_policies (
  id SERIAL PRIMARY KEY,
  version VARCHAR(20) NOT NULL UNIQUE,
  policy_type VARCHAR(30) NOT NULL DEFAULT 'privacy_policy',
  title VARCHAR(200) NOT NULL,
  content_url TEXT NOT NULL,
  content_hash VARCHAR(64),
  summary TEXT,
  effective_date TIMESTAMP WITH TIME ZONE NOT NULL,
  mandatory_confirm BOOLEAN DEFAULT TRUE,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'deprecated')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  published_at TIMESTAMP WITH TIME ZONE,
  deprecated_at TIMESTAMP WITH TIME ZONE,
  created_by INTEGER REFERENCES users(id),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_privacy_policies_version ON privacy_policies(version);
CREATE INDEX idx_privacy_policies_status ON privacy_policies(status);
CREATE INDEX idx_privacy_policies_effective_date ON privacy_policies(effective_date);

COMMENT ON TABLE privacy_policies IS '隐私政策和服务条款版本管理表';

-- ============================================================
-- 2. 用户政策确认记录表
-- ============================================================

CREATE TABLE IF NOT EXISTS user_privacy_confirmations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id INTEGER NOT NULL REFERENCES privacy_policies(id),
  policy_version VARCHAR(20) NOT NULL,
  confirmed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ip_address VARCHAR(45),
  user_agent TEXT,
  device_id VARCHAR(100),
  confirmation_type VARCHAR(20) DEFAULT 'explicit' CHECK (confirmation_type IN ('explicit', 'implicit', 'forced')),
  content_snapshot TEXT,
  revoked_at TIMESTAMP WITH TIME ZONE,
  revoke_reason VARCHAR(100),
  UNIQUE(user_id, policy_id)
);

CREATE INDEX idx_user_confirmations_user ON user_privacy_confirmations(user_id);
CREATE INDEX idx_user_confirmations_policy ON user_privacy_confirmations(policy_id);
CREATE INDEX idx_user_confirmations_version ON user_privacy_confirmations(policy_version);
CREATE INDEX idx_user_confirmations_date ON user_privacy_confirmations(confirmed_at);

COMMENT ON TABLE user_privacy_confirmations IS '用户隐私政策确认记录表';

-- ============================================================
-- 3. 政策变更通知队列表
-- ============================================================

CREATE TABLE IF NOT EXISTS privacy_update_notifications (
  id SERIAL PRIMARY KEY,
  policy_id INTEGER NOT NULL REFERENCES privacy_policies(id),
  user_id INTEGER REFERENCES users(id),
  notification_type VARCHAR(30) NOT NULL CHECK (notification_type IN ('email', 'push', 'in_app', 'sms')),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'read', 'confirmed')),
  scheduled_at TIMESTAMP WITH TIME ZONE,
  sent_at TIMESTAMP WITH TIME ZONE,
  read_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_policy_notifications_policy ON privacy_update_notifications(policy_id);
CREATE INDEX idx_policy_notifications_user ON privacy_update_notifications(user_id);
CREATE INDEX idx_policy_notifications_status ON privacy_update_notifications(status);
CREATE INDEX idx_policy_notifications_scheduled ON privacy_update_notifications(scheduled_at);

-- ============================================================
-- 4. 用户政策状态视图
-- ============================================================

CREATE OR REPLACE VIEW user_policy_status AS
SELECT 
  u.id AS user_id,
  u.phone,
  u.email,
  u.created_at AS user_created_at,
  pp.id AS latest_policy_id,
  pp.version AS latest_policy_version,
  pp.effective_date AS policy_effective_date,
  pp.mandatory_confirm,
  upc.id AS confirmation_id,
  upc.confirmed_at,
  upc.policy_version AS confirmed_version,
  CASE 
    WHEN upc.id IS NULL THEN 'pending_confirmation'
    WHEN upc.policy_version = pp.version THEN 'confirmed_latest'
    ELSE 'needs_update'
  END AS confirmation_status,
  CASE 
    WHEN upc.id IS NULL THEN FALSE
    WHEN upc.policy_version = pp.version THEN TRUE
    ELSE FALSE
  END AS is_up_to_date
FROM users u
CROSS JOIN LATERAL (
  SELECT * FROM privacy_policies 
  WHERE status = 'published' 
  AND mandatory_confirm = TRUE
  ORDER BY effective_date DESC 
  LIMIT 1
) pp
LEFT JOIN user_privacy_confirmations upc ON upc.user_id = u.id AND upc.policy_id = pp.id;

COMMENT ON VIEW user_policy_status IS '用户政策确认状态视图';

-- ============================================================
-- 5. 触发器：自动生成版本号
-- ============================================================

CREATE OR REPLACE FUNCTION generate_policy_version()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.version IS NULL OR NEW.version = '' THEN
    NEW.version := to_char(NEW.effective_date, 'YYYY.MM') || '.' || 
                   COALESCE(
                     (SELECT COUNT(*) + 1 FROM privacy_policies 
                      WHERE policy_type = NEW.policy_type 
                      AND DATE_TRUNC('month', effective_date) = DATE_TRUNC('month', NEW.effective_date)),
                     1
                   );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_generate_policy_version ON privacy_policies;
CREATE TRIGGER trigger_generate_policy_version
  BEFORE INSERT ON privacy_policies
  FOR EACH ROW
  EXECUTE FUNCTION generate_policy_version();

-- ============================================================
-- 6. 初始政策数据
-- ============================================================

INSERT INTO privacy_policies (version, policy_type, title, content_url, summary, effective_date, mandatory_confirm, status, published_at)
VALUES 
  ('2026.01.1', 'privacy_policy', '隐私政策', '/static/privacy/privacy_policy_2026_01_zh-CN.html', 
   '本隐私政策说明了我们如何收集、使用和保护您的个人信息。', '2026-01-01 00:00:00+00', TRUE, 'published', '2026-01-01 00:00:00+00'),
  ('2026.01.1', 'terms_of_service', '服务条款', '/static/privacy/terms_of_service_2026_01_zh-CN.html',
   '本服务条款规定了您使用 mineGo 服务时的权利和义务。', '2026-01-01 00:00:00+00', TRUE, 'published', '2026-01-01 00:00:00+00')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- 7. 管理函数
-- ============================================================

-- 发布新政策
CREATE OR REPLACE FUNCTION publish_privacy_policy(
  p_policy_id INTEGER,
  p_published_by INTEGER DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  UPDATE privacy_policies 
  SET status = 'published',
      published_at = NOW(),
      created_by = COALESCE(created_by, p_published_by)
  WHERE id = p_policy_id;
  
  -- 将旧版本标记为废弃
  UPDATE privacy_policies 
  SET status = 'deprecated',
      deprecated_at = NOW()
  WHERE policy_type = (SELECT policy_type FROM privacy_policies WHERE id = p_policy_id)
    AND id != p_policy_id
    AND status = 'published';
END;
$$ LANGUAGE plpgsql;

-- 获取用户需确认的政策
CREATE OR REPLACE FUNCTION get_pending_policies_for_user(p_user_id INTEGER)
RETURNS TABLE (
  policy_id INTEGER,
  version VARCHAR(20),
  policy_type VARCHAR(30),
  title VARCHAR(200),
  content_url TEXT,
  mandatory_confirm BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT pp.id, pp.version, pp.policy_type, pp.title, pp.content_url, pp.mandatory_confirm
  FROM privacy_policies pp
  WHERE pp.status = 'published'
    AND pp.mandatory_confirm = TRUE
    AND NOT EXISTS (
      SELECT 1 FROM user_privacy_confirmations upc
      WHERE upc.user_id = p_user_id 
        AND upc.policy_id = pp.id
        AND upc.revoked_at IS NULL
    );
END;
$$ LANGUAGE plpgsql;

-- 记录用户确认
CREATE OR REPLACE FUNCTION confirm_privacy_policy(
  p_user_id INTEGER,
  p_policy_id INTEGER,
  p_ip_address VARCHAR(45) DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_device_id VARCHAR(100) DEFAULT NULL,
  p_confirmation_type VARCHAR(20) DEFAULT 'explicit'
) RETURNS INTEGER AS $$
DECLARE
  v_confirmation_id INTEGER;
BEGIN
  INSERT INTO user_privacy_confirmations (
    user_id, policy_id, policy_version, ip_address, user_agent, device_id, confirmation_type
  )
  SELECT p_user_id, p_policy_id, version, p_ip_address, p_user_agent, p_device_id, p_confirmation_type
  FROM privacy_policies WHERE id = p_policy_id
  ON CONFLICT (user_id, policy_id) 
  DO UPDATE SET 
    confirmed_at = NOW(),
    ip_address = p_ip_address,
    user_agent = p_user_agent,
    device_id = p_device_id,
    confirmation_type = p_confirmation_type,
    revoked_at = NULL,
    revoke_reason = NULL
  RETURNING id INTO v_confirmation_id;
  
  RETURN v_confirmation_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 8. 审计日志触发器
-- ============================================================

CREATE OR REPLACE FUNCTION audit_privacy_policy_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RAISE NOTICE 'Privacy policy created: % version %', NEW.policy_type, NEW.version;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status != NEW.status THEN
      RAISE NOTICE 'Privacy policy status changed: % version % from % to %', 
        NEW.policy_type, NEW.version, OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_audit_privacy_policy ON privacy_policies;
CREATE TRIGGER trigger_audit_privacy_policy
  AFTER INSERT OR UPDATE ON privacy_policies
  FOR EACH ROW
  EXECUTE FUNCTION audit_privacy_policy_changes();
