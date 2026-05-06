(function () {
  var ANON_KEY = 'cometojesus_analytics_id';
  var SESSION_KEY = 'cometojesus_analytics_session_id';
  // Sticky for the SESSION — the host/utm_source we attribute the whole
  // session to. Set on first event of the session so deep-links into
  // /chat.html or /upgrade.html still get attributed to TikTok / Google /
  // wherever they came in from. Without this, a user who lands from TikTok
  // and then clicks "enter" would have all subsequent events labeled
  // "internal" because document.referrer is now cometojesus.co.
  var ENTRY_SOURCE_KEY = 'cometojesus_entry_source';
  var ENTRY_REFERRER_KEY = 'cometojesus_entry_referrer';
  var ENTRY_LANDING_KEY = 'cometojesus_entry_landing';
  var ENTRY_UTM_KEY = 'cometojesus_entry_utm';

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'anon_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function readStorage(storage, key) {
    try { return storage.getItem(key); } catch (e) { return null; }
  }

  function writeStorage(storage, key, value) {
    try { storage.setItem(key, value); } catch (e) {}
  }

  function getOrCreate(storage, key) {
    var value = readStorage(storage, key);
    if (!value) {
      value = uuid();
      writeStorage(storage, key, value);
    }
    return value;
  }

  function deviceType() {
    var width = window.innerWidth || 0;
    if (width <= 640) return 'mobile';
    if (width <= 1024) return 'tablet';
    return 'desktop';
  }

  function rawReferrerHost() {
    if (!document.referrer) return null;
    try {
      var url = new URL(document.referrer);
      return url.host || null;
    } catch (e) {
      return null;
    }
  }

  // Normalize a hostname to a coarse traffic-source label so the admin
  // sees "tiktok" instead of "vm.tiktok.com" / "www.tiktok.com" /
  // "m.tiktok.com" all separately. Returns lowercase short labels.
  function normalizeHost(host) {
    if (!host) return null;
    var h = host.toLowerCase();
    if (/(^|\.)tiktok\.com$/.test(h) || /(^|\.)tiktokcdn\.com$/.test(h)) return 'tiktok';
    if (/(^|\.)instagram\.com$/.test(h) || h === 'l.instagram.com') return 'instagram';
    if (/(^|\.)facebook\.com$/.test(h) || h === 'l.facebook.com' || h === 'lm.facebook.com' || h === 'm.facebook.com') return 'facebook';
    if (/(^|\.)threads\.net$/.test(h) || h === 'l.threads.net') return 'threads';
    if (h === 't.co' || /(^|\.)twitter\.com$/.test(h) || /(^|\.)x\.com$/.test(h)) return 'twitter/x';
    if (/(^|\.)youtube\.com$/.test(h) || h === 'youtu.be') return 'youtube';
    if (/(^|\.)reddit\.com$/.test(h) || h === 'out.reddit.com') return 'reddit';
    if (/(^|\.)pinterest\./.test(h)) return 'pinterest';
    if (/(^|\.)snapchat\.com$/.test(h)) return 'snapchat';
    if (/(^|\.)linkedin\.com$/.test(h) || h === 'lnkd.in') return 'linkedin';
    if (/(^|\.)bing\.com$/.test(h)) return 'bing';
    if (/(^|\.)duckduckgo\.com$/.test(h)) return 'duckduckgo';
    if (/(^|\.)yahoo\.com$/.test(h)) return 'yahoo';
    // Google: many TLDs (.com, .co.uk, .de, etc.) all roll up to "google"
    if (/(^|\.)google\.[a-z.]{2,8}$/.test(h)) return 'google';
    if (h === 'chatgpt.com' || /(^|\.)openai\.com$/.test(h)) return 'chatgpt';
    if (/(^|\.)perplexity\.ai$/.test(h)) return 'perplexity';
    if (/(^|\.)claude\.ai$/.test(h)) return 'claude';
    // Same-site = internal navigation
    try {
      if (h === window.location.host) return 'internal';
    } catch (e) {}
    // Unknown host — return cleaned hostname (strip leading www.)
    return h.replace(/^www\./, '');
  }

  // Read UTM params from the current URL. Used on first event of the
  // session to lock in the entry source. Drops empty / oversized values.
  function readUtm() {
    try {
      var p = new URLSearchParams(window.location.search);
      var out = {};
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (key) {
        var v = p.get(key);
        if (v && v.length <= 80) out[key] = v.toLowerCase();
      });
      return Object.keys(out).length ? out : null;
    } catch (e) { return null; }
  }

  // Compute the entry source for this session. Resolves once, caches in
  // sessionStorage so every subsequent event retains the same attribution.
  // Resolution order:
  //   1. utm_source on the landing URL ("tiktok" / "instagram" / etc.)
  //   2. Normalized referrer host (when external)
  //   3. Same-host referrer = "internal"
  //   4. No referrer + no utm = "direct"
  function getEntrySource() {
    var cached = readStorage(window.sessionStorage, ENTRY_SOURCE_KEY);
    if (cached) {
      return {
        source: cached,
        referrer: readStorage(window.sessionStorage, ENTRY_REFERRER_KEY) || null,
        landing: readStorage(window.sessionStorage, ENTRY_LANDING_KEY) || null,
        utm: parseUtmCache(),
      };
    }

    var utm = readUtm();
    var refHost = rawReferrerHost();
    var refLabel = normalizeHost(refHost);

    var source;
    if (utm && utm.utm_source) {
      source = utm.utm_source;
    } else if (refLabel && refLabel !== 'internal') {
      source = refLabel;
    } else if (refLabel === 'internal') {
      source = 'internal';
    } else {
      source = 'direct';
    }

    writeStorage(window.sessionStorage, ENTRY_SOURCE_KEY, source);
    if (refHost) writeStorage(window.sessionStorage, ENTRY_REFERRER_KEY, refHost);
    var landing = (window.location.pathname || '/') + (window.location.search || '');
    writeStorage(window.sessionStorage, ENTRY_LANDING_KEY, landing.slice(0, 200));
    if (utm) {
      try { writeStorage(window.sessionStorage, ENTRY_UTM_KEY, JSON.stringify(utm)); } catch (e) {}
    }

    return { source: source, referrer: refHost, landing: landing, utm: utm };
  }

  function parseUtmCache() {
    var raw = readStorage(window.sessionStorage, ENTRY_UTM_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function cleanMetadata(metadata) {
    var out = {};
    metadata = metadata || {};
    Object.keys(metadata).slice(0, 16).forEach(function (key) {
      if (/message|content|prompt|reply|transcript|conversation|password|token|secret/i.test(key)) return;
      var value = metadata[key];
      if (value == null || typeof value === 'boolean' || typeof value === 'number') {
        out[key] = value;
      } else if (typeof value === 'string') {
        out[key] = value.slice(0, 160);
      }
    });
    return out;
  }

  function sendEvent(eventName, metadata, token) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;

    var entry = getEntrySource();
    var meta = cleanMetadata(metadata);
    // Inject session-sticky attribution so every event carries the entry
    // source (not just the page_view). Server rolls up on metadata.entry_source.
    meta.entry_source = entry.source;
    if (entry.referrer) meta.entry_referrer_host = entry.referrer.slice(0, 120);
    if (entry.landing) meta.entry_landing = entry.landing;
    if (entry.utm) {
      if (entry.utm.utm_source) meta.utm_source = entry.utm.utm_source;
      if (entry.utm.utm_medium) meta.utm_medium = entry.utm.utm_medium;
      if (entry.utm.utm_campaign) meta.utm_campaign = entry.utm.utm_campaign;
    }

    fetch('/api/track-event', {
      method: 'POST',
      headers: headers,
      keepalive: true,
      body: JSON.stringify({
        event: eventName,
        anonymousId: getOrCreate(window.localStorage, ANON_KEY),
        sessionId: getOrCreate(window.sessionStorage, SESSION_KEY),
        pagePath: window.location.pathname,
        // Per-event referrer host stays as-is (page-to-page). Use entry_source
        // for "where did they come from to the site" — referrer_host is now
        // mostly noise (internal navs).
        referrerHost: entry.source,
        deviceType: deviceType(),
        metadata: meta,
      }),
    }).catch(function () {});
  }

  window.ctjTrack = function (eventName, metadata) {
    try {
      var supabase = window.__supabase;
      if (!supabase || !supabase.auth || !supabase.auth.getSession) {
        sendEvent(eventName, metadata, null);
        return;
      }

      supabase.auth.getSession()
        .then(function (result) {
          var token = result && result.data && result.data.session
            ? result.data.session.access_token
            : null;
          sendEvent(eventName, metadata, token);
        })
        .catch(function () {
          sendEvent(eventName, metadata, null);
        });
    } catch (e) {}
  };

  window.addEventListener('DOMContentLoaded', function () {
    window.ctjTrack('page_view', {
      title: document.title,
      search: window.location.search ? 'present' : 'none',
    });
  });
})();
