import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  IconButton,
  Slider,
  Grid,
  CircularProgress,
  Alert,
  Menu,
  MenuItem,
  Chip
} from '@mui/material';
import {
  PlayArrow,
  Pause,
  SkipNext,
  SkipPrevious,
  VolumeUp,
  Devices,
  Refresh
} from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

const PlayerControls = () => {
  const { API_BASE_URL, refreshToken, user } = useAuth();
  const { 
    playbackState,
    partyState,
    isSyncedWithParty,
    emitPlaybackControl, 
    emitPlaybackStateChange,
    emitPlayNextFromQueue,
    emitTrackRemovedFromQueue,
    serverRateLimitedMs
  } = useSocket();

  // Utiliser l'état approprié selon le mode
  // Guard: partyState or playbackState may be undefined while the socket initializes.
  // Default to an empty object so property reads (e.g. currentTrack) won't throw.
  const activeState = isSyncedWithParty ? (partyState || {}) : (playbackState || {});

  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(50);
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState(null);
  const [deviceMenuAnchor, setDeviceMenuAnchor] = useState(null);
  const [rateLimited, setRateLimited] = useState(false);

  // Récupérer l'état de lecture depuis Spotify API (logique originale)
  const fetchPlaybackState = useCallback(async () => {
    if (!API_BASE_URL || !refreshToken || rateLimited) return;
    // If we're in Party mode, only the designated fetcher client should call Spotify.
    try {
      const amIFetcher = activeState?.fetcher && (activeState.fetcher.spotifyId === user?.id || activeState.fetcher.name === user?.display_name);
      if (isSyncedWithParty && !amIFetcher) return;
    } catch (e) {
      // ignore and continue if we can't determine fetcher yet
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/spotify/playback-state`, {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data.item) {
          setCurrentTrack(data.item);
          setIsPlaying(data.is_playing);
          setPosition(data.progress_ms || 0);
          setDuration(data.item?.duration_ms || 0);
          // Align estimator baseline immediately after fetching to avoid drift
          try {
            basePositionRef.current = data.progress_ms || 0;
            lastPlaybackUpdateRef.current = Date.now();
          } catch (e) {
            // ignore if refs unavailable during initialization
          }
          setVolume(data.device?.volume_percent || 50);
          
          // Émettre l'état vers les autres clients
          emitPlaybackStateChange({
            currentTrack: data.item,
            isPlaying: data.is_playing,
            position: data.progress_ms || 0,
            fetcher: null
          });
        } else {
          // Aucune musique en cours
          setCurrentTrack(null);
          setIsPlaying(false);
          setPosition(0);
          setDuration(0);
        }
      } else if (response.status === 429) {
        console.log('⚠️ Rate limited, pausage temporaire...');
        setRateLimited(true);
        setTimeout(() => setRateLimited(false), 10000);
      }
    } catch (error) {
      console.error('Erreur lors de la récupération de l\'état de lecture:', error);
      setError('Erreur de connexion Spotify');
    }
  }, [API_BASE_URL, refreshToken, emitPlaybackStateChange, rateLimited]);

  // When entering Party mode, clear pending timers/estimators to avoid
  // briefly showing local playback info before party state arrives.
  useEffect(() => {
    if (isSyncedWithParty) {
      // clear any scheduled API call
      if (scheduledRef.current) {
        clearTimeout(scheduledRef.current);
        scheduledRef.current = null;
      }
      // clear estimator interval
      if (estimateIntervalRef.current) {
        clearInterval(estimateIntervalRef.current);
        estimateIntervalRef.current = null;
      }
      // also reset baseline refs
      basePositionRef.current = 0;
      lastPlaybackUpdateRef.current = Date.now();
    }
  }, [isSyncedWithParty]);

  // When entering Party mode, clear local displayed track immediately to avoid
  // briefly showing the user's local playback before the party state arrives.
  useEffect(() => {
    if (isSyncedWithParty) {
      setCurrentTrack(null);
      setIsPlaying(false);
      setPosition(0);
    }
  }, [isSyncedWithParty]);

  // Récupérer les appareils disponibles
  const fetchDevices = useCallback(async () => {
    if (!API_BASE_URL || !refreshToken || rateLimited) return;

    try {
      const response = await fetch(`${API_BASE_URL}/api/spotify/devices`, {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        setDevices(data.devices || []);
      }
    } catch (error) {
      console.error('Erreur lors de la récupération des appareils:', error);
    }
  }, [API_BASE_URL, refreshToken, rateLimited]);

  // Throttle combiné pour playback + devices: au moins 1000ms entre deux séries d'appels
  const lastApiCallRef = useRef(0);
  const scheduledRef = useRef(null);
  const lastAutoPlayRequestRef = useRef(0);
  const basePositionRef = useRef(position);
  const lastPlaybackUpdateRef = useRef(Date.now());
  const estimateIntervalRef = useRef(null);

  const performThrottledFetch = useCallback(() => {
    if (!API_BASE_URL || !refreshToken || rateLimited) return;
    // respect server-side rate limiting
    if (serverRateLimitedMs && serverRateLimitedMs > 0) return;

    const now = Date.now();
    const elapsed = now - (lastApiCallRef.current || 0);
    const execute = async () => {
      lastApiCallRef.current = Date.now();
      try {
        // run both in parallel but treat them as one "API interaction"
        await Promise.all([fetchPlaybackState(), fetchDevices()]);
      } catch (e) {
        // ignore individual errors here (they're handled in each fn)
      }
    };

    if (elapsed >= 1000) {
      // enough time passed
      execute();
    } else {
      // schedule the next permitted call if none scheduled
      if (scheduledRef.current) return;
      scheduledRef.current = setTimeout(() => {
        scheduledRef.current = null;
        execute();
      }, 1000 - elapsed);
    }
  }, [API_BASE_URL, refreshToken, rateLimited, serverRateLimitedMs, fetchPlaybackState, fetchDevices]);

  // Polling régulier de l'état Spotify
  useEffect(() => {
    const amIFetcher = activeState?.fetcher && (activeState.fetcher.spotifyId === user?.id || activeState.fetcher.name === user?.display_name);
    const noFetcher = !activeState?.fetcher;
    // When synced with a party, only the fetcher should poll Spotify directly.
    let canFetch;
    if (isSyncedWithParty) {
      canFetch = !!amIFetcher;
    } else {
      canFetch = amIFetcher || (noFetcher && user?.product === 'premium');
    }

    if (!canFetch) {
      // If we're not allowed to fetch, rely on socket updates only
      return;
    }

    // respect server-side rate limiting
    if (serverRateLimitedMs && serverRateLimitedMs > 0) return;

    // initial immediate call and then polling every 1s using the throttled performer
    performThrottledFetch();
    const interval = setInterval(() => {
      performThrottledFetch();
    }, 1000);

    return () => {
      clearInterval(interval);
      if (scheduledRef.current) {
        clearTimeout(scheduledRef.current);
        scheduledRef.current = null;
      }
    };
  }, [fetchPlaybackState, fetchDevices, rateLimited, activeState, user, performThrottledFetch, serverRateLimitedMs]);

  // Synchroniser avec les événements socket.
  // En mode Party, n'afficher une piste actuelle que si elle provient de la file d'attente partagée.
  useEffect(() => {
    if (isSyncedWithParty) {
      const partyTrack = partyState?.currentTrack;
      const inQueue = partyState?.queue && Array.isArray(partyState.queue) && partyState.queue.some(t => t.id === partyTrack?.id);
      if (partyTrack && inQueue) {
        setCurrentTrack(partyTrack);
        setIsPlaying(partyState.isPlaying);
        setPosition(partyState.position || 0);
      } else {
        // No queue-originating track is playing — clear local display
        setCurrentTrack(null);
        setIsPlaying(false);
        setPosition(0);
      }
    } else {
      // Solo mode: display local playback state as usual
      if (playbackState?.currentTrack) {
        setCurrentTrack(playbackState.currentTrack);
        setIsPlaying(playbackState.isPlaying);
        setPosition(playbackState.position || 0);
      }
    }
  }, [isSyncedWithParty, partyState, playbackState]);

  // When returning from Party mode to Solo, refresh playback state from the API
  // to correct any position drift that occurred while synced to the party.
  useEffect(() => {
    if (!isSyncedWithParty) {
      // We're now in Solo mode — refresh local playback info
      try {
        fetchPlaybackState();
      } catch (err) {
        console.warn('Erreur en récupérant l\'état après sortie du mode Party:', err);
      }
    }
  }, [isSyncedWithParty, fetchPlaybackState]);

  // Estimate current position using the last known playbackState position + elapsed time
  useEffect(() => {
    const END_MARGIN_MS = 2500;
    const COOLDOWN_MS = 5000;
    const TICK_MS = 500;

    // Clean previous interval
    if (estimateIntervalRef.current) {
      clearInterval(estimateIntervalRef.current);
      estimateIntervalRef.current = null;
    }

    // When playbackState updates, capture its baseline position and timestamp
    // Only take baseline playback position from server when this client is allowed
    // to see full playback info (fetcher) or when there is no fetcher and the user is premium.
    const amIFetcher = activeState?.fetcher && (activeState.fetcher.spotifyId === user?.id || activeState.fetcher.name === user?.display_name);
    const noFetcher = !activeState?.fetcher;
    const canUsePlaybackState = amIFetcher || (noFetcher && user?.product === 'premium');

    if (canUsePlaybackState && activeState && activeState.position !== undefined) {
      basePositionRef.current = activeState.position || 0;
      lastPlaybackUpdateRef.current = Date.now();
    }

    // Only run estimator when playback is active and we have a current track
    if (!isPlaying || !currentTrack || duration <= 0) {
      return;
    }

    estimateIntervalRef.current = setInterval(() => {
      try {
        const now = Date.now();
        const elapsed = Math.max(0, now - (lastPlaybackUpdateRef.current || now));
        const estimated = Math.min(duration, (basePositionRef.current || 0) + elapsed);
        setPosition(estimated);

        // If there is a queue, trigger next when within margin (with cooldown)
        if (activeState && activeState.queue && activeState.queue.length > 0) {
          if (now - (lastAutoPlayRequestRef.current || 0) >= COOLDOWN_MS) {
            if (estimated >= (duration - END_MARGIN_MS)) {
              emitPlayNextFromQueue();
              lastAutoPlayRequestRef.current = now;
            }
          }
        }
      } catch (err) {
        console.warn('Erreur estimation position:', err);
      }
    }, TICK_MS);

    return () => {
      if (estimateIntervalRef.current) {
        clearInterval(estimateIntervalRef.current);
        estimateIntervalRef.current = null;
      }
    };
  }, [isPlaying, currentTrack, duration, playbackState, emitPlayNextFromQueue]);

  // Écouter l'événement CustomEvent 'autoPlayTrackFromQueue' dispatché par SocketContext
  useEffect(() => {
    if (!API_BASE_URL) return;

    const handler = async (e) => {
      try {
        const { track, requestedBy } = e.detail || {};
        if (!track) return;

        console.log('🎵 autoPlayTrackFromQueue reçu pour:', track.name, 'demandé par', requestedBy);

        // Gate: only the fetcher or a premium user should attempt to call Spotify API directly
        const amIFetcher = activeState?.fetcher && (activeState.fetcher.spotifyId === user?.id || activeState.fetcher.name === user?.display_name);
        const canAttemptPlay = amIFetcher || user?.product === 'premium';

        if (!canAttemptPlay) {
          // Not authorized to perform the play; just refresh state later to reflect server-side actions
          console.log('ℹ️ Pas autorisé à jouer localement, demande au serveur de jouer. Rafraîchissement d\'état prévu.');
          setTimeout(fetchPlaybackState, 1000);
          return;
        }

        // Attempt to play the requested track via server API (will use cookies/session)
        const resp = await fetch(`${API_BASE_URL}/api/spotify/play-track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ uri: track.uri })
        });

        if (resp.ok) {
          console.log('✅ Lecture locale déclenchée pour la track de la queue:', track.name);
          // Ask server to remove the track from the queue
          if (emitTrackRemovedFromQueue && track.id) {
            emitTrackRemovedFromQueue(track.id);
          }
          // Refresh playback state shortly after
          setTimeout(fetchPlaybackState, 1000);
        } else {
          const txt = await resp.text();
          console.warn('⚠️ play-track failed for autoPlayTrackFromQueue:', txt);
          // fallback: refresh
          setTimeout(fetchPlaybackState, 1000);
        }
      } catch (err) {
        console.error('Erreur handling autoPlayTrackFromQueue:', err);
        setTimeout(fetchPlaybackState, 1000);
      }
    };

    window.addEventListener('autoPlayTrackFromQueue', handler);
    return () => window.removeEventListener('autoPlayTrackFromQueue', handler);
  }, [API_BASE_URL, fetchPlaybackState, playbackState, user, emitTrackRemovedFromQueue]);

  const handlePlayPause = async () => {
    if (serverRateLimitedMs && serverRateLimitedMs > 0) return;
    try {
      const action = isPlaying ? 'pause' : 'play';
      const response = await fetch(`${API_BASE_URL}/api/spotify/${action}`, {
        method: 'PUT',
        credentials: 'include'
      });
      
      if (response.ok) {
        emitPlaybackControl(action);
        setIsPlaying(!isPlaying);
      }
    } catch (error) {
      console.error('Erreur lors du contrôle de lecture:', error);
      setError('Erreur lors du contrôle de lecture');
    }
  };

  const handleNext = async () => {
    if (serverRateLimitedMs && serverRateLimitedMs > 0) return;
    try {
      // Delegate the 'next' action to the server so it can coordinate queue vs Spotify
      emitPlaybackControl('next');
      // Refresh local state shortly after
      setTimeout(fetchPlaybackState, 500);
    } catch (error) {
      console.error('Erreur lors du passage au titre suivant:', error);
    }
  };

  const handlePrevious = async () => {
    if (serverRateLimitedMs && serverRateLimitedMs > 0) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/spotify/previous`, {
        method: 'POST',
        credentials: 'include'
      });
      
      if (response.ok) {
        emitPlaybackControl('previous');
        setTimeout(fetchPlaybackState, 500);
      }
    } catch (error) {
      console.error('Erreur lors du retour au titre précédent:', error);
    }
  };

  const handlePositionChange = (event, newValue) => {
    setPosition(newValue);
  };

  const handlePositionChangeCommitted = async (event, newValue) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/spotify/seek`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ position_ms: newValue })
      });
      
      if (response.ok) {
        setPosition(newValue);
        emitPlaybackStateChange({ position: newValue });
      }
    } catch (error) {
      console.error('Erreur lors du changement de position:', error);
    }
  };

  const handleVolumeChange = (event, newValue) => {
    setVolume(newValue);
  };

  const handleVolumeChangeCommitted = async (event, newValue) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/spotify/volume`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ volume_percent: newValue })
      });
      
      if (response.ok) {
        setVolume(newValue);
      }
    } catch (error) {
      console.error('Erreur lors du changement de volume:', error);
    }
  };

  const handleDeviceChange = async (deviceId) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/spotify/device`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          device_ids: [deviceId],
          play: isPlaying
        })
      });
      
      if (response.ok) {
        await fetchDevices();
        setDeviceMenuAnchor(null);
      }
    } catch (error) {
      console.error('Erreur lors du changement d\'appareil:', error);
    }
  };

  const formatTime = (ms) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const getDeviceIcon = (deviceType) => {
    switch (deviceType?.toLowerCase()) {
      case 'computer': return '💻';
      case 'smartphone': return '📱';
      case 'speaker': return '🔊';
      default: return '🎵';
    }
  };

  if (error) {
    return (
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Alert 
            severity="error" 
            action={
              <IconButton onClick={() => setError(null)} size="small">
                <Refresh />
              </IconButton>
            }
          >
            {error}
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        {currentTrack ? (
          <>
            <Grid container spacing={2} alignItems="center">
              {/* Track Info */}
              <Grid item xs={12} md={4}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  {currentTrack.album?.images?.[0] && (
                    <Box
                      component="img"
                      src={currentTrack.album.images[0].url}
                      alt={currentTrack.name}
                      sx={{
                        width: 60,
                        height: 60,
                        borderRadius: 1,
                        mr: 2,
                        flexShrink: 0
                      }}
                    />
                  )}
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                      <Typography 
                        variant="subtitle1" 
                        noWrap
                        sx={{ fontWeight: 'bold', flex: 1 }}
                      >
                        {currentTrack.name}
                      </Typography>
                      {isSyncedWithParty && (
                        <Chip 
                          label="Synchronisée" 
                          size="small" 
                          color="primary" 
                          sx={{ 
                            height: 20,
                            fontSize: '0.7rem',
                            fontWeight: 'bold'
                          }}
                        />
                      )}
                    </Box>
                    <Typography 
                      variant="body2" 
                      color="text.secondary" 
                      noWrap
                    >
                      {(currentTrack.artists && currentTrack.artists.map(artist => artist.name).join(', ')) || ''}
                    </Typography>
                    <Typography 
                      variant="caption" 
                      color="text.secondary" 
                      noWrap
                    >
                      {currentTrack.album?.name}
                    </Typography>
                  </Box>
                </Box>
              </Grid>
            </Grid>

          {/* Play Controls - Outside Grid */}
          <Box sx={{ 
            display: 'flex', 
            justifyContent: 'center', 
            alignItems: 'center',
            gap: 1,
            my: 2
          }}>
            <IconButton 
              onClick={handlePrevious}
              size="large"
              sx={{ color: 'primary.main' }}
            >
              <SkipPrevious />
            </IconButton>
            
            <IconButton 
              onClick={handlePlayPause}
              size="large"
              sx={{ 
                color: 'primary.main',
                '&:hover': { transform: 'scale(1.1)' }
              }}
            >
              {isPlaying ? <Pause /> : <PlayArrow />}
            </IconButton>
            
            <IconButton 
              onClick={handleNext}
              size="large"
              sx={{ color: 'primary.main' }}
            >
              <SkipNext />
            </IconButton>
          </Box>

          {/* Progress Bar + Volume */}
          <Box sx={{ display: 'flex', alignItems: 'center', mt: 1 }}>
            <Typography variant="caption" sx={{ minWidth: 45 }}>
              {formatTime(position)}
            </Typography>
            <Slider
              size="small"
              value={position}
              min={0}
              max={duration || 1}
              onChange={handlePositionChange}
              onChangeCommitted={handlePositionChangeCommitted}
              sx={{ 
                mx: 1,
                '& .MuiSlider-thumb': {
                  '&:hover, &.Mui-focusVisible': {
                    boxShadow: '0 0 0 8px rgba(29, 185, 84, 0.16)'
                  }
                }
              }}
            />
            <Typography variant="caption" sx={{ minWidth: 45 }}>
              {formatTime(duration)}
            </Typography>
            
            {/* Volume & Devices */}
            <VolumeUp sx={{ color: 'text.secondary', ml: 2 }} />
            <Slider
              size="small"
              value={volume}
              min={0}
              max={100}
              onChange={handleVolumeChange}
              onChangeCommitted={handleVolumeChangeCommitted}
              sx={{ 
                width: 100,
                mx: 1,
                '& .MuiSlider-thumb': {
                  '&:hover, &.Mui-focusVisible': {
                    boxShadow: '0 0 0 8px rgba(29, 185, 84, 0.16)'
                  }
                }
              }}
            />
            
            <IconButton 
              onClick={(e) => setDeviceMenuAnchor(e.currentTarget)}
              size="small"
              sx={{ color: 'text.secondary' }}
            >
              <Devices />
            </IconButton>

            <Menu
              anchorEl={deviceMenuAnchor}
              open={Boolean(deviceMenuAnchor)}
              onClose={() => setDeviceMenuAnchor(null)}
            >
              {devices.map(device => (
                <MenuItem 
                  key={device.id}
                  onClick={() => handleDeviceChange(device.id)}
                  selected={device.is_active}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <span>{getDeviceIcon(device.type)}</span>
                    <Box>
                      <Typography variant="body2">
                        {device.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {device.type} - {device.volume_percent}%
                      </Typography>
                    </Box>
                    {device.is_active && (
                      <Chip 
                        label="Actif" 
                        size="small" 
                        color="primary" 
                        sx={{ ml: 1 }}
                      />
                    )}
                  </Box>
                </MenuItem>
              ))}
            </Menu>
          </Box>
          </>
        ) : (
          <Box sx={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            py: 4
          }}>
            {rateLimited ? (
              <>
                <CircularProgress sx={{ mb: 2 }} />
                <Typography color="text.secondary">
                  Limitation API atteinte, veuillez patienter...
                </Typography>
              </>
            ) : (
              <>
                <Typography variant="h6" color="text.secondary" sx={{ mb: 1 }}>
                  🎵 Aucune musique en cours
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Lancez la lecture depuis Spotify ou ajoutez une chanson à la file d'attente
                </Typography>
              </>
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  );
};

export default PlayerControls;