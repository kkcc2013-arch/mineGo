-- REQ-00519: 后端任务队列可靠性增强与死信处理系统
-- 创建死信队列（DLQ）相关表结构

-- 死信队列表
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id SERIAL PRIMARY KEY,
  task_id VARCHAR(100) NOT NULL UNIQUE,
  task_type VARCHAR(50) NOT NULL,
  task_data JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'dead_letter',
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  error_stack TEXT,
  error_code VARCHAR(50),
  moved_to_dlq_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retried_from_dlq_at TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id),
  resolution_note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_dlq_task_id ON dead_letter_queue(task_id);
CREATE INDEX IF NOT EXISTS idx_dlq_task_type ON dead_letter_queue(task_type, moved_to_dlq_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_status ON dead_letter_queue(status);
CREATE INDEX IF NOT EXISTS idx_dlq_moved_at ON dead_letter_queue(moved_to_dlq_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_error_code ON dead_letter_queue(error_code);

-- 任务执行历史表
CREATE TABLE IF NOT EXISTS task_execution_history (
  id SERIAL PRIMARY KEY,
  task_id VARCHAR(100) NOT NULL,
  task_type VARCHAR(50) NOT NULL,
  attempt_number INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL,
  error_message TEXT,
  execution_time_ms INTEGER,
  retry_delay_ms INTEGER,
  executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_task_history_task_id ON task_execution_history(task_id);
CREATE INDEX IF NOT EXISTS idx_task_history_type ON task_execution_history(task_type, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_history_status ON task_execution_history(status, executed_at DESC);

-- 任务重试配置表
CREATE TABLE IF NOT EXISTS task_retry_config (
  id SERIAL PRIMARY KEY,
  task_type VARCHAR(50) NOT NULL UNIQUE,
  max_retries INTEGER NOT NULL DEFAULT 5,
  base_delay_ms INTEGER NOT NULL DEFAULT 1000,
  max_delay_ms INTEGER NOT NULL DEFAULT 60000,
  backoff_factor DECIMAL(3, 2) NOT NULL DEFAULT 2.0,
  jitter_enabled BOOLEAN NOT NULL DEFAULT true,
  jitter_range DECIMAL(3, 2) NOT NULL DEFAULT 0.5,
  alert_threshold INTEGER NOT NULL DEFAULT 50,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 插入默认配置
INSERT INTO task_retry_config (task_type, max_retries, base_delay_ms, max_delay_ms, backoff_factor, jitter_enabled, jitter_range, alert_threshold) VALUES
  ('data_deletion', 3, 500, 10000, 1.5, true, 0.3, 20),
  ('data_export', 10, 2000, 100000, 2.5, true, 0.5, 10),
  ('backup', 5, 1000, 60000, 2.0, true, 0.5, 30),
  ('index_maintenance', 7, 1000, 90000, 2.0, true, 0.4, 40),
  ('alert', 15, 100, 30000, 1.5, true, 0.2, 5),
  ('payment', 8, 500, 30000, 2.0, true, 0.3, 10),
  ('notification', 5, 200, 20000, 2.0, true, 0.4, 50),
  ('default', 5, 1000, 60000, 2.0, true, 0.5, 50)
ON CONFLICT (task_type) DO NOTHING;

-- DLQ 告警日志表
CREATE TABLE IF NOT EXISTS dlq_alerts (
  id SERIAL PRIMARY KEY,
  alert_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  dlq_size INTEGER NOT NULL,
  threshold INTEGER NOT NULL,
  task_type VARCHAR(50),
  message TEXT NOT NULL,
  triggered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id),
  resolution_note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_dlq_alerts_triggered_at ON dlq_alerts(triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_alerts_severity ON dlq_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_dlq_alerts_type ON dlq_alerts(alert_type, triggered_at DESC);

-- 更新触发器
CREATE OR REPLACE FUNCTION update_dlq_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_dlq_updated_at
  BEFORE UPDATE ON dead_letter_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_dlq_updated_at();

CREATE TRIGGER trigger_update_task_config_updated_at
  BEFORE UPDATE ON task_retry_config
  FOR EACH ROW
  EXECUTE FUNCTION update_dlq_updated_at();

-- 注释
COMMENT ON TABLE dead_letter_queue IS 'REQ-00519: 死信队列存储失败的任务';
COMMENT ON TABLE task_execution_history IS 'REQ-00519: 任务执行历史记录';
COMMENT ON TABLE task_retry_config IS 'REQ-00519: 任务重试配置';
COMMENT ON TABLE dlq_alerts IS 'REQ-00519: DLQ 告警日志';

COMMENT ON COLUMN dead_letter_queue.task_id IS '任务唯一 ID';
COMMENT ON COLUMN dead_letter_queue.task_type IS '任务类型';
COMMENT ON COLUMN dead_letter_queue.task_data IS '任务原始数据';
COMMENT ON COLUMN dead_letter_queue.status IS '任务状态：dead_letter, retrying, resolved';
COMMENT ON COLUMN dead_letter_queue.retry_count IS '重试次数';
COMMENT ON COLUMN dead_letter_queue.error_message IS '错误消息';
COMMENT ON COLUMN dead_letter_queue.error_stack IS '错误堆栈';
COMMENT ON COLUMN dead_letter_queue.error_code IS '错误代码';
COMMENT ON COLUMN dead_letter_queue.moved_to_dlq_at IS '移入 DLQ 的时间';
COMMENT ON COLUMN dead_letter_queue.retried_from_dlq_at IS '从 DLQ 重试的时间';
COMMENT ON COLUMN dead_letter_queue.resolved_at IS '解决时间';
COMMENT ON COLUMN dead_letter_queue.resolved_by IS '解决操作的用户';
COMMENT ON COLUMN dead_letter_queue.resolution_note IS '解决说明';

COMMENT ON COLUMN task_retry_config.max_retries IS '最大重试次数';
COMMENT ON COLUMN task_retry_config.base_delay_ms IS '基础延迟（毫秒）';
COMMENT ON COLUMN task_retry_config.max_delay_ms IS '最大延迟（毫秒）';
COMMENT ON COLUMN task_retry_config.backoff_factor IS '退避因子';
COMMENT ON COLUMN task_retry_config.jitter_enabled IS '是否启用抖动';
COMMENT ON COLUMN task_retry_config.jitter_range IS '抖动范围（0-1）';
COMMENT ON COLUMN task_retry_config.alert_threshold IS '告警阈值';