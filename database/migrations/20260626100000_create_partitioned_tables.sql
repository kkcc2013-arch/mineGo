-- database/migrations/20260626100000_create_partitioned_tables.sql
-- 数据库分区表创建脚本
-- REQ-00323: 数据库分区表与大数据量表分区策略

-- 捕捉记录分区表
CREATE TABLE IF NOT EXISTS catch_records_partitioned (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    pokemon_id UUID NOT NULL,
    species_id INTEGER NOT NULL,
    location_id UUID,
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    catch_method VARCHAR(50),
    ball_used VARCHAR(50),
    success BOOLEAN DEFAULT true,
    escaped BOOLEAN DEFAULT false,
    experience_gained INTEGER DEFAULT 0,
    bonus_multiplier DECIMAL(4, 2) DEFAULT 1.0,
    weather VARCHAR(50),
    time_of_day VARCHAR(20),
    device_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 战斗日志分区表
CREATE TABLE IF NOT EXISTS battle_logs_partitioned (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    battle_id UUID NOT NULL,
    battle_type VARCHAR(50) NOT NULL,
    attacker_id UUID NOT NULL,
    defender_id UUID NOT NULL,
    attacker_pokemon_id UUID NOT NULL,
    defender_pokemon_id UUID NOT NULL,
    skill_id INTEGER,
    damage_dealt INTEGER,
    damage_blocked INTEGER,
    critical_hit BOOLEAN DEFAULT false,
    status_effect VARCHAR(50),
    round_number INTEGER,
    battle_time TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, battle_time)
) PARTITION BY RANGE (battle_time);

-- 用户活动记录分区表
CREATE TABLE IF NOT EXISTS user_activities_partitioned (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    activity_type VARCHAR(100) NOT NULL,
    activity_data JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    device_id VARCHAR(100),
    location_lat DECIMAL(10, 8),
    location_lng DECIMAL(11, 8),
    activity_time TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, activity_time)
) PARTITION BY RANGE (activity_time);

-- 精灵位置历史分区表
CREATE TABLE IF NOT EXISTS pokemon_location_history_partitioned (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    spawn_point_id UUID NOT NULL,
    species_id INTEGER NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    altitude DECIMAL(8, 2),
    accuracy_radius DECIMAL(6, 2),
    spawn_type VARCHAR(50),
    weather VARCHAR(50),
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL,
    despawn_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- 审计日志分区表
CREATE TABLE IF NOT EXISTS audit_logs_partitioned (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    user_id UUID,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(255),
    old_values JSONB,
    new_values JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    session_id VARCHAR(255),
    status VARCHAR(20) DEFAULT 'success',
    error_message TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 通知分区表
CREATE TABLE IF NOT EXISTS notifications_partitioned (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    notification_type VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT,
    data JSONB,
    priority INTEGER DEFAULT 0,
    read_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE catch_records_partitioned IS '捕捉记录分区表 - 按月分区';
COMMENT ON TABLE battle_logs_partitioned IS '战斗日志分区表 - 按月分区';
COMMENT ON TABLE user_activities_partitioned IS '用户活动记录分区表 - 按月分区';
COMMENT ON TABLE pokemon_location_history_partitioned IS '精灵位置历史分区表 - 按月分区';
COMMENT ON TABLE audit_logs_partitioned IS '审计日志分区表 - 按月分区';
COMMENT ON TABLE notifications_partitioned IS '通知分区表 - 按月分区';