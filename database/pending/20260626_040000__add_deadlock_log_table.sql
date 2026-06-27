// database/pending/20260611_002000__add_deadlock_log_table.sql
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
