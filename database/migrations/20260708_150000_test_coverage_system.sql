-- Test Coverage System Migration
-- Created: 2026-07-08
-- REQ-00507: 测试覆盖率自动化度量与 CI 集成系统

-- 测试覆盖率记录表（按服务）
CREATE TABLE IF NOT EXISTS test_coverage_records (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  build_id VARCHAR(100) NOT NULL,
  branch VARCHAR(100) NOT NULL,
  commit_sha VARCHAR(40) NOT NULL,
  lines_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  statements_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  functions_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  branches_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  files_covered INTEGER NOT NULL DEFAULT 0,
  total_lines INTEGER NOT NULL DEFAULT 0,
  covered_lines INTEGER NOT NULL DEFAULT 0,
  total_functions INTEGER NOT NULL DEFAULT 0,
  covered_functions INTEGER NOT NULL DEFAULT 0,
  total_branches INTEGER NOT NULL DEFAULT 0,
  covered_branches INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_coverage_service ON test_coverage_records(service_name);
CREATE INDEX IF NOT EXISTS idx_coverage_build ON test_coverage_records(build_id);
CREATE INDEX IF NOT EXISTS idx_coverage_branch ON test_coverage_records(branch);
CREATE INDEX IF NOT EXISTS idx_coverage_created ON test_coverage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_coverage_commit ON test_coverage_records(commit_sha);

-- 测试覆盖率汇总表（全项目）
CREATE TABLE IF NOT EXISTS test_coverage_summary (
  id SERIAL PRIMARY KEY,
  build_id VARCHAR(100) NOT NULL UNIQUE,
  branch VARCHAR(100) NOT NULL,
  commit_sha VARCHAR(40) NOT NULL,
  avg_lines_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  avg_statements_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  avg_functions_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  avg_branches_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  services_covered INTEGER NOT NULL DEFAULT 0,
  total_services INTEGER NOT NULL DEFAULT 9,
  total_lines INTEGER NOT NULL DEFAULT 0,
  covered_lines INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_coverage_summary_build ON test_coverage_summary(build_id);
CREATE INDEX IF NOT EXISTS idx_coverage_summary_branch ON test_coverage_summary(branch);
CREATE INDEX IF NOT EXISTS idx_coverage_summary_created ON test_coverage_summary(created_at);

-- 覆盖率阈值配置表
CREATE TABLE IF NOT EXISTS coverage_threshold_config (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL UNIQUE,
  min_lines_pct DECIMAL(5,2) NOT NULL DEFAULT 50,
  min_statements_pct DECIMAL(5,2) NOT NULL DEFAULT 50,
  min_functions_pct DECIMAL(5,2) NOT NULL DEFAULT 50,
  min_branches_pct DECIMAL(5,2) NOT NULL DEFAULT 40,
  incremental_min_lines_pct DECIMAL(5,2) NOT NULL DEFAULT 80,
  incremental_min_functions_pct DECIMAL(5,2) NOT NULL DEFAULT 80,
  is_active BOOLEAN DEFAULT true,
  updated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 初始阈值配置
INSERT INTO coverage_threshold_config (service_name, min_lines_pct, min_statements_pct, min_functions_pct, min_branches_pct, incremental_min_lines_pct, incremental_min_functions_pct)
VALUES
  ('gateway', 50, 50, 50, 40, 80, 80),
  ('user-service', 60, 60, 60, 50, 80, 80),
  ('pokemon-service', 60, 60, 60, 50, 80, 80),
  ('catch-service', 70, 70, 70, 60, 85, 85),
  ('gym-service', 50, 50, 50, 40, 80, 80),
  ('social-service', 50, 50, 50, 40, 80, 80),
  ('reward-service', 60, 60, 60, 50, 80, 80),
  ('payment-service', 80, 80, 80, 70, 90, 90),
  ('location-service', 50, 50, 50, 40, 80, 80),
  ('backend/shared', 60, 60, 60, 50, 80, 80)
ON CONFLICT (service_name) DO NOTHING;

-- 覆盖率缺口分析结果表
CREATE TABLE IF NOT EXISTS coverage_gap_analysis (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  build_id VARCHAR(100) NOT NULL,
  file_path TEXT NOT NULL,
  uncovered_functions JSONB,
  uncovered_branches JSONB,
  severity_score DECIMAL(5,2) NOT NULL DEFAULT 0,
  total_lines INTEGER NOT NULL DEFAULT 0,
  covered_lines INTEGER NOT NULL DEFAULT 0,
  suggested_tests TEXT[],
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_gap_service ON coverage_gap_analysis(service_name);
CREATE INDEX IF NOT EXISTS idx_gap_build ON coverage_gap_analysis(build_id);
CREATE INDEX IF NOT EXISTS idx_gap_severity ON coverage_gap_analysis(severity_score DESC);
CREATE INDEX IF NOT EXISTS idx_gap_file ON coverage_gap_analysis(file_path);

-- 覆盖率历史趋势视图
CREATE OR REPLACE VIEW coverage_trend_view AS
SELECT 
  build_id,
  branch,
  avg_lines_pct,
  avg_functions_pct,
  avg_branches_pct,
  services_covered,
  created_at,
  LAG(avg_lines_pct) OVER (ORDER BY created_at) as prev_lines_pct,
  LAG(avg_functions_pct) OVER (ORDER BY created_at) as prev_functions_pct
FROM test_coverage_summary
ORDER BY created_at DESC
LIMIT 30;

-- 评论
COMMENT ON TABLE test_coverage_records IS '服务测试覆盖率记录';
COMMENT ON TABLE test_coverage_summary IS '全项目覆盖率汇总';
COMMENT ON TABLE coverage_threshold_config IS '覆盖率阈值配置';
COMMENT ON TABLE coverage_gap_analysis IS '覆盖率缺口分析结果';
COMMENT ON VIEW coverage_trend_view IS '覆盖率历史趋势视图';