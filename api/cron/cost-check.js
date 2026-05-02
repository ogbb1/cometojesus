// api/cron/cost-check.js
//
// Daily cost-monitor cron. Sums usage_log over the last 24 hours and emails
// Oskar if total Anthropic spend has crossed a configurable threshold.
// The per-user yellow/red alerts in chat.js are user-level safety nets;
// this is the global-spend safety net so a runaway day doesn't go unnoticed
// until the bill arrives.
//
// Auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET>. We refuse
// any request that doesn't match. Without CRON_SECRET set we skip the check
// (useful for local development).
//
// Threshold: DAILY_COST_ALERT_THRESHOLD_CENTS env var, default 1500 (=$15).

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const ALERT_EMAIL = 'ograbowski132@gmail.com';
const ALERT_FROM = 'come to jesus alerts <support@cometojesus.co>';

async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set, skipping cost-alert email');
    return;
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: ALERT_FROM, to: [to], subject, html }),
    });
    if (!response.ok) {
      const errBody = await response.text();
      console.error('Resend send failed:', response.status, errBody);
    }
  } catch (err) {
    console.error('Resend send threw:', err);
  }
}

export default async function handler(req, res) {
  // Auth: only accept Vercel Cron's signed request.
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const thresholdCents = parseInt(
    process.env.DAILY_COST_ALERT_THRESHOLD_CENTS || '1500',
    10
  );
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // usage_log stores cost in micros (1 cent = 10000 micros). Convert to
  // cents in-process so the rest of this function (thresholds, email
  // dollars math) stays simple.
  const { data: rows, error } = await supabaseAdmin
    .from('usage_log')
    .select('cost_micros, user_id')
    .gte('created_at', since);

  if (error) {
    console.error('cost-check query error:', error);
    return res.status(500).json({
      error: 'query failed',
      detail: error.message || String(error),
      code: error.code || null,
      hint: error.hint || null,
      url_set: !!process.env.SUPABASE_URL,
      key_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
  }

  const safeRows = rows || [];
  const totalMicros = safeRows.reduce((a, r) => a + (r.cost_micros || 0), 0);
  const totalCents = Math.floor(totalMicros / 10000);
  const callCount = safeRows.length;
  const uniqueUsers = new Set(
    safeRows.map(r => r.user_id).filter(Boolean)
  ).size;

  // Below threshold: log + return without emailing.
  if (totalCents < thresholdCents) {
    console.log(
      `[cron/cost-check] $${(totalCents / 100).toFixed(2)} in last 24h, below $${(thresholdCents / 100).toFixed(2)} threshold`
    );
    return res.status(200).json({
      ok: true,
      total_dollars: (totalCents / 100).toFixed(2),
      threshold_dollars: (thresholdCents / 100).toFixed(2),
      call_count: callCount,
      unique_users: uniqueUsers,
      below_threshold: true,
    });
  }

  // Above threshold: aggregate top spenders for the email. Sum in micros
  // for precision, convert to dollars only at display.
  const userTotalsMicros = {};
  for (const r of safeRows) {
    if (!r.user_id) continue;
    userTotalsMicros[r.user_id] = (userTotalsMicros[r.user_id] || 0) + (r.cost_micros || 0);
  }
  const topSpenders = Object.entries(userTotalsMicros)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([id, micros]) => ({ id, dollars: (micros / 1000000).toFixed(2) }));

  // Best-effort email resolution. Non-fatal if the auth-schema query fails.
  const userEmails = {};
  try {
    const ids = topSpenders.map(s => s.id);
    if (ids.length > 0) {
      const { data: users } = await supabaseAdmin
        .schema('auth')
        .from('users')
        .select('id, email')
        .in('id', ids);
      if (users) {
        for (const u of users) userEmails[u.id] = u.email;
      }
    }
  } catch (err) {
    console.warn('top-spender email lookup failed (non-fatal):', err);
  }

  const totalDollars = (totalCents / 100).toFixed(2);
  const thresholdDollars = (thresholdCents / 100).toFixed(2);
  const subject = `[cometojesus] daily spend alert, $${totalDollars} in last 24h`;
  const topRows = topSpenders
    .map(s => `<tr>
      <td style="padding:6px 10px 6px 0"><code style="font-size:11px">${s.id}</code></td>
      <td style="padding:6px 10px;text-align:right"><strong>$${s.dollars}</strong></td>
      <td style="padding:6px 0;color:#6c5e4a">${userEmails[s.id] || ''}</td>
    </tr>`)
    .join('');

  const html = `
<div style="font-family:-apple-system,sans-serif;line-height:1.6;color:#1c1409;max-width:560px">
  <h2 style="font-style:italic;font-weight:500;color:#a13e2c">Daily spend alert</h2>
  <p>Anthropic API spend in the last 24 hours crossed <strong>$${thresholdDollars}</strong>.</p>
  <hr style="border:none;border-top:1px solid #e5dfd2;margin:20px 0">
  <p><strong>Total:</strong> $${totalDollars}<br>
  <strong>API calls:</strong> ${callCount}<br>
  <strong>Unique users:</strong> ${uniqueUsers}</p>
  <hr style="border:none;border-top:1px solid #e5dfd2;margin:20px 0">
  <p style="font-size:13px;color:#6c5e4a"><strong>Top spenders (last 24h):</strong></p>
  <table style="font-size:13px;border-collapse:collapse;width:100%">${topRows}</table>
  <hr style="border:none;border-top:1px solid #e5dfd2;margin:20px 0">
  <p style="font-size:13px;color:#6c5e4a"><strong>Investigate a specific user:</strong></p>
  <pre style="background:#f4eadb;padding:12px;border-radius:4px;font-size:12px;overflow-x:auto">SELECT created_at, cost_cents, model, input_tokens, output_tokens
FROM usage_log
WHERE user_id = 'paste-uuid-here'
ORDER BY created_at DESC
LIMIT 50;</pre>
  <p style="font-size:13px;color:#6c5e4a"><strong>Tune or silence the alert:</strong> set <code>DAILY_COST_ALERT_THRESHOLD_CENTS</code> in Vercel env vars (current default 1500).</p>
  <p style="font-size:12px;color:#6c5e4a;margin-top:30px">come to jesus &middot; automated daily cost monitor</p>
</div>`;

  await sendResendEmail({ to: ALERT_EMAIL, subject, html });

  console.log(
    `[cron/cost-check] alerted, $${totalDollars} crossed $${thresholdDollars} threshold`
  );

  return res.status(200).json({
    ok: true,
    total_dollars: totalDollars,
    threshold_dollars: thresholdDollars,
    call_count: callCount,
    unique_users: uniqueUsers,
    top_spender_count: topSpenders.length,
    alerted: true,
  });
}
