-- migrate:up
-- REQ-00044: GDPR 账号删除申请（冷却期后自动清理）
CREATE TABLE IF NOT EXISTS gdpr_deletion_requests (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'CANCELLED', 'PROCESSING', 'COMPLETED', 'FAILED')),
  reason        TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_for TIMESTAMPTZ NOT NULL,
  cancelled_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  summary       JSONB,
  error         TEXT
);
-- 每个用户同时最多一个待处理申请
CREATE UNIQUE INDEX IF NOT EXISTS uq_gdpr_deletion_pending
  ON gdpr_deletion_requests(user_id) WHERE status IN ('PENDING', 'PROCESSING');
CREATE INDEX IF NOT EXISTS idx_gdpr_deletion_due
  ON gdpr_deletion_requests(scheduled_for) WHERE status = 'PENDING';

-- 被清理的账号保留一行匿名记录（订单等财务数据依法保留并引用该行）
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- migrate:down
DROP TABLE IF EXISTS gdpr_deletion_requests;
ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;
