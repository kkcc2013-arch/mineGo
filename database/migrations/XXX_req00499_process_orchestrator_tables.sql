-- REQ-00499: 流程编排数据库迁移
-- 创建流程实例和步骤记录表

-- 流程实例表
CREATE TABLE IF NOT EXISTS process_instances (
  instance_id VARCHAR(64) PRIMARY KEY,
  process_type VARCHAR(64) NOT NULL,
  version VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  current_step VARCHAR(64),
  input JSONB,
  output JSONB,
  error JSONB,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  trace_id VARCHAR(64),
  context JSONB DEFAULT '{}'::jsonb
);

-- 流程步骤记录表
CREATE TABLE IF NOT EXISTS process_steps (
  id SERIAL PRIMARY KEY,
  instance_id VARCHAR(64) NOT NULL REFERENCES process_instances(instance_id) ON DELETE CASCADE,
  step_name VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  service VARCHAR(64),
  action VARCHAR(64),
  input JSONB,
  output JSONB,
  error JSONB,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  compensation_status VARCHAR(32) DEFAULT 'pending',
  compensation_completed_at TIMESTAMP,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 补偿步骤表
CREATE TABLE IF NOT EXISTS compensation_steps (
  id SERIAL PRIMARY KEY,
  instance_id VARCHAR(64) NOT NULL REFERENCES process_instances(instance_id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  step_name VARCHAR(64) NOT NULL,
  service VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL,
  input JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  executed_at TIMESTAMP,
  completed_at TIMESTAMP,
  error JSONB,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_process_instances_type ON process_instances(process_type);
CREATE INDEX IF NOT EXISTS idx_process_instances_status ON process_instances(status);
CREATE INDEX IF NOT EXISTS idx_process_instances_trace_id ON process_instances(trace_id);
CREATE INDEX IF NOT EXISTS idx_process_instances_created_at ON process_instances(created_at);
CREATE INDEX IF NOT EXISTS idx_process_instances_started_at ON process_instances(started_at);

CREATE INDEX IF NOT EXISTS idx_process_steps_instance ON process_steps(instance_id);
CREATE INDEX IF NOT EXISTS idx_process_steps_status ON process_steps(status);
CREATE INDEX IF NOT EXISTS idx_process_steps_service ON process_steps(service);

CREATE INDEX IF NOT EXISTS idx_compensation_steps_instance ON compensation_steps(instance_id);
CREATE INDEX IF NOT EXISTS idx_compensation_steps_status ON compensation_steps(status);

-- 流程定义版本表
CREATE TABLE IF NOT EXISTS process_definitions (
  process_type VARCHAR(64) NOT NULL,
  version VARCHAR(32) NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  PRIMARY KEY (process_type, version)
);

CREATE INDEX IF NOT EXISTS idx_process_definitions_active ON process_definitions(is_active);

-- 添加注释
COMMENT ON TABLE process_instances IS 'REQ-00499: 流程实例主表，记录流程执行状态和历史';
COMMENT ON TABLE process_steps IS 'REQ-00499: 流程步骤执行记录，包含输入输出和补偿状态';
COMMENT ON TABLE compensation_steps IS 'REQ-00499: 补偿事务步骤记录，用于 Saga 模式逆向补偿';
COMMENT ON TABLE process_definitions IS 'REQ-00499: 流程定义版本管理表';

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_process_instances_updated_at 
  BEFORE UPDATE ON process_instances 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_process_definitions_updated_at 
  BEFORE UPDATE ON process_definitions 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();