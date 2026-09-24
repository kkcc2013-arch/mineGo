-- REQ-00137: 游戏内容本地化内容管理与翻译工作流系统
-- 创建时间: 2026-06-16

-- 翻译键表
CREATE TABLE IF NOT EXISTS translation_keys (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    category VARCHAR(50) NOT NULL, -- pokemon/skill/item/achievement/ui/system
    description TEXT,
    context TEXT, -- 翻译上下文说明
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE translation_keys ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE translation_keys ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE translation_keys ADD COLUMN IF NOT EXISTS context TEXT;
ALTER TABLE translation_keys ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE translation_keys ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE translation_keys ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_translation_keys_category ON translation_keys(category);
CREATE INDEX IF NOT EXISTS idx_translation_keys_active ON translation_keys(is_active);
CREATE INDEX IF NOT EXISTS idx_translation_keys_key ON translation_keys(key);

-- 翻译内容表
CREATE TABLE IF NOT EXISTS translations (
    id SERIAL PRIMARY KEY,
    key_id INTEGER NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL, -- zh-CN/en-US/ja-JP
    content TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'rejected')),
    translated_by INTEGER,
    reviewed_by INTEGER,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT translations_key_language_version_unique UNIQUE(key_id, language, version)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE translations ADD COLUMN IF NOT EXISTS key_id INTEGER;
ALTER TABLE translations ADD COLUMN IF NOT EXISTS language VARCHAR(10);
ALTER TABLE translations ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE translations ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE translations ADD COLUMN IF NOT EXISTS translated_by INTEGER;
ALTER TABLE translations ADD COLUMN IF NOT EXISTS reviewed_by INTEGER;
ALTER TABLE translations ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE translations ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE translations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE translations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_translations_key ON translations(key_id);
CREATE INDEX IF NOT EXISTS idx_translations_language ON translations(language);
CREATE INDEX IF NOT EXISTS idx_translations_status ON translations(status);
CREATE INDEX IF NOT EXISTS idx_translations_key_lang ON translations(key_id, language);

-- 翻译历史表
CREATE TABLE IF NOT EXISTS translation_history (
    id SERIAL PRIMARY KEY,
    key_id INTEGER NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL,
    old_content TEXT,
    new_content TEXT NOT NULL,
    changed_by INTEGER,
    change_reason TEXT,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE translation_history ADD COLUMN IF NOT EXISTS key_id INTEGER;
ALTER TABLE translation_history ADD COLUMN IF NOT EXISTS language VARCHAR(10);
ALTER TABLE translation_history ADD COLUMN IF NOT EXISTS old_content TEXT;
ALTER TABLE translation_history ADD COLUMN IF NOT EXISTS new_content TEXT;
ALTER TABLE translation_history ADD COLUMN IF NOT EXISTS changed_by INTEGER;
ALTER TABLE translation_history ADD COLUMN IF NOT EXISTS change_reason TEXT;
ALTER TABLE translation_history ADD COLUMN IF NOT EXISTS changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_translation_history_key ON translation_history(key_id);
CREATE INDEX IF NOT EXISTS idx_translation_history_language ON translation_history(language);
CREATE INDEX IF NOT EXISTS idx_translation_history_time ON translation_history(changed_at);

-- 翻译进度表
CREATE TABLE IF NOT EXISTS translation_progress (
    id SERIAL PRIMARY KEY,
    language VARCHAR(10) UNIQUE NOT NULL,
    total_keys INTEGER DEFAULT 0,
    translated_keys INTEGER DEFAULT 0,
    approved_keys INTEGER DEFAULT 0,
    completion_pct DECIMAL(5,2) DEFAULT 0.00,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE translation_progress ADD COLUMN IF NOT EXISTS language VARCHAR(10);
ALTER TABLE translation_progress ADD COLUMN IF NOT EXISTS total_keys INTEGER DEFAULT 0;
ALTER TABLE translation_progress ADD COLUMN IF NOT EXISTS translated_keys INTEGER DEFAULT 0;
ALTER TABLE translation_progress ADD COLUMN IF NOT EXISTS approved_keys INTEGER DEFAULT 0;
ALTER TABLE translation_progress ADD COLUMN IF NOT EXISTS completion_pct DECIMAL(5,2) DEFAULT 0.00;
ALTER TABLE translation_progress ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 翻译任务表
CREATE TABLE IF NOT EXISTS translation_tasks (
    id SERIAL PRIMARY KEY,
    key_id INTEGER NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL,
    assigned_to INTEGER,
    priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
    due_date TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT translation_tasks_key_lang_unique UNIQUE(key_id, language)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE translation_tasks ADD COLUMN IF NOT EXISTS key_id INTEGER;
ALTER TABLE translation_tasks ADD COLUMN IF NOT EXISTS language VARCHAR(10);
ALTER TABLE translation_tasks ADD COLUMN IF NOT EXISTS assigned_to INTEGER;
ALTER TABLE translation_tasks ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'normal';
ALTER TABLE translation_tasks ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE translation_tasks ADD COLUMN IF NOT EXISTS due_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE translation_tasks ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE translation_tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE translation_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_translation_tasks_assigned ON translation_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_translation_tasks_status ON translation_tasks(status);
CREATE INDEX IF NOT EXISTS idx_translation_tasks_lang ON translation_tasks(language);

-- 翻译评论表（用于翻译讨论）
CREATE TABLE IF NOT EXISTS translation_comments (
    id SERIAL PRIMARY KEY,
    key_id INTEGER NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL,
    user_id INTEGER NOT NULL,
    comment TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE translation_comments ADD COLUMN IF NOT EXISTS key_id INTEGER;
ALTER TABLE translation_comments ADD COLUMN IF NOT EXISTS language VARCHAR(10);
ALTER TABLE translation_comments ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE translation_comments ADD COLUMN IF NOT EXISTS comment TEXT;
ALTER TABLE translation_comments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_translation_comments_key ON translation_comments(key_id);
CREATE INDEX IF NOT EXISTS idx_translation_comments_key_lang ON translation_comments(key_id, language);

-- 初始化语言进度
INSERT INTO translation_progress (language) VALUES ('zh-CN'), ('en-US'), ('ja-JP')
ON CONFLICT (language) DO NOTHING;

-- 触发器：更新 updated_at
CREATE OR REPLACE FUNCTION update_translation_keys_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_translation_keys ON translation_keys;
CREATE TRIGGER trigger_update_translation_keys
    BEFORE UPDATE ON translation_keys
    FOR EACH ROW
    EXECUTE FUNCTION update_translation_keys_timestamp();

CREATE OR REPLACE FUNCTION update_translations_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_translations ON translations;
CREATE TRIGGER trigger_update_translations
    BEFORE UPDATE ON translations
    FOR EACH ROW
    EXECUTE FUNCTION update_translations_timestamp();

DROP TRIGGER IF EXISTS trigger_update_translation_tasks ON translation_tasks;
CREATE TRIGGER trigger_update_translation_tasks
    BEFORE UPDATE ON translation_tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_translation_keys_timestamp();

-- 注释
COMMENT ON TABLE translation_keys IS '翻译键表 - 定义所有需要翻译的文本键';
COMMENT ON TABLE translations IS '翻译内容表 - 存储各语言的翻译内容';
COMMENT ON TABLE translation_history IS '翻译历史表 - 记录翻译变更历史';
COMMENT ON TABLE translation_progress IS '翻译进度表 - 统计各语言翻译完成度';
COMMENT ON TABLE translation_tasks IS '翻译任务表 - 管理翻译工作任务';
COMMENT ON TABLE translation_comments IS '翻译评论表 - 用于翻译讨论';
