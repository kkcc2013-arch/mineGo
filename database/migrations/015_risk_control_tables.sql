-- database/migrations/015_risk_control_tables.sql
-- REQ-00416: Game Economy Anomaly Detection and Anti-Fraud System
-- Risk scoring history, events, related accounts, and review queue

-- Enable UUID extension if not exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Risk score history table
CREATE TABLE IF NOT EXISTS risk_score_history (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  level VARCHAR(20) NOT NULL CHECK (level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'BAN')),
  breakdown JSONB,
  trigger_action VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_score_user_time 
  ON risk_score_history(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_score_level 
  ON risk_score_history(level, created_at DESC);

-- Risk events table
CREATE TABLE IF NOT EXISTS risk_events (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  event_type VARCHAR(50) NOT NULL,
  rule_name VARCHAR(100),
  score_delta INTEGER DEFAULT 0,
  action_taken VARCHAR(50),
  details JSONB,
  reviewed BOOLEAN DEFAULT FALSE,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_events_user 
  ON risk_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_events_type 
  ON risk_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_events_reviewed 
  ON risk_events(reviewed, created_at DESC);

-- Related accounts table (for multi-account detection)
CREATE TABLE IF NOT EXISTS related_accounts (
  id SERIAL PRIMARY KEY,
  user_id_a UUID NOT NULL REFERENCES users(id),
  user_id_b UUID NOT NULL REFERENCES users(id),
  relation_type VARCHAR(50) NOT NULL 
    CHECK (relation_type IN ('SAME_DEVICE', 'SAME_IP', 'FREQUENT_TRADE', 'FAMILY', 'ORGANIZATION')),
  confidence DECIMAL(5, 4) DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  evidence JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '30 days'),
  UNIQUE(user_id_a, user_id_b, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_related_accounts_user_a 
  ON related_accounts(user_id_a);

CREATE INDEX IF NOT EXISTS idx_related_accounts_user_b 
  ON related_accounts(user_id_b);

-- Risk review queue table
CREATE TABLE IF NOT EXISTS risk_review_queue (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  risk_score INTEGER NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
  trigger_event VARCHAR(100),
  trigger_event_id INTEGER REFERENCES risk_events(id),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED')),
  assigned_to UUID REFERENCES users(id),
  resolution VARCHAR(50),
  resolution_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE,
  priority INTEGER DEFAULT 1 CHECK (priority >= 1 AND priority <= 5)
);

CREATE INDEX IF NOT EXISTS idx_review_queue_status 
  ON risk_review_queue(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_queue_assigned 
  ON risk_review_queue(assigned_to, status);

-- Risk action log (for audit trail)
CREATE TABLE IF NOT EXISTS risk_action_log (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  action_type VARCHAR(50) NOT NULL,
  action_details JSONB,
  performed_by UUID REFERENCES users(id),
  is_automatic BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_action_user 
  ON risk_action_log(user_id, created_at DESC);

-- View for risk dashboard
CREATE OR REPLACE VIEW risk_user_summary AS
SELECT 
  u.id AS user_id,
  u.nickname AS username,
  u.level,
  u.premium_coins,
  rsh.score AS current_score,
  rsh.level AS risk_level,
  rsh.created_at AS score_updated_at,
  COUNT(DISTINCT re.id) FILTER (WHERE re.created_at > NOW() - INTERVAL '24 hours') AS events_24h,
  COUNT(DISTINCT rr.id) FILTER (WHERE rr.status = 'PENDING') AS pending_reviews,
  MAX(re.created_at) AS last_event_at
FROM users u
LEFT JOIN risk_score_history rsh ON rsh.user_id = u.id 
  AND rsh.created_at = (
    SELECT MAX(created_at) FROM risk_score_history WHERE user_id = u.id
  )
LEFT JOIN risk_events re ON re.user_id = u.id
LEFT JOIN risk_review_queue rr ON rr.user_id = u.id AND rr.status = 'PENDING'
GROUP BY u.id, u.nickname, u.level, u.premium_coins, rsh.score, rsh.level, rsh.created_at;

-- Function for updating user status based on risk
CREATE OR REPLACE FUNCTION update_user_status_on_risk()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.level = 'BAN' AND OLD.level != 'BAN' THEN
    UPDATE users SET is_banned = TRUE, ban_reason = '风控系统自动封禁' WHERE id = NEW.user_id;
  END IF;
  
  IF NEW.level = 'CRITICAL' THEN
    INSERT INTO risk_review_queue (user_id, risk_score, trigger_event, status, priority)
    VALUES (NEW.user_id, NEW.score, 'AUTO_INSERT', 'PENDING', 3)
    ON CONFLICT DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_risk_score_user_status ON risk_score_history;
CREATE TRIGGER trg_risk_score_user_status
  AFTER INSERT ON risk_score_history
  FOR EACH ROW
  EXECUTE FUNCTION update_user_status_on_risk();