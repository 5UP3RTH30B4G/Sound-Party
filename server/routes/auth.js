const express = require('express');
const querystring = require('querystring');
const axios = require('axios');
const sessionManager = require('../utils/sessionManager');
const router = express.Router();

// Configuration des variables d'environnement avec vérifications
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${process.env.PORT || process.env.PORT || 5000}/auth/callback`;
const CLIENT_URL = process.env.CLIENT_URL || process.env.CLIENT_ORIGIN || 'http://127.0.0.1:3000';

// Vérifications des variables critiques
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Variables Spotify manquantes dans les routes auth:');
  if (!CLIENT_ID) console.error('   - SPOTIFY_CLIENT_ID non défini');
  if (!CLIENT_SECRET) console.error('   - SPOTIFY_CLIENT_SECRET non défini');
}

console.log('🔑 Configuration Spotify Auth:');
console.log(`   CLIENT_ID: ${CLIENT_ID ? CLIENT_ID.substring(0, 8) + '...' : 'NON DÉFINI'}`);
console.log(`   REDIRECT_URI: ${REDIRECT_URI}`);
console.log(`   CLIENT_URL: ${CLIENT_URL}`);

// Générer une chaîne aléatoire pour l'état
const generateRandomString = (length) => {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

// Route pour initier la connexion Spotify
router.get('/login', (req, res) => {
  console.log('🔐 Début processus de connexion Spotify');
  
  const state = generateRandomString(16);
  const sessionId = generateRandomString(32); // Identifiant de session unique
  const scope = 'user-read-private user-read-email user-read-playback-state user-modify-playback-state user-read-currently-playing streaming';

  console.log('🎯 Scopes demandés:', scope);
  console.log('🆔 Session ID généré:', sessionId);
  
  // Stocker le state ET le sessionId
  res.cookie('spotify_auth_state', state);
  res.cookie('session_id', sessionId, { 
    httpOnly: true, 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 jours
  });

  const queryParams = querystring.stringify({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: scope,
    redirect_uri: REDIRECT_URI,
    state: state
  });

  const authUrl = `https://accounts.spotify.com/authorize?${queryParams}`;
  console.log('🌐 Redirection vers Spotify:', authUrl);
  res.redirect(authUrl);
});

// Route de callback après autorisation Spotify
router.get('/callback', async (req, res) => {
  console.log('🔄 Callback Spotify reçu');
  
  const code = req.query.code || null;
  const state = req.query.state || null;
  const storedState = req.cookies ? req.cookies['spotify_auth_state'] : null;
  const sessionId = req.cookies ? req.cookies['session_id'] : null;

  console.log('📋 Paramètres callback:', { code: !!code, state, storedState, sessionId });

  if (state === null || state !== storedState) {
    console.error('❌ Erreur state mismatch:', { state, storedState });
    return res.redirect(`${process.env.CLIENT_URL}/?error=state_mismatch`);
  }

  if (!sessionId) {
    console.error('❌ Session ID manquant');
    return res.redirect(`${process.env.CLIENT_URL}/?error=session_missing`);
  }

  res.clearCookie('spotify_auth_state');
  console.log('✅ State validé, échange du code...');

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', 
      querystring.stringify({
        code: code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      }), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')
        }
      }
    );

    const { access_token, refresh_token } = response.data;

    // Récupérer les informations utilisateur
    const userResponse = await axios.get('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': 'Bearer ' + access_token }
    });

    console.log('👤 Utilisateur connecté:', userResponse.data.display_name);

    // Stocker la session utilisateur avec l'ID de session
    sessionManager.createSession(sessionId, {
      access_token,
      refresh_token,
      user: userResponse.data
    });

    console.log('💾 Session stockée pour:', userResponse.data.display_name, 'ID:', sessionId);

    // Rediriger vers le frontend avec succès
    const redirectUrl = `${CLIENT_URL}/?auth=success&user=${encodeURIComponent(userResponse.data.display_name)}`;
    console.log('🔄 Redirection vers:', redirectUrl);
    res.redirect(redirectUrl);

  } catch (error) {
    console.error('❌ Erreur lors de l\'authentification:', error.response?.data || error.message);
    res.redirect(`${CLIENT_URL}/?auth=error&message=${encodeURIComponent('Authentication failed')}`);
  }
});

// Route pour rafraîchir le token
router.post('/refresh', async (req, res) => {
  const sessionId = req.cookies?.session_id;
  
  if (!sessionId) {
    return res.status(401).json({ error: 'No session ID' });
  }

  const session = sessionManager.getSession(sessionId);
  if (!session || !session.refresh_token) {
    return res.status(401).json({ error: 'Invalid session or no refresh token' });
  }

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token: session.refresh_token
      }), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')
        }
      }
    );

    const { access_token } = response.data;
    
    // Mettre à jour la session avec le nouveau token
    sessionManager.updateSession(sessionId, {
      access_token: access_token
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Erreur lors du rafraîchissement:', error.response?.data || error.message);
    res.status(400).json({ error: 'Invalid refresh token' });
  }
});

// Route pour déconnexion
router.post('/logout', (req, res) => {
  const sessionId = req.cookies?.session_id;
  
  if (sessionId) {
    sessionManager.deleteSession(sessionId);
  }
  
  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
  res.clearCookie('session_id');
  res.json({ success: true });
});

// Route pour vérifier le statut de connexion
router.get('/status', async (req, res) => {
  console.log('🔍 Vérification status auth - Headers:', req.headers.cookie);
  const sessionId = req.cookies?.session_id;
  console.log('🔍 Session ID reçu:', sessionId);
  
  if (!sessionId) {
    console.log('❌ Aucun session ID dans les cookies');
    return res.json({ authenticated: false, reason: 'no_session_id' });
  }

  const session = sessionManager.getSession(sessionId);
  console.log('🔍 Session trouvée:', !!session, session ? 'User: ' + session.user?.display_name : 'Aucune');
  
  if (!session || !session.access_token) {
    console.log('❌ Session invalide ou token manquant');
    return res.json({ authenticated: false, reason: 'invalid_session' });
  }

  try {
    console.log('🔍 Test du token Spotify pour:', session.user?.display_name);
    const response = await axios.get('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': 'Bearer ' + session.access_token }
    });

    console.log('✅ Token valide pour:', response.data.display_name);
    res.json({ 
      authenticated: true, 
      user: response.data 
    });
  } catch (error) {
    console.error('❌ Token expiré ou invalide pour la session:', sessionId, error.response?.status, error.response?.data);
    res.json({ authenticated: false, reason: 'spotify_token_invalid', error: error.response?.data });
  }
});

// Route pour obtenir les statistiques des sessions (debug)
router.get('/sessions-stats', (req, res) => {
  const stats = sessionManager.getStats();
  res.json(stats);
});

module.exports = router;