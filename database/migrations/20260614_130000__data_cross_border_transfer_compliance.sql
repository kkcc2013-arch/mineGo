-- REQ-00089: 数据跨境传输合规与本地化存储策略
-- 创建数据存储区域配置、跨境传输请求、传输日志表

-- 1. 数据存储区域配置表
CREATE TABLE IF NOT EXISTS data_regions (
  id SERIAL PRIMARY KEY,
  region_code VARCHAR(20) NOT NULL UNIQUE,
  region_name VARCHAR(100) NOT NULL,
  countries TEXT[] NOT NULL,
  storage_location VARCHAR(100) NOT NULL,
  applicable_laws TEXT[] NOT NULL,
  compliance_requirements JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 用户数据区域映射表
CREATE TABLE IF NOT EXISTS user_data_regions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  region_code VARCHAR(20) NOT NULL REFERENCES data_regions(region_code),
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  assignment_reason VARCHAR(50) NOT NULL, -- 'ip_detection', 'user_selection', 'legal_requirement'
  ip_address_at_assignment INET,
  assigned_by INTEGER, -- 管理员ID（如果是手动分配）
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. 跨境传输请求表
CREATE TABLE IF NOT EXISTS data_transfer_requests (
  id SERIAL PRIMARY KEY,
  request_id VARCHAR(50) NOT NULL UNIQUE DEFAULT ('DTR-' || to_char(now(), 'YYYYMMDD') || '-' || LPAD(nextval('data_transfer_request_seq')::TEXT, 6, '0')),
  requester_id INTEGER NOT NULL,
  source_region VARCHAR(20) NOT NULL,
  target_region VARCHAR(20) NOT NULL,
  data_types TEXT[] NOT NULL, -- ['personal', 'location', 'payment', 'game_data']
  legal_basis VARCHAR(50) NOT NULL, -- 'consent', 'contract', 'legitimate_interest', 'public_interest', 'vital_interest'
  purpose TEXT NOT NULL,
  recipient_info JSONB, -- 接收方信息
  data_subjects_affected INTEGER DEFAULT 0,
  risk_assessment JSONB,
  protection_measures TEXT[],
  scc_reference VARCHAR(100), -- 标准合同条款引用
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'executed', 'cancelled'
  approved_by INTEGER,
  approved_at TIMESTAMP,
  rejection_reason TEXT,
  executed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_requester FOREIGN KEY (requester_id) REFERENCES users(id),
  CONSTRAINT fk_approver FOREIGN KEY (approved_by) REFERENCES users(id),
  CONSTRAINT chk_different_regions CHECK (source_region != target_region)
);

-- 创建序列
CREATE SEQUENCE IF NOT EXISTS data_transfer_request_seq;

-- 4. 数据传输日志表
CREATE TABLE IF NOT EXISTS data_transfer_logs (
  id SERIAL PRIMARY KEY,
  transfer_request_id INTEGER REFERENCES data_transfer_requests(id),
  user_id INTEGER,
  source_region VARCHAR(20) NOT NULL,
  target_region VARCHAR(20) NOT NULL,
  data_type VARCHAR(50) NOT NULL,
  data_category VARCHAR(50), -- 'personal', 'sensitive', 'anonymous'
  legal_basis VARCHAR(50) NOT NULL,
  purpose VARCHAR(200),
  data_volume_kb INTEGER DEFAULT 0,
  transferred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB DEFAULT '{}'
);

-- 5. 标准合同条款表
CREATE TABLE IF NOT EXISTS standard_contractual_clauses (
  id SERIAL PRIMARY KEY,
  scc_code VARCHAR(50) NOT NULL UNIQUE,
  scc_name VARCHAR(200) NOT NULL,
  version VARCHAR(20) NOT NULL,
  issuer VARCHAR(100) NOT NULL, -- 'EU_Commission', 'country_specific'
  applicable_transfers TEXT[] NOT NULL, -- ['EU->US', 'EU->CN']
  content TEXT NOT NULL,
  effective_date DATE NOT NULL,
  expiry_date DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. 数据传输影响评估表
CREATE TABLE IF NOT EXISTS transfer_impact_assessments (
  id SERIAL PRIMARY KEY,
  assessment_id VARCHAR(50) NOT NULL UNIQUE DEFAULT ('TIA-' || to_char(now(), 'YYYYMMDD') || '-' || LPAD(nextval('tia_seq')::TEXT, 6, '0')),
  transfer_request_id INTEGER REFERENCES data_transfer_requests(id),
  assessor_id INTEGER REFERENCES users(id),
  
  -- 数据评估
  data_types_assessed TEXT[] NOT NULL,
  data_volume_estimate INTEGER,
  data_subjects_count INTEGER,
  sensitive_data_present BOOLEAN DEFAULT false,
  
  -- 法律环境评估
  source_region_laws JSONB DEFAULT '{}',
  target_region_laws JSONB DEFAULT '{}',
  legal_gaps TEXT[],
  
  -- 风险评估
  risk_level VARCHAR(20) NOT NULL, -- 'low', 'medium', 'high', 'very_high'
  identified_risks JSONB DEFAULT '[]',
  risk_mitigation_measures JSONB DEFAULT '[]',
  
  -- 结论
  recommendation VARCHAR(50) NOT NULL, -- 'approve', 'approve_with_conditions', 'reject'
  conditions TEXT[],
  assessment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  valid_until DATE,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建序列
CREATE SEQUENCE IF NOT EXISTS tia_seq;

-- 7. 索引优化
CREATE INDEX IF NOT EXISTS idx_user_data_regions_user ON user_data_regions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_data_regions_region ON user_data_regions(region_code);
CREATE INDEX IF NOT EXISTS idx_data_transfer_requests_status ON data_transfer_requests(status);
CREATE INDEX IF NOT EXISTS idx_data_transfer_requests_requester ON data_transfer_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_data_transfer_requests_created ON data_transfer_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_transfer_logs_user ON data_transfer_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_data_transfer_logs_transferred ON data_transfer_logs(transferred_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_transfer_logs_regions ON data_transfer_logs(source_region, target_region);
CREATE INDEX IF NOT EXISTS idx_transfer_impact_assessments_request ON transfer_impact_assessments(transfer_request_id);

-- 8. 初始化数据区域配置
INSERT INTO data_regions (region_code, region_name, countries, storage_location, applicable_laws, compliance_requirements) VALUES
('EU', 'European Union', ARRAY['DE','FR','IT','ES','NL','BE','AT','PT','IE','SE','DK','FI','GR','PL','CZ','HU','RO','BG','HR','SI','SK','EE','LV','LT','LU','MT','CY'], 'eu-west-1', ARRAY['GDPR', 'ePrivacy'], '{"consent_required": true, "dpo_required": true, "breach_notification_hours": 72}'),
('CN', 'China', ARRAY['CN'], 'cn-east-1', ARRAY['PIPL', 'DSL', 'Cybersecurity_Law'], '{"localization_required": true, "consent_required": true, "security_assessment_required": true}'),
('US', 'United States', ARRAY['US','CA'], 'us-east-1', ARRAY['CCPA', 'COPPA'], '{"ccpa_opt_out": true, "coppa_age_verification": true}'),
('RU', 'Russia', ARRAY['RU'], 'ru-central-1', ARRAY['RU_Data_Localization'], '{"localization_required": true}'),
('JP', 'Japan', ARRAY['JP'], 'ap-northeast-1', ARRAY['APPI'], '{"consent_required": true}'),
('GB', 'United Kingdom', ARRAY['GB'], 'eu-west-2', ARRAY['UK_GDPR'], '{"consent_required": true, "breach_notification_hours": 72}'),
('ROW', 'Rest of World', ARRAY['*'], 'us-east-1', ARRAY[], '{}')
ON CONFLICT (region_code) DO NOTHING;

-- 9. 初始化标准合同条款
INSERT INTO standard_contractual_clauses (scc_code, scc_name, version, issuer, applicable_transfers, content, effective_date) VALUES
('SCC-EU-2021', 'EU Standard Contractual Clauses (2021)', '2021', 'EU_Commission', ARRAY['EU->US','EU->CN','EU->RU','EU->JP','EU->ROW'], 'EU Commission Decision 2021/914 - Standard Contractual Clauses for the transfer of personal data to third countries...', '2021-06-27'),
('SCC-CN-PIPL', 'China Cross-border Data Transfer Agreement', '2022', 'CAC', ARRAY['CN->EU','CN->US'], 'Standard contract for cross-border transfer of personal information under PIPL Article 38...', '2022-09-01')
ON CONFLICT (scc_code) DO NOTHING;

-- 10. 注释
COMMENT ON TABLE data_regions IS '数据存储区域配置表';
COMMENT ON TABLE user_data_regions IS '用户数据区域映射表';
COMMENT ON TABLE data_transfer_requests IS '跨境传输请求表';
COMMENT ON TABLE data_transfer_logs IS '数据传输日志表';
COMMENT ON TABLE standard_contractual_clauses IS '标准合同条款表';
COMMENT ON TABLE transfer_impact_assessments IS '数据传输影响评估表';
