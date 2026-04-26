// api/create-portal-session.js — Stripe customer portal session creator
//
// POST /api/create-portal-session
// Headers: Authorization: Bearer <supabase-jwt>
//
// Returns: { url: 'https://billing.stripe.com/...' }
//
// The frontend redirects the user to the returned URL. Stripe's hosted
// customer portal lets them: cancel subscription, update payment method,
// view invoice history, switch monthly<->annual.
//
// User must already have a stripe_customer_id in our subscriptions table
// (i.e. they've completed at least one checkout flow).

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

const SITE_URL = 'https://cometojesus.co';

async function getUserFromJwt(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;
  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error) return null;
    return data?.user || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const user = await getUserFromJwt(req.headers.authorization);
  if (!user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  // Look up the user's Stripe customer ID
  const { data: sub, error } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .not('stripe_customer_id', 'is', null)
    .maybeSingle();

  if (error) {
    console.error('subscriptions query error:', error);
    return res.status(500).json({ error: 'database_error' });
  }

  if (!sub?.stripe_customer_id) {
    return res.status(404).json({ error: 'no_subscription', detail: 'no stripe customer found for this user' });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${SITE_URL}/`,
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('billingPortal.sessions.create failed:', e);
    return res.status(500).json({ error: 'portal_creation_failed', detail: e.message });
  }
}
