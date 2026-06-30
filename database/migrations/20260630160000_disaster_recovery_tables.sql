-- REQ-00376: 跨区域灾备自动化切换系统
-- 数据库迁移：区域健康监控、切换历史、配置管理

-- 区域健康记录表
CREATE TABLE IF NOT EXISTS disaster_recovery_region_health (
  id SERIAL PRIMARY KEY,
  region_code VARCHAR(50) NOT NULL,
  health_score DECIMAL(5,2) NOT NULL CHECK (health_score >= 0 AND health_score <= 100),
  status VARCHAR(20) NOT NULL CHECK (status IN ('healthy', 'degraded', 'critical', 'offline')),
  dimensions JSONB NOT NULL DEFAULT '{}',
  recorded_at TIMESTAMP NOT NULL DEFAULT NOW(),
  INDEX idx_dr_region_health_region_time (region_code, recorded_at DESC)
);

COMMENT ON TABLE disaster_recovery_region_health IS '区域健康状态记录';

COMMENT ON COLUMN disaster_recovery_region_health.dimensions IS '{
  "serviceAvailability": "服务可用性 0-1",
  "databaseHealth": "数据库健康度 0-1", 
  "cacheHealth": "缓存健康度 0-1",
  "networkLatency": "网络延迟 ms",
  "errorRate": "错误率 0-1"
}';

-- 切换历史记录表
CREATE TABLE IF NOT EXISTS disaster_recovery_switch_history (
  id SERIAL PRIMARY KEY,
  from_region VARCHAR(50) NOT NULL,
  to_region VARCHAR(50) NOT NULL,
  trigger_reason TEXT NOT NULL,
  switch_type VARCHAR(20) NOT NULL CHECK (switch_type IN ('automatic', 'manual', 'drill', 'rollback')),
  triggered_by VARCHAR(100),  -- 用户名或系统标识
  steps_completed JSONB NOT NULL DEFAULT '[]',
  success BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  rollback_at TIMESTAMP,
  duration_ms INTEGER,
  error_message TEXT,
  INDEX idx_dr_switch_history_time (started_at DESC),
  INDEX idx_dr_switch_history_regions (from_region, to_region)
);

COMMENT ON TABLE disaster_recovery_switch_history IS '灾备切换历史记录';

COMMENT ON COLUMN disaster_recovery_switch_history.steps_completed IS '[
  { "step": "validateDataSync", "success": true, "duration": 1200 },
  { "step": "drainTraffic", "success": true, "duration": 800 }
]';

-- 区域配置表
CREATE TABLE IF NOT EXISTS disaster_recovery_region_config (
  region_code VARCHAR(50) PRIMARY KEY,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  priority INTEGER NOT NULL DEFAULT 0,
  dns_endpoint VARCHAR(200) NOT NULL,
  postgresql_endpoint VARCHAR(200) NOT NULL,
  redis_endpoint VARCHAR(200) NOT NULL,
  kafka_endpoint VARCHAR(200) NOT NULL,
  capacity_weight DECIMAL(3,2) DEFAULT 1.0,
  latencies JSONB DEFAULT '{}', -- 到其他区域的延迟映射
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  INDEX idx_dr_region_config_primary (is_primary) WHERE is_primary = true
);

COMMENT ON TABLE disaster_recovery_region_config IS '区域灾备配置';

-- 插入默认区域配置
INSERT INTO disaster_recovery_region_config (region_code, is_primary, priority, dns_endpoint, postgresql_endpoint, redis_endpoint, kafka_endpoint, capacity_weight)
VALUES 
  ('beijing', true, 1, 'api.minego.game', 'postgres-primary.minego.internal:5432', 'redis-primary.minego.internal:6379', 'kafka-primary.minego.internal:9092', 1.0),
  ('shanghai', false, 2, 'api-sh.minego.game', 'postgres-standby.minego.internal:5432', 'redis-standby.minego.internal:6379', 'kafka-standby.minego.internal:9092', 1.0),
  ('guangzhou', false, 3, 'api-gz.minego.game', 'postgres-backup.minego.internal:5432', 'redis-backup.minego.internal:6379', 'kafka-backup.minego.internal:9092', 0.8)
ON CONFLICT (region_code) DO UPDATE SET updated_at = NOW();

-- 健康检查阈值配置表
CREATE TABLE IF NOT EXISTS disaster_recovery_health_thresholds (
  id SERIAL PRIMARY KEY,
  dimension VARCHAR(50) NOT NULL UNIQUE,
  weight DECIMAL(4,3) NOT NULL CHECK (weight >= 0 AND weight <= 1),
  threshold DECIMAL(10,4) NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE disaster_recovery_health_thresholds IS '健康检查维度阈值配置';

-- 插入默认阈值配置
INSERT INTO disaster_recovery_health_thresholds (dimension, weight, threshold, description)
VALUES
  ('serviceAvailability', 0.30, 0.95, '服务可用性阈值，低于95%认为不健康'),
  ('databaseHealth', 0.25, 0.90, '数据库健康度阈值'),
  ('cacheHealth', 0.15, 0.85, '缓存健康度阈值'),
  ('networkLatency', 0.15, 100.0, '网络延迟阈值（毫秒）'),
  ('errorRate', 0.15, 0.05, '错误率阈值，超过5%认为不健康')
ON CONFLICT (dimension) DO NOTHING;

-- 灾备演练计划表
CREATE TABLE IF NOT EXISTS disaster_recovery_drills (
  id SERIAL PRIMARY KEY,
  drill_id VARCHAR(100) NOT NULL UNIQUE,
  scheduled_at TIMESTAMP NOT NULL,
  drill_type VARCHAR(20) NOT NULL CHECK (drill_type IN ('tabletop', 'simulation', 'full_failover')),
  execute_failover BOOLEAN NOT NULL DEFAULT false,
  target_standby_region VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'failed', 'cancelled')),
  result JSONB,
  created_by VARCHAR(100),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP
);

COMMENT ON TABLE disaster_recovery_drills IS '灾备演练计划';

-- 创建视图：当前各区域健康状态
CREATE OR REPLACE VIEW v_current_region_health AS
SELECT DISTINCT ON (region_code)
  region_code,
  health_score,
  status,
  dimensions,
  recorded_at
FROM disaster_recovery_region_health
ORDER BY region_code, recorded_at DESC;

COMMENT ON VIEW v_current_region_health IS '当前各区域健康状态';

-- 创建视图：最近切换历史
CREATE OR REPLACE VIEW v_recent_switch_history AS
SELECT 
  id,
  from_region,
  to_region,
  switch_type,
  success,
  started_at,
  completed_at,
  duration_ms,
  EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 as actual_duration_ms
FROM disaster_recovery_switch_history
WHERE started_at > NOW() - INTERVAL '30 days'
ORDER BY started_at DESC;

COMMENT ON VIEW v_recent_switch_history IS '最近30天切换历史';

-- 创建函数：更新区域健康分数
CREATE OR REPLACE FUNCTION update_region_health_score(
  p_region_code VARCHAR(50),
  p_dimensions JSONB
)
RETURNS DECIMAL(5,2)
AS $$
DECLARE
  v_health_score DECIMAL(5,2) := 0;
  v_dimension RECORD;
BEGIN
  FOR v_dimension IN 
    SELECT dimension, weight, threshold 
    FROM disaster_recovery_health_thresholds
  LOOP
    IF v_dimension.dimension IN ('serviceAvailability', 'databaseHealth', 'cacheHealth') THEN
      IF (p_dimensions->>v_dimension.dimension)::DECIMAL >= v_dimension.threshold THEN
        v_health_score := v_health_score + v_dimension.weight * 100;
      ELSE
        v_health_score := v_health_score + v_dimension.weight * 
          ((p_dimensions->>v_dimension.dimension)::DECIMAL / v_dimension.threshold) * 100;
      END IF;
    ELSIF v_dimension.dimension = 'networkLatency' THEN
      IF (p_dimensions->>v_dimension.dimension)::DECIMAL <= v_dimension.threshold THEN
        v_health_score := v_health_score + v_dimension.weight * 100;
      ELSE
        v_health_score := v_health_score + v_dimension.weight * 
          (v_dimension.threshold / (p_dimensions->>v_dimension.dimension)::DECIMAL) * 100;
      END IF;
    ELSIF v_dimension.dimension = 'errorRate' THEN
      IF (p_dimensions->>v_dimension.dimension)::DECIMAL <= v_dimension.threshold THEN
        v_health_score := v_health_score + v_dimension.weight * 100;
      ELSE
        v_health_score := v_health_score + v_dimension.weight * 
          ((1 - (p_dimensions->>v_dimension.dimension)::DECIMAL) / (1 - v_dimension.threshold)) * 100;
      END IF;
    END IF;
  END LOOP;
  
  INSERT INTO disaster_recovery_region_health (region_code, health_score, status, dimensions)
  VALUES (
    p_region_code, 
    v_health_score,
    CASE 
      WHEN v_health_score >= 80 THEN 'healthy'
      WHEN v_health_score >= 50 THEN 'degraded'
      WHEN v_health_score > 0 THEN 'critical'
      ELSE 'offline'
    END,
    p_dimensions
  );
  
  RETURN v_health_score;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_region_health_score IS '计算并记录区域健康分数';

-- 创建触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_dr_region_config_updated_at
BEFORE UPDATE ON disaster_recovery_region_config
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 授权
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO minego_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO minego_app;
