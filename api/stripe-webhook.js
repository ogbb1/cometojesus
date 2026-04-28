// api/stripe-webhook.js — Stripe webhook handler
//
// Receives subscription events from Stripe, validates signature,
// writes subscription state to Supabase. This is the single source
// of truth for who is paid.
//
// Configured Stripe events:
//   - checkout.session.completed       (new subscription started)
//   - customer.subscription.created    (subscription record created)
//   - customer.subscription.updated    (plan change, cancel scheduled, etc.)
//   - customer.subscription.deleted    (subscription fully ended)
//   - invoice.payment_succeeded        (recurring renewal succeeded)
//   - invoice.payment_failed           (card declined on renewal)
//
// The endpoint MUST:
//   1. Read the raw body (NOT JSON-parsed) for signature verification
//   2. Verify the Stripe-Signature header against STRIPE_WEBHOOK_SECRET
//   3. Always return 200 quickly — Stripe retries on failure
//   4. Be idempotent — same event may fire multiple times

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Vercel needs raw body for signature verification.
// This config tells Vercel NOT to parse the body as JSON.
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

// ============================================================
// Helpers
// ============================================================

// Read the raw request body as a Buffer.
// Vercel requires this for Stripe signature verification.
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Resolve our internal user_id from a Stripe customer.
// We store user_id in subscription metadata at checkout creation.
// Falls back to looking up by stripe_customer_id in our subscriptions table.
async function resolveUserId(customerId, subscription) {
  // Prefer metadata set during checkout (most reliable)
  if (subscription?.metadata?.user_id) {
    return subscription.metadata.user_id;
  }

  // Fall back to existing subscription row
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (error) {
    console.error('resolveUserId: query error', error);
    return null;
  }
  return data?.user_id || null;
}

// Map Stripe price ID to plan_type.
// We use env vars so this works in test and live without code changes.
function planTypeFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_ID_MONTHLY) return 'monthly';
  if (priceId === process.env.STRIPE_PRICE_ID_ANNUAL) return 'annual';
  return null;
}

// Upsert the subscription row for this user.
// Idempotent — handles new subscriptions and updates the same way.
async function upsertSubscription({ userId, subscription }) {
  if (!userId || !subscription) {
    console.error('upsertSubscription: missing userId or subscription');
    return;
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const planType = planTypeFromPriceId(priceId);

  // current_period_end was at the subscription root in older Stripe API versions,
  // but in newer versions (2026+) it lives on the subscription item. Read both.
  const periodEnd =
    subscription.current_period_end ||
    subscription.items?.data?.[0]?.current_period_end ||
    null;

  const row = {
    user_id: userId,
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    plan_type: planType,
    current_period_end: periodEnd
      ? new Date(periodEnd * 1000).toISOString()
      : null,
    cancel_at_period_end: !!subscription.cancel_at_period_end,
    canceled_at: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  };

  // Use user_id as conflict key — schema enforces one subscription row per user.
  // Whether new or updating, we write the latest Stripe state to the same row.
  const { error } = await supabaseAdmin
    .from('subscriptions')
    .upsert(row, { onConflict: 'user_id' });

  if (error) {
    console.error('upsertSubscription error:', error);
    throw error;
  }
}

// ============================================================
// Event handlers
// ============================================================

async function handleCheckoutCompleted(session) {
  // The checkout session itself doesn't have all subscription details,
  // so we fetch the full subscription and pass it to the upsert.
  if (!session.subscription) {
    console.warn('checkout.session.completed without subscription:', session.id);
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(session.subscription);

  // user_id should be in client_reference_id (set when creating session)
  // OR in subscription metadata. Prefer client_reference_id from session.
  const userId =
    session.client_reference_id ||
    subscription.metadata?.user_id ||
    (await resolveUserId(session.customer, subscription));

  if (!userId) {
    console.error('checkout.session.completed: cannot resolve user_id', {
      session_id: session.id,
      customer: session.customer,
    });
    return;
  }

  // Make sure user_id is in subscription metadata for future events
  if (!subscription.metadata?.user_id) {
    try {
      await stripe.subscriptions.update(subscription.id, {
        metadata: { ...subscription.metadata, user_id: userId },
      });
    } catch (e) {
      console.warn('failed to set user_id on subscription metadata:', e.message);
    }
  }

  await upsertSubscription({ userId, subscription });
  console.log('[stripe-webhook] checkout.session.completed handled for user', userId);
}

async function handleSubscriptionEvent(subscription) {
  const userId = await resolveUserId(subscription.customer, subscription);
  if (!userId) {
    console.error('subscription event: cannot resolve user_id', {
      subscription_id: subscription.id,
      customer: subscription.customer,
    });
    return;
  }
  await upsertSubscription({ userId, subscription });
}

async function handleInvoiceEvent(invoice, eventType) {
  // For renewals, just refresh the subscription state.
  // For payment_failed, the subscription status will be 'past_due'.
  if (!invoice.subscription) return;

  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
  const userId = await resolveUserId(invoice.customer, subscription);
  if (!userId) return;

  await upsertSubscription({ userId, subscription });

  // On a successful first payment or renewal, roll over the user's billing
  // period: reset cost/message counters and clear yellow/red alert flags so
  // thresholds work fresh next cycle. Suspension flag is intentionally NOT
  // cleared; abusers must be unsuspended manually after investigation.
  // Skip subscription_update (mid-cycle proration) since the period hasn't
  // actually rolled over.
  if (
    eventType === 'invoice.payment_succeeded' &&
    (invoice.billing_reason === 'subscription_create' ||
      invoice.billing_reason === 'subscription_cycle')
  ) {
    const { error } = await supabaseAdmin.rpc('reset_user_billing_period', {
      p_user_id: userId,
    });
    if (error) {
      console.error('[stripe-webhook] reset_user_billing_period failed:', error);
      throw error;
    }
    console.log('[stripe-webhook] billing period reset for user', userId, '(' + invoice.billing_reason + ')');
  }

  if (eventType === 'invoice.payment_failed') {
    console.warn('[stripe-webhook] payment failed for user', userId, 'subscription', subscription.id);
    // TODO future: send email to user warning them card was declined
  }
}

// ============================================================
// Main handler
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    console.error('[stripe-webhook] missing stripe-signature header');
    return res.status(400).json({ error: 'missing_signature' });
  }

  let event;
  let rawBody;
  try {
    rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'invalid_signature' });
  }

  console.log('[stripe-webhook] event:', event.type, event.id);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionEvent(event.data.object);
        break;

      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
        await handleInvoiceEvent(event.data.object, event.type);
        break;

      default:
        console.log('[stripe-webhook] unhandled event type:', event.type);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err);
    // Return 500 so Stripe retries
    return res.status(500).json({ error: 'handler_error' });
  }
}
