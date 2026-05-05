import { createClient } from '@supabase/supabase-js';

export const DEFAULT_ADMIN_EMAIL = 'ograbowski132@gmail.com';

export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const FORBIDDEN_METADATA_KEY = /(message|content|prompt|reply|transcript|conversation|password|token|secret)/i;

export const TRACKED_EVENTS = new Set([
  'page_view',
  'home_begin_clicked',
  'home_pricing_clicked',
  'home_nav_clicked',
  'chat_gate_seen',
  'chat_gate_entered',
  'chat_started',
  'third_message_sent',
  'limit_hit',
  'signup_started',
  'signup_completed',
  'upgrade_clicked',
  'checkout_intent',
  'checkout_requires_auth',
  'checkout_started',
  'checkout_created',
  'subscription_completed',
  'subscription_payment_failed',
  'subscription_deleted',
  'auth_modal_opened',
  'sidebar_upgrade_clicked',
  'portal_opened',
]);

export function getAdminEmails() {
  const raw = [
    DEFAULT_ADMIN_EMAIL,
    process.env.ADMIN_EMAILS,
    process.env.ADMIN_EMAIL,
  ].filter(Boolean).join(',');

  return [...new Set(raw
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean))];
}

export function isAdminEmail(email) {
  if (!email) return false;
  return getAdminEmails().includes(email.trim().toLowerCase());
}

export async function getUserFromJwt(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error) return null;
    return data?.user || null;
  } catch (err) {
    console.warn('getUserFromJwt failed:', err.message);
    return null;
  }
}

export function sanitizeMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

  const out = {};
  for (const [rawKey, rawValue] of Object.entries(input).slice(0, 18)) {
    const key = String(rawKey || '').trim().slice(0, 48);
    if (!key || FORBIDDEN_METADATA_KEY.test(key)) continue;

    if (
      rawValue === null ||
      typeof rawValue === 'boolean' ||
      typeof rawValue === 'number'
    ) {
      out[key] = rawValue;
      continue;
    }

    if (typeof rawValue === 'string') {
      out[key] = rawValue.slice(0, 160);
    }
  }

  return out;
}

export function normalizePath(path) {
  if (!path || typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed || trimmed.length > 180) return null;
  return trimmed.startsWith('/') ? trimmed : null;
}

export function normalizeEventName(eventName) {
  const name = String(eventName || '').trim().toLowerCase();
  if (!/^[a-z0-9_:-]{2,80}$/.test(name)) return null;
  return TRACKED_EVENTS.has(name) ? name : null;
}

export async function recordAnalyticsEvent({
  eventName,
  userId = null,
  anonymousId = null,
  sessionId = null,
  conversationId = null,
  pagePath = null,
  referrerHost = null,
  deviceType = null,
  metadata = {},
}) {
  const safeEventName = normalizeEventName(eventName);
  if (!safeEventName) return { ok: false, skipped: 'invalid_event' };

  try {
    const { error } = await supabaseAdmin.from('analytics_events').insert({
      event_name: safeEventName,
      user_id: userId || null,
      anonymous_id: typeof anonymousId === 'string' ? anonymousId.slice(0, 80) : null,
      session_id: typeof sessionId === 'string' ? sessionId.slice(0, 80) : null,
      conversation_id: typeof conversationId === 'string' ? conversationId.slice(0, 80) : null,
      page_path: normalizePath(pagePath),
      referrer_host: typeof referrerHost === 'string' ? referrerHost.slice(0, 120) : null,
      device_type: typeof deviceType === 'string' ? deviceType.slice(0, 32) : null,
      metadata: sanitizeMetadata(metadata),
    });

    if (error) {
      console.warn('analytics event insert failed:', error.message);
      return { ok: false, error };
    }

    return { ok: true };
  } catch (err) {
    console.warn('analytics event insert threw:', err.message);
    return { ok: false, error: err };
  }
}
