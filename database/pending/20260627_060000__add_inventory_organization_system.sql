-- REQ-00348: 精灵背包智能整理与自动分类系统
-- 数据库迁移

-- 添加背包整理相关字段
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT FALSE;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT FALSE;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS custom_tags TEXT[] DEFAULT '{}';
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS sort_priority INTEGER DEFAULT 0;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE pokemon_instances ADD COLUMN IF NOT EXISTS nickname VARCHAR(50);

-- 添加注释
COMMENT ON COLUMN pokemon_instances.is_favorite IS '是否收藏';
COMMENT ON COLUMN pokemon_instances.is_locked IS '是否锁定（防止转移）';
COMMENT ON COLUMN pokemon_instances.custom_tags IS '用户自定义标签';
COMMENT ON COLUMN pokemon_instances.sort_priority IS '自定义排序优先级';
COMMENT ON COLUMN pokemon_instances.deleted_at IS '软删除时间';
COMMENT ON COLUMN pokemon_instances.nickname IS '精灵昵称';

-- 创建索引优化查询
CREATE INDEX IF NOT EXISTS idx_pokemon_user_favorite 
  ON pokemon_instances(user_id, is_favorite DESC, combat_power DESC)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_pokemon_user_locked 
  ON pokemon_instances(user_id, is_locked DESC, created_at DESC)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_pokemon_user_types 
  ON pokemon_instances(user_id, types[1])
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_pokemon_user_species
  ON pokemon_instances(user_id, species_id)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_pokemon_user_cp
  ON pokemon_instances(user_id, cp DESC)
  WHERE is_deleted = FALSE;

-- 用户背包偏好表
CREATE TABLE IF NOT EXISTS user_inventory_preferences (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL UNIQUE,
  primary_sort VARCHAR(50) DEFAULT 'combatPower',
  secondary_sort VARCHAR(50) DEFAULT 'rarity',
  sort_order VARCHAR(10) DEFAULT 'desc',
  default_group_by VARCHAR(50),
  custom_groups JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_inventory_preferences_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_inventory_preferences_timestamp ON user_inventory_preferences;
CREATE TRIGGER trigger_update_inventory_preferences_timestamp
  BEFORE UPDATE ON user_inventory_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_inventory_preferences_timestamp();

-- 用户糖果表（用于转移奖励）
CREATE TABLE IF NOT EXISTS user_candies (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL UNIQUE,
  amount INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_user_candy FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 战斗队伍表
CREATE TABLE IF NOT EXISTS battle_teams (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  pokemon_ids TEXT[] NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_user_team FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_battle_teams_user ON battle_teams(user_id);

-- 插入默认用户偏好（为现有用户）
INSERT INTO user_inventory_preferences (user_id)
SELECT id FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM user_inventory_preferences WHERE user_id = users.id
)
ON CONFLICT DO NOTHING;

-- 插入默认糖果记录
INSERT INTO user_candies (user_id)
SELECT id FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM user_candies WHERE user_id = users.id
)
ON CONFLICT DO NOTHING;

-- 添加索引以支持按稀有度排序
CREATE INDEX IF NOT EXISTS idx_pokemon_user_rarity
  ON pokemon_instances(user_id, rarity)
  WHERE is_deleted = FALSE;

-- 添加索引以支持按亲密度排序
CREATE INDEX IF NOT EXISTS idx_pokemon_user_friendship
  ON pokemon_instances(user_id, friendship DESC)
  WHERE is_deleted = FALSE AND friendship IS NOT NULL;
