-- REQ-00136: FCM/APNs 移动推送通知系统
-- 创建时间: 2026-06-15

-- 设备令牌表
CREATE TABLE IF NOT EXISTS device_tokens (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('ios', 'android')),
    token TEXT NOT NULL,
    app_version VARCHAR(20),
    os_version VARCHAR(20),
    device_model VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_token ON device_tokens(token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_active ON device_tokens(is_active);

COMMENT ON TABLE device_tokens IS '用户设备推送令牌表';
COMMENT ON COLUMN device_tokens.token IS 'FCM/APNs 设备令牌';
COMMENT ON COLUMN device_tokens.platform IS '平台：ios 或 android';
COMMENT ON COLUMN device_tokens.is_active IS '令牌是否活跃';

-- 推送通知记录表
CREATE TABLE IF NOT EXISTS push_notifications (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_token_id INTEGER REFERENCES device_tokens(id) ON DELETE SET NULL,
    notification_type VARCHAR(50) NOT NULL,
    title VARCHAR(100) NOT NULL,
    body TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    image_url TEXT,
    priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('high', 'normal')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'cancelled')),
    fcm_message_id VARCHAR(100),
    apns_apns_id VARCHAR(100),
    sent_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    opened_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_notifications_user ON push_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_push_notifications_status ON push_notifications(status);
CREATE INDEX IF NOT EXISTS idx_push_notifications_type ON push_notifications(notification_type);
CREATE INDEX IF NOT EXISTS idx_push_notifications_created ON push_notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_push_notifications_fcm_id ON push_notifications(fcm_message_id);

COMMENT ON TABLE push_notifications IS '推送通知记录表';
COMMENT ON COLUMN push_notifications.notification_type IS '通知类型：pokemon_catch, gym_battle, friend_request 等';
COMMENT ON COLUMN push_notifications.status IS '推送状态';
COMMENT ON COLUMN push_notifications.data IS '自定义数据载荷';

-- 用户推送偏好表
CREATE TABLE IF NOT EXISTS push_preferences (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    global_enabled BOOLEAN DEFAULT true,
    quiet_hours_start TIME DEFAULT '22:00',
    quiet_hours_end TIME DEFAULT '08:00',
    timezone VARCHAR(50) DEFAULT 'UTC',
    pokemon_catch BOOLEAN DEFAULT true,
    gym_battle BOOLEAN DEFAULT true,
    friend_request BOOLEAN DEFAULT true,
    gift_received BOOLEAN DEFAULT true,
    event_reminder BOOLEAN DEFAULT true,
    system_announcement BOOLEAN DEFAULT true,
    marketing BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE push_preferences IS '用户推送偏好设置表';
COMMENT ON COLUMN push_preferences.quiet_hours_start IS '静默时段开始时间';
COMMENT ON COLUMN push_preferences.quiet_hours_end IS '静默时段结束时间';

-- 推送活动管理表
CREATE TABLE IF NOT EXISTS push_campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    notification_type VARCHAR(50) NOT NULL,
    title_template VARCHAR(100) NOT NULL,
    body_template TEXT NOT NULL,
    image_url TEXT,
    target_segment VARCHAR(50),
    target_user_ids UUID[] DEFAULT '{}',
    scheduled_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'completed', 'cancelled')),
    total_targets INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    delivered_count INTEGER DEFAULT 0,
    opened_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_campaigns_status ON push_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_push_campaigns_scheduled ON push_campaigns(scheduled_at);

COMMENT ON TABLE push_campaigns IS '推送活动管理表';
COMMENT ON COLUMN push_campaigns.target_segment IS '目标用户分段：all, active_7d, active_30d, new_users, paying_users';

-- 推送分析统计表
CREATE TABLE IF NOT EXISTS push_analytics (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    total_sent INTEGER DEFAULT 0,
    total_delivered INTEGER DEFAULT 0,
    total_opened INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    ios_sent INTEGER DEFAULT 0,
    android_sent INTEGER DEFAULT 0,
    by_type JSONB DEFAULT '{}',
    avg_delivery_time_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_analytics_date ON push_analytics(date);

COMMENT ON TABLE push_analytics IS '推送通知每日统计表';

-- 插入通知类型枚举注释
COMMENT ON COLUMN push_notifications.notification_type IS 
'通知类型枚举：
- pokemon_catch: 精灵捕捉成功
- gym_battle: 道馆战斗结果
- friend_request: 好友请求
- gift_received: 收到礼物
- event_reminder: 活动提醒
- system_announcement: 系统公告
- marketing: 营销推送';
