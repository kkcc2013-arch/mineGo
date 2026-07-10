-- REQ-00527: 数据导出任务表

CREATE TABLE IF NOT EXISTS data_export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format VARCHAR(20) NOT NULL CHECK (format IN ('json', 'csv', 'xml', 'pdf', 'parquet')),
  data_types TEXT[] NOT NULL,
  encrypt BOOLEAN DEFAULT false,
  sign BOOLEAN DEFAULT false,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'expired')),
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  file_path TEXT,
  file_size BIGINT,
  checksum VARCHAR(128),
  encryption_key_id VARCHAR(64),
  signature TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- 索引
CREATE INDEX idx_export_jobs_user ON data_export_jobs(user_id);
CREATE INDEX idx_export_jobs_status ON data_export_jobs(status);
CREATE INDEX idx_export_jobs_created ON data_export_jobs(created_at DESC);
CREATE INDEX idx_export_jobs_expires ON data_export_jobs(expires_at) WHERE status = 'completed';

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_export_job_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_export_job_updated_at
BEFORE UPDATE ON data_export_jobs
FOR EACH ROW
EXECUTE FUNCTION update_export_job_updated_at();

-- 注释
COMMENT ON TABLE data_export_jobs IS 'REQ-00527: 用户数据导出任务表';
COMMENT ON COLUMN data_export_jobs.user_id IS '用户ID';
COMMENT ON COLUMN data_export_jobs.format IS '导出格式（json/csv/xml/pdf/parquet）';
COMMENT ON COLUMN data_export_jobs.data_types IS '导出的数据类型列表';
COMMENT ON COLUMN data_export_jobs.encrypt IS '是否加密';
COMMENT ON COLUMN data_export_jobs.sign IS '是否签名';
COMMENT ON COLUMN data_export_jobs.status IS '任务状态';
COMMENT ON COLUMN data_export_jobs.progress IS '进度（0-100）';
COMMENT ON COLUMN data_export_jobs.file_path IS '文件路径';
COMMENT ON COLUMN data_export_jobs.file_size IS '文件大小（字节）';
COMMENT ON COLUMN data_export_jobs.checksum IS '文件校验和';
COMMENT ON COLUMN data_export_jobs.encryption_key_id IS '加密密钥ID';
COMMENT ON COLUMN data_export_jobs.signature IS '数字签名';
COMMENT ON COLUMN data_export_jobs.expires_at IS '过期时间（下载链接24小时有效）';
COMMENT ON COLUMN data_export_jobs.error_message IS '错误信息';
