import React from 'react';
import {
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Avatar,
  IconButton,
  Typography,
  Box,
  Chip,
  ToggleButton,
  ToggleButtonGroup
} from '@mui/material';
import { Remove, MusicNote, PlayArrow } from '@mui/icons-material';
import { useSocket } from '../contexts/SocketContext';
import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || process.env.REACT_APP_API_URL;

const QueueComponent = () => {
  const { playbackState, partyState, isSyncedWithParty, togglePartySync, emitTrackRemovedFromQueue } = useSocket();
  // Effective fetcher: party fetcher preferred, otherwise solo playback fetcher
  const effectiveFetcher = (partyState && partyState.fetcher) || (playbackState && playbackState.fetcher);
  const activeState = isSyncedWithParty ? partyState : playbackState;
  // Guard: activeState may be undefined while the socket/context initializes.
  // Provide a default empty queue to avoid runtime destructure errors.
  const { queue = [] } = activeState || {};

  const handleRemoveFromQueue = (trackId) => {
    console.log('🗑️ Suppression de la queue:', trackId);
    emitTrackRemovedFromQueue(trackId);
  };

  const handlePlayTrack = async (track) => {
    console.log('▶️ Tentative de lecture du track:', track.name);
    
    try {
      await axios.post(`${API_BASE_URL}/api/spotify/play-track`, {
        uri: track.uri
      }, {
        withCredentials: true,
        headers: { 'Content-Type': 'application/json' }
      });
      console.log('✅ Track joué avec succès:', track.name);
      // Après une lecture réussie, demander la suppression de la piste de la file d'attente
      try {
        emitTrackRemovedFromQueue(track.id);
        console.log('🗑️ Emis suppression de la piste jouée de la file:', track.id);
      } catch (err) {
        console.warn('⚠️ Impossible d\'émettre la suppression de la queue après play:', err);
      }
    } catch (error) {
      console.error('❌ Erreur lors de la lecture du track:', error);
      alert('Erreur: ' + (error.response?.data?.error || 'Impossible de jouer cette chanson'));
    }
  };

  const handleModeToggle = (event, newMode) => {
    if (newMode !== null) {
      togglePartySync(newMode === 'party');
    }
  };

  const formatDuration = (ms) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const formatAddedTime = (timestamp) => {
    const now = new Date();
    const added = new Date(timestamp);
    const diffMinutes = Math.floor((now - added) / 60000);
    
    if (diffMinutes < 1) return 'À l\'instant';
    if (diffMinutes < 60) return `Il y a ${diffMinutes}min`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `Il y a ${diffHours}h`;
    return added.toLocaleDateString();
  };

  return (
    <Box sx={{ 
      display: 'flex', 
      flexDirection: 'column',
      overflow: 'hidden',
      maxHeight: { xs: '40vh', sm: '50vh', md: '60vh' },
      minHeight: 0,
      position: 'relative'
    }}>      
      {queue && queue.length > 0 ? (
        <>
          <Box sx={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            mb: 2 
          }}>
            <Typography 
              variant="body2" 
              color="text.secondary" 
              sx={{ 
                fontSize: { xs: '0.875rem', sm: '0.875rem' },
                fontWeight: 'medium'
              }}
            >
              {queue.length} chanson{queue.length > 1 ? 's' : ''} en attente
            </Typography>
            
            <ToggleButtonGroup
              value={isSyncedWithParty ? 'party' : 'solo'}
              exclusive
              onChange={handleModeToggle}
              size="small"
              sx={{ height: 28 }}
            >
              <ToggleButton value="solo" sx={{ px: 1.5, fontSize: '0.75rem' }}>
                Solo
              </ToggleButton>
              <ToggleButton value="party" sx={{ px: 1.5, fontSize: '0.75rem' }}>
                Party
              </ToggleButton>
            </ToggleButtonGroup>
              {effectiveFetcher && (
                <Chip
                  label={`Fetcher: ${effectiveFetcher.name || 'actif'}`}
                  size="small"
                  color="info"
                  sx={{ ml: 1, height: 26, fontSize: '0.7rem' }}
                />
              )}
          </Box>
          
          <List sx={{ 
            flex: 1, 
            overflow: 'auto',
            py: 0,
            // Scrollbar mobile optimisée
            '&::-webkit-scrollbar': {
              width: { xs: 4, sm: 6 },
            },
            '&::-webkit-scrollbar-track': {
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              borderRadius: 3,
            },
            '&::-webkit-scrollbar-thumb': {
              backgroundColor: 'rgba(29, 185, 84, 0.3)',
              borderRadius: 3,
              '&:hover': {
                backgroundColor: 'rgba(29, 185, 84, 0.5)',
              },
            },
          }}>
            {queue.map((track, index) => (
              <ListItem
                key={track.id}
                className="queue-item"
                sx={{
                  borderRadius: 1,
                  mb: { xs: 1, sm: 1 },
                  px: { xs: 1, sm: 2 },
                  py: { xs: 1.5, sm: 1.5 },
                  backgroundColor: 'rgba(29, 185, 84, 0.1)',
                  border: '1px solid rgba(29, 185, 84, 0.2)',
                  '&:hover': {
                    backgroundColor: 'rgba(29, 185, 84, 0.2)',
                    transform: 'translateY(-1px)',
                    transition: 'all 0.2s ease'
                  },
                  '&:active': {
                    transform: 'translateY(0px)',
                    backgroundColor: 'rgba(29, 185, 84, 0.25)',
                  },
                  cursor: 'pointer'
                }}
                secondaryAction={
                  <Box sx={{ 
                    display: 'flex', 
                    gap: { xs: 0.5, sm: 0.5 },
                    flexDirection: { xs: 'column', sm: 'row' },
                    alignItems: 'center'
                  }}>
                    <IconButton
                      edge="end"
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePlayTrack(track);
                      }}
                      title="Jouer maintenant"
                      sx={{ 
                        color: 'success.main',
                        backgroundColor: 'rgba(76, 175, 80, 0.1)',
                        width: { xs: 40, sm: 44 },
                        height: { xs: 40, sm: 44 },
                        '&:hover': {
                          backgroundColor: 'rgba(76, 175, 80, 0.2)',
                          transform: 'scale(1.1)',
                        },
                        '&:active': {
                          transform: 'scale(0.95)',
                        },
                        transition: 'all 0.2s ease'
                      }}
                      size="small"
                    >
                      <PlayArrow sx={{ fontSize: { xs: 18, sm: 20 } }} />
                    </IconButton>
                    <IconButton
                      edge="end"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveFromQueue(track.id);
                      }}
                      title="Supprimer de la file d'attente"
                      sx={{ 
                        color: 'error.main',
                        backgroundColor: 'rgba(244, 67, 54, 0.1)',
                        width: { xs: 40, sm: 44 },
                        height: { xs: 40, sm: 44 },
                        '&:hover': {
                          backgroundColor: 'rgba(244, 67, 54, 0.2)',
                          transform: 'scale(1.1)',
                        },
                        '&:active': {
                          transform: 'scale(0.95)',
                        },
                        transition: 'all 0.2s ease'
                      }}
                      size="small"
                    >
                      <Remove sx={{ fontSize: { xs: 18, sm: 20 } }} />
                    </IconButton>
                  </Box>
                }
              >
                <ListItemAvatar>
                  <Avatar
                    src={track.image}
                    variant="rounded"
                    sx={{ 
                      width: { xs: 48, sm: 56 }, 
                      height: { xs: 48, sm: 56 },
                      borderRadius: 1,
                      border: '1px solid rgba(29, 185, 84, 0.3)'
                    }}
                  >
                    <MusicNote sx={{ fontSize: { xs: 20, sm: 24 } }} />
                  </Avatar>
                </ListItemAvatar>
                
                <ListItemText
                  primary={
                    <Typography 
                      variant="body2" 
                      sx={{
                        color: 'white',
                        fontWeight: 'medium',
                        fontSize: { xs: '0.875rem', sm: '0.9rem' }
                      }}
                    >
                      {track.name}
                    </Typography>
                  }
                  secondary={
                    <Box>
                      <Typography 
                        variant="caption" 
                        color="text.secondary" 
                        sx={{
                          display: 'block',
                          fontSize: { xs: '0.75rem', sm: '0.8rem' }
                        }}
                      >
                        {track.artist}
                      </Typography>
                      
                      {/* Badges et infos sur mobile */}
                      <Box sx={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: { xs: 0.5, sm: 1 }, 
                        mt: 0.5,
                        flexWrap: 'wrap'
                      }}>
                        <Chip
                          label={`#${index + 1}`}
                          size="small"
                          color="primary"
                          sx={{ 
                            height: { xs: 16, sm: 18 }, 
                            fontSize: { xs: '0.6rem', sm: '0.7rem' }, 
                            minWidth: { xs: 20, sm: 24 },
                            backgroundColor: 'rgba(29, 185, 84, 0.2)',
                            color: 'rgba(29, 185, 84, 1)',
                            border: '1px solid rgba(29, 185, 84, 0.4)'
                          }}
                        />
                        {track.duration_ms && (
                          <Chip
                            label={formatDuration(track.duration_ms)}
                            size="small"
                            variant="outlined"
                            sx={{ 
                              height: { xs: 16, sm: 18 }, 
                              fontSize: { xs: '0.6rem', sm: '0.7rem' },
                              backgroundColor: 'rgba(255, 255, 255, 0.05)',
                              borderColor: 'rgba(255, 255, 255, 0.2)'
                            }}
                          />
                        )}
                        <Typography 
                          variant="caption" 
                          color="text.secondary"
                          sx={{ 
                            fontSize: { xs: '0.65rem', sm: '0.75rem' },
                            display: { xs: 'none', sm: 'inline' } // Masquer sur mobile pour économiser l'espace
                          }}
                        >
                          par {track.addedBy}
                        </Typography>
                      </Box>
                      
                      {/* Timestamp en bas */}
                      <Typography 
                        variant="caption" 
                        color="text.secondary"
                        sx={{ 
                          display: 'block',
                          mt: 0.5,
                          fontSize: { xs: '0.65rem', sm: '0.7rem' }
                        }}
                      >
                        {formatAddedTime(track.addedAt)}
                        {/* Afficher "par" sur mobile seulement ici */}
                        <Box component="span" sx={{ display: { xs: 'inline', sm: 'none' } }}>
                          {' • par '}{track.addedBy}
                        </Box>
                      </Typography>
                    </Box>
                  }
                  sx={{ 
                    ml: { xs: 1, sm: 2 },
                    mr: { xs: 0.5, sm: 1 }
                  }}
                />
              </ListItem>
            ))}
          </List>
        </>
      ) : (
        <div className="queue-empty">
          <div className="queue-empty-icon">🎵</div>
          <h3>File d'attente vide</h3>
          <p>Recherchez et ajoutez des chansons pour commencer !</p>
        </div>
      )}
    </Box>
  );
};

export default QueueComponent;