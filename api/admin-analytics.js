import {
  getUserFromJwt,
  isAdminEmail,
  supabaseAdmin,
} from '../lib/analytics-server.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function dollarsFromMicros(micros) {
  return Math.round((micros || 0) / 10000) / 100;
}

function dateKey(iso) {
  return String(iso || '').slice(0, 10);
}

function increment(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function topEntries(map, limit = 8) {
  return Object.entries(map)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function identityFor(row) {
  return row.user_id || row.anonymous_id || row.session_id || null;
}

async function getEmailsForUsers(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))].slice(0, 50);
  if (ids.length === 0) return {};

  try {
    const users = await Promise.all(ids.map(async (id) => {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(id);
      if (error || !data?.user?.email) return null;
      return [id, data.user.email];
    }));
    return Object.fromEntries(users.filter(Boolean));
  } catch (err) {
    console.warn('admin email lookup failed:', err.message);
    return {};
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const user = await getUserFromJwt(req.headers.authorization);
  if (!user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  if (!isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'not_authorized' });
  }

  const requestedDays = Number.parseInt(req.query.days || '30', 10);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(requestedDays, 1), 90)
    : 30;
  const since = new Date(Date.now() - days * DAY_MS).toISOString();

  const response = {
    admin: { email: user.email },
    generatedAt: new Date().toISOString(),
    rangeDays: days,
    setup: { analyticsEventsTable: true },
    summary: {
      visitors: 0,
      pageViews: 0,
      trackedEvents: 0,
      chatStarts: 0,
      limitHits: 0,
      checkoutStarts: 0,
      subscriptionCompletions: 0,
      signupCompletions: 0,
      chatMessages: 0,
      estimatedSpendDollars: 0,
      activePaidUsers: 0,
      monthlyPaidUsers: 0,
      annualPaidUsers: 0,
      estimatedMrrDollars: 0,
    },
    funnel: [],
    eventsByName: [],
    daily: [],
    topPages: [],
    topReferrers: [],
    topSpenders: [],
    subscriptions: [],
    recentEvents: [],
  };

  let events = [];
  const eventsResult = await supabaseAdmin
    .from('analytics_events')
    .select('event_name, user_id, anonymous_id, session_id, page_path, referrer_host, device_type, metadata, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20000);

  if (eventsResult.error) {
    response.setup.analyticsEventsTable = false;
    response.setup.analyticsEventsError = eventsResult.error.message;
  } else {
    events = eventsResult.data || [];
  }

  const eventCounts = {};
  const pageCounts = {};
  // Attribution = unique visitors per traffic source. Counts events would
  // double-count anyone who clicks around the site (every internal nav
  // would inflate their source). We track unique identities per source
  // and report THAT.
  const sourceVisitors = {};
  const uniqueVisitors = new Set();
  const daily = {};
  const funnelEvents = [
    ['page_view', 'visited'],
    ['home_begin_clicked', 'begin clicked'],
    ['chat_gate_entered', 'entered chat'],
    ['chat_started', 'sent first message'],
    ['limit_hit', 'hit limit'],
    ['upgrade_clicked', 'upgrade clicked'],
    ['checkout_started', 'checkout started'],
    ['subscription_completed', 'subscribed'],
  ];
  const funnelUniques = Object.fromEntries(funnelEvents.map(([name]) => [name, new Set()]));

  for (const event of events) {
    const name = event.event_name;
    const day = dateKey(event.created_at);
    const identity = identityFor(event);

    increment(eventCounts, name);
    increment(pageCounts, event.page_path);
    if (identity) uniqueVisitors.add(identity);

    // Attribution: prefer the new metadata.entry_source (sticky per session,
    // captures TikTok/IG/etc. with utm fallback to host normalization).
    // Fall back to referrer_host for legacy rows. Skip "internal" so the
    // top sources reflect inbound traffic only — not page-to-page nav.
    const entrySource = (event.metadata && event.metadata.entry_source) || event.referrer_host;
    if (identity && entrySource && entrySource !== 'internal') {
      if (!sourceVisitors[entrySource]) sourceVisitors[entrySource] = new Set();
      sourceVisitors[entrySource].add(identity);
    }

    if (!daily[day]) {
      daily[day] = {
        date: day,
        visitors: new Set(),
        pageViews: 0,
        chatStarts: 0,
        signups: 0,
        checkoutStarts: 0,
        subscriptions: 0,
      };
    }
    if (identity) daily[day].visitors.add(identity);
    if (name === 'page_view') daily[day].pageViews += 1;
    if (name === 'chat_started') daily[day].chatStarts += 1;
    if (name === 'signup_completed') daily[day].signups += 1;
    if (name === 'checkout_started') daily[day].checkoutStarts += 1;
    if (name === 'subscription_completed') daily[day].subscriptions += 1;

    if (funnelUniques[name] && identity) funnelUniques[name].add(identity);
  }

  response.summary.visitors = uniqueVisitors.size;
  response.summary.pageViews = eventCounts.page_view || 0;
  response.summary.trackedEvents = events.length;
  response.summary.chatStarts = eventCounts.chat_started || 0;
  response.summary.limitHits = eventCounts.limit_hit || 0;
  response.summary.checkoutStarts = eventCounts.checkout_started || 0;
  response.summary.subscriptionCompletions = eventCounts.subscription_completed || 0;
  response.summary.signupCompletions = eventCounts.signup_completed || 0;
  response.eventsByName = topEntries(eventCounts, 20);
  response.topPages = topEntries(pageCounts, 10);

  // topSources = unique visitors per traffic source, "internal" excluded.
  // This replaces the old topReferrers (which was dominated by "internal"
  // because every same-host page nav fired an event).
  const sourceCounts = {};
  for (const key of Object.keys(sourceVisitors)) {
    sourceCounts[key] = sourceVisitors[key].size;
  }
  const totalAttributed = Object.values(sourceCounts).reduce((a, b) => a + b, 0);
  // Each source row carries `share` (% of attributed visitors) so the
  // dashboard can render a horizontal bar without recomputing it.
  response.topSources = topEntries(sourceCounts, 12).map((row) => ({
    ...row,
    share: totalAttributed ? Math.round((row.count / totalAttributed) * 100) : 0,
  }));
  // Keep topReferrers field name for backward compat with any older
  // dashboard render — same shape, same data.
  response.topReferrers = response.topSources;
  response.summary.attributedVisitors = totalAttributed;
  // unattributed = identities seen but never tied to a source row
  // (typically because their only events predate the entry_source change
  // AND had a null referrer_host). Useful "data quality" signal.
  response.summary.unattributedVisitors = Math.max(0, uniqueVisitors.size - totalAttributed);

  // Funnel rows include conversionFromPrevPct (% of the previous step that
  // made it to this step) and dropoffPct so the dashboard can render the
  // leak between each pair of steps without recomputing it client-side.
  let prevUnique = null;
  response.funnel = funnelEvents.map(([name, label]) => {
    const unique = funnelUniques[name]?.size || 0;
    const conversionFromPrevPct = prevUnique && prevUnique > 0
      ? Math.round((unique / prevUnique) * 100)
      : null;
    const row = {
      name,
      label,
      count: eventCounts[name] || 0,
      unique,
      conversionFromPrevPct,
      dropoffPct: conversionFromPrevPct == null ? null : 100 - conversionFromPrevPct,
    };
    prevUnique = unique;
    return row;
  });
  response.daily = Object.values(daily)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => ({ ...row, visitors: row.visitors.size }));
  response.recentEvents = events.slice(0, 30).map((event) => ({
    event: event.event_name,
    when: event.created_at,
    page: event.page_path,
    source: (event.metadata && event.metadata.entry_source) || event.referrer_host || 'direct',
    device: event.device_type,
    metadata: event.metadata || {},
  }));

  const usageResult = await supabaseAdmin
    .from('usage_log')
    .select('created_at, user_id, cost_micros')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20000);

  if (!usageResult.error) {
    const usage = usageResult.data || [];
    const costByUser = {};
    let totalMicros = 0;
    for (const row of usage) {
      const micros = row.cost_micros || 0;
      totalMicros += micros;
      if (row.user_id) increment(costByUser, row.user_id, micros);
    }

    response.summary.chatMessages = usage.length;
    response.summary.estimatedSpendDollars = dollarsFromMicros(totalMicros);

    const topUserIds = Object.keys(costByUser)
      .sort((a, b) => costByUser[b] - costByUser[a])
      .slice(0, 8);
    const emailsByUser = await getEmailsForUsers(topUserIds);
    response.topSpenders = topUserIds.map((id) => ({
      userId: id,
      email: emailsByUser[id] || null,
      dollars: dollarsFromMicros(costByUser[id]),
      calls: usage.filter((row) => row.user_id === id).length,
    }));
  }

  const subsResult = await supabaseAdmin
    .from('subscriptions')
    .select('user_id, status, plan_type, cancel_at_period_end, current_period_end, updated_at')
    .order('updated_at', { ascending: false })
    .limit(500);

  if (!subsResult.error) {
    const subs = subsResult.data || [];
    const paid = subs.filter((sub) => ['active', 'trialing'].includes(sub.status));
    const emailsByUser = await getEmailsForUsers(paid.map((sub) => sub.user_id));
    response.summary.activePaidUsers = paid.length;
    response.summary.monthlyPaidUsers = paid.filter((sub) => sub.plan_type === 'monthly').length;
    response.summary.annualPaidUsers = paid.filter((sub) => sub.plan_type === 'annual').length;

    // Estimated MRR: monthly subs × $9.99 + annual subs × ($99.99 / 12).
    // Snapshot only — based on currently active subscriptions, not historical
    // billing events. For a proper MRR trend we'd need to track the
    // subscription lifecycle table over time. This is the accurate
    // "if everyone paid this month at current pricing" number.
    const monthlyMrr = paid.filter((sub) => sub.plan_type === 'monthly').length * 9.99;
    const annualMrr = paid.filter((sub) => sub.plan_type === 'annual').length * (99.99 / 12);
    response.summary.estimatedMrrDollars = Math.round((monthlyMrr + annualMrr) * 100) / 100;

    response.subscriptions = paid.slice(0, 20).map((sub) => ({
      email: emailsByUser[sub.user_id] || null,
      userId: sub.user_id,
      status: sub.status,
      plan: sub.plan_type,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodEnd: sub.current_period_end,
    }));
  }

  return res.status(200).json(response);
}
