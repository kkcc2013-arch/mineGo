-- ============================================================
-- REQ-00129: 精灵数据备份与恢复系统
-- Migration: 20260614_070300__add_pokemon_backup_system.sql
-- ============================================================

-- 备份元数据表
CREATE TABLE IF NOT EXISTS pokemon_backup_metadata (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    backup_type VARCHAR(20) NOT NULL CHECK (backup_type IN ('manual', 'auto_daily', 'auto_weekly', 'migration')),
    backup_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (backup_status IN ('pending', 'completed', 'failed', 'expired')),
    backup_size_bytes BIGINT,
    pokemon_count INTEGER DEFAULT 0,
    storage_path VARCHAR(500),
    checksum VARCHAR(64),
    encryption_key_id VARCHAR(100),
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_backup_user_time ON pokemon_backup_metadata(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_status ON pokemon_backup_metadata(backup_status, created_at);
CREATE INDEX IF NOT EXISTS idx_backup_expires ON pokemon_backup_metadata(expires_at) WHERE backup_status = 'completed';

COMMENT ON TABLE pokemon_backup_metadata IS '精灵数据备份元数据表';
COMMENT ON COLUMN pokemon_backup_metadata.backup_type IS '备份类型：manual(手动), auto_daily(每日自动), auto_weekly(每周自动), migration(迁移导出)';
COMMENT ON COLUMN pokemon_backup_metadata.backup_status IS '备份状态：pending(处理中), completed(完成), failed(失败), expired(已过期)';
COMMENT ON COLUMN pokemon_backup_metadata.storage_path IS '存储路径（S3或本地路径）';
COMMENT ON COLUMN pokemon_backup_metadata.checksum IS 'SHA256校验和';

-- 备份内容表（存储序列化数据，用于快速恢复）
CREATE TABLE IF NOT EXISTS pokemon_backup_contents (
    id SERIAL PRIMARY KEY,
    backup_id INTEGER NOT NULL REFERENCES pokemon_backup_metadata(id) ON DELETE CASCADE,
    pokemon_instance_id INTEGER NOT NULL,
    pokemon_data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_backup_contents_backup ON pokemon_backup_contents(backup_id);
CREATE INDEX IF NOT EXISTS idx_backup_contents_pokemon ON pokemon_backup_contents(pokemon_instance_id);

COMMENT ON TABLE pokemon_backup_contents IS '备份内容表：存储精灵实例的完整数据快照';
COMMENT ON COLUMN pokemon_backup_contents.pokemon_data IS '精灵完整数据JSON（包含属性、技能等）';

-- 恢复记录表
CREATE TABLE IF NOT EXISTS pokemon_restore_records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    backup_id INTEGER REFERENCES pokemon_backup_metadata(id) ON DELETE SET NULL,
    restore_type VARCHAR(20) NOT NULL CHECK (restore_type IN ('full', 'partial', 'point_in_time')),
    restore_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (restore_status IN ('pending', 'processing', 'completed', 'failed')),
    restore_mode VARCHAR(20) DEFAULT 'merge' CHECK (restore_mode IN ('merge', 'replace', 'append')),
    restored_pokemon_count INTEGER DEFAULT 0,
    skipped_pokemon_count INTEGER DEFAULT 0,
    conflicts_resolved INTEGER DEFAULT 0,
    restore_log TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_restore_user_time ON pokemon_restore_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_restore_status ON pokemon_restore_records(restore_status);

COMMENT ON TABLE pokemon_restore_records IS '精灵数据恢复记录表';
COMMENT ON COLUMN pokemon_restore_records.restore_type IS '恢复类型：full(全量), partial(部分), point_in_time(时间点)';
COMMENT ON COLUMN pokemon_restore_records.restore_mode IS '恢复模式：merge(合并), replace(替换), append(追加)';

-- 备份配额表
CREATE TABLE IF NOT EXISTS user_backup_quotas (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_manual_backups INTEGER DEFAULT 5,
    current_manual_backups INTEGER DEFAULT 0,
    max_storage_bytes BIGINT DEFAULT 104857600, -- 100MB
    current_storage_bytes BIGINT DEFAULT 0,
    last_backup_at TIMESTAMP,
    last_restore_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE user_backup_quotas IS '用户备份配额表';
COMMENT ON COLUMN user_backup_quotas.max_manual_backups IS '最大手动备份数量';
COMMENT ON COLUMN user_backup_quotas.max_storage_bytes IS '最大存储空间（字节）';

-- 自动备份配置表
CREATE TABLE IF NOT EXISTS user_auto_backup_config (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN DEFAULT false,
    schedule VARCHAR(20) DEFAULT 'daily' CHECK (schedule IN ('daily', 'weekly')),
    include_items BOOLEAN DEFAULT true,
    include_achievements BOOLEAN DEFAULT true,
    last_run_at TIMESTAMP,
    next_run_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE user_auto_backup_config IS '用户自动备份配置表';

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_backup_quota_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER trigger_backup_quota_updated_at 
    BEFORE UPDATE ON user_backup_quotas
    FOR EACH ROW EXECUTE FUNCTION update_backup_quota_updated_at();

CREATE TRIGGER trigger_auto_backup_config_updated_at 
    BEFORE UPDATE ON user_auto_backup_config
    FOR EACH ROW EXECUTE FUNCTION update_backup_quota_updated_at();

-- 初始化用户配额（可选：为新用户自动创建配额记录）
-- 这里不自动创建，而是在首次备份时创建

-- 统计视图：备份统计
CREATE OR REPLACE VIEW backup_statistics AS
SELECT 
    backup_type,
    backup_status,
    COUNT(*) as backup_count,
    AVG(backup_size_bytes) as avg_size_bytes,
    AVG(pokemon_count) as avg_pokemon_count,
    SUM(backup_size_bytes) as total_size_bytes
FROM pokemon_backup_metadata
GROUP BY backup_type, backup_status;

COMMENT ON VIEW backup_statistics IS '备份统计视图';
