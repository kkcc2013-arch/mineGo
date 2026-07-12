-- REQ-00518: 监控数据智能摘要与自动化报告系统
-- 数据库迁移

-- 监控报告表
CREATE TABLE IF NOT EXISTS monitor_reports (
  id SERIAL PRIMARY KEY,
  report_type VARCHAR(20) NOT NULL,  -- 'daily' | 'weekly' | 'incident'
  health_score INTEGER NOT NULL,     -- 0-100
  overall_status VARCHAR(20) NOT NULL, -- 'healthy' | 'warning' | 'critical'
  summary JSONB,                     -- 摘要数据
  data JSONB,                        -- 原始数据
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_monitor_reports_type ON monitor_reports(report_type);
CREATE INDEX idx_monitor_reports_created ON monitor_reports(created_at DESC);
CREATE INDEX idx_monitor_reports_health ON monitor_reports(health_score);

-- 报告历史视图
CREATE OR REPLACE VIEW monitor_report_history AS
SELECT 
  id,
  report_type,
  health_score,
  overall_status,
  created_at,
  (summary->>'keyFindings')::jsonb AS key_findings,
  (summary->>'criticalIssues')::jsonb AS critical_issues
FROM monitor_reports
ORDER BY created_at DESC;

-- 评论
COMMENT ON TABLE monitor_reports IS '监控报告存储表';
COMMENT ON COLUMN monitor_reports.report_type IS '报告类型：daily/weekly/incident';
COMMENT ON COLUMN monitor_reports.health_score IS '系统健康评分 (0-100)';
COMMENT ON COLUMN monitor_reports.summary IS '报告摘要（JSON格式）';
COMMENT ON COLUMN monitor_reports.data IS '原始监控数据（JSON格式）';