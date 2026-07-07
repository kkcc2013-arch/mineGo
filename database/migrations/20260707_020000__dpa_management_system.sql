-- 20260707_020000__dpa_management_system.sql
-- REQ-00467: 第三方数据处理协议管理系统

-- 创建供应商表
CREATE TABLE IF NOT EXISTS dpa_vendors (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL, -- cloud_provider, payment_gateway, push_service, analytics, cdn, etc.
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(50),
    country VARCHAR(100) NOT NULL,
    data_types_processed TEXT[] NOT NULL, -- personal_data, payment_data, location_data, etc.
    processing_purpose TEXT NOT NULL,
    data_residency_countries TEXT[],
    contract_reference VARCHAR(255),
    notes TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, agreement_pending, agreement_active, agreement_expired, suspended
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT valid_vendor_status CHECK (status IN ('pending', 'agreement_pending', 'agreement_active', 'agreement_expired', 'suspended'))
);

CREATE INDEX idx_dpa_vendors_status ON dpa_vendors(status);
CREATE INDEX idx_dpa_vendors_type ON dpa_vendors(type);
CREATE INDEX idx_dpa_vendors_name ON dpa_vendors(name);

-- 创建协议表
CREATE TABLE IF NOT EXISTS dpa_agreements (
    id SERIAL PRIMARY KEY,
    vendor_id INTEGER NOT NULL REFERENCES dpa_vendors(id),
    agreement_type VARCHAR(50) NOT NULL, -- standard_dpa, custom_dpa, privacy_addendum
    document_path VARCHAR(500),
    document_hash VARCHAR(64), -- SHA256
    effective_date DATE NOT NULL,
    expiry_date DATE,
    signatory_name VARCHAR(255) NOT NULL,
    signatory_title VARCHAR(255),
    signed_date DATE NOT NULL,
    version VARCHAR(50) NOT NULL DEFAULT '1.0',
    summary TEXT,
    special_conditions TEXT[],
    status VARCHAR(50) NOT NULL DEFAULT 'pending_approval', -- pending_approval, approved, rejected, expired, renewed
    approved_by INTEGER,
    approved_at TIMESTAMP,
    approval_comments TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT valid_agreement_status CHECK (status IN ('pending_approval', 'approved', 'rejected', 'expired', 'renewed'))
);

CREATE INDEX idx_dpa_agreements_vendor ON dpa_agreements(vendor_id);
CREATE INDEX idx_dpa_agreements_status ON dpa_agreements(status);
CREATE INDEX idx_dpa_agreements_expiry ON dpa_agreements(expiry_date);

-- 创建变更历史表
CREATE TABLE IF NOT EXISTS dpa_change_history (
    id SERIAL PRIMARY KEY,
    agreement_id INTEGER NOT NULL REFERENCES dpa_agreements(id),
    action VARCHAR(50) NOT NULL, -- created, approval, rejection, renewal, termination, update
    old_status VARCHAR(50),
    new_status VARCHAR(50),
    changed_by INTEGER,
    change_reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_dpa_change_history_agreement ON dpa_change_history(agreement_id);

-- 创建到期提醒表
CREATE TABLE IF NOT EXISTS dpa_expiry_alerts (
    id SERIAL PRIMARY KEY,
    agreement_id INTEGER NOT NULL REFERENCES dpa_agreements(id),
    alert_days INTEGER NOT NULL, -- 90, 60, 30
    alert_sent BOOLEAN DEFAULT FALSE,
    sent_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_expiry_alert UNIQUE (agreement_id, alert_days)
);

CREATE INDEX idx_dpa_expiry_alerts_agreement ON dpa_expiry_alerts(agreement_id);

-- 创建审计日志视图
CREATE OR REPLACE VIEW dpa_compliance_view AS
SELECT 
    v.id as vendor_id,
    v.name as vendor_name,
    v.type as vendor_type,
    v.status as vendor_status,
    COUNT(a.id) as agreement_count,
    MAX(a.expiry_date) as latest_expiry,
    CASE 
        WHEN MAX(a.expiry_date) < CURRENT_TIMESTAMP THEN 'expired'
        WHEN MAX(a.expiry_date) <= CURRENT_TIMESTAMP + INTERVAL '30 days' THEN 'critical'
        WHEN MAX(a.expiry_date) <= CURRENT_TIMESTAMP + INTERVAL '90 days' THEN 'warning'
        ELSE 'active'
    END as expiry_status
FROM dpa_vendors v
LEFT JOIN dpa_agreements a ON v.id = a.vendor_id AND a.status = 'approved'
GROUP BY v.id, v.name, v.type, v.status;

COMMENT ON TABLE dpa_vendors IS '第三方数据处理供应商信息';
COMMENT ON TABLE dpa_agreements IS '数据处理协议文档记录';
COMMENT ON TABLE dpa_change_history IS '协议变更历史审计日志';
COMMENT ON TABLE dpa_expiry_alerts IS '协议到期提醒记录';