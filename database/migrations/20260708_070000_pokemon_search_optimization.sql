-- REQ-00498: 精灵搜索与排序查询性能优化系统
-- 数据库迁移脚本

-- 复合索引：用户精灵列表高频查询
CREATE INDEX IF NOT EXISTS idx_pokemon_user_cp_desc ON pokemon_instances(user_id, cp DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_user_created_desc ON pokemon_instances(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_user_species ON pokemon_instances(user_id, species_id);

-- 类型筛选索引
-- 已移除：pokemon_instances 没有 types 列（属性在 pokemon_species.type1/type2），按属性筛选需 JOIN species

-- CP 范围筛选索引（部分索引）
CREATE INDEX IF NOT EXISTS idx_pokemon_user_cp_high ON pokemon_instances(user_id, cp) WHERE cp >= 2000;
CREATE INDEX IF NOT EXISTS idx_pokemon_user_cp_mid ON pokemon_instances(user_id, cp) WHERE cp BETWEEN 500 AND 2000;

-- 全文搜索扩展
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 全文搜索索引（精灵昵称）
CREATE INDEX IF NOT EXISTS idx_pokemon_nickname_trgm ON pokemon_instances USING gin (nickname gin_trgm_ops);

-- 精灵种类名称搜索索引
CREATE INDEX IF NOT EXISTS idx_pokemon_species_name_trgm ON pokemon_species USING gin (name_zh gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_pokemon_species_name_en_trgm ON pokemon_species USING gin (name_en gin_trgm_ops);

-- 搜索辅助表
CREATE TABLE IF NOT EXISTS pokemon_search_cache (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  search_term VARCHAR(100) NOT NULL,
  result_ids JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  UNIQUE(user_id, search_term)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE pokemon_search_cache ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE pokemon_search_cache ADD COLUMN IF NOT EXISTS search_term VARCHAR(100);
ALTER TABLE pokemon_search_cache ADD COLUMN IF NOT EXISTS result_ids JSONB;
ALTER TABLE pokemon_search_cache ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE pokemon_search_cache ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_search_cache_user_term ON pokemon_search_cache(user_id, search_term);
CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON pokemon_search_cache(expires_at);

-- 清理过期搜索缓存的定时任务
CREATE OR REPLACE FUNCTION clean_expired_search_cache()
RETURNS void AS $$
BEGIN
  DELETE FROM pokemon_search_cache WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- 创建定时清理任务（每小时执行）
DO $cron$ BEGIN IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN PERFORM cron.schedule('clean_search_cache', '0 * * * *', 'SELECT clean_expired_search_cache()'); END IF; END $cron$;
