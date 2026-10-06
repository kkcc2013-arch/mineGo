-- REQ-00053: conservative defaults and compatibility with both existing policy schemas.
-- New initialization does not invent consent. Existing choices and policy text are preserved.
CREATE TABLE IF NOT EXISTS user_privacy_preferences (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  category VARCHAR(32) NOT NULL,
  collectable BOOLEAN NOT NULL DEFAULT false,
  consented_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, category)
);
ALTER TABLE user_privacy_preferences ALTER COLUMN collectable SET DEFAULT false;

CREATE TABLE IF NOT EXISTS privacy_policy_versions (
  version VARCHAR(16) PRIMARY KEY,
  effective_date DATE,
  changes TEXT[],
  content_zh_cn TEXT,
  content_en_us TEXT,
  content_ja_jp TEXT,
  title VARCHAR(200),
  content TEXT,
  summary TEXT,
  published_at TIMESTAMP,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE privacy_policy_versions ALTER COLUMN version TYPE VARCHAR(16);
ALTER TABLE privacy_policy_versions ADD COLUMN IF NOT EXISTS effective_date DATE;
ALTER TABLE privacy_policy_versions ADD COLUMN IF NOT EXISTS changes TEXT[];
ALTER TABLE privacy_policy_versions ADD COLUMN IF NOT EXISTS content_zh_cn TEXT;
ALTER TABLE privacy_policy_versions ADD COLUMN IF NOT EXISTS content_en_us TEXT;
ALTER TABLE privacy_policy_versions ADD COLUMN IF NOT EXISTS content_ja_jp TEXT;
ALTER TABLE privacy_policy_versions ADD COLUMN IF NOT EXISTS title VARCHAR(200);
ALTER TABLE privacy_policy_versions ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE privacy_policy_versions ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;
ALTER TABLE privacy_policy_versions ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
-- Preserve legacy text without fabricating translations or earlier effective dates.
UPDATE privacy_policy_versions SET effective_date = published_at::date
WHERE effective_date IS NULL AND published_at IS NOT NULL;
UPDATE privacy_policy_versions SET content_zh_cn = content
WHERE content_zh_cn IS NULL AND content IS NOT NULL;

CREATE TABLE IF NOT EXISTS privacy_policy_acceptance (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  policy_version VARCHAR(16) NOT NULL,
  accepted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, policy_version)
);
CREATE TABLE IF NOT EXISTS data_transparency_reports (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  month VARCHAR(7) NOT NULL,
  report_json JSONB NOT NULL,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, month)
);
CREATE TABLE IF NOT EXISTS data_access_logs (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  category VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  purpose VARCHAR(128),
  details TEXT,
  accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  service VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS service VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_privacy_preference_policy_effective ON privacy_policy_versions(effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_preference_data_access ON data_access_logs(user_id, accessed_at DESC);
