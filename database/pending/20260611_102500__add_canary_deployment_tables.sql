-- 金丝雀发布主表
CREATE TABLE canary_deployments (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    
    -- 版本信息
    canary_version VARCHAR(100) NOT NULL,
    stable_version VARCHAR(100) NOT NULL,
    
    -- 流量控制
    traffic_split INTEGER DEFAULT 0 CHECK (traffic_split >= 0 AND traffic_split <= 100),
    
    -- 策略
    strategy VARCHAR(20) DEFAULT 'progressive' CHECK (strategy IN ('progressive', 'manual', 'auto', 'header', 'cookie', 'user-segment', 'force-canary')),
    rules JSONB DEFAULT '{}',
    auto_promote BOOLEAN DEFAULT true,
    
    -- 指标基线
    metrics_baseline JSONB DEFAULT '{}',
    
    -- 状态
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'promoting', 'completed', 'rolled_back', 'cancelled')),
    
    -- 回滚信息
    rollback_reason TEXT,
    rolled_back_at TIMESTAMP,
    
    -- 时间戳
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    
    created_by INTEGER,
    
    CONSTRAINT unique_active_canary UNIQUE (service_name, status) 
      WHERE status IN ('active', 'promoting')
);

-- 金丝雀发布历史表
CREATE TABLE canary_deployment_history (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES canary_deployments(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 金丝雀指标快照表
CREATE TABLE canary_metrics_snapshots (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES canary_deployments(id) ON DELETE CASCADE,
    metrics JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_canary_deployments_service ON canary_deployments(service_name, status);
CREATE INDEX idx_canary_deployments_status ON canary_deployments(status);
CREATE INDEX idx_canary_history_deployment ON canary_deployment_history(deployment_id);
CREATE INDEX idx_canary_metrics_deployment ON canary_metrics_snapshots(deployment_id, created_at DESC);

-- 注释
COMMENT ON TABLE canary_deployments IS '金丝雀发布主表';
COMMENT ON TABLE canary_deployment_history IS '金丝雀发布历史记录';
COMMENT ON TABLE canary_metrics_snapshots IS '金丝雀指标快照';
