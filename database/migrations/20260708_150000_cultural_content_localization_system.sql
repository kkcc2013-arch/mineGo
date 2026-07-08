-- database/migrations/20260708_150000_cultural_content_localization_system.sql
-- REQ-00495: 文化敏感内容本地化过滤与合规适配系统

-- 文化内容规则表
CREATE TABLE IF NOT EXISTS cultural_content_rules (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,     -- pokemon/skill/item/activity/ugc
  entity_id INTEGER,
  content_field VARCHAR(50),            -- name/description/image
  sensitivity_level VARCHAR(20) NOT NULL CHECK (sensitivity_level IN ('low', 'medium', 'high', 'critical')),
  cultural_context VARCHAR(50) NOT NULL CHECK (cultural_context IN ('religion', 'politics', 'violence', 'gambling', 'adult', 'cultural')),
  affected_regions JSONB,                 -- ["CN", "JP", "DE", "SA"]
  restriction_type VARCHAR(20) NOT NULL CHECK (restriction_type IN ('hide', 'rename', 'warn', 'age_gate', 'replace_image')),
  alternative_content JSONB,              -- {"name": {"zh-CN": "替代名称"}}
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cultural_rules_entity ON cultural_content_rules(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_cultural_rules_regions ON cultural_content_rules USING GIN(affected_regions);
CREATE INDEX IF NOT EXISTS idx_cultural_rules_sensitivity ON cultural_content_rules(sensitivity_level);
CREATE INDEX IF NOT EXISTS idx_cultural_rules_cultural ON cultural_content_rules(cultural_context);

-- 地区限制实体表（精灵/道具/技能）
CREATE TABLE IF NOT EXISTS region_restricted_entities (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  region_code VARCHAR(10) NOT NULL,       -- ISO 3166-1 alpha-2
  restriction_level VARCHAR(20) NOT NULL CHECK (restriction_level IN ('blocked', 'restricted', 'modified')),
  reason TEXT,
  alternative_content JSONB,
  effective_from TIMESTAMP,
  effective_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(entity_type, entity_id, region_code)
);

CREATE INDEX IF NOT EXISTS idx_region_restricted_lookup ON region_restricted_entities(entity_type, entity_id, region_code);
CREATE INDEX IF NOT EXISTS idx_region_restricted_level ON region_restricted_entities(restriction_level);

-- 内容年龄分级表
CREATE TABLE IF NOT EXISTS content_age_ratings (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  rating_system VARCHAR(20) NOT NULL CHECK (rating_system IN ('PEGI', 'ESRB', 'CERO', 'CADPA', 'GRAC', 'ACB')),
  region_code VARCHAR(10) NOT NULL,
  age_rating VARCHAR(20) NOT NULL,
  content_descriptors JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(entity_type, entity_id, rating_system, region_code)
);

CREATE INDEX IF NOT EXISTS idx_age_ratings_entity ON content_age_ratings(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_age_ratings_region ON content_age_ratings(region_code);
CREATE INDEX IF NOT EXISTS idx_age_ratings_system ON content_age_ratings(rating_system);

-- 合规规则配置表
CREATE TABLE IF NOT EXISTS compliance_rules (
  id SERIAL PRIMARY KEY,
  region_code VARCHAR(10) NOT NULL,
  rule_type VARCHAR(50) NOT NULL,
  rule_config JSONB NOT NULL,
  effective_from TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(region_code, rule_type)
);

CREATE INDEX IF NOT EXISTS idx_compliance_rules_region ON compliance_rules(region_code);
CREATE INDEX IF NOT EXISTS idx_compliance_rules_type ON compliance_rules(rule_type);

-- 文化敏感词库表
CREATE TABLE IF NOT EXISTS cultural_sensitive_words (
  id SERIAL PRIMARY KEY,
  word VARCHAR(255) NOT NULL,
  language VARCHAR(10) NOT NULL,
  sensitivity_type VARCHAR(50) NOT NULL CHECK (sensitivity_type IN ('religion', 'politics', 'offensive', 'adult', 'cultural', 'trademark')),
  cultural_context VARCHAR(100),
  action VARCHAR(20) DEFAULT 'reject' CHECK (action IN ('reject', 'warn', 'review')),
  severity INTEGER DEFAULT 50 CHECK (severity BETWEEN 0 AND 100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sensitive_words_lookup ON cultural_sensitive_words(word, language);
CREATE INDEX IF NOT EXISTS idx_sensitive_words_type ON cultural_sensitive_words(sensitivity_type);

-- 用户合规记录表
CREATE TABLE IF NOT EXISTS user_compliance_records (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  region_code VARCHAR(10) NOT NULL,
  age_verified BOOLEAN DEFAULT false,
  verified_age INTEGER,
  gdpr_consent BOOLEAN DEFAULT false,
  coppa_consent BOOLEAN DEFAULT false,
  consent_version VARCHAR(20),
  consent_date TIMESTAMP,
  last_check TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, region_code)
);

CREATE INDEX IF NOT EXISTS idx_compliance_user ON user_compliance_records(user_id);

-- 内容审核记录表
CREATE TABLE IF NOT EXISTS content_moderation_logs (
  id SERIAL PRIMARY KEY,
  content_type VARCHAR(50) NOT NULL,
  content_id VARCHAR(100),
  user_id UUID,
  original_content TEXT,
  filtered_content TEXT,
  detected_violations JSONB,
  action_taken VARCHAR(20) NOT NULL,
  region_code VARCHAR(10),
  moderator_id INTEGER,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'escalated')),
  created_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_moderation_status ON content_moderation_logs(status);
CREATE INDEX IF NOT EXISTS idx_moderation_user ON content_moderation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_moderation_type ON content_moderation_logs(content_type);

-- 插入初始文化敏感内容规则示例
INSERT INTO cultural_content_rules (entity_type, entity_id, content_field, sensitivity_level, cultural_context, affected_regions, restriction_type, alternative_content)
VALUES
  -- 示例1：龙类精灵在中东地区需要改名
  ('pokemon', 149, 'name', 'medium', 'cultural', '["SA", "AE", "KW", "QA"]'::jsonb, 'rename', '{"name": {"ar": "精灵149"}}'::jsonb),
  ('pokemon', 149, 'description', 'medium', 'cultural', '["SA", "AE", "KW", "QA"]'::jsonb, 'replace_image', '{"description": {"ar": "神秘精灵"}}'::jsonb),
  
  -- 示例2：暴力内容在德国需要年龄分级
  ('pokemon', 94, 'image', 'high', 'violence', '["DE"]'::jsonb, 'age_gate', NULL),
  
  -- 示例3：万圣节活动在中国大陆不显示
  ('activity', 1001, 'name', 'low', 'cultural', '["CN"]'::jsonb, 'hide', NULL)
ON CONFLICT DO NOTHING;

-- 插入初始地区限制实体
INSERT INTO region_restricted_entities (entity_type, entity_id, region_code, restriction_level, reason)
VALUES
  -- 示例：某些精灵在特定地区被屏蔽
  ('pokemon', 200, 'CN', 'blocked', '文化敏感性'),
  ('pokemon', 200, 'SA', 'modified', '宗教敏感性'),
  
  -- 示例：赌博相关道具在日本需要限制
  ('item', 501, 'JP', 'restricted', '赌博要素限制')
ON CONFLICT (entity_type, entity_id, region_code) DO NOTHING;

-- 插入初始年龄分级数据
INSERT INTO content_age_ratings (entity_type, entity_id, rating_system, region_code, age_rating, content_descriptors)
VALUES
  -- 全项目基础分级
  ('game', 1, 'PEGI', 'DE', '12', '["violence", "online"]'::jsonb),
  ('game', 1, 'ESRB', 'US', 'T', '["violence", "users_interact"]'::jsonb),
  ('game', 1, 'CERO', 'JP', 'B', '["violence"]'::jsonb),
  ('game', 1, 'CADPA', 'CN', '12+', '["violence"]'::jsonb),
  ('game', 1, 'GRAC', 'KR', '12', '["violence"]'::jsonb)
ON CONFLICT DO NOTHING;

-- 插入初始合规规则
INSERT INTO compliance_rules (region_code, rule_type, rule_config, is_active)
VALUES
  -- 中国防沉迷规则
  ('CN', 'playtime_limit', '{"daily_limit_hours": 1.5, "night_restriction": {"start_hour": 22, "end_hour": 8}, "age_threshold": 18}', true),
  ('CN', 'payment_limit', '{"max_single_amount": 50, "max_monthly_amount": 200, "age_threshold": 16}', true),
  ('CN', 'real_name_verification', '{"required": true, "providers": ["tencent", "netease"]}', true),
  
  -- 日本支付限制
  ('JP', 'payment_limit', '{"max_single_amount": 5000, "age_threshold": 20}', true),
  ('JP', 'gambling_restriction', '{"gacha_disclosure": true, "probability_display": true}', true),
  
  -- 欧洲GDPR合规
  ('DE', 'gdpr_consent', '{"required": true, "consent_age": 16}', true),
  ('GB', 'gdpr_consent', '{"required": true, "consent_age": 13}', true),
  
  -- 美国COPPA合规
  ('US', 'coppa_compliance', '{"age_threshold": 13, "parental_consent_required": true}', true),
  
  -- 中东地区宗教合规
  ('SA', 'content_filter', '{"religious_content": true, "violence_level": "low"}', true),
  ('AE', 'content_filter', '{"religious_content": true, "violence_level": "low"}', true)
ON CONFLICT (region_code, rule_type) DO NOTHING;

-- 插入初始文化敏感词库
INSERT INTO cultural_sensitive_words (word, language, sensitivity_type, cultural_context, action, severity)
VALUES
  -- 政治敏感词（中文）
  ('政治敏感词1', 'zh', 'politics', '中国政治敏感性', 'reject', 100),
  ('政治敏感词2', 'zh', 'politics', '中国政治敏感性', 'reject', 100),
  
  -- 宗教敏感词（阿拉伯语）
  ('الله', 'ar', 'religion', '伊斯兰教神圣名称', 'review', 90),
  ('Jesus', 'en', 'religion', '基督教相关', 'warn', 60),
  
  -- 商标敏感词
  ('Pokemon', 'en', 'trademark', '任天堂商标', 'review', 70),
  ('Pokémon', 'en', 'trademark', '任天堂商标', 'review', 70),
  
  -- 冒犯性词汇（示例）
  ('示例冒犯词', 'zh', 'offensive', '冒犯性内容', 'reject', 100)
ON CONFLICT DO NOTHING;

-- 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_cultural_rules_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_cultural_rules
BEFORE UPDATE ON cultural_content_rules
FOR EACH ROW
EXECUTE FUNCTION update_cultural_rules_timestamp();

CREATE TRIGGER trigger_update_compliance_rules
BEFORE UPDATE ON compliance_rules
FOR EACH ROW
EXECUTE FUNCTION update_cultural_rules_timestamp();

CREATE TRIGGER trigger_update_user_compliance
BEFORE UPDATE ON user_compliance_records
FOR EACH ROW
EXECUTE FUNCTION update_cultural_rules_timestamp();

-- 视图：活跃的文化规则
CREATE OR REPLACE VIEW v_active_cultural_rules AS
SELECT 
  ccr.*,
  CASE 
    WHEN ccr.sensitivity_level = 'critical' THEN 4
    WHEN ccr.sensitivity_level = 'high' THEN 3
    WHEN ccr.sensitivity_level = 'medium' THEN 2
    ELSE 1
  END AS priority
FROM cultural_content_rules ccr
WHERE ccr.affected_regions IS NOT NULL
  AND jsonb_array_length(ccr.affected_regions) > 0
ORDER BY priority DESC;

-- 视图：地区合规规则汇总
CREATE OR REPLACE VIEW v_region_compliance_summary AS
SELECT 
  region_code,
  jsonb_object_agg(rule_type, rule_config) AS rules,
  array_agg(rule_type) AS active_rules
FROM compliance_rules
WHERE is_active = true
  AND (effective_from IS NULL OR effective_from <= NOW())
GROUP BY region_code;

-- 注释
COMMENT ON TABLE cultural_content_rules IS '文化内容规则配置表';
COMMENT ON TABLE region_restricted_entities IS '地区限制实体表';
COMMENT ON TABLE content_age_ratings IS '内容年龄分级表';
COMMENT ON TABLE compliance_rules IS '合规规则配置表';
COMMENT ON TABLE cultural_sensitive_words IS '文化敏感词库';
COMMENT ON TABLE user_compliance_records IS '用户合规记录表';
COMMENT ON TABLE content_moderation_logs IS '内容审核记录表';
