-- REQ-00048: 精灵好友系统与社交互动增强
-- 增强好友系统数据库结构

-- 好友请求表
CREATE TABLE IF NOT EXISTS friend_requests (
    id SERIAL PRIMARY KEY,
    from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, accepted, rejected, expired
    expires_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_user_id, to_user_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id, status);

-- 修改 friendships 表添加友情点数和等级
ALTER TABLE friendships 
ADD COLUMN IF NOT EXISTS friendship_points INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS friendship_level INTEGER DEFAULT 1 CHECK (friendship_level BETWEEN 1 AND 5),
ADD COLUMN IF NOT EXISTS gift_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS raid_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS trade_count INTEGER DEFAULT 0;

-- 好友互动记录表
CREATE TABLE IF NOT EXISTS friend_interactions (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interaction_type VARCHAR(50) NOT NULL, -- gift_item, gift_candy, raid_together, battle_together, trade, exchange_gift
    metadata JSONB DEFAULT '{}', -- 互动详情
    friendship_points_earned INTEGER DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_friend_interactions_user_friend ON friend_interactions(user_id, friend_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_friend_interactions_type ON friend_interactions(interaction_type);

-- 增强 friend_gifts 表
ALTER TABLE friend_gifts
ADD COLUMN IF NOT EXISTS gift_type VARCHAR(50) DEFAULT 'postcard', -- postcard, item, candy, stardust
ADD COLUMN IF NOT EXISTS gift_id VARCHAR(36), -- 道具ID或精灵ID
ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
ADD COLUMN IF NOT EXISTS friendship_points INTEGER DEFAULT 10;

-- 好友排行榜物化视图（刷新策略：每小时）
CREATE MATERIALIZED VIEW IF NOT EXISTS friend_leaderboard_mv AS
SELECT 
    u.id AS user_id,
    u.username,
    u.avatar_url,
    u.level,
    COUNT(DISTINCT CASE WHEN f.user_a = u.id THEN f.user_b ELSE f.user_a END) AS friend_count,
    COALESCE(SUM(f.friendship_points), 0) AS total_friendship_points,
    COALESCE(SUM(f.friendship_level), 0) AS avg_friendship_level,
    MAX(f.last_interaction_at) AS last_interaction,
    CURRENT_TIMESTAMP AS updated_at
FROM users u
LEFT JOIN friendships f ON (f.user_a = u.id OR f.user_b = u.id)
GROUP BY u.id, u.username, u.avatar_url, u.level;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_mv_user ON friend_leaderboard_mv(user_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_mv_points ON friend_leaderboard_mv(total_friendship_points DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_mv_friends ON friend_leaderboard_mv(friend_count DESC);

-- 用户好友码字段
ALTER TABLE users
ADD COLUMN IF NOT EXISTS friend_code VARCHAR(12) UNIQUE;

-- 为现有用户生成好友码（基于用户ID的前12位）
UPDATE users 
SET friend_code = UPPER(SUBSTRING(REPLACE(id::text, '-', ''), 1, 12))
WHERE friend_code IS NULL;

-- 用户在线状态追踪表
CREATE TABLE IF NOT EXISTS user_online_status (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'offline', -- online, away, offline
    last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    current_location_lat DECIMAL(10, 8),
    current_location_lng DECIMAL(11, 8),
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_online_status_time ON user_online_status(last_active_at DESC);

-- 好友系统配置表
CREATE TABLE IF NOT EXISTS friend_system_config (
    key VARCHAR(50) PRIMARY KEY,
    value INTEGER NOT NULL,
    description TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 插入默认配置
INSERT INTO friend_system_config (key, value, description) VALUES
('max_friends', 400, '最大好友数量'),
('max_pending_requests', 50, '最大待处理好友请求数'),
('max_daily_gifts', 50, '每日最大礼物发送数量'),
('request_expire_days', 7, '好友请求过期天数'),
('gift_expire_days', 30, '礼物过期天数'),
('online_threshold_minutes', 5, '在线状态判定阈值（分钟）'),
('away_threshold_minutes', 60, '离开状态判定阈值（分钟）')
ON CONFLICT (key) DO NOTHING;

-- 友情等级阈值配置
CREATE TABLE IF NOT EXISTS friendship_level_thresholds (
    level INTEGER PRIMARY KEY CHECK (level BETWEEN 1 AND 5),
    min_points INTEGER NOT NULL,
    label VARCHAR(20) NOT NULL, -- Good, Great, Ultra, Best, Lucky
    rewards JSONB DEFAULT '{}'
);

INSERT INTO friendship_level_thresholds (level, min_points, label, rewards) VALUES
(1, 0, 'Good', '{"gift_unlock": true}'::jsonb),
(2, 100, 'Great', '{"gift_unlock": true, "raid_bonus": 10}'::jsonb),
(3, 500, 'Ultra', '{"gift_unlock": true, "raid_bonus": 20, "trade_discount": 10}'::jsonb),
(4, 1000, 'Best', '{"gift_unlock": true, "raid_bonus": 30, "trade_discount": 20, "lucky_chance": 5}'::jsonb),
(5, 2000, 'Lucky', '{"gift_unlock": true, "raid_bonus": 50, "trade_discount": 50, "lucky_chance": 100}'::jsonb)
ON CONFLICT (level) DO NOTHING;

-- 添加触发器：自动更新好友请求过期状态
CREATE OR REPLACE FUNCTION update_expired_friend_requests()
RETURNS void AS $$
BEGIN
    UPDATE friend_requests 
    SET status = 'expired', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'pending' AND expires_at < CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- 添加触发器：自动更新友情等级
CREATE OR REPLACE FUNCTION update_friendship_level()
RETURNS trigger AS $$
DECLARE
    new_level INTEGER;
BEGIN
    -- 根据积分计算等级
    SELECT level INTO new_level
    FROM friendship_level_thresholds
    WHERE min_points <= NEW.friendship_points
    ORDER BY min_points DESC
    LIMIT 1;
    
    IF new_level IS NULL THEN
        new_level := 1;
    END IF;
    
    NEW.friendship_level := new_level;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS friendship_level_trigger ON friendships;
CREATE TRIGGER friendship_level_trigger
BEFORE UPDATE OF friendship_points ON friendships
FOR EACH ROW
EXECUTE FUNCTION update_friendship_level();

-- 注释
COMMENT ON TABLE friend_requests IS '好友请求记录表';
COMMENT ON TABLE friend_interactions IS '好友互动记录表';
COMMENT ON TABLE user_online_status IS '用户在线状态追踪表';
COMMENT ON COLUMN friendships.friendship_points IS '友情点数累计';
COMMENT ON COLUMN friendships.friendship_level IS '友情等级（1-5级）';
COMMENT ON COLUMN users.friend_code IS '用户唯一好友码（12位字母数字）';