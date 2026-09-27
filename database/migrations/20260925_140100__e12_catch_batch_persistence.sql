-- migrate:up
-- REQ-00383：捕捉结果批处理与异步持久化（catch-service src/persistence/，CATCH_PERSISTENCE_MODE=batch 时启用）
-- 依赖：users（V1）、catch_throws（V1，主键 id UUID —— 批量写入用预生成 id + ON CONFLICT (id) DO NOTHING 去重）
-- 幂等：IF NOT EXISTS。

-- 1) 奖励 outbox：与"抢占野生精灵 + 创建实例 + 关闭会话"同一事务写入，提交即持久化；applier 批量聚合写入
--    users(xp/stardust) / candy_inventory / pokedex_entries / user_achievements 后在同一事务把 status 置为 applied（恰好一次）
CREATE TABLE IF NOT EXISTS catch_reward_outbox (
  id                 BIGSERIAL PRIMARY KEY,
  session_id         UUID NOT NULL UNIQUE,                 -- 一次捕捉会话只产生一条（重复提交被 ON CONFLICT 吸收）
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id         SMALLINT NOT NULL,
  xp                 INTEGER NOT NULL DEFAULT 0,
  stardust           INTEGER NOT NULL DEFAULT 0,
  candy              INTEGER NOT NULL DEFAULT 0,
  cp                 INTEGER NOT NULL DEFAULT 0,
  is_shiny           BOOLEAN NOT NULL DEFAULT FALSE,
  count_achievement  BOOLEAN NOT NULL DEFAULT TRUE,        -- 是否给 user_achievements('catch_total') +1（与同步路径对齐）
  caught_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dead')),
  attempts           SMALLINT NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_catch_reward_outbox_pending ON catch_reward_outbox (id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_catch_reward_outbox_dead ON catch_reward_outbox (id) WHERE status = 'dead';
CREATE INDEX IF NOT EXISTS idx_catch_reward_outbox_applied ON catch_reward_outbox (applied_at) WHERE status = 'applied';
CREATE INDEX IF NOT EXISTS idx_catch_reward_outbox_user ON catch_reward_outbox (user_id, created_at DESC);

-- 2) 死信（重试 CATCH_BATCH_MAX_RETRIES 次仍失败的投掷日志 / 奖励），POST /v1/catch/persistence/dead-letters/retry 补偿重放
CREATE TABLE IF NOT EXISTS catch_persist_failures (
  id           BIGSERIAL PRIMARY KEY,
  kind         VARCHAR(10) NOT NULL CHECK (kind IN ('throw', 'reward')),
  entry_id     VARCHAR(64) NOT NULL,     -- throw：Redis Stream 消息 ID；reward：catch_reward_outbox.id
  payload      JSONB NOT NULL DEFAULT '{}',
  error        TEXT,
  attempts     SMALLINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_catch_persist_failures_open ON catch_persist_failures (kind, id) WHERE resolved_at IS NULL;

COMMENT ON TABLE catch_reward_outbox IS 'REQ-00383 捕捉奖励 outbox（batch 模式）；applied 行保留 7 天后由 catch-service 清理';
COMMENT ON TABLE catch_persist_failures IS 'REQ-00383 批处理持久化死信';

-- migrate:down
DROP TABLE IF EXISTS catch_persist_failures;
DROP TABLE IF EXISTS catch_reward_outbox;
