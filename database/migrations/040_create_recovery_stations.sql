-- REQ-00156: 精灵恢复站系统
-- 创建恢复站相关表

-- 恢复站表
CREATE TABLE IF NOT EXISTS recovery_stations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'normal' CHECK (type IN ('normal', 'advanced', 'premium', 'event')),
    level INT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
    
    -- 恢复配置
    recovery_speed_multiplier DECIMAL(3,2) DEFAULT 1.0,
    bonus_effects JSONB DEFAULT '{}',
    daily_usage_limit INT DEFAULT 0,
    
    -- 状态
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance')),
    last_maintenance_at TIMESTAMPTZ,
    
    -- 元数据
    photo_url VARCHAR(500),
    rating DECIMAL(3,2) DEFAULT 0.0,
    total_check_ins INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 恢复站签到记录表
CREATE TABLE IF NOT EXISTS recovery_check_ins (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id),
    station_id INT NOT NULL REFERENCES recovery_stations(id),
    
    -- 恢复详情
    pokemon_recovered INT DEFAULT 0,
    hp_recovered INT DEFAULT 0,
    pp_recovered INT DEFAULT 0,
    status_healed JSONB DEFAULT '{}',
    
    -- 奖励
    bonus_items JSONB DEFAULT '[]',
    bonus_experience INT DEFAULT 0,
    
    -- 时间
    checked_in_at TIMESTAMPTZ DEFAULT NOW(),
    recovery_duration_seconds INT
);

-- 恢复站照片表
CREATE TABLE IF NOT EXISTS recovery_station_photos (
    id SERIAL PRIMARY KEY,
    station_id INT NOT NULL REFERENCES recovery_stations(id),
    user_id INT NOT NULL REFERENCES users(id),
    photo_url VARCHAR(500) NOT NULL,
    description TEXT,
    
    -- 审核状态
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by INT REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    
    -- 统计
    likes_count INT DEFAULT 0,
    reports_count INT DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 恢复站评论表
CREATE TABLE IF NOT EXISTS recovery_station_reviews (
    id SERIAL PRIMARY KEY,
    station_id INT NOT NULL REFERENCES recovery_stations(id),
    user_id INT NOT NULL REFERENCES users(id),
    rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    content TEXT,
    
    -- 审核状态
    status VARCHAR(20) DEFAULT 'active',
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE (station_id, user_id)
);

-- 用户恢复站收藏表
CREATE TABLE IF NOT EXISTS user_favorites_recovery_stations (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id),
    station_id INT NOT NULL REFERENCES recovery_stations(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE (user_id, station_id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_recovery_stations_location ON recovery_stations USING GIST(location);
CREATE INDEX IF NOT EXISTS idx_recovery_stations_type ON recovery_stations(type);
CREATE INDEX IF NOT EXISTS idx_recovery_stations_status ON recovery_stations(status);
CREATE INDEX IF NOT EXISTS idx_recovery_check_ins_user ON recovery_check_ins(user_id);
CREATE INDEX IF NOT EXISTS idx_recovery_check_ins_station ON recovery_check_ins(station_id);
CREATE INDEX IF NOT EXISTS idx_recovery_check_ins_time ON recovery_check_ins(checked_in_at);
CREATE INDEX IF NOT EXISTS idx_recovery_station_photos_station ON recovery_station_photos(station_id);
CREATE INDEX IF NOT EXISTS idx_recovery_station_reviews_station ON recovery_station_reviews(station_id);

-- 插入示例恢复站数据
INSERT INTO recovery_stations (name, description, location, type, level, recovery_speed_multiplier, bonus_effects, status) VALUES
('中央公园恢复站', '位于市中心公园的恢复站，环境优美', ST_SetSRID(ST_MakePoint(116.4074, 39.9042), 4326)::geography, 'normal', 1, 1.0, '{}', 'active'),
('商业区高级恢复站', '繁华商圈的高级恢复站，恢复速度更快', ST_SetSRID(ST_MakePoint(116.4100, 39.9000), 4326)::geography, 'advanced', 2, 1.5, '{"bonus_item_chance": 0.3}', 'active'),
('会员专属恢复站', 'VIP会员专属，全属性加成', ST_SetSRID(ST_MakePoint(116.4200, 39.9100), 4326)::geography, 'premium', 3, 2.0, '{"bonus_item_chance": 0.5, "xp_bonus": 1.5}', 'active')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE recovery_stations IS '精灵恢复站信息表';
COMMENT ON TABLE recovery_check_ins IS '恢复站签到记录表';
COMMENT ON TABLE recovery_station_photos IS '恢复站照片表';
COMMENT ON TABLE recovery_station_reviews IS '恢复站评论表';
COMMENT ON TABLE user_favorites_recovery_stations IS '用户恢复站收藏表';
