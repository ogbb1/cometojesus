// api/waitlist.js — collect emails for the paid-tier waitlist

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > 200) return false;
  // Simple sanity check — not a full RFC 5322 validator, doesn't need to be.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    // Store in a Redis set — dedupes automatically, never grows unbounded per user.
    await redis.sadd('waitlist:paid', email.toLowerCase().trim());
    // Also store a timestamp of when they signed up, for ordering later.
    await redis.hset('waitlist:paid:meta', {
      [email.toLowerCase().trim()]: Date.now()
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Waitlist error:', err);
    return res.status(500).json({ error: 'Could not save' });
  }
}
