-- migrate:up
-- Epic E13：站内消息中心与智能推送（REQ-00099 / REQ-00261 / REQ-00425）
--
-- 现状：notification_history（V1，无标题/已读时间）、notifications_partitioned、push_notifications 等多套表并存，
-- user-service 的 messageCenter 路由查询了 notification_history 上不存在的列，处于不可用状态。
-- 收敛：notifications 为唯一站内消息表（软删除、去重键、过期时间、多语言模板参数）；
-- 偏好沿用 user_push_preferences（已有分类开关/免打扰/设备令牌列，这里补齐渠道与静音列）；
-- 模板沿用 notification_templates + notification_template_contents（zh-CN/en-US/ja-JP）。
-- 全服公告/活动开始写 notification_broadcasts，玩家读取消息时按需物化（避免给全体玩家逐条写入）。
-- notifications 插入时 pg_notify('pmg_notifications')，user-service 的 WebSocket 据此实时推送。

-- ============================================================
-- 1. 站内消息
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         VARCHAR(60) NOT NULL,
  category     VARCHAR(20) NOT NULL DEFAULT 'system',
  priority     VARCHAR(10) NOT NULL DEFAULT 'normal',
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  template_key VARCHAR(64),
  params       JSONB NOT NULL DEFAULT '{}'::jsonb,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  icon         VARCHAR(16),
  action_url   VARCHAR(300),
  dedupe_key   VARCHAR(160),
  channels     TEXT[] NOT NULL DEFAULT ARRAY['in_app']::text[],
  is_read      BOOLEAN NOT NULL DEFAULT FALSE,
  read_at      TIMESTAMPTZ,
  clicked_at   TIMESTAMPTZ,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- 若库里已有同名旧表，补齐列（幂等收敛）
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'system';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'normal';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS template_key VARCHAR(64);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS icon VARCHAR(16);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url VARCHAR(300);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(160);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channels TEXT[] NOT NULL DEFAULT ARRAY['in_app']::text[];
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days');

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('system', 'social', 'event', 'reward', 'pokemon', 'security'));
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_priority_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_priority_check
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_notifications_user_category ON notifications (user_id, category, created_at DESC) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, category) WHERE NOT is_read AND NOT is_deleted;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_expires ON notifications (expires_at);

CREATE OR REPLACE FUNCTION notifications_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pmg_notifications', json_build_object('id', NEW.id, 'userId', NEW.user_id,
    'priority', NEW.priority, 'category', NEW.category)::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_notifications_notify ON notifications;
CREATE TRIGGER trg_notifications_notify AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_notify();

COMMENT ON TABLE notifications IS '站内消息（消息中心）：软删除、dedupe_key 去重、默认 30 天过期；插入即 pg_notify 实时推送';

-- ============================================================
-- 2. 全服广播（系统公告、活动开始）：读取时按玩家物化为 notifications（dedupe_key = bc:<id>）
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_broadcasts (
  id           BIGSERIAL PRIMARY KEY,
  type         VARCHAR(60) NOT NULL,
  category     VARCHAR(20) NOT NULL DEFAULT 'system',
  priority     VARCHAR(10) NOT NULL DEFAULT 'normal',
  template_key VARCHAR(64),
  params       JSONB NOT NULL DEFAULT '{}'::jsonb,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_url   VARCHAR(300),
  audience     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {"minLevel": 5, "team": "VALOR"}
  dedupe_key   VARCHAR(160) UNIQUE,
  starts_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notification_broadcasts_active ON notification_broadcasts (starts_at, expires_at);

-- 活动开始：events.status 变为 active（管理员上线/恢复、定时任务到点激活）时写广播；同一活动只广播一次
CREATE OR REPLACE FUNCTION trg_event_start_broadcast() RETURNS trigger AS $$
DECLARE hrs INT;
BEGIN
  IF COALESCE(NEW.status, '') <> 'active' OR (TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status) THEN RETURN NULL; END IF;
  IF NEW.end_time IS NOT NULL AND NEW.end_time <= NOW() THEN RETURN NULL; END IF;
  BEGIN
    hrs := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (COALESCE(NEW.end_time, NOW() + INTERVAL '1 day') - GREATEST(NOW(), COALESCE(NEW.start_time, NOW())))) / 3600))::int;
    INSERT INTO notification_broadcasts (type, category, priority, template_key, params, title, body, data, action_url,
                                         dedupe_key, starts_at, expires_at)
    VALUES ('event.started', 'event', 'normal', 'event_start',
            jsonb_build_object('event_name', NEW.title, 'duration', hrs || 'h',
              '_i18n', jsonb_build_object('en-US', jsonb_build_object('event_name', COALESCE(NEW.title_en, NEW.title)),
                                          'ja-JP', jsonb_build_object('event_name', COALESCE(NEW.title_ja, NEW.title)))),
            '活动开始', NEW.title || ' 已开始！持续 ' || hrs || 'h',
            jsonb_build_object('eventId', NEW.id, 'eventKey', NEW.event_key, 'eventType', NEW.event_type, 'endTime', NEW.end_time),
            '/events/' || NEW.id, 'event_start:' || NEW.id, NOW(), COALESCE(NEW.end_time, NOW() + INTERVAL '7 days'))
    ON CONFLICT (dedupe_key) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'event start broadcast skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_events_start_broadcast ON events;
CREATE TRIGGER trg_events_start_broadcast AFTER INSERT OR UPDATE OF status ON events
  FOR EACH ROW EXECUTE FUNCTION trg_event_start_broadcast();

-- ============================================================
-- 3. 投递/打开分析（REQ-00425 送达率、打开率）
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_events (
  id              BIGSERIAL PRIMARY KEY,
  notification_id UUID,
  user_id         UUID NOT NULL,
  event_type      VARCHAR(20) NOT NULL,
  channel         VARCHAR(20) NOT NULL,
  metadata        JSONB,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE notification_events DROP CONSTRAINT IF EXISTS notification_events_type_check;
ALTER TABLE notification_events ADD CONSTRAINT notification_events_type_check
  CHECK (event_type IN ('sent', 'delivered', 'opened', 'clicked', 'dismissed', 'failed', 'deferred', 'suppressed'));
ALTER TABLE notification_events DROP CONSTRAINT IF EXISTS notification_events_channel_check;
ALTER TABLE notification_events ADD CONSTRAINT notification_events_channel_check
  CHECK (channel IN ('in_app', 'ws', 'email', 'sms', 'fcm', 'apns'));
CREATE INDEX IF NOT EXISTS idx_notification_events_notification ON notification_events (notification_id);
CREATE INDEX IF NOT EXISTS idx_notification_events_user_time ON notification_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_type_time ON notification_events (event_type, occurred_at);

-- ============================================================
-- 4. 偏好：沿用 user_push_preferences，补齐站内/推送/邮件开关、时区、临时静音、每小时推送上限
-- ============================================================
ALTER TABLE user_push_preferences ADD COLUMN IF NOT EXISTS enable_in_app BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_push_preferences ADD COLUMN IF NOT EXISTS enable_push BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_push_preferences ADD COLUMN IF NOT EXISTS enable_email BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_push_preferences ADD COLUMN IF NOT EXISTS timezone VARCHAR(50);
ALTER TABLE user_push_preferences ADD COLUMN IF NOT EXISTS mute_until TIMESTAMPTZ;
ALTER TABLE user_push_preferences ADD COLUMN IF NOT EXISTS max_push_per_hour SMALLINT NOT NULL DEFAULT 6;

-- ============================================================
-- 5. 模板补充（zh-CN / en-US / ja-JP）
-- ============================================================
INSERT INTO notification_templates (template_key, category, priority, variables) VALUES
  ('title_unlocked', 'reward', 'normal', '["title_name"]'),
  ('collection_liked', 'social', 'low', '["liker_name"]'),
  ('collection_comment', 'social', 'normal', '["commenter_name", "comment"]'),
  ('room_level_up', 'reward', 'normal', '["new_level"]'),
  ('decoration_unlocked', 'reward', 'normal', '["item_name"]'),
  ('system_announcement', 'system', 'normal', '["title", "body"]')
ON CONFLICT (template_key) DO NOTHING;

INSERT INTO notification_template_contents (template_id, language, title_template, body_template)
SELECT t.id, v.lang, v.title, v.body
  FROM (VALUES
    ('title_unlocked', 'zh-CN', '新称号解锁', '获得称号「{{title_name}}」，可在资料卡中佩戴'),
    ('title_unlocked', 'en-US', 'New Title Unlocked', 'You earned the title "{{title_name}}". Equip it on your profile!'),
    ('title_unlocked', 'ja-JP', '新しい称号', '称号「{{title_name}}」を獲得しました'),
    ('collection_liked', 'zh-CN', '收藏室被点赞', '{{liker_name}} 赞了你的收藏室'),
    ('collection_liked', 'en-US', 'Your Room Got a Like', '{{liker_name}} liked your collection room'),
    ('collection_liked', 'ja-JP', 'いいねされました', '{{liker_name}}があなたのコレクションルームにいいねしました'),
    ('collection_comment', 'zh-CN', '收藏室新留言', '{{commenter_name}}：{{comment}}'),
    ('collection_comment', 'en-US', 'New Comment', '{{commenter_name}}: {{comment}}'),
    ('collection_comment', 'ja-JP', '新しいコメント', '{{commenter_name}}：{{comment}}'),
    ('room_level_up', 'zh-CN', '收藏室升级', '你的收藏室升到了 {{new_level}} 级，解锁了新的主题和展示位'),
    ('room_level_up', 'en-US', 'Room Level Up', 'Your collection room reached level {{new_level}}!'),
    ('room_level_up', 'ja-JP', 'ルームレベルアップ', 'コレクションルームがレベル{{new_level}}になりました'),
    ('decoration_unlocked', 'zh-CN', '获得装饰', '获得装饰物品「{{item_name}}」'),
    ('decoration_unlocked', 'en-US', 'New Decoration', 'You got the decoration "{{item_name}}"'),
    ('decoration_unlocked', 'ja-JP', '新しいデコレーション', 'デコレーション「{{item_name}}」を手に入れました'),
    ('system_announcement', 'zh-CN', '{{title}}', '{{body}}'),
    ('system_announcement', 'en-US', '{{title}}', '{{body}}'),
    ('system_announcement', 'ja-JP', '{{title}}', '{{body}}')
  ) AS v(key, lang, title, body)
  JOIN notification_templates t ON t.template_key = v.key
ON CONFLICT (template_id, language) DO NOTHING;

-- migrate:down
DROP TRIGGER IF EXISTS trg_events_start_broadcast ON events;
DROP TRIGGER IF EXISTS trg_notifications_notify ON notifications;
DROP TABLE IF EXISTS notification_events;
DROP TABLE IF EXISTS notification_broadcasts;
DROP TABLE IF EXISTS notifications;
