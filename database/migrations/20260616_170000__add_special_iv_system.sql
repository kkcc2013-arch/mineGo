-- REQ-00160: 精灵特殊个体值（彩蛋）系统
-- 添加特殊 IV 标识字段

-- 添加特殊 IV 标识字段到 pokemon_instances 表
ALTER TABLE pokemon_instances 
ADD COLUMN IF NOT EXISTS is_zero_iv BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_perfect_iv BOOLEAN DEFAULT FALSE;

-- 添加索引以支持快速查询特殊 IV 精灵
CREATE INDEX IF NOT EXISTS idx_pokemon_zero_iv 
  ON pokemon_instances(is_zero_iv) WHERE is_zero_iv = TRUE;
CREATE INDEX IF NOT EXISTS idx_pokemon_perfect_iv 
  ON pokemon_instances(is_perfect_iv) WHERE is_perfect_iv = TRUE;
CREATE INDEX IF NOT EXISTS idx_pokemon_lucky 
  ON pokemon_instances(is_lucky) WHERE is_lucky = TRUE;

-- 添加特殊 IV 统计视图
CREATE OR REPLACE VIEW special_iv_stats AS
SELECT 
  COUNT(*) FILTER (WHERE is_zero_iv = TRUE) as zero_iv_count,
  COUNT(*) FILTER (WHERE is_perfect_iv = TRUE) as perfect_iv_count,
  COUNT(*) FILTER (WHERE is_lucky = TRUE) as lucky_count,
  COUNT(*) as total_count
FROM pokemon_instances;

-- 添加用户特殊 IV 统计视图
CREATE OR REPLACE VIEW user_special_iv_stats AS
SELECT 
  user_id,
  COUNT(*) FILTER (WHERE is_zero_iv = TRUE) as zero_iv_count,
  COUNT(*) FILTER (WHERE is_perfect_iv = TRUE) as perfect_iv_count,
  COUNT(*) FILTER (WHERE is_lucky = TRUE) as lucky_count,
  COUNT(*) as total_count
FROM pokemon_instances
GROUP BY user_id;

-- 添加注释
COMMENT ON COLUMN pokemon_instances.is_zero_iv IS '零 IV 精灵标识（攻击/防御/HP 都是 0），稀有收藏品';
COMMENT ON COLUMN pokemon_instances.is_perfect_iv IS '完美 IV 精灵标识（攻击/防御/HP 都是 15），100% 完美度';

-- 插入特殊 IV 配置到系统配置表（如果存在）
INSERT INTO system_config (key, value, description, created_at)
VALUES (
  'special_iv_rates',
  '{"zero_iv_rate": 0.0001, "perfect_iv_rate": 0.001, "lucky_trade_rate": 0.05, "lucky_iv_floor": 12}'::jsonb,
  '特殊 IV 出现概率配置',
  NOW()
) ON CONFLICT (key) DO UPDATE SET 
  value = EXCLUDED.value,
  description = EXCLUDED.description;
