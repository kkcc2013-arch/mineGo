// database/migrations/055_i18n_dynamic_localization.sql
// REQ-00294: 动态本地化系统数据库迁移

-- 翻译键表
CREATE TABLE IF NOT EXISTS translation_keys (
  id SERIAL PRIMARY KEY,
  key VARCHAR(255) NOT NULL,
  context VARCHAR(100) DEFAULT 'default',
  description TEXT,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(key, context)
);

COMMENT ON TABLE translation_keys IS '翻译键定义表';

-- 翻译表
CREATE TABLE IF NOT EXISTS translations (
  id SERIAL PRIMARY KEY,
  locale VARCHAR(10) NOT NULL,
  key VARCHAR(255) NOT NULL,
  context VARCHAR(100) DEFAULT 'default',
  value TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  translator VARCHAR(100),
  machine_translated BOOLEAN DEFAULT FALSE,
  reviewed_at TIMESTAMP,
  reviewed_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(locale, key, context)
);

COMMENT ON TABLE translations IS '翻译内容表';

-- 翻译反馈表
CREATE TABLE IF NOT EXISTS translation_feedback (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36),
  locale VARCHAR(10) NOT NULL,
  translation_key VARCHAR(255) NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE translation_feedback IS '玩家翻译质量反馈表';

-- 用户语言偏好表
CREATE TABLE IF NOT EXISTS user_locale_preferences (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL UNIQUE,
  locale VARCHAR(10) NOT NULL,
  auto_detected BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE user_locale_preferences IS '用户语言偏好表';

-- 索引
CREATE INDEX IF NOT EXISTS idx_translations_locale ON translations(locale);
CREATE INDEX IF NOT EXISTS idx_translations_key ON translations(key);
CREATE INDEX IF NOT EXISTS idx_translations_context ON translations(context);
CREATE INDEX IF NOT EXISTS idx_translations_status ON translations(status);
CREATE INDEX IF NOT EXISTS idx_translation_keys_context ON translation_keys(context);
CREATE INDEX IF NOT EXISTS idx_translation_feedback_locale ON translation_feedback(locale, created_at);
CREATE INDEX IF NOT EXISTS idx_user_locale_user ON user_locale_preferences(user_id);

-- 初始化基础翻译键
INSERT INTO translation_keys (key, context, description) VALUES
('common.loading', 'common', '加载中'),
('common.success', 'common', '成功'),
('common.error', 'common', '错误'),
('common.confirm', 'common', '确认'),
('common.cancel', 'common', '取消'),
('common.save', 'common', '保存'),
('common.delete', 'common', '删除'),
('common.edit', 'common', '编辑'),
('pokemon.catch_success', 'pokemon', '精灵捕捉成功'),
('pokemon.catch_failed', 'pokemon', '精灵捕捉失败'),
('pokemon.not_found', 'pokemon', '精灵不存在'),
('pokemon.level', 'pokemon', '精灵等级'),
('pokemon.type', 'pokemon', '精灵类型'),
('gym.battle_start', 'gym', '道馆战斗开始'),
('gym.battle_win', 'gym', '道馆战斗胜利'),
('gym.battle_lose', 'gym', '道馆战斗失败'),
('user.login', 'user', '登录'),
('user.logout', 'user', '退出登录'),
('user.register', 'user', '注册'),
('user.profile', 'user', '用户资料'),
('event.title', 'event', '活动标题'),
('event.description', 'event', '活动描述'),
('event.start_time', 'event', '活动开始时间'),
('event.end_time', 'event', '活动结束时间'),
('reward.daily', 'reward', '每日奖励'),
('reward.achievement', 'reward', '成就奖励'),
('reward.milestone', 'reward', '里程碑奖励')
ON CONFLICT (key, context) DO NOTHING;

-- 初始化中文翻译
INSERT INTO translations (locale, key, context, value, translator, reviewed_at) VALUES
('zh-CN', 'common.loading', 'common', '加载中...', 'system', NOW()),
('zh-CN', 'common.success', 'common', '成功', 'system', NOW()),
('zh-CN', 'common.error', 'common', '错误', 'system', NOW()),
('zh-CN', 'common.confirm', 'common', '确认', 'system', NOW()),
('zh-CN', 'common.cancel', 'common', '取消', 'system', NOW()),
('zh-CN', 'common.save', 'common', '保存', 'system', NOW()),
('zh-CN', 'common.delete', 'common', '删除', 'system', NOW()),
('zh-CN', 'common.edit', 'common', '编辑', 'system', NOW()),
('zh-CN', 'pokemon.catch_success', 'pokemon', '成功捕捉了 {name}！', 'system', NOW()),
('zh-CN', 'pokemon.catch_failed', 'pokemon', '捕捉失败，{name} 逃跑了', 'system', NOW()),
('zh-CN', 'pokemon.not_found', 'pokemon', '精灵不存在或已消失', 'system', NOW()),
('zh-CN', 'pokemon.level', 'pokemon', '等级', 'system', NOW()),
('zh-CN', 'pokemon.type', 'pokemon', '类型', 'system', NOW()),
('zh-CN', 'gym.battle_start', 'gym', '道馆战斗开始！', 'system', NOW()),
('zh-CN', 'gym.battle_win', 'gym', '道馆战斗胜利！', 'system', NOW()),
('zh-CN', 'gym.battle_lose', 'gym', '道馆战斗失败', 'system', NOW()),
('zh-CN', 'user.login', 'user', '登录', 'system', NOW()),
('zh-CN', 'user.logout', 'user', '退出登录', 'system', NOW()),
('zh-CN', 'user.register', 'user', '注册', 'system', NOW()),
('zh-CN', 'user.profile', 'user', '用户资料', 'system', NOW()),
('zh-CN', 'event.title', 'event', '活动标题', 'system', NOW()),
('zh-CN', 'event.description', 'event', '活动描述', 'system', NOW()),
('zh-CN', 'event.start_time', 'event', '开始时间', 'system', NOW()),
('zh-CN', 'event.end_time', 'event', '结束时间', 'system', NOW()),
('zh-CN', 'reward.daily', 'reward', '每日奖励', 'system', NOW()),
('zh-CN', 'reward.achievement', 'reward', '成就奖励', 'system', NOW()),
('zh-CN', 'reward.milestone', 'reward', '里程碑奖励', 'system', NOW())
ON CONFLICT (locale, key, context) DO NOTHING;

-- 初始化英文翻译
INSERT INTO translations (locale, key, context, value, translator, reviewed_at) VALUES
('en-US', 'common.loading', 'common', 'Loading...', 'system', NOW()),
('en-US', 'common.success', 'common', 'Success', 'system', NOW()),
('en-US', 'common.error', 'common', 'Error', 'system', NOW()),
('en-US', 'common.confirm', 'common', 'Confirm', 'system', NOW()),
('en-US', 'common.cancel', 'common', 'Cancel', 'system', NOW()),
('en-US', 'common.save', 'common', 'Save', 'system', NOW()),
('en-US', 'common.delete', 'common', 'Delete', 'system', NOW()),
('en-US', 'common.edit', 'common', 'Edit', 'system', NOW()),
('en-US', 'pokemon.catch_success', 'pokemon', 'Successfully caught {name}!', 'system', NOW()),
('en-US', 'pokemon.catch_failed', 'pokemon', 'Catch failed, {name} escaped', 'system', NOW()),
('en-US', 'pokemon.not_found', 'pokemon', 'Pokémon not found or has disappeared', 'system', NOW()),
('en-US', 'pokemon.level', 'pokemon', 'Level', 'system', NOW()),
('en-US', 'pokemon.type', 'pokemon', 'Type', 'system', NOW()),
('en-US', 'gym.battle_start', 'gym', 'Gym battle started!', 'system', NOW()),
('en-US', 'gym.battle_win', 'gym', 'Gym battle victory!', 'system', NOW()),
('en-US', 'gym.battle_lose', 'gym', 'Gym battle failed', 'system', NOW()),
('en-US', 'user.login', 'user', 'Login', 'system', NOW()),
('en-US', 'user.logout', 'user', 'Logout', 'system', NOW()),
('en-US', 'user.register', 'user', 'Register', 'system', NOW()),
('en-US', 'user.profile', 'user', 'Profile', 'system', NOW()),
('en-US', 'event.title', 'event', 'Event Title', 'system', NOW()),
('en-US', 'event.description', 'event', 'Event Description', 'system', NOW()),
('en-US', 'event.start_time', 'event', 'Start Time', 'system', NOW()),
('en-US', 'event.end_time', 'event', 'End Time', 'system', NOW()),
('en-US', 'reward.daily', 'reward', 'Daily Reward', 'system', NOW()),
('en-US', 'reward.achievement', 'reward', 'Achievement Reward', 'system', NOW()),
('en-US', 'reward.milestone', 'reward', 'Milestone Reward', 'system', NOW())
ON CONFLICT (locale, key, context) DO NOTHING;

-- 初始化日文翻译
INSERT INTO translations (locale, key, context, value, translator, reviewed_at) VALUES
('ja-JP', 'common.loading', 'common', '読み込み中...', 'system', NOW()),
('ja-JP', 'common.success', 'common', '成功', 'system', NOW()),
('ja-JP', 'common.error', 'common', 'エラー', 'system', NOW()),
('ja-JP', 'common.confirm', 'common', '確認', 'system', NOW()),
('ja-JP', 'common.cancel', 'common', 'キャンセル', 'system', NOW()),
('ja-JP', 'common.save', 'common', '保存', 'system', NOW()),
('ja-JP', 'common.delete', 'common', '削除', 'system', NOW()),
('ja-JP', 'common.edit', 'common', '編集', 'system', NOW()),
('ja-JP', 'pokemon.catch_success', 'pokemon', '{name}を捕獲しました！', 'system', NOW()),
('ja-JP', 'pokemon.catch_failed', 'pokemon', '捕獲失敗、{name}が逃げました', 'system', NOW()),
('ja-JP', 'pokemon.not_found', 'pokemon', 'ポケモンが見つからないか消えました', 'system', NOW()),
('ja-JP', 'pokemon.level', 'pokemon', 'レベル', 'system', NOW()),
('ja-JP', 'pokemon.type', 'pokemon', 'タイプ', 'system', NOW()),
('ja-JP', 'gym.battle_start', 'gym', 'ジムバトル開始！', 'system', NOW()),
('ja-JP', 'gym.battle_win', 'gym', 'ジムバトル勝利！', 'system', NOW()),
('ja-JP', 'gym.battle_lose', 'gym', 'ジムバトル失敗', 'system', NOW()),
('ja-JP', 'user.login', 'user', 'ログイン', 'system', NOW()),
('ja-JP', 'user.logout', 'user', 'ログアウト', 'system', NOW()),
('ja-JP', 'user.register', 'user', '登録', 'system', NOW()),
('ja-JP', 'user.profile', 'user', 'プロフィール', 'system', NOW()),
('ja-JP', 'event.title', 'event', 'イベントタイトル', 'system', NOW()),
('ja-JP', 'event.description', 'event', 'イベント説明', 'system', NOW()),
('ja-JP', 'event.start_time', 'event', '開始時間', 'system', NOW()),
('ja-JP', 'event.end_time', 'event', '終了時間', 'system', NOW()),
('ja-JP', 'reward.daily', 'reward', '毎日報酬', 'system', NOW()),
('ja-JP', 'reward.achievement', 'reward', '達成報酬', 'system', NOW()),
('ja-JP', 'reward.milestone', 'reward', 'マイルストーン報酬', 'system', NOW())
ON CONFLICT (locale, key, context) DO NOTHING;

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_translation_keys_updated_at
    BEFORE UPDATE ON translation_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_translations_updated_at
    BEFORE UPDATE ON translations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_locale_updated_at
    BEFORE UPDATE ON user_locale_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();