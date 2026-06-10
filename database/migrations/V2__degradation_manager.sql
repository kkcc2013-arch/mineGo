-- REQ-00068: 服务降级策略与优雅降级管理器
-- 降级审计日志表

-- 降级审计日志表
CREATE TABLE IF NOT EXISTS degradation_audit_log (
    id BIGSERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    level VARCHAR(20) NOT NULL,
    actions JSONB DEFAULT '[]',
    metrics JSONB DEFAULT '{}',
    trigger_source VARCHAR(50) DEFAULT 'auto', -- auto, manual, system
    changed_by VARCHAR(100),
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 降级历史快照表（用于分析）
CREATE TABLE IF NOT EXISTS degradation_snapshots (
    id BIGSERIAL PRIMARY KEY,
    snapshot_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    services_status JSONB NOT NULL,
    total_degraded_services INT DEFAULT 0,
    summary JSONB DEFAULT '{}'
);

-- 降级配置版本表
CREATE TABLE IF NOT EXISTS degradation_config_versions (
    id SERIAL PRIMARY KEY,
    version INT NOT NULL,
    config JSONB NOT NULL,
    changed_by VARCHAR(100),
    change_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_degradation_audit_service ON degradation_audit_log(service_name);
CREATE INDEX idx_degradation_audit_time ON degradation_audit_log(created_at DESC);
CREATE INDEX idx_degradation_audit_level ON degradation_audit_log(level);
CREATE INDEX idx_degradation_snapshots_time ON degradation_snapshots(snapshot_time DESC);

-- 注释
COMMENT ON TABLE degradation_audit_log IS '降级操作审计日志';
COMMENT ON TABLE degradation_snapshots IS '系统降级状态快照，用于历史分析';
COMMENT ON TABLE degradation_config_versions IS '降级配置版本历史';

-- 插入初始配置
INSERT INTO degradation_config_versions (version, config, changed_by, change_reason)
VALUES (
    1,
    '{
        "global": {
            "enabled": true,
            "triggerConditions": {
                "cpuUsage": 85,
                "memoryUsage": 90,
                "errorRate": 0.05,
                "latencyP99": 3000
            }
        },
        "userTiers": {
            "vip": {"priority": 1, "exemptFromDegradation": true},
            "premium": {"priority": 2, "degradationDelay": 60},
            "free": {"priority": 3, "degradationDelay": 0}
        }
    }'::jsonb,
    'system',
    'Initial degradation configuration'
);
