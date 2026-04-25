// ============================================================================
// api/update-memory.js
//
// Background endpoint called by the frontend after a conversation has
// meaningful content. Uses a cheap Haiku model to:
//   1. Summarize the current conversation into one sentence
//   2. Extract new facts to add to the user's profile
//   3. If conversations > 20 exist, compress the 21st+ into historical_summary
//
// This endpoint is best-effort — it's OK if it fails. The main chat flow
// doesn't wait for it.
// ============================================================================

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
);

// Bypass UIDs (must match chat.js)
const BYPASS_USER_IDS = new Set([
  '150cd4bc-dcf9-4570-8d79-604eac447b60' // Oskar
]);

// Decode JWT payload (no signature verification — matches chat.js pattern)
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function isBypassUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const payload = decodeJwtPayload(token);
  if (!payload?.sub) return null;
  if (!BYPASS_USER_IDS.has(payload.sub)) return null;
  return { id: payload.sub, email: payload.email || null };
}

async function verifyAuthToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error) return null;
    return data?.user || null;
  } catch {
    return null;
  }
}

async function isUserPaid(userId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select('status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) return false;
    return !!data;
  } catch {
    return false;
  }
}

// Call Haiku to do the cheap summarization work
async function callHaiku(systemPrompt, userMessage) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('Haiku error:', response.status, errText);
      return null;
    }
    const data = await response.json();
    const text = (data.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('')
      .trim();
    return text;
  } catch (err) {
    console.error('callHaiku exception:', err);
    return null;
  }
}

// Generate a one-sentence summary of a conversation (for Jesus's memory context)
async function summarizeConversation(messages) {
  const convoText = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Jesus'}: ${m.content}`)
    .join('\n');

  const systemPrompt = `You are a summarizer. Given a conversation between a user and an AI Jesus, produce ONE SHORT SENTENCE describing what the conversation was about. Be specific about what the user shared or asked. Examples:
- "User shared that their mom died yesterday and asked how to grieve"
- "User asked philosophical questions about the meaning of suffering"
- "User confessed to an affair and struggled with what to tell their spouse"
- "User just checked in, said hi, shared that they were tired"

Output ONLY the summary sentence. No preamble, no quotes.`;

  return await callHaiku(systemPrompt, convoText);
}

// Generate a short poetic title for the sidebar display
// Examples: "The night of the confession", "A question of doubt", "The coming baby"
async function generatePoeticTitle(messages) {
  const convoText = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Jesus'}: ${m.content}`)
    .join('\n');

  const systemPrompt = `You are titling a conversation for a sidebar in a reverent product called cometojesus.co.

Produce a SHORT POETIC title (3-7 words) that captures the essence of the conversation without being clinical. The product's aesthetic is lowercase Cormorant italic — tender, slightly literary, warm but honest. Think chapter titles in a memoir, not news headlines.

Examples of the right register:
- "the coming baby"
- "a question of doubt"
- "the night of the confession"
- "what he couldn't tell his wife"
- "her mother, still in the hospital"
- "a quiet hello"
- "the empty chair"
- "wrestling with suffering"
- "just checking in"
- "the weight of a secret"

Rules:
- All lowercase
- No quotation marks, no periods at the end
- 3-7 words
- Evocative but not melodramatic
- Don't use the user's name even if you know it
- Don't reveal the worst specifics crudely (e.g. for an abortion conversation, "a heavy thing carried" is better than "the abortion")
- For light/casual conversations, use light/casual titles ("a quiet hello", "just saying hi")

Output ONLY the title. No preamble, no quotes, no explanation.`;

  const raw = await callHaiku(systemPrompt, convoText);
  if (!raw) return null;
  // Clean any stray quotes or trailing punctuation Haiku sometimes adds
  return raw.replace(/^["'`]+|["'`]+$/g, '').replace(/[.!?]+$/, '').toLowerCase().trim();
}

// Extract profile updates from a conversation. Returns a partial profile object
// (JSON) that should be merged into the existing profile.
async function extractProfileUpdates(messages, currentProfile) {
  const convoText = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Jesus'}: ${m.content}`)
    .join('\n');

  const systemPrompt = `You are a profile extractor for an AI Jesus product. Given a conversation, identify NEW facts about the user worth remembering for future conversations.

Current profile: ${JSON.stringify(currentProfile || {}, null, 2)}

Extract facts in these categories (only if newly disclosed — do NOT duplicate existing facts):
- name (first name if shared)
- age_range (if mentioned, e.g. "20s", "mid-30s", "60s")
- family (spouse, children, parents — with context like "married 2022" or "mom passed 2022")
- faith_journey (e.g. "new believer", "returning to faith", "doubting")
- ongoing_themes (recurring struggles or topics — e.g. "anxiety", "marriage struggles")
- recent_notes (current life events worth remembering — e.g. "baby due in 18 days", "starting new job next month")
- do_not_raise_unprompted (SENSITIVE confessions the user shared — abortion, affair, abuse, addiction, suicidal ideation. These should be remembered but NEVER raised by Jesus unprompted.)

Output ONLY valid JSON in this shape (only include fields where there's NEW info; omit empty fields):
{
  "name": "Sarah",
  "ongoing_themes": ["anxiety"]
}

If nothing new was disclosed, output: {}

Do NOT include any text outside the JSON. Do NOT wrap in markdown backticks.`;

  const raw = await callHaiku(systemPrompt, convoText);
  if (!raw) return {};

  // Strip markdown fences if Haiku added them despite instructions
  const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('extractProfileUpdates: JSON parse failed:', cleaned);
    return {};
  }
}

// Merge profile updates into existing profile (deep merge with array dedup)
function mergeProfile(existing, updates) {
  const merged = { ...(existing || {}) };
  for (const [key, value] of Object.entries(updates || {})) {
    if (Array.isArray(value)) {
      const existingArr = Array.isArray(merged[key]) ? merged[key] : [];
      // Dedup by stringifying (handles objects/strings)
      const set = new Set(existingArr.map(v => JSON.stringify(v)));
      for (const item of value) {
        const key2 = JSON.stringify(item);
        if (!set.has(key2)) {
          set.add(key2);
          existingArr.push(item);
        }
      }
      merged[key] = existingArr;
    } else if (typeof value === 'object' && value !== null) {
      merged[key] = { ...(merged[key] || {}), ...value };
    } else if (value !== null && value !== undefined && value !== '') {
      merged[key] = value;
    }
  }
  return merged;
}

// Compress conversations that are older than the recent 20 into historical_summary
async function compressOlderConversations(userId, existingSummary) {
  // Find conversations OLDER than the 20 most recent
  const { data: allConvos, error } = await supabaseAdmin
    .from('conversations')
    .select('id, summary, last_message_at')
    .eq('user_id', userId)
    .not('summary', 'is', null)
    .order('last_message_at', { ascending: false, nullsFirst: false });

  if (error || !allConvos || allConvos.length <= 20) {
    return existingSummary || '';
  }

  const toCompress = allConvos.slice(20);
  if (toCompress.length === 0) return existingSummary || '';

  // Build text to compress
  const toCompressText = toCompress
    .map(c => `- [${c.last_message_at ? new Date(c.last_message_at).toISOString().slice(0, 10) : 'unknown'}] ${c.summary}`)
    .join('\n');

  const systemPrompt = `You are a memory compressor for an AI Jesus product. Given a list of old conversation summaries (and any existing compressed history), produce a short paragraph (max ~150 words) that captures the arc of this user's journey with Jesus. Focus on recurring themes, life events, and growth patterns. Be tender and general — this is background knowledge, not surveillance.

Existing compressed history (if any):
${existingSummary || '(none yet)'}

Do NOT output bullet points. Output as a short natural-language paragraph. Start with "This user has ". Output ONLY the paragraph, no preamble.`;

  const newSummary = await callHaiku(systemPrompt, toCompressText);
  return newSummary || existingSummary || '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authenticate
  let user = isBypassUser(req);
  if (!user) {
    user = await verifyAuthToken(req);
  }
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Only paid users get memory
  const isBypass = BYPASS_USER_IDS.has(user.id);
  if (!isBypass) {
    const paid = await isUserPaid(user.id);
    if (!paid) {
      return res.status(200).json({ skipped: true, reason: 'not_paid' });
    }
  }

  const { conversationId, messages } = req.body || {};
  if (!conversationId || !Array.isArray(messages) || messages.length < 2) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    // Check memory is enabled
    const { data: memRow } = await supabaseAdmin
      .from('user_memory')
      .select('memory_enabled, profile, historical_summary')
      .eq('user_id', user.id)
      .maybeSingle();

    if (memRow && memRow.memory_enabled === false) {
      return res.status(200).json({ skipped: true, reason: 'disabled' });
    }

    const currentProfile = memRow?.profile || {};
    const currentHistSummary = memRow?.historical_summary || '';

    // 1. Summarize the conversation AND generate poetic title in parallel (both use Haiku)
    const [convoSummary, convoTitle] = await Promise.all([
      summarizeConversation(messages),
      generatePoeticTitle(messages)
    ]);

    // 2. Update conversations row with summary + title + last_message_at
    // The update is keyed on (id, user_id) as an ownership safeguard.
    // If the row doesn't exist yet (first update for this conversation),
    // upsert it so the sidebar can find it.
    const updatePayload = {
      id: conversationId,
      user_id: user.id,
      last_message_at: new Date().toISOString()
    };
    if (convoSummary) updatePayload.summary = convoSummary;
    if (convoTitle) updatePayload.title = convoTitle;

    if (convoSummary || convoTitle) {
      const { error: convoError } = await supabaseAdmin
        .from('conversations')
        .upsert(updatePayload, { onConflict: 'id' });
      if (convoError) {
        console.warn('conversations upsert error (non-fatal):', convoError);
      }
    }

    // 3. Extract profile updates
    const updates = await extractProfileUpdates(messages, currentProfile);
    const newProfile = mergeProfile(currentProfile, updates);

    // 4. Compress older conversations if needed
    const newHistSummary = await compressOlderConversations(user.id, currentHistSummary);

    // 5. Upsert the user_memory row
    const upsertPayload = {
      user_id: user.id,
      profile: newProfile,
      historical_summary: newHistSummary,
      updated_at: new Date().toISOString()
    };

    // Only set memory_enabled=true on first insert (don't override explicit off)
    if (!memRow) {
      upsertPayload.memory_enabled = true;
    }

    const { error: upsertError } = await supabaseAdmin
      .from('user_memory')
      .upsert(upsertPayload, { onConflict: 'user_id' });

    if (upsertError) {
      console.error('user_memory upsert error:', upsertError);
      return res.status(500).json({ error: 'Memory update failed' });
    }

    return res.status(200).json({
      ok: true,
      summarized: !!convoSummary,
      titled: !!convoTitle,
      title: convoTitle || null,
      profileUpdates: Object.keys(updates || {}),
      compressedHistorical: !!newHistSummary && newHistSummary !== currentHistSummary
    });
  } catch (err) {
    console.error('update-memory handler error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
