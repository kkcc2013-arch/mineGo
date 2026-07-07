-- REQ-00479: 数据库查询结果缓存自动失效策略系统
-- PostgreSQL NOTIFY 触发器

-- 创建 CDC 通知函数
CREATE OR REPLACE FUNCTION notify_cache_invalidation()
RETURNS TRIGGER AS $$
DECLARE
  payload JSONB;
  channel_name TEXT;
BEGIN
  -- 构造通知 payload
  IF TG_OP = 'INSERT' THEN
    payload = jsonb_build_object(
      'operation', 'insert',
      'table', TG_TABLE_NAME,
      'timestamp', EXTRACT(EPOCH FROM NOW()) * 1000,
      'data', to_jsonb(NEW)
    );
    channel_name := 'cdc_' || TG_TABLE_NAME;
    
  ELSIF TG_OP = 'UPDATE' THEN
    payload = jsonb_build_object(
      'operation', 'update',
      'table', TG_TABLE_NAME,
      'timestamp', EXTRACT(EPOCH FROM NOW()) * 1000,
      'data', to_jsonb(NEW),
      'oldData', to_jsonb(OLD)
    );
    channel_name := 'cdc_' || TG_TABLE_NAME;
    
  ELSIF TG_OP = 'DELETE' THEN
    payload = jsonb_build_object(
      'operation', 'delete',
      'table', TG_TABLE_NAME,
      'timestamp', EXTRACT(EPOCH FROM NOW()) * 1000,
      'data', to_jsonb(OLD)
    );
    channel_name := 'cdc_' || TG_TABLE_NAME;
  END IF;
  
  -- 发送通知
  PERFORM pg_notify(channel_name, payload::TEXT);
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为各表创建触发器
-- 用户表
DROP TRIGGER IF EXISTS cdc_users_trigger ON users;
CREATE TRIGGER cdc_users_trigger
AFTER INSERT OR UPDATE OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 精灵表
DROP TRIGGER IF EXISTS cdc_pokemon_trigger ON pokemon;
CREATE TRIGGER cdc_pokemon_trigger
AFTER INSERT OR UPDATE OR DELETE ON pokemon
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 捕捉记录表
DROP TRIGGER IF EXISTS cdc_catch_records_trigger ON catch_records;
CREATE TRIGGER cdc_catch_records_trigger
AFTER INSERT OR DELETE ON catch_records
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 道馆表
DROP TRIGGER IF EXISTS cdc_gyms_trigger ON gyms;
CREATE TRIGGER cdc_gyms_trigger
AFTER INSERT OR UPDATE OR DELETE ON gyms
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 道馆队伍表
DROP TRIGGER IF EXISTS cdc_gyms_teams_trigger ON gyms_teams;
CREATE TRIGGER cdc_gyms_teams_trigger
AFTER INSERT OR UPDATE OR DELETE ON gyms_teams
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- Raid 表
DROP TRIGGER IF EXISTS cdc_raids_trigger ON raids;
CREATE TRIGGER cdc_raids_trigger
AFTER INSERT OR UPDATE OR DELETE ON raids
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 好友表
DROP TRIGGER IF EXISTS cdc_friends_trigger ON friends;
CREATE TRIGGER cdc_friends_trigger
AFTER INSERT OR UPDATE OR DELETE ON friends
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 道具表
DROP TRIGGER IF EXISTS cdc_items_trigger ON items;
CREATE TRIGGER cdc_items_trigger
AFTER INSERT OR UPDATE OR DELETE ON items
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 用户背包表
DROP TRIGGER IF EXISTS cdc_inventory_trigger ON inventory;
CREATE TRIGGER cdc_inventory_trigger
AFTER INSERT OR UPDATE OR DELETE ON inventory
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 奖励记录表
DROP TRIGGER IF EXISTS cdc_reward_records_trigger ON reward_records;
CREATE TRIGGER cdc_reward_records_trigger
AFTER INSERT OR UPDATE ON reward_records
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 支付记录表
DROP TRIGGER IF EXISTS cdc_payments_trigger ON payments;
CREATE TRIGGER cdc_payments_trigger
AFTER INSERT OR UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();

-- 注释
COMMENT ON FUNCTION notify_cache_invalidation() IS 
'Req-00479: 数据库变更通知触发器，用于缓存失效';
