-- =====================================================
-- REQ-00051: 多货币支持与汇率转换系统
-- =====================================================

-- 1. 支持的货币列表
CREATE TABLE IF NOT EXISTS supported_currencies (
    currency_code CHAR(3) PRIMARY KEY,  -- ISO 4217 货币代码
    currency_name VARCHAR(50) NOT NULL,
    currency_symbol VARCHAR(10) NOT NULL,
    decimal_places INTEGER DEFAULT 2,
    is_active BOOLEAN DEFAULT true,
    supported_since TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(currency_code)
);

-- 2. 用户货币偏好
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_currency CHAR(3) DEFAULT 'USD';
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency_auto_detect BOOLEAN DEFAULT true;

-- 3. 汇率快照表
CREATE TABLE IF NOT EXISTS exchange_rates (
    id SERIAL PRIMARY KEY,
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    rate DECIMAL(20, 10) NOT NULL,
    source VARCHAR(50) NOT NULL,  -- 'openexchangerates', 'ecb', 'manual'
    fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMP NOT NULL,
    is_current BOOLEAN DEFAULT true,
    UNIQUE(from_currency, to_currency, fetched_at)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_current ON exchange_rates(from_currency, to_currency) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_exchange_rates_validity ON exchange_rates(valid_until);

-- 4. 汇率锁定记录（支付专用）
CREATE TABLE IF NOT EXISTS rate_locks (
    id SERIAL PRIMARY KEY,
    lock_id VARCHAR(64) UNIQUE NOT NULL,  -- UUID
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    locked_rate DECIMAL(20, 10) NOT NULL,
    locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    reference_type VARCHAR(20),  -- 'order', 'price_display'
    reference_id VARCHAR(100),
    used BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_rate_locks_lookup ON rate_locks(lock_id, expires_at) WHERE used = false;

-- 5. 汇率历史表（审计）
CREATE TABLE IF NOT EXISTS exchange_rate_history (
    id SERIAL PRIMARY KEY,
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    rate DECIMAL(20, 10) NOT NULL,
    recorded_at DATE NOT NULL,
    open_rate DECIMAL(20, 10),
    close_rate DECIMAL(20, 10),
    high_rate DECIMAL(20, 10),
    low_rate DECIMAL(20, 10),
    UNIQUE(from_currency, to_currency, recorded_at)
);

-- 6. 商品定价表（支持多货币）
CREATE TABLE IF NOT EXISTS product_prices (
    id SERIAL PRIMARY KEY,
    product_id VARCHAR(100) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    price DECIMAL(20, 2) NOT NULL,
    original_price DECIMAL(20, 2),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, currency_code)
);

CREATE INDEX IF NOT EXISTS idx_product_prices_lookup ON product_prices(product_id);

-- 7. 初始化支持的货币
INSERT INTO supported_currencies (currency_code, currency_name, currency_symbol, decimal_places) VALUES
('USD', 'US Dollar', '$', 2),
('EUR', 'Euro', '€', 2),
('GBP', 'British Pound', '£', 2),
('JPY', 'Japanese Yen', '¥', 0),
('CNY', 'Chinese Yuan', '¥', 2),
('KRW', 'South Korean Won', '₩', 0),
('TWD', 'Taiwan Dollar', 'NT$', 2),
('HKD', 'Hong Kong Dollar', 'HK$', 2),
('SGD', 'Singapore Dollar', 'S$', 2),
('AUD', 'Australian Dollar', 'A$', 2),
('CAD', 'Canadian Dollar', 'C$', 2),
('CHF', 'Swiss Franc', 'CHF', 2),
('SEK', 'Swedish Krona', 'kr', 2),
('NOK', 'Norwegian Krone', 'kr', 2),
('INR', 'Indian Rupee', '₹', 2)
ON CONFLICT (currency_code) DO NOTHING;

-- 8. 初始化商品价格（USD 基准）
INSERT INTO product_prices (product_id, currency_code, price) VALUES
('coins_60', 'USD', 6.00),
('coins_300', 'USD', 30.00),
('coins_600', 'USD', 58.00),
('coins_1200', 'USD', 98.00),
('coins_2500', 'USD', 198.00)
ON CONFLICT (product_id, currency_code) DO NOTHING;

-- 9. 初始化基准汇率（USD 对其他货币，示例值）
INSERT INTO exchange_rates (from_currency, to_currency, rate, source, valid_until, is_current) VALUES
('USD', 'USD', 1.0000000000, 'base', NOW() + INTERVAL '1 year', true),
('USD', 'EUR', 0.9200000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'GBP', 0.7900000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'JPY', 149.5000000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'CNY', 7.2400000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'KRW', 1320.0000000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'TWD', 31.5000000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'HKD', 7.8200000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'SGD', 1.3400000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'AUD', 1.5300000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'CAD', 1.3600000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'CHF', 0.8800000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'SEK', 10.5000000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'NOK', 10.8000000000, 'manual', NOW() + INTERVAL '1 hour', true),
('USD', 'INR', 83.0000000000, 'manual', NOW() + INTERVAL '1 hour', true)
ON CONFLICT (from_currency, to_currency, fetched_at) DO NOTHING;

-- 10. 添加支付订单多货币字段
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS amount_local DECIMAL(20, 2);
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS local_currency CHAR(3) DEFAULT 'USD';
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS exchange_rate DECIMAL(20, 10);
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS rate_lock_id VARCHAR(64);

COMMENT ON TABLE supported_currencies IS 'REQ-00051: 支持的货币列表';
COMMENT ON TABLE exchange_rates IS 'REQ-00051: 汇率快照表';
COMMENT ON TABLE rate_locks IS 'REQ-00051: 汇率锁定记录（支付专用）';
COMMENT ON TABLE exchange_rate_history IS 'REQ-00051: 汇率历史表（审计）';
COMMENT ON TABLE product_prices IS 'REQ-00051: 商品多货币定价表';
