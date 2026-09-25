/**
 * 数据库迁移：连接池智能管理相关表
 * REQ-00623: 数据库连接池智能预热与动态自适应管理系统
 */

-- 连接池使用历史记录表
CREATE TABLE IF NOT EXISTS pool_usage_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name    VARCHAR(50) NOT NULL,
  pool_name       VARCHAR(100) NOT NULL,
  total_connections   INTEGER NOT NULL,
  idle_connections    INTEGER NOT NULL,
  waiting_clients     INTEGER NOT NULL,
  utilization         DECIMAL(5,4) NOT NULL,
  avg_query_time_ms   INTEGER,
  timestamp       TIMESTAMP NOT NULL DEFAULT NOW(),
  
  -- 索引优化字段
  hour            INTEGER NOT NULL,
  day_of_week     INTEGER NOT NULL
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS id UUID DEFAULT uuid_generate_v4();
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS service_name VARCHAR(50);
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS pool_name VARCHAR(100);
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS total_connections INTEGER;
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS idle_connections INTEGER;
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS waiting_clients INTEGER;
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS utilization DECIMAL(5,4);
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS avg_query_time_ms INTEGER;
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS timestamp TIMESTAMP DEFAULT NOW();
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS hour INTEGER;
ALTER TABLE pool_usage_history ADD COLUMN IF NOT EXISTS day_of_week INTEGER;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.pool_usage_history') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('id', 'service_name', 'pool_name', 'total_connections', 'idle_connections', 'waiting_clients', 'utilization', 'avg_query_time_ms', 'timestamp', 'hour', 'day_of_week', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE pool_usage_history ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_pool_history_service_time 
  ON pool_usage_history(service_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pool_history_hour 
  ON pool_usage_history(service_name, hour, day_of_week);
CREATE INDEX IF NOT EXISTS idx_pool_history_utilization 
  ON pool_usage_history(service_name, utilization DESC) 
  WHERE utilization > 0.8;

-- 连接池配置调整历史表
CREATE TABLE IF NOT EXISTS pool_config_changes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name    VARCHAR(50) NOT NULL,
  old_max_size    INTEGER NOT NULL,
  new_max_size    INTEGER NOT NULL,
  old_min_size    INTEGER NOT NULL,
  new_min_size    INTEGER NOT NULL,
  action          VARCHAR(20) NOT NULL, -- 'scale_up', 'scale_down', 'preheat'
  reason          TEXT,
  triggered_by    VARCHAR(50) NOT NULL, -- 'auto', 'manual', 'scheduled'
  metrics_snapshot JSONB,
  timestamp       TIMESTAMP NOT NULL DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS id UUID DEFAULT uuid_generate_v4();
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS service_name VARCHAR(50);
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS old_max_size INTEGER;
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS new_max_size INTEGER;
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS old_min_size INTEGER;
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS new_min_size INTEGER;
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS action VARCHAR(20);
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(50);
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS metrics_snapshot JSONB;
ALTER TABLE pool_config_changes ADD COLUMN IF NOT EXISTS timestamp TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.pool_config_changes') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('id', 'service_name', 'old_max_size', 'new_max_size', 'old_min_size', 'new_min_size', 'action', 'reason', 'triggered_by', 'metrics_snapshot', 'timestamp', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE pool_config_changes ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_pool_changes_service_time 
  ON pool_config_changes(service_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pool_changes_action 
  ON pool_config_changes(action, timestamp DESC);

-- 流量预测数据表
CREATE TABLE IF NOT EXISTS traffic_predictions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prediction_time TIMESTAMP NOT NULL,
  predicted_hour  INTEGER NOT NULL,
  predicted_day   INTEGER NOT NULL,
  expected_traffic VARCHAR(20) NOT NULL, -- 'low', 'medium', 'high', 'very_high'
  confidence      DECIMAL(3,2) NOT NULL, -- 0.00 - 1.00
  model_version   VARCHAR(50),
  features        JSONB,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMP NOT NULL
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE traffic_predictions ADD COLUMN IF NOT EXISTS id UUID DEFAULT uuid_generate_v4();
ALTER TABLE traffic_predictions ADD COLUMN IF NOT EXISTS prediction_time TIMESTAMP;
ALTER TABLE traffic_predictions ADD COLUMN IF NOT EXISTS predicted_hour INTEGER;
ALTER TABLE traffic_predictions ADD COLUMN IF NOT EXISTS predicted_day INTEGER;
ALTER TABLE traffic_predictions ADD COLUMN IF NOT EXISTS expected_traffic VARCHAR(20);
ALTER TABLE traffic_predictions ADD COLUMN IF NOT EXISTS confidence DECIMAL(3,2);
ALTER TABLE traffic_predictions ADD COLUMN IF NOT EXISTS model_version VARCHAR(50);
ALTER TABLE traffic_predictions ADD COLUMN IF NOT EXISTS features JSONB;
ALTER TABLE traffic_predictions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE traffic_predictions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.traffic_predictions') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('id', 'prediction_time', 'predicted_hour', 'predicted_day', 'expected_traffic', 'confidence', 'model_version', 'features', 'created_at', 'expires_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE traffic_predictions ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_traffic_predictions_time 
  ON traffic_predictions(prediction_time);
CREATE INDEX IF NOT EXISTS idx_traffic_predictions_expires 
  ON traffic_predictions(expires_at) 
  WHERE expires_at IS NOT NULL;

-- 预热任务记录表
CREATE TABLE IF NOT EXISTS pool_preheat_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name    VARCHAR(50) NOT NULL,
  preheat_type    VARCHAR(50) NOT NULL, -- 'scheduled', 'manual', 'prediction-based'
  target_connections INTEGER NOT NULL,
  actual_connections  INTEGER,
  success         BOOLEAN NOT NULL DEFAULT false,
  duration_ms     INTEGER,
  error_message   TEXT,
  timestamp       TIMESTAMP NOT NULL DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE pool_preheat_records ADD COLUMN IF NOT EXISTS id UUID DEFAULT uuid_generate_v4();
ALTER TABLE pool_preheat_records ADD COLUMN IF NOT EXISTS service_name VARCHAR(50);
ALTER TABLE pool_preheat_records ADD COLUMN IF NOT EXISTS preheat_type VARCHAR(50);
ALTER TABLE pool_preheat_records ADD COLUMN IF NOT EXISTS target_connections INTEGER;
ALTER TABLE pool_preheat_records ADD COLUMN IF NOT EXISTS actual_connections INTEGER;
ALTER TABLE pool_preheat_records ADD COLUMN IF NOT EXISTS success BOOLEAN DEFAULT false;
ALTER TABLE pool_preheat_records ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE pool_preheat_records ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE pool_preheat_records ADD COLUMN IF NOT EXISTS timestamp TIMESTAMP DEFAULT NOW();
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.pool_preheat_records') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('id', 'service_name', 'preheat_type', 'target_connections', 'actual_connections', 'success', 'duration_ms', 'error_message', 'timestamp', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE pool_preheat_records ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

CREATE INDEX IF NOT EXISTS idx_preheat_records_time 
  ON pool_preheat_records(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_preheat_records_service 
  ON pool_preheat_records(service_name, timestamp DESC);

-- 添加注释
COMMENT ON TABLE pool_usage_history IS '连接池使用率历史记录，用于分析和预测';
COMMENT ON TABLE pool_config_changes IS '连接池配置调整历史记录';
COMMENT ON TABLE traffic_predictions IS '流量预测数据存储';
COMMENT ON TABLE pool_preheat_records IS '连接池预热任务执行记录';

-- 创建视图：连接池使用率统计
CREATE OR REPLACE VIEW v_pool_utilization_stats AS
SELECT 
  service_name,
  DATE_TRUNC('hour', timestamp) AS hour,
  COUNT(*) AS sample_count,
  AVG(utilization) AS avg_utilization,
  MAX(utilization) AS max_utilization,
  MIN(utilization) AS min_utilization,
  AVG(waiting_clients) AS avg_waiting_clients,
  MAX(waiting_clients) AS max_waiting_clients
FROM pool_usage_history
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY service_name, DATE_TRUNC('hour', timestamp)
ORDER BY service_name, hour DESC;

-- 创建视图：连接池健康状态
CREATE OR REPLACE VIEW v_pool_health_status AS
SELECT 
  service_name,
  COUNT(*) FILTER (WHERE utilization > 0.85) AS high_utilization_count,
  COUNT(*) FILTER (WHERE utilization < 0.3) AS low_utilization_count,
  AVG(utilization) AS avg_utilization,
  MAX(timestamp) AS last_update
FROM pool_usage_history
WHERE timestamp > NOW() - INTERVAL '1 hour'
GROUP BY service_name;

-- 创建函数：清理过期数据
CREATE OR REPLACE FUNCTION cleanup_pool_history()
RETURNS void AS $$
BEGIN
  -- 删除 7 天前的历史记录
  DELETE FROM pool_usage_history 
  WHERE timestamp < NOW() - INTERVAL '7 days';
  
  -- 删除过期的预测数据
  DELETE FROM traffic_predictions 
  WHERE expires_at < NOW();
  
  -- 删除 30 天前的配置变更记录
  DELETE FROM pool_config_changes 
  WHERE timestamp < NOW() - INTERVAL '30 days';
  
  RAISE NOTICE 'Pool history cleanup completed';
END;
$$ LANGUAGE plpgsql;

-- 创建定时任务：每小时清理一次
-- 注意：需要安装 pg_cron 扩展
-- SELECT cron.schedule('cleanup_pool_history', '0 * * * *', 'SELECT cleanup_pool_history()');
