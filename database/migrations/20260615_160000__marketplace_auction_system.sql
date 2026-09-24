-- REQ-00104: 精灵交换市场与竞价拍卖系统
-- 创建市场相关表结构

-- 市场列表表
CREATE TABLE IF NOT EXISTS marketplace_listings (
    id SERIAL PRIMARY KEY,
    listing_id VARCHAR(36) UNIQUE NOT NULL,
    seller_id UUID NOT NULL REFERENCES users(id),
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
    
    -- 交易类型
    listing_type VARCHAR(20) NOT NULL CHECK (listing_type IN ('fixed', 'auction')),
    
    -- 定价信息
    fixed_price INTEGER,
    starting_bid INTEGER,
    buyout_price INTEGER,
    
    -- 拍卖信息
    current_highest_bid INTEGER DEFAULT 0,
    current_highest_bidder_id UUID REFERENCES users(id),
    bid_count INTEGER DEFAULT 0,
    
    -- 时间信息
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    sold_at TIMESTAMP WITH TIME ZONE,
    
    -- 状态
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'sold', 'expired', 'cancelled')),
    
    -- 其他
    featured BOOLEAN DEFAULT false,
    view_count INTEGER DEFAULT 0,
    
    CONSTRAINT valid_fixed_price CHECK (
        listing_type != 'fixed' OR fixed_price IS NOT NULL
    ),
    CONSTRAINT valid_auction_price CHECK (
        listing_type != 'auction' OR starting_bid IS NOT NULL
    )
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS listing_id VARCHAR(36);
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS seller_id UUID;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS pokemon_id INTEGER;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS listing_type VARCHAR(20);
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS fixed_price INTEGER;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS starting_bid INTEGER;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS buyout_price INTEGER;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS current_highest_bid INTEGER DEFAULT 0;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS current_highest_bidder_id UUID;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS bid_count INTEGER DEFAULT 0;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS sold_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT false;
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0;

-- 索引
CREATE INDEX IF NOT EXISTS idx_marketplace_seller_id ON marketplace_listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_pokemon_id ON marketplace_listings(pokemon_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_status_expires ON marketplace_listings(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_marketplace_type_price ON marketplace_listings(listing_type, fixed_price, current_highest_bid);

-- 竞价记录表
CREATE TABLE IF NOT EXISTS marketplace_bids (
    id SERIAL PRIMARY KEY,
    bid_id VARCHAR(36) UNIQUE NOT NULL,
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    bidder_id UUID NOT NULL REFERENCES users(id),
    bid_amount INTEGER NOT NULL,
    is_auto_bid BOOLEAN DEFAULT false,
    max_auto_bid INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_winning BOOLEAN DEFAULT false,
    
    CONSTRAINT valid_auto_bid CHECK (
        is_auto_bid = false OR max_auto_bid IS NOT NULL
    ),
    CONSTRAINT valid_bid_amount CHECK (bid_amount > 0)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE marketplace_bids ADD COLUMN IF NOT EXISTS bid_id VARCHAR(36);
ALTER TABLE marketplace_bids ADD COLUMN IF NOT EXISTS listing_id INTEGER;
ALTER TABLE marketplace_bids ADD COLUMN IF NOT EXISTS bidder_id UUID;
ALTER TABLE marketplace_bids ADD COLUMN IF NOT EXISTS bid_amount INTEGER;
ALTER TABLE marketplace_bids ADD COLUMN IF NOT EXISTS is_auto_bid BOOLEAN DEFAULT false;
ALTER TABLE marketplace_bids ADD COLUMN IF NOT EXISTS max_auto_bid INTEGER;
ALTER TABLE marketplace_bids ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE marketplace_bids ADD COLUMN IF NOT EXISTS is_winning BOOLEAN DEFAULT false;

-- 索引
CREATE INDEX IF NOT EXISTS idx_bids_listing_bidder ON marketplace_bids(listing_id, bidder_id);
CREATE INDEX IF NOT EXISTS idx_bids_bidder_created ON marketplace_bids(bidder_id, created_at);

-- 市场收藏表
CREATE TABLE IF NOT EXISTS marketplace_favorites (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id, listing_id)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE marketplace_favorites ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE marketplace_favorites ADD COLUMN IF NOT EXISTS listing_id INTEGER;
ALTER TABLE marketplace_favorites ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_favorites_user ON marketplace_favorites(user_id);

-- 市场交易历史表
CREATE TABLE IF NOT EXISTS marketplace_transactions (
    id SERIAL PRIMARY KEY,
    transaction_id VARCHAR(36) UNIQUE NOT NULL,
    listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id),
    seller_id UUID NOT NULL REFERENCES users(id),
    buyer_id UUID NOT NULL REFERENCES users(id),
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
    final_price INTEGER NOT NULL,
    fee_amount INTEGER NOT NULL,
    transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('fixed', 'auction')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT valid_final_price CHECK (final_price > 0)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE marketplace_transactions ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(36);
ALTER TABLE marketplace_transactions ADD COLUMN IF NOT EXISTS listing_id INTEGER;
ALTER TABLE marketplace_transactions ADD COLUMN IF NOT EXISTS seller_id UUID;
ALTER TABLE marketplace_transactions ADD COLUMN IF NOT EXISTS buyer_id UUID;
ALTER TABLE marketplace_transactions ADD COLUMN IF NOT EXISTS pokemon_id INTEGER;
ALTER TABLE marketplace_transactions ADD COLUMN IF NOT EXISTS final_price INTEGER;
ALTER TABLE marketplace_transactions ADD COLUMN IF NOT EXISTS fee_amount INTEGER;
ALTER TABLE marketplace_transactions ADD COLUMN IF NOT EXISTS transaction_type VARCHAR(20);
ALTER TABLE marketplace_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- 索引
CREATE INDEX IF NOT EXISTS idx_transactions_seller ON marketplace_transactions(seller_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_buyer ON marketplace_transactions(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_pokemon ON marketplace_transactions(pokemon_id);

-- 市场价格历史表
CREATE TABLE IF NOT EXISTS marketplace_price_history (
    id SERIAL PRIMARY KEY,
    pokemon_species_id INTEGER NOT NULL,
    avg_price INTEGER,
    min_price INTEGER,
    max_price INTEGER,
    transaction_count INTEGER DEFAULT 0,
    recorded_date DATE NOT NULL,
    
    UNIQUE(pokemon_species_id, recorded_date)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE marketplace_price_history ADD COLUMN IF NOT EXISTS pokemon_species_id INTEGER;
ALTER TABLE marketplace_price_history ADD COLUMN IF NOT EXISTS avg_price INTEGER;
ALTER TABLE marketplace_price_history ADD COLUMN IF NOT EXISTS min_price INTEGER;
ALTER TABLE marketplace_price_history ADD COLUMN IF NOT EXISTS max_price INTEGER;
ALTER TABLE marketplace_price_history ADD COLUMN IF NOT EXISTS transaction_count INTEGER DEFAULT 0;
ALTER TABLE marketplace_price_history ADD COLUMN IF NOT EXISTS recorded_date DATE;

CREATE INDEX IF NOT EXISTS idx_price_history_species_date ON marketplace_price_history(pokemon_species_id, recorded_date);

-- 用户市场统计表
CREATE TABLE IF NOT EXISTS marketplace_user_stats (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_listings INTEGER DEFAULT 0,
    total_sales INTEGER DEFAULT 0,
    total_purchases INTEGER DEFAULT 0,
    total_earned INTEGER DEFAULT 0,
    total_spent INTEGER DEFAULT 0,
    total_fees_paid INTEGER DEFAULT 0,
    rating_score DECIMAL(3,2) DEFAULT 5.00,
    rating_count INTEGER DEFAULT 0,
    last_listing_at TIMESTAMP WITH TIME ZONE,
    last_transaction_at TIMESTAMP WITH TIME ZONE
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS total_listings INTEGER DEFAULT 0;
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS total_sales INTEGER DEFAULT 0;
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS total_purchases INTEGER DEFAULT 0;
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS total_earned INTEGER DEFAULT 0;
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS total_spent INTEGER DEFAULT 0;
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS total_fees_paid INTEGER DEFAULT 0;
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS rating_score DECIMAL(3,2) DEFAULT 5.00;
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0;
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS last_listing_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE marketplace_user_stats ADD COLUMN IF NOT EXISTS last_transaction_at TIMESTAMP WITH TIME ZONE;

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_stats_sales ON marketplace_user_stats(total_sales DESC);
CREATE INDEX IF NOT EXISTS idx_user_stats_earned ON marketplace_user_stats(total_earned DESC);

-- 注释
COMMENT ON TABLE marketplace_listings IS '市场列表：支持固定价格和竞价拍卖';
COMMENT ON TABLE marketplace_bids IS '竞价记录：拍卖模式的出价历史';
COMMENT ON TABLE marketplace_favorites IS '市场收藏：用户收藏的列表';
COMMENT ON TABLE marketplace_transactions IS '市场交易历史：已完成的交易记录';
COMMENT ON TABLE marketplace_price_history IS '市场价格历史：用于价格趋势分析';
COMMENT ON TABLE marketplace_user_stats IS '用户市场统计：交易数据汇总';
