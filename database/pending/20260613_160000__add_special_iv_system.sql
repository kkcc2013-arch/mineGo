-- REQ-00160: 精灵特殊个体值（彩蛋）系统
-- 创建时间: 2026-06-13 16:00
-- 描述: 添加零 IV、完美 IV 字段，以及幸运精灵机制

-- 1. 添加 wild_pokemon 表的特殊 IV 字段
ALTER TABLE wild_pokemon 
ADD COLUMN IF NOT EXISTS is_zero_iv BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_perfect_iv BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN wild_pokemon.is_zero_iv IS '零 IV 精灵标识（攻击/防御/HP 都是 0，稀有收藏品）';
COMMENT ON COLUMN wild_pokemon.is_perfect_iv IS '完美 IV 精灵标识（攻击/防御/HP 都是 15，100% IV）';

-- 2. 添加 pokemon_instances 表的特殊 IV 字段（如果不存在）
ALTER TABLE pokemon_instances 
ADD COLUMN IF NOT EXISTS is_zero_iv BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_perfect_iv BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS is_lucky BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN pokemon_instances.is_zero_iv IS '零 IV 精灵标识';
COMMENT ON COLUMN pokemon_instances.is_perfect_iv IS '完美 IV 精灵标识';
COMMENT ON COLUMN pokemon_instances.is_lucky IS '幸运精灵标识（交换时有几率获得，IV 下限 12）';

-- 3. 添加索引以支持快速查询特殊 IV 精灵
CREATE INDEX IF NOT EXISTS idx_wild_pokemon_zero_iv 
ON wild_pokemon(is_zero_iv) WHERE is_zero_iv = TRUE;

CREATE INDEX IF NOT EXISTS idx_wild_pokemon_perfect_iv 
ON wild_pokemon(is_perfect_iv) WHERE is_perfect_iv = TRUE;

CREATE INDEX IF NOT EXISTS idx_pokemon_instances_zero_iv 
ON pokemon_instances(is_zero_iv) WHERE is_zero_iv = TRUE;

CREATE INDEX IF NOT EXISTS idx_pokemon_instances_perfect_iv 
ON pokemon_instances(is_perfect_iv) WHERE is_perfect_iv = TRUE;

CREATE INDEX IF NOT EXISTS idx_pokemon_instances_lucky 
ON pokemon_instances(is_lucky) WHERE is_lucky = TRUE;

-- 4. 添加用户特殊 IV 统计表
CREATE TABLE IF NOT EXISTS user_special_iv_stats (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  zero_iv_count INTEGER DEFAULT 0,
  perfect_iv_count INTEGER DEFAULT 0,
  lucky_count INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE user_special_iv_stats IS '用户特殊 IV 精灵统计表';

-- 5. 创建更新特殊 IV 统计的触发器函数
CREATE OR REPLACE FUNCTION update_special_iv_stats()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO user_special_iv_stats (user_id, zero_iv_count, perfect_iv_count, lucky_count, last_updated)
    VALUES (NEW.user_id, 
            CASE WHEN NEW.is_zero_iv THEN 1 ELSE 0 END,
            CASE WHEN NEW.is_perfect_iv THEN 1 ELSE 0 END,
            CASE WHEN NEW.is_lucky THEN 1 ELSE 0 END,
            NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      zero_iv_count = user_special_iv_stats.zero_iv_count + CASE WHEN NEW.is_zero_iv THEN 1 ELSE 0 END,
      perfect_iv_count = user_special_iv_stats.perfect_iv_count + CASE WHEN NEW.is_perfect_iv THEN 1 ELSE 0 END,
      lucky_count = user_special_iv_stats.lucky_count + CASE WHEN NEW.is_lucky THEN 1 ELSE 0 END,
      last_updated = NOW();
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 6. 创建触发器（如果不存在）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_update_special_iv_stats'
  ) THEN
    CREATE TRIGGER trigger_update_special_iv_stats
    AFTER INSERT ON pokemon_instances
    FOR EACH ROW
    EXECUTE FUNCTION update_special_iv_stats();
  END IF;
END $$;

-- 7. 添加 Prometheus 指标相关的物化视图
CREATE MATERIALIZED VIEW IF NOT EXISTS special_iv_spawn_stats AS
SELECT 
  DATE(created_at) as spawn_date,
  COUNT(*) FILTER (WHERE is_zero_iv = TRUE) as zero_iv_count,
  COUNT(*) FILTER (WHERE is_perfect_iv = TRUE) as perfect_iv_count,
  COUNT(*) as total_spawns,
  ROUND(100.0 * COUNT(*) FILTER (WHERE is_zero_iv = TRUE) / NULLIF(COUNT(*), 0), 4) as zero_iv_rate,
  ROUND(100.0 * COUNT(*) FILTER (WHERE is_perfect_iv = TRUE) / NULLIF(COUNT(*), 0), 4) as perfect_iv_rate
FROM wild_pokemon
GROUP BY DATE(created_at)
ORDER BY spawn_date DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_special_iv_spawn_stats_date 
ON special_iv_spawn_stats(spawn_date);

COMMENT ON MATERIALIZED VIEW special_iv_spawn_stats IS '特殊 IV 精灵生成统计（每日汇总）';

-- 8. 插入默认的幸运精灵配置
INSERT INTO game_configs (key, value, description, updated_at)
VALUES 
  ('lucky_pokemon_chance', '0.05', '幸运精灵出现概率（交换时）', NOW()),
  ('lucky_pokemon_iv_floor', '12', '幸运精灵 IV 下限值', NOW()),
  ('zero_iv_chance', '0.0001', '零 IV 精灵出现概率', NOW()),
  ('perfect_iv_chance', '0.001', '完美 IV 精灵出现概率（包含零 IV）', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- 9. 添加索引优化图鉴查询
CREATE INDEX IF NOT EXISTS idx_pokemon_instances_user_special 
ON pokemon_instances(user_id, is_zero_iv, is_perfect_iv, is_lucky);
