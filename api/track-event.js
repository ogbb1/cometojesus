import {
  getUserFromJwt,
  normalizeEventName,
  normalizePath,
  recordAnalyticsEvent,
  sanitizeMetadata,
} from '../lib/analytics-server.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = req.body || {};
  const eventName = normalizeEventName(body.event || body.eventName);
  if (!eventName) {
    return res.status(400).json({ error: 'invalid_event' });
  }

  const user = await getUserFromJwt(req.headers.authorization);
  const result = await recordAnalyticsEvent({
    eventName,
    userId: user?.id || null,
    anonymousId: body.anonymousId,
    sessionId: body.sessionId,
    conversationId: body.conversationId,
    pagePath: normalizePath(body.pagePath),
    referrerHost: body.referrerHost,
    deviceType: body.deviceType,
    metadata: sanitizeMetadata(body.metadata),
  });

  if (!result.ok) {
    return res.status(202).json({ ok: false });
  }

  return res.status(200).json({ ok: true });
}
