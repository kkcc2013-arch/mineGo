-- REQ-00506: 容器资源智能利用率分析系统
-- 数据库迁移脚本

-- ============================================================
-- 1. 资源采样表
-- ============================================================

CREATE TABLE IF NOT EXISTS resource_samples (
  id SERIAL PRIMARY KEY,
  pod_name VARCHAR(255) NOT NULL,
  container_name VARCHAR(255) NOT NULL,
  namespace VARCHAR(100) DEFAULT 'pmg',
  
  -- CPU 数据（核心数）
  cpu_usage DECIMAL(10, 4),
  cpu_request DECIMAL(10, 4),
  cpu_limit DECIMAL(10, 4),
  
  -- Memory 数据（字节）
  memory_usage BIGINT,
  memory_request BIGINT,
  memory_limit BIGINT,
  
  sampled_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- 索引约束
  UNIQUE(pod_name, container_name, sampled_at)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_resource_samples_pod ON resource_samples(pod_name);
CREATE INDEX IF NOT EXISTS idx_resource_samples_container ON resource_samples(container_name);
CREATE INDEX IF NOT EXISTS idx_resource_samples_namespace ON resource_samples(namespace);
CREATE INDEX IF NOT EXISTS idx_resource_samples_time ON resource_samples(sampled_at DESC);

-- ============================================================
-- 2. 资源分析报告表
-- ============================================================

CREATE TABLE IF NOT EXISTS resource_analysis_reports (
  id SERIAL PRIMARY KEY,
  report_data JSONB NOT NULL,
  
  -- 快速查询字段
  total_containers INT,
  under_utilized_count INT,
  optimal_count INT,
  over_utilized_count INT,
  risky_count INT,
  
  -- 潜在节省（快速查询）
  potential_cpu_savings DECIMAL(10, 4),
  potential_memory_savings BIGINT,
  
  generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resource_reports_time ON resource_analysis_reports(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_resource_reports_under_utilized ON resource_analysis_reports(under_utilized_count);
CREATE INDEX IF NOT EXISTS idx_resource_reports_risky ON resource_analysis_reports(risky_count);

-- ============================================================
-- 3. 资源调整历史表
-- ============================================================

CREATE TABLE IF NOT EXISTS resource_adjustment_history (
  id SERIAL PRIMARY KEY,
  pod_name VARCHAR(255) NOT NULL,
  container_name VARCHAR(255) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,  -- cpu/memory
  adjustment_type VARCHAR(50) NOT NULL, -- reduce_request/increase_limit
  
  current_value DECIMAL(10, 4),         -- 当前值
  suggested_value DECIMAL(10, 4),       -- 建议值
  executed_value DECIMAL(10, 4),        -- 实际执行值
  
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending/approved/rejected/completed/failed
  priority VARCHAR(50),                 -- high/medium/low
  
  reason TEXT,
  impact TEXT,
  note TEXT,
  
  -- 时间戳
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMP,
  rejected_at TIMESTAMP,
  rejection_reason TEXT,
  executed_at TIMESTAMP,
  failed_at TIMESTAMP,
  
  result JSONB,                         -- 执行结果详情
  created_by VARCHAR(100),              -- 创建者（自动/手动）
  approved_by VARCHAR(100),             -- 批准者
  
  -- 索引约束
  UNIQUE(pod_name, container_name, resource_type, adjustment_type, created_at)
);

CREATE INDEX IF NOT EXISTS idx_adjustment_pod ON resource_adjustment_history(pod_name);
CREATE INDEX IF NOT EXISTS idx_adjustment_container ON resource_adjustment_history(container_name);
CREATE INDEX IF NOT EXISTS idx_adjustment_status ON resource_adjustment_history(status);
CREATE INDEX IF NOT EXISTS idx_adjustment_time ON resource_adjustment_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adjustment_resource ON resource_adjustment_history(resource_type);

-- ============================================================
-- 4. 调整策略配置表
-- ============================================================

CREATE TABLE IF NOT EXISTS adjustment_strategies (
  id SERIAL PRIMARY KEY,
  strategy_name VARCHAR(100) UNIQUE NOT NULL, -- conservative/balanced/aggressive
  
  cpu_buffer DECIMAL(5, 2) DEFAULT 1.5,
  memory_buffer DECIMAL(5, 2) DEFAULT 1.3,
  auto_execute BOOLEAN DEFAULT FALSE,
  max_reduction DECIMAL(5, 2) DEFAULT 0.3,
  
  is_active BOOLEAN DEFAULT TRUE,
  description TEXT,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 插入默认策略
INSERT INTO adjustment_strategies (strategy_name, cpu_buffer, memory_buffer, auto_execute, max_reduction, description)
VALUES 
  ('conservative', 1.5, 1.3, FALSE, 0.3, '保守策略：需要手动审核，最大降幅 30%'),
  ('balanced', 1.3, 1.2, FALSE, 0.4, '平衡策略：需要手动审核，最大降幅 40%'),
  ('aggressive', 1.2, 1.15, TRUE, 0.5, '激进策略：自动执行，最大降幅 50%')
ON CONFLICT (strategy_name) DO NOTHING;

-- ============================================================
-- 5. 服务资源配置表（配置参考）
-- ============================================================

CREATE TABLE IF NOT EXISTS service_resource_configs (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) UNIQUE NOT NULL,
  
  -- 当前配置
  cpu_request DECIMAL(10, 4),
  cpu_limit DECIMAL(10, 4),
  memory_request BIGINT,
  memory_limit BIGINT,
  
  -- 推荐配置
  recommended_cpu_request DECIMAL(10, 4),
  recommended_cpu_limit DECIMAL(10, 4),
  recommended_memory_request BIGINT,
  recommended_memory_limit BIGINT,
  
  -- 配置来源
  config_source VARCHAR(50),            -- manual/auto/historical
  
  -- 时间戳
  last_updated TIMESTAMP DEFAULT NOW(),
  last_sampled TIMESTAMP,
  
  notes TEXT,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_config_name ON service_resource_configs(service_name);

-- ============================================================
-- 6. 视图：最新资源利用率摘要
-- ============================================================

CREATE OR REPLACE VIEW v_resource_utilization_latest AS
SELECT 
  pod_name,
  container_name,
  namespace,
  cpu_usage,
  cpu_request,
  cpu_limit,
  CASE 
    WHEN cpu_request > 0 THEN cpu_usage / cpu_request
    ELSE NULL
  END AS cpu_utilization,
  memory_usage,
  memory_request,
  memory_limit,
  CASE 
    WHEN memory_request > 0 THEN memory_usage / memory_request
    ELSE NULL
  END AS memory_utilization,
  sampled_at
FROM resource_samples
WHERE sampled_at >= NOW() - INTERVAL '24 hours'
ORDER BY sampled_at DESC;

-- ============================================================
-- 7. 视图：调整历史摘要
-- ============================================================

CREATE OR REPLACE VIEW v_adjustment_summary AS
SELECT 
  pod_name,
  container_name,
  resource_type,
  adjustment_type,
  current_value,
  suggested_value,
  status,
  priority,
  created_at,
  CASE 
    WHEN executed_at IS NOT NULL THEN executed_at - created_at
    ELSE NULL
  END AS execution_duration
FROM resource_adjustment_history
ORDER BY created_at DESC;

-- ============================================================
-- 8. 函数：计算服务利用率统计
-- ============================================================

CREATE OR REPLACE FUNCTION calculate_service_utilization(
  p_service_name VARCHAR,
  p_hours INT DEFAULT 24
)
RETURNS TABLE (
  container_name VARCHAR,
  avg_cpu_usage DECIMAL,
  avg_memory_usage BIGINT,
  avg_cpu_utilization DECIMAL,
  avg_memory_utilization DECIMAL,
  cpu_request DECIMAL,
  memory_request BIGINT,
  status VARCHAR
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    rs.container_name,
    AVG(rs.cpu_usage) AS avg_cpu_usage,
    AVG(rs.memory_usage) AS avg_memory_usage,
    CASE 
      WHEN AVG(rs.cpu_request) > 0 THEN AVG(rs.cpu_usage) / AVG(rs.cpu_request)
      ELSE NULL
    END AS avg_cpu_utilization,
    CASE 
      WHEN AVG(rs.memory_request) > 0 THEN AVG(rs.memory_usage) / AVG(rs.memory_request)
      ELSE NULL
    END AS avg_memory_utilization,
    AVG(rs.cpu_request) AS cpu_request,
    AVG(rs.memory_request) AS memory_request,
    CASE 
      WHEN AVG(rs.cpu_usage) / AVG(rs.cpu_request) < 0.3 THEN 'under-utilized'
      WHEN AVG(rs.cpu_usage) / AVG(rs.cpu_request) > 0.9 THEN 'risky'
      WHEN AVG(rs.cpu_usage) / AVG(rs.cpu_request) > 0.8 THEN 'over-utilized'
      ELSE 'optimal'
    END AS status
  FROM resource_samples rs
  WHERE rs.pod_name LIKE p_service_name || '%'
    AND rs.sampled_at >= NOW() - (p_hours || ' hours')::INTERVAL
  GROUP BY rs.container_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 9. 触发器：自动更新 updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_resource_samples_updated_at
  BEFORE UPDATE ON resource_samples
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_service_resource_configs_updated_at
  BEFORE UPDATE ON service_resource_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 10. 数据清理：保留最近 90 天的采样数据
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_old_resource_samples()
RETURNS INT AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM resource_samples
  WHERE sampled_at < NOW() - INTERVAL '90 days';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 完成
-- ============================================================

COMMENT ON TABLE resource_samples IS 'REQ-00506: Kubernetes Pod 资源采样数据';
COMMENT ON TABLE resource_analysis_reports IS 'REQ-00506: 资源利用率分析报告';
COMMENT ON TABLE resource_adjustment_history IS 'REQ-00506: 资源配额调整历史记录';
COMMENT ON TABLE adjustment_strategies IS 'REQ-00506: 自动调整策略配置';
COMMENT ON TABLE service_resource_configs IS 'REQ-00506: 服务资源配置参考';