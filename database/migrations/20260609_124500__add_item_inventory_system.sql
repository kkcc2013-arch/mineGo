-- =====================================================
-- REQ-00047: 精灵道具与背包管理系统
-- 已由 database/pending/20260609_124500__add_item_inventory_system.sql 取代（同一需求、同一时间戳）。
-- 原文件以 id SERIAL 定义 items、以 INTEGER 引用 users(id)（UUID），在任何库上都无法执行，
-- 且与 20260613_localization_layer.sql 的 items（id VARCHAR PK）冲突。保留文件名以免迁移记录错乱。
-- =====================================================
SELECT 1;
