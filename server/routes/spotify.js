const express = require('express');
const axios = require('axios');
const sessionManager = require('../utils/sessionManager');
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
const socketHandler = require('../socket/socketHandler');

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

// Obtenir l'état de lecture actuel
router.get('/playback-state', requireAuth, async (req, res) => {
  try {
    const response = await callSpotify({
      method: 'get',
      url: 'https://api.spotify.com/v1/me/player',
      headers: { 'Authorization': 'Bearer ' + req.access_token }
    });

    if (response.status === 204) {
      return res.json({ active: false });
    }

    return res.json(response.data);
  } catch (error) {
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
// This endpoint accepts authenticated requests as before, but if the requester
// is not authenticated we allow the server to perform the search using the
// current party fetcher session (if one exists). That enables solo clients to
// use the fetcher for searches when the UI allowed it.
router.get('/search', async (req, res) => {
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

    // If still no access token, try to use the active party fetcher's session
    if (!access_token) {
      try {
        const playbackState = socketHandler.getPlaybackState();
        if (playbackState && playbackState.fetcher && playbackState.fetcher.sessionId) {
          const fsess = sessionManager.getSession(playbackState.fetcher.sessionId);
          if (fsess && fsess.access_token) {
            access_token = fsess.access_token;
            sessionId = playbackState.fetcher.sessionId;
            if (typeof shouldLog === 'function' ? shouldLog('search_using_fetcher') : true) console.log('ℹ️ Using fetcher session for unauthenticated search');
          }
        }
      } catch (err) {
        // ignore — fallback to auth failure below
      }
    }

    if (!access_token) {
      return res.status(401).json({ error: 'Not authenticated and no fetcher available' });
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
  try {
    console.log('🎵 Demande de lecture du prochain titre de la queue locale');
    
    // Récupérer la queue locale depuis le socket handler
    const socketHandler = require('../socket/socketHandler');
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