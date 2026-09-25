-- Epic E25 API 设计规范：版本生命周期 / 版本转换规则 / 端点弃用 / 契约注册中心 / 字段集 / 批量请求 / 转换管道
-- REQ-00201 REQ-00308 REQ-00315 REQ-00407 REQ-00520 REQ-00532 REQ-00542 REQ-00547
-- 幂等：全部 IF NOT EXISTS / ON CONFLICT DO NOTHING

-- ── REQ-00201 / REQ-00520：版本生命周期（在 REQ-00044 的 api_versions 上扩展） ─────────────
CREATE TABLE IF NOT EXISTS api_versions (
    version INTEGER PRIMARY KEY,
    released DATE NOT NULL DEFAULT CURRENT_DATE,
    deprecated DATE,
    sunset DATE,
    deprecation_period INTEGER DEFAULT 180,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE api_versions ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'stable';
ALTER TABLE api_versions ADD COLUMN IF NOT EXISTS successor_version INTEGER;
ALTER TABLE api_versions ADD COLUMN IF NOT EXISTS migration_guide TEXT;
ALTER TABLE api_versions ALTER COLUMN deprecated TYPE TIMESTAMPTZ USING deprecated::timestamptz;
ALTER TABLE api_versions ALTER COLUMN sunset TYPE TIMESTAMPTZ USING sunset::timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_versions_status_check') THEN
    ALTER TABLE api_versions ADD CONSTRAINT api_versions_status_check
      CHECK (status IN ('development', 'testing', 'stable', 'deprecated', 'sunset'));
  END IF;
END $$;
INSERT INTO api_versions (version, released, description, status, successor_version) VALUES
    (1, '2026-06-01', '初始版本', 'stable', 2),
    (2, '2026-06-22', '性能优化版本，新增批量查询', 'stable', NULL)
ON CONFLICT (version) DO NOTHING;
UPDATE api_versions SET successor_version = 2 WHERE version = 1 AND successor_version IS NULL;

CREATE TABLE IF NOT EXISTS api_changes (
    id SERIAL PRIMARY KEY,
    version INTEGER NOT NULL REFERENCES api_versions(version),
    change_type VARCHAR(20) NOT NULL,
    path VARCHAR(500) NOT NULL,
    description TEXT NOT NULL,
    change_date DATE NOT NULL DEFAULT CURRENT_DATE,
    breaking_change BOOLEAN DEFAULT false,
    migration_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO api_changes (version, change_type, path, description, change_date, breaking_change, migration_notes)
SELECT v.version, v.change_type, v.path, v.description, v.change_date::date, v.breaking_change, v.migration_notes
FROM (VALUES
    (2, 'changed', '/api/v2/users/:id/profile', '响应增加 stats / achievements 字段（v1 由网关版本转换规则移除，保持兼容）', '2026-06-22', false, '旧客户端无需修改；v1 继续返回旧结构'),
    (2, 'changed', '/api/v2/pokemon', '响应增加 moves 字段', '2026-06-22', false, NULL),
    (2, 'added', '/api/v2/catch/nearby', '新增稀有度过滤参数 rarity', '2026-06-22', false, NULL)
) AS v(version, change_type, path, description, change_date, breaking_change, migration_notes)
WHERE NOT EXISTS (SELECT 1 FROM api_changes c WHERE c.version = v.version AND c.path = v.path AND c.change_type = v.change_type);

CREATE TABLE IF NOT EXISTS api_version_usage (
    id SERIAL PRIMARY KEY,
    version INTEGER NOT NULL,
    endpoint VARCHAR(500) NOT NULL,
    request_count BIGINT DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    UNIQUE (version, endpoint, date)
);

-- 版本间请求/响应声明式转换规则（op: remove/rename/default/set/move）
CREATE TABLE IF NOT EXISTS api_version_transforms (
    id VARCHAR(100) PRIMARY KEY,
    version INTEGER NOT NULL,
    method VARCHAR(10) NOT NULL DEFAULT '*',
    path VARCHAR(255) NOT NULL,
    description TEXT,
    request_ops JSONB NOT NULL DEFAULT '[]'::jsonb,
    response_ops JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_version_transforms_version ON api_version_transforms (version) WHERE enabled;

-- ── REQ-00407：端点弃用与客户端迁移追踪 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_deprecations (
    id SERIAL PRIMARY KEY,
    endpoint VARCHAR(255) NOT NULL,
    method VARCHAR(10) NOT NULL DEFAULT 'GET',
    deprecated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sunset_at TIMESTAMPTZ NOT NULL,
    successor_endpoint VARCHAR(255),
    migration_guide TEXT,
    breaking_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
    affected_clients JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_deprecations_status_check') THEN
    ALTER TABLE api_deprecations ADD CONSTRAINT api_deprecations_status_check CHECK (status IN ('active', 'sunset', 'removed', 'cancelled'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_deprecations_endpoint ON api_deprecations (endpoint, method);
CREATE INDEX IF NOT EXISTS idx_deprecations_sunset ON api_deprecations (sunset_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS client_migration_status (
    id SERIAL PRIMARY KEY,
    client_id VARCHAR(100) NOT NULL,
    client_version VARCHAR(50),
    deprecation_id INTEGER REFERENCES api_deprecations(id) ON DELETE CASCADE,
    user_id UUID,
    last_deprecated_call_at TIMESTAMPTZ,
    deprecated_call_count INTEGER DEFAULT 0,
    migrated_at TIMESTAMPTZ,
    notification_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE client_migration_status ADD COLUMN IF NOT EXISTS user_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_migration ON client_migration_status (client_id, deprecation_id);

-- ── REQ-00315 / REQ-00547：契约注册中心（每次契约内容变化生成新版本） ─────────────────
CREATE TABLE IF NOT EXISTS api_schema_registry (
    id SERIAL PRIMARY KEY,
    contract_id VARCHAR(100) NOT NULL,
    version INTEGER NOT NULL,
    hash CHAR(64) NOT NULL,
    service VARCHAR(100),
    method VARCHAR(10) NOT NULL,
    route VARCHAR(255) NOT NULL,
    schema JSONB NOT NULL,
    request_schema JSONB,
    definitions JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (contract_id, version),
    UNIQUE (contract_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_api_schema_registry_contract ON api_schema_registry (contract_id, version DESC);

-- ── REQ-00532：字段集与字段使用统计 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fieldset_configs (
    id SERIAL PRIMARY KEY,
    resource_type VARCHAR(100) NOT NULL,
    fieldset_name VARCHAR(50) NOT NULL,
    fields JSONB,
    description TEXT,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (resource_type, fieldset_name)
);
CREATE INDEX IF NOT EXISTS idx_fieldset_resource ON fieldset_configs (resource_type);
CREATE INDEX IF NOT EXISTS idx_fieldset_default ON fieldset_configs (resource_type, is_default);

CREATE TABLE IF NOT EXISTS field_usage_stats (
    id SERIAL PRIMARY KEY,
    resource_type VARCHAR(100) NOT NULL,
    field_name VARCHAR(100) NOT NULL,
    request_count BIGINT DEFAULT 0,
    last_requested_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (resource_type, field_name)
);
CREATE INDEX IF NOT EXISTS idx_field_usage_resource ON field_usage_stats (resource_type);
CREATE INDEX IF NOT EXISTS idx_field_usage_count ON field_usage_stats (request_count DESC);

-- 字段名与服务实际返回一致（下划线命名）；fields 为 NULL 表示完整字段
INSERT INTO fieldset_configs (resource_type, fieldset_name, fields, description, is_default) VALUES
    ('pokemon', 'list', '["id", "species_id", "nickname", "cp", "is_shiny", "sprite_url", "name_zh", "name_en"]', '精灵列表最小字段集', true),
    ('pokemon', 'detail', NULL, '精灵完整信息', false),
    ('pokemon', 'battle', '["id", "species_id", "nickname", "cp", "hp_current", "hp_max", "iv_attack", "iv_defense", "iv_hp", "fast_move", "charge_move", "type1", "type2"]', '战斗所需字段', false),
    ('pokemon', 'social', '["id", "species_id", "nickname", "cp", "is_shiny", "is_lucky", "caught_at", "sprite_url"]', '社交展示字段', false),
    ('species', 'list', '["id", "name", "type1", "type2", "rarity", "sprite_url"]', '图鉴列表', true),
    ('user', 'profile', '["id", "nickname", "level", "xp", "team", "avatar_url", "created_at"]', '用户档案字段', true),
    ('user', 'minimal', '["id", "nickname", "avatar_url"]', '最小用户信息', false),
    ('gym', 'list', '["id", "name", "team", "lat", "lng", "level"]', '道馆列表字段', true),
    ('gym', 'detail', NULL, '道馆完整信息', false)
ON CONFLICT (resource_type, fieldset_name) DO NOTHING;

-- ── REQ-00308：批量请求统计与模板 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS batch_request_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    request_count INTEGER NOT NULL,
    success_count INTEGER NOT NULL,
    cached_count INTEGER NOT NULL,
    total_duration_ms INTEGER NOT NULL,
    cost_saved_usd DECIMAL(12, 8) DEFAULT 0,
    endpoint_group VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_batch_stats_user ON batch_request_stats (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_batch_stats_created ON batch_request_stats (created_at DESC);

CREATE TABLE IF NOT EXISTS batch_request_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    requests JSONB NOT NULL,
    options JSONB DEFAULT '{}'::jsonb,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_batch_templates_name ON batch_request_templates (name);

-- 预定义模板：路径均为网关对外路径，{id}/{lat}/{lng} 由调用方 params 填充
INSERT INTO batch_request_templates (name, description, requests, options) VALUES
    ('pokemon-detail', '精灵详情页：详情 + 图鉴种类 + 个人图鉴',
     '[{"id":"pokemon","path":"/v1/pokemon/my/{id}","priority":"high"},{"id":"species","path":"/v1/pokemon/species/{speciesId}","priority":"normal"},{"id":"pokedex","path":"/v1/pokemon/pokedex","priority":"low"}]',
     '{"parallel": true, "maxParallel": 3}'),
    ('friends-list', '好友页：好友列表 + 礼物',
     '[{"id":"friends","path":"/v1/friends","priority":"high"},{"id":"gifts","path":"/v1/friends/gifts","priority":"normal"}]',
     '{"parallel": true}'),
    ('inventory', '背包页：道具 + 精灵 + 个人信息',
     '[{"id":"items","path":"/v1/users/me/inventory","priority":"high"},{"id":"pokemon","path":"/v1/pokemon/my?pageSize=20","priority":"high"},{"id":"me","path":"/v1/users/me","priority":"normal"}]',
     '{"parallel": true}'),
    ('home', '首页：个人信息 + 每日签到 + 附近',
     '[{"id":"me","path":"/v1/users/me","priority":"high"},{"id":"daily","path":"/v1/rewards/daily","priority":"normal"},{"id":"nearby","path":"/v1/map/nearby?lat={lat}&lng={lng}&radius=1000","priority":"high"}]',
     '{"parallel": true}')
ON CONFLICT (name) DO NOTHING;

-- ── REQ-00542：转换管道与声明式转换器（管理接口持久化） ───────────────────────
CREATE TABLE IF NOT EXISTS api_transform_pipelines (
    name VARCHAR(64) PRIMARY KEY,
    config JSONB NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    updated_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_transformers (
    name VARCHAR(64) PRIMARY KEY,
    type VARCHAR(32) NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── REQ-00402：网关使用的重试配置 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS retry_configs (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL UNIQUE,
    max_retries INTEGER DEFAULT 3,
    initial_delay_ms INTEGER DEFAULT 100,
    max_delay_ms INTEGER DEFAULT 30000,
    backoff_type VARCHAR(20) DEFAULT 'exponential',
    jitter_type VARCHAR(20) DEFAULT 'full',
    timeout_ms INTEGER DEFAULT 30000,
    retry_budget_max INTEGER DEFAULT 100,
    retry_budget_refill INTEGER DEFAULT 10,
    error_config JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
INSERT INTO retry_configs (service_name, max_retries, initial_delay_ms, max_delay_ms, backoff_type, jitter_type, timeout_ms, retry_budget_max, retry_budget_refill) VALUES
    ('gateway-batch', 2, 50, 1000, 'exponential', 'full', 5000, 50, 10),
    ('gateway-proxy', 2, 100, 800, 'exponential', 'decorrelated', 10000, 30, 5)
ON CONFLICT (service_name) DO NOTHING;

COMMENT ON TABLE api_version_transforms IS 'REQ-00201 版本间声明式转换规则';
COMMENT ON TABLE api_deprecations IS 'REQ-00407 端点弃用登记';
COMMENT ON TABLE client_migration_status IS 'REQ-00407 客户端迁移进度';
COMMENT ON TABLE api_schema_registry IS 'REQ-00315/00547 契约注册中心（版本化）';
COMMENT ON TABLE fieldset_configs IS 'REQ-00532 字段集配置';
COMMENT ON TABLE field_usage_stats IS 'REQ-00532 字段使用统计';
COMMENT ON TABLE batch_request_stats IS 'REQ-00308 批量请求统计';
COMMENT ON TABLE batch_request_templates IS 'REQ-00308 批量请求模板';
COMMENT ON TABLE api_transform_pipelines IS 'REQ-00542 管理接口创建的转换管道';
COMMENT ON TABLE api_transformers IS 'REQ-00542 声明式转换器';
