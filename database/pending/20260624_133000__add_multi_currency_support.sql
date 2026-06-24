-- Multi-currency Support and Exchange Rate System
-- REQ-00051: 2026-06-24

-- ============================================
-- 1. Supported Currencies
-- ============================================
CREATE TABLE IF NOT EXISTS supported_currencies (
    currency_code CHAR(3) PRIMARY KEY,
    currency_name VARCHAR(50) NOT NULL,
    currency_symbol VARCHAR(10) NOT NULL,
    decimal_places INTEGER DEFAULT 2,
    is_active BOOLEAN DEFAULT true,
    supported_since TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_currency_code CHECK (LENGTH(currency_code) = 3)
);

CREATE INDEX IF NOT EXISTS idx_supported_currencies_active ON supported_currencies(is_active);

-- ============================================
-- 2. User Currency Preferences
-- ============================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_currency CHAR(3) DEFAULT 'USD';
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency_auto_detect BOOLEAN DEFAULT true;

-- ============================================
-- 3. Exchange Rates
-- ============================================
CREATE TABLE IF NOT EXISTS exchange_rates (
    id SERIAL PRIMARY KEY,
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    rate DECIMAL(20, 10) NOT NULL,
    source VARCHAR(50) NOT NULL,
    fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    valid_until TIMESTAMP NOT NULL,
    is_current BOOLEAN DEFAULT true,
    CONSTRAINT chk_rate_positive CHECK (rate > 0),
    CONSTRAINT chk_currencies_different CHECK (from_currency <> to_currency)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_current ON exchange_rates(from_currency, to_currency) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_exchange_rates_validity ON exchange_rates(valid_until);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_fetched ON exchange_rates(fetched_at DESC);

-- ============================================
-- 4. Rate Locks (for payments)
-- ============================================
CREATE TABLE IF NOT EXISTS rate_locks (
    id SERIAL PRIMARY KEY,
    lock_id VARCHAR(64) UNIQUE NOT NULL,
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    locked_rate DECIMAL(20, 10) NOT NULL,
    locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    reference_type VARCHAR(20),
    reference_id VARCHAR(100),
    used BOOLEAN DEFAULT false,
    CONSTRAINT chk_locked_rate_positive CHECK (locked_rate > 0)
);

CREATE INDEX IF NOT EXISTS idx_rate_locks_lookup ON rate_locks(lock_id, expires_at) WHERE used = false;
CREATE INDEX IF NOT EXISTS idx_rate_locks_expires ON rate_locks(expires_at);

-- ============================================
-- 5. Exchange Rate History (for audit)
-- ============================================
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
    CONSTRAINT uq_rate_history UNIQUE(from_currency, to_currency, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_rate_history_lookup ON exchange_rate_history(from_currency, to_currency, recorded_at DESC);

-- ============================================
-- 6. Product Prices (multi-currency)
-- ============================================
CREATE TABLE IF NOT EXISTS product_prices (
    id SERIAL PRIMARY KEY,
    product_id VARCHAR(100) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    price DECIMAL(20, 2) NOT NULL,
    original_price DECIMAL(20, 2),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_product_price UNIQUE(product_id, currency_code),
    CONSTRAINT chk_price_positive CHECK (price > 0)
);

CREATE INDEX IF NOT EXISTS idx_product_prices_lookup ON product_prices(product_id);

-- ============================================
-- 7. Payment Orders Enhancement
-- ============================================
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS amount_usd DECIMAL(20, 2);
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS amount_local DECIMAL(20, 2);
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS local_currency CHAR(3) DEFAULT 'USD';
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS exchange_rate DECIMAL(20, 10);
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS rate_lock_id VARCHAR(64);

-- ============================================
-- 8. Currency Conversion Audit Log
-- ============================================
CREATE TABLE IF NOT EXISTS currency_conversion_logs (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(100),
    from_currency CHAR(3) NOT NULL,
    to_currency CHAR(3) NOT NULL,
    from_amount DECIMAL(20, 2) NOT NULL,
    to_amount DECIMAL(20, 2) NOT NULL,
    rate DECIMAL(20, 10) NOT NULL,
    rate_source VARCHAR(50),
    rate_lock_id VARCHAR(64),
    conversion_type VARCHAR(20) NOT NULL, -- 'payment', 'display', 'refund'
    reference_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_currency_conversion_user ON currency_conversion_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_currency_conversion_ref ON currency_conversion_logs(reference_id);

-- ============================================
-- 9. Seed Default Currencies
-- ============================================
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
('INR', 'Indian Rupee', '₹', 2),
('THB', 'Thai Baht', '฿', 2),
('MYR', 'Malaysian Ringgit', 'RM', 2),
('PHP', 'Philippine Peso', '₱', 2),
('VND', 'Vietnamese Dong', '₫', 0),
('BRL', 'Brazilian Real', 'R$', 2)
ON CONFLICT (currency_code) DO NOTHING;

-- ============================================
-- 10. Seed Default Product Prices
-- ============================================
INSERT INTO product_prices (product_id, currency_code, price) VALUES
-- USD prices (base)
('coins_60', 'USD', 0.99),
('coins_300', 'USD', 4.99),
('coins_600', 'USD', 9.99),
('coins_1200', 'USD', 19.99),
('coins_2500', 'USD', 39.99),
-- CNY prices
('coins_60', 'CNY', 6.00),
('coins_300', 'CNY', 30.00),
('coins_600', 'CNY', 58.00),
('coins_1200', 'CNY', 108.00),
('coins_2500', 'CNY', 198.00),
-- JPY prices
('coins_60', 'JPY', 120),
('coins_300', 'JPY', 600),
('coins_600', 'JPY', 1200),
('coins_1200', 'JPY', 2400),
('coins_2500', 'JPY', 4800),
-- EUR prices
('coins_60', 'EUR', 0.99),
('coins_300', 'EUR', 4.99),
('coins_600', 'EUR', 9.99),
('coins_1200', 'EUR', 19.99),
('coins_2500', 'EUR', 39.99)
ON CONFLICT (product_id, currency_code) DO NOTHING;

-- ============================================
-- 11. Comments
-- ============================================
COMMENT ON TABLE supported_currencies IS 'List of supported currencies with ISO 4217 codes';
COMMENT ON TABLE exchange_rates IS 'Current and historical exchange rates with validity tracking';
COMMENT ON TABLE rate_locks IS 'Locked exchange rates for payment transactions to prevent rate fluctuation';
COMMENT ON TABLE product_prices IS 'Localized product prices in different currencies';
COMMENT ON TABLE currency_conversion_logs IS 'Audit log of all currency conversions';
