-- 精灵交换欺诈检测与交易安全系统数据库迁移
-- Migration: REQ-00289

-- ============================================================
-- 1. 交易欺诈分析表
-- ============================================================

CREATE TABLE IF NOT EXISTS trade_fraud_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL UNIQUE,
  scores JSONB NOT NULL DEFAULT '[]',
  overall_score DECIMAL(5,4) NOT NULL DEFAULT 0,
  risk_level VARCHAR(20) NOT NULL DEFAULT 'low',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_fraud_analysis_trade_id ON trade_fraud_analysis(trade_id);
CREATE INDEX idx_trade_fraud_analysis_risk_level ON trade_fraud_analysis(risk_level);
CREATE INDEX idx_trade_fraud_analysis_created_at ON trade_fraud_analysis(created_at);

COMMENT ON TABLE trade_fraud_analysis IS '交易欺诈分析结果';
COMMENT ON COLUMN trade_fraud_analysis.scores IS '各检测器的评分结果（JSON数组）';
COMMENT ON COLUMN trade_fraud_analysis.overall_score IS '综合欺诈风险评分（0-1）';
COMMENT ON COLUMN trade_fraud_analysis.risk_level IS '风险等级：low/medium/high/critical';

-- ============================================================
-- 2. 交易价值警告表
-- ============================================================

CREATE TABLE IF NOT EXISTS trade_value_warnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL,
  user_id UUID NOT NULL,
  warning_data JSONB NOT NULL,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_value_warnings_trade_id ON trade_value_warnings(trade_id);
CREATE INDEX idx_trade_value_warnings_user_id ON trade_value_warnings(user_id);
CREATE INDEX idx_trade_value_warnings_acknowledged ON trade_value_warnings(acknowledged);

COMMENT ON TABLE trade_value_warnings IS '交易价值警告记录';

-- ============================================================
-- 3. 交易审计日志表
-- ============================================================

CREATE TABLE IF NOT EXISTS trade_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  audit_data JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_audit_log_trade_id ON trade_audit_log(trade_id);
CREATE INDEX idx_trade_audit_log_event_type ON trade_audit_log(event_type);
CREATE INDEX idx_trade_audit_log_created_at ON trade_audit_log(created_at);

-- 分区（按月）
-- CREATE TABLE trade_audit_log_partitioned (
--   LIKE trade_audit_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS
-- ) PARTITION BY RANGE (created_at);

COMMENT ON TABLE trade_audit_log IS '交易审计日志';

-- ============================================================
-- 4. 交易回滚记录表
-- ============================================================

CREATE TABLE IF NOT EXISTS trade_rollbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL UNIQUE,
  initiator_id UUID NOT NULL,
  receiver_id UUID NOT NULL,
  reason TEXT,
  rolled_back_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_rollbacks_trade_id ON trade_rollbacks(trade_id);
CREATE INDEX idx_trade_rollbacks_initiator_id ON trade_rollbacks(initiator_id);
CREATE INDEX idx_trade_rollbacks_receiver_id ON trade_rollbacks(receiver_id);

COMMENT ON TABLE trade_rollbacks IS '交易回滚记录';

-- ============================================================
-- 5. 修改 pokemon_trades 表
-- ============================================================

-- 添加新状态
ALTER TABLE pokemon_trades 
DROP CONSTRAINT IF EXISTS pokemon_trades_status_check;

ALTER TABLE pokemon_trades
ADD CONSTRAINT pokemon_trades_status_check 
CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'BLOCKED', 'ROLLED_BACK'));

-- 添加回滚相关字段
ALTER TABLE pokemon_trades
ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS rollback_reason TEXT;

-- 添加欺诈分析相关字段
ALTER TABLE pokemon_trades
ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20) DEFAULT 'low',
ADD COLUMN IF NOT EXISTS fraud_score DECIMAL(5,4) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pokemon_trades_risk_level ON pokemon_trades(risk_level);
CREATE INDEX IF NOT EXISTS idx_pokemon_trades_fraud_score ON pokemon_trades(fraud_score);

-- ============================================================
-- 6. 用户安全事件表（用于行为分析）
-- ============================================================

CREATE TABLE IF NOT EXISTS user_security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  event_data JSONB,
  ip_address INET,
  device_fingerprint VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_security_events_user_id ON user_security_events(user_id);
CREATE INDEX idx_user_security_events_event_type ON user_security_events(event_type);
CREATE INDEX idx_user_security_events_created_at ON user_security_events(created_at);

COMMENT ON TABLE user_security_events IS '用户安全事件记录（密码修改、登录异常等）';

-- ============================================================
-- 7. 交易网络分析缓存表
-- ============================================================

CREATE TABLE IF NOT EXISTS trade_network_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id1 UUID NOT NULL,
  user_id2 UUID NOT NULL,
  cluster_id UUID,
  network_metrics JSONB,
  last_analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id1, user_id2)
);

CREATE INDEX idx_trade_network_cache_cluster_id ON trade_network_cache(cluster_id);

COMMENT ON TABLE trade_network_cache IS '交易网络分析缓存';

-- ============================================================
-- 8. 触发器：自动更新 updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_trade_fraud_analysis_updated_at
  BEFORE UPDATE ON trade_fraud_analysis
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 9. 审计日志触发器
-- ============================================================

CREATE OR REPLACE FUNCTION log_trade_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO trade_audit_log (trade_id, event_type, audit_data)
    VALUES (
      NEW.id,
      'status_changed',
      jsonb_build_object(
        'old_status', OLD.status,
        'new_status', NEW.status,
        'changed_at', CURRENT_TIMESTAMP
      )
    );
  END IF;
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER trigger_log_trade_status_change
  AFTER UPDATE ON pokemon_trades
  FOR EACH ROW
  EXECUTE FUNCTION log_trade_status_change();

-- ============================================================
-- 10. 视图：高风险交易统计
-- ============================================================

CREATE OR REPLACE VIEW high_risk_trades_view AS
SELECT 
  DATE(created_at) AS trade_date,
  risk_level,
  COUNT(*) AS total_trades,
  AVG(overall_score) AS avg_fraud_score,
  COUNT(*) FILTER (WHERE overall_score > 0.7) AS critical_count,
  COUNT(*) FILTER (WHERE overall_score BETWEEN 0.5 AND 0.7) AS high_count
FROM trade_fraud_analysis
GROUP BY DATE(created_at), risk_level
ORDER BY trade_date DESC, risk_level;

COMMENT ON VIEW high_risk_trades_view IS '高风险交易统计视图';

-- ============================================================
-- 11. 权限设置
-- ============================================================

GRANT SELECT, INSERT, UPDATE ON trade_fraud_analysis TO minego_user;
GRANT SELECT, INSERT, UPDATE ON trade_value_warnings TO minego_user;
GRANT SELECT, INSERT ON trade_audit_log TO minego_user;
GRANT SELECT, INSERT ON trade_rollbacks TO minego_user;
GRANT SELECT, INSERT ON user_security_events TO minego_user;
GRANT SELECT, INSERT, UPDATE ON trade_network_cache TO minego_user;

-- ============================================================
-- 12. 初始数据
-- ============================================================

-- 无初始数据

-- ============================================================
-- 回滚脚本（如需回滚）
-- ============================================================

/*
DROP TABLE IF EXISTS trade_fraud_analysis CASCADE;
DROP TABLE IF EXISTS trade_value_warnings CASCADE;
DROP TABLE IF EXISTS trade_audit_log CASCADE;
DROP TABLE IF EXISTS trade_rollbacks CASCADE;
DROP TABLE IF EXISTS user_security_events CASCADE;
DROP TABLE IF EXISTS trade_network_cache CASCADE;
DROP VIEW IF EXISTS high_risk_trades_view;
DROP TRIGGER IF EXISTS update_trade_fraud_analysis_updated_at ON trade_fraud_analysis;
DROP TRIGGER IF EXISTS trigger_log_trade_status_change ON pokemon_trades;
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP FUNCTION IF EXISTS log_trade_status_change();

ALTER TABLE pokemon_trades
DROP COLUMN IF EXISTS rolled_back_at,
DROP COLUMN IF EXISTS rollback_reason,
DROP COLUMN IF EXISTS risk_level,
DROP COLUMN IF EXISTS fraud_score;
*/
