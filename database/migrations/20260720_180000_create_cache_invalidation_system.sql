-- REQ-00523: 数据库查询结果缓存失效智能同步系统
-- 数据库迁移文件

-- 创建 CDC 状态表
CREATE TABLE IF NOT EXISTS cdc_status (
  id SERIAL PRIMARY KEY,
  instance_id VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'stopped', 'error')),
  last_heartbeat TIMESTAMP DEFAULT NOW(),
  config JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(instance_id)
);

COMMENT ON TABLE cdc_status IS 'CDC 实例状态追踪表';

-- 创建缓存失效事件日志表
CREATE TABLE IF NOT EXISTS cache_invalidation_log (
  id SERIAL PRIMARY KEY,
  instance_id VARCHAR(100) NOT NULL,
  table_name VARCHAR(100) NOT NULL,
  operation VARCHAR(20) NOT NULL CHECK (operation IN ('insert', 'update', 'delete', 'manual')),
  cache_keys TEXT[] NOT NULL,
  primary_key_value TEXT,
  latency_ms INTEGER,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE cache_invalidation_log IS '缓存失效事件日志';

CREATE INDEX idx_invalidation_log_table ON cache_invalidation_log(table_name);
CREATE INDEX idx_invalidation_log_created ON cache_invalidation_log(created_at);
CREATE INDEX idx_invalidation_log_instance ON cache_invalidation_log(instance_id);

-- 创建缓存失效规则配置表
CREATE TABLE IF NOT EXISTS cache_invalidation_rules (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(100) NOT NULL UNIQUE,
  primary_key VARCHAR(100) NOT NULL,
  cache_key_patterns JSONB NOT NULL,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id)
);

COMMENT ON TABLE cache_invalidation_rules IS '缓存失效规则配置表';

-- 创建缓存失效统计表（按小时聚合）
CREATE TABLE IF NOT EXISTS cache_invalidation_stats (
  id SERIAL PRIMARY KEY,
  hour_timestamp TIMESTAMP NOT NULL,
  instance_id VARCHAR(100) NOT NULL,
  total_changes INTEGER DEFAULT 0,
  invalidated_keys INTEGER DEFAULT 0,
  failed_invalidations INTEGER DEFAULT 0,
  avg_latency_ms REAL,
  success_rate REAL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(hour_timestamp, instance_id)
);

COMMENT ON TABLE cache_invalidation_stats IS '缓存失效统计表（按小时聚合）';

CREATE INDEX idx_invalidation_stats_hour ON cache_invalidation_stats(hour_timestamp);

-- 插入默认失效规则
INSERT INTO cache_invalidation_rules (table_name, primary_key, cache_key_patterns) VALUES
('users', 'id', '[{"pattern": "user:{id}", "type": "exact"}, {"pattern": "user:{id}:*", "type": "prefix"}]'),
('pokemon', 'id', '[{"pattern": "pokemon:{id}", "type": "exact"}, {"pattern": "pokemon:user:{userId}", "type": "exact"}, {"pattern": "pokemon:nearby:*", "type": "prefix"}]'),
('pokemon_species', 'id', '[{"pattern": "species:{id}", "type": "exact"}, {"pattern": "pokedex:*", "type": "prefix"}]'),
('gyms', 'id', '[{"pattern": "gym:{id}", "type": "exact"}, {"pattern": "gyms:nearby:*", "type": "prefix"}, {"pattern": "raid:{id}", "type": "exact"}]'),
('items', 'id', '[{"pattern": "item:{id}", "type": "exact"}, {"pattern": "items:*", "type": "prefix"}]'),
('user_items', 'user_id,item_id', '[{"pattern": "inventory:{userId}", "type": "exact"}, {"pattern": "user:{userId}:items", "type": "exact"}]'),
('friendships', 'id', '[{"pattern": "friends:{userId}", "type": "exact"}, {"pattern": "friend:*", "type": "prefix"}]'),
('trades', 'id', '[{"pattern": "trade:{id}", "type": "exact"}, {"pattern": "trades:user:{userId}", "type": "exact"}]'),
('marketplace_listings', 'id', '[{"pattern": "listing:{id}", "type": "exact"}, {"pattern": "marketplace:*", "type": "prefix"}]'),
('catches', 'id', '[{"pattern": "catch:{id}", "type": "exact"}, {"pattern": "catches:user:{userId}", "type": "prefix"}]'),
('achievements', 'id', '[{"pattern": "achievement:{id}", "type": "exact"}, {"pattern": "achievements:user:{userId}", "type": "exact"}]'),
('raids', 'id', '[{"pattern": "raid:{id}", "type": "exact"}, {"pattern": "raids:nearby:*", "type": "prefix"}]')
ON CONFLICT (table_name) DO NOTHING;

-- 创建触发器函数：记录缓存失效事件
CREATE OR REPLACE FUNCTION log_cache_invalidation()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO cache_invalidation_log (
    instance_id,
    table_name,
    operation,
    cache_keys,
    primary_key_value,
    latency_ms,
    success
  ) VALUES (
    'default',
    TG_TABLE_NAME,
    LOWER(TG_OP),
    ARRAY[]::TEXT[],
    NULL,
    NULL,
    true
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 创建监控视图
CREATE OR REPLACE VIEW cache_invalidation_health AS
SELECT 
  instance_id,
  status,
  last_heartbeat,
  EXTRACT(EPOCH FROM (NOW() - last_heartbeat)) AS seconds_since_heartbeat,
  CASE 
    WHEN EXTRACT(EPOCH FROM (NOW() - last_heartbeat)) < 60 THEN 'healthy'
    WHEN EXTRACT(EPOCH FROM (NOW() - last_heartbeat)) < 300 THEN 'warning'
    ELSE 'unhealthy'
  END AS health_status
FROM cdc_status
ORDER BY last_heartbeat DESC;

COMMENT ON VIEW cache_invalidation_health IS 'CDC 健康状态视图';

-- 创建统计聚合函数
CREATE OR REPLACE FUNCTION aggregate_invalidation_stats()
RETURNS void AS $$
BEGIN
  INSERT INTO cache_invalidation_stats (
    hour_timestamp,
    instance_id,
    total_changes,
    invalidated_keys,
    failed_invalidations,
    avg_latency_ms,
    success_rate
  )
  SELECT 
    date_trunc('hour', created_at) AS hour_timestamp,
    instance_id,
    COUNT(*) AS total_changes,
    SUM(array_length(cache_keys, 1)) AS invalidated_keys,
    COUNT(*) FILTER (WHERE NOT success) AS failed_invalidations,
    AVG(latency_ms) AS avg_latency_ms,
    (COUNT(*) FILTER (WHERE success)::FLOAT / COUNT(*) * 100) AS success_rate
  FROM cache_invalidation_log
  WHERE created_at >= date_trunc('hour', NOW() - INTERVAL '1 hour')
    AND created_at < date_trunc('hour', NOW())
  GROUP BY date_trunc('hour', created_at), instance_id
  ON CONFLICT (hour_timestamp, instance_id) 
  DO UPDATE SET
    total_changes = EXCLUDED.total_changes,
    invalidated_keys = EXCLUDED.invalidated_keys,
    failed_invalidations = EXCLUDED.failed_invalidations,
    avg_latency_ms = EXCLUDED.avg_latency_ms,
    success_rate = EXCLUDED.success_rate;
END;
$$ LANGUAGE plpgsql;

-- 创建定时任务：每小时聚合统计
-- 注意：需要安装 pg_cron 扩展
-- SELECT cron.schedule('aggregate_invalidation_stats', '0 * * * *', 'SELECT aggregate_invalidation_stats()');

-- 创建清理函数：删除旧日志
CREATE OR REPLACE FUNCTION cleanup_old_invalidation_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM cache_invalidation_log
  WHERE created_at < NOW() - INTERVAL '30 days';
  
  DELETE FROM cache_invalidation_stats
  WHERE hour_timestamp < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- 创建索引优化查询
CREATE INDEX IF NOT EXISTS idx_cdc_status_heartbeat ON cdc_status(last_heartbeat DESC);
CREATE INDEX IF NOT EXISTS idx_invalidation_log_success ON cache_invalidation_log(success);

-- 授权
GRANT SELECT, INSERT, UPDATE, DELETE ON cdc_status TO minego_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON cache_invalidation_log TO minego_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON cache_invalidation_rules TO minego_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON cache_invalidation_stats TO minego_user;
GRANT SELECT ON cache_invalidation_health TO minego_user;
