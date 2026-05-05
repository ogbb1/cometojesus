-- ============================================================
-- Come to Jesus: first-party funnel analytics events
-- Run this in Supabase SQL Editor
-- Safe to re-run (uses IF NOT EXISTS)
-- ============================================================
--
-- Stores lightweight product analytics events only. Do not store chat text,
-- generated replies, prompts, or other sensitive conversation content here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  anonymous_id TEXT,
  session_id TEXT,
  conversation_id TEXT,
  page_path TEXT,
  referrer_host TEXT,
  device_type TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT analytics_events_event_name_len
    CHECK (char_length(event_name) BETWEEN 2 AND 80)
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
  ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_created
  ON analytics_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_created
  ON analytics_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_anon_created
  ON analytics_events(anonymous_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_page_created
  ON analytics_events(page_path, created_at DESC);

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON analytics_events;
CREATE POLICY "service_role_full_access" ON analytics_events
  FOR ALL USING (auth.role() = 'service_role');

-- Optional verification:
-- SELECT 'analytics_events exists' AS check, COUNT(*) AS rows FROM analytics_events;
