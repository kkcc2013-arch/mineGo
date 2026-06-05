-- REQ-00016: GDPR 合规与用户数据隐私保护
-- 创建时间: 2026-06-05 16:10

-- 1. 用户同意记录表
CREATE TABLE IF NOT EXISTS user_consents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  privacy_policy_version VARCHAR(10) NOT NULL,
  terms_version VARCHAR(10) NOT NULL,
  consented_at TIMESTAMP NOT NULL,
  withdrawn_at TIMESTAMP,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_user_consents_user ON user_consents(user_id);
CREATE INDEX idx_user_consents_version ON user_consents(privacy_policy_version);

-- 2. 隐私政策版本表
CREATE TABLE IF NOT EXISTS privacy_policy_versions (
  version VARCHAR(10) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  published_at TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 3. 审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  action VARCHAR(100) NOT NULL,
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  service VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_service ON audit_logs(service);

-- 4. 数据删除请求表
CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'pending', -- pending, processing, completed, failed
  requested_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  error_message TEXT,
  confirmation_token VARCHAR(64)
);

CREATE INDEX idx_deletion_requests_user ON data_deletion_requests(user_id);
CREATE INDEX idx_deletion_requests_status ON data_deletion_requests(status);

-- 5. 数据保留策略配置表
CREATE TABLE IF NOT EXISTS data_retention_policies (
  table_name VARCHAR(100) PRIMARY KEY,
  retention_days INTEGER,
  auto_delete BOOLEAN DEFAULT false,
  description TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 插入默认保留策略
INSERT INTO data_retention_policies (table_name, retention_days, auto_delete, description) VALUES
  ('users', NULL, false, '用户数据永久保留，用户删除时删除'),
  ('catch_history', 730, true, '捕捉历史保留 2 年'),
  ('gym_battles', 365, true, '道馆战斗记录保留 1 年'),
  ('messages', 90, true, '消息记录保留 90 天'),
  ('payments', 2555, false, '支付记录保留 7 年（法律要求）'),
  ('audit_logs', 2555, false, '审计日志保留 7 年'),
  ('user_locations', 30, true, '位置历史保留 30 天')
ON CONFLICT (table_name) DO NOTHING;

-- 6. 加密位置数据表（替代明文存储）
CREATE TABLE IF NOT EXISTS encrypted_user_locations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  encrypted_location TEXT NOT NULL,
  iv VARCHAR(64) NOT NULL,
  auth_tag VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_encrypted_locations_user ON encrypted_user_locations(user_id);
CREATE INDEX idx_encrypted_locations_created ON encrypted_user_locations(created_at);

-- 7. 添加用户删除时间字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(100);

-- 8. 插入初始隐私政策
INSERT INTO privacy_policy_versions (version, title, content, summary, published_at) VALUES
('1.0', 'mineGo 隐私政策', 
'# mineGo 隐私政策

生效日期：2026年6月5日

## 1. 我们收集的数据

### 1.1 必需数据
- **账户信息**：邮箱、用户名、密码（加密存储）
- **位置数据**：GPS 坐标（加密存储，用于游戏功能）
- **设备信息**：设备类型、操作系统、应用版本

### 1.2 可选数据
- **支付信息**：支付方式、交易记录
- **社交数据**：好友列表、聊天记录
- **游戏数据**：精灵、道具、成就

## 2. 数据用途

- 提供游戏服务（位置数据用于精灵生成）
- 改进游戏体验（分析用户行为）
- 发送通知（新活动、好友请求）
- 防止作弊和安全保护

## 3. 数据共享

我们不会出售您的数据。仅在以下情况共享：
- 支付处理（支付服务商）
- 法律要求
- 经您明确同意

## 4. 您的权利（GDPR）

- 查看您的数据
- 导出您的数据（JSON 格式）
- 删除您的数据（被遗忘权）
- 撤回同意
- 投诉数据保护机构

## 5. 数据安全

- 所有敏感数据加密存储
- HTTPS 传输加密
- 访问控制和审计日志
- 定期安全审计

## 6. 数据保留

- 用户数据：账户存续期间
- 位置数据：30 天
- 消息记录：90 天
- 支付记录：7 年（法律要求）
- 审计日志：7 年

## 7. 儿童隐私

本服务面向 13 岁以上用户。13 岁以下需监护人同意。

## 8. 政策更新

政策更新时，我们会通知您。继续使用即表示同意新政策。

## 9. 联系我们

隐私相关问题：privacy@minego.com
数据删除请求：delete@minego.com

---

mineGo 团队
2026年6月5日',
'我们收集账户、位置、设备等数据用于游戏服务。您可以随时查看、导出或删除您的数据。',
NOW())
ON CONFLICT (version) DO NOTHING;

-- 9. 注释
COMMENT ON TABLE user_consents IS '用户隐私政策同意记录';
COMMENT ON TABLE privacy_policy_versions IS '隐私政策版本管理';
COMMENT ON TABLE audit_logs IS '合规审计日志';
COMMENT ON TABLE data_deletion_requests IS '数据删除请求跟踪';
COMMENT ON TABLE data_retention_policies IS '数据保留策略配置';
COMMENT ON TABLE encrypted_user_locations IS '加密的用户位置数据';
