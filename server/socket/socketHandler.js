// Stockage en mémoire des utilisateurs connectés et de l'état de lecture
let connectedUsers = new Map();

// Party playback state (shared by all synchronized users)
// This state is server-authoritative: position is calculated from playbackStartTime
let partyPlaybackState = {
  isPlaying: false,
  currentTrack: null,
  position: 0,
  queue: [],
  fetcher: null,
  ownerSpotifyId: null,
  playbackStartTime: null, // timestamp when playback started (for position calculation)
  pausedAt: null // position where playback was paused (null when playing)
};

// Legacy currentPlaybackState kept for backward compatibility (will be replaced gradually)
let currentPlaybackState = {
  isPlaying: false,
  currentTrack: null,
  position: 0,
  queue: [],
  fetcher: null,
  ownerSpotifyId: null
};

// Auto-skip cooldowns to prevent duplicate rapid plays (in ms)
const AUTO_SKIP_COOLDOWN_MS = 1500; // 1.5s
const lastAutoPlayTimestamps = {
  party: 0,
  solo: 0
};

// Instance IO pour les méthodes utilitaires
let ioInstance = null;

// Require session manager and axios once for periodic token checks
const sessionManager = require('../utils/sessionManager');
const axios = require('axios');

// Log throttling pour éviter le spam
const logThrottleMap = new Map();
// Provide a local shouldLog helper. If a future deploy overwrote this file without it,
// other checks use typeof to avoid throwing — but define a fallback here for safety.
function shouldLog(key, intervalMs = 5000) {
  try {
    const now = Date.now();
    const lastLog = logThrottleMap.get(key);
    if (!lastLog || (now - lastLog) >= intervalMs) {
      logThrottleMap.set(key, now);
      return true;
    }
    return false;
  } catch (e) {
    // In unexpected environments, allow logging (fail-open)
    return true;
  }
}

// Helper functions for Party playback state management (declared at module level for export)

// Helper: start playback for party (sets timing for position calculation)
const startPartyPlayback = (track, startPosition = 0) => {
  partyPlaybackState.currentTrack = track;
  partyPlaybackState.isPlaying = true;
  partyPlaybackState.position = startPosition;
  partyPlaybackState.playbackStartTime = Date.now();
  partyPlaybackState.pausedAt = startPosition; // Use startPosition as base, not null
  console.log('🎵 Party playback started:', track?.name || 'unknown', 'at position:', startPosition, 'ms');
};

// Helper: pause party playback (saves current position)
const pausePartyPlayback = () => {
  if (partyPlaybackState.isPlaying && partyPlaybackState.playbackStartTime) {
    const elapsed = Date.now() - partyPlaybackState.playbackStartTime;
    // pausedAt is already set as the base position (from start or resume)
    const basePosition = partyPlaybackState.pausedAt || 0;
    const newPosition = basePosition + elapsed;
    partyPlaybackState.pausedAt = newPosition;
    partyPlaybackState.position = newPosition;
    console.log('⏸️ Party paused at position:', newPosition, 'ms (base:', basePosition, '+ elapsed:', elapsed, ')');
  }
  partyPlaybackState.isPlaying = false;
  partyPlaybackState.playbackStartTime = null;
};

// Helper: resume party playback from paused position
const resumePartyPlayback = () => {
  if (!partyPlaybackState.isPlaying) {
    partyPlaybackState.isPlaying = true;
    partyPlaybackState.playbackStartTime = Date.now();
    console.log('▶️ Party resumed from position:', partyPlaybackState.pausedAt, 'ms');
    // pausedAt remains set, will be used as base position for future calculations
  }
};

// Helper: seek party playback to specific position
const seekPartyPlayback = (position_ms) => {
  partyPlaybackState.position = position_ms;
  partyPlaybackState.pausedAt = position_ms;
  if (partyPlaybackState.isPlaying) {
    partyPlaybackState.playbackStartTime = Date.now();
  }
  console.log('⏩ Party seeked to position:', position_ms, 'ms');
};

// Main socket handler entrypoint
const socketHandler = (io) => {
  ioInstance = io;

  // NEW: Broadcast party playback state to all synchronized users
  // Calculate real-time position based on playback start time
  const broadcastPartyState = () => {
    try {
      const stateToBroadcast = { ...partyPlaybackState };
      
      // Calculate current position if playing
      if (stateToBroadcast.isPlaying && stateToBroadcast.playbackStartTime) {
        const elapsed = Date.now() - stateToBroadcast.playbackStartTime;
        const basePosition = stateToBroadcast.pausedAt || 0;
        stateToBroadcast.position = basePosition + elapsed;
        
        // Clamp to track duration if we have it
        if (stateToBroadcast.currentTrack && stateToBroadcast.currentTrack.duration_ms) {
          stateToBroadcast.position = Math.min(stateToBroadcast.position, stateToBroadcast.currentTrack.duration_ms);
        }
      } else if (!stateToBroadcast.isPlaying && stateToBroadcast.pausedAt !== null && stateToBroadcast.pausedAt !== undefined) {
        // When paused, use the exact paused position
        stateToBroadcast.position = stateToBroadcast.pausedAt;
      }
      
      io.emit('party_state_updated', stateToBroadcast);
    } catch (err) {
      console.warn('⚠️ Erreur lors du broadcast party state:', err);
    }
  };

  // Helper: broadcast masked playback to everyone and full playback only to the exact fetcher socketId
  const broadcastPlaybackState = () => {
    try {
      const masked = { ...currentPlaybackState, currentTrack: null, isPlaying: false, position: 0 };
      // masked to everyone
      io.emit('playback_state_updated', masked);

      // full only to the exact fetcher socket id (if present)
      if (currentPlaybackState.fetcher && currentPlaybackState.fetcher.socketId) {
        const owner = currentPlaybackState.ownerSpotifyId;
        const fetcherId = currentPlaybackState.fetcher.spotifyId;
        const fullForFetcher = { ...currentPlaybackState };
        if (owner && owner !== fetcherId) {
          // mask sensitive playback fields even for fetcher when they don't own it
          fullForFetcher.currentTrack = null;
          fullForFetcher.isPlaying = false;
          fullForFetcher.position = 0;
        }
        io.to(currentPlaybackState.fetcher.socketId).emit('playback_state_updated', fullForFetcher);
      }
    } catch (err) {
      console.warn('⚠️ Erreur lors du broadcast de l\'état de lecture:', err);
    }
  };

  // Helper: send a full_sync to each connected socket, masking playback for non-fetchers individually
  const broadcastFullSyncToAll = () => {
    try {
      const usersList = Array.from(connectedUsers.values());
      for (const [sockId, user] of connectedUsers.entries()) {
        // Send party state to all users
        const syncData = {
          playbackState: user.isSyncedWithParty ? partyPlaybackState : { ...currentPlaybackState, currentTrack: null, isPlaying: false, position: 0 },
          partyState: partyPlaybackState,
          connectedUsers: usersList,
          isSyncedWithParty: !!user.isSyncedWithParty
        };
        
        io.to(sockId).emit('full_sync', syncData);
      }
    } catch (err) {
      console.warn('⚠️ Erreur lors du broadcast full_sync:', err);
    }
  };

  // Helper: get the appropriate playback state based on user's sync status
  const getPlaybackStateForUser = (user) => {
    return user && user.isSyncedWithParty ? partyPlaybackState : currentPlaybackState;
  };

  // Helper: update playback state based on user's sync status
  const updatePlaybackStateForUser = (user, updates) => {
    const targetState = getPlaybackStateForUser(user);
    Object.assign(targetState, updates);
    
    // Broadcast the appropriate state
    if (user && user.isSyncedWithParty) {
      broadcastPartyState();
    } else {
      broadcastPlaybackState();
    }
  };
  
  io.on('connection', (socket) => {
    console.log(`👤 Utilisateur connecté: ${socket.id}`);

    // Événement de connexion d'un utilisateur authentifié
    socket.on('user_connected', (userData) => {
      // Vérifier si ce socket a déjà un utilisateur enregistré
      const existingUser = connectedUsers.get(socket.id);
      if (existingUser && existingUser.spotifyId === userData.spotifyId) {
        // Limiter les logs de double connexion (1 log par 10 secondes par utilisateur)
        const logKey = `double_connection_${userData.spotifyId}_${socket.id}`;
        if (typeof shouldLog === 'function' ? shouldLog(logKey, 10000) : true)
        return; // Ignorer les connexions multiples du même utilisateur sur le même socket
      }
      
      // Vérifier s'il y a déjà un utilisateur connecté avec le même Spotify ID sur d'autres sockets
      const existingUserSockets = [];
      for (const [socketId, user] of connectedUsers.entries()) {
        if (user.spotifyId === userData.spotifyId && socketId !== socket.id) {
          existingUserSockets.push(socketId);
        }
      }
      
      // D'abord enregistrer le nouvel utilisateur
      // Attach a connectedAt timestamp so clients can display "connected since" safely
      try {
        userData.connectedAt = new Date();
        userData.isSyncedWithParty = false; // By default, user is in solo mode
      } catch (e) {
        // ignore if userData is not an object
      }
      connectedUsers.set(socket.id, userData);
      console.log(`✅ ${userData.name} connecté depuis ${socket.id}`);
      
      // Puis supprimer les anciens sockets pour le même utilisateur
      existingUserSockets.forEach(oldSocketId => {
        connectedUsers.delete(oldSocketId);
        console.log(`🔄 Suppression de l'ancienne connexion ${oldSocketId} pour ${userData.name}`);
      });

      // Émettre la liste mise à jour des utilisateurs connectés
      const usersList = Array.from(connectedUsers.values());
      io.emit('user_list_updated', usersList);

      // Événement d'information de connexion pour les autres utilisateurs
      socket.broadcast.emit('user_joined', {
        user: userData.name,
        timestamp: new Date()
      });

      // If no fetcher is set yet and this user is premium, make them the fetcher immediately
      if (!currentPlaybackState.fetcher && userData.premium) {
        currentPlaybackState.fetcher = {
          spotifyId: userData.spotifyId,
          name: userData.name,
          socketId: socket.id,
          sessionId: userData.sessionId || null
        };

        // Try to resolve sessionId from sessionManager if not provided
        if (!currentPlaybackState.fetcher.sessionId) {
          try {
            const sessionManager = require('../utils/sessionManager');
            const sessions = sessionManager.getActiveSessions();
            const match = sessions.find(s => s.user && (s.user.id === userData.id || s.user.id === userData.spotifyId || s.user.display_name === userData.name));
            if (match) {
              currentPlaybackState.fetcher.sessionId = match.sessionId;
              if (typeof shouldLog === 'function' ? shouldLog('fetcher_auto_session') : true) console.log(`🔎 Auto-resolved fetcher session ${match.sessionId} for ${userData.name}`);
            }
          } catch (err) {
            console.warn('⚠️ Impossible de résoudre session pour fetcher auto:', err);
          }
        }

        console.log(`🔧 Auto-assign fetcher to ${userData.name} on connect`);
        io.emit('fetcher_changed', currentPlaybackState.fetcher);
      }

      // Envoyer l'état actuel au nouvel utilisateur, mais ne pas exposer la lecture en cours
      // si l'utilisateur connecté n'est pas le fetcher (il ne doit pas voir la musique des autres)
      let playbackForNewUser = { ...currentPlaybackState };
      const newUserIsFetcher = currentPlaybackState.fetcher && (currentPlaybackState.fetcher.spotifyId === userData.spotifyId || currentPlaybackState.fetcher.socketId === socket.id || currentPlaybackState.fetcher.name === userData.name);
      if (!newUserIsFetcher) {
        // hide current playback details for non-fetchers
        playbackForNewUser = { ...playbackForNewUser, currentTrack: null, isPlaying: false, position: 0 };
      }

      socket.emit('full_sync', {
        playbackState: playbackForNewUser,
        connectedUsers: usersList
      });
    });

    // Événement de déconnexion
    socket.on('disconnect', () => {
      const user = connectedUsers.get(socket.id);
      if (user) {
        console.log(`👋 ${user.name} s'est déconnecté`);
        connectedUsers.delete(socket.id);

        // Émettre la liste mise à jour
        const usersList = Array.from(connectedUsers.values());
        io.emit('user_list_updated', usersList);

        // Événement d'information de déconnexion
        socket.broadcast.emit('user_left', {
          user: user.name,
          timestamp: new Date()
        });

        // If the disconnected user was the fetcher, try to promote another premium
        const fetcher = currentPlaybackState.fetcher;
        const disconnectedWasFetcher = fetcher && (fetcher.socketId === socket.id || fetcher.spotifyId === user.spotifyId || fetcher.name === user.name);
        if (disconnectedWasFetcher) {
          console.log(`⚠️ Le fetcher ${user.name} s'est déconnecté, tentative de promotion d'un autre premium`);
          // Find a candidate premium to promote
          const sessions = Array.from(connectedUsers.entries()); // [socketId, user]
          const candidateEntry = sessions.find(([sId, u]) => u.premium);
          if (candidateEntry) {
            const [candSocketId, candUser] = candidateEntry;
            // Assign new fetcher
            currentPlaybackState.fetcher = {
              spotifyId: candUser.spotifyId,
              name: candUser.name,
              socketId: candSocketId,
              sessionId: candUser.sessionId || null
            };
            // Try to resolve sessionId if missing
            if (!currentPlaybackState.fetcher.sessionId) {
              try {
                const sessionManager = require('../utils/sessionManager');
                const act = sessionManager.getActiveSessions();
                const match = act.find(s => s.user && (s.user.id === candUser.id || s.user.id === candUser.spotifyId || s.user.display_name === candUser.name));
                if (match) currentPlaybackState.fetcher.sessionId = match.sessionId;
              } catch (err) {
                console.warn('⚠️ Erreur résolution session pour fetcher promu:', err);
              }
            }
            console.log(`🔧 Nouveau fetcher promu: ${candUser.name}`);
            io.emit('fetcher_changed', currentPlaybackState.fetcher);
          } else {
            // No premium candidate: clear fetcher
            currentPlaybackState.fetcher = null;
            console.log('ℹ️ Aucun premium disponible pour être fetcher, fetcher cleared');
            io.emit('fetcher_changed', null);
          }

          // Broadcast playback state changes using helper (full only to exact fetcher socket)
          broadcastPlaybackState();
          // Also send a full sync to all clients so they refresh their connected user state
          broadcastFullSyncToAll();
        }
      }
    });

    // Événement pour basculer entre mode solo et mode synchronisé party
    socket.on('toggle_party_sync', (data) => {
      const user = connectedUsers.get(socket.id);
      if (!user) return;

      const { isSynced } = data;
      user.isSyncedWithParty = isSynced;
      connectedUsers.set(socket.id, user);

      console.log(`🔄 ${user.name} a basculé en mode ${isSynced ? 'Party' : 'Solo'}`);

      // Émettre la liste mise à jour des utilisateurs
      const usersList = Array.from(connectedUsers.values());
      io.emit('user_list_updated', usersList);

      // Si l'utilisateur vient de se synchroniser, envoyer l'état party actuel
      if (isSynced) {
        socket.emit('party_state_updated', partyPlaybackState);
      } else {
        // Si l'utilisateur se désynchronise, lui envoyer son propre état de lecture
        broadcastPlaybackState();
      }
    });

    // Événement pour jouer automatiquement la prochaine chanson de la queue
    socket.on('play_next_from_queue', async () => {
      // Allow play_next_from_queue even if the user hasn't yet been registered
      // (clients may emit this right after socket connect before server-side
      // user registration completes). Use a sensible fallback queue selection
      // and log clearly to aid debugging.
      let user = connectedUsers.get(socket.id);
      if (!user) {
        if (typeof shouldLog === 'function' ? shouldLog(`play_next_unknown_socket_${socket.id}`, 5000) : true) console.warn(`⚠️ play_next_from_queue received from unknown socket ${socket.id} - using fallback queue selection`);
        // pick party queue if non-empty, otherwise solo queue
        const fallbackIsParty = (partyPlaybackState && partyPlaybackState.queue && partyPlaybackState.queue.length > 0);
        user = { name: `socket:${socket.id}`, isSyncedWithParty: fallbackIsParty, sessionId: null, spotifyId: null, premium: false };
      }

      // Choose the correct queue based on whether the requester is synced with the party
      const isPartyRequest = !!user.isSyncedWithParty;
      const targetQueue = isPartyRequest ? partyPlaybackState.queue : currentPlaybackState.queue;
      const targetState = isPartyRequest ? partyPlaybackState : currentPlaybackState;

        // Deduplicate rapid auto-play requests per-queue to avoid duplicate next/play calls
        try {
          const key = isPartyRequest ? 'party' : 'solo';
          const now = Date.now();
          if (now - (lastAutoPlayTimestamps[key] || 0) < AUTO_SKIP_COOLDOWN_MS) {
            if (typeof shouldLog === 'function' ? shouldLog('play_next_debounced') : true) console.log(`ℹ️ Ignoring play_next_from_queue (debounced) for ${key} queue`);
            return;
          }
          // reserve the timeslot immediately to avoid races
          lastAutoPlayTimestamps[key] = now;
        } catch (e) {
          // ignore errors
        }

      if (!targetQueue || targetQueue.length === 0) {
        if (typeof shouldLog === 'function' ? shouldLog('play_next_empty_queue') : true) console.log(`ℹ️ play_next_from_queue: no tracks in ${isPartyRequest ? 'party' : 'solo'} queue`);
        return;
      }
      const nextTrack = targetQueue[0];
      console.log(`🎵 Demande play_next_from_queue par ${user.name} pour: ${nextTrack.name} (isParty: ${isPartyRequest})`);

      // Try to resolve a session to perform the play server-side (prefer fetcher, then requester)
      let sessionIdToUse = null;
      if (targetState.fetcher && targetState.fetcher.sessionId) sessionIdToUse = targetState.fetcher.sessionId;
      if (!sessionIdToUse && user.sessionId) sessionIdToUse = user.sessionId;
      if (!sessionIdToUse) {
        try {
          const sessionManager = require('../utils/sessionManager');
          const sessions = sessionManager.getActiveSessions();
          // prefer fetcher match
          if (targetState.fetcher && targetState.fetcher.spotifyId) {
            const match = sessions.find(s => s.user && (s.user.id === targetState.fetcher.spotifyId || s.user.spotifyId === targetState.fetcher.spotifyId));
            if (match) sessionIdToUse = match.sessionId;
          }
          if (!sessionIdToUse) {
            const match2 = sessions.find(s => s.user && (s.user.id === user.id || s.user.spotifyId === user.spotifyId));
            if (match2) sessionIdToUse = match2.sessionId;
          }
        } catch (err) {
          console.warn('⚠️ Impossible de résoudre session pour play_next_from_queue:', err);
        }
      }

      if (sessionIdToUse) {
        try {
          const API_BASE = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
          const resp = await fetch(`${API_BASE.replace(/\/$/, '')}/api/spotify/play-track`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': `session_id=${sessionIdToUse}` },
            body: JSON.stringify({ uri: nextTrack.uri })
          });

          if (resp && resp.ok) {
            console.log(`✅ play_next_from_queue: Played ${nextTrack.name} using session ${sessionIdToUse}`);
            // Remove track from queue and broadcast
            const removed = targetQueue.shift();
            io.emit('queue_updated', { queue: targetQueue, autoRemoved: true, removedTrack: removed, isParty: isPartyRequest });

            // Update playback state
            targetState.ownerSpotifyId = user.spotifyId || (targetState.fetcher && targetState.fetcher.spotifyId) || null;
            
            if (isPartyRequest) {
              // Use helper for proper timing
              startPartyPlayback(nextTrack, 0);
              broadcastPartyState();
            } else {
              targetState.currentTrack = nextTrack;
              targetState.isPlaying = true;
              targetState.position = 0;
              broadcastPlaybackState();
            }
            return;
          } else {
            const txt = resp ? (await resp.text()) : 'no response';
            console.warn('⚠️ play_next_from_queue server play failed:', txt);
          }
        } catch (err) {
          console.warn('⚠️ Erreur lors du play_next_from_queue server play attempt:', err?.message || err);
        }
      }

      // Fallback: inform clients to attempt playback (existing behavior)
      io.emit('play_track_from_queue', { track: nextTrack, requestedBy: user.name });
    });

    // Permet à un utilisateur premium de se déclarer comme "fetcher"
    socket.on('set_fetcher', () => {
      const user = connectedUsers.get(socket.id);
      if (!user) return;
      if (!user.premium) {
        socket.emit('fetcher_denied', { reason: 'Premium required to be fetcher' });
        return;
      }

      // Store minimal fetcher info on the server state (sessionId will be looked up when used)
      currentPlaybackState.fetcher = {
        spotifyId: user.spotifyId,
        name: user.name,
        socketId: socket.id,
        sessionId: user.sessionId || null
      };

      // If the client didn't provide a sessionId, try to resolve it from the session manager
      if (!currentPlaybackState.fetcher.sessionId) {
        try {
          const sessionManager = require('../utils/sessionManager');
          const sessions = sessionManager.getActiveSessions();
          const match = sessions.find(s => s.user && (s.user.id === user.id || s.user.id === user.spotifyId || s.user.display_name === user.name));
          if (match) {
            currentPlaybackState.fetcher.sessionId = match.sessionId;
            if (typeof shouldLog === 'function' ? shouldLog('fetcher_session_resolved') : true) console.log(`� Résolution session fetcher: ${match.sessionId} pour ${user.name}`);
          }
        } catch (err) {
          console.warn('⚠️ Impossible de résoudre session fetcher:', err);
        }
      }

      console.log(`�🔧 ${user.name} est maintenant le fetcher actif`);
      io.emit('fetcher_changed', currentPlaybackState.fetcher);
      // Force all clients to re-sync so UI updates for fetcher transfer
      broadcastFullSyncToAll();
    });

    // Événement de contrôle de lecture (play/pause/next/previous) - relay possible via fetcher
    socket.on('playback_control', async (action) => {
      const user = connectedUsers.get(socket.id);
      if (!user) return;

      console.log(`🎮 Action ${action.type} par ${user.name} (mode: ${user.isSyncedWithParty ? 'Party' : 'Solo'})`);

      // Get the appropriate playback state based on user's sync mode
      const targetState = getPlaybackStateForUser(user);
      const isPartyMode = user.isSyncedWithParty;

      // Determine permission
      // In Party mode: all synced users can control
      // In Solo mode: only premium or fetcher can control
      const isFetcher = targetState.fetcher && targetState.fetcher.spotifyId === user.spotifyId;
      const isPremium = !!user.premium;
      const canControlDirectly = isPartyMode || isPremium || isFetcher;

      // If the user cannot control directly but there is a fetcher, we will forward the control to the fetcher socket
      const relayToFetcher = !canControlDirectly && targetState.fetcher;

      if (!canControlDirectly && !relayToFetcher) {
        socket.emit('control_denied', { reason: isPartyMode ? 'Action non autorisée' : 'Premium required or active fetcher needed' });
        return;
      }

      // If the playback is currently owned by another spotify user, prefer forwarding the control to them
      // Only in Solo mode - in Party mode everyone can control
      const ownerSpotifyId = targetState.ownerSpotifyId;
      if (!isPartyMode && ownerSpotifyId && ownerSpotifyId !== user.spotifyId) {
        try {
          // Try to find the owner's connected socket
          const ownerEntry = Array.from(connectedUsers.entries()).find(([, u]) => u.spotifyId === ownerSpotifyId);
          if (ownerEntry) {
            const [ownerSocketId, ownerUser] = ownerEntry;
            // Forward to owner socket for them to perform the control locally
            io.to(ownerSocketId).emit('perform_playback_control', {
              action,
              requestedBy: user.name,
              requestedSocketId: socket.id,
              forwardedBy: 'server'
            });
            socket.emit('control_forwarded', { to: ownerUser.name });
            return;
          }

          // Owner is not currently connected. If requester cannot control directly, deny.
          if (!canControlDirectly) {
            socket.emit('control_denied', { reason: `Playback currently owned by another user (${ownerSpotifyId}). Only the owner or a premium/fetcher can control.` });
            return;
          }
          // If requester can control directly (premium or fetcher), allow the flow to continue and attempt the API call.
        } catch (err) {
          console.error('❌ Erreur lors de la tentative de forward au propriétaire:', err);
          socket.emit('control_error', { reason: 'Forward to owner failed' });
          return;
        }
      }

      // Special-case early attempt: if 'next' and we have a server queue, try server-side play
      if (action.type === 'next' && targetState.queue && targetState.queue.length > 0) {
        // debounce rapid 'next' requests for this queue
        try {
          const key = isPartyMode ? 'party' : 'solo';
          const now4 = Date.now();
          if (now4 - (lastAutoPlayTimestamps[key] || 0) < AUTO_SKIP_COOLDOWN_MS) {
            if (typeof shouldLog === 'function' ? shouldLog('next_debounced') : true) console.log(`ℹ️ Ignoring playback 'next' (debounced) for ${key} queue`);
            return;
          }
          lastAutoPlayTimestamps[key] = now4;
        } catch (e) {}
        // prefer fetcher session if available
        let trySession = targetState.fetcher && targetState.fetcher.sessionId ? targetState.fetcher.sessionId : null;
        if (!trySession && user && user.sessionId) trySession = user.sessionId;
        if (!trySession) {
          try {
            const sessionManager = require('../utils/sessionManager');
            const sessions = sessionManager.getActiveSessions();
            if (targetState.fetcher && targetState.fetcher.spotifyId) {
              const m = sessions.find(s => s.user && (s.user.id === targetState.fetcher.spotifyId || s.user.spotifyId === targetState.fetcher.spotifyId));
              if (m) trySession = m.sessionId;
            }
            if (!trySession) {
              const m2 = sessions.find(s => s.user && (s.user.id === user.id || s.user.spotifyId === user.spotifyId));
              if (m2) trySession = m2.sessionId;
            }
          } catch (err) {
            // ignore
          }
        }

        if (trySession) {
          const nextTrack = targetState.queue[0];
          try {
            const API_BASE = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
            const playRes = await fetch(`${API_BASE.replace(/\/$/, '')}/api/spotify/play-track`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Cookie': `session_id=${trySession}` },
              body: JSON.stringify({ uri: nextTrack.uri })
            });

            if (playRes && playRes.ok) {
              const removed = targetState.queue.shift();
              io.emit('queue_updated', { queue: targetState.queue, autoRemoved: true, removedTrack: removed, isParty: isPartyMode });
              
              // Use helper to properly initialize playback timing in Party mode
              if (isPartyMode) {
                startPartyPlayback(nextTrack, 0);
              } else {
                targetState.currentTrack = nextTrack;
                targetState.isPlaying = true;
                targetState.position = 0;
              }
              
              targetState.ownerSpotifyId = user.spotifyId;
              if (canControlDirectly) {
                targetState.fetcher = { spotifyId: user.spotifyId, name: user.name, socketId: socket.id, sessionId: user.sessionId };
              }
              // Broadcast appropriate state
              if (isPartyMode) {
                broadcastPartyState();
              } else {
                broadcastPlaybackState();
              }
              socket.broadcast.emit('playback_control_received', { user: user.name, action: 'next', timestamp: new Date() });
              return;
            }
          } catch (err) {
            // fallthrough to existing handling
            if (typeof shouldLog === 'function' ? shouldLog('next_server_play_failed') : true) console.warn('⚠️ next server-side play attempt failed, will fallback to normal flow', err?.message || err);
          }
        }
      }

      // If we are relaying to the fetcher (and no owner conflict), forward the action to the fetcher socket and let them perform the API call
      if (relayToFetcher) {
        try {
          const fetcherSocketId = targetState.fetcher.socketId;
          if (fetcherSocketId && io) {
            io.to(fetcherSocketId).emit('perform_playback_control', {
              action,
              requestedBy: user.name,
              requestedSocketId: socket.id
            });
            // Inform the requester that the action was forwarded
            socket.emit('control_forwarded', { to: targetState.fetcher.name });
          } else {
            socket.emit('control_error', { reason: 'No fetcher socket available' });
          }
        } catch (err) {
          console.error('❌ Erreur en forward control vers fetcher:', err);
          socket.emit('control_error', { reason: 'Forward failed' });
        }
        return;
      }

      // Decide which sessionId to use for the relay call (server routes expect session_id cookie)
      let sessionToUse = null;
      if (canControlDirectly) {
        sessionToUse = user.sessionId;
        // If the socket's user object doesn't have a sessionId, try to find it from sessionManager
        if (!sessionToUse) {
          try {
            const sessionManager = require('../utils/sessionManager');
            const sessions = sessionManager.getActiveSessions();
            const match = sessions.find(s => s.user && (s.user.id === user.id || s.user.id === user.spotifyId || s.user.display_name === user.name));
            if (match) sessionToUse = match.sessionId;
          } catch (err) {
            console.warn('⚠️ Erreur lors de la recherche de session pour utilisateur:', err);
          }
        }
      } else if (relayToFetcher) {
        // try to use fetcher.sessionId if present; otherwise lookup via sessionManager by spotifyId
        sessionToUse = targetState.fetcher.sessionId;
        if (!sessionToUse) {
          const sessionManager = require('../utils/sessionManager');
          const sessions = sessionManager.getActiveSessions();
          const match = sessions.find(s => s.user && s.user.id === targetState.fetcher.spotifyId);
          if (match) sessionToUse = match.sessionId;
        }
      }

      const endpointMap = {
        next: { method: 'POST', path: '/api/spotify/next' },
        previous: { method: 'POST', path: '/api/spotify/previous' },
        play: { method: 'PUT', path: '/api/spotify/play' },
        pause: { method: 'PUT', path: '/api/spotify/pause' }
      };

      const mapEntry = endpointMap[action.type];
      if (!mapEntry) {
        // Broadcast for unsupported actions, but don't call Spotify
        socket.broadcast.emit('playback_control_received', {
          user: user.name,
          action: action.type,
          timestamp: new Date()
        });
        return;
      }

      try {
        // If we couldn't resolve a session to use for the Spotify API call, fail fast
        if (!sessionToUse) {
          console.error('❌ Aucun session_id résolu pour exécuter la commande Spotify pour', user.name);
          socket.emit('control_error', { reason: 'Not authenticated: no session available' });
          return;
        }

        // Special-case: if there's a server-side queue, honor it for 'next' by playing the queued track
        if (action.type === 'next' && targetState.queue && targetState.queue.length > 0) {
          const nextTrack = targetState.queue[0];
          try {
            const API_BASE = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
            const playRes = await fetch(`${API_BASE.replace(/\/$/, '')}/api/spotify/play-track`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Cookie': `session_id=${sessionToUse}`
              },
              body: JSON.stringify({ uri: nextTrack.uri })
            });

            if (playRes && playRes.ok) {
              // Remove from queue and broadcast
              const removed = targetState.queue.shift();
              io.emit('queue_updated', { queue: targetState.queue, autoRemoved: true, removedTrack: removed, isParty: isPartyMode });

              // Update server playback state
              targetState.ownerSpotifyId = user.spotifyId;
              // If controlling directly, ensure fetcher assignment
              if (canControlDirectly) {
                targetState.fetcher = { spotifyId: user.spotifyId, name: user.name, socketId: socket.id, sessionId: user.sessionId };
              }

              // Use helper for party mode to set proper timing
              if (isPartyMode) {
                startPartyPlayback(nextTrack, 0);
                broadcastPartyState();
              } else {
                targetState.currentTrack = nextTrack;
                targetState.isPlaying = true;
                targetState.position = 0;
                broadcastPlaybackState();
              }
              socket.broadcast.emit('playback_control_received', { user: user.name, action: 'next', timestamp: new Date() });
              return;
            } else {
              const txt = playRes ? (await playRes.text()) : 'no response';
              console.warn('⚠️ play-track for queued next failed, falling back to normal next:', txt);
              // fall-through to normal next behavior below
            }
          } catch (err) {
            console.warn('⚠️ Erreur en tentant play-track pour queue next, falling back to normal next:', err?.message || err);
            // fall-through to normal next behavior below
          }
        }

        const API_BASE = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
        if (typeof shouldLog === 'function' ? shouldLog('relay_control_session') : true) console.log(`🔁 relay control using session_id=${sessionToUse} for action=${action.type} by ${user.name}`);
        const res = await fetch(`${API_BASE.replace(/\/$/, '')}${mapEntry.path}`, {
          method: mapEntry.method,
          headers: {
            'Content-Type': 'application/json',
            'Cookie': sessionToUse ? `session_id=${sessionToUse}` : ''
          },
          body: action.payload ? JSON.stringify(action.payload) : undefined
        });

        if (!res.ok) {
          const txt = await res.text();

          // Special handling for Spotify 403 'Restriction violated' which sometimes is returned
          // even when the player state eventually reflects the requested action. Verify actual
          // playback state using the same session; if the player is already playing (or matches
          // the requested action), treat the control as successful.
          try {
            if (res.status === 403 && txt && txt.toLowerCase().includes('restriction')) {
              if (sessionToUse) {
                try {
                  const stateResp = await fetch(`${API_BASE.replace(/\/$/, '')}/api/spotify/playback-state`, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json', 'Cookie': `session_id=${sessionToUse}` }
                  });

                  if (stateResp && stateResp.ok) {
                    const stateData = await stateResp.json();
                    const actuallyPlaying = !!stateData?.is_playing;
                    // If the requested action was 'play' and Spotify reports playing, treat as success
                    if (action.type === 'play' && actuallyPlaying) {
                      console.log('ℹ️ Relay returned 403 but playback-state shows playing — treating as success');
                      // Update server-side playbackState
                      if (canControlDirectly) {
                        targetState.fetcher = { spotifyId: user.spotifyId, name: user.name, socketId: socket.id, sessionId: user.sessionId };
                        targetState.ownerSpotifyId = user.spotifyId;
                      }
                      
                      // Handle play/pause with proper timing for party mode
                      if (isPartyMode) {
                        resumePartyPlayback();
                      } else {
                        targetState.isPlaying = true;
                        if (stateData.item) targetState.currentTrack = stateData.item;
                        targetState.position = stateData.progress_ms || 0;
                      }
                      
                      if (isPartyMode) {
                        broadcastPartyState();
                      } else {
                        broadcastPlaybackState();
                      }
                      socket.broadcast.emit('playback_control_received', { user: user.name, action: action.type, timestamp: new Date() });
                      return;
                    }

                    // If requested 'pause' and Spotify reports not playing, treat as success
                    if (action.type === 'pause' && !actuallyPlaying) {
                      console.log('ℹ️ Relay returned 403 but playback-state shows paused — treating as success');
                      if (canControlDirectly) {
                        targetState.fetcher = { spotifyId: user.spotifyId, name: user.name, socketId: socket.id, sessionId: user.sessionId };
                        targetState.ownerSpotifyId = user.spotifyId;
                      }
                      
                      // Handle play/pause with proper timing for party mode
                      if (isPartyMode) {
                        pausePartyPlayback();
                      } else {
                        targetState.isPlaying = false;
                        if (stateData.item) targetState.currentTrack = stateData.item;
                        targetState.position = stateData.progress_ms || 0;
                      }
                      
                      if (isPartyMode) {
                        broadcastPartyState();
                      } else {
                        broadcastPlaybackState();
                      }
                      socket.broadcast.emit('playback_control_received', { user: user.name, action: action.type, timestamp: new Date() });
                      return;
                    }
                  }
                } catch (err) {
                  console.warn('⚠️ Failed to verify playback-state after 403:', err?.message || err);
                }
              }
            }
          } catch (err) {
            console.warn('⚠️ Error in post-403 verification flow:', err);
          }

          // If we didn't early-return above, report the control error back to the requester
          if (typeof shouldLog === 'function' ? shouldLog('relay_control_error') : true) console.error('❌ Erreur relay control:', txt);
          socket.emit('control_error', { reason: txt });
          return;
        }

        // If next was called and queue exists, remove first
        if (action.type === 'next' && targetState.queue.length > 0) {
          const removedTrack = targetState.queue.shift();
          io.emit('queue_updated', {
            queue: targetState.queue,
            autoRemoved: true,
            removedTrack: removedTrack,
            isParty: isPartyMode
          });
        }

        // Update server-side playbackState
        if (canControlDirectly) {
          targetState.fetcher = { spotifyId: user.spotifyId, name: user.name, socketId: socket.id, sessionId: user.sessionId };
          // direct control gives ownership of playback to this user
          targetState.ownerSpotifyId = user.spotifyId;
        }
        
        // Handle play/pause with proper timing for party mode
        if (isPartyMode) {
          if (action.type === 'play') {
            resumePartyPlayback();
          } else if (action.type === 'pause') {
            pausePartyPlayback();
          }
        } else {
          if (action.type === 'play') targetState.isPlaying = true;
          if (action.type === 'pause') targetState.isPlaying = false;
        }

        // Broadcast playback state changes using helper (full only to exact fetcher socket)
        if (isPartyMode) {
          broadcastPartyState();
        } else {
          broadcastPlaybackState();
        }
        socket.broadcast.emit('playback_control_received', {
          user: user.name,
          action: action.type,
          timestamp: new Date()
        });
      } catch (err) {
        console.error('❌ Erreur lors du relay vers Spotify:', err);
        socket.emit('control_error', { reason: 'Relay failed' });
      }
    });

    // Événement d'auto-play quand file vide
    socket.on('auto_play_track', async (trackData) => {
      console.log(`🎵 Auto-play demandé de ${socket.id}:`, trackData);
      console.log(`📊 État serveur actuel - Queue: ${currentPlaybackState.queue.length}, Current: ${currentPlaybackState.currentTrack?.name || 'none'}`);
      const user = connectedUsers.get(socket.id);
      
      if (!user) {
        console.error(`❌ Utilisateur non trouvé pour auto-play`);
        return;
      }

      // Auto-play même si il y a 1 élément dans la queue (celui qu'on vient d'ajouter)
      // mais pas de musique en cours de lecture
      if (!currentPlaybackState.currentTrack || !currentPlaybackState.isPlaying) {
        console.log(`🚀 Lecture automatique de "${trackData.name}"`);
        
    // Mettre à jour l'état de lecture
    currentPlaybackState.currentTrack = trackData;
    currentPlaybackState.isPlaying = true;
    currentPlaybackState.position = 0;
    currentPlaybackState.fetcher = { spotifyId: user.spotifyId, name: user.name, socketId: socket.id, sessionId: user.sessionId };
    // owner is the user who requested the auto_play
    currentPlaybackState.ownerSpotifyId = user.spotifyId;

        // Émettre l'état mis à jour (broadcast masked/full appropriately)
        broadcastPlaybackState();

        // Jouer via Spotify API en utilisant la route locale
        try {
          // Resolve sessionId for this user if not present on the socket user object
          let sessionIdToUse = user.sessionId;
          if (!sessionIdToUse) {
            try {
              const sessionManager = require('../utils/sessionManager');
              const sessions = sessionManager.getActiveSessions();
              const match = sessions.find(s => s.user && (s.user.id === user.id || s.user.id === user.spotifyId || s.user.display_name === user.name));
              if (match) sessionIdToUse = match.sessionId;
            } catch (err) {
              console.warn('⚠️ Erreur lors de la résolution de session pour auto_play_track:', err);
            }
          }

          if (!sessionIdToUse) {
            console.error('❌ Aucun session_id résolu pour auto_play_track pour', user.name);
            socket.emit('control_error', { reason: 'Not authenticated: no session available for auto_play' });
            return;
          }

          const API_BASE = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
          const response = await fetch(`${API_BASE.replace(/\/$/, '')}/api/spotify/play-track`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Cookie': `session_id=${sessionIdToUse}`
            },
            body: JSON.stringify({
              uri: trackData.uri
            })
          });

          if (response.ok) {
            console.log(`✅ Track joué avec succès: ${trackData.uri}`);
            
            // Supprimer le track de la queue après lecture réussie
            const trackIndex = currentPlaybackState.queue.findIndex(q => q.uri === trackData.uri);
            if (trackIndex !== -1) {
              const removedTrack = currentPlaybackState.queue.splice(trackIndex, 1)[0];
              console.log(`📋 Suppression automatique de la queue: ${removedTrack.name}`);
              
              // Informer tous les clients de la mise à jour de la queue
              io.emit('queue_updated', {
                queue: currentPlaybackState.queue,
                autoRemoved: true,
                removedTrack: removedTrack,
                isParty: false
              });
            }
          } else {
            const errorText = await response.text();
            console.error(`❌ Erreur lors de la lecture:`, errorText);
          }
        } catch (error) {
          console.error(`❌ Erreur de connexion Spotify:`, error);
        }
      } else {
        console.log(`⚠️ Auto-play ignoré - musique déjà en cours: "${currentPlaybackState.currentTrack?.name}"`);
      }
    });

    // Événement d'ajout à la file d'attente
    socket.on('track_queued', (trackData) => {
      console.log(`🎵 Événement track_queued reçu de ${socket.id}:`, trackData);
      const user = connectedUsers.get(socket.id);
      console.log(`👤 Utilisateur trouvé pour ${socket.id}:`, user ? user.name : 'NON TROUVÉ');
      
      if (!user) {
        console.error(`❌ Utilisateur non trouvé pour socket ${socket.id}. Utilisateurs connectés:`, Array.from(connectedUsers.keys()));
        return;
      }

      const hasAnyFetcher = (partyPlaybackState && partyPlaybackState.fetcher) || (currentPlaybackState && currentPlaybackState.fetcher);
      if (!user.isSyncedWithParty && !hasAnyFetcher) {
        console.log(`⚠️ ${user.name} a tenté d'ajouter une piste en mode Solo (non autorisé, aucun fetcher disponible)`);
        socket.emit('control_error', { reason: 'La file d\'attente est disponible uniquement en mode Party tant qu\'il n\'y a pas de fetcher actif' });
        return;
      }

      if (!user.isSyncedWithParty && hasAnyFetcher) {
        // Autorisé: utilisateur en Solo mais un fetcher existe, on le laisse ajouter à la queue.
        if (typeof shouldLog === 'function' ? shouldLog(`queue_add_allowed_solo_with_fetcher_${socket.id}`) : true) console.log(`ℹ️ ${user.name} (Solo) ajoute une piste parce qu'un fetcher est présent`);
      }

      // Build queue item metadata
      const queueItem = {
        ...trackData,
        addedBy: user.name,
        addedAt: new Date(),
        id: Date.now() + Math.random() // ID unique simple
      };

      // Decide whether this belongs to party queue or solo (current) queue
      const isPartyAdd = !!user.isSyncedWithParty;
      if (isPartyAdd) {
        console.log(`➕ ${user.name} a ajouté "${trackData.name}" à la file d'attente party`);
        partyPlaybackState.queue.push(queueItem);

        if (typeof shouldLog === 'function' ? shouldLog('party_queue_size_log') : true) console.log(`ℹ️ Queue party taille après ajout: ${partyPlaybackState.queue.length}`);

        // Inform all clients about the updated party queue
        io.emit('queue_updated', {
          queue: partyPlaybackState.queue,
          addedTrack: queueItem,
          addedBy: user.name,
          isParty: true
        });

        io.emit('queue_message', {
          user: user.name,
          message: `a ajouté "${trackData.name}" à la file d'attente`,
          timestamp: new Date()
        });

        // If nothing is playing in party, attempt to auto-play the newly queued track (same logic as before)
        try {
          if (!partyPlaybackState.currentTrack || !partyPlaybackState.isPlaying) {
            const nextTrack = partyPlaybackState.queue[0];
            if (nextTrack) {
              console.log(`ℹ️ Aucune lecture party en cours, tentative d'auto-play pour ${nextTrack.name} ajouté par ${user.name}`);

              // Resolve a session id to use: prefer fetcher.sessionId, else the user who queued
              let sessionIdToUse = null;
              if (partyPlaybackState.fetcher && partyPlaybackState.fetcher.sessionId) {
                sessionIdToUse = partyPlaybackState.fetcher.sessionId;
              }
              if (!sessionIdToUse) {
                sessionIdToUse = user.sessionId;
              }

              if (!sessionIdToUse) {
                // try to lookup in session manager
                try {
                  const sessionManager = require('../utils/sessionManager');
                  const sessions = sessionManager.getActiveSessions();
                  const match = sessions.find(s => s.user && (s.user.id === user.id || s.user.id === user.spotifyId || s.user.display_name === user.name));
                  if (match) sessionIdToUse = match.sessionId;
                } catch (err) {
                  console.warn('⚠️ Impossible de résoudre session pour auto-play après track_queued (party):', err);
                }
              }

              if (!sessionIdToUse) {
                console.log('⚠️ Aucun session_id disponible pour auto-play du track ajouté (party)');
              } else {
                // Call internal API to play the track using the resolved session cookie
                const API_BASE = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
                (async () => {
                  try {
                    const axios = require('axios');
                    const response = await axios.post(`${API_BASE.replace(/\/$/, '')}/api/spotify/play-track`, { uri: nextTrack.uri }, {
                      headers: { 'Content-Type': 'application/json', 'Cookie': `session_id=${sessionIdToUse}` }
                    });

                    if (response.status >= 200 && response.status < 300) {
                      console.log(`✅ Auto-play party démarré pour ${nextTrack.name}`);
                      // Remove from party queue locally
                      const trackIndex = partyPlaybackState.queue.findIndex(q => q.uri === nextTrack.uri);
                      if (trackIndex !== -1) {
                        const removedTrack = partyPlaybackState.queue.splice(trackIndex, 1)[0];
                        io.emit('queue_updated', {
                          queue: partyPlaybackState.queue,
                          autoRemoved: true,
                          removedTrack: removedTrack,
                          isParty: true
                        });
                      }
                      if (typeof shouldLog === 'function' ? shouldLog('party_queue_size_after_autoplay') : true) console.log(`ℹ️ Queue party taille après autoplay remove: ${partyPlaybackState.queue.length}`);
                      // Update party playback state using helper
                      partyPlaybackState.ownerSpotifyId = user.spotifyId;
                      startPartyPlayback(nextTrack, 0);
                      // Broadcast party state
                      broadcastPartyState();
                    } else {
                      const txt = response.data || `HTTP ${response.status}`;
                      console.warn('⚠️ Auto-play party failed:', txt);
                      // Notify specific user who queued that auto-play failed
                      io.to(socket.id).emit('auto_play_failed', { error: txt });
                    }
                  } catch (err) {
                    const txt = err?.response?.data || err.message;
                    console.error('❌ Erreur lors de l\'appel interne pour auto-play party:', txt);
                    io.to(socket.id).emit('auto_play_failed', { error: txt });
                  }
                })();
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ Erreur dans auto-play after track_queued (party):', err);
        }
      } else {
        // Solo add -> push to currentPlaybackState.queue (solo queue)
        console.log(`➕ ${user.name} a ajouté "${trackData.name}" à la file d'attente solo`);
        currentPlaybackState.queue.push(queueItem);

        if (typeof shouldLog === 'function' ? shouldLog('solo_queue_size_log') : true) console.log(`ℹ️ Queue solo taille après ajout: ${currentPlaybackState.queue.length}`);

        io.emit('queue_updated', {
          queue: currentPlaybackState.queue,
          addedTrack: queueItem,
          addedBy: user.name,
          isParty: false
        });

        io.emit('queue_message', {
          user: user.name,
          message: `a ajouté "${trackData.name}" à la file d'attente solo`,
          timestamp: new Date()
        });

        // If nothing is playing in solo, attempt to auto-play the newly queued track
        try {
          if (!currentPlaybackState.currentTrack || !currentPlaybackState.isPlaying) {
            const nextTrack = currentPlaybackState.queue[0];
            if (nextTrack) {
              console.log(`ℹ️ Aucune lecture solo en cours, tentative d'auto-play pour ${nextTrack.name} ajouté par ${user.name}`);

              // Resolve a session id to use: prefer fetcher.sessionId, else the user who queued
              let sessionIdToUse = null;
              if (currentPlaybackState.fetcher && currentPlaybackState.fetcher.sessionId) {
                sessionIdToUse = currentPlaybackState.fetcher.sessionId;
              }
              if (!sessionIdToUse) {
                sessionIdToUse = user.sessionId;
              }

              if (!sessionIdToUse) {
                try {
                  const sessionManager = require('../utils/sessionManager');
                  const sessions = sessionManager.getActiveSessions();
                  const match = sessions.find(s => s.user && (s.user.id === user.id || s.user.id === user.spotifyId || s.user.display_name === user.name));
                  if (match) sessionIdToUse = match.sessionId;
                } catch (err) {
                  console.warn('⚠️ Impossible de résoudre session pour auto-play après track_queued (solo):', err);
                }
              }

              if (!sessionIdToUse) {
                console.log('⚠️ Aucun session_id disponible pour auto-play du track ajouté (solo)');
              } else {
                const API_BASE = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;
                (async () => {
                  try {
                    const axios = require('axios');
                    const response = await axios.post(`${API_BASE.replace(/\/$/, '')}/api/spotify/play-track`, { uri: nextTrack.uri }, {
                      headers: { 'Content-Type': 'application/json', 'Cookie': `session_id=${sessionIdToUse}` }
                    });

                    if (response.status >= 200 && response.status < 300) {
                      console.log(`✅ Auto-play solo démarré pour ${nextTrack.name}`);
                      // Remove from solo queue locally
                      const trackIndex = currentPlaybackState.queue.findIndex(q => q.uri === nextTrack.uri);
                      if (trackIndex !== -1) {
                        const removedTrack = currentPlaybackState.queue.splice(trackIndex, 1)[0];
                        io.emit('queue_updated', {
                          queue: currentPlaybackState.queue,
                          autoRemoved: true,
                          removedTrack: removedTrack,
                          isParty: false
                        });
                      }
                      if (typeof shouldLog === 'function' ? shouldLog('solo_queue_size_after_autoplay') : true) console.log(`ℹ️ Queue solo taille après autoplay remove: ${currentPlaybackState.queue.length}`);
                      // Update solo playback state
                      currentPlaybackState.currentTrack = nextTrack;
                      currentPlaybackState.isPlaying = true;
                      currentPlaybackState.position = 0;
                      currentPlaybackState.ownerSpotifyId = user.spotifyId;
                      // Broadcast solo state
                      broadcastPlaybackState();
                    } else {
                      const txt = response.data || `HTTP ${response.status}`;
                      console.warn('⚠️ Auto-play solo failed:', txt);
                      io.to(socket.id).emit('auto_play_failed', { error: txt });
                    }
                  } catch (err) {
                    const txt = err?.response?.data || err.message;
                    console.error('❌ Erreur lors de l\'appel interne pour auto-play solo:', txt);
                    io.to(socket.id).emit('auto_play_failed', { error: txt });
                  }
                })();
              }
            }
          }
        } catch (err) {
          console.warn('⚠️ Erreur dans auto-play after track_queued (solo):', err);
        }
      }
    });

    // Événement de suppression de la file d'attente
    socket.on('track_removed_from_queue', (trackId) => {
      const user = connectedUsers.get(socket.id);
      if (!user) return;

      // Determine which queue to operate on based on user's sync mode
      const isPartyOp = !!user.isSyncedWithParty;
      if (isPartyOp) {
        const trackIndex = partyPlaybackState.queue.findIndex(track => track.id === trackId);
        if (trackIndex !== -1) {
          const removedTrack = partyPlaybackState.queue.splice(trackIndex, 1)[0];
          console.log(`🗑️ ${user.name} a supprimé "${removedTrack.name}" de la file d'attente party`);

          // Informer tous les clients de la mise à jour de la queue
          io.emit('queue_updated', {
            queue: partyPlaybackState.queue,
            removedTrack: removedTrack,
            removedBy: user.name,
            isParty: true
          });

          // Message dans le chat
          io.emit('queue_message', {
            user: user.name,
            message: `a supprimé "${removedTrack.name}" de la file d'attente`,
            timestamp: new Date()
          });
        }
        return;
      }

      // Solo operation: allow removal from solo queue with sensible permissions
      const trackIndexSolo = currentPlaybackState.queue.findIndex(track => track.id === trackId);
      if (trackIndexSolo === -1) {
        // nothing to remove
        return;
      }

      const trackToRemove = currentPlaybackState.queue[trackIndexSolo];
      // Permit removal if the requester added the track, or is premium, or is the fetcher
      const amIFetcher = currentPlaybackState.fetcher && (currentPlaybackState.fetcher.spotifyId === user.spotifyId || currentPlaybackState.fetcher.socketId === socket.id);
      const canRemoveSolo = (trackToRemove.addedBy === user.name) || !!user.premium || !!amIFetcher;

      if (!canRemoveSolo) {
        console.log(`⚠️ ${user.name} n'est pas autorisé à supprimer la piste solo ${trackToRemove.name}`);
        socket.emit('control_denied', { reason: 'Not allowed to remove this track from solo queue' });
        return;
      }

      const removedTrack = currentPlaybackState.queue.splice(trackIndexSolo, 1)[0];
      console.log(`🗑️ ${user.name} a supprimé "${removedTrack.name}" de la file d'attente solo`);

      // Emit updated solo queue
      io.emit('queue_updated', {
        queue: currentPlaybackState.queue,
        removedTrack: removedTrack,
        removedBy: user.name,
        isParty: false
      });

      io.emit('queue_message', {
        user: user.name,
        message: `a supprimé "${removedTrack.name}" de la file d'attente solo`,
        timestamp: new Date()
      });
    });

    // Événement de changement d'état de lecture
    // Only the exact fetcher socket may send full playback state updates. Others will be ignored or will only trigger a masked broadcast.
    socket.on('playback_state_changed', (newState) => {
      const user = connectedUsers.get(socket.id);
      if (!user) return;

      const isExactFetcherSocket = currentPlaybackState.fetcher && currentPlaybackState.fetcher.socketId === socket.id;

      if (!isExactFetcherSocket) {
        // Non-fetchers are not allowed to push full playback state. If they attempt, emit a masked broadcast so clients stay consistent.
  if (typeof shouldLog === 'function' ? shouldLog(`unauthorized_playback_state_${socket.id}`) : true) console.log(`⚠️ Ignored full playback_state_changed from non-fetcher ${user.name} (${socket.id})`);
        broadcastPlaybackState();
        return;
      }

      // Mettre à jour l'état global (fetcher is the authoritative source)
      if (newState.currentTrack !== undefined) {
        currentPlaybackState.currentTrack = newState.currentTrack;
      }
      if (newState.isPlaying !== undefined) {
        currentPlaybackState.isPlaying = newState.isPlaying;
      }
      if (newState.position !== undefined) {
        currentPlaybackState.position = newState.position;
      }
      if (newState.fetcher) {
        currentPlaybackState.fetcher = newState.fetcher;
      }

      // Broadcast updated playback (masked to others, full to fetcher)
      broadcastPlaybackState();
    });

    // When a client (fetcher or owner) reports back the result of an action, forward it to the original requester
    socket.on('perform_playback_result', (data) => {
      try {
        const requestedSocketId = data?.requestedSocketId;
        if (requestedSocketId && io) {
          io.to(requestedSocketId).emit('perform_playback_result', data);
        }

        // Broadcast updated playback state so UIs refresh
        try { broadcastPlaybackState(); } catch (e) { /* ignore */ }
      } catch (err) {
        console.warn('⚠️ Erreur en traitant perform_playback_result:', err);
      }
    });

    // Événement de message de chat
    socket.on('chat_message', (data) => {
      const user = connectedUsers.get(socket.id);
      if (!user) return;

      const message = {
        id: Date.now(),
        user: user.name,
        message: data.message,
        timestamp: new Date(),
        avatar: user.avatar
      };

      // Diffuser le message à tous les clients connectés
      io.emit('chat_message_received', message);
    });

    // Événement de partage de recherche
    socket.on('search_shared', (searchData) => {
      const user = connectedUsers.get(socket.id);
      if (!user) return;

      // Diffuser les résultats de recherche à tous les autres clients
      socket.broadcast.emit('search_results_shared', {
        sharedBy: user.name,
        query: searchData.query,
        results: searchData.results,
        timestamp: new Date()
      });
    });

    // Événement de demande de synchronisation
    socket.on('request_sync', () => {
      const usersList = Array.from(connectedUsers.values());
      // Determine whether the requester is the exact fetcher socket
      const requesterIsFetcher = currentPlaybackState.fetcher && currentPlaybackState.fetcher.socketId === socket.id;
      let playbackForRequester = { ...currentPlaybackState };
      if (!requesterIsFetcher) {
        // mask for non-fetchers
        playbackForRequester = { ...playbackForRequester, currentTrack: null, isPlaying: false, position: 0 };
      } else {
        // If requester is fetcher but does not own the current playback, mask as well
        const owner = currentPlaybackState.ownerSpotifyId;
        const fetcherId = currentPlaybackState.fetcher ? currentPlaybackState.fetcher.spotifyId : null;
        if (owner && fetcherId && owner !== fetcherId) {
          playbackForRequester = { ...playbackForRequester, currentTrack: null, isPlaying: false, position: 0 };
        }
      }
      // Include partyState in full_sync so clients following the party do not
      // receive an undefined partyState which could clear their UI.
      socket.emit('full_sync', {
        playbackState: playbackForRequester,
        partyState: partyPlaybackState,
        connectedUsers: usersList,
        // Inform requester whether they are currently marked as synced with party
        isSyncedWithParty: !!(connectedUsers.get(socket.id) && connectedUsers.get(socket.id).isSyncedWithParty)
      });
    });
  });

  // Nettoyage périodique (optionnel)
  setInterval(() => {
    // Nettoyer les anciennes entrées de la file d'attente si nécessaire
    // currentPlaybackState.queue = currentPlaybackState.queue.slice(-50); // Garder seulement les 50 dernières
  }, 5 * 60 * 1000); // Toutes les 5 minutes

  // Broadcast périodique de l'état Party avec position mise à jour (toutes les 500ms)
  // Cela assure que tous les clients synchronisés affichent la même position en temps réel
  setInterval(() => {
    try {
      // Only broadcast if there are party-synced users and something is playing
      if (partyPlaybackState.isPlaying || partyPlaybackState.currentTrack) {
        const syncedUsers = Array.from(connectedUsers.values()).filter(u => u.isSyncedWithParty);
        if (syncedUsers.length > 0) {
          broadcastPartyState();
        }
      }
    } catch (err) {
      console.warn('⚠️ Erreur dans le broadcast périodique Party:', err);
    }
  }, 500); // Every 500ms

  // Periodic check: Verify that connected users' Spotify access tokens are still valid.
  // We only check sessions for currently connected users to limit Spotify API usage.
  const tokenCheckIntervalMs = 2 * 60 * 1000; // every 2 minutes
  const tokenCheckTimeout = 8000; // 8s timeout for axios

  async function checkConnectedUsersTokens() {
    try {
      if (!ioInstance || connectedUsers.size === 0) return;

      let changed = false;

      // For each connected user that has a sessionId, verify their token by calling /v1/me
      for (const [sockId, user] of connectedUsers.entries()) {
        const sid = user.sessionId;
        if (!sid) {
          // no session attached -> mark as unauthenticated
          if (user.spotifyTokenValid !== false) {
            user.spotifyTokenValid = false;
            changed = true;
          }
          continue;
        }

        const session = sessionManager.getSession(sid);
        if (!session || !session.access_token) {
          if (user.spotifyTokenValid !== false) {
            user.spotifyTokenValid = false;
            changed = true;
          }
          continue;
        }

        try {
          const resp = await axios.get('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${session.access_token}` },
            timeout: tokenCheckTimeout
          });

          if (resp && resp.status === 200) {
            if (user.spotifyTokenValid !== true) {
              user.spotifyTokenValid = true;
              changed = true;
            }
          } else {
            if (user.spotifyTokenValid !== false) {
              user.spotifyTokenValid = false;
              changed = true;
            }
          }
        } catch (err) {
          const status = err?.response?.status;
          if (status === 401 || status === 403) {
            // token invalid or expired
            sessionManager.updateSession(sid, { invalid: true });
            if (user.spotifyTokenValid !== false) {
              user.spotifyTokenValid = false;
              changed = true;
            }
          } else {
            // network or rate limit; do not change state to avoid flapping
            if (typeof shouldLog === 'function' ? shouldLog('token_check_network') : true) console.log('ℹ️ Token check network issue for', user.name, err.message || err);
          }
        }
      }

      if (changed) {
        // Emit updated user list
        const usersList = Array.from(connectedUsers.values());
        ioInstance.emit('user_list_updated', usersList);
        if (typeof shouldLog === 'function' ? shouldLog('user_list_token_changed') : true) console.log('🔁 Emitted user_list_updated due to token validity changes');
      }
    } catch (err) {
      console.warn('⚠️ Erreur dans checkConnectedUsersTokens:', err);
    }
  }

  // Start periodic checking
  setInterval(() => {
    // fire and forget
    checkConnectedUsersTokens().catch(() => {});
  }, tokenCheckIntervalMs);
};

// Méthodes utilitaires pour exposer la queue locale
socketHandler.setIO = (io) => {
  ioInstance = io;
};

socketHandler.getCurrentQueue = () => {
  return currentPlaybackState.queue;
};

socketHandler.removeFirstFromQueue = () => {
  if (currentPlaybackState.queue.length > 0) {
    const removedTrack = currentPlaybackState.queue.shift();
    console.log(`📋 Track supprimé de la queue locale: ${removedTrack.name}`);
    // Émettre la mise à jour de la queue après suppression
    if (ioInstance) {
      ioInstance.emit('queue_updated', {
        queue: currentPlaybackState.queue,
        autoRemoved: true,
        removedTrack: removedTrack,
        isParty: false
      });
    }
    return removedTrack;
  }
  return null;
};

socketHandler.getPlaybackState = () => {
  return currentPlaybackState;
};

// Notify all connected sockets about a rate limit event (msRemaining)
socketHandler.notifyRateLimit = (ms) => {
  try {
    if (!ioInstance) return;
    ioInstance.emit('server_rate_limited', { msRemaining: ms });
    console.warn(`🔔 Notified clients of rate limit for ${ms}ms`);
  } catch (err) {
    console.warn('⚠️ Erreur lors de la notification rate limit:', err);
  }
};

module.exports = socketHandler;
module.exports.partyPlaybackState = partyPlaybackState;
module.exports.seekPartyPlayback = seekPartyPlayback;
