-- ============================================================
-- Come to Jesus: per-user billing period + abuse-suspension RPCs
-- Run this in Supabase SQL Editor
-- Safe to re-run (uses IF NOT EXISTS / OR REPLACE)
-- ============================================================
--
-- Why this exists:
-- The original 2026-04-27-usage-tracking.sql migration assumed
-- usage_log would store cost in cents. The actual production
-- usage_log table uses cost_micros (1 cent = 10,000 micros) and
-- different column names (cached_input_tokens, thinking_tokens).
-- Meanwhile, the user_billing_period table and its RPCs were
-- never created at all.
--
-- This migration creates the missing tables and RPCs, aligned to
-- the existing usage_log schema by using cost_micros throughout.
-- chat.js will be patched in the same release to multiply its
-- cost_cents -> cost_micros at I/O boundary, then read back to
-- cents for threshold comparison.

-- ----- Part 1: user_billing_period -----
CREATE TABLE IF NOT EXISTS user_billing_period (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  period_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_cost_micros BIGINT NOT NULL DEFAULT 0,
  period_message_count INT NOT NULL DEFAULT 0,
  yellow_alert_sent BOOLEAN NOT NULL DEFAULT FALSE,
  red_alert_sent BOOLEAN NOT NULL DEFAULT FALSE,
  is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_period_suspended
  ON user_billing_period(is_suspended) WHERE is_suspended = TRUE;
CREATE INDEX IF NOT EXISTS idx_billing_period_cost
  ON user_billing_period(period_cost_micros DESC);

ALTER TABLE user_billing_period ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON user_billing_period;
CREATE POLICY "service_role_full_access" ON user_billing_period
  FOR ALL USING (auth.role() = 'service_role');


-- ----- Part 2: record_user_usage -----
-- Atomically increments the user's billing period totals + returns
-- the new state so the caller can decide whether to fire alerts.
-- Cost is in MICROS to match usage_log.cost_micros.

CREATE OR REPLACE FUNCTION record_user_usage(
  p_user_id UUID,
  p_cost_micros BIGINT
)
RETURNS TABLE (
  new_cost_micros BIGINT,
  yellow_already_sent BOOLEAN,
  red_already_sent BOOLEAN,
  is_suspended BOOLEAN
) AS $$
DECLARE
  result_row user_billing_period%ROWTYPE;
BEGIN
  INSERT INTO user_billing_period (user_id, period_cost_micros, period_message_count)
  VALUES (p_user_id, p_cost_micros, 1)
  ON CONFLICT (user_id) DO UPDATE
    SET period_cost_micros = user_billing_period.period_cost_micros + p_cost_micros,
        period_message_count = user_billing_period.period_message_count + 1,
        updated_at = NOW()
  RETURNING * INTO result_row;

  RETURN QUERY SELECT
    result_row.period_cost_micros,
    result_row.yellow_alert_sent,
    result_row.red_alert_sent,
    result_row.is_suspended;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ----- Part 3: alert state helpers -----

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


-- ----- Part 4: reset on Stripe renewal -----
-- Called by stripe-webhook on subscription_create / subscription_cycle.
-- Clears period counters + alert flags. Suspension flag is intentionally
-- NOT cleared; abusers must be unsuspended manually after investigation.

CREATE OR REPLACE FUNCTION reset_user_billing_period(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE user_billing_period
  SET period_started_at = NOW(),
      period_cost_micros = 0,
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


-- ----- Part 5: admin view, "who's costing me money this period" -----

CREATE OR REPLACE VIEW admin_top_spenders AS
SELECT
  u.email,
  bp.user_id,
  bp.period_cost_micros,
  ROUND(bp.period_cost_micros / 10000.0)::INT AS period_cost_cents,
  ROUND(bp.period_cost_micros / 1000000.0, 2) AS period_cost_dollars,
  bp.period_message_count,
  bp.period_started_at,
  bp.is_suspended,
  bp.yellow_alert_sent,
  bp.red_alert_sent
FROM user_billing_period bp
JOIN auth.users u ON u.id = bp.user_id
ORDER BY bp.period_cost_micros DESC;


-- ============================================================
-- Verification queries (optional, run after to confirm):
-- ============================================================
-- SELECT 'user_billing_period exists' AS check, COUNT(*) AS rows FROM user_billing_period;
-- SELECT 'record_user_usage exists' AS check, COUNT(*) FROM pg_proc WHERE proname = 'record_user_usage';
-- SELECT 'reset_user_billing_period exists' AS check, COUNT(*) FROM pg_proc WHERE proname = 'reset_user_billing_period';
-- SELECT 'admin_top_spenders works' AS check, COUNT(*) FROM admin_top_spenders;
