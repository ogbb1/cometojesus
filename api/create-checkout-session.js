// api/create-checkout-session.js — Stripe checkout session creator
//
// POST /api/create-checkout-session
// Body: { plan: 'monthly' | 'annual' }
// Headers: Authorization: Bearer <supabase-jwt>
//
// Returns: { url: 'https://checkout.stripe.com/...' }
//
// The frontend redirects the user to the returned URL. Stripe handles
// the entire checkout flow on their hosted page. After payment, Stripe
// redirects back to the success_url and fires webhook events.

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

// ============================================================
// Helpers
// ============================================================

// Verify the JWT and return the user record, or null if invalid.
async function getUserFromJwt(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error) {
      console.warn('getUser error:', error.message);
      return null;
    }
    return data?.user || null;
  } catch (e) {
    console.error('getUser threw:', e.message);
    return null;
  }
}

// Find an existing Stripe customer ID for this user, or create one.
// We persist this in the subscriptions table so the same user always
// maps to the same Stripe customer (preserves payment history).
async function getOrCreateStripeCustomer(userId, email) {
  // Check if we already have a Stripe customer ID for this user
  const { data: existing, error: queryError } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .not('stripe_customer_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (queryError) {
    console.warn('subscriptions query error:', queryError.message);
  }

  if (existing?.stripe_customer_id) {
    // Verify the customer still exists in Stripe (could be deleted)
    try {
      const customer = await stripe.customers.retrieve(existing.stripe_customer_id);
      if (!customer.deleted) {
        return existing.stripe_customer_id;
      }
    } catch (e) {
      console.warn('stripe customer retrieve failed, will create new:', e.message);
    }
  }

  // Create a new Stripe customer
  const customer = await stripe.customers.create({
    email,
    metadata: { user_id: userId },
  });

  // Pre-create a subscriptions row with inactive status so we have
  // somewhere to write back to when the webhook fires (defensive).
  // The webhook will upsert and update fields properly.
  await supabaseAdmin
    .from('subscriptions')
    .upsert(
      {
        user_id: userId,
        stripe_customer_id: customer.id,
        status: 'inactive',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );

  return customer.id;
}

// ============================================================
// Main handler
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // 1. Authenticate user
  const user = await getUserFromJwt(req.headers.authorization);
  if (!user) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  // 2. Parse and validate plan choice
  const plan = (req.body?.plan || '').toLowerCase();
  let priceId;
  if (plan === 'monthly') {
    priceId = process.env.STRIPE_PRICE_ID_MONTHLY;
  } else if (plan === 'annual') {
    priceId = process.env.STRIPE_PRICE_ID_ANNUAL;
  } else {
    return res.status(400).json({ error: 'invalid_plan', detail: 'plan must be "monthly" or "annual"' });
  }

  if (!priceId) {
    console.error('Missing price ID env var for plan:', plan);
    return res.status(500).json({ error: 'configuration_error' });
  }

  // 3. Get or create Stripe customer
  let customerId;
  try {
    customerId = await getOrCreateStripeCustomer(user.id, user.email);
  } catch (e) {
    console.error('getOrCreateStripeCustomer failed:', e);
    return res.status(500).json({ error: 'customer_creation_failed' });
  }

  // 4. Create checkout session
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],

      // CRITICAL: client_reference_id links Stripe checkout to our user.
      // The webhook reads this to know which user just paid.
      client_reference_id: user.id,

      // Also put it in subscription metadata for redundancy
      subscription_data: {
        metadata: {
          user_id: user.id,
        },
      },

      // Where to send the user after they pay or cancel
      success_url: `${SITE_URL}/chat.html?upgraded=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/upgrade.html?canceled=true`,

      // Allow promo codes if you want to run promotions later
      allow_promotion_codes: true,

      // Collect billing address for tax compliance
      billing_address_collection: 'auto',
    });

    // Funnel measurement uses the client-side checkout_started fire (user
    // intent) plus the subscription_completed webhook (payment cleared).
    // The interim checkout_created event was dropped — internal API success
    // doesn't tell us anything the other two events don't.

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('checkout.sessions.create failed:', e);
    return res.status(500).json({ error: 'checkout_creation_failed', detail: e.message });
  }
}
