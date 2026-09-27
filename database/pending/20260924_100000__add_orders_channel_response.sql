-- migrate:up
-- 支付回调原文留存（payment-service webhook 写入该列，但此前没有任何迁移创建它，
-- 导致渠道确认的支付全部入账失败）
ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel_response TEXT;

-- migrate:down
ALTER TABLE orders DROP COLUMN IF EXISTS channel_response;
