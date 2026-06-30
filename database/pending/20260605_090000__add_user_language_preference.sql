-- Migration: Add user language preference
-- Created: 2026-06-05 09:00:00
-- Description: Add language_preference column to users table for i18n support

-- Add language_preference column
ALTER TABLE users ADD COLUMN IF NOT EXISTS language_preference VARCHAR(10) DEFAULT 'zh-CN';

-- Add constraint to ensure valid language values
ALTER TABLE users ADD CONSTRAINT chk_language_preference 
  CHECK (language_preference IN ('zh-CN', 'en-US', 'ja-JP'));

-- CREATE INDEX IF NOT EXISTS for language-based queries (optional, for analytics)
CREATE INDEX IF NOT EXISTS idx_users_language ON users(language_preference);

-- Comment
COMMENT ON COLUMN users.language_preference IS 'User preferred language for UI and error messages (zh-CN, en-US, ja-JP)';
