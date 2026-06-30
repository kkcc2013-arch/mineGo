-- REQ-00055: 精灵收藏展示系统
-- 创建时间: 2026-06-09 20:15

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
    updated_at TIMESTAMPTZ DEFAULT NOW(),
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
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT false,
    UNIQUE(pokemon_id, user_id)
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
    last_commented_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 用户点赞限额表（每日重置）
-- ============================================================
CREATE TABLE IF NOT EXISTS user_showcase_quotas (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    likes_today INTEGER DEFAULT 0,
    comments_today INTEGER DEFAULT 0,
    last_reset_date DATE DEFAULT CURRENT_DATE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 创建索引
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_pokemon_favorites_user ON pokemon_favorites(user_id, display_order);
CREATE INDEX IF NOT EXISTS idx_pokemon_favorites_pokemon ON pokemon_favorites(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_likes_pokemon ON pokemon_likes(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_pokemon_likes_user ON pokemon_likes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_likes_created ON pokemon_likes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_comments_pokemon ON pokemon_comments(pokemon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_comments_user ON pokemon_comments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_showcase_stats_likes ON pokemon_showcase_stats(like_count DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_showcase_stats_views ON pokemon_showcase_stats(view_count DESC);
CREATE INDEX IF NOT EXISTS idx_user_showcase_quotas_reset ON user_showcase_quotas(last_reset_date);

-- ============================================================
-- 触发器：自动更新 updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_pokemon_favorites_updated_at 
    BEFORE UPDATE ON pokemon_favorites 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pokemon_comments_updated_at 
    BEFORE UPDATE ON pokemon_comments 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pokemon_showcase_stats_updated_at 
    BEFORE UPDATE ON pokemon_showcase_stats 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_showcase_quotas_updated_at 
    BEFORE UPDATE ON user_showcase_quotas 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 触发器：点赞时自动更新统计表
-- ============================================================
CREATE OR REPLACE FUNCTION update_like_count_on_insert()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO pokemon_showcase_stats (pokemon_id, like_count, last_liked_at)
    VALUES (NEW.pokemon_id, 1, NEW.created_at)
    ON CONFLICT (pokemon_id) 
    DO UPDATE SET 
        like_count = pokemon_showcase_stats.like_count + 1,
        last_liked_at = NEW.created_at;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER trigger_like_insert
    AFTER INSERT ON pokemon_likes
    FOR EACH ROW EXECUTE FUNCTION update_like_count_on_insert();

CREATE OR REPLACE FUNCTION update_like_count_on_delete()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE pokemon_showcase_stats 
    SET like_count = GREATEST(like_count - 1, 0)
    WHERE pokemon_id = OLD.pokemon_id;
    RETURN OLD;
END;
$$ language 'plpgsql';

CREATE TRIGGER trigger_like_delete
    AFTER DELETE ON pokemon_likes
    FOR EACH ROW EXECUTE FUNCTION update_like_count_on_delete();

-- ============================================================
-- 触发器：评语时自动更新统计表
-- ============================================================
CREATE OR REPLACE FUNCTION update_comment_count_on_insert()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO pokemon_showcase_stats (pokemon_id, comment_count, last_commented_at)
    VALUES (NEW.pokemon_id, 1, NEW.created_at)
    ON CONFLICT (pokemon_id) 
    DO UPDATE SET 
        comment_count = pokemon_showcase_stats.comment_count + 1,
        last_commented_at = NEW.created_at;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER trigger_comment_insert
    AFTER INSERT ON pokemon_comments
    FOR EACH ROW EXECUTE FUNCTION update_comment_count_on_insert();

CREATE OR REPLACE FUNCTION update_comment_count_on_delete()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE pokemon_showcase_stats 
    SET comment_count = GREATEST(comment_count - 1, 0)
    WHERE pokemon_id = OLD.pokemon_id;
    RETURN OLD;
END;
$$ language 'plpgsql';

CREATE TRIGGER trigger_comment_delete
    AFTER DELETE ON pokemon_comments
    FOR EACH ROW EXECUTE FUNCTION update_comment_count_on_delete();

-- ============================================================
-- 敏感词过滤函数
-- ============================================================
CREATE TABLE IF NOT EXISTS sensitive_words (
    id SERIAL PRIMARY KEY,
    word VARCHAR(100) NOT NULL UNIQUE,
    category VARCHAR(50), -- 'profanity', 'spam', 'advertisement'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 插入一些常见敏感词示例
INSERT INTO sensitive_words (word, category) VALUES
    ('fuck', 'profanity'),
    ('shit', 'profanity'),
    ('damn', 'profanity'),
    ('ass', 'profanity'),
    ('bastard', 'profanity'),
    ('bitch', 'profanity'),
    ('crap', 'profanity'),
    ('hell', 'profanity'),
    ('代练', 'advertisement'),
    ('代刷', 'advertisement'),
    ('外挂', 'advertisement'),
    ('刷钻', 'advertisement'),
    ('加微信', 'advertisement'),
    ('加QQ', 'advertisement')
ON CONFLICT (word) DO NOTHING;

CREATE OR REPLACE FUNCTION contains_sensitive_words(text_content TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    word_record RECORD;
    lower_content TEXT;
BEGIN
    lower_content := LOWER(text_content);
    
    FOR word_record IN SELECT word FROM sensitive_words LOOP
        IF POSITION(LOWER(word_record.word) IN lower_content) > 0 THEN
            RETURN TRUE;
        END IF;
    END LOOP;
    
    RETURN FALSE;
END;
$$ language 'plpgsql';

-- ============================================================
-- 排行榜物化视图（每小时刷新）
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS pokemon_showcase_leaderboard AS
SELECT 
    p.id as pokemon_id,
    p.species_id as species,
    p.power_up_count as level,
    p.is_shiny,
    (p.iv_attack + p.iv_defense + p.iv_hp) as iv_total,
    p.user_id as owner_id,
    u.nickname as owner_nickname,
    COALESCE(s.like_count, 0) as like_count,
    COALESCE(s.comment_count, 0) as comment_count,
    COALESCE(s.view_count, 0) as view_count,
    RANK() OVER (ORDER BY COALESCE(s.like_count, 0) DESC, COALESCE(s.comment_count, 0) DESC) as rank
FROM pokemon_instances p
JOIN users u ON p.user_id = u.id
LEFT JOIN pokemon_showcase_stats s ON p.id = s.pokemon_id
ORDER BY like_count DESC, comment_count DESC
LIMIT 100;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_rank ON pokemon_showcase_leaderboard(rank);

-- 创建刷新索引
CREATE INDEX IF NOT EXISTS idx_leaderboard_pokemon ON pokemon_showcase_leaderboard(pokemon_id);

-- ============================================================
-- 插入测试数据
-- ============================================================
-- 创建测试用户的收藏精灵
-- INSERT INTO pokemon_favorites (pokemon_id, user_id, display_order)
-- SELECT id, user_id, 0 FROM pokemon_instances LIMIT 1;

COMMENT ON TABLE pokemon_favorites IS '精灵收藏表 - 玩家标记的收藏精灵';
COMMENT ON TABLE pokemon_likes IS '精灵点赞表 - 玩家对精灵的点赞记录';
COMMENT ON TABLE pokemon_comments IS '精灵评语表 - 玩家对精灵的评语';
COMMENT ON TABLE pokemon_showcase_stats IS '精灵展示统计表 - 点赞、评语、浏览数统计';
COMMENT ON TABLE user_showcase_quotas IS '用户点赞评语限额表 - 每日限额管理';
