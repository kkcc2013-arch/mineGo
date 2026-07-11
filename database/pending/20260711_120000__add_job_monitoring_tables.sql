-- REQ-00538: 任务执行状态实时监控与智能告警系统
-- 数据库迁移：创建任务执行日志表

-- 创建执行日志表
CREATE TABLE IF NOT EXISTS job_execution_logs (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(100) NOT NULL,
  job_name VARCHAR(200),
  category VARCHAR(50),
  status VARCHAR(20) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  duration_ms INTEGER,
  error_message TEXT,
  error_stack TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_execution_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_status ON job_execution_logs(status);
CREATE INDEX IF NOT EXISTS idx_job_logs_start_time ON job_execution_logs(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_job_logs_category ON job_execution_logs(category);
CREATE INDEX IF NOT EXISTS idx_job_logs_created_at ON job_execution_logs(created_time DESC);

-- 创建告警历史表
CREATE TABLE IF NOT EXISTS job_alert_history (
  id SERIAL PRIMARY KEY,
  alert_id VARCHAR(100) UNIQUE NOT NULL,
  job_id VARCHAR(100) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  channels JSONB,
  metadata JSONB,
  sent_at TIMESTAMP NOT NULL,
  acknowledged_at TIMESTAMP,
  acknowledged_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_history_job_id ON job_alert_history(job_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_severity ON job_alert_history(severity);
CREATE INDEX IF NOT EXISTS idx_alert_history_sent_at ON job_alert_history(sent_at DESC);

-- 创建任务健康快照表（用于趋势分析）
CREATE TABLE IF NOT EXISTS job_health_snapshots (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(100) NOT NULL,
  health_score INTEGER NOT NULL,
  grade CHAR(1) NOT NULL,
  success_rate NUMERIC(5, 2),
  avg_duration_ms INTEGER,
  run_count INTEGER,
  failure_count INTEGER,
  factors JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_snapshots_job_id ON job_health_snapshots(job_id);
CREATE INDEX IF NOT EXISTS idx_health_snapshots_created_at ON job_health_snapshots(created_at DESC);

-- 创建统计视图（每日聚合）
CREATE OR REPLACE VIEW job_daily_statistics AS
SELECT
  job_id,
  job_name,
  category,
  DATE(start_time) as stat_date,
  COUNT(*) as total_runs,
  COUNT(*) FILTER (WHERE status = 'success') as success_count,
  COUNT(*) FILTER (WHERE status = 'failed') as failure_count,
  COUNT(*) FILTER (WHERE status = 'timeout') as timeout_count,
  AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as avg_duration_ms,
  MIN(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as min_duration_ms,
  MAX(duration_ms) FILTER (WHERE duration_ms IS NOT NULL) as max_duration_ms,
  ROUND(
    COUNT(*) FILTER (WHERE status = 'success')::numeric / NULLIF(COUNT(*), 0) * 100,
    2
  ) as success_rate
FROM job_execution_logs
GROUP BY job_id, job_name, category, DATE(start_time);

-- 创建告警噪音抑制日志表
CREATE TABLE IF NOT EXISTS alert_suppression_log (
  id SERIAL PRIMARY KEY,
  alert_key VARCHAR(200) NOT NULL,
  original_alert_id VARCHAR(100),
  suppressed_at TIMESTAMP NOT NULL,
  suppression_window_ms INTEGER,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppression_alert_key ON alert_suppression_log(alert_key);

-- 添加注释
COMMENT ON TABLE job_execution_logs IS '任务执行日志记录表';
COMMENT ON TABLE job_alert_history IS '告警历史记录表';
COMMENT ON TABLE job_health_snapshots IS '任务健康评分快照表';
COMMENT ON TABLE alert_suppression_log IS '告警噪音抑制日志表';
COMMENT ON VIEW job_daily_statistics IS '任务每日统计视图';
