(function () {
  var ANON_KEY = 'cometojesus_analytics_id';
  var SESSION_KEY = 'cometojesus_analytics_session_id';

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

  function referrerHost() {
    if (!document.referrer) return null;
    try {
      var url = new URL(document.referrer);
      return url.host === window.location.host ? 'internal' : url.host;
    } catch (e) {
      return null;
    }
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

    fetch('/api/track-event', {
      method: 'POST',
      headers: headers,
      keepalive: true,
      body: JSON.stringify({
        event: eventName,
        anonymousId: getOrCreate(window.localStorage, ANON_KEY),
        sessionId: getOrCreate(window.sessionStorage, SESSION_KEY),
        pagePath: window.location.pathname,
        referrerHost: referrerHost(),
        deviceType: deviceType(),
        metadata: cleanMetadata(metadata),
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
