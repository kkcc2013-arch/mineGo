-- 区域化内容分发系统数据库迁移
-- 创建时间：2026-06-14 01:00 UTC
-- 需求：REQ-00083

-- =====================================================
-- 1. 区域定义表
-- =====================================================
CREATE TABLE IF NOT EXISTS regions (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,           -- 区域代码 如 CN, CN-BJ, US-CA
  parent_code VARCHAR(20),                    -- 父区域代码
  name VARCHAR(100) NOT NULL,                 -- 区域名称
  level VARCHAR(20) NOT NULL CHECK (level IN ('country', 'province', 'city')),
  geo_bounds JSONB,                           -- 地理边界 GeoJSON
  timezone VARCHAR(50),                       -- 默认时区
  currency VARCHAR(10),                       -- 默认货币
  language VARCHAR(10),                       -- 默认语言
  compliance_rules JSONB,                     -- 合规规则
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT fk_parent_region FOREIGN KEY (parent_code) 
    REFERENCES regions(code) ON DELETE SET NULL
);

CREATE INDEX idx_regions_code ON regions(code);
CREATE INDEX idx_regions_parent ON regions(parent_code);
CREATE INDEX idx_regions_level ON regions(level);
CREATE INDEX idx_regions_active ON regions(is_active);

COMMENT ON TABLE regions IS '区域定义表，支持国家/省份/城市三级';
COMMENT ON COLUMN regions.code IS '区域代码：ISO 3166-1 国家代码或自定义地区代码';
COMMENT ON COLUMN regions.geo_bounds IS '地理边界 GeoJSON 格式，用于自动区域检测';
COMMENT ON COLUMN regions.compliance_rules IS '合规规则 JSON 配置';

-- =====================================================
-- 2. 区域精灵权重配置表
-- =====================================================
CREATE TABLE IF NOT EXISTS region_pokemon_weights (
  id SERIAL PRIMARY KEY,
  region_code VARCHAR(20) NOT NULL,
  pokemon_id INTEGER NOT NULL,
  spawn_weight DECIMAL(5,4) DEFAULT 1.0,      -- 刷新权重 (0.0-10.0)
  is_exclusive BOOLEAN DEFAULT false,         -- 是否区域专属
  start_date TIMESTAMP,                       -- 生效开始时间
  end_date TIMESTAMP,                         -- 生效结束时间
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT fk_region_weights FOREIGN KEY (region_code) 
    REFERENCES regions(code) ON DELETE CASCADE,
  CONSTRAINT unique_region_pokemon UNIQUE (region_code, pokemon_id),
  CONSTRAINT valid_spawn_weight CHECK (spawn_weight >= 0 AND spawn_weight <= 10)
);

CREATE INDEX idx_region_pokemon_weights_region ON region_pokemon_weights(region_code);
CREATE INDEX idx_region_pokemon_weights_pokemon ON region_pokemon_weights(pokemon_id);
CREATE INDEX idx_region_pokemon_weights_dates ON region_pokemon_weights(start_date, end_date);

COMMENT ON TABLE region_pokemon_weights IS '区域精灵刷新权重配置，支持区域专属和权重调整';
COMMENT ON COLUMN region_pokemon_weights.spawn_weight IS '刷新权重倍数，1.0 为标准权重';
COMMENT ON COLUMN region_pokemon_weights.is_exclusive IS '是否为该区域专属精灵，其他区域不刷新';

-- =====================================================
-- 3. 区域活动配置表
-- =====================================================
CREATE TABLE IF NOT EXISTS region_events (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(50) NOT NULL,
  region_codes TEXT[] NOT NULL,               -- 适用区域列表
  title JSONB NOT NULL,                       -- 多语言标题 {"zh": "春节活动", "en": "Spring Festival"}
  description JSONB NOT NULL,                 -- 多语言描述
  event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
    'spawn_bonus', 'catch_bonus', 'stardust_bonus', 
    'xp_bonus', 'item_bonus', 'special_pokemon'
  )),
  bonuses JSONB NOT NULL,                     -- 奖励配置
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT valid_event_times CHECK (end_time > start_time)
);

CREATE INDEX idx_region_events_event_id ON region_events(event_id);
CREATE INDEX idx_region_events_regions ON region_events USING GIN(region_codes);
CREATE INDEX idx_region_events_time ON region_events(start_time, end_time);
CREATE INDEX idx_region_events_active ON region_events(is_active);

COMMENT ON TABLE region_events IS '区域活动配置，支持按地区定制活动';
COMMENT ON COLUMN region_events.region_codes IS '适用区域代码数组，如 {CN, JP, KR}';
COMMENT ON COLUMN region_events.bonuses IS '奖励配置 JSON，如 {"catchRate": 1.5, "stardustMultiplier": 2.0}';

-- =====================================================
-- 4. 合规过滤规则表
-- =====================================================
CREATE TABLE IF NOT EXISTS compliance_rules (
  id SERIAL PRIMARY KEY,
  region_code VARCHAR(20) NOT NULL,
  content_type VARCHAR(50) NOT NULL CHECK (content_type IN (
    'pokemon', 'item', 'event', 'sprite', 'text', 'audio'
  )),
  content_id INTEGER,                         -- 内容ID (null表示全部)
  filter_action VARCHAR(20) NOT NULL CHECK (filter_action IN (
    'hide', 'modify', 'restrict', 'warn', 'age_gate'
  )),
  modified_content JSONB,                     -- 替换内容
  reason VARCHAR(200),                        -- 过滤原因
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT fk_region_compliance FOREIGN KEY (region_code) 
    REFERENCES regions(code) ON DELETE CASCADE
);

CREATE INDEX idx_compliance_rules_region ON compliance_rules(region_code);
CREATE INDEX idx_compliance_rules_content ON compliance_rules(content_type, content_id);
CREATE INDEX idx_compliance_rules_action ON compliance_rules(filter_action);

COMMENT ON TABLE compliance_rules IS '合规过滤规则，用于自动过滤或修改敏感内容';
COMMENT ON COLUMN compliance_rules.filter_action IS '过滤动作：hide-隐藏, modify-替换, restrict-限制访问';

-- =====================================================
-- 5. 区域用户映射表（缓存）
-- =====================================================
CREATE TABLE IF NOT EXISTS user_regions (
  user_id VARCHAR(50) PRIMARY KEY,
  region_code VARCHAR(20) NOT NULL,
  detected_at TIMESTAMP DEFAULT NOW(),
  last_updated TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT fk_user_region FOREIGN KEY (region_code) 
    REFERENCES regions(code) ON DELETE SET NULL
);

CREATE INDEX idx_user_regions_region ON user_regions(region_code);

COMMENT ON TABLE user_regions IS '用户区域映射缓存，避免重复检测';

-- =====================================================
-- 6. 初始数据：常用区域
-- =====================================================
INSERT INTO regions (code, name, level, timezone, currency, language, compliance_rules) VALUES
('CN', '中国', 'country', 'Asia/Shanghai', 'CNY', 'zh-CN', 
  '{"restricted_pokemon": [], "content_rating": "general", "gambling_restricted": true}'),
('JP', '日本', 'country', 'Asia/Tokyo', 'JPY', 'ja-JP', 
  '{"restricted_pokemon": [], "content_rating": "general"}'),
('KR', '韩国', 'country', 'Asia/Seoul', 'KRW', 'ko-KR', 
  '{"restricted_pokemon": [], "content_rating": "general"}'),
('US', '美国', 'country', 'America/New_York', 'USD', 'en-US', 
  '{"restricted_pokemon": [], "content_rating": "teen"}'),
('GB', '英国', 'country', 'Europe/London', 'GBP', 'en-GB', 
  '{"restricted_pokemon": [], "content_rating": "teen"}'),
('DE', '德国', 'country', 'Europe/Berlin', 'EUR', 'de-DE', 
  '{"restricted_pokemon": [], "content_rating": "teen", "gdpr_strict": true}'),
('AU', '澳大利亚', 'country', 'Australia/Sydney', 'AUD', 'en-AU', 
  '{"restricted_pokemon": [], "content_rating": "general"}'),
('BR', '巴西', 'country', 'America/Sao_Paulo', 'BRL', 'pt-BR', 
  '{"restricted_pokemon": [], "content_rating": "general"}'),
('IN', '印度', 'country', 'Asia/Kolkata', 'INR', 'en-IN', 
  '{"restricted_pokemon": [], "content_rating": "general"}'),
('AE', '阿联酋', 'country', 'Asia/Dubai', 'AED', 'ar-AE', 
  '{"restricted_pokemon": [], "content_rating": "general", "religious_restrictions": true}')
ON CONFLICT (code) DO NOTHING;

-- =====================================================
-- 7. 触发器：自动更新 updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_regions_updated_at BEFORE UPDATE ON regions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_region_pokemon_weights_updated_at BEFORE UPDATE ON region_pokemon_weights
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_region_events_updated_at BEFORE UPDATE ON region_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_compliance_rules_updated_at BEFORE UPDATE ON compliance_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 8. 视图：活动精灵权重
-- =====================================================
CREATE OR REPLACE VIEW active_region_pokemon_weights AS
SELECT 
  rpw.region_code,
  rpw.pokemon_id,
  rpw.spawn_weight,
  rpw.is_exclusive,
  r.name as region_name
FROM region_pokemon_weights rpw
JOIN regions r ON r.code = rpw.region_code
WHERE (rpw.start_date IS NULL OR rpw.start_date <= NOW())
  AND (rpw.end_date IS NULL OR rpw.end_date >= NOW())
  AND r.is_active = true;

COMMENT ON VIEW active_region_pokemon_weights IS '当前生效的区域精灵权重配置';

-- =====================================================
-- 9. 视图：当前活动
-- =====================================================
CREATE OR REPLACE VIEW current_region_events AS
SELECT 
  re.*,
  array_agg(r.name) as region_names
FROM region_events re
LEFT JOIN regions r ON r.code = ANY(re.region_codes)
WHERE re.is_active = true
  AND re.start_time <= NOW()
  AND re.end_time >= NOW()
GROUP BY re.id;

COMMENT ON VIEW current_region_events IS '当前进行中的区域活动';
