-- E15 动态配置中心与 A/B 实验（REQ-00085 / REQ-00122 / REQ-00409 / REQ-00431 / REQ-00531）
--
-- 配置中心：PostgreSQL 为唯一可信源（config_entries 当前值 + config_history 版本/修订），
--           Redis 只做变更通知（pub/sub）与快照副本；审计写入 config_audit_log（永久保留）。
-- 实验：experiments（定义）+ experiment_exposures（曝光，每用户一行）+ experiment_conversions（转化，每用户每指标一行）。
--
-- 幂等：全部 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS；依赖 users(id UUID)（V1__initial_schema.sql）。

-- ============================================================
-- 1. 配置项当前值
-- ============================================================
CREATE TABLE IF NOT EXISTS config_entries (
  id              BIGSERIAL PRIMARY KEY,
  environment     VARCHAR(20)  NOT NULL,
  service         VARCHAR(64)  NOT NULL DEFAULT '*',          -- '*' = 全局，其它 = 服务名（覆盖全局）
  config_key      VARCHAR(200) NOT NULL,
  value           JSONB        NOT NULL,                       -- 敏感配置为 "enc:v1:…" 密文字符串
  description     TEXT,
  is_secret       BOOLEAN      NOT NULL DEFAULT FALSE,
  version         INTEGER      NOT NULL DEFAULT 1,             -- 该键的版本号（删除后重建继续递增）
  canary_value    JSONB,                                       -- 灰度值（命中 canary_targets 的实例使用）
  canary_targets  JSONB,                                       -- {"instances":[…],"groups":[…],"services":[…]}
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_config_entries_env_service_key UNIQUE (environment, service, config_key),
  CONSTRAINT ck_config_entries_env CHECK (environment IN ('development', 'test', 'staging', 'production')),
  CONSTRAINT ck_config_entries_version CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS idx_config_entries_env_service ON config_entries(environment, service);

-- ============================================================
-- 2. 版本历史（id 即全局修订号 revision；每个键保留最近 100 个版本，由应用在写入时裁剪）
-- ============================================================
CREATE TABLE IF NOT EXISTS config_history (
  id              BIGSERIAL PRIMARY KEY,
  environment     VARCHAR(20)  NOT NULL,
  service         VARCHAR(64)  NOT NULL,
  config_key      VARCHAR(200) NOT NULL,
  version         INTEGER      NOT NULL,
  action          VARCHAR(20)  NOT NULL,
  old_value       JSONB,
  new_value       JSONB,
  canary_value    JSONB,
  canary_targets  JSONB,
  is_secret       BOOLEAN      NOT NULL DEFAULT FALSE,
  changed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  change_reason   TEXT,
  request_id      VARCHAR(64),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_config_history_action CHECK (action IN ('create', 'update', 'delete', 'rollback', 'canary_set', 'canary_promote', 'canary_abort'))
);

CREATE INDEX IF NOT EXISTS idx_config_history_entry ON config_history(environment, service, config_key, id DESC);
CREATE INDEX IF NOT EXISTS idx_config_history_env_id ON config_history(environment, id DESC);

-- ============================================================
-- 3. 审计日志（沿用 20260613150000_config_audit_log.js 建的表，补充列；永久保留）
-- ============================================================
CREATE TABLE IF NOT EXISTS config_audit_log (
  id            SERIAL PRIMARY KEY,
  service_name  VARCHAR(100) NOT NULL,
  config_key    VARCHAR(200) NOT NULL,
  old_value     JSONB,
  new_value     JSONB,
  changed_by    VARCHAR(200) NOT NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE config_audit_log ADD COLUMN IF NOT EXISTS environment VARCHAR(20);
ALTER TABLE config_audit_log ADD COLUMN IF NOT EXISTS action      VARCHAR(40);
ALTER TABLE config_audit_log ADD COLUMN IF NOT EXISTS version     INTEGER;
ALTER TABLE config_audit_log ADD COLUMN IF NOT EXISTS actor_id    UUID;          -- 不加外键：用户删除后审计仍保留
ALTER TABLE config_audit_log ADD COLUMN IF NOT EXISTS request_id  VARCHAR(64);
ALTER TABLE config_audit_log ADD COLUMN IF NOT EXISTS ip          VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_config_audit_service    ON config_audit_log(service_name);
CREATE INDEX IF NOT EXISTS idx_config_audit_created_at ON config_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_config_audit_key        ON config_audit_log(config_key);
CREATE INDEX IF NOT EXISTS idx_config_audit_env_created ON config_audit_log(environment, created_at DESC);

-- ============================================================
-- 4. A/B 实验定义
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS experiments_revision_seq;

CREATE TABLE IF NOT EXISTS experiments (
  id               BIGSERIAL PRIMARY KEY,
  environment      VARCHAR(20)  NOT NULL DEFAULT 'production',
  exp_key          VARCHAR(100) NOT NULL,
  name             VARCHAR(200) NOT NULL,
  description      TEXT,
  hypothesis       TEXT,
  status           VARCHAR(20)  NOT NULL DEFAULT 'draft',
  salt             VARCHAR(64)  NOT NULL,                      -- 分桶盐：默认=exp_key，换盐即重新随机
  traffic_percent  NUMERIC(5,2) NOT NULL DEFAULT 100,
  variants         JSONB        NOT NULL,                      -- [{"key":"control","weight":50,"config":{…}}, …]
  targeting        JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- {"platforms":[…],"minLevel":n,"maxLevel":n,"overrides":{"<uid>":"variant"}}
  primary_metric   VARCHAR(100) NOT NULL DEFAULT 'conversion',
  guardrails       JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- {"metrics":[{"metric":"crash","direction":"decrease"}],"minSamplePerVariant":100,"srmPValue":0.001,"autoPause":true}
  pause_reason     TEXT,
  winner           VARCHAR(50),
  revision         BIGINT       NOT NULL DEFAULT nextval('experiments_revision_seq'),
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_experiments_env_key UNIQUE (environment, exp_key),
  CONSTRAINT ck_experiments_status CHECK (status IN ('draft', 'running', 'paused', 'stopped', 'completed')),
  CONSTRAINT ck_experiments_traffic CHECK (traffic_percent >= 0 AND traffic_percent <= 100)
);

CREATE INDEX IF NOT EXISTS idx_experiments_env_status ON experiments(environment, status);

-- ============================================================
-- 5. 曝光（去重：每个实验每个用户一行，记录首次曝光的变体）
-- ============================================================
CREATE TABLE IF NOT EXISTS experiment_exposures (
  experiment_id     BIGINT      NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant           VARCHAR(50) NOT NULL,
  exposure_count    INTEGER     NOT NULL DEFAULT 1,
  first_exposed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_exposed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  context           JSONB,
  PRIMARY KEY (experiment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_experiment_exposures_variant ON experiment_exposures(experiment_id, variant);

-- ============================================================
-- 6. 转化（二元指标：每个实验每个用户每个指标一行，变体取自曝光记录）
-- ============================================================
CREATE TABLE IF NOT EXISTS experiment_conversions (
  id                  BIGSERIAL PRIMARY KEY,
  experiment_id       BIGINT       NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  user_id             UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant             VARCHAR(50)  NOT NULL,
  metric              VARCHAR(100) NOT NULL,
  value               NUMERIC      NOT NULL DEFAULT 1,
  occurrences         INTEGER      NOT NULL DEFAULT 1,
  first_converted_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_converted_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_experiment_conversions UNIQUE (experiment_id, user_id, metric)
);

CREATE INDEX IF NOT EXISTS idx_experiment_conversions_metric ON experiment_conversions(experiment_id, metric, variant);

COMMENT ON TABLE config_entries IS 'E15 配置中心：配置当前值（PostgreSQL 为可信源）';
COMMENT ON TABLE config_history IS 'E15 配置中心：版本历史，id 为全局修订号，每键保留最近 100 版';
COMMENT ON TABLE experiments IS 'E15 A/B 实验定义';
COMMENT ON TABLE experiment_exposures IS 'E15 A/B 实验曝光（每实验每用户一行）';
COMMENT ON TABLE experiment_conversions IS 'E15 A/B 实验转化（每实验每用户每指标一行）';
