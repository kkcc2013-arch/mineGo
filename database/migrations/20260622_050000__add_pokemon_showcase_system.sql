-- REQ-00055: 精灵收藏展示系统 - 数据库迁移
-- 创建时间: 2026-06-22

-- ============================================================
-- 精灵收藏表
-- ============================================================

CREATE TABLE IF NOT EXISTS pokemon_favorites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_order INTEGER DEFAULT 0 CHECK (display_order >= 0 AND display_order < 6),
    is_showcased BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, display_order),
    UNIQUE(user_id, pokemon_id)
);

-- ============================================================
-- 精灵点赞表
-- ============================================================

CREATE TABLE IF NOT EXISTS pokemon_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pokemon_id, user_id)
);

-- ============================================================
-- 精灵评语表
-- ============================================================

CREATE TABLE IF NOT EXISTS pokemon_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment TEXT NOT NULL CHECK (char_length(comment) >= 1 AND char_length(comment) <= 200),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 精灵展示统计表
-- ============================================================

CREATE TABLE IF NOT EXISTS pokemon_showcase_stats (
    pokemon_id UUID PRIMARY KEY REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    last_liked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 用户点赞限额表（每日重置）
-- ============================================================

CREATE TABLE IF NOT EXISTS user_like_quotas (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    likes_today INTEGER DEFAULT 0,
    comments_today INTEGER DEFAULT 0,
    last_reset_date DATE DEFAULT CURRENT_DATE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 创建索引
-- ============================================================

-- 收藏表索引
CREATE INDEX IF NOT EXISTS idx_pokemon_favorites_user ON pokemon_favorites(user_id, display_order);
CREATE INDEX IF NOT EXISTS idx_pokemon_favorites_pokemon ON pokemon_favorites(pokemon_id);

-- 点赞表索引
CREATE INDEX IF NOT EXISTS idx_pokemon_likes_pokemon ON pokemon_likes(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_likes_user ON pokemon_likes(user_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_likes_created ON pokemon_likes(created_at DESC);

-- 评语表索引
CREATE INDEX IF NOT EXISTS idx_pokemon_comments_pokemon ON pokemon_comments(pokemon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_comments_user ON pokemon_comments(user_id);

-- 展示统计表索引
CREATE INDEX IF NOT EXISTS idx_pokemon_showcase_stats_likes ON pokemon_showcase_stats(like_count DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_showcase_stats_views ON pokemon_showcase_stats(view_count DESC);

-- ============================================================
-- 注释
-- ============================================================

COMMENT ON TABLE pokemon_favorites IS 'REQ-00055: 精灵收藏表 - 存储用户收藏的精灵';
COMMENT ON TABLE pokemon_likes IS 'REQ-00055: 精灵点赞表 - 记录点赞信息';
COMMENT ON TABLE pokemon_comments IS 'REQ-00055: 精灵评语表 - 存储用户评语';
COMMENT ON TABLE pokemon_showcase_stats IS 'REQ-00055: 精灵展示统计表 - 统计点赞/评语/浏览数';
COMMENT ON TABLE user_like_quotas IS 'REQ-00055: 用户点赞限额表 - 每日限额管理';

-- ============================================================
-- 触发器：自动更新 updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_pokemon_comments_updated_at
    BEFORE UPDATE ON pokemon_comments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pokemon_showcase_stats_updated_at
    BEFORE UPDATE ON pokemon_showcase_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_like_quotas_updated_at
    BEFORE UPDATE ON user_like_quotas
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
