-- REQ-00150: 背包容量扩展与购买系统
-- 创建时间: 2026-06-13

-- 背包扩容配置表
CREATE TABLE IF NOT EXISTS bag_upgrade_config (
  upgrade_id VARCHAR(50) PRIMARY KEY,
  category VARCHAR(20) NOT NULL CHECK (category IN ('base', 'pokeball', 'potion', 'tm', 'evolution', 'special')),
  increment INTEGER NOT NULL CHECK (increment > 0),
  gold_cost INTEGER CHECK (gold_cost IS NULL OR gold_cost >= 0),
  gem_cost INTEGER CHECK (gem_cost IS NULL OR gem_cost >= 0),
  required_level INTEGER DEFAULT 1 CHECK (required_level >= 1),
  max_upgrades INTEGER DEFAULT 10 CHECK (max_upgrades >= 1),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE bag_upgrade_config IS '背包扩容配置表';
COMMENT ON COLUMN bag_upgrade_config.upgrade_id IS '扩容配置ID';
COMMENT ON COLUMN bag_upgrade_config.category IS '背包类别';
COMMENT ON COLUMN bag_upgrade_config.increment IS '扩容数量';
COMMENT ON COLUMN bag_upgrade_config.gold_cost IS '金币价格';
COMMENT ON COLUMN bag_upgrade_config.gem_cost IS '宝石价格';
COMMENT ON COLUMN bag_upgrade_config.required_level IS '所需玩家等级';
COMMENT ON COLUMN bag_upgrade_config.max_upgrades IS '最大购买次数';

-- 玩家背包扩容记录表
CREATE TABLE IF NOT EXISTS player_bag_upgrades (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upgrade_id VARCHAR(50) NOT NULL REFERENCES bag_upgrade_config(upgrade_id),
  purchase_method VARCHAR(20) NOT NULL CHECK (purchase_method IN ('gold', 'gem', 'achievement', 'event', 'free')),
  cost_amount INTEGER NOT NULL CHECK (cost_amount >= 0),
  purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, upgrade_id, purchased_at)
);

COMMENT ON TABLE player_bag_upgrades IS '玩家背包扩容记录表';
COMMENT ON COLUMN player_bag_upgrades.user_id IS '用户ID';
COMMENT ON COLUMN player_bag_upgrades.upgrade_id IS '扩容配置ID';
COMMENT ON COLUMN player_bag_upgrades.purchase_method IS '购买方式';
COMMENT ON COLUMN player_bag_upgrades.cost_amount IS '实际花费';
COMMENT ON COLUMN player_bag_upgrades.purchased_at IS '购买时间';

-- 索引
CREATE INDEX IF NOT EXISTS idx_player_bag_upgrades_user ON player_bag_upgrades(user_id);
CREATE INDEX IF NOT EXISTS idx_player_bag_upgrades_method ON player_bag_upgrades(purchase_method);
CREATE INDEX IF NOT EXISTS idx_player_bag_upgrades_time ON player_bag_upgrades(purchased_at);

-- 初始配置数据
INSERT INTO bag_upgrade_config (upgrade_id, category, increment, gold_cost, gem_cost, required_level, max_upgrades) VALUES
  ('base_50', 'base', 50, 10000, 100, 5, 20),
  ('base_100', 'base', 100, 50000, 500, 10, 10),
  ('pokeball_20', 'pokeball', 20, 5000, 50, 1, 15),
  ('potion_20', 'potion', 20, 5000, 50, 1, 15),
  ('tm_10', 'tm', 10, 8000, 80, 8, 10),
  ('evolution_10', 'evolution', 10, 8000, 80, 8, 10),
  ('special_10', 'special', 10, 10000, 100, 10, 10)
ON CONFLICT (upgrade_id) DO NOTHING;

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_bag_upgrade_config_updated_at BEFORE UPDATE ON bag_upgrade_config
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
