-- database/migrations/20260708_060000_push_notification_localization.sql
-- REQ-00496: 推送通知内容多语言本地化与智能语言适配系统
-- 创建通知模板表和用户语言缓存

-- 通知模板表（多语言）
CREATE TABLE IF NOT EXISTS notification_templates (
  id SERIAL PRIMARY KEY,
  template_key VARCHAR(64) UNIQUE NOT NULL,  -- 如 'friend_request', 'gift_received'
  category VARCHAR(32) NOT NULL,              -- social/activity/system/reward/security
  priority VARCHAR(16) DEFAULT 'normal',      -- low/normal/high/critical
  variables JSONB,                            -- 支持的变量列表 ['sender_name', 'pokemon_name']
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_template_key ON notification_templates(template_key);
CREATE INDEX IF NOT EXISTS idx_template_category ON notification_templates(category);

-- 通知模板内容表（各语言版本）
CREATE TABLE IF NOT EXISTS notification_template_contents (
  id SERIAL PRIMARY KEY,
  template_id INTEGER REFERENCES notification_templates(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,              -- zh-CN/en-US/ja-JP
  title_template TEXT NOT NULL,               -- 支持变量插值，如 "好友 {{sender_name}} 发送了请求"
  body_template TEXT NOT NULL,                -- 如 "点击查看详情"
  action_text VARCHAR(64),                    -- 按钮文本，如 "接受"/"Accept"/"承認"
  cultural_variant TEXT,                      -- 文化适配说明
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(template_id, language)
);

CREATE INDEX IF NOT EXISTS idx_template_content_lang ON notification_template_contents(template_id, language);

-- 用户通知语言缓存表
CREATE TABLE IF NOT EXISTS user_notification_language_cache (
  user_id VARCHAR(64) PRIMARY KEY,
  language VARCHAR(10) NOT NULL,
  language_source VARCHAR(32),                -- preference/header/device/default
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 预置常用通知模板
INSERT INTO notification_templates (template_key, category, priority, variables) VALUES
-- 社交类
('friend_request', 'social', 'normal', '{"variables": ["sender_name"]}'::jsonb),
('friend_accepted', 'social', 'normal', '{"variables": ["friend_name"]}'::jsonb),
('gift_received', 'social', 'normal', '{"variables": ["sender_name", "gift_name"]}'::jsonb),
('gift_sent', 'social', 'normal', '{"variables": ["recipient_name", "gift_name"]}'::jsonb),
('trade_request', 'social', 'high', '{"variables": ["sender_name", "pokemon_name"]}'::jsonb),
('trade_completed', 'social', 'normal', '{"variables": ["partner_name", "pokemon_name"]}'::jsonb),
-- 活动类
('event_start', 'activity', 'high', '{"variables": ["event_name", "duration"]}'::jsonb),
('event_end', 'activity', 'normal', '{"variables": ["event_name"]}'::jsonb),
('raid_nearby', 'activity', 'high', '{"variables": ["pokemon_name", "distance", "time_left"]}'::jsonb),
('spawn_rare', 'activity', 'high', '{"variables": ["pokemon_name", "distance"]}'::jsonb),
('spawn_legendary', 'activity', 'critical', '{"variables": ["pokemon_name", "location"]}'::jsonb),
-- 系统类
('system_maintenance', 'system', 'critical', '{"variables": ["start_time", "duration"]}'::jsonb),
('system_update', 'system', 'high', '{"variables": ["version", "features"]}'::jsonb),
('server_restart', 'system', 'high', '{"variables": ["estimated_time"]}'::jsonb),
-- 奖励类
('daily_reward', 'reward', 'normal', '{"variables": ["reward_name", "amount"]}'::jsonb),
('achievement_unlock', 'reward', 'high', '{"variables": ["achievement_name"]}'::jsonb),
('level_up', 'reward', 'normal', '{"variables": ["new_level"]}'::jsonb),
('streak_bonus', 'reward', 'normal', '{"variables": ["days", "bonus"]}'::jsonb),
-- 安全类
('security_alert', 'security', 'critical', '{"variables": ["alert_type", "action"]}'::jsonb),
('password_changed', 'security', 'high', '{"variables": []}'::jsonb),
('new_device_login', 'security', 'high', '{"variables": ["device_name", "location"]}'::jsonb),
('account_verify', 'security', 'high', '{"variables": []}'::jsonb)
ON CONFLICT (template_key) DO NOTHING;

-- 预置模板内容（三种语言）
-- friend_request (template_id = 1)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(1, 'zh-CN', '好友请求', '{{sender_name}} 想和你成为好友', '查看'),
(1, 'en-US', 'Friend Request', '{{sender_name}} wants to be your friend', 'View'),
(1, 'ja-JP', '友達申請', '{{sender_name}}が友達申請を送りました', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- friend_accepted (template_id = 2)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(2, 'zh-CN', '好友确认', '{{friend_name}} 已接受你的好友请求', '查看'),
(2, 'en-US', 'Friend Accepted', '{{friend_name}} accepted your friend request', 'View'),
(2, 'ja-JP', '友達承認', '{{friend_name}}が友達申請を承認しました', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- gift_received (template_id = 3)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(3, 'zh-CN', '收到礼物', '{{sender_name}} 送了你一个 {{gift_name}}', '领取'),
(3, 'en-US', 'Gift Received', '{{sender_name}} sent you a {{gift_name}}', 'Claim'),
(3, 'ja-JP', 'ギフト受信', '{{sender_name}}から{{gift_name}}が届きました', '受け取る')
ON CONFLICT (template_id, language) DO NOTHING;

-- gift_sent (template_id = 4)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(4, 'zh-CN', '礼物送达', '你的礼物已成功送出给 {{recipient_name}}', '确认'),
(4, 'en-US', 'Gift Sent', 'Your gift has been sent to {{recipient_name}}', 'OK'),
(4, 'ja-JP', 'ギフト送信', '{{recipient_name}}へのギフトが届きました', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- trade_request (template_id = 5)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(5, 'zh-CN', '交易请求', '{{sender_name}} 想和你交换 {{pokemon_name}}', '查看'),
(5, 'en-US', 'Trade Request', '{{sender_name}} wants to trade {{pokemon_name}}', 'View'),
(5, 'ja-JP', '交換申請', '{{sender_name}}が{{pokemon_name}}の交換を申請しました', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- trade_completed (template_id = 6)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(6, 'zh-CN', '交易完成', '你与 {{partner_name}} 完成了 {{pokemon_name}} 的交换', '查看'),
(6, 'en-US', 'Trade Completed', 'You completed the trade of {{pokemon_name}} with {{partner_name}}', 'View'),
(6, 'ja-JP', '交換完了', '{{partner_name}}との{{pokemon_name}}の交換が完了しました', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- event_start (template_id = 7)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(7, 'zh-CN', '活动开始', '{{event_name}} 已开始！持续 {{duration}}', '参与'),
(7, 'en-US', 'Event Started', '{{event_name}} has started! Duration: {{duration}}', 'Join'),
(7, 'ja-JP', 'イベント開始', '{{event_name}}が始まりました！期間：{{duration}}', '参加')
ON CONFLICT (template_id, language) DO NOTHING;

-- event_end (template_id = 8)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(8, 'zh-CN', '活动结束', '{{event_name}} 已结束，感谢参与！', '查看'),
(8, 'en-US', 'Event Ended', '{{event_name}} has ended. Thanks for participating!', 'View'),
(8, 'ja-JP', 'イベント終了', '{{event_name}}が終了しました。ご参加ありがとうございます！', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- raid_nearby (template_id = 9)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(9, 'zh-CN', 'Raid 战通知', '附近的 Raid 战开始！{{pokemon_name}} 还剩 {{time_left}}', '前往'),
(9, 'en-US', 'Raid Nearby', 'A nearby Raid has started! {{pokemon_name}}, {{time_left}} left', 'Go'),
(9, 'ja-JP', 'レイド通知', '近くのレイドが始まりました！{{pokemon_name}}、残り{{time_left}}', '行く')
ON CONFLICT (template_id, language) DO NOTHING;

-- spawn_rare (template_id = 10)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(10, 'zh-CN', '稀有精灵出现', '稀有精灵 {{pokemon_name}} 出现！距离 {{distance}}', '前往'),
(10, 'en-US', 'Rare Spawn', 'Rare {{pokemon_name}} spawned! {{distance}} away', 'Go'),
(10, 'ja-JP', '希少ポケモン出現', '希少な{{pokemon_name}}が現れました！距離：{{distance}}', '行く')
ON CONFLICT (template_id, language) DO NOTHING;

-- spawn_legendary (template_id = 11)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(11, 'zh-CN', '传说精灵出现', '传说中的 {{pokemon_name}} 出现于 {{location}}！', '立即前往'),
(11, 'en-US', 'Legendary Spawned', 'Legendary {{pokemon_name}} appeared at {{location}}!', 'Go Now'),
(11, 'ja-JP', '伝説のポケモン出現', '伝説の{{pokemon_name}}が{{location}}に現れました！', '今すぐ行く')
ON CONFLICT (template_id, language) DO NOTHING;

-- system_maintenance (template_id = 12)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(12, 'zh-CN', '系统维护通知', '系统将于 {{start_time}} 开始维护，预计 {{duration}}', '了解更多'),
(12, 'en-US', 'Maintenance Notice', 'System maintenance at {{start_time}}, estimated {{duration}}', 'Learn More'),
(12, 'ja-JP', 'システムメンテナンス', '{{start_time}}からメンテナンス開始、予想時間：{{duration}}', '詳細')
ON CONFLICT (template_id, language) DO NOTHING;

-- system_update (template_id = 13)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(13, 'zh-CN', '系统更新', '系统已更新至 {{version}}，新增：{{features}}', '查看'),
(13, 'en-US', 'System Update', 'System updated to {{version}}. New: {{features}}', 'View'),
(13, 'ja-JP', 'システム更新', 'システムが{{version}}に更新されました。新機能：{{features}}', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- server_restart (template_id = 14)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(14, 'zh-CN', '服务器重启', '服务器正在重启，预计恢复时间 {{estimated_time}}', '等待'),
(14, 'en-US', 'Server Restart', 'Server is restarting. Estimated recovery: {{estimated_time}}', 'Wait'),
(14, 'ja-JP', 'サーバー再起動', 'サーバーが再起動中です。予想復旧時間：{{estimated_time}}', '待機')
ON CONFLICT (template_id, language) DO NOTHING;

-- daily_reward (template_id = 15)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(15, 'zh-CN', '每日奖励', '每日奖励已就绪：{{reward_name}} {{amount}}', '领取'),
(15, 'en-US', 'Daily Reward', 'Daily reward ready: {{reward_name}} {{amount}}', 'Claim'),
(15, 'ja-JP', '日報酬', '日報酬が準備完了：{{reward_name}} {{amount}}', '受け取る')
ON CONFLICT (template_id, language) DO NOTHING;

-- achievement_unlock (template_id = 16)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(16, 'zh-CN', '成就解锁', '恭喜解锁成就：{{achievement_name}}', '查看奖励'),
(16, 'en-US', 'Achievement Unlocked', 'Achievement unlocked: {{achievement_name}}', 'View Rewards'),
(16, 'ja-JP', '実績解除', '実績解除：{{achievement_name}}', '報酬を見る')
ON CONFLICT (template_id, language) DO NOTHING;

-- level_up (template_id = 17)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(17, 'zh-CN', '等级提升', '恭喜！你已升至 {{new_level}} 级', '查看'),
(17, 'en-US', 'Level Up', 'Congratulations! You reached Level {{new_level}}', 'View'),
(17, 'ja-JP', 'レベルアップ', 'レベル{{new_level}}に達しました！', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- streak_bonus (template_id = 18)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(18, 'zh-CN', '连续登录奖励', '连续登录 {{days}} 天！奖励：{{bonus}}', '领取'),
(18, 'en-US', 'Streak Bonus', '{{days}} day streak! Bonus: {{bonus}}', 'Claim'),
(18, 'ja-JP', '連続ログイン報酬', '{{days}}日連続ログイン！報酬：{{bonus}}', '受け取る')
ON CONFLICT (template_id, language) DO NOTHING;

-- security_alert (template_id = 19)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(19, 'zh-CN', '安全警告', '检测到 {{alert_type}}，建议 {{action}}', '立即处理'),
(19, 'en-US', 'Security Alert', '{{alert_type}} detected. Recommended: {{action}}', 'Take Action'),
(19, 'ja-JP', 'セキュリティ警告', '{{alert_type}}が検出されました。推奨：{{action}}', '対処')
ON CONFLICT (template_id, language) DO NOTHING;

-- password_changed (template_id = 20)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(20, 'zh-CN', '密码已更改', '你的密码已成功更改', '确认'),
(20, 'en-US', 'Password Changed', 'Your password has been changed successfully', 'OK'),
(20, 'ja-JP', 'パスワード変更', 'パスワードが変更されました', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- new_device_login (template_id = 21)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(21, 'zh-CN', '新设备登录提醒', '您的账号在 {{device_name}} ({{location}}) 登录', '检查'),
(21, 'en-US', 'New Device Login', 'Your account logged in on {{device_name}} ({{location}})', 'Check'),
(21, 'ja-JP', '新しいデバイスログイン', '{{device_name}}（{{location}}）でログインしました', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- account_verify (template_id = 22)
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
(22, 'zh-CN', '账号验证', '请验证您的账号以解锁更多功能', '立即验证'),
(22, 'en-US', 'Account Verification', 'Verify your account to unlock more features', 'Verify Now'),
(22, 'ja-JP', 'アカウント確認', 'アカウントを確認して機能を解放してください', '確認')
ON CONFLICT (template_id, language) DO NOTHING;

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_notification_template_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_templates_updated_at
  BEFORE UPDATE ON notification_templates
  FOR EACH ROW EXECUTE FUNCTION update_notification_template_timestamp();

CREATE TRIGGER notification_template_contents_updated_at
  BEFORE UPDATE ON notification_template_contents
  FOR EACH ROW EXECUTE FUNCTION update_notification_template_timestamp();

-- 创建视图：完整模板（含所有语言）
CREATE OR REPLACE VIEW v_notification_templates_full AS
SELECT 
  t.id,
  t.template_key,
  t.category,
  t.priority,
  t.variables,
  jsonb_object_agg(
    c.language,
    jsonb_build_object(
      'title', c.title_template,
      'body', c.body_template,
      'action_text', c.action_text,
      'cultural_variant', c.cultural_variant
    )
  ) AS contents,
  t.created_at,
  t.updated_at
FROM notification_templates t
LEFT JOIN notification_template_contents c ON t.id = c.template_id
GROUP BY t.id, t.template_key, t.category, t.priority, t.variables, t.created_at, t.updated_at;

-- 创建视图：用户语言偏好统计
CREATE OR REPLACE VIEW v_notification_language_stats AS
SELECT 
  language,
  COUNT(*) AS user_count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) AS percentage
FROM user_notification_language_cache
GROUP BY language
ORDER BY user_count DESC;

COMMENT ON TABLE notification_templates IS 'REQ-00496: 通知模板定义表';
COMMENT ON TABLE notification_template_contents IS 'REQ-00496: 通知模板各语言版本内容';
COMMENT ON TABLE user_notification_language_cache IS 'REQ-00496: 用户通知语言偏好缓存';