-- 部署记录表
CREATE TABLE IF NOT EXISTS deployment_records (
  id SERIAL PRIMARY KEY,
  deployment_id VARCHAR(100) NOT NULL UNIQUE,
  service VARCHAR(50) NOT NULL,
  environment VARCHAR(20) NOT NULL, -- staging/production
  version VARCHAR(100) NOT NULL,
  commit_sha VARCHAR(40),
  branch VARCHAR(100),
  status VARCHAR(30) NOT NULL, -- pending/running/success/failed/rolled_back
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  triggered_by VARCHAR(100),
  trigger_type VARCHAR(30), -- manual/scheduled/auto
  rollback_from VARCHAR(100), -- 如果是回滚，记录原部署 ID
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployments_service ON deployment_records(service);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployment_records(status);
CREATE INDEX IF NOT EXISTS idx_deployments_env ON deployment_records(environment);
CREATE INDEX IF NOT EXISTS idx_deployments_time ON deployment_records(started_at DESC);

-- 部署步骤表
CREATE TABLE IF NOT EXISTS deployment_steps (
  id SERIAL PRIMARY KEY,
  deployment_id VARCHAR(100) NOT NULL,
  step_name VARCHAR(100) NOT NULL,
  step_order INTEGER NOT NULL,
  status VARCHAR(30) NOT NULL, -- pending/running/success/failed/skipped
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  log_text TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_steps_deployment ON deployment_steps(deployment_id);
CREATE INDEX IF NOT EXISTS idx_steps_status ON deployment_steps(status);

-- 部署告警表
CREATE TABLE IF NOT EXISTS deployment_alerts (
  id SERIAL PRIMARY KEY,
  deployment_id VARCHAR(100) NOT NULL,
  alert_type VARCHAR(50) NOT NULL, -- error/warning/info
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_by VARCHAR(100),
  acknowledged_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_alerts_deployment ON deployment_alerts(deployment_id);
CREATE INDEX IF NOT EXISTS idx_alerts_ack ON deployment_alerts(acknowledged);

COMMENT ON TABLE deployment_records IS '部署记录表，记录每次部署的完整状态';
COMMENT ON TABLE deployment_steps IS '部署步骤表，记录部署过程中每个步骤的执行情况';
COMMENT ON TABLE deployment_alerts IS '部署告警表，记录部署过程中的告警和问题';