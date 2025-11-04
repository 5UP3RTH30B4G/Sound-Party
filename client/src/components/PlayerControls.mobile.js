import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Slider,
  Card,
  CardMedia,
  Alert,
  Button,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
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
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

const PlayerControls = () => {
  const { API_BASE_URL, refreshToken } = useAuth();
  const { 
    playbackState, 
    emitPlaybackControl, 
    emitPlaybackStateChange,
    connectionStatus 
  } = useSocket();
  const { serverRateLimitedMs } = useSocket();

  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(50);
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState(null);
  const [deviceMenuAnchor, setDeviceMenuAnchor] = useState(null);
  const [rateLimited, setRateLimited] = useState(false);
  const isMobileDeviceSelected = playbackState?.device?.type && playbackState.device.type.toLowerCase().includes('phone');

  const fetchPlaybackState = useCallback(async () => {
    if (rateLimited) return;
    
    try {
      const response = await axios.get(`${API_BASE_URL}/api/spotify/playback-state`);
      
      if (response.data.active !== false) {
        const track = response.data.item;
        const playing = response.data.is_playing;
        const pos = response.data.progress_ms || 0;
        const dur = track?.duration_ms || 0;

        setCurrentTrack(track);
        setIsPlaying(playing);
        setPosition(pos);
        setDuration(dur);

        emitPlaybackStateChange({
          currentTrack: track,
          isPlaying: playing,
          position: pos,
          device: response.data.device
        });

        setError(null);
        setRateLimited(false);
      } else {
        setError('Aucun appareil Spotify actif détecté. Ouvrez Spotify sur un appareil.');
      }
    } catch (error) {
      console.error('Erreur lors de la récupération de l\'état:', error);
      
      if (error.response?.status === 429) {
        setRateLimited(true);
        setError('Trop de requêtes - pause de 30 secondes');
        setTimeout(() => {
          setRateLimited(false);
          setError(null);
        }, 30000);
      } else if (error.response?.status === 401) {
        const refreshed = await refreshToken();
        if (!refreshed) {
          setError('Session expirée. Veuillez vous reconnecter.');
        }
      } else {
        setError('Erreur lors de la récupération de l\'état de lecture');
      }
    }
  }, [API_BASE_URL, refreshToken, emitPlaybackStateChange, rateLimited]);

  const fetchDevices = useCallback(async () => {
    if (rateLimited) return;
    
    try {
      const response = await axios.get(`${API_BASE_URL}/api/spotify/devices`);
      const devicesList = response.data.devices || [];
      
      setDevices(devicesList);
      setRateLimited(false);
    } catch (error) {
      console.error('❌ Erreur lors de la récupération des appareils:', error);
      
      if (error.response?.status === 429) {
        setRateLimited(true);
        setTimeout(() => {
          setRateLimited(false);
        }, 30000);
      }
    }
  }, [API_BASE_URL, rateLimited]);

  useEffect(() => {
    if (serverRateLimitedMs && serverRateLimitedMs > 0) return;

    fetchPlaybackState();
    fetchDevices();

    const playbackInterval = setInterval(() => {
      if (!rateLimited) {
        fetchPlaybackState();
      }
    }, 10000);

    const devicesInterval = setInterval(() => {
      if (!rateLimited) {
        fetchDevices();
      }
    }, 60000);
    
    return () => {
      clearInterval(playbackInterval);
      clearInterval(devicesInterval);
    };
  }, [fetchPlaybackState, fetchDevices, rateLimited]);

  useEffect(() => {
    if (playbackState.currentTrack) {
      setCurrentTrack(playbackState.currentTrack);
      setIsPlaying(playbackState.isPlaying);
      setPosition(playbackState.position);
    }
  }, [playbackState]);

  const handlePlayPause = async () => {
    try {
      if (isPlaying) {
        await axios.put(`${API_BASE_URL}/api/spotify/pause`);
        emitPlaybackControl('pause');
      } else {
        await axios.put(`${API_BASE_URL}/api/spotify/play`);
        emitPlaybackControl('play');
      }
      setIsPlaying(!isPlaying);
      setError(null);
    } catch (error) {
      console.error('Erreur play/pause:', error);
      setError(error.response?.data?.error || 'Erreur lors du contrôle de lecture');
    }
  };

  const handleNext = async () => {
    try {
      await axios.post(`${API_BASE_URL}/api/spotify/next`);
      emitPlaybackControl('next');
      setTimeout(fetchPlaybackState, 1000);
      setError(null);
    } catch (error) {
      console.error('Erreur next:', error);
      setError(error.response?.data?.error || 'Erreur lors du passage à la chanson suivante');
    }
  };

  const handlePrevious = async () => {
    try {
      await axios.post(`${API_BASE_URL}/api/spotify/previous`);
      emitPlaybackControl('previous');
      setTimeout(fetchPlaybackState, 1000);
      setError(null);
    } catch (error) {
      console.error('Erreur previous:', error);
      setError(error.response?.data?.error || 'Erreur lors du retour à la chanson précédente');
    }
  };

  const handlePositionChange = (event, newValue) => {
    setPosition(newValue);
  };

  const handlePositionChangeCommitted = async (event, newValue) => {
    try {
      await axios.put(`${API_BASE_URL}/api/spotify/seek`, {
        position_ms: newValue
      });
      setPosition(newValue);
      setError(null);
    } catch (error) {
      console.error('Erreur seek:', error);
      setError('Erreur lors du déplacement dans la chanson');
    }
  };

  const handleVolumeChangeCommitted = async (event, newValue) => {
    try {
      await axios.put(`${API_BASE_URL}/api/spotify/volume`, {
        volume_percent: newValue
      });
      setError(null);
    } catch (error) {
      console.error('Erreur volume:', error);
      setError('Erreur lors du changement de volume');
    }
  };

  const handleDeviceChange = async (deviceId) => {
    try {
      await axios.put(`${API_BASE_URL}/api/spotify/device`, {
        device_ids: [deviceId],
        play: isPlaying
      });
      
      await fetchDevices();
      setTimeout(() => {
        fetchPlaybackState();
      }, 1000);
      
      setDeviceMenuAnchor(null);
      setError(null);
    } catch (error) {
      console.error('❌ Erreur changement d\'appareil:', error);
      setError('Erreur lors du changement d\'appareil: ' + (error.response?.data?.error || error.message));
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

  return (
    <Card sx={{ 
      backgroundColor: 'rgba(30, 30, 30, 0.95)', 
      borderRadius: 2,
      border: '1px solid rgba(255, 255, 255, 0.1)',
      p: { xs: 2, sm: 3 },
      width: '100%'
    }}>
      {error && (
        <Alert 
          severity="warning" 
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={fetchPlaybackState}>
              <Refresh sx={{ mr: 1 }} />
              Réessayer
            </Button>
          }
        >
          {error}
        </Alert>
      )}

      {/* Layout responsive optimisé pour mobile */}
      <Box sx={{ 
        display: 'flex',
        flexDirection: { xs: 'column', md: 'row' },
        alignItems: 'center',
        gap: { xs: 2, md: 3 },
        width: '100%'
      }}>
        
        {/* Section: Informations sur la chanson */}
        <Box sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          minWidth: 0,
          width: { xs: '100%', md: 'auto' },
          justifyContent: { xs: 'center', md: 'flex-start' },
          flex: { md: '0 0 auto' }
        }}>
          {currentTrack ? (
            <>
              <CardMedia
                component="img"
                sx={{ 
                  width: { xs: 72, sm: 80, md: 64 }, 
                  height: { xs: 72, sm: 80, md: 64 }, 
                  borderRadius: 1,
                  flexShrink: 0 
                }}
                image={currentTrack.album?.images?.[0]?.url || '/placeholder-album.jpg'}
                alt={currentTrack.name}
              />
              <Box className="scrolling-text-container" sx={{ 
                ml: { xs: 2, md: 2 }, 
                minWidth: 0, 
                flex: 1,
                textAlign: { xs: 'left', md: 'left' },
                maxWidth: { xs: 'calc(100% - 140px)', sm: 'calc(100% - 160px)', md: 'auto' }
              }}>
                <Typography 
                  variant="subtitle1" 
                  className={`scrolling-text ${((currentTrack.name || '').length) > 3 ? 'scrolling-text-active' : 'scrolling-text-inactive'}`}
                  sx={{ 
                    fontWeight: 'bold',
                    color: 'white',
                    fontSize: { xs: '1rem', sm: '1.1rem' },
                    animationName: ((currentTrack.name || '').length) > 3 ? 'scrollTextComplete' : 'none'
                  }}>
                  {currentTrack.name}
                </Typography>
                <Typography 
                  variant="body2" 
                  color="text.secondary" 
                  className={`scrolling-text (${((currentTrack.artists && currentTrack.artists.map(artist => artist.name).join(', ')) || '')}.length > 3 ? 'scrolling-text-active' : 'scrolling-text-inactive'}`}
                  sx={{
                    fontSize: { xs: '0.875rem', sm: '0.875rem' },
                    animationName: ((currentTrack.artists && currentTrack.artists.map(artist => artist.name).join(', ')) || '').length > 3 ? 'scrollTextArtistComplete' : 'none'
                  }}>
                  {(currentTrack.artists && currentTrack.artists.map(artist => artist.name).join(', ')) || ''}
                </Typography>
                <Typography 
                  variant="caption" 
                  color="text.secondary" 
                  className={`scrolling-text ${currentTrack.album?.name?.length > 3 ? 'scrolling-text-active' : 'scrolling-text-inactive'}`}
                  sx={{
                    fontSize: { xs: '0.75rem', sm: '0.75rem' },
                    animationName: currentTrack.album?.name?.length > 3 ? 'scrollTextAlbumComplete' : 'none'
                  }}>
                  {currentTrack.album?.name}
                </Typography>
              </Box>
            </>
          ) : (
            <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', justifyContent: 'center' }}>
              <Box sx={{ 
                width: { xs: 72, sm: 80, md: 64 }, 
                height: { xs: 72, sm: 80, md: 64 }, 
                backgroundColor: 'rgba(255, 255, 255, 0.1)', 
                borderRadius: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: { xs: '28px', sm: '32px', md: '24px' }
              }}>
                🎵
              </Box>
              <Box sx={{ ml: 2 }}>
                <Typography variant="subtitle1" color="text.secondary" sx={{
                  fontSize: { xs: '1rem', sm: '1.1rem' }
                }}>
                  Aucune chanson en cours
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{
                  fontSize: { xs: '0.875rem', sm: '0.875rem' }
                }}>
                  Lancez Spotify pour commencer
                </Typography>
              </Box>
            </Box>
          )}
        </Box>

        {/* Section: Contrôles de lecture avec barre de progression */}
        <Box sx={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center',
          width: '100%',
          flex: { md: 1 },
          maxWidth: { md: '600px' }
        }}>
          {/* Boutons de contrôle - plus grands sur mobile */}
          <Box sx={{ 
            display: 'flex', 
            alignItems: 'center', 
            mb: { xs: 2, md: 2 },
            gap: { xs: 1, sm: 2 }
          }}>
            <IconButton 
              onClick={handlePrevious}
              disabled={!currentTrack || connectionStatus !== 'connected'}
              sx={{ 
                color: 'white',
                width: { xs: 48, sm: 52, md: 44 },
                height: { xs: 48, sm: 52, md: 44 },
                '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.1)' }
              }}
            >
              <SkipPrevious sx={{ fontSize: { xs: 32, sm: 36, md: 28 } }} />
            </IconButton>
            
            <IconButton 
              onClick={handlePlayPause}
              disabled={!currentTrack || connectionStatus !== 'connected'}
              sx={{ 
                backgroundColor: '#1DB954',
                color: 'white',
                mx: { xs: 1, sm: 2 },
                width: { xs: 64, sm: 72, md: 56 },
                height: { xs: 64, sm: 72, md: 56 },
                '&:hover': { 
                  backgroundColor: '#1ed760',
                  transform: 'scale(1.05)'
                },
                '&:disabled': { backgroundColor: 'grey.700' },
                transition: 'all 0.2s ease'
              }}
            >
              {isPlaying ? 
                <Pause sx={{ fontSize: { xs: 36, sm: 40, md: 32 } }} /> : 
                <PlayArrow sx={{ fontSize: { xs: 36, sm: 40, md: 32 } }} />
              }
            </IconButton>
            
            <IconButton 
              onClick={handleNext}
              disabled={!currentTrack || connectionStatus !== 'connected'}
              sx={{ 
                color: 'white',
                width: { xs: 48, sm: 52, md: 44 },
                height: { xs: 48, sm: 52, md: 44 },
                '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.1)' }
              }}
            >
              <SkipNext sx={{ fontSize: { xs: 32, sm: 36, md: 28 } }} />
            </IconButton>
          </Box>

          {/* Barre de progression - adaptative */}
          {currentTrack && (
            <Box sx={{ 
              display: 'flex', 
              alignItems: 'center', 
              width: '100%',
              maxWidth: { xs: '100%', sm: '100%', md: '500px' }
            }}>
              <Typography variant="caption" sx={{ 
                minWidth: { xs: 35, sm: 40, md: 45 }, 
                fontSize: { xs: '0.7rem', sm: '0.75rem' },
                color: 'text.secondary',
                textAlign: 'right',
                mr: { xs: 1, sm: 1 }
              }}>
                {formatTime(position)}
              </Typography>
              
              <Slider
                value={position}
                max={duration}
                onChange={handlePositionChange}
                onChangeCommitted={handlePositionChangeCommitted}
                disabled={!currentTrack}
                sx={{
                  flex: 1,
                  mx: { xs: 1, sm: 1 },
                  height: { xs: 6, sm: 8, md: 6 },
                  color: '#1DB954',
                  '& .MuiSlider-thumb': {
                    width: { xs: 14, sm: 16, md: 12 },
                    height: { xs: 14, sm: 16, md: 12 },
                    '&:before': {
                      boxShadow: '0 4px 8px rgba(0,0,0,0.4)',
                    },
                    '&:hover, &.Mui-focusVisible, &.Mui-active': {
                      boxShadow: 'none',
                    },
                  },
                  '& .MuiSlider-track': {
                    height: { xs: 4, sm: 6, md: 4 },
                  },
                  '& .MuiSlider-rail': {
                    height: { xs: 4, sm: 6, md: 4 },
                    color: 'rgba(255, 255, 255, 0.2)',
                  },
                }}
              />
              
              <Typography variant="caption" sx={{ 
                minWidth: { xs: 35, sm: 40, md: 45 }, 
                fontSize: { xs: '0.7rem', sm: '0.75rem' },
                color: 'text.secondary',
                ml: { xs: 1, sm: 1 }
              }}>
                {formatTime(duration)}
              </Typography>
            </Box>
          )}
        </Box>

        {/* Section: Volume et appareils - cachée si l'appareil sélectionné est un téléphone */}
        {!isMobileDeviceSelected && (
          <Box sx={{ 
            display: { xs: 'none', md: 'flex' },
            alignItems: 'center',
            minWidth: 150,
            justifyContent: 'flex-end'
          }}>
            {/* Contrôle de volume */}
            <Box sx={{ display: 'flex', alignItems: 'center', mr: 2 }}>
              <VolumeUp sx={{ color: 'text.secondary', mr: 1 }} />
              <Slider
                value={volume}
                onChange={(e, newValue) => setVolume(newValue)}
                onChangeCommitted={handleVolumeChangeCommitted}
                sx={{
                  width: 80,
                  color: '#1DB954',
                  '& .MuiSlider-thumb': {
                    width: 12,
                    height: 12,
                  },
                }}
              />
            </Box>

            {/* Sélecteur d'appareil */}
            <IconButton
              onClick={(event) => {
                setDeviceMenuAnchor(event.currentTarget);
                fetchDevices();
              }}
              disabled={connectionStatus !== 'connected'}
              sx={{ 
                color: 'white',
                '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.1)' }
              }}
            >
              <Devices />
            </IconButton>
          </Box>
        )}
      </Box>

      {/* Menu flottant pour mobile - Volume et appareils (caché si appareil sélectionné est un téléphone) */}
      {!isMobileDeviceSelected && (
        <Box sx={{ 
          display: { xs: 'flex', md: 'none' },
          justifyContent: 'space-between',
          alignItems: 'center',
          mt: 2,
          pt: 2,
          borderTop: '1px solid rgba(255, 255, 255, 0.1)'
        }}>
          {/* Contrôle de volume mobile */}
          <Box sx={{ display: 'flex', alignItems: 'center', flex: 1, mr: 2 }}>
            <VolumeUp sx={{ color: 'text.secondary', mr: 1, fontSize: 20 }} />
            <Slider
              value={volume}
              onChange={(e, newValue) => setVolume(newValue)}
              onChangeCommitted={handleVolumeChangeCommitted}
              sx={{
                flex: 1,
                color: '#1DB954',
                '& .MuiSlider-thumb': {
                  width: 16,
                  height: 16,
                },
                '& .MuiSlider-track': {
                  height: 4,
                },
                '& .MuiSlider-rail': {
                  height: 4,
                  color: 'rgba(255, 255, 255, 0.2)',
                },
              }}
            />
          </Box>

          {/* Sélecteur d'appareil mobile */}
          <IconButton
            onClick={(event) => {
              setDeviceMenuAnchor(event.currentTarget);
              fetchDevices();
            }}
            disabled={connectionStatus !== 'connected'}
            sx={{ 
              color: 'white',
              width: 44,
              height: 44,
              '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.1)' }
            }}
          >
            <Devices sx={{ fontSize: 24 }} />
          </IconButton>
        </Box>
      )}

      {/* Menu des appareils */}
      <Menu
        anchorEl={deviceMenuAnchor}
        open={Boolean(deviceMenuAnchor)}
        onClose={() => setDeviceMenuAnchor(null)}
        PaperProps={{
          sx: {
            backgroundColor: 'rgba(30, 30, 30, 0.95)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255, 255, 255, 0.1)'
          }
        }}
      >
        {devices.map((device) => (
          <MenuItem 
            key={device.id}
            onClick={() => handleDeviceChange(device.id)}
            selected={device.is_active}
            sx={{ 
              '&.Mui-selected': { 
                backgroundColor: 'rgba(29, 185, 84, 0.2)' 
              }
            }}
          >
            <ListItemIcon sx={{ color: 'white' }}>
              {getDeviceIcon(device.type)}
            </ListItemIcon>
            <ListItemText 
              primary={device.name}
              secondary={device.type}
              primaryTypographyProps={{ color: 'white' }}
              secondaryTypographyProps={{ color: 'text.secondary' }}
            />
            {device.is_active && (
              <Chip 
                label="Actif" 
                size="small" 
                color="success" 
                sx={{ ml: 1 }}
              />
            )}
          </MenuItem>
        ))}
        {devices.length === 0 && (
          <MenuItem disabled>
            <ListItemText 
              primary="Aucun appareil disponible" 
              primaryTypographyProps={{ color: 'text.secondary' }}
            />
          </MenuItem>
        )}
      </Menu>
    </Card>
  );
};

export default PlayerControls;