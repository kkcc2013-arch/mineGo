-- 数据库迁移：灾难演练系统
-- 创建时间：2026-07-20

-- 演练记录表
CREATE TABLE IF NOT EXISTS drill_records (
    id VARCHAR(100) PRIMARY KEY,
    scenario_id VARCHAR(100) NOT NULL,
    scenario_name VARCHAR(200) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('full', 'partial', 'dry-run')),
    status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'stopped')),
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    duration INTEGER, -- 毫秒
    
    -- 混沌实验配置
    chaos_experiments JSONB DEFAULT '[]'::jsonb,
    
    -- 指标数据
    metrics JSONB DEFAULT '{}'::jsonb,
    
    -- 结果分析
    results JSONB DEFAULT '{}'::jsonb,
    
    -- RTO/RPO
    rto INTEGER, -- 毫秒
    rpo INTEGER, -- 毫秒
    
    -- 元数据
    created_by VARCHAR(100),
    auto_rollback BOOLEAN DEFAULT true,
    manual_stop BOOLEAN DEFAULT false,
    error_message TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 演练场景配置表
CREATE TABLE IF NOT EXISTS drill_scenarios (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    type VARCHAR(50) NOT NULL CHECK (type IN ('full', 'partial', 'dry-run')),
    
    -- 配置
    chaos_experiments JSONB DEFAULT '[]'::jsonb,
    duration INTEGER NOT NULL DEFAULT 1800000,
    target_services TEXT[] DEFAULT '{}',
    target_region VARCHAR(100),
    
    -- 目标值
    rto_target INTEGER DEFAULT 300000,
    rpo_target INTEGER DEFAULT 60000,
    
    -- 开关
    auto_rollback BOOLEAN DEFAULT true,
    enabled BOOLEAN DEFAULT true,
    
    -- 调度配置
    schedule_cron VARCHAR(100),
    last_run TIMESTAMP,
    next_run TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 混沌实验记录表
CREATE TABLE IF NOT EXISTS chaos_experiments (
    id VARCHAR(100) PRIMARY KEY,
    drill_id VARCHAR(100) NOT NULL REFERENCES drill_records(id) ON DELETE CASCADE,
    
    kind VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL,
    
    -- Kubernetes 资源信息
    namespace VARCHAR(100),
    resource_name VARCHAR(200),
    
    -- 注入时间
    injected_at TIMESTAMP,
    rolled_back_at TIMESTAMP,
    
    -- 目标服务
    target_services TEXT[] DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- SLO 监控快照表
CREATE TABLE IF NOT EXISTS slo_snapshots (
    id SERIAL PRIMARY KEY,
    drill_id VARCHAR(100) NOT NULL REFERENCES drill_records(id) ON DELETE CASCADE,
    
    -- 采集时间
    captured_at TIMESTAMP NOT NULL,
    
    -- SLO 指标
    availability NUMERIC(5, 4),
    latency_p50 NUMERIC(10, 3),
    latency_p95 NUMERIC(10, 3),
    latency_p99 NUMERIC(10, 3),
    error_rate NUMERIC(5, 4),
    throughput INTEGER,
    
    -- 额外指标
    extra_metrics JSONB DEFAULT '{}'::jsonb,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 演练报告表
CREATE TABLE IF NOT EXISTS drill_reports (
    id VARCHAR(100) PRIMARY KEY,
    drill_id VARCHAR(100) NOT NULL REFERENCES drill_records(id) ON DELETE CASCADE,
    
    -- 报告格式
    format VARCHAR(50) DEFAULT 'standard',
    
    -- 报告内容
    content JSONB NOT NULL,
    
    -- 生成时间
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- 导出路径（如果导出为文件）
    export_path TEXT
);

-- 演练建议表
CREATE TABLE IF NOT EXISTS drill_recommendations (
    id SERIAL PRIMARY KEY,
    drill_id VARCHAR(100) NOT NULL REFERENCES drill_records(id) ON DELETE CASCADE,
    
    -- 建议信息
    category VARCHAR(100) NOT NULL,
    severity VARCHAR(50) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    message TEXT NOT NULL,
    
    -- 相关指标
    metric_name VARCHAR(100),
    current_value NUMERIC,
    target_value NUMERIC,
    
    -- 状态
    status VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'ignored')),
    resolved_at TIMESTAMP,
    resolved_by VARCHAR(100),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 演练统计视图
CREATE OR REPLACE VIEW drill_statistics AS
SELECT 
    COUNT(*) AS total_drills,
    COUNT(*) FILTER (WHERE status = 'completed') AS successful_drills,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_drills,
    COUNT(*) FILTER (WHERE status = 'stopped') AS stopped_drills,
    
    AVG(duration) AS avg_duration,
    AVG(rto) AS avg_rto,
    AVG(rpo) AS avg_rpo,
    
    AVG((results->'sloCompliance'->'availability'->>'passed')::boolean) AS avg_availability_compliance,
    
    MAX(start_time) AS last_drill_time,
    MIN(start_time) AS first_drill_time
    
FROM drill_records;

-- 演练历史视图
CREATE OR REPLACE VIEW drill_history AS
SELECT 
    dr.id,
    dr.scenario_id,
    dr.scenario_name,
    dr.type,
    dr.status,
    dr.start_time,
    dr.end_time,
    dr.duration,
    dr.rto,
    dr.rpo,
    dr.results->'impactAnalysis'->>'overallImpact' AS overall_impact,
    COUNT(ce.id) AS experiment_count
FROM drill_records dr
LEFT JOIN chaos_experiments ce ON ce.drill_id = dr.id
GROUP BY dr.id
ORDER BY dr.start_time DESC;

-- 活跃演练视图
CREATE OR REPLACE VIEW active_drills AS
SELECT 
    id,
    scenario_id,
    scenario_name,
    type,
    start_time,
    EXTRACT(EPOCH FROM (NOW() - start_time)) * 1000 AS elapsed_time
FROM drill_records
WHERE status = 'running';

-- 索引
CREATE INDEX idx_drill_records_status ON drill_records(status);
CREATE INDEX idx_drill_records_scenario ON drill_records(scenario_id);
CREATE INDEX idx_drill_records_start_time ON drill_records(start_time DESC);
CREATE INDEX idx_chaos_experiments_drill ON chaos_experiments(drill_id);
CREATE INDEX idx_slo_snapshots_drill ON slo_snapshots(drill_id);
CREATE INDEX idx_drill_recommendations_status ON drill_recommendations(status);

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_drill_records_updated_at
    BEFORE UPDATE ON drill_records
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_drill_scenarios_updated_at
    BEFORE UPDATE ON drill_scenarios
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 函数：获取演练统计
CREATE OR REPLACE FUNCTION get_drill_statistics(
    p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
    total_drills BIGINT,
    successful_drills BIGINT,
    failed_drills BIGINT,
    avg_rto NUMERIC,
    avg_rpo NUMERIC,
    avg_duration NUMERIC,
    slo_compliance_rate NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*)::BIGINT AS total_drills,
        COUNT(*) FILTER (WHERE status = 'completed')::BIGINT AS successful_drills,
        COUNT(*) FILTER (WHERE status = 'failed')::BIGINT AS failed_drills,
        AVG(rto)::NUMERIC AS avg_rto,
        AVG(rpo)::NUMERIC AS avg_rpo,
        AVG(duration)::NUMERIC AS avg_duration,
        AVG(CASE 
            WHEN (results->'sloCompliance'->'availability'->>'passed')::boolean = true 
            THEN 1 
            ELSE 0 
        END)::NUMERIC AS slo_compliance_rate
    FROM drill_records
    WHERE start_time >= NOW() - (p_days || ' days')::interval;
END;
$$ LANGUAGE plpgsql;

-- 函数：清理旧的演练记录
CREATE OR REPLACE FUNCTION cleanup_old_drill_records(
    p_retention_days INTEGER DEFAULT 90
)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM drill_records
    WHERE created_at < NOW() - (p_retention_days || ' days')::interval;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 函数：生成演练摘要
CREATE OR REPLACE FUNCTION generate_drill_summary(
    p_drill_id VARCHAR(100)
)
RETURNS JSONB AS $$
DECLARE
    summary JSONB;
BEGIN
    SELECT jsonb_build_object(
        'drill_id', id,
        'scenario', scenario_name,
        'status', status,
        'duration', duration,
        'rto', rto,
        'rpo', rpo,
        'experiments', (SELECT COUNT(*) FROM chaos_experiments WHERE drill_id = p_drill_id),
        'slo_compliance', results->'sloCompliance',
        'impact', results->'impactAnalysis',
        'recommendations', (
            SELECT jsonb_agg(jsonb_build_object(
                'category', category,
                'severity', severity,
                'message', message
            ))
            FROM drill_recommendations
            WHERE drill_id = p_drill_id
        )
    ) INTO summary
    FROM drill_records
    WHERE id = p_drill_id;
    
    RETURN summary;
END;
$$ LANGUAGE plpgsql;

-- 初始化默认演练场景
INSERT INTO drill_scenarios (id, name, description, type, chaos_experiments, duration, target_services, rto_target, rpo_target)
VALUES 
(
    'region-outage',
    '区域服务下线演练',
    '模拟整个区域的服务不可用',
    'full',
    '[{"kind": "NetworkChaos", "spec": {"action": "partition", "mode": "all", "selector": {"namespaces": ["minego"], "labelSelectors": {"region": "beijing"}}}}]'::jsonb,
    1800000,
    ARRAY['gateway', 'user-service', 'pokemon-service'],
    300000,
    60000
),
(
    'database-failure',
    '数据库故障演练',
    '模拟数据库主从切换',
    'partial',
    '[{"kind": "PodChaos", "spec": {"action": "pod-kill", "mode": "one", "selector": {"namespaces": ["minego"], "labelSelectors": {"app": "postgresql-primary"}}}}]'::jsonb,
    600000,
    ARRAY['database'],
    120000,
    30000
),
(
    'network-latency',
    '网络延迟演练',
    '模拟网络延迟增加',
    'partial',
    '[{"kind": "NetworkChaos", "spec": {"action": "delay", "mode": "all", "selector": {"namespaces": ["minego"], "labelSelectors": {"app": "gateway"}}, "delay": {"latency": "500ms"}}}]'::jsonb,
    900000,
    ARRAY['gateway'],
    60000,
    0
),
(
    'cache-failure',
    '缓存故障演练',
    '模拟 Redis 缓存故障',
    'partial',
    '[{"kind": "PodChaos", "spec": {"action": "pod-kill", "mode": "one", "selector": {"namespaces": ["minego"], "labelSelectors": {"app": "redis"}}}}]'::jsonb,
    300000,
    ARRAY['redis'],
    60000,
    0
);

-- 注释
COMMENT ON TABLE drill_records IS '演练记录表';
COMMENT ON TABLE drill_scenarios IS '演练场景配置表';
COMMENT ON TABLE chaos_experiments IS '混沌实验记录表';
COMMENT ON TABLE slo_snapshots IS 'SLO 监控快照表';
COMMENT ON TABLE drill_reports IS '演练报告表';
COMMENT ON TABLE drill_recommendations IS '演练建议表';
