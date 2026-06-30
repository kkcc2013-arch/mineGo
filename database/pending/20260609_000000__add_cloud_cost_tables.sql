-- database/pending/20260609_000000__add_cloud_cost_tables.sql
-- REQ-00040: 云成本监控与预算告警系统
-- 创建预算配置、成本记录、预算告警历史、成本优化建议表

-- 预算配置表
CREATE TABLE IF NOT EXISTS budget_configs (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) DEFAULT 'USD',
  period VARCHAR(20) NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly', 'yearly')),
  scope VARCHAR(20) NOT NULL CHECK (scope IN ('all', 'service', 'namespace')),
  scope_values JSONB DEFAULT '{}', -- { "services": [], "namespaces": [] }
  alert_thresholds JSONB DEFAULT '[0.5, 0.8, 0.9, 1.0]',
  notifications JSONB DEFAULT '[]', -- [{ "type": "email", "recipient": "ops@example.com" }]
  start_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  end_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE budget_configs IS '预算配置表，存储各类预算的金额、周期、告警阈值等';
COMMENT ON COLUMN budget_configs.amount IS '预算金额';
COMMENT ON COLUMN budget_configs.period IS '预算周期：daily/weekly/monthly/yearly';
COMMENT ON COLUMN budget_configs.scope IS '预算范围：all/service/namespace';
COMMENT ON COLUMN budget_configs.scope_values IS '具体的服务或命名空间列表';
COMMENT ON COLUMN budget_configs.alert_thresholds IS '告警阈值列表，如 [0.5, 0.8, 0.9, 1.0]';

-- 成本记录表
CREATE TABLE IF NOT EXISTS cost_records (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,
  service_name VARCHAR(100),
  namespace VARCHAR(100) DEFAULT 'default',
  resource_type VARCHAR(50) DEFAULT 'compute',
  amount DECIMAL(10, 4) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  period_start TIMESTAMP WITH TIME ZONE NOT NULL,
  period_end TIMESTAMP WITH TIME ZONE NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cost_records_provider ON cost_records(provider);
CREATE INDEX IF NOT EXISTS idx_cost_records_service ON cost_records(service_name);
CREATE INDEX IF NOT EXISTS idx_cost_records_namespace ON cost_records(namespace);
CREATE INDEX IF NOT EXISTS idx_cost_records_period ON cost_records(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_cost_records_created ON cost_records(created_at DESC);

COMMENT ON TABLE cost_records IS '成本记录表，存储从云厂商采集的成本数据';
COMMENT ON COLUMN cost_records.provider IS '云提供商：aws/aliyun/gcp/mock';
COMMENT ON COLUMN cost_records.service_name IS '服务名称，如 user-service、gateway 等';
COMMENT ON COLUMN cost_records.resource_type IS '资源类型：compute/storage/network/database';
COMMENT ON COLUMN cost_records.amount IS '成本金额';

-- 预算告警历史表
CREATE TABLE IF NOT EXISTS budget_alerts (
  id SERIAL PRIMARY KEY,
  budget_name VARCHAR(100) NOT NULL,
  budget_id INTEGER REFERENCES budget_configs(id) ON DELETE SET NULL,
  threshold DECIMAL(3, 2) NOT NULL,
  percentage DECIMAL(5, 2) NOT NULL,
  spent_amount DECIMAL(10, 2) NOT NULL,
  budget_amount DECIMAL(10, 2) NOT NULL,
  alert_level VARCHAR(20) NOT NULL CHECK (alert_level IN ('info', 'warning', 'high', 'critical')),
  message TEXT,
  notified_channels JSONB DEFAULT '[]',
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  acknowledged_by VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_budget_alerts_budget ON budget_alerts(budget_name);
CREATE INDEX IF NOT EXISTS idx_budget_alerts_level ON budget_alerts(alert_level);
CREATE INDEX IF NOT EXISTS idx_budget_alerts_created ON budget_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_alerts_unacknowledged ON budget_alerts(acknowledged) WHERE acknowledged = FALSE;

COMMENT ON TABLE budget_alerts IS '预算告警历史表，记录所有预算告警事件';
COMMENT ON COLUMN budget_alerts.threshold IS '触发的阈值，如 0.8 表示 80%';
COMMENT ON COLUMN budget_alerts.alert_level IS '告警级别：info/warning/high/critical';

-- 成本优化建议表
CREATE TABLE IF NOT EXISTS cost_optimization_suggestions (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  service_name VARCHAR(100),
  namespace VARCHAR(100) DEFAULT 'default',
  resource_type VARCHAR(50),
  current_value DECIMAL(10, 2),
  recommended_value DECIMAL(10, 2),
  current_utilization DECIMAL(5, 4),
  potential_saving DECIMAL(10, 2) DEFAULT 0,
  priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  recommendation TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed', 'expired')),
  applied_at TIMESTAMP WITH TIME ZONE,
  applied_by VARCHAR(100),
  dismissed_at TIMESTAMP WITH TIME ZONE,
  dismissed_by VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_optimization_type ON cost_optimization_suggestions(type);
CREATE INDEX IF NOT EXISTS idx_optimization_service ON cost_optimization_suggestions(service_name);
CREATE INDEX IF NOT EXISTS idx_optimization_status ON cost_optimization_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_optimization_priority ON cost_optimization_suggestions(priority);
CREATE INDEX IF NOT EXISTS idx_optimization_created ON cost_optimization_suggestions(created_at DESC);

COMMENT ON TABLE cost_optimization_suggestions IS '成本优化建议表，存储系统生成的优化建议';
COMMENT ON COLUMN cost_optimization_suggestions.type IS '优化类型：underutilized/reserved_instance/cpu_optimization/memory_optimization';
COMMENT ON COLUMN cost_optimization_suggestions.potential_saving IS '潜在节省金额（美元/月）';
COMMENT ON COLUMN cost_optimization_suggestions.status IS '状态：pending/applied/dismissed/expired';

-- 成本趋势分析表
CREATE TABLE IF NOT EXISTS cost_trends (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  total_cost DECIMAL(10, 4) NOT NULL,
  by_provider JSONB DEFAULT '{}',
  by_service JSONB DEFAULT '{}',
  cpu_cost DECIMAL(10, 4) DEFAULT 0,
  memory_cost DECIMAL(10, 4) DEFAULT 0,
  storage_cost DECIMAL(10, 4) DEFAULT 0,
  network_cost DECIMAL(10, 4) DEFAULT 0,
  predicted_cost DECIMAL(10, 4),
  anomaly_detected BOOLEAN DEFAULT FALSE,
  anomaly_score DECIMAL(5, 2),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cost_trends_date ON cost_trends(date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_trends_anomaly ON cost_trends(anomaly_detected) WHERE anomaly_detected = TRUE;

COMMENT ON TABLE cost_trends IS '成本趋势分析表，按日存储聚合成本数据';
COMMENT ON COLUMN cost_trends.by_provider IS '按提供商的成本分布';
COMMENT ON COLUMN cost_trends.by_service IS '按服务的成本分布';
COMMENT ON COLUMN cost_trends.anomaly_score IS '异常分数（z-score）';

-- 插入默认预算配置
INSERT INTO budget_configs (name, amount, period, scope, scope_values, notifications, start_date)
VALUES 
  ('monthly-total', 1000.00, 'monthly', 'all', 
   '{}',
   '[{"type": "log", "recipient": "ops"}]',
   CURRENT_TIMESTAMP),
  ('gateway-budget', 200.00, 'monthly', 'service',
   '{"services": ["gateway"]}',
   '[{"type": "log", "recipient": "gateway-team"}]',
   CURRENT_TIMESTAMP),
  ('user-service-budget', 150.00, 'monthly', 'service',
   '{"services": ["user-service"]}',
   '[{"type": "log", "recipient": "user-team"}]',
   CURRENT_TIMESTAMP),
  ('location-service-budget', 180.00, 'monthly', 'service',
   '{"services": ["location-service"]}',
   '[{"type": "log", "recipient": "location-team"}]',
   CURRENT_TIMESTAMP),
  ('pokemon-service-budget', 120.00, 'monthly', 'service',
   '{"services": ["pokemon-service"]}',
   '[{"type": "log", "recipient": "pokemon-team"}]',
   CURRENT_TIMESTAMP)
ON CONFLICT (name) DO UPDATE SET
  amount = EXCLUDED.amount,
  period = EXCLUDED.period,
  scope = EXCLUDED.scope,
  scope_values = EXCLUDED.scope_values,
  notifications = EXCLUDED.notifications,
  updated_at = CURRENT_TIMESTAMP;

-- 创建视图：预算状态概览
CREATE OR REPLACE VIEW budget_status_view AS
SELECT 
  bc.name,
  bc.amount as budget_limit,
  bc.period,
  bc.scope,
  COALESCE(SUM(cr.amount), 0) as spent,
  bc.amount - COALESCE(SUM(cr.amount), 0) as remaining,
  CASE 
    WHEN bc.amount > 0 THEN ROUND((COALESCE(SUM(cr.amount), 0) / bc.amount) * 100, 2)
    ELSE 0 
  END as usage_percentage,
  CASE
    WHEN bc.amount > 0 AND COALESCE(SUM(cr.amount), 0) >= bc.amount THEN 'exceeded'
    WHEN bc.amount > 0 AND COALESCE(SUM(cr.amount), 0) >= bc.amount * 0.9 THEN 'warning'
    ELSE 'ok'
  END as status,
  bc.alert_thresholds
FROM budget_configs bc
LEFT JOIN cost_records cr ON 
  (bc.scope = 'all' 
   OR (bc.scope = 'service' AND bc.scope_values->'services' @> jsonb_build_array(cr.service_name))
   OR (bc.scope = 'namespace' AND bc.scope_values->'namespaces' @> jsonb_build_array(cr.namespace))
  )
  AND cr.period_start >= bc.start_date
  AND (bc.end_date IS NULL OR cr.period_end <= bc.end_date)
WHERE bc.end_date IS NULL OR bc.end_date > CURRENT_TIMESTAMP
GROUP BY bc.id, bc.name, bc.amount, bc.period, bc.scope, bc.alert_thresholds;

COMMENT ON VIEW budget_status_view IS '预算状态概览视图，显示每个预算的使用情况';

-- 创建视图：服务成本排行
CREATE OR REPLACE VIEW service_cost_ranking_view AS
SELECT 
  service_name,
  SUM(amount) as total_cost,
  AVG(amount) as avg_daily_cost,
  SUM(amount) * 30 as monthly_projection,
  COUNT(*) as record_count
FROM cost_records
WHERE period_start >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY service_name
ORDER BY total_cost DESC;

COMMENT ON VIEW service_cost_ranking_view IS '服务成本排行视图，按成本从高到低排序';

-- 创建函数：检查预算告警
CREATE OR REPLACE FUNCTION check_budget_alerts()
RETURNS TABLE (
  budget_name VARCHAR(100),
  threshold NUMERIC,
  percentage NUMERIC,
  spent_amount NUMERIC,
  budget_amount NUMERIC,
  alert_level VARCHAR(20)
)
LANGUAGE plpgsql
AS $$
DECLARE
  budget_rec RECORD;
  threshold_val NUMERIC;
BEGIN
  FOR budget_rec IN 
    SELECT * FROM budget_configs 
    WHERE end_date IS NULL OR end_date > CURRENT_TIMESTAMP
  LOOP
    FOR threshold_val IN SELECT jsonb_array_elements_text(alert_thresholds)::numeric FROM budget_configs WHERE id = budget_rec.id
    LOOP
      -- 这里简化处理，实际应从 cost_records 计算花费
      -- 返回可能的告警
      RETURN NEXT;
    END LOOP;
  END LOOP;
  RETURN;
END;
$$;

-- 授权（如果需要）
-- GRANT SELECT, INSERT, UPDATE ON budget_configs, cost_records, budget_alerts, cost_optimization_suggestions, cost_trends TO minego_app;
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO minego_app;
