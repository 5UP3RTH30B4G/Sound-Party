import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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

const debugLog = false; // Enable or disable debug logging

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
    serverRateLimitedMs,
    // requestSync is consumed in some async flows; keep it in the destructure to keep API parity.
    // If ESLint complains about unused variable in some builds, the explicit reference below
    // (void requestSync) ensures it's treated as used without changing behavior.
    requestSync
  } = useSocket();
  // make a no-op reference so linters recognize requestSync as used when it's only called conditionally
  try { void requestSync; } catch (e) {}

  // Utiliser l'état approprié selon le mode
  // Guard: partyState or playbackState may be undefined while the socket initializes.
  // Wrap in useMemo so identity is stable and won't trigger unrelated effect re-runs.
  const activeState = useMemo(() => {
    return isSyncedWithParty ? (partyState || {}) : (playbackState || {});
  }, [isSyncedWithParty, partyState, playbackState]);

  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [baselineReady, setBaselineReady] = useState(false);
  const [volume, setVolume] = useState(50);
  const [devices, setDevices] = useState([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [error, setError] = useState(null);
  const [deviceMenuAnchor, setDeviceMenuAnchor] = useState(null);
  const [rateLimited, setRateLimited] = useState(false);

  // Récupérer l'état de lecture depuis Spotify API (logique originale)
  const fetchPlaybackState = useCallback(async () => {
    if (!API_BASE_URL || !refreshToken || rateLimited) return;
    // Prevent any solo fetch actions if we've become party-synced; use ref to avoid stale closures
    if (isSyncedRef.current) return;
    // Polling rules: do not poll while synced with a party; only premium users
    // may poll in Solo mode (non-premium users are restricted to Party mode).
    if (user?.product !== 'premium') return;

    try {
      const response = await fetch(`${API_BASE_URL}/api/spotify/playback-state`, {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
          if (data && data.item) {
            if (isSyncedRef.current) return; // avoid overwriting party UI with solo data
          setCurrentTrack(data.item);
          setIsPlaying(data.is_playing);
          setPosition(data.progress_ms || 0);
          setDuration(data.item?.duration_ms || 0);
          // Align estimator baseline immediately after fetching to avoid drift
          try {
            basePositionRef.current = data.progress_ms || 0;
            lastPlaybackUpdateRef.current = Date.now();
            // Visible log: baseline aligned after fetch
            if (debugLog) {
              console.log('estimator baseline aligned from fetchPlaybackState', {
                basePosition: basePositionRef.current,
                lastPlaybackUpdate: lastPlaybackUpdateRef.current
              });
            }
            // mark estimator baseline as ready so the estimator effect can start
            try { setBaselineReady(true); } catch (e) {}
            // Immediate check using fetched progress (server-driven via API)
            try {
              const now = Date.now();
              const pos = data.progress_ms || 0;
              const queueLength = activeState?.queue?.length || 0;
              const threshold = Math.max(0, duration - END_MARGIN_MS);
              const cooldownPassed = (now - (lastAutoPlayRequestRef.current || 0)) >= COOLDOWN_MS;

              if (debugLog) {
                console.log('auto-skip immediate check (from fetch)', { pos, duration, threshold, cooldownPassed, lastAutoPlayRequest: lastAutoPlayRequestRef.current });
              }
              if (cooldownPassed && pos >= threshold) {
                if (isSyncedWithParty) {
                  if (queueLength > 0) {
                    console.info('⏭️ auto-skip (party) immediate check (fetch) — emitting play_next_from_queue', { pos, duration });
                    emitPlayNextFromQueue();
                    lastAutoPlayRequestRef.current = now;
                  } else {
                    console.info('⏭️ auto-skip immediate (fetch) but party queue empty — not emitting', { pos, duration });
                  }
                } else {
                  console.info('⏭️ auto-skip (solo) immediate check (fetch) — emitting playback next', { pos, duration });
                  if (emitPlaybackControl) emitPlaybackControl('next');
                  lastAutoPlayRequestRef.current = now;
                }
              }
            } catch (e) { console.warn('auto-skip immediate check (fetch) failed:', e); }
          } catch (e) {
            // ignore if refs unavailable during initialization
          }
          // If Spotify reports a device volume of 0 we must respect it.
          // Use an explicit check for number to avoid `0` being treated as falsy.
          if (!isSyncedRef.current) {
            if (data.device && typeof data.device.volume_percent === 'number') {
              setVolume(data.device.volume_percent);
            } else {
              setVolume(50);
            }
          }
          
          // Émettre l'état vers les autres clients
          emitPlaybackStateChange({
            currentTrack: data.item,
            isPlaying: data.is_playing,
            position: data.progress_ms || 0
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
  }, [API_BASE_URL, refreshToken, emitPlaybackStateChange, rateLimited, isSyncedWithParty, user?.product, emitPlayNextFromQueue, emitPlaybackControl, duration, activeState]);

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
      // baseline is cleared when entering party mode (will be set again from partyState)
      try { setBaselineReady(false); } catch (e) {}
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
  const fetchDevices = useCallback(async (opts = { force: false }) => {
    // Only attempt to fetch devices when this client is allowed to poll Spotify.
    // We do not poll in Party mode. In Solo mode only premium users may poll.
    if (!API_BASE_URL || !refreshToken || rateLimited) return;
    const canFetch = !isSyncedWithParty && user?.product === 'premium';
    if (!canFetch) return;

    const DEBOUNCE_MS = 5000; // avoid re-fetching devices too often
    const now = Date.now();

    // If a fetch is already in-flight, return the same promise so callers coalesce.
    if (!opts.force && devicesInFlightRef.current) {
      return devicesInFlightRef.current;
    }

    // If last fetch was recent and caller didn't force, skip
    if (!opts.force && (now - (lastDevicesFetchRef.current || 0)) < DEBOUNCE_MS) {
      return; // recent result still valid
    }

    // Start a new fetch and store the promise in ref so concurrent callers reuse it
    const promise = (async () => {
      try { setDevicesLoading(true); } catch (e) {}
      try {
        const response = await fetch(`${API_BASE_URL}/api/spotify/devices`, {
          credentials: 'include'
        });

        if (response.ok) {
          const data = await response.json();
          const list = data.devices || [];
          // Only update devices/volume when not party-synced (avoid overwriting party UI)
          if (!isSyncedRef.current) {
            setDevices(list);
            // If a device is active, and provides a numeric volume, use it.
            const active = list.find(d => d.is_active);
            if (active && typeof active.volume_percent === 'number') {
              setVolume(active.volume_percent);
            }
          }
        }
        // record timestamp even on non-ok to avoid tight retry loops
        lastDevicesFetchRef.current = Date.now();
      } catch (error) {
        console.error('Erreur lors de la récupération des appareils:', error);
        lastDevicesFetchRef.current = Date.now();
      } finally {
        try { setDevicesLoading(false); } catch (e) {}
      }
    })();

    devicesInFlightRef.current = promise;
    // ensure we clear the in-flight ref when done
    promise.finally(() => { devicesInFlightRef.current = null; });
    return promise;
  }, [API_BASE_URL, refreshToken, rateLimited, user?.product, isSyncedWithParty]);

  // When the authenticated user changes (e.g. multiple logins), ensure we refresh
  // playback state and devices so the UI (volume, active device) reflects the
  // currently logged-in user rather than stale data from a previous session.
  useEffect(() => {
    if (!user) return;
    // Do not poll or fetch devices when following a party — party state is authoritative
    if (isSyncedWithParty) return;
    // Only premium users may query devices / control playback locally
    if (user?.product !== 'premium') return;

    // Fetch the playback state and devices for the current user
    try {
      fetchPlaybackState();
    } catch (e) {}
    try {
      fetchDevices();
    } catch (e) {}
  }, [user, user?.id, user?.product, isSyncedWithParty, fetchPlaybackState, fetchDevices]);

  // Throttle combiné pour playback + devices: au moins 1000ms entre deux séries d'appels
  const lastApiCallRef = useRef(0);
  const scheduledRef = useRef(null);
  // Keep a ref of the latest party-sync state to avoid stale closures updating
  // local (solo) playback state after we've joined a party.
  const isSyncedRef = useRef(isSyncedWithParty);
  useEffect(() => {
    isSyncedRef.current = isSyncedWithParty;
  }, [isSyncedWithParty]);
  // Coalescing/debounce for devices fetch
  const lastDevicesFetchRef = useRef(0);
  const devicesInFlightRef = useRef(null);
  const lastAutoPlayRequestRef = useRef(0);
  const basePositionRef = useRef(position);
  const lastPlaybackUpdateRef = useRef(Date.now());
  const estimateIntervalRef = useRef(null);
  // const lastAutoPlayedTrackRef = useRef(null); // unused - kept commented for future use
  // Auto-skip tuning
  const END_MARGIN_MS = 1000; // 1 second
  const COOLDOWN_MS = 2000; // avoid double-emits in quick succession
  const TICK_MS = 250; // check more frequently for accuracy

  const performThrottledFetch = useCallback(() => {
    if (!API_BASE_URL || !refreshToken || rateLimited) return;
    // respect server-side rate limiting
    if (serverRateLimitedMs && serverRateLimitedMs > 0) return;

    const now = Date.now();
    const elapsed = now - (lastApiCallRef.current || 0);
    const execute = async () => {
      lastApiCallRef.current = Date.now();
      try {
        // Only fetch playback state periodically. Devices are fetched on-demand
        // when the user opens the devices menu to avoid unnecessary polling.
        await fetchPlaybackState();
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
  }, [API_BASE_URL, refreshToken, rateLimited, serverRateLimitedMs, fetchPlaybackState]);

  // Appel Périodique Playback + Devices
  useEffect(() => {
    // When synced with a party, do not poll; in Solo mode only premium users poll.
    const canFetch = !isSyncedWithParty && user?.product === 'premium';
    if (!canFetch) return;

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
  }, [fetchPlaybackState, fetchDevices, rateLimited, user, performThrottledFetch, serverRateLimitedMs, isSyncedWithParty]);

  // Synchroniser avec les événements socket.
  // En mode Party, n'afficher une piste actuelle que si elle provient de la file d'attente partagée.
  // Improve party UI stability: partyState updates may transiently omit
  // `currentTrack` during server-side queue removals and re-broadcasts. If we
  // immediately clear the UI when `partyState.currentTrack` is momentarily
  // undefined we'll see a flicker (image disappears then reappears). To avoid
  // that, keep the last seen party track visible until the server explicitly
  // signals playback stopped (isPlaying=false) or a new track arrives.
  const lastSeenPartyTrackRef = useRef(null);

  const fetchTrackDetails = useCallback(async (track) => {
    try {
      if (!track) return null;
      // If we already have images, nothing to do
      if (track.album && track.album.images && track.album.images.length > 0) return track;

      // Extract an ID from possible uri formats
      const uri = track.uri || track.id || '';
      let id = null;
      if (uri.startsWith('spotify:track:')) {
        id = uri.split(':').pop();
      } else {
        // Try URL form
        const m = String(uri).match(/track\/([a-zA-Z0-9]+)/);
        if (m) id = m[1];
      }
      if (!id) return track;

      if (!API_BASE_URL) return track;
      const resp = await fetch(`${API_BASE_URL}/api/spotify/track/${encodeURIComponent(id)}`, { credentials: 'include' });
      if (!resp.ok) return track;
      const data = await resp.json();
      // Merge album/images into existing track object to avoid losing other fields
      return { ...track, album: data.album || track.album, images: data.album?.images || track.images, artists: data.artists || track.artists };
    } catch (e) {
      console.warn('Erreur fetchTrackDetails:', e);
      return track;
    }
  }, [API_BASE_URL]);
  useEffect(() => {
    if (isSyncedWithParty) {
      const partyTrack = partyState?.currentTrack;
      const partyPlaying = !!partyState?.isPlaying;
      const partyPosition = partyState?.position || 0;

      if (partyTrack) {
        // Only enrich track metadata if it's a NEW track (different ID)
        const isNewTrack = lastSeenPartyTrackRef.current?.id !== partyTrack.id;
        
        if (isNewTrack) {
          // Immediately update state for new track to prevent oscillation
          lastSeenPartyTrackRef.current = partyTrack;
          setCurrentTrack(partyTrack);
          setDuration(partyTrack.duration_ms || 0);
          
          // Then enrich metadata asynchronously (album images)
          (async () => {
            const enriched = await fetchTrackDetails(partyTrack);
            if (enriched) {
              lastSeenPartyTrackRef.current = enriched;
              setCurrentTrack(enriched);
            }
          })();
        }
        
        setIsPlaying(partyPlaying);
        // Use server-provided position directly (no local estimation in Party mode)
        setPosition(partyPosition);
      } else {
        // No explicit currentTrack in the update. Only clear when party is
        // not playing — otherwise keep showing the last seen track to avoid flicker.
        if (!partyPlaying) {
          lastSeenPartyTrackRef.current = null;
          setCurrentTrack(null);
          setIsPlaying(false);
          setPosition(0);
        } else {
          // keep last seen track visible and update position if provided
          if (lastSeenPartyTrackRef.current) {
            setCurrentTrack(lastSeenPartyTrackRef.current);
          }
          if (partyState?.position !== undefined) {
            setPosition(partyState.position || 0);
          }
          // keep isPlaying true
          setIsPlaying(true);
        }
      }
    } else {
      // Solo mode: display local playback state as usual
      // Prevent accidentally applying solo playback state if we've become party-synced
      if (!isSyncedRef.current && playbackState?.currentTrack) {
        setCurrentTrack(playbackState.currentTrack);
        setIsPlaying(playbackState.isPlaying);
        setPosition(playbackState.position || 0);
      }
    }
  }, [isSyncedWithParty, partyState, playbackState, fetchTrackDetails]);

  // When returning from Party mode to Solo, refresh playback state from the API
  // to correct any position drift that occurred while synced to the party.
  useEffect(() => {
    if (!isSyncedWithParty) {
      // We're now in Solo mode — refresh local playback info for premium users
      try {
        fetchPlaybackState();
      } catch (err) {
        console.warn('Erreur en récupérant l\'état après sortie du mode Party:', err);
      }
    }
  }, [isSyncedWithParty, fetchPlaybackState]);

  // Estimate current position using the last known playbackState position + elapsed time
  useEffect(() => {

    // Clean previous interval
    if (estimateIntervalRef.current) {
      clearInterval(estimateIntervalRef.current);
      estimateIntervalRef.current = null;
    }

    // In Party mode, the server calculates position and broadcasts it every 500ms.
    // Skip local estimation entirely to avoid cursor oscillation.
    if (isSyncedWithParty) {
      return;
    }

    // Log when effect runs so we can verify it's executing
    try {
      if (debugLog) {
        console.log('estimator effect run', {
          isPlaying,
          currentTrackId: currentTrack?.id,
          duration,
          queueLength: activeState?.queue?.length
        });
      }
    } catch (e) {
      // ignore logging errors
    }

    // When playbackState updates, capture its baseline position and timestamp
  // Only use server-provided baseline when in Solo mode and the user is premium.
  const canUsePlaybackState = !isSyncedWithParty && user?.product === 'premium';

  if (canUsePlaybackState && activeState && activeState.position !== undefined) {
      basePositionRef.current = activeState.position || 0;
      lastPlaybackUpdateRef.current = Date.now();
      try {
        if (debugLog) {
          console.log('estimator baseline aligned from activeState', {
            activeStatePosition: activeState.position,
            basePosition: basePositionRef.current,
            lastPlaybackUpdate: lastPlaybackUpdateRef.current
          });
        }
        try { setBaselineReady(true); } catch (e) {}
          // Immediate check using actual activeState.position (server-driven)
          try {
            const now = Date.now();
            const pos = activeState.position || 0;
            const queueLength = activeState?.queue?.length || 0;
            const threshold = Math.max(0, duration - END_MARGIN_MS);
            const cooldownPassed = (now - (lastAutoPlayRequestRef.current || 0)) >= COOLDOWN_MS;
            if (debugLog) {
              console.log('auto-skip immediate check (from activeState)', { pos, duration, threshold, cooldownPassed, lastAutoPlayRequest: lastAutoPlayRequestRef.current });
            }
            if (cooldownPassed && pos >= threshold) {
              // Only trigger auto-skip if there are tracks in the (shared) queue.
              // This prevents auto-skipping in solo mode when there's no queue.
              if (queueLength > 0) {
                try {
                  console.info('⏭️ auto-skip immediate check — emitting play_next_from_queue', { pos, duration });
                  // set cooldown before emitting to avoid re-entrancy
                  lastAutoPlayRequestRef.current = now;
                  if (emitPlayNextFromQueue) emitPlayNextFromQueue();
                } catch (e) {
                  console.warn('auto-skip emit failed:', e);
                }
              } else {
                console.info('⏭️ auto-skip immediate but queue empty — not emitting', { pos, duration });
              }
            }
          } catch (e) { console.warn('auto-skip immediate check failed:', e); }
      } catch (e) {}
    }

    // Only run estimator when playback is active and we have a current track
    // and we've captured an initial baseline position (from socket or fetch)
    if (!isPlaying || !currentTrack || duration <= 0 || !baselineReady) {
      try {
        if (debugLog) {
          console.log('estimator effect not starting — conditions not met', {
            isPlaying,
            currentTrackId: currentTrack?.id,
            duration,
            baselineReady
          });
        }
      } catch (e) {}
      return;
    }

  estimateIntervalRef.current = setInterval(() => {
      // Tick-level log to confirm the interval is firing and what values are used
      try {
        const debugNow = Date.now();
        console.log('estimator tick', {
          now: debugNow,
          basePosition: basePositionRef.current,
          lastPlaybackUpdate: lastPlaybackUpdateRef.current,
          activeStatePosition: activeState?.position,
          // duration & isPlaying captured from closure
          duration,
          isPlaying
        });
      } catch (e) {}
      try {
        const now = Date.now();
        const elapsed = Math.max(0, now - (lastPlaybackUpdateRef.current || now));
        const estimated = Math.min(duration, (basePositionRef.current || 0) + elapsed);
        setPosition(estimated);
        // Debug: also log formatted current time / total duration for easier reading
        try {
          if (typeof formatTime === 'function') {
            console.log(`Playback time: ${formatTime(estimated)} / ${formatTime(duration)}`);
          }
        } catch (e) {
          // ignore formatting errors
        }

        // Evaluate auto-skip conditions using estimated and margins.
        try {
          const queueLength = activeState?.queue?.length || 0;
          const threshold = Math.max(0, duration - END_MARGIN_MS);
          console.log('estimator:', { estimated, duration, threshold, queueLength, lastAutoPlayRequest: lastAutoPlayRequestRef.current, now });

          const cooldownPassed = (now - (lastAutoPlayRequestRef.current || 0)) >= COOLDOWN_MS;
          const closeToEnd = estimated >= threshold;

          if (cooldownPassed && closeToEnd) {
            if (isSyncedWithParty) {
              // Party mode: only emit play_next_from_queue when the shared queue has items
              if (queueLength > 0) {
                console.info('⏭️ auto-skip (party) threshold reached — emitting play_next_from_queue', { estimated, duration });
                emitPlayNextFromQueue();
                lastAutoPlayRequestRef.current = now;
              } else {
                console.info('⏭️ auto-skip threshold reached but party queue is empty — not emitting', { estimated, duration });
                // no-op for party when no queued tracks
              }
            } else {
              // Solo mode: delegate to the server to advance playback (keeps behavior consistent)
              try {
                console.info('⏭️ auto-skip (solo) threshold reached — emitting playback next', { estimated, duration });
                if (emitPlaybackControl) emitPlaybackControl('next');
                lastAutoPlayRequestRef.current = now;
              } catch (e) {
                console.warn('Failed to emit playback next during auto-skip (solo):', e);
              }
            }
          }
        } catch (e) {
          // don't let logging or minor errors break the estimator
          console.warn('Error evaluating auto-skip conditions:', e);
        }
      } catch (err) {
        console.warn('Erreur estimation position:', err);
      }
    }, TICK_MS);

    // Visible log indicating the estimator interval was started
    try {
      if (debugLog) {
        console.log('estimator interval started', { TICK_MS, END_MARGIN_MS });
      }
      // quick alive-check to detect if something clears the interval immediately after start
      try {
        setTimeout(() => {
          if (debugLog) {
            console.log('estimator alive-check', { intervalExists: !!estimateIntervalRef.current });
          }
        }, 500);
      } catch (e) {}
    } catch (e) {}

    return () => {
      if (debugLog) {
        try {
          console.log('estimator cleanup — clearing interval if present', {
            isPlaying,
            currentTrackId: currentTrack?.id,
            duration,
            baselineReady,
            intervalExists: !!estimateIntervalRef.current
          });
        } catch (e) {}
        if (estimateIntervalRef.current) {
          clearInterval(estimateIntervalRef.current);
          estimateIntervalRef.current = null;
        }
        try { console.log('estimator interval cleared'); } catch (e) {}
      }
    };
  }, [isPlaying, currentTrack, duration, playbackState, partyState, isSyncedWithParty, emitPlayNextFromQueue, baselineReady, emitPlaybackControl, user?.product, activeState]);

  // Écouter l'événement CustomEvent 'autoPlayTrackFromQueue' dispatché par SocketContext
  useEffect(() => {
    if (!API_BASE_URL) return;

    const handler = async (e) => {
      try {
        const { track, requestedBy } = e.detail || {};
        if (!track) return;

        console.log('🎵 autoPlayTrackFromQueue reçu pour:', track.name, 'demandé par', requestedBy);

            // Gate: only premium users should attempt to call Spotify API directly
            const canAttemptPlay = user?.product === 'premium';

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
  }, [API_BASE_URL, fetchPlaybackState, playbackState, user, emitTrackRemovedFromQueue, activeState, emitPlaybackControl, user?.id, user?.display_name, user?.product, isSyncedWithParty]);

  // Party-mode auto-skip: when following a party, periodically check the
  // server-provided position and emit play_next_from_queue when near the end.
  useEffect(() => {
    if (!isSyncedWithParty) return;

    const partyAutoInterval = setInterval(() => {
      try {
        const now = Date.now();
        const pos = (partyState && typeof partyState.position === 'number') ? partyState.position : 0;
        const dur = (partyState && partyState.currentTrack && partyState.currentTrack.duration_ms) ? partyState.currentTrack.duration_ms : duration || 0;
        const queueLength = (partyState && Array.isArray(partyState.queue)) ? partyState.queue.length : 0;
        const threshold = Math.max(0, dur - END_MARGIN_MS);
        const cooldownPassed = (now - (lastAutoPlayRequestRef.current || 0)) >= COOLDOWN_MS;

        if (dur > 0 && queueLength > 0 && cooldownPassed && pos >= threshold) {
          try {
            console.info('⏭️ party auto-skip condition met — emitting play_next_from_queue', { pos, dur, queueLength });
            if (emitPlayNextFromQueue) emitPlayNextFromQueue();
            lastAutoPlayRequestRef.current = now;
          } catch (e) {
            console.warn('Erreur lors de l\'émission play_next_from_queue (party auto-skip):', e);
          }
        }
      } catch (e) {
        // ignore per-interval errors
      }
    }, 500);

    return () => clearInterval(partyAutoInterval);
  }, [isSyncedWithParty, partyState, emitPlayNextFromQueue, duration]);

  const handlePlayPause = async () => {
    if (serverRateLimitedMs && serverRateLimitedMs > 0) return;
    try {
      const action = isPlaying ? 'pause' : 'play';
      // Emit control to server; server is authoritative for party playback and
      // will relay to Spotify for solo/premium users. We optimistically update UI.
      if (emitPlaybackControl) emitPlaybackControl(action);
      setIsPlaying(prev => !prev);
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
      // Delegate previous to the server so it can coordinate party vs solo behavior
      if (emitPlaybackControl) emitPlaybackControl('previous');
      // optimistic fetch sync shortly after
      setTimeout(fetchPlaybackState, 500);
    } catch (error) {
      console.error('Erreur lors du retour au titre précédent:', error);
    }
  };

  const handlePositionChange = (event, newValue) => {
    // Immediate visual feedback during dragging (temporary position)
    setPosition(newValue);
  };

  const handlePositionChangeCommitted = async (event, newValue) => {
    if (process.env.NODE_ENV !== 'production') {
      try {
        console.log('DEBUG: handlePositionChangeCommitted invoked', { newValue, isSyncedWithParty });
      } catch (e) {}
    }
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
        // In Party mode, the server will update partyPlaybackState and broadcast to all clients.
        // Don't set position locally — trust the server's next broadcast.
        if (!isSyncedWithParty) {
          setPosition(newValue);
          // Only emit playback_state_changed in Solo mode
          emitPlaybackStateChange({ position: newValue });
        }
        // In Party mode, the server /seek endpoint calls seekPartyPlayback()
        // and the periodic broadcast will sync all clients automatically.
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
    // Close menu immediately so UI stays responsive
    setDeviceMenuAnchor(null);

    if (!deviceId) {
      console.warn('handleDeviceChange called without deviceId');
      return;
    }

    // Guard: only premium users in Solo may transfer playback locally
    if (user?.product !== 'premium' || isSyncedWithParty) {
      console.warn('Device change ignored: not allowed for non-premium or while synced with party');
      return;
    }

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
        // After a successful transfer, refresh playback state (includes device + volume)
        try { await fetchPlaybackState(); } catch (e) { /* fetchPlaybackState logs errors */ }
        // Re-fetch devices list (force) to refresh active flags and volumes
        try { await fetchDevices({ force: true }); } catch (e) { /* ignore */ }
        // Ask server to synchronize state across connected clients
        try { if (requestSync) requestSync(); } catch (e) {}
      } else {
        const txt = await response.text();
        console.warn('Device transfer failed:', txt);
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
          <Box sx={{ display: 'flex', alignItems: 'center', mt: 1, flexWrap: 'wrap' }}>
            <Typography variant="caption" sx={{ minWidth: 45 }}>
              {formatTime(position)}
            </Typography>
            <Box sx={{ flex: 1, minWidth: 0, mx: 1 }}>
              <Slider
                size="small"
                value={position}
                min={0}
                max={duration || 1}
                onChange={handlePositionChange}
                onChangeCommitted={handlePositionChangeCommitted}
                sx={{
                  width: '100%',
                  '& .MuiSlider-thumb': {
                    '&:hover, &.Mui-focusVisible': {
                      boxShadow: '0 0 0 8px rgba(29, 185, 84, 0.16)'
                    }
                  }
                }}
              />
            </Box>
            <Typography variant="caption" sx={{ minWidth: 45 }}>
              {formatTime(duration)}
            </Typography>
            
            {/* Volume & Devices - responsive: on xs stack below the progress bar */}
            <Box sx={{
              display: 'flex',
              alignItems: 'center',
              ml: { xs: 0, sm: 2 },
              mt: { xs: 1, sm: 0 },
              width: { xs: '100%', sm: 'auto' },
              justifyContent: { xs: 'flex-start', sm: 'flex-end' },
              order: { xs: 2, sm: 0 }
            }}>
              <VolumeUp sx={{ color: 'text.secondary', mr: 1 }} />
              <Slider
                size="small"
                value={volume}
                min={0}
                max={100}
                onChange={handleVolumeChange}
                onChangeCommitted={handleVolumeChangeCommitted}
                sx={{ 
                  width: { xs: '60%', sm: 100 },
                  mx: 1,
                  '& .MuiSlider-thumb': {
                    '&:hover, &.Mui-focusVisible': {
                      boxShadow: '0 0 0 8px rgba(29, 185, 84, 0.16)'
                    }
                  }
                }}
              />
              <IconButton 
                onClick={(e) => {
                  // React pools synthetic events — capture the anchor before any await
                  const anchor = e.currentTarget;
                  // Open the menu immediately for snappier UX and fetch devices in background
                  setDeviceMenuAnchor(anchor);
                  // Fetch devices but do not block UI; errors are logged
                  try { fetchDevices(); } catch (err) { console.warn('Erreur lors du fetchDevices on open:', err); }
                }}
                size="small"
                sx={{ color: 'text.secondary' }}
              >
                <Devices />
              </IconButton>
            </Box>

            <Menu
              anchorEl={deviceMenuAnchor}
              open={Boolean(deviceMenuAnchor)}
              onClose={() => setDeviceMenuAnchor(null)}
            >
              {devicesLoading ? (
                <MenuItem disabled>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1 }}>
                    <CircularProgress size={20} />
                    <Typography variant="body2">Chargement des appareils…</Typography>
                  </Box>
                </MenuItem>
              ) : devices.length === 0 ? (
                <MenuItem disabled>
                  <Typography variant="body2">Aucun appareil trouvé</Typography>
                </MenuItem>
              ) : (
                devices.map(device => (
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
                ))
              )}
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