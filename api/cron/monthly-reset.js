// api/cron/monthly-reset.js
//
// Monthly free-tier re-engagement. Runs on the 1st of each month at 14:00 UTC
// (9am ET / 6am PT). Finds users who used the chat in the previous month and
// don't have an active subscription, then emails them a "your messages are
// restored" note.
//
// Why: free users hit the 10/mo wall and bounce with no reason to come back.
// A monthly transactional reminder is the simplest re-engagement loop and
// captures the slice of free users who'd convert if they just remembered.
//
// Auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET>.
// Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY.

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const FROM = 'come to Jesus <support@cometojesus.co>';

// Pool of soft prompts to vary the email body across months. Kept short and
// inviting, not preachy. Each is a question or a one-line scripture pointer
// that gives the user a thread to pull on if they open the chat.
const PROMPT_POOL = [
  'what have you been carrying that you haven\'t said out loud?',
  'what is one question you\'ve been afraid to ask?',
  'who is one person you owe a real conversation with?',
  'what would change if you stopped pretending you had it figured out?',
  'where in your life have you stopped expecting Him to show up?',
];

function pickPrompt() {
  return PROMPT_POOL[Math.floor(Math.random() * PROMPT_POOL.length)];
}

async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set, skipping monthly reset email');
    return { ok: false, reason: 'no_api_key' };
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    if (!response.ok) {
      const errBody = await response.text();
      console.error('Resend send failed:', response.status, errBody, 'to:', to);
      return { ok: false, reason: 'resend_error' };
    }
    return { ok: true };
  } catch (err) {
    console.error('Resend send threw:', err, 'to:', to);
    return { ok: false, reason: 'exception' };
  }
}

function buildEmailHtml(prompt) {
  return `
<div style="font-family:'Cormorant Garamond',Georgia,serif;line-height:1.6;color:#1c1409;max-width:520px;background:#f4eadb;padding:48px 32px">
  <p style="font-style:italic;font-size:13px;letter-spacing:0.22em;color:#7a5a30;text-transform:uppercase;margin:0 0 28px 0">a quiet reminder</p>
  <p style="font-family:Fraunces,Georgia,serif;font-size:36px;font-style:italic;font-weight:500;line-height:1.1;color:#1c1409;margin:0 0 28px 0">your messages are restored.</p>
  <p style="font-size:18px;line-height:1.55;color:#3a2c18;margin:0 0 24px 0">a new month means ten fresh messages. nothing has to be said. but if something has been sitting with you, this is your invitation.</p>
  <p style="font-size:18px;line-height:1.55;color:#1c1409;margin:0 0 32px 0;font-style:italic">${prompt}</p>
  <p style="margin:0 0 32px 0">
    <a href="https://cometojesus.co/chat.html" style="display:inline-block;background:#1c1409;color:#f4eadb;text-decoration:none;padding:14px 24px;border-radius:8px;font-family:Georgia,serif;font-size:12px;letter-spacing:0.18em;text-transform:uppercase">begin a conversation</a>
  </p>
  <hr style="border:none;border-top:1px solid rgba(28,20,9,0.12);margin:32px 0">
  <p style="font-size:12px;color:#7a5a30;font-style:italic;margin:0 0 8px 0">cometojesus.co. an imagined conversation, rooted in the gospels.</p>
  <p style="font-size:11px;color:#9a8c76;margin:0">questions? reply to this email or write <a href="mailto:support@cometojesus.co" style="color:#7a5a30">support@cometojesus.co</a>.</p>
</div>`;
}

export default async function handler(req, res) {
  // Auth: only accept Vercel Cron's signed request.
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Compute the previous calendar month's bounds.
  const now = new Date();
  const startPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const endPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // Find unique user_ids that sent messages last month.
  const { data: usageRows, error: usageErr } = await supabaseAdmin
    .from('usage_log')
    .select('user_id')
    .gte('created_at', startPrev.toISOString())
    .lt('created_at', endPrev.toISOString())
    .not('user_id', 'is', null);

  if (usageErr) {
    console.error('monthly-reset usage_log query error:', usageErr);
    return res.status(500).json({ error: 'usage query failed' });
  }

  const userIdSet = new Set((usageRows || []).map(r => r.user_id).filter(Boolean));
  const userIds = Array.from(userIdSet);
  if (userIds.length === 0) {
    return res.status(200).json({ ok: true, sent: 0, reason: 'no_active_users_last_month' });
  }

  // Filter out users with active subscriptions (paid users don't need the
  // reset reminder; their messages are unlimited).
  const { data: subs } = await supabaseAdmin
    .from('subscriptions')
    .select('user_id')
    .in('user_id', userIds)
    .in('status', ['active', 'trialing']);
  const paidIds = new Set((subs || []).map(s => s.user_id));
  const freeUserIds = userIds.filter(id => !paidIds.has(id));

  if (freeUserIds.length === 0) {
    return res.status(200).json({ ok: true, sent: 0, reason: 'all_users_paid' });
  }

  // Fetch emails for the free users.
  const { data: users, error: usersErr } = await supabaseAdmin
    .schema('auth')
    .from('users')
    .select('id, email')
    .in('id', freeUserIds);

  if (usersErr) {
    console.error('monthly-reset auth.users query error:', usersErr);
    return res.status(500).json({ error: 'users query failed' });
  }

  // Send a "messages restored" email to each free user. Vary the prompt per
  // recipient so every user doesn't get the same line if they share inboxes.
  let sentCount = 0;
  let failCount = 0;
  const subject = 'your messages are restored';

  for (const user of (users || [])) {
    if (!user.email) continue;
    const html = buildEmailHtml(pickPrompt());
    const result = await sendResendEmail({ to: user.email, subject, html });
    if (result.ok) sentCount++;
    else failCount++;
    // Soft rate limit: 100ms between sends so we stay well under Resend's
    // free-tier 100 emails/day cap during testing.
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`[cron/monthly-reset] sent ${sentCount}, failed ${failCount}, free users found ${freeUserIds.length}`);

  return res.status(200).json({
    ok: true,
    sent: sentCount,
    failed: failCount,
    free_users_found: freeUserIds.length,
    period_start: startPrev.toISOString(),
    period_end: endPrev.toISOString(),
  });
}
