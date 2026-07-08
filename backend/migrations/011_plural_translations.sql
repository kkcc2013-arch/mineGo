-- 复数形式国际化数据库迁移
-- 支持 CLDR 标准复数规则的翻译存储

-- 复数翻译表
CREATE TABLE IF NOT EXISTS plural_translations (
  id SERIAL PRIMARY KEY,
  base_key VARCHAR(255) NOT NULL,
  plural_category VARCHAR(20) NOT NULL, -- one, few, many, other, etc.
  locale VARCHAR(10) NOT NULL,
  translation TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(base_key, plural_category, locale)
);

CREATE INDEX idx_plural_translations_key ON plural_translations(base_key);
CREATE INDEX idx_plural_translations_locale ON plural_translations(locale);

-- 复数规则配置表
CREATE TABLE IF NOT EXISTS plural_rules_config (
  id SERIAL PRIMARY KEY,
  locale VARCHAR(10) NOT NULL UNIQUE,
  categories JSONB NOT NULL, -- ['one', 'few', 'many', 'other']
  rules JSONB NOT NULL, -- 复数规则表达式
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 插入 CLDR 复数规则配置
INSERT INTO plural_rules_config (locale, categories, rules, description) VALUES
('zh-CN', '{"categories": ["other"]}', '{"other": ""}', '中文无复数形式'),
('en-US', '{"categories": ["one", "other"]}', '{"one": "n = 1", "other": ""}', '英语单数和其他'),
('ru-RU', '{"categories": ["one", "few", "many", "other"]}', '{"one": "n % 10 = 1 and n % 100 != 11", "few": "n % 10 in 2..4 and n % 100 not in 12..14", "many": "n % 10 = 0 or n % 10 in 5..9 or n % 100 in 11..14", "other": ""}', '俄语四种复数形式'),
('ar-SA', '{"categories": ["zero", "one", "two", "few", "many", "other"]}', '{"zero": "n = 0", "one": "n = 1", "two": "n = 2", "few": "n % 100 in 3..10", "many": "n % 100 in 11..99", "other": ""}', '阿拉伯语六种复数形式')
ON CONFLICT (locale) DO NOTHING;

-- 插入示例翻译
INSERT INTO plural_translations (base_key, plural_category, locale, translation) VALUES
('catch.success', 'one', 'en-US', 'You caught 1 Pokemon'),
('catch.success', 'other', 'en-US', 'You caught {{count}} Pokemon'),
('catch.success', 'one', 'ru-RU', 'Вы поймали 1 Покемона'),
('catch.success', 'few', 'ru-RU', 'Вы поймали {{count}} Покемона'),
('catch.success', 'many', 'ru-RU', 'Вы поймали {{count}} Покемонов'),
('catch.success', 'other', 'ru-RU', 'Вы поймали {{count}} Покемонов'),
('catch.success', 'other', 'zh-CN', '你捕获了 {{count}} 只精灵'),
('pokemon.count', 'one', 'en-US', '1 Pokemon'),
('pokemon.count', 'other', 'en-US', '{{count}} Pokemon')
ON CONFLICT DO NOTHING;