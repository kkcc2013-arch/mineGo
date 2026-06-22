-- REQ-00044: API 版本管理数据库表
-- 创建时间: 2026-06-22

-- API 版本定义表
CREATE TABLE IF NOT EXISTS api_versions (
    version INTEGER PRIMARY KEY,
    released DATE NOT NULL,
    deprecated DATE,
    sunset DATE,
    deprecation_period INTEGER DEFAULT 180,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- API 变更记录表
CREATE TABLE IF NOT EXISTS api_changes (
    id SERIAL PRIMARY KEY,
    version INTEGER NOT NULL REFERENCES api_versions(version),
    change_type VARCHAR(20) NOT NULL,  -- added, changed, deprecated, removed
    path VARCHAR(500) NOT NULL,
    description TEXT NOT NULL,
    change_date DATE NOT NULL DEFAULT CURRENT_DATE,
    breaking_change BOOLEAN DEFAULT false,
    migration_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_changes_version ON api_changes(version);
CREATE INDEX idx_api_changes_path ON api_changes(path);

-- API 版本使用统计表
CREATE TABLE IF NOT EXISTS api_version_usage (
    id SERIAL PRIMARY KEY,
    version INTEGER NOT NULL,
    endpoint VARCHAR(500) NOT NULL,
    request_count BIGINT DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    UNIQUE(version, endpoint, date)
);

CREATE INDEX idx_api_version_usage_lookup ON api_version_usage(version, endpoint, date);

-- API 废弃告警记录表
CREATE TABLE IF NOT EXISTS api_deprecation_warnings (
    id SERIAL PRIMARY KEY,
    version INTEGER NOT NULL,
    endpoint VARCHAR(500) NOT NULL,
    user_id UUID,
    user_agent TEXT,
    ip_address INET,
    warned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_deprecation_warnings_version ON api_deprecation_warnings(version, warned_at DESC);

-- 初始化版本数据
INSERT INTO api_versions (version, released, description) VALUES
    (1, '2026-06-01', '初始版本'),
    (2, '2026-06-22', '性能优化版本，新增批量查询')
ON CONFLICT (version) DO NOTHING;

-- 初始化变更记录
INSERT INTO api_changes (version, change_type, path, description, change_date) VALUES
    (2, 'added', '/api/v2/catch/nearby', '新增稀有度过滤参数 rarity', '2026-06-22'),
    (2, 'changed', '/api/v2/users/profile', '响应增加 stats 字段', '2026-06-22'),
    (2, 'added', '/api/v2/pokemon/batch', '新增批量查询接口', '2026-06-22')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE api_versions IS 'API 版本定义表';
COMMENT ON TABLE api_changes IS 'API 变更记录表';
COMMENT ON TABLE api_version_usage IS 'API 版本使用统计表';
COMMENT ON TABLE api_deprecation_warnings IS 'API 废弃告警记录表';
