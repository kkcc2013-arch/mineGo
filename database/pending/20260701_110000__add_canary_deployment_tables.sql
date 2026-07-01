-- 金丝雀发布系统数据库迁移
-- Migration: 20260701_110000__add_canary_deployment_tables
-- Description: 添加金丝雀发布相关的数据库表

-- 金丝雀发布主表
CREATE TABLE IF NOT EXISTS canary_deployments (
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
CREATE TABLE IF NOT EXISTS canary_deployment_history (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES canary_deployments(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 金丝雀指标快照表
CREATE TABLE IF NOT EXISTS canary_metrics_snapshots (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES canary_deployments(id) ON DELETE CASCADE,
    metrics JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 金丝雀请求日志表（用于指标统计）
CREATE TABLE IF NOT EXISTS canary_request_logs (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES canary_deployments(id) ON DELETE CASCADE,
    status_code INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_canary_deployments_service ON canary_deployments(service_name, status);
CREATE INDEX IF NOT EXISTS idx_canary_deployments_status ON canary_deployments(status);
CREATE INDEX IF NOT EXISTS idx_canary_deployments_active ON canary_deployments(service_name) WHERE status IN ('active', 'promoting');
CREATE INDEX IF NOT EXISTS idx_canary_history_deployment ON canary_deployment_history(deployment_id);
CREATE INDEX IF NOT EXISTS idx_canary_metrics_deployment ON canary_metrics_snapshots(deployment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canary_logs_deployment_time ON canary_request_logs(deployment_id, created_at DESC);

-- 注释
COMMENT ON TABLE canary_deployments IS '金丝雀发布主表';
COMMENT ON TABLE canary_deployment_history IS '金丝雀发布历史记录';
COMMENT ON TABLE canary_metrics_snapshots IS '金丝雀指标快照';
COMMENT ON TABLE canary_request_logs IS '金丝雀请求日志（用于指标统计）';

COMMENT ON COLUMN canary_deployments.traffic_split IS '金丝雀流量百分比（0-100）';
COMMENT ON COLUMN canary_deployments.strategy IS '发布策略：progressive(渐进式) / manual(手动) / auto(自动) / header / cookie / user-segment';
COMMENT ON COLUMN canary_deployments.auto_promote IS '是否自动推进（指标正常时自动增加流量）';
COMMENT ON COLUMN canary_deployments.metrics_baseline IS '指标基线（用于对比验证）';

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_canary_deployments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_canary_deployments_updated_at ON canary_deployments;
CREATE TRIGGER trigger_update_canary_deployments_updated_at
    BEFORE UPDATE ON canary_deployments
    FOR EACH ROW
    EXECUTE FUNCTION update_canary_deployments_updated_at();

-- 插入示例数据（可选）
-- INSERT INTO canary_deployments (service_name, canary_version, stable_version, traffic_split, strategy)
-- VALUES ('catch-service', 'v1.2.0', 'v1.1.0', 5, 'progressive');