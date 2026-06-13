-- database/pending/20260613_080000__add_openapi_i18n_tables.sql
-- OpenAPI 翻译管理表（REQ-00155）

-- OpenAPI 翻译键表（用于追踪翻译状态）
CREATE TABLE IF NOT EXISTS openapi_translation_keys (
  id SERIAL PRIMARY KEY,
  key VARCHAR(512) NOT NULL UNIQUE,
  category VARCHAR(64) NOT NULL, -- info, tags, paths, parameters, requestBody, responses
  source_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_openapi_keys_category ON openapi_translation_keys(category);

-- OpenAPI 翻译表
CREATE TABLE IF NOT EXISTS openapi_translations (
  id SERIAL PRIMARY KEY,
  key_id INTEGER REFERENCES openapi_translation_keys(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL, -- zh-CN, en-US, ja-JP
  translated_text TEXT NOT NULL,
  translated_by VARCHAR(64), -- 翻译者（手动翻译时记录）
  status VARCHAR(20) DEFAULT 'pending', -- pending, reviewed, approved
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(key_id, language)
);

CREATE INDEX IF NOT EXISTS idx_openapi_translations_lang ON openapi_translations(language);
CREATE INDEX IF NOT EXISTS idx_openapi_translations_status ON openapi_translations(status);

-- 翻译审计日志
CREATE TABLE IF NOT EXISTS openapi_translation_audit (
  id SERIAL PRIMARY KEY,
  key_id INTEGER REFERENCES openapi_translation_keys(id),
  language VARCHAR(10),
  action VARCHAR(32) NOT NULL, -- created, updated, deleted, reviewed
  old_value TEXT,
  new_value TEXT,
  changed_by VARCHAR(64),
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_openapi_audit_key ON openapi_translation_audit(key_id);
CREATE INDEX IF NOT EXISTS idx_openapi_audit_time ON openapi_translation_audit(changed_at DESC);

-- 注释
COMMENT ON TABLE openapi_translation_keys IS 'OpenAPI 翻译键表';
COMMENT ON TABLE openapi_translations IS 'OpenAPI 翻译表';
COMMENT ON TABLE openapi_translation_audit IS 'OpenAPI 翻译审计日志';
