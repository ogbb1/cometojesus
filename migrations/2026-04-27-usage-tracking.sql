-- ============================================================
-- Come to Jesus: Usage tracking, suspension, and audit log
-- Run this in Supabase SQL Editor
-- Safe to re-run (uses IF NOT EXISTS)
-- ============================================================

-- ----- Part 1: usage_log table (every API call, audit trail) -----

CREATE TABLE IF NOT EXISTS usage_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  fingerprint TEXT,
  conversation_id TEXT,
  tier TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cache_read_tokens INT NOT NULL DEFAULT 0,
  cache_write_tokens INT NOT NULL DEFAULT 0,
  cost_cents INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_log_user_id ON usage_log(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_log_created_at ON usage_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_log_user_created ON usage_log(user_id, created_at DESC);

-- RLS: only service_role can read/write (server-side only)
ALTER TABLE usage_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON usage_log;
CREATE POLICY "service_role_full_access" ON usage_log
  FOR ALL USING (auth.role() = 'service_role');


-- ----- Part 2: user_billing_period table (per-user period rollup) -----
-- One row per user per billing period. Lets us check thresholds in O(1)
-- without summing thousands of usage_log rows on every request.

CREATE TABLE IF NOT EXISTS user_billing_period (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  period_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_cost_cents INT NOT NULL DEFAULT 0,
  period_message_count INT NOT NULL DEFAULT 0,
  yellow_alert_sent BOOLEAN NOT NULL DEFAULT FALSE,
  red_alert_sent BOOLEAN NOT NULL DEFAULT FALSE,
  is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_period_suspended ON user_billing_period(is_suspended) WHERE is_suspended = TRUE;
CREATE INDEX IF NOT EXISTS idx_billing_period_cost ON user_billing_period(period_cost_cents DESC);

ALTER TABLE user_billing_period ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON user_billing_period;
CREATE POLICY "service_role_full_access" ON user_billing_period
  FOR ALL USING (auth.role() = 'service_role');


-- ----- Part 3: helper function to reset a user's period -----
-- Called when their Stripe billing renews. Resets counters but keeps suspension
-- (suspension must be cleared manually after investigation).

CREATE OR REPLACE FUNCTION reset_user_billing_period(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE user_billing_period
  SET period_started_at = NOW(),
      period_cost_cents = 0,
      period_message_count = 0,
      yellow_alert_sent = FALSE,
      red_alert_sent = FALSE,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    INSERT INTO user_billing_period (user_id) VALUES (p_user_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ----- Part 4: helper function to atomically increment usage -----
-- Used on every API call. Returns the new cost_cents so the caller
-- can decide whether to fire alerts.

CREATE OR REPLACE FUNCTION record_user_usage(
  p_user_id UUID,
  p_cost_cents INT
)
RETURNS TABLE (
  new_cost_cents INT,
  yellow_already_sent BOOLEAN,
  red_already_sent BOOLEAN,
  is_suspended BOOLEAN
) AS $$
DECLARE
  result_row user_billing_period%ROWTYPE;
BEGIN
  -- Insert or update billing period row
  INSERT INTO user_billing_period (user_id, period_cost_cents, period_message_count)
  VALUES (p_user_id, p_cost_cents, 1)
  ON CONFLICT (user_id) DO UPDATE
    SET period_cost_cents = user_billing_period.period_cost_cents + p_cost_cents,
        period_message_count = user_billing_period.period_message_count + 1,
        updated_at = NOW()
  RETURNING * INTO result_row;

  RETURN QUERY SELECT
    result_row.period_cost_cents,
    result_row.yellow_alert_sent,
    result_row.red_alert_sent,
    result_row.is_suspended;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ----- Part 5: mark alerts as sent (so we don't spam) -----

CREATE OR REPLACE FUNCTION mark_yellow_alert_sent(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE user_billing_period
  SET yellow_alert_sent = TRUE, updated_at = NOW()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION mark_red_alert_sent_and_suspend(p_user_id UUID, p_reason TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE user_billing_period
  SET red_alert_sent = TRUE,
      is_suspended = TRUE,
      suspended_at = NOW(),
      suspended_reason = p_reason,
      updated_at = NOW()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ----- Part 6: admin query helper - "who's costing me money" -----
-- Run this anytime in SQL editor to see top users by cost this period

CREATE OR REPLACE VIEW admin_top_spenders AS
SELECT
  u.email,
  bp.user_id,
  bp.period_cost_cents,
  bp.period_message_count,
  bp.period_started_at,
  bp.is_suspended,
  bp.yellow_alert_sent,
  bp.red_alert_sent
FROM user_billing_period bp
JOIN auth.users u ON u.id = bp.user_id
ORDER BY bp.period_cost_cents DESC;


-- ============================================================
-- Verification queries (optional, run to check setup worked)
-- ============================================================

-- SELECT 'usage_log table exists' AS check, COUNT(*) AS rows FROM usage_log;
-- SELECT 'user_billing_period exists' AS check, COUNT(*) AS rows FROM user_billing_period;
-- SELECT 'admin_top_spenders view works' AS check, COUNT(*) AS rows FROM admin_top_spenders;
