-- REQ-00048: 精灵好友系统与社交互动增强
-- 数据库迁移文件
-- 创建时间: 2026-06-09 13:00

-- ============================================
-- 1. 好友关系表
-- ============================================
CREATE TABLE IF NOT EXISTS friends (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    friend_user_id VARCHAR(36) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, accepted, blocked
    friendship_level INTEGER DEFAULT 1, -- 友情等级 1-5
    friendship_points INTEGER DEFAULT 0, -- 友情点数
    last_interaction_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_friends_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_friends_friend FOREIGN KEY (friend_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT uq_friends_pair UNIQUE(user_id, friend_user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_user_id);
CREATE INDEX IF NOT EXISTS idx_friends_status ON friends(status);
CREATE INDEX IF NOT EXISTS idx_friends_level ON friends(friendship_level);

COMMENT ON TABLE friends IS '好友关系表 - 双向存储';
COMMENT ON COLUMN friends.status IS '好友状态: pending-待确认, accepted-已接受, blocked-已屏蔽';
COMMENT ON COLUMN friends.friendship_level IS '友情等级 1-5，影响交易加成等';

-- ============================================
-- 2. 好友请求表
-- ============================================
CREATE TABLE IF NOT EXISTS friend_requests (
    id SERIAL PRIMARY KEY,
    from_user_id VARCHAR(36) NOT NULL,
    to_user_id VARCHAR(36) NOT NULL,
    message TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- pending, accepted, rejected, expired
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_friend_requests_from FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_friend_requests_to FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT uq_friend_requests_pair UNIQUE(from_user_id, to_user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_status ON friend_requests(status);
CREATE INDEX IF NOT EXISTS idx_friend_requests_expires ON friend_requests(expires_at);

COMMENT ON TABLE friend_requests IS '好友请求表';

-- ============================================
-- 3. 好友互动记录表
-- ============================================
CREATE TABLE IF NOT EXISTS friend_interactions (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    friend_user_id VARCHAR(36) NOT NULL,
    interaction_type VARCHAR(50) NOT NULL, -- gift_item, gift_candy, raid_together, battle_together, trade
    metadata JSONB, -- 互动详情
    friendship_points_earned INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_friend_interactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_friend_interactions_friend FOREIGN KEY (friend_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_friend_interactions_user ON friend_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_friend_interactions_friend ON friend_interactions(friend_user_id);
CREATE INDEX IF NOT EXISTS idx_friend_interactions_type ON friend_interactions(interaction_type);
CREATE INDEX IF NOT EXISTS idx_friend_interactions_time ON friend_interactions(created_at DESC);

COMMENT ON TABLE friend_interactions IS '好友互动记录表';

-- ============================================
-- 4. 好友礼物表
-- ============================================
CREATE TABLE IF NOT EXISTS friend_gifts (
    id SERIAL PRIMARY KEY,
    from_user_id VARCHAR(36) NOT NULL,
    to_user_id VARCHAR(36) NOT NULL,
    gift_type VARCHAR(50) NOT NULL, -- item, candy, stardust
    gift_id VARCHAR(36), -- 道具ID或精灵种类ID
    gift_name VARCHAR(100), -- 礼物名称（冗余，方便展示）
    quantity INTEGER DEFAULT 1,
    status VARCHAR(20) DEFAULT 'pending', -- pending, claimed, expired, rejected
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
    claimed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_friend_gifts_from FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_friend_gifts_to FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_friend_gifts_to ON friend_gifts(to_user_id);
CREATE INDEX IF NOT EXISTS idx_friend_gifts_from ON friend_gifts(from_user_id);
CREATE INDEX IF NOT EXISTS idx_friend_gifts_status ON friend_gifts(status);
CREATE INDEX IF NOT EXISTS idx_friend_gifts_expires ON friend_gifts(expires_at);

COMMENT ON TABLE friend_gifts IS '好友礼物表';

-- ============================================
-- 5. 用户好友码字段
-- ============================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_code VARCHAR(12) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- 为现有用户生成好友码
UPDATE users SET friend_code = UPPER(SUBSTRING(id::text, 1, 8)) WHERE friend_code IS NULL;

-- ============================================
-- 6. 好友统计视图
-- ============================================
CREATE OR REPLACE VIEW v_friend_stats AS
SELECT 
    f.user_id,
    COUNT(*) FILTER (WHERE f.status = 'accepted') AS friend_count,
    COUNT(*) FILTER (WHERE f.status = 'pending') AS pending_sent_count,
    AVG(f.friendship_level) FILTER (WHERE f.status = 'accepted') AS avg_friendship_level,
    SUM(f.friendship_points) FILTER (WHERE f.status = 'accepted') AS total_friendship_points,
    MAX(f.last_interaction_at) AS last_friend_interaction
FROM friends f
GROUP BY f.user_id;

COMMENT ON VIEW v_friend_stats IS '好友统计视图';

-- ============================================
-- 7. 好友排行榜物化视图
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_friend_leaderboard AS
SELECT 
    u.id AS user_id,
    u.username,
    u.avatar_url,
    u.level,
    COALESCE(stats.friend_count, 0) AS friend_count,
    COALESCE(stats.total_friendship_points, 0) AS total_friendship_points,
    stats.last_friend_interaction AS last_active,
    CURRENT_TIMESTAMP AS updated_at
FROM users u
LEFT JOIN v_friend_stats stats ON stats.user_id = u.id
WHERE u.id IN (SELECT DISTINCT user_id FROM friends WHERE status = 'accepted');

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_leaderboard_user ON mv_friend_leaderboard(user_id);
CREATE INDEX IF NOT EXISTS idx_mv_leaderboard_friends ON mv_friend_leaderboard(friend_count DESC);
CREATE INDEX IF NOT EXISTS idx_mv_leaderboard_points ON mv_friend_leaderboard(total_friendship_points DESC);

COMMENT ON MATERIALIZED VIEW mv_friend_leaderboard IS '好友排行榜物化视图 - 每小时刷新';

-- ============================================
-- 8. 触发器：自动更新 updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_friends_updated_at
    BEFORE UPDATE ON friends
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_friend_requests_updated_at
    BEFORE UPDATE ON friend_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 9. 清理过期请求的函数
-- ============================================
CREATE OR REPLACE FUNCTION cleanup_expired_friend_requests()
RETURNS void AS $$
BEGIN
    -- 更新过期的好友请求状态
    UPDATE friend_requests
    SET status = 'expired', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'pending' AND expires_at < CURRENT_TIMESTAMP;
    
    -- 更新过期的礼物状态
    UPDATE friend_gifts
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 10. 刷新排行榜的函数
-- ============================================
CREATE OR REPLACE FUNCTION refresh_friend_leaderboard()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_friend_leaderboard;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 11. 插入测试数据（可选）
-- ============================================
-- 注意：测试数据仅在开发环境使用

-- ============================================
-- 回滚脚本
-- ============================================
-- DROP MATERIALIZED VIEW IF EXISTS mv_friend_leaderboard;
-- DROP VIEW IF EXISTS v_friend_stats;
-- DROP TABLE IF EXISTS friend_gifts;
-- DROP TABLE IF EXISTS friend_interactions;
-- DROP TABLE IF EXISTS friend_requests;
-- DROP TABLE IF EXISTS friends;
-- ALTER TABLE users DROP COLUMN IF EXISTS friend_code;
-- ALTER TABLE users DROP COLUMN IF EXISTS last_active_at;
