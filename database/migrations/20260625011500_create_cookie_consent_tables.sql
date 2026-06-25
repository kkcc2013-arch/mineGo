-- Cookie 同意管理数据库迁移
-- REQ-00322: Cookie 同意管理与隐私偏好中心

-- Cookie 同意记录表
CREATE TABLE IF NOT EXISTS cookie_consents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(255),  -- 匿名用户设备标识
    consent_version VARCHAR(20) NOT NULL DEFAULT '1.0',
    
    -- 同意状态（JSON 格式）
    categories JSONB NOT NULL DEFAULT '{}',
    
    -- 元数据
    ip_address VARCHAR(45),
    user_agent TEXT,
    country_code VARCHAR(3),
    
    -- 时间戳
    consented_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE,
    
    -- 来源
    source VARCHAR(20) DEFAULT 'banner',
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cookie_consents_user ON cookie_consents(user_id, consented_at DESC);
CREATE INDEX idx_cookie_consents_device ON cookie_consents(device_id, consented_at DESC);
CREATE INDEX idx_cookie_consents_expires ON cookie_consents(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE cookie_consents IS 'Cookie 同意记录表 - GDPR/CCPA 合规';

-- 同意历史审计表
CREATE TABLE IF NOT EXISTS cookie_consent_audit_logs (
    id SERIAL PRIMARY KEY,
    consent_id INTEGER REFERENCES cookie_consents(id) ON DELETE CASCADE,
    user_id INTEGER,
    device_id VARCHAR(255),
    action VARCHAR(20) NOT NULL,  -- created, updated, withdrawn
    previous_categories JSONB,
    new_categories JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_consent_audit_consent ON cookie_consent_audit_logs(consent_id, created_at DESC);
CREATE INDEX idx_consent_audit_user ON cookie_consent_audit_logs(user_id, created_at DESC);

COMMENT ON TABLE cookie_consent_audit_logs IS 'Cookie 同意变更审计日志';

-- Cookie 定义表（管理后台配置）
CREATE TABLE IF NOT EXISTS cookie_definitions (
    id SERIAL PRIMARY KEY,
    category VARCHAR(20) NOT NULL,  -- necessary, functional, analytics, marketing, social
    name VARCHAR(100) NOT NULL,
    provider VARCHAR(100),
    description TEXT NOT NULL,
    purpose TEXT,
    duration VARCHAR(50),  -- session, 1 year, persistent
    third_party BOOLEAN DEFAULT false,
    script_url TEXT,
    script_type VARCHAR(20),  -- inline, external
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category, name)
);

CREATE INDEX idx_cookie_definitions_category ON cookie_definitions(category, is_active);

COMMENT ON TABLE cookie_definitions IS 'Cookie 定义表 - 用于管理后台展示';

-- 隐私偏好表
CREATE TABLE IF NOT EXISTS privacy_preferences (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    allow_personalization BOOLEAN DEFAULT true,
    allow_third_party_sharing BOOLEAN DEFAULT false,
    allow_analytics BOOLEAN DEFAULT true,
    allow_marketing BOOLEAN DEFAULT false,
    allow_email_notifications BOOLEAN DEFAULT true,
    allow_push_notifications BOOLEAN DEFAULT true,
    allow_in_game_messages BOOLEAN DEFAULT true,
    data_retention_preference VARCHAR(20) DEFAULT 'standard',  -- minimal, standard, extended
    do_not_track BOOLEAN DEFAULT false,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE privacy_preferences IS '用户隐私偏好设置';

-- 初始化 Cookie 定义
INSERT INTO cookie_definitions (category, name, provider, description, purpose, duration, third_party, script_url, script_type) VALUES
-- 必要 Cookie
('necessary', 'session_token', 'mineGo', '用户会话认证令牌', '保持用户登录状态', 'session', false, NULL, NULL),
('necessary', 'csrf_token', 'mineGo', '跨站请求伪造防护令牌', '安全防护', 'session', false, NULL, NULL),
('necessary', 'preferences', 'mineGo', '用户偏好设置', '记住用户设置', '1 year', false, NULL, NULL),
('necessary', 'cookie_consent', 'mineGo', 'Cookie 同意状态', '记录用户同意', '1 year', false, NULL, NULL),

-- 功能性 Cookie
('functional', 'language', 'mineGo', '语言偏好', '记住用户语言选择', '1 year', false, NULL, NULL),
('functional', 'theme', 'mineGo', '主题偏好', '记住用户主题选择', '1 year', false, NULL, NULL),
('functional', 'game_settings', 'mineGo', '游戏设置', '游戏音量、画质等设置', '1 year', false, NULL, NULL),

-- 分析 Cookie
('analytics', '_ga', 'Google Analytics', 'Google Analytics 主 Cookie', '区分用户', '2 years', true, 'https://www.googletagmanager.com/gtag/js', 'external'),
('analytics', '_gid', 'Google Analytics', 'Google Analytics 用户 ID', '区分用户', '24 hours', true, NULL, NULL),
('analytics', 'matomo_id', 'Matomo', 'Matomo 分析 Cookie', '用户追踪', '13 months', true, 'https://analytics.example.com/matomo.js', 'external'),

-- 营销 Cookie
('marketing', '_fbp', 'Facebook', 'Facebook Pixel', '广告追踪', '3 months', true, 'https://connect.facebook.net/en_US/fbevents.js', 'external'),
('marketing', 'ads_prefs', 'mineGo', '广告偏好', '个性化广告', '1 year', true, NULL, NULL),

-- 社交 Cookie
('social', 'twitter_widget', 'Twitter', 'Twitter 嵌入组件', '社交分享', 'session', true, 'https://platform.twitter.com/widgets.js', 'external'),
('social', 'discord_widget', 'Discord', 'Discord 嵌入组件', '社交集成', 'session', true, 'https://discord.com/widget.js', 'external')
ON CONFLICT (category, name) DO NOTHING;

-- 创建视图：活跃 Cookie 统计
CREATE OR REPLACE VIEW cookie_consent_stats AS
SELECT 
    DATE_TRUNC('day', consented_at) as date,
    source,
    COUNT(*) as total_consents,
    COUNT(*) FILTER (WHERE categories->>'analytics' = 'true') as analytics_accepted,
    COUNT(*) FILTER (WHERE categories->>'marketing' = 'true') as marketing_accepted,
    COUNT(*) FILTER (WHERE categories->>'functional' = 'true') as functional_accepted,
    COUNT(*) FILTER (WHERE categories->>'social' = 'true') as social_accepted
FROM cookie_consents
WHERE consented_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', consented_at), source
ORDER BY date DESC;

COMMENT ON VIEW cookie_consent_stats IS 'Cookie 同意统计视图 - 按日统计各类别同意率';

-- 函数：清理过期同意记录
CREATE OR REPLACE FUNCTION cleanup_expired_consents()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM cookie_consents
    WHERE expires_at IS NOT NULL
    AND expires_at < CURRENT_TIMESTAMP
    AND user_id IS NULL;  -- 仅清理匿名记录
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_expired_consents() IS '清理过期的匿名 Cookie 同意记录';
