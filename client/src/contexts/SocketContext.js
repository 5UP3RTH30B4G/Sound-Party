import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';

const SocketContext = createContext();

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};

export const SocketProvider = ({ children, socket }) => {
  const { user, authenticated } = useAuth();
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [playbackState, setPlaybackState] = useState({
    isPlaying: false,
    currentTrack: null,
    position: 0,
    queue: [],
  });
  const [partyState, setPartyState] = useState({
    isPlaying: false,
    currentTrack: null,
    position: 0,
    queue: [],
  });
  const [isSyncedWithParty, setIsSyncedWithParty] = useState(false);
  const [messages, setMessages] = useState([]);
  const [serverRateLimitedMs, setServerRateLimitedMs] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');

  useEffect(() => {
    if (!socket) {
      console.log('❌ Pas de socket disponible');
      return;
    }

    // Note: user registration is handled on socket 'connect' and in the
    // authentication-change effect below. Avoid emitting 'user_connected'
    // on every re-run of this effect (which can happen when playback/party
    // state updates) to prevent spamming the server with repeated
    // registrations.

    // Événements de connexion
    socket.on('connect', () => {
      setConnectionStatus('connected');
      console.log('✅ Connecté au serveur');
      
      // Si l'utilisateur est authentifié, l'enregistrer
      if (authenticated && user) {
        console.log('👤 Auto-enregistrement après connexion:', user.display_name);
        socket.emit('user_connected', {
          name: user.display_name,
          spotifyId: user.id,
          avatar: user.images?.[0]?.url || null,
          premium: user.product === 'premium',
          sessionId: user.sessionId || null
        });
      }
    });

    socket.on('disconnect', () => {
      setConnectionStatus('disconnected');
      console.log('❌ Déconnecté du serveur');
    });

    socket.on('reconnect', () => {
      setConnectionStatus('connected');
      console.log('🔄 Reconnecté au serveur');
    });

    // Événements utilisateurs
    socket.on('user_list_updated', (users) => {
      setConnectedUsers(users);
    });

    socket.on('user_joined', (data) => {
      addSystemMessage(`${data.user} a rejoint la session !`, 'success');
    });

    socket.on('user_left', (data) => {
      addSystemMessage(`${data.user} a quitté la session`, 'info');
    });

    // Événements de lecture
    socket.on('playback_state_updated', (state) => {
      try {
        // If the client is synced with the party, avoid applying solo playback
        // updates — while following a party, local/solo updates should not override party UI.
        if (isSyncedWithParty) {
          if (process.env.NODE_ENV !== 'development') console.log('Ignored solo playback_state_updated because client is synced with party');
        } else {
          setPlaybackState(state);
        }
      } catch (err) {
        console.warn('Error handling playback_state_updated', err);
      }

      // Dev: print detailed payload for debugging
      if (process.env.NODE_ENV !== 'production') {
        try {
          console.log('socket: playback_state_updated (detail):', JSON.stringify({
            currentTrack: state?.currentTrack?.name || null,
            position: state?.position,
            isPlaying: state?.isPlaying
          }));
        } catch (e) { console.log('socket: playback_state_updated (raw):', state); }
      }
    });
    socket.on('party_state_updated', (state) => {
      if (process.env.NODE_ENV !== 'production') {
        try {
          console.log('socket: party_state_updated', state);
          console.log('socket: party_state_updated (detail):', JSON.stringify({
            currentTrack: state?.currentTrack?.name || null,
            position: state?.position,
            isPlaying: state?.isPlaying,
            queueLength: state?.queue?.length || 0
          }));
        } catch (e) { /* ignore stringify errors */ }
      }
      setPartyState(state);
    });

    // Server-side rate limit notification: pause client polling/backoff
    socket.on('server_rate_limited', (data) => {
      try {
        const ms = data?.msRemaining || 0;
        if (ms > 0) {
          setServerRateLimitedMs(ms);
          addSystemMessage(`⚠️ Server rate-limited for ${Math.round(ms/1000)}s. Pausing API calls.`, 'warning');
          // Clear after ms
          setTimeout(() => {
            setServerRateLimitedMs(0);
            addSystemMessage('✅ Server rate-limit lifted. Resuming API calls.', 'success');
          }, ms);
        }
      } catch (err) {
        console.warn('Error handling server_rate_limited event', err);
      }
    });

    socket.on('playback_control_received', (data) => {
      addSystemMessage(`${data.user} a ${getActionText(data.action)}`, 'info');
    });

    // Événements de file d'attente
    socket.on('queue_updated', (data) => {
      console.log('🔄 Queue mise à jour:', data);
      try {
        if (data.isParty) {
          setPartyState(prev => ({ ...prev, queue: data.queue }));
        } else {
          setPlaybackState(prev => ({ ...prev, queue: data.queue }));
        }
      } catch (err) {
        console.warn('⚠️ Erreur lors de la mise à jour de la queue côté client:', err);
      }
    });

    socket.on('queue_message', (data) => {
      console.log('📋 Message queue:', data);
      addSystemMessage(`${data.user} ${data.message}`, 'info');
    });

    // Événement pour jouer une chanson provenant de la queue (auto ou manuel)
    socket.on('play_track_from_queue', async (data) => {
      try {
        const trigger = data?.trigger || 'auto';
        const trackName = data?.track?.name || 'unknown';

        if (trigger === 'manual') {
          addSystemMessage(`${data.requestedBy || 'Utilisateur'} a lancé la lecture: "${trackName}"`, 'info');
        } else {
          addSystemMessage(`🎵 Lecture automatique: "${trackName}"`, 'success');
        }

        // Émettre un événement pour que PlayerControls gère la lecture
        window.dispatchEvent(new CustomEvent('autoPlayTrackFromQueue', {
          detail: { track: data.track, requestedBy: data.requestedBy, trigger }
        }));
      } catch (err) {
        console.warn('Erreur handling play_track_from_queue:', err);
      }
    });

    // Handler: perform_playback_control (server forwarded control request)
    socket.on('perform_playback_control', async (data) => {
      console.log('🔁 perform_playback_control reçu:', data);
      addSystemMessage(`🔁 Exécution action demandée par ${data.requestedBy}: ${data.action.type}`, 'info');

      try {
  const action = data.action || {};
  const opts = { method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'include' };

        let url = null;
        let body = null;

        switch (action.type) {
          case 'next':
            url = '/api/spotify/next';
            opts.method = 'POST';
            break;
          case 'previous':
            url = '/api/spotify/previous';
            opts.method = 'POST';
            break;
          case 'play':
            url = '/api/spotify/play';
            opts.method = 'PUT';
            body = action.payload || undefined;
            break;
          case 'pause':
            url = '/api/spotify/pause';
            opts.method = 'PUT';
            break;
          case 'seek':
            url = '/api/spotify/seek';
            opts.method = 'PUT';
            body = { position_ms: action.payload?.position_ms };
            break;
          case 'volume':
            url = '/api/spotify/volume';
            opts.method = 'PUT';
            body = { volume_percent: action.payload?.volume_percent };
            break;
          case 'device':
            url = '/api/spotify/device';
            opts.method = 'PUT';
            body = { device_ids: action.payload?.device_ids, play: action.payload?.play };
            break;
          case 'play_track':
            url = '/api/spotify/play-track';
            opts.method = 'POST';
            body = { uri: action.payload?.uri, device_id: action.payload?.device_id };
            break;
          default:
            console.log('ℹ️ Action non supportée par perform_playback_control:', action.type);
            socket.emit('perform_playback_result', { success: false, reason: 'unsupported_action', action: action.type, requestedBy: data.requestedBy });
            return;
        }

        if (body) opts.body = JSON.stringify(body);

        // Execute the API request; using relative path ensures cookies/session are sent
        const res = await fetch(url, opts);

        if (!res.ok) {
          const text = await res.text();
          console.error('❌ perform_playback_control failed:', text);
          socket.emit('perform_playback_result', { success: false, reason: text, action: action.type, requestedBy: data.requestedBy });
          return;
        }

        // Notify server and trigger a sync so all clients get updated playback state
        socket.emit('perform_playback_result', { success: true, action: action.type, requestedBy: data.requestedBy });
        socket.emit('request_sync');
        addSystemMessage(`✅ Action ${action.type} effectuée pour ${data.requestedBy}`, 'success');
      } catch (err) {
        console.error('❌ Erreur perform_playback_control:', err);
        socket.emit('perform_playback_result', { success: false, reason: err.message, requestedBy: data.requestedBy });
        addSystemMessage(`❌ Échec action pour ${data.requestedBy}: ${err.message}`, 'warning');
      }
    });

    // Événements de chat
    socket.on('chat_message_received', (message) => {
      console.log('💬 Message reçu du serveur:', message);
      setMessages(prev => [...prev, { ...message, type: 'user' }]);
    });

    // Événements de recherche partagée
    socket.on('search_results_shared', (data) => {
      addSystemMessage(`${data.sharedBy} a partagé une recherche: "${data.query}"`, 'info');
    });

    // Déconnexion forcée par le serveur
    socket.on('force_disconnect', (data) => {
      console.log('🚫 Déconnexion forcée:', data);
      addSystemMessage(data.message || 'Déconnecté par le serveur', 'warning');
      
      // Empêcher les reconnexions automatiques pendant un moment
      setConnectionStatus('force_disconnected');
      
      // Optionnel : rediriger vers la page de login après un délai
      setTimeout(() => {
        // Ne recharger que si toujours en état de déconnexion forcée
        if (connectionStatus === 'force_disconnected') {
          window.location.reload();
        }
      }, 5000);
    });

    // Synchronisation complète
    socket.on('full_sync', (data) => {
      if (process.env.NODE_ENV !== 'production') {
        try {
          console.log('socket: full_sync', data);
          console.log('socket: full_sync (detail):', JSON.stringify({
            playback_current: data?.playbackState?.currentTrack?.name || null,
            playback_pos: data?.playbackState?.position,
            playback_playing: data?.playbackState?.isPlaying,
            party_current: data?.partyState?.currentTrack?.name || null,
            party_pos: data?.partyState?.position,
            party_playing: data?.partyState?.isPlaying,
            party_queue_len: data?.partyState?.queue?.length || 0,
            isSyncedWithParty: data?.isSyncedWithParty
          }));
        } catch (e) { console.log('socket: full_sync (raw):', data); }
      }
      setPlaybackState(data.playbackState);
      setPartyState(data.partyState);
      setConnectedUsers(data.connectedUsers);
      // Only update isSyncedWithParty if server explicitly provides the flag
      if (typeof data.isSyncedWithParty !== 'undefined') {
        setIsSyncedWithParty(!!data.isSyncedWithParty);
      }
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('reconnect');
      socket.off('user_list_updated');
      socket.off('user_joined');
      socket.off('user_left');
      socket.off('playback_state_updated');
      socket.off('party_state_updated');
      socket.off('playback_control_received');
      socket.off('queue_updated');
      socket.off('queue_message');
      socket.off('play_track_from_queue');
      socket.off('chat_message_received');
      socket.off('search_results_shared');
      socket.off('perform_playback_control');
      socket.off('force_disconnect');
      socket.off('full_sync');
    };
  }, [socket, authenticated, user, isSyncedWithParty, partyState, playbackState, connectionStatus]);

  // Effet séparé pour gérer les changements d'authentification
  useEffect(() => {
    console.log('🔐 Changement d\'état d\'authentification:', { authenticated, user: user?.display_name });
    
    // Ne pas se reconnecter si on vient d'être déconnecté de force
    if (connectionStatus === 'force_disconnected') {
      console.log('🚫 Éviter la reconnexion après déconnexion forcée');
      return;
    }
    
    if (authenticated && user && socket && socket.connected) {
      console.log('🔄 Re-enregistrement utilisateur après changement d\'auth');
      
      // Vérifier si l'utilisateur n'est pas déjà connecté pour éviter les doublons
      let isAlreadyConnected = false;
      if (connectedUsers && connectedUsers.length > 0) {
        isAlreadyConnected = connectedUsers.some(u => u.spotifyId === user.id);
      }
      
      if (!isAlreadyConnected) {
        // Délai pour éviter les connexions multiples rapides
        setTimeout(() => {
          if (socket.connected && connectionStatus !== 'force_disconnected') {
              socket.emit('user_connected', {
                name: user.display_name,
                spotifyId: user.id,
                avatar: user.images?.[0]?.url || null,
                premium: user.product === 'premium',
                sessionId: user.sessionId || null
              });
            }
        }, 500);
      } else {
        console.log('⚠️ Utilisateur déjà connecté, éviter la double connexion');
      }
    }
  }, [authenticated, user, socket, connectionStatus, connectedUsers]);

  const addSystemMessage = (message, type = 'info') => {
    setMessages(prev => [...prev, {
      id: Date.now(),
      message,
      type: 'system',
      systemType: type,
      timestamp: new Date()
    }]);
  };

  const getActionText = (action) => {
    switch (action) {
      case 'play': return 'lancé la lecture';
      case 'pause': return 'mis en pause';
      case 'next': return 'passé à la chanson suivante';
      case 'previous': return 'reculé à la chanson précédente';
      default: return `effectué l'action: ${action}`;
    }
  };

  // Fonctions utilitaires pour émettre des événements
  const emitPlaybackControl = (action) => {
    if (socket && authenticated) {
      socket.emit('playback_control', { type: action });
    }
  };

  const emitPlaybackStateChange = (newState) => {
    if (socket && authenticated) {
      socket.emit('playback_state_changed', newState);
    }
  };

  const emitTrackQueued = (trackData) => {
    if (socket && authenticated) {
      socket.emit('track_queued', trackData);
    }
  };

  const emitTrackRemovedFromQueue = (trackId) => {
    if (socket && authenticated) {
      socket.emit('track_removed_from_queue', trackId);
    }
  };

  const emitChatMessage = (message) => {
    console.log('📤 Début emitChatMessage:', message);
    console.log('📤 État:', { socket: !!socket, authenticated, connected: socket?.connected });
    
    if (socket && authenticated) {
      console.log('📤 Émission message chat vers le serveur:', message);
      socket.emit('chat_message', { message });
      console.log('✅ Message émis avec succès');
    } else {
      console.log('❌ Impossible d\'émettre le message:', { 
        socket: !!socket, 
        authenticated,
        connected: socket?.connected 
      });
    }
  };

  const emitSearchShared = (searchData) => {
    if (socket && authenticated) {
      socket.emit('search_shared', searchData);
    }
  };

  const requestSync = () => {
    if (socket && authenticated) {
      socket.emit('request_sync');
    }
  };

  const emitPlayNextFromQueue = () => {
    if (socket && authenticated) {
      try {
        console.log('🎵 Demande de lecture automatique de la prochaine chanson (emitPlayNextFromQueue)');
        // Add debug info about party state to help trace why server may ignore
        try { console.log('emitPlayNextFromQueue debug:', {
          partyPos: partyState?.position,
          partyCurrent: partyState?.currentTrack?.name,
          partyQueueLen: Array.isArray(partyState?.queue) ? partyState.queue.length : undefined
        }); } catch (e) {}
        socket.emit('play_next_from_queue');
      } catch (err) {
        console.warn('Erreur emitPlayNextFromQueue:', err);
      }
    }
  };

  const togglePartySync = (isSynced) => {
    if (socket && authenticated) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`socket.emit toggle_party_sync -> ${isSynced ? 'Party' : 'Solo'}`);
        // Print a stack trace to help identify accidental callers (dev only)
        try { console.trace('togglePartySync called from:'); } catch (e) {}
      }
      socket.emit('toggle_party_sync', { isSynced });
      setIsSyncedWithParty(isSynced);
    }
  };

  const value = {
    socket,
    connectedUsers,
    playbackState,
    partyState,
    isSyncedWithParty,
    messages,
    connectionStatus,
    serverRateLimitedMs,
    emitPlaybackControl,
    emitPlaybackStateChange,
    emitTrackQueued,
    emitTrackRemovedFromQueue,
    emitChatMessage,
    emitSearchShared,
    requestSync,
    emitPlayNextFromQueue,
    togglePartySync,
    addSystemMessage
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};