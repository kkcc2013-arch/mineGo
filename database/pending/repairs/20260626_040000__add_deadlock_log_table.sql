-- database/pending/20260611_002000__add_deadlock_log_table.sql
/**
 * REQ-00096: 数据库事务隔离级别控制与死锁检测机制
 * 死锁日志表迁移
 */

-- 创建死锁日志表
CREATE TABLE IF NOT EXISTS deadlock_log (
  id SERIAL PRIMARY KEY,
  code VARCHAR(10) NOT NULL,
  message TEXT,
  detail TEXT,
  processes JSONB,
  transaction_name VARCHAR(255),
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Preserve the older documented context-only layout and unknown historical retry metadata.
DO $legacy$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='deadlock_log'::regclass AND attname='transaction_name' AND NOT attisdropped) THEN
    ALTER TABLE deadlock_log ADD COLUMN transaction_name VARCHAR(255);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='deadlock_log'::regclass AND attname='retry_count' AND NOT attisdropped) THEN
    ALTER TABLE deadlock_log ADD COLUMN retry_count INTEGER;
    ALTER TABLE deadlock_log ALTER COLUMN retry_count SET DEFAULT 0;
  END IF;
  ALTER TABLE deadlock_log ADD COLUMN IF NOT EXISTS context JSONB;
  IF EXISTS(SELECT 1 FROM (VALUES('id','integer'),('code','character varying(10)'),('message','text'),('detail','text'),('processes','jsonb'),('transaction_name','character varying(255)'),('retry_count','integer'),('context','jsonb'),('created_at','timestamp without time zone')) expected(name,type)
    LEFT JOIN pg_attribute a ON a.attrelid='deadlock_log'::regclass AND a.attname=expected.name AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR format_type(a.atttypid,a.atttypmod)<>expected.type) THEN
    RAISE EXCEPTION 'Deadlock log schema requires explicit adoption';
  END IF;
END
$legacy$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_deadlock_log_created_at ON deadlock_log(created_at);
CREATE INDEX IF NOT EXISTS idx_deadlock_log_code ON deadlock_log(code);
CREATE INDEX IF NOT EXISTS idx_deadlock_log_transaction_name ON deadlock_log(transaction_name);

-- 添加表注释
COMMENT ON TABLE deadlock_log IS 'REQ-00096: 记录死锁事件，用于分析和优化';

COMMENT ON COLUMN deadlock_log.code IS 'PostgreSQL 错误代码（40P01=死锁, 40001=序列化失败）';
COMMENT ON COLUMN deadlock_log.message IS '错误消息';
COMMENT ON COLUMN deadlock_log.detail IS '错误详情（包含死锁进程信息）';
COMMENT ON COLUMN deadlock_log.processes IS '死锁涉及的进程ID列表（JSON数组）';
COMMENT ON COLUMN deadlock_log.transaction_name IS '事务名称（用于监控）';
COMMENT ON COLUMN deadlock_log.retry_count IS '重试次数';
COMMENT ON COLUMN deadlock_log.created_at IS '创建时间';
