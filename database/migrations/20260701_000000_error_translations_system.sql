-- REQ-00398: API 错误消息动态翻译管理系统
-- 创建时间: 2026-07-01 00:00 UTC

-- ============================================
-- 1. 错误码翻译表
-- ============================================
CREATE TABLE IF NOT EXISTS error_translations (
  id SERIAL PRIMARY KEY,
  error_code VARCHAR(100) NOT NULL,
  language VARCHAR(10) NOT NULL,
  message TEXT NOT NULL,
  params_template JSONB,
  metadata JSONB,
  version INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  
  CONSTRAINT unique_error_translation UNIQUE(error_code, language)
);

-- 索引优化
CREATE INDEX idx_error_translations_code ON error_translations(error_code);
CREATE INDEX idx_error_translations_lang ON error_translations(language);
CREATE INDEX idx_error_translations_version ON error_translations(error_code, language, version);
CREATE INDEX idx_error_translations_created ON error_translations(created_at DESC);

COMMENT ON TABLE error_translations IS 'API 错误码多语言翻译表';
COMMENT ON COLUMN error_translations.error_code IS '错误码（如 POKEMON_NOT_FOUND）';
COMMENT ON COLUMN error_translations.language IS '语言代码（如 zh-CN, en-US）';
COMMENT ON COLUMN error_translations.message IS '翻译后的错误消息';
COMMENT ON COLUMN error_translations.params_template IS '参数模板定义，用于消息插值';
COMMENT ON COLUMN error_translations.metadata IS '元数据（来源、审核状态等）';

-- ============================================
-- 2. 翻译审计日志表
-- ============================================
CREATE TABLE IF NOT EXISTS error_translation_audit (
  id SERIAL PRIMARY KEY,
  error_code VARCHAR(100) NOT NULL,
  language VARCHAR(10) NOT NULL,
  old_message TEXT,
  new_message TEXT NOT NULL,
  old_metadata JSONB,
  new_metadata JSONB,
  changed_by INTEGER REFERENCES users(id),
  change_reason TEXT,
  changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_translation_audit_error ON error_translation_audit(error_code, language);
CREATE INDEX idx_translation_audit_time ON error_translation_audit(changed_at DESC);
CREATE INDEX idx_translation_audit_user ON error_translation_audit(changed_by);

COMMENT ON TABLE error_translation_audit IS '翻译变更审计日志';

-- ============================================
-- 3. 缺失翻译告警表
-- ============================================
CREATE TABLE IF NOT EXISTS missing_translation_alerts (
  id SERIAL PRIMARY KEY,
  error_code VARCHAR(100) NOT NULL,
  missing_languages TEXT[] NOT NULL,
  severity VARCHAR(20) DEFAULT 'warning',
  first_detected TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_detected TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  detection_count INTEGER DEFAULT 1,
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  
  CONSTRAINT unique_missing_alert UNIQUE(error_code),
  CONSTRAINT valid_severity CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX idx_missing_alerts_severity ON missing_translation_alerts(severity);
CREATE INDEX idx_missing_alerts_ack ON missing_translation_alerts(acknowledged);
CREATE INDEX idx_missing_alerts_detected ON missing_translation_alerts(last_detected DESC);

COMMENT ON TABLE missing_translation_alerts IS '缺失翻译自动告警表';

-- ============================================
-- 4. 插入初始翻译数据
-- ============================================
INSERT INTO error_translations (error_code, language, message, params_template, metadata) VALUES
-- 核心错误 - 中文
('SUCCESS', 'zh-CN', '操作成功', '{"params": []}', '{"category": "core", "priority": "high"}'),
('INVALID_REQUEST', 'zh-CN', '请求参数无效: {field}', '{"params": [{"name": "field", "type": "string", "required": true}]}', '{"category": "validation", "priority": "high"}'),
('UNAUTHORIZED', 'zh-CN', '未授权访问，请先登录', '{"params": []}', '{"category": "auth", "priority": "critical"}'),
('FORBIDDEN', 'zh-CN', '权限不足，无法执行此操作', '{"params": []}', '{"category": "auth", "priority": "high"}'),
('NOT_FOUND', 'zh-CN', '请求的资源不存在', '{"params": []}', '{"category": "core", "priority": "medium"}'),
('INTERNAL_ERROR', 'zh-CN', '服务器内部错误，请稍后重试', '{"params": []}', '{"category": "system", "priority": "critical"}'),
('RATE_LIMIT_EXCEEDED', 'zh-CN', '请求过于频繁，请在 {retry_after} 秒后重试', '{"params": [{"name": "retry_after", "type": "number", "required": true}]}', '{"category": "rate", "priority": "high"}'),

-- 精灵相关 - 中文
('POKEMON_NOT_FOUND', 'zh-CN', '未找到指定的精灵: {pokemon_id}', '{"params": [{"name": "pokemon_id", "type": "string", "required": true}]}', '{"category": "pokemon", "priority": "high"}'),
('POKEMON_ALREADY_CAUGHT', 'zh-CN', '该精灵已被捕捉', '{"params": []}', '{"category": "pokemon", "priority": "medium"}'),
('POKEMON_ESCAPED', 'zh-CN', '精灵逃脱了，请再次尝试', '{"params": []}', '{"category": "catch", "priority": "medium"}'),
('POKEMON_OUT_OF_RANGE', 'zh-CN', '精灵距离太远（{distance}米），请靠近后再尝试', '{"params": [{"name": "distance", "type": "number", "required": true}]}', '{"category": "location", "priority": "high"}'),

-- 捕捉相关 - 中文
('CATCH_FAILED', 'zh-CN', '捕捉失败，精灵已逃跑', '{"params": []}', '{"category": "catch", "priority": "medium"}'),
('INSUFFICIENT_BALLS', 'zh-CN', '精灵球不足，请前往商店购买', '{"params": []}', '{"category": "inventory", "priority": "high"}'),
('INVALID_BALL_TYPE', 'zh-CN', '无效的精灵球类型: {ball_type}', '{"params": [{"name": "ball_type", "type": "string", "required": true}]}', '{"category": "inventory", "priority": "medium"}'),

-- 道馆相关 - 中文
('GYM_NOT_FOUND', 'zh-CN', '未找到指定的道馆', '{"params": []}', '{"category": "gym", "priority": "high"}'),
('GYM_BATTLE_COOLDOWN', 'zh-CN', '道馆战斗冷却中，请等待 {cooldown} 秒', '{"params": [{"name": "cooldown", "type": "number", "required": true}]}', '{"category": "gym", "priority": "medium"}'),
('GYM_TEAM_FULL', 'zh-CN', '道馆防守队伍已满', '{"params": []}', '{"category": "gym", "priority": "medium"}'),

-- 社交相关 - 中文
('FRIEND_ALREADY_EXISTS', 'zh-CN', '该用户已是你的好友', '{"params": []}', '{"category": "social", "priority": "low"}'),
('FRIEND_REQUEST_PENDING', 'zh-CN', '好友请求已发送，等待对方确认', '{"params": []}', '{"category": "social", "priority": "low"}'),
('USER_NOT_FOUND', 'zh-CN', '未找到该用户: {user_id}', '{"params": [{"name": "user_id", "type": "string", "required": true}]}', '{"category": "user", "priority": "high"}'),

-- 支付相关 - 中文
('PAYMENT_FAILED', 'zh-CN', '支付失败，请检查支付方式后重试', '{"params": []}', '{"category": "payment", "priority": "critical"}'),
('INSUFFICIENT_BALANCE', 'zh-CN', '余额不足，请充值后重试', '{"params": []}', '{"category": "payment", "priority": "high"}'),
('TRANSACTION_NOT_FOUND', 'zh-CN', '未找到该交易记录', '{"params": []}', '{"category": "payment", "priority": "medium"}'),

-- 核心错误 - 英文
('SUCCESS', 'en-US', 'Operation successful', '{"params": []}', '{"category": "core", "priority": "high"}'),
('INVALID_REQUEST', 'en-US', 'Invalid request parameter: {field}', '{"params": [{"name": "field", "type": "string", "required": true}]}', '{"category": "validation", "priority": "high"}'),
('UNAUTHORIZED', 'en-US', 'Unauthorized access, please login first', '{"params": []}', '{"category": "auth", "priority": "critical"}'),
('FORBIDDEN', 'en-US', 'Insufficient permissions', '{"params": []}', '{"category": "auth", "priority": "high"}'),
('NOT_FOUND', 'en-US', 'Requested resource not found', '{"params": []}', '{"category": "core", "priority": "medium"}'),
('INTERNAL_ERROR', 'en-US', 'Internal server error, please try again later', '{"params": []}', '{"category": "system", "priority": "critical"}'),
('RATE_LIMIT_EXCEEDED', 'en-US', 'Too many requests, please retry after {retry_after} seconds', '{"params": [{"name": "retry_after", "type": "number", "required": true}]}', '{"category": "rate", "priority": "high"}'),

-- 精灵相关 - 英文
('POKEMON_NOT_FOUND', 'en-US', 'Pokemon not found: {pokemon_id}', '{"params": [{"name": "pokemon_id", "type": "string", "required": true}]}', '{"category": "pokemon", "priority": "high"}'),
('POKEMON_ALREADY_CAUGHT', 'en-US', 'This Pokemon has already been caught', '{"params": []}', '{"category": "pokemon", "priority": "medium"}'),
('POKEMON_ESCAPED', 'en-US', 'Pokemon escaped, please try again', '{"params": []}', '{"category": "catch", "priority": "medium"}'),
('POKEMON_OUT_OF_RANGE', 'en-US', 'Pokemon is too far away ({distance}m), please get closer', '{"params": [{"name": "distance", "type": "number", "required": true}]}', '{"category": "location", "priority": "high"}'),

-- 捕捉相关 - 英文
('CATCH_FAILED', 'en-US', 'Catch failed, Pokemon ran away', '{"params": []}', '{"category": "catch", "priority": "medium"}'),
('INSUFFICIENT_BALLS', 'en-US', 'Insufficient Pokeballs, please visit the shop', '{"params": []}', '{"category": "inventory", "priority": "high"}'),
('INVALID_BALL_TYPE', 'en-US', 'Invalid Pokeball type: {ball_type}', '{"params": [{"name": "ball_type", "type": "string", "required": true}]}', '{"category": "inventory", "priority": "medium"}'),

-- 道馆相关 - 英文
('GYM_NOT_FOUND', 'en-US', 'Gym not found', '{"params": []}', '{"category": "gym", "priority": "high"}'),
('GYM_BATTLE_COOLDOWN', 'en-US', 'Gym battle on cooldown, please wait {cooldown} seconds', '{"params": [{"name": "cooldown", "type": "number", "required": true}]}', '{"category": "gym", "priority": "medium"}'),
('GYM_TEAM_FULL', 'en-US', 'Gym defense team is full', '{"params": []}', '{"category": "gym", "priority": "medium"}'),

-- 社交相关 - 英文
('FRIEND_ALREADY_EXISTS', 'en-US', 'This user is already your friend', '{"params": []}', '{"category": "social", "priority": "low"}'),
('FRIEND_REQUEST_PENDING', 'en-US', 'Friend request already sent, awaiting confirmation', '{"params": []}', '{"category": "social", "priority": "low"}'),
('USER_NOT_FOUND', 'en-US', 'User not found: {user_id}', '{"params": [{"name": "user_id", "type": "string", "required": true}]}', '{"category": "user", "priority": "high"}'),

-- 支付相关 - 英文
('PAYMENT_FAILED', 'en-US', 'Payment failed, please check your payment method', '{"params": []}', '{"category": "payment", "priority": "critical"}'),
('INSUFFICIENT_BALANCE', 'en-US', 'Insufficient balance, please top up', '{"params": []}', '{"category": "payment", "priority": "high"}'),
('TRANSACTION_NOT_FOUND', 'en-US', 'Transaction not found', '{"params": []}', '{"category": "payment", "priority": "medium"}'),

-- 核心错误 - 日文
('SUCCESS', 'ja-JP', '操作が成功しました', '{"params": []}', '{"category": "core", "priority": "high"}'),
('INVALID_REQUEST', 'ja-JP', 'リクエストパラメータが無効です: {field}', '{"params": [{"name": "field", "type": "string", "required": true}]}', '{"category": "validation", "priority": "high"}'),
('UNAUTHORIZED', 'ja-JP', '認証されていません。ログインしてください', '{"params": []}', '{"category": "auth", "priority": "critical"}'),
('FORBIDDEN', 'ja-JP', '権限がありません', '{"params": []}', '{"category": "auth", "priority": "high"}'),
('NOT_FOUND', 'ja-JP', 'リソースが見つかりません', '{"params": []}', '{"category": "core", "priority": "medium"}'),
('INTERNAL_ERROR', 'ja-JP', 'サーバーエラーが発生しました。後でもう一度お試しください', '{"params": []}', '{"category": "system", "priority": "critical"}'),
('RATE_LIMIT_EXCEEDED', 'ja-JP', 'リクエストが多すぎます。{retry_after}秒後にお試しください', '{"params": [{"name": "retry_after", "type": "number", "required": true}]}', '{"category": "rate", "priority": "high"}')

ON CONFLICT (error_code, language) DO UPDATE SET
  message = EXCLUDED.message,
  params_template = EXCLUDED.params_template,
  metadata = EXCLUDED.metadata,
  version = error_translations.version + 1,
  updated_at = CURRENT_TIMESTAMP;

-- ============================================
-- 5. 创建视图和函数
-- ============================================

-- 缺失翻译统计视图
CREATE OR REPLACE VIEW missing_translations_summary AS
SELECT 
  et.error_code,
  COUNT(DISTINCT et.language) as translated_languages,
  array_agg(DISTINCT et.language) as available_languages,
  (SELECT COUNT(*) FROM (SELECT unnest(ARRAY['zh-CN', 'en-US', 'ja-JP']) as lang) t) as expected_total,
  (SELECT COUNT(*) FROM (SELECT unnest(ARRAY['zh-CN', 'en-US', 'ja-JP']) as lang) t) - COUNT(DISTINCT et.language) as missing_count
FROM error_translations et
GROUP BY et.error_code
HAVING COUNT(DISTINCT et.language) < 3;

-- 翻译覆盖率视图
CREATE OR REPLACE VIEW translation_coverage AS
SELECT 
  language,
  COUNT(*) as translation_count,
  COUNT(DISTINCT error_code) as unique_codes,
  ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(DISTINCT error_code) FROM error_translations), 0), 2) as coverage_percentage
FROM error_translations
GROUP BY language;

-- 自动更新缺失翻译告警的函数
CREATE OR REPLACE FUNCTION update_missing_translation_alerts()
RETURNS void AS $$
BEGIN
  -- 插入新检测到的缺失翻译
  INSERT INTO missing_translation_alerts (error_code, missing_languages, severity)
  SELECT 
    mts.error_code,
    ARRAY(
      SELECT unnest(ARRAY['zh-CN', 'en-US', 'ja-JP']) 
      EXCEPT 
      SELECT unnest(mts.available_languages)
    ),
    CASE 
      WHEN mts.missing_count >= 2 THEN 'critical'
      WHEN mts.missing_count = 1 THEN 'warning'
      ELSE 'info'
    END
  FROM missing_translations_summary mts
  WHERE NOT EXISTS (
    SELECT 1 FROM missing_translation_alerts mta WHERE mta.error_code = mts.error_code
  )
  ON CONFLICT (error_code) DO UPDATE SET
    missing_languages = EXCLUDED.missing_languages,
    last_detected = CURRENT_TIMESTAMP,
    detection_count = missing_translation_alerts.detection_count + 1;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 6. 定时任务：每天检查缺失翻译
-- ============================================
-- 需要在 cron 中配置或使用 pg_cron 扩展
-- SELECT cron.schedule('check-missing-translations', '0 2 * * *', 'SELECT update_missing_translation_alerts()');

-- ============================================
-- 完成
-- ============================================
-- 迁移完成时间: 2026-07-01 00:00 UTC
