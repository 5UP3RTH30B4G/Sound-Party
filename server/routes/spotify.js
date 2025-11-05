const express = require('express');
const axios = require('axios');
const sessionManager = require('../utils/sessionManager');
const socketHandler = require('../socket/socketHandler');
const router = express.Router();

// Middleware pour vérifier l'authentification
const requireAuth = (req, res, next) => {
  // D'abord essayer avec les cookies (ancienne méthode pour compatibilité)
  let access_token = req.cookies?.access_token;
  let sessionId = req.cookies?.session_id;
  
  // Si pas de token direct mais un sessionId, essayer de récupérer depuis les sessions
  if (!access_token && sessionId) {
    const session = sessionManager.getSession(sessionId);
    if (session && session.access_token) {
      access_token = session.access_token;
    }
  }
  
  if (!access_token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  req.access_token = access_token;
  req.session_id = sessionId;
  next();
};

const rateLimiter = require('../utils/rateLimiter');

// Lightweight in-memory counters to detect excessive calls per endpoint (resets every minute)
const callCounters = new Map();
function incrementCounter(key) {
  const now = Date.now();
  const entry = callCounters.get(key) || { count: 0, windowStart: now };
  // reset window if older than 60s
  if (now - entry.windowStart > 60 * 1000) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  callCounters.set(key, entry);
  return entry.count;
}

// Per-route, per-session counters to identify which sessions cause most traffic
const sessionCounters = new Map();
function incrementSessionCounter(routeKey, sessionId) {
  try {
    let routeMap = sessionCounters.get(routeKey);
    if (!routeMap) {
      routeMap = new Map();
      sessionCounters.set(routeKey, routeMap);
    }
    const now = Date.now();
    const prev = routeMap.get(sessionId) || { count: 0, windowStart: now };
    if (now - prev.windowStart > 60 * 1000) {
      prev.count = 0;
      prev.windowStart = now;
    }
    prev.count += 1;
    routeMap.set(sessionId, prev);
    return prev.count;
  } catch (e) {
    return null;
  }
}

const debuglog = false; // set to true to enable debug logging

// Helper to log Spotify API usage with session/user info when available
function logSpotifyCall(req, routeName) {
  try {
    const ts = new Date().toISOString();
    const sessionId = req.session_id || req.cookies?.session_id || null;
    let userLabel = 'unknown';
    if (sessionId) {
      try {
        const s = sessionManager.getSession(sessionId);
        if (s && s.user) userLabel = s.user.display_name || s.user.id || s.user.spotifyId || userLabel;
      } catch (e) {
        // ignore
      }
    }

    const key = routeName || (req.method + ' ' + req.path) || 'unknown_route';
  const count = incrementCounter(key);
  // track per-session counts for this route as well
  if (sessionId) incrementSessionCounter(key, sessionId);

    if (debuglog) {
      console.log(`[SPOTIFY_CALL] ${ts} route=${key} session=${sessionId || 'none'} user=${userLabel} ip=${req.ip || 'unknown'} count_last_min=${count}`);
    }

    // If an endpoint is called very frequently, emit a clearer warning
    if (count > 70) {
      console.warn(`[SPOTIFY_CALLS_HIGH] ${count} calls to ${key} in the last minute - investigate excessive usage`);
    }
  } catch (e) {
    // fail-safe: do not throw from logging
    console.warn('⚠️ Failed to log Spotify call debug info', e);
  }
}

// Helper to call Spotify and handle 429 global backoff
const callSpotify = async (axiosConfig) => {
  if (rateLimiter.isLimited()) {
    const ms = rateLimiter.getRemainingMs();
    const err = new Error('Rate limited by server');
    err.status = 429;
    err.ms = ms;
    throw err;
  }

  try {
    // Lightweight logging for outgoing Spotify requests
    try {
      const fullUrl = axiosConfig && axiosConfig.url ? axiosConfig.url : 'unknown_url';
      const spotifyPath = String(fullUrl).replace(/^https?:\/\/api\.spotify\.com/, '') || fullUrl;
      const cnt = incrementCounter(`spotify:${spotifyPath}`);
      if (debuglog) {
        console.log(`[SPOTIFY_REQ] ${new Date().toISOString()} ${axiosConfig.method || 'GET'} ${fullUrl} count_last_min=${cnt}`);
      }
      if (cnt > 100) console.warn(`[SPOTIFY_REQ_HIGH] ${cnt} requests to ${spotifyPath} in the last minute`);
    } catch (e) {
      // ignore logging errors
    }

    return await axios(axiosConfig);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429) {
      // Trigger a short global cooldown and notify clients
      const ms = rateLimiter.trigger(10); // 10s default
      try {
        socketHandler.notifyRateLimit(ms);
      } catch (e) {
        console.warn('⚠️ Failed to notify clients about rate limit', e);
      }
      const e2 = new Error('Spotify rate limited');
      e2.status = 429;
      e2.ms = ms;
      throw e2;
    }
    throw err;
  }
};

// Per-session cache for /playback-state to enforce strictly 1s update frequency
const playbackStateCache = new Map(); // sessionId -> { ts, data }
// Per-session in-flight coalescing: sessionId -> { ts, promise }
const playbackInFlight = new Map();

// Obtenir l'état de lecture actuel
router.get('/playback-state', requireAuth, async (req, res) => {
  // Note: we avoid logging/incrementing the global call counter for every incoming
  // /playback-state because clients poll frequently and cache-hits should not
  // be treated as Spotify API usage. We'll log only when we actually initiate
  // an outgoing Spotify request (below) so callCounters reflect real outgoing load.
  try {
    // Enforce strict 1s per-session policy: if a recent cached response exists, return it
    const sid = req.session_id || req.cookies?.session_id || 'anonymous';
    const now = Date.now();
    const cached = playbackStateCache.get(sid);
    if (cached && (now - cached.ts) < 1000) {
      // Return cached data immediately to avoid another outgoing Spotify call
      if (typeof shouldLog === 'function' ? shouldLog(`playback_state_cache_hit_${sid}`) : true);
      res.set('X-Cache', 'HIT');
      return res.json(cached.data);
    }

    // If there is already an in-flight fetch for this session, await it and return its result
    const inFlight = playbackInFlight.get(sid);
    if (inFlight && inFlight.promise) {
      try {
        // Await the existing promise so concurrent requests coalesce
        await inFlight.promise;
        const newCached = playbackStateCache.get(sid);
        if (newCached) {
          if (typeof shouldLog === 'function' ? shouldLog(`playback_state_cache_coalesced_${sid}`) : true) console.log(`ℹ️ playback-state coalesced for session ${sid}`);
          res.set('X-Cache', 'HIT');
          return res.json(newCached.data);
        }
        // If coalesced fetch didn't populate cache (failed), fallthrough to fresh fetch
      } catch (e) {
        // If the in-flight call failed, continue to try a fresh fetch below
        console.warn('ℹ️ In-flight playback-state fetch failed, trying fresh fetch', e?.message || e);
      }
    }
  } catch (e) {
    // logging failure should not block
    console.warn('⚠️ playback-state cache check failed', e);
  }
  // Before initiating an outgoing Spotify request, log the incoming route use
  // (this will increment counters for the actual outgoing fetch below because
  // logSpotifyCall also increments callCounters). We deliberately avoid logging
  // at the top of the route to prevent cache-hit noise.
  logSpotifyCall(req, '/playback-state');

  // Initiate a single outgoing Spotify request for this session and make it visible to other concurrent callers
  const sidForFetch = req.session_id || req.cookies?.session_id || 'anonymous';
  let fetchPromise;
  try {
    fetchPromise = (async () => {
      const response = await callSpotify({
        method: 'get',
        url: 'https://api.spotify.com/v1/me/player',
        headers: { 'Authorization': 'Bearer ' + req.access_token }
      });

      if (response.status === 204) {
        // Cache the empty response for this session
        try {
          playbackStateCache.set(sidForFetch, { ts: Date.now(), data: { active: false } });
        } catch (e) { /* ignore cache write errors */ }
        return { active: false };
      }

      // Cache the response for this session so subsequent requests within 1s return cached
      try {
        playbackStateCache.set(sidForFetch, { ts: Date.now(), data: response.data });
      } catch (e) { /* ignore cache write errors */ }

      return response.data;
    })();

    // register in-flight promise so concurrent callers wait on the same promise
    playbackInFlight.set(sidForFetch, { ts: Date.now(), promise: fetchPromise });

    // Await fetch and return result
    const result = await fetchPromise;
    try { playbackInFlight.delete(sidForFetch); } catch (e) {}
    return res.json(result);
  } catch (error) {
    try { playbackInFlight.delete(sidForFetch); } catch (e) {}
    if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limited', ms: error.ms });
    }
    if (error.response?.status === 204) {
      return res.json({ active: false });
    }
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Erreur lors de la récupération de l\'état de lecture';
    console.error('Erreur playback state:', error.response?.data || error.message);
    return res.status(status).json({ error: message });
  }
});

// Lire/Pause
router.put('/play', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/play');
  try {
    await callSpotify({
      method: 'put',
      url: 'https://api.spotify.com/v1/me/player/play',
      headers: { 'Authorization': 'Bearer ' + req.access_token },
      data: req.body
    });
    res.json({ success: true });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
      const status = error.response?.status || 500;
      const message = error.response?.data?.error?.message || error.message || 'Erreur lors de la lecture';
      console.error('Erreur play:', error.response?.data || error.message);
      return res.status(status).json({ error: message });
  }
});

router.put('/pause', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/pause');
  try {
    await callSpotify({
      method: 'put',
      url: 'https://api.spotify.com/v1/me/player/pause',
      headers: { 'Authorization': 'Bearer ' + req.access_token }
    });
    res.json({ success: true });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
      const status = error.response?.status || 500;
      const message = error.response?.data?.error?.message || error.message || 'Erreur lors de la pause';
      console.error('Erreur pause:', error.response?.data || error.message);
      return res.status(status).json({ error: message });
  }
});

// Chanson suivante/précédente
router.post('/next', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/next');
  try {
    await callSpotify({
      method: 'post',
      url: 'https://api.spotify.com/v1/me/player/next',
      headers: { 'Authorization': 'Bearer ' + req.access_token }
    });
    res.json({ success: true });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Erreur lors du passage à la chanson suivante';
    console.error('Erreur next:', error.response?.data || error.message);
    return res.status(status).json({ error: message });
  }
});

router.post('/previous', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/previous');
  try {
    await callSpotify({
      method: 'post',
      url: 'https://api.spotify.com/v1/me/player/previous',
      headers: { 'Authorization': 'Bearer ' + req.access_token }
    });
    res.json({ success: true });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
      const status = error.response?.status || 500;
      const message = error.response?.data?.error?.message || error.message || 'Erreur lors du passage à la chanson précédente';
      console.error('Erreur previous:', error.response?.data || error.message);
      return res.status(status).json({ error: message });
  }
});

// Rechercher des chansons
router.get('/search', async (req, res) => {
  logSpotifyCall(req, '/search');
  const { q, type = 'track', limit = 20 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Paramètre de recherche manquant' });
  }

  try {
    // Try to resolve an access token from cookies/session like requireAuth would
    let access_token = req.cookies?.access_token;
    let sessionId = req.cookies?.session_id;

    if (!access_token && sessionId) {
      const session = sessionManager.getSession(sessionId);
      if (session && session.access_token) access_token = session.access_token;
    }

    if (!access_token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const response = await callSpotify({
      method: 'get',
      url: 'https://api.spotify.com/v1/search',
      headers: { 'Authorization': 'Bearer ' + access_token },
      params: { q, type, limit }
    });
    res.json(response.data);
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Erreur lors de la recherche';
    console.error('Erreur search:', error.response?.data || error.message);
    return res.status(status).json({ error: message });
  }
});

// Ajouter à la file d'attente
router.post('/queue', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/queue');
  const { uri } = req.body;
  
  if (!uri) {
    return res.status(400).json({ error: 'URI de la chanson manquant' });
  }

  try {
    await callSpotify({
      method: 'post',
      url: 'https://api.spotify.com/v1/me/player/queue',
      headers: { 'Authorization': 'Bearer ' + req.access_token },
      params: { uri }
    });
    res.json({ success: true });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Erreur lors de l\'ajout à la file d\'attente';
    console.error('Erreur queue:', error.response?.data || error.message);
    return res.status(status).json({ error: message });
  }
});

// Jouer le prochain titre depuis la queue locale
router.post('/queue/next', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/queue/next');
  try {
    console.log('🎵 Demande de lecture du prochain titre de la queue locale');
    
    // Récupérer la queue locale depuis le socket handler (already imported at top)
    const playbackState = socketHandler.getPlaybackState();
    
    if (!playbackState || !playbackState.queue || playbackState.queue.length === 0) {
      console.log('❌ Queue locale vide');
      return res.status(400).json({ error: 'Queue vide' });
    }
    
    const nextTrack = playbackState.queue[0];
    console.log('🎵 Prochaine chanson à jouer:', nextTrack.name, 'par', nextTrack.artists?.[0]?.name || 'Artiste inconnu');
    
    // Jouer le track sur Spotify
    await callSpotify({
      method: 'put',
      url: 'https://api.spotify.com/v1/me/player/play',
      headers: { 'Authorization': 'Bearer ' + req.access_token },
      data: { uris: [nextTrack.uri] }
    });
    
    // Supprimer le track de la queue locale
    const removedTrack = socketHandler.removeFirstFromQueue();
    
    console.log('✅ Lecture réussie depuis la queue locale');
    res.json({ 
      success: true, 
      playedTrack: removedTrack,
      remainingQueueLength: playbackState.queue.length
    });
    
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Erreur lors de la lecture depuis la queue';
    console.error('❌ Erreur lors de la lecture depuis la queue:', error.response?.data || error.message);
    return res.status(status).json({ error: message });
  }
});

// Obtenir les appareils disponibles
router.get('/devices', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/devices');
  try {
    const response = await callSpotify({
      method: 'get',
      url: 'https://api.spotify.com/v1/me/player/devices',
      headers: { 'Authorization': 'Bearer ' + req.access_token }
    });
    res.json(response.data);
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
      const status = error.response?.status || 500;
      const message = error.response?.data?.error?.message || error.message || 'Erreur lors de la récupération des appareils';
      console.error('Erreur devices:', error.response?.data || error.message);
      return res.status(status).json({ error: message });
  }
});

// Jouer un track spécifique depuis la queue serveur
router.post('/play-track', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/play-track');
  const { uri, device_id } = req.body;
  
  console.log('🎵 Tentative de lecture du track:', uri);
  
  if (!uri) {
    return res.status(400).json({ error: 'URI de la chanson manquant' });
  }

  try {
    const playData = {
      uris: [uri]
    };
    
    if (device_id) {
      playData.device_id = device_id;
    }

    await callSpotify({
      method: 'put',
      url: 'https://api.spotify.com/v1/me/player/play',
      headers: { 'Authorization': 'Bearer ' + req.access_token },
      data: playData
    });
    
    console.log('✅ Track joué avec succès:', uri);
    res.json({ success: true });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Erreur lors de la lecture du track';
    console.error('❌ Erreur lors de la lecture du track:', error.response?.data || error.message);
    return res.status(status).json({ error: message });
  }
});

// Changer d'appareil
router.put('/device', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/device');
  const { device_ids, play } = req.body;
  
  try {
    await callSpotify({
      method: 'put',
      url: 'https://api.spotify.com/v1/me/player',
      headers: { 'Authorization': 'Bearer ' + req.access_token },
      data: { device_ids, play }
    });
    res.json({ success: true });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Erreur lors du changement d\'appareil';
    console.error('Erreur device transfer:', error.response?.data || error.message);
    return res.status(status).json({ error: message });
  }
});

// Contrôler le volume
router.put('/volume', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/volume');
  const { volume_percent } = req.body;
  
  if (volume_percent === undefined || volume_percent < 0 || volume_percent > 100) {
    return res.status(400).json({ error: 'Volume doit être entre 0 et 100' });
  }
  
  try {
    await callSpotify({
      method: 'put',
      url: `https://api.spotify.com/v1/me/player/volume?volume_percent=${Math.round(volume_percent)}`,
      headers: { 'Authorization': 'Bearer ' + req.access_token }
    });
    console.log('✅ Volume changé à:', volume_percent + '%');
    res.json({ success: true, volume_percent: volume_percent });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Erreur lors du changement de volume';
    console.error('❌ Erreur lors du changement de volume:', error.response?.data || error.message);
    return res.status(status).json({ error: message });
  }
});

// Changer la position de lecture (seek)
router.put('/seek', requireAuth, async (req, res) => {
  logSpotifyCall(req, '/seek');
  const { position_ms } = req.body;
  
  if (position_ms === undefined || position_ms < 0) {
    return res.status(400).json({ error: 'Position doit être un nombre positif' });
  }
  
  try {
    await callSpotify({
      method: 'put',
      url: `https://api.spotify.com/v1/me/player/seek?position_ms=${Math.round(position_ms)}`,
      headers: { 'Authorization': 'Bearer ' + req.access_token }
    });
    console.log('✅ Position changée à:', Math.round(position_ms) + 'ms');
    
    // If the incoming request includes the X-SKIP-PARTY-SEEK header it means
    // the client was executing a server-requested local seek. In that case we
    // must NOT call seekPartyPlayback again (it would re-broadcast and cause a
    // seek -> broadcast -> seek loop). Honor the header to avoid excessive
    // Spotify API usage.
    const skipPartySeekHeader = (req.get('x-skip-party-seek') || req.query.skip_party_seek || '').toString();
    const skipPartySeek = skipPartySeekHeader === '1' || skipPartySeekHeader.toLowerCase() === 'true';

    if (skipPartySeek) {
      if (typeof shouldLog === 'function' ? shouldLog('skip_party_seek_header') : true) console.log('ℹ️ /seek called with X-SKIP-PARTY-SEEK - skipping server-side seekPartyPlayback');
    } else {
      // If in Party mode, update server-side Party state to prevent position oscillation
      if (socketHandler.partyPlaybackState && socketHandler.partyPlaybackState.currentTrack) {
        console.log('🎉 Party mode detected — updating server Party position to', position_ms);
        socketHandler.seekPartyPlayback(position_ms);
      }
    }
    
    res.json({ success: true, position_ms: position_ms });
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Erreur lors du changement de position';
    console.error('❌ Erreur lors du changement de position:', error.response?.data || error.message);
    return res.status(status).json({ error: message });
  }
});

module.exports = router;

// --- Debug endpoint for counters (restricted to localhost) ---
// Note: placed after module.exports to avoid affecting normal exports ordering
router.get('/internal/spotify-counters', (req, res) => {
  const remote = req.ip || req.connection?.remoteAddress || '';
  // Allow only localhost or 127.0.0.1
  if (!remote || !(remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const reset = req.query.reset === '1' || req.query.reset === 'true';

    const counters = {};
    for (const [k, v] of callCounters.entries()) {
      counters[k] = { count: v.count, windowStart: v.windowStart };
    }

    const sessionStats = {};
    for (const [route, map] of sessionCounters.entries()) {
      sessionStats[route] = {};
      for (const [sid, obj] of map.entries()) {
        sessionStats[route][sid] = { count: obj.count, windowStart: obj.windowStart };
      }
    }

    if (reset) {
      callCounters.clear();
      sessionCounters.clear();
    }

    return res.json({ counters, sessionStats });
  } catch (err) {
    console.error('⚠️ Error serving internal/spotify-counters:', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// Obtenir les métadonnées d'un track (utilisable même si le client n'est pas authentifié)
router.get('/track/:id', async (req, res) => {
  logSpotifyCall(req, '/track/:id');
  const trackId = req.params.id;
  if (!trackId) return res.status(400).json({ error: 'track id missing' });

  try {
    // Resolve access token similarly to /search
    let access_token = req.cookies?.access_token;
    let sessionId = req.cookies?.session_id;

    if (!access_token && sessionId) {
      const session = sessionManager.getSession(sessionId);
      if (session && session.access_token) access_token = session.access_token;
    }

    // If no access token is available, require authentication
    if (!access_token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const response = await callSpotify({
      method: 'get',
      url: `https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`,
      headers: { Authorization: 'Bearer ' + access_token }
    });

    return res.json(response.data);
  } catch (error) {
    if (error.status === 429) return res.status(429).json({ error: 'Rate limited', ms: error.ms });
    const status = error.response?.status || 500;
    const message = error.response?.data?.error?.message || error.message || 'Erreur lors de la récupération du track';
    console.error('Erreur track lookup:', error.response?.data || error.message);
    return res.status(status).json({ error: message });
  }
});