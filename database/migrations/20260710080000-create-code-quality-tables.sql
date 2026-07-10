-- Code Quality Analysis Tables
-- Migration: 20260710080000-create-code-quality-tables.sql

-- Main quality snapshots table
CREATE TABLE IF NOT EXISTS code_quality_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_date TIMESTAMP NOT NULL,
  commit_hash VARCHAR(40),
  branch VARCHAR(128) DEFAULT 'main',
  total_files INTEGER NOT NULL,
  total_lines INTEGER NOT NULL,
  total_functions INTEGER NOT NULL DEFAULT 0,
  total_classes INTEGER NOT NULL DEFAULT 0,
  avg_cyclomatic_complexity DECIMAL(10, 3) NOT NULL,
  avg_cognitive_complexity DECIMAL(10, 3) NOT NULL DEFAULT 0,
  avg_maintainability_index DECIMAL(10, 3) NOT NULL,
  high_complexity_files_count INTEGER NOT NULL DEFAULT 0,
  technical_debt_score INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_code_quality_snapshots_date ON code_quality_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_code_quality_snapshots_commit ON code_quality_snapshots(commit_hash);
CREATE INDEX IF NOT EXISTS idx_code_quality_snapshots_branch ON code_quality_snapshots(branch);

-- File-level details
CREATE TABLE IF NOT EXISTS code_quality_file_details (
  id SERIAL PRIMARY KEY,
  snapshot_id INTEGER REFERENCES code_quality_snapshots(id) ON DELETE CASCADE,
  file_path VARCHAR(500) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  lines_of_code INTEGER NOT NULL,
  cyclomatic_complexity INTEGER NOT NULL,
  cognitive_complexity INTEGER NOT NULL DEFAULT 0,
  maintainability_index DECIMAL(10, 3) NOT NULL,
  technical_debt_score INTEGER NOT NULL DEFAULT 0,
  function_count INTEGER NOT NULL DEFAULT 0,
  max_nesting_depth INTEGER NOT NULL DEFAULT 0,
  issues JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cq_file_details_snapshot ON code_quality_file_details(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_cq_file_details_path ON code_quality_file_details(file_path);
CREATE INDEX IF NOT EXISTS idx_cq_file_details_complexity ON code_quality_file_details(cyclomatic_complexity);

-- Daily aggregations
CREATE TABLE IF NOT EXISTS code_quality_daily (
  snapshot_date DATE PRIMARY KEY,
  avg_complexity DECIMAL(10, 3) NOT NULL,
  avg_maintainability DECIMAL(10, 3) NOT NULL,
  total_debt INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Weekly aggregations
CREATE TABLE IF NOT EXISTS code_quality_weekly (
  week_start DATE PRIMARY KEY,
  avg_complexity DECIMAL(10, 3) NOT NULL,
  avg_maintainability DECIMAL(10, 3) NOT NULL,
  total_debt INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Monthly aggregations
CREATE TABLE IF NOT EXISTS code_quality_monthly (
  month_start DATE PRIMARY KEY,
  avg_complexity DECIMAL(10, 3) NOT NULL,
  avg_maintainability DECIMAL(10, 3) NOT NULL,
  total_debt INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Refactoring recommendations table
CREATE TABLE IF NOT EXISTS refactoring_recommendations (
  id SERIAL PRIMARY KEY,
  file_path VARCHAR(500) NOT NULL,
  priority DECIMAL(10, 3) NOT NULL,
  priority_level VARCHAR(20) NOT NULL CHECK (priority_level IN ('critical', 'high', 'medium', 'low')),
  reasons JSONB NOT NULL,
  suggested_actions JSONB NOT NULL,
  estimated_effort_hours INTEGER NOT NULL,
  impact_score DECIMAL(10, 3) DEFAULT 0,
  risk_level VARCHAR(20) DEFAULT 'medium',
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'dismissed')),
  assigned_to VARCHAR(64),
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refactoring_priority ON refactoring_recommendations(priority DESC);
CREATE INDEX IF NOT EXISTS idx_refactoring_status ON refactoring_recommendations(status);
CREATE INDEX IF NOT EXISTS idx_refactoring_file ON refactoring_recommendations(file_path);

-- Quality alerts table
CREATE TABLE IF NOT EXISTS code_quality_alerts (
  id SERIAL PRIMARY KEY,
  alert_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  file_path VARCHAR(500),
  message TEXT NOT NULL,
  metric_value DECIMAL(10, 3),
  threshold_value DECIMAL(10, 3),
  snapshot_id INTEGER REFERENCES code_quality_snapshots(id),
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_by VARCHAR(64),
  acknowledged_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cq_alerts_type ON code_quality_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_cq_alerts_severity ON code_quality_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_cq_alerts_created ON code_quality_alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_cq_alerts_file ON code_quality_alerts(file_path);

-- Comments for documentation
COMMENT ON TABLE code_quality_snapshots IS 'Stores periodic snapshots of code quality metrics';
COMMENT ON TABLE code_quality_file_details IS 'Per-file quality metrics for each snapshot';
COMMENT ON TABLE refactoring_recommendations IS 'Prioritized refactoring recommendations';
COMMENT ON TABLE code_quality_alerts IS 'Quality degradation alerts and warnings';
