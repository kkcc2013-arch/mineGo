-- REQ-00150: 背包容量扩展与购买系统
-- 创建时间：2026-06-30 17:00 UTC

-- 背包扩容配置表
CREATE TABLE IF NOT EXISTS bag_upgrade_config (
  upgrade_id VARCHAR(50) PRIMARY KEY,
  category VARCHAR(20) NOT NULL CHECK (category IN ('base', 'pokeball', 'potion', 'tm', 'evolution', 'special', 'berry', 'misc')),
  increment INTEGER NOT NULL CHECK (increment > 0),
  gold_cost INTEGER CHECK (gold_cost IS NULL OR gold_cost >= 0),
  gem_cost INTEGER CHECK (gem_cost IS NULL OR gem_cost >= 0),
  required_level INTEGER DEFAULT 1 CHECK (required_level >= 1),
  max_upgrades INTEGER DEFAULT 10 CHECK (max_upgrades >= 0),
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE bag_upgrade_config IS '背包扩容配置表，定义各类别扩容的价格和限制';
COMMENT ON COLUMN bag_upgrade_config.category IS '背包分类：base=基础容量，pokeball=精灵球，potion=药水等';
COMMENT ON COLUMN bag_upgrade_config.increment IS '扩容数量';
COMMENT ON COLUMN bag_upgrade_config.max_upgrades IS '该配置最大可购买次数';

-- 玩家背包扩容记录表
CREATE TABLE IF NOT EXISTS player_bag_upgrades (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upgrade_id VARCHAR(50) NOT NULL REFERENCES bag_upgrade_config(upgrade_id),
  purchase_method VARCHAR(20) NOT NULL CHECK (purchase_method IN ('gold', 'gem', 'achievement', 'event', 'free', 'vip', 'admin')),
  cost_amount INTEGER NOT NULL DEFAULT 0 CHECK (cost_amount >= 0),
  purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  transaction_id VARCHAR(100),
  CONSTRAINT unique_purchase_record UNIQUE(user_id, upgrade_id, purchased_at)
);

CREATE INDEX IF NOT EXISTS idx_player_bag_upgrades_user ON player_bag_upgrades(user_id);
CREATE INDEX IF NOT EXISTS idx_player_bag_upgrades_method ON player_bag_upgrades(purchase_method);
CREATE INDEX IF NOT EXISTS idx_player_bag_upgrades_upgrade ON player_bag_upgrades(upgrade_id);
CREATE INDEX IF NOT EXISTS idx_player_bag_upgrades_time ON player_bag_upgrades(purchased_at DESC);

COMMENT ON TABLE player_bag_upgrades IS '玩家背包扩容购买记录';
COMMENT ON COLUMN player_bag_upgrades.purchase_method IS '购买方式：gold=金币，gem=宝石，achievement=成就奖励，event=活动奖励等';
COMMENT ON COLUMN player_bag_upgrades.transaction_id IS '关联的交易ID（用于审计）';

-- 初始配置数据
INSERT INTO bag_upgrade_config (upgrade_id, category, increment, gold_cost, gem_cost, required_level, max_upgrades, display_order) VALUES
  ('base_50', 'base', 50, 10000, 100, 5, 20, 1),
  ('base_100', 'base', 100, 50000, 500, 10, 10, 2),
  ('base_200', 'base', 200, NULL, 1000, 15, 5, 3),
  ('pokeball_20', 'pokeball', 20, 5000, 50, 1, 15, 10),
  ('pokeball_50', 'pokeball', 50, 20000, 200, 8, 10, 11),
  ('potion_20', 'potion', 20, 5000, 50, 1, 15, 20),
  ('potion_50', 'potion', 50, 20000, 200, 8, 10, 21),
  ('tm_10', 'tm', 10, 8000, 80, 8, 10, 30),
  ('tm_20', 'tm', 20, NULL, 150, 12, 8, 31),
  ('evolution_10', 'evolution', 10, 8000, 80, 8, 10, 40),
  ('evolution_20', 'evolution', 20, NULL, 150, 12, 8, 41),
  ('berry_20', 'berry', 20, 5000, 50, 1, 15, 50),
  ('berry_50', 'berry', 50, 20000, 200, 8, 10, 51),
  ('special_10', 'special', 10, 10000, 100, 10, 10, 60),
  ('special_20', 'special', 20, NULL, 180, 15, 8, 61),
  ('misc_20', 'misc', 20, 5000, 50, 1, 15, 70),
  ('misc_50', 'misc', 50, 20000, 200, 8, 10, 71)
ON CONFLICT (upgrade_id) DO NOTHING;

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_bag_upgrade_config_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_bag_upgrade_config_timestamp ON bag_upgrade_config;
CREATE TRIGGER trg_update_bag_upgrade_config_timestamp
  BEFORE UPDATE ON bag_upgrade_config
  FOR EACH ROW
  EXECUTE FUNCTION update_bag_upgrade_config_timestamp();

-- 扩展 inventory_capacity 表（如果不存在相关列）
-- 确保 inventory_capacity 表有所有类别的容量字段
DO $$
BEGIN
  -- 检查并添加各类别容量列
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_capacity' AND column_name = 'pokeball_slots') THEN
    ALTER TABLE inventory_capacity ADD COLUMN pokeball_slots INTEGER DEFAULT 50;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_capacity' AND column_name = 'potion_slots') THEN
    ALTER TABLE inventory_capacity ADD COLUMN potion_slots INTEGER DEFAULT 50;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_capacity' AND column_name = 'tm_slots') THEN
    ALTER TABLE inventory_capacity ADD COLUMN tm_slots INTEGER DEFAULT 20;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_capacity' AND column_name = 'evolution_slots') THEN
    ALTER TABLE inventory_capacity ADD COLUMN evolution_slots INTEGER DEFAULT 30;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_capacity' AND column_name = 'berry_slots') THEN
    ALTER TABLE inventory_capacity ADD COLUMN berry_slots INTEGER DEFAULT 50;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_capacity' AND column_name = 'special_slots') THEN
    ALTER TABLE inventory_capacity ADD COLUMN special_slots INTEGER DEFAULT 20;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'inventory_capacity' AND column_name = 'misc_slots') THEN
    ALTER TABLE inventory_capacity ADD COLUMN misc_slots INTEGER DEFAULT 100;
  END IF;
END $$;

-- 审计日志表（用于记录扩容操作）
CREATE TABLE IF NOT EXISTS bag_upgrade_audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  upgrade_id VARCHAR(50) NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('purchase', 'grant', 'refund', 'expire')),
  purchase_method VARCHAR(20),
  cost_amount INTEGER,
  old_capacity INTEGER,
  new_capacity INTEGER,
  performed_by INTEGER,
  performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_bag_upgrade_audit_user ON bag_upgrade_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_bag_upgrade_audit_time ON bag_upgrade_audit_log(performed_at DESC);

-- 统计视图：玩家扩容统计
CREATE OR REPLACE VIEW v_player_bag_upgrade_stats AS
SELECT 
  u.id AS user_id,
  u.nickname,
  COUNT(pbu.id) AS total_upgrades,
  SUM(CASE WHEN pbu.purchase_method = 'gold' THEN pbu.cost_amount ELSE 0 END) AS total_gold_spent,
  SUM(CASE WHEN pbu.purchase_method = 'gem' THEN pbu.cost_amount ELSE 0 END) AS total_gem_spent,
  SUM(CASE WHEN pbu.purchase_method IN ('achievement', 'event', 'free', 'vip') THEN 1 ELSE 0 END) AS free_upgrades,
  MAX(pbu.purchased_at) AS last_upgrade_time
FROM users u
LEFT JOIN player_bag_upgrades pbu ON u.id = pbu.user_id
GROUP BY u.id, u.nickname;

COMMENT ON VIEW v_player_bag_upgrade_stats IS '玩家背包扩容统计视图';