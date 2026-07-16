-- REQ-00550: 游戏内货币本地化显示与智能区域适配系统
-- 创建区域定价和用户货币偏好表

-- 区域定价表
CREATE TABLE IF NOT EXISTS regional_pricing (
  id SERIAL PRIMARY KEY,
  product_id VARCHAR(50) NOT NULL,
  country_code CHAR(2) NOT NULL,
  currency_code CHAR(3) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  original_price DECIMAL(10, 2),
  strategy VARCHAR(20) DEFAULT 'local',  -- local, PPP, converted
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(product_id, country_code, currency_code)
);

-- 用户货币偏好表
CREATE TABLE IF NOT EXISTS user_currency_preferences (
  user_id VARCHAR(50) PRIMARY KEY,
  preferred_currency CHAR(3) DEFAULT 'USD',
  display_format VARCHAR(20) DEFAULT 'abbreviated',  -- full, abbreviated
  region VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_regional_pricing_product ON regional_pricing(product_id);
CREATE INDEX IF NOT EXISTS idx_regional_pricing_country ON regional_pricing(country_code);
CREATE INDEX IF NOT EXISTS idx_regional_pricing_active ON regional_pricing(is_active, country_code);
CREATE INDEX IF NOT EXISTS idx_user_currency_pref_region ON user_currency_preferences(region);

-- 初始定价数据
INSERT INTO regional_pricing (product_id, country_code, currency_code, price, strategy) VALUES
  ('coins_100', 'US', 'USD', 0.99, 'base'),
  ('coins_550', 'US', 'USD', 4.99, 'base'),
  ('coins_1200', 'US', 'USD', 9.99, 'base'),
  ('coins_2500', 'US', 'USD', 19.99, 'base'),
  ('coins_5200', 'US', 'USD', 39.99, 'base'),
  ('coins_14500', 'US', 'USD', 99.99, 'base'),
  ('coins_100', 'JP', 'JPY', 120, 'local'),
  ('coins_550', 'JP', 'JPY', 600, 'local'),
  ('coins_1200', 'JP', 'JPY', 1200, 'local'),
  ('coins_2500', 'JP', 'JPY', 2400, 'local'),
  ('coins_5200', 'JP', 'JPY', 4800, 'local'),
  ('coins_14500', 'JP', 'JPY', 12000, 'local'),
  ('coins_100', 'CN', 'CNY', 6, 'local'),
  ('coins_550', 'CN', 'CNY', 30, 'local'),
  ('coins_1200', 'CN', 'CNY', 68, 'local'),
  ('coins_2500', 'CN', 'CNY', 128, 'local'),
  ('coins_5200', 'CN', 'CNY', 198, 'local'),
  ('coins_14500', 'CN', 'CNY', 648, 'local'),
  ('coins_100', 'KR', 'KRW', 1100, 'local'),
  ('coins_550', 'KR', 'KRW', 5500, 'local'),
  ('coins_1200', 'KR', 'KRW', 11000, 'local')
ON CONFLICT (product_id, country_code, currency_code) DO NOTHING;