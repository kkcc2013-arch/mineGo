-- REQ-00043: 延迟任务队列与可靠重试机制
-- Migration: 2026-06-09 02:00:00

-- Delay queue task tracking table
CREATE TABLE IF NOT EXISTS delay_queue_tasks (
  id VARCHAR(100) PRIMARY KEY,
  type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 2,
  status VARCHAR(20) DEFAULT 'pending', -- pending, processing, completed, failed, dead_letter
  execute_at TIMESTAMP NOT NULL,
  retries INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 5,
  error_message TEXT,
  error_stack TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  metadata JSONB,
  CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter'))
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_delay_queue_tasks_status ON delay_queue_tasks(status);
CREATE INDEX IF NOT EXISTS idx_delay_queue_tasks_type ON delay_queue_tasks(type);
CREATE INDEX IF NOT EXISTS idx_delay_queue_tasks_execute_at ON delay_queue_tasks(execute_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_delay_queue_tasks_priority ON delay_queue_tasks(priority, execute_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_delay_queue_tasks_created_at ON delay_queue_tasks(created_at DESC);

-- Delay queue statistics table (for historical tracking)
CREATE TABLE IF NOT EXISTS delay_queue_stats (
  id SERIAL PRIMARY KEY,
  recorded_at TIMESTAMP DEFAULT NOW(),
  bucket VARCHAR(20) NOT NULL,
  task_count INTEGER NOT NULL,
  avg_delay_seconds NUMERIC,
  max_delay_seconds INTEGER,
  completed_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_delay_queue_stats_bucket ON delay_queue_stats(bucket, recorded_at DESC);

-- DLQ audit log (for manual intervention tracking)
CREATE TABLE IF NOT EXISTS delay_queue_dlq_audit (
  id SERIAL PRIMARY KEY,
  task_id VARCHAR(100) NOT NULL,
  task_type VARCHAR(100) NOT NULL,
  original_payload JSONB,
  error_message TEXT,
  error_stack TEXT,
  failed_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  resolved_by VARCHAR(100),
  resolution_notes TEXT,
  resolution_action VARCHAR(50) -- 'retried', 'ignored', 'fixed'
);

CREATE INDEX IF NOT EXISTS idx_dlq_audit_task_type ON delay_queue_dlq_audit(task_type);
CREATE INDEX IF NOT EXISTS idx_dlq_audit_failed_at ON delay_queue_dlq_audit(failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_audit_resolved ON delay_queue_dlq_audit(resolved_at) WHERE resolved_at IS NULL;

-- Recurring tasks table
CREATE TABLE IF NOT EXISTS delay_queue_recurring (
  id VARCHAR(100) PRIMARY KEY,
  task_type VARCHAR(100) NOT NULL,
  payload JSONB,
  cron_expression VARCHAR(100) NOT NULL,
  priority VARCHAR(20) DEFAULT 'normal',
  max_retries INTEGER DEFAULT 5,
  active BOOLEAN DEFAULT TRUE,
  last_run TIMESTAMP,
  next_run TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurring_active ON delay_queue_recurring(active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_recurring_next_run ON delay_queue_recurring(next_run) WHERE active = TRUE;

-- Task execution history (for debugging and analysis)
CREATE TABLE IF NOT EXISTS delay_queue_history (
  id SERIAL PRIMARY KEY,
  task_id VARCHAR(100) NOT NULL,
  task_type VARCHAR(100) NOT NULL,
  action VARCHAR(50) NOT NULL, -- 'scheduled', 'started', 'completed', 'failed', 'retried', 'dead_letter'
  timestamp TIMESTAMP DEFAULT NOW(),
  duration_ms INTEGER,
  error_message TEXT,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_history_task_id ON delay_queue_history(task_id);
CREATE INDEX IF NOT EXISTS idx_history_task_type ON delay_queue_history(task_type);
CREATE INDEX IF NOT EXISTS idx_history_timestamp ON delay_queue_history(timestamp DESC);

-- Function to automatically update updated_at
CREATE OR REPLACE FUNCTION update_delay_queue_recurring_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_recurring_updated_at ON delay_queue_recurring;
CREATE TRIGGER trigger_update_recurring_updated_at
  BEFORE UPDATE ON delay_queue_recurring
  FOR EACH ROW
  EXECUTE FUNCTION update_delay_queue_recurring_updated_at();

-- Function to record task history
CREATE OR REPLACE FUNCTION record_delay_queue_history(
  p_task_id VARCHAR(100),
  p_task_type VARCHAR(100),
  p_action VARCHAR(50),
  p_duration_ms INTEGER DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO delay_queue_history (
    task_id, task_type, action, duration_ms, error_message, metadata
  ) VALUES (
    p_task_id, p_task_type, p_action, p_duration_ms, p_error_message, p_metadata
  );
END;
$$ LANGUAGE plpgsql;

-- View for pending tasks summary
CREATE OR REPLACE VIEW delay_queue_pending_summary AS
SELECT 
  type,
  priority,
  COUNT(*) as pending_count,
  MIN(execute_at) as earliest_execution,
  MAX(execute_at) as latest_execution,
  AVG(EXTRACT(EPOCH FROM (execute_at - NOW()))) as avg_delay_seconds
FROM delay_queue_tasks
WHERE status = 'pending'
GROUP BY type, priority
ORDER BY priority, pending_count DESC;

-- View for DLQ summary
CREATE OR REPLACE VIEW delay_queue_dlq_summary AS
SELECT 
  task_type,
  COUNT(*) as dlq_count,
  MIN(failed_at) as earliest_failure,
  MAX(failed_at) as latest_failure,
  COUNT(*) FILTER (WHERE resolved_at IS NULL) as unresolved_count
FROM delay_queue_dlq_audit
GROUP BY task_type
ORDER BY dlq_count DESC;

-- Comments for documentation
COMMENT ON TABLE delay_queue_tasks IS 'Tracks all delayed tasks and their execution status';
COMMENT ON TABLE delay_queue_stats IS 'Historical statistics for delay queue buckets';
COMMENT ON TABLE delay_queue_dlq_audit IS 'Audit log for dead letter queue tasks requiring manual intervention';
COMMENT ON TABLE delay_queue_recurring IS 'Configuration for recurring scheduled tasks';
COMMENT ON TABLE delay_queue_history IS 'Complete execution history for all tasks';

COMMENT ON COLUMN delay_queue_tasks.priority IS 'Task priority: 0=critical, 1=high, 2=normal, 3=low';
COMMENT ON COLUMN delay_queue_tasks.status IS 'Task status: pending, processing, completed, failed, dead_letter';
COMMENT ON COLUMN delay_queue_tasks.execute_at IS 'Scheduled execution timestamp';
