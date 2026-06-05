-- database/pending/20260605_100000__add_circuit_breaker_tables.sql
-- Migration: Circuit Breaker State Tables
-- Description: Tables for persisting circuit breaker state across restarts (optional)

-- Circuit Breaker State Table
-- Stores circuit breaker state for recovery after gateway restart
CREATE TABLE IF NOT EXISTS circuit_breaker_state (
  service_name VARCHAR(64) PRIMARY KEY,
  state VARCHAR(16) NOT NULL DEFAULT 'CLOSED',  -- CLOSED, OPEN, HALF_OPEN
  failures INT NOT NULL DEFAULT 0,
  successes INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_failure_error TEXT,
  last_success_at TIMESTAMPTZ,
  total_calls BIGINT NOT NULL DEFAULT 0,
  successful_calls BIGINT NOT NULL DEFAULT 0,
  failed_calls BIGINT NOT NULL DEFAULT 0,
  rejected_calls BIGINT NOT NULL DEFAULT 0,
  config_json JSONB,  -- Store configuration for reference
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Circuit Breaker Events Log
-- Audit log of circuit breaker state changes
CREATE TABLE IF NOT EXISTS circuit_breaker_events (
  id BIGSERIAL PRIMARY KEY,
  service_name VARCHAR(64) NOT NULL,
  event_type VARCHAR(16) NOT NULL,  -- open, close, half-open
  from_state VARCHAR(16) NOT NULL,
  to_state VARCHAR(16) NOT NULL,
  failures INT,
  successes INT,
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying recent events
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_events_service_time 
  ON circuit_breaker_events(service_name, created_at DESC);

-- Fallback Events Log
-- Track when fallback strategies are triggered
CREATE TABLE IF NOT EXISTS fallback_events (
  id BIGSERIAL PRIMARY KEY,
  service_name VARCHAR(64) NOT NULL,
  operation VARCHAR(64),
  strategy_name VARCHAR(64) NOT NULL,
  user_id INT,
  request_id VARCHAR(64),
  error_message TEXT,
  fallback_result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying fallback events by service
CREATE INDEX IF NOT EXISTS idx_fallback_events_service_time 
  ON fallback_events(service_name, created_at DESC);

-- Index for querying fallback events by user
CREATE INDEX IF NOT EXISTS idx_fallback_events_user 
  ON fallback_events(user_id, created_at DESC);

-- Comment on tables
COMMENT ON TABLE circuit_breaker_state IS 'Persists circuit breaker state for recovery after gateway restart';
COMMENT ON TABLE circuit_breaker_events IS 'Audit log of circuit breaker state changes';
COMMENT ON TABLE fallback_events IS 'Track when fallback strategies are triggered';

-- Grant permissions (adjust as needed)
-- GRANT SELECT, INSERT, UPDATE ON circuit_breaker_state TO minego_app;
-- GRANT SELECT, INSERT ON circuit_breaker_events TO minego_app;
-- GRANT SELECT, INSERT ON fallback_events TO minego_app;
