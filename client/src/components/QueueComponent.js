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
  Chip
} from '@mui/material';
import { Remove, MusicNote, PlayArrow, DragIndicator } from '@mui/icons-material';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';

const QueueComponent = () => {
  const { playbackState, partyState, isSyncedWithParty, emitTrackRemovedFromQueue, socket } = useSocket();
  const { API_BASE_URL, user } = useAuth();
  const activeState = isSyncedWithParty ? partyState : playbackState;
  const isAllowed = isSyncedWithParty || user?.product === 'premium';
  // Guard: activeState may be undefined while the socket/context initializes.
  // Provide a default empty queue to avoid runtime destructure errors.
  const { queue = [] } = activeState || {};

  const [draggedIndex, setDraggedIndex] = React.useState(null);
  const [dragOverIndex, setDragOverIndex] = React.useState(null);

  const handleDragStart = (e, index) => {
    e.dataTransfer.effectAllowed = 'move';
    setDraggedIndex(index);
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (index !== dragOverIndex) {
      setDragOverIndex(index);
    }
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (e, dropIndex) => {
    e.preventDefault();
    setDragOverIndex(null);
    
    if (draggedIndex === null || draggedIndex === dropIndex) {
      setDraggedIndex(null);
      return;
    }

    // Emit socket event to reorder queue
    socket?.emit('reorder_queue', {
      fromIndex: draggedIndex,
      toIndex: dropIndex,
      isParty: isSyncedWithParty
    });
    
    setDraggedIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleRemoveFromQueue = (trackId) => {
    console.log('🗑️ Suppression de la queue:', trackId);
    emitTrackRemovedFromQueue(trackId);
  };

  const handlePlayTrack = async (track) => {
    console.log('▶️ Tentative de lecture du track:', track.name);
    // In Party mode we must instruct the server to start party playback so
    // that all synced clients receive the play instruction. For Solo mode we
    // keep the existing behavior which attempts to play on the local account
    // via the server API (using session cookies).
    if (isSyncedWithParty) {
      try {
        // Ask the server to play this specific track from the party queue
        socket?.emit('play_specific_from_queue', { trackId: track.id });
        console.log('ℹ️ Emitted play_specific_from_queue for', track.id);
      } catch (err) {
        console.error('❌ Failed to emit play_specific_from_queue:', err);
        alert('Erreur lors de la demande de lecture en mode Party');
      }
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/spotify/play-track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ uri: track.uri })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la lecture');
      }
      
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
      alert('Erreur: ' + error.message);
    }
  };

  // Mode toggle removed from UI; keep this component focused on rendering the queue

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
      {/* Restriction overlay: allow queue interactions in Party mode or for premium users in Solo */}
      {(() => {
        if (!isAllowed) {
          return (
            <Box sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0, 0, 0, 0.7)',
              zIndex: 10,
              borderRadius: 1,
              p: 2
            }}>
                <Typography variant="h6" sx={{ color: 'warning.main', textAlign: 'center' }}>
                🎵 File d'attente disponible uniquement en mode Party ou pour les utilisateurs premium
              </Typography>
            </Box>
          );
        }
        return null;
      })()}
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
            {queue.map((track, index) => {
              const isDragging = draggedIndex === index;
              const isDragOver = dragOverIndex === index;
              
              return (
              <ListItem
                key={track.id}
                className="queue-item"
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
                sx={{
                  borderRadius: 1,
                  mb: { xs: 1, sm: 1 },
                  px: { xs: 1, sm: 2 },
                  py: { xs: 1.5, sm: 1.5 },
                  backgroundColor: isDragging 
                    ? 'rgba(29, 185, 84, 0.3)' 
                    : isDragOver 
                    ? 'rgba(29, 185, 84, 0.25)'
                    : 'rgba(29, 185, 84, 0.1)',
                  border: isDragOver 
                    ? '2px dashed rgba(29, 185, 84, 0.6)' 
                    : '1px solid rgba(29, 185, 84, 0.2)',
                  opacity: isDragging ? 0.5 : 1,
                  '&:hover': {
                    backgroundColor: 'rgba(29, 185, 84, 0.2)',
                    transform: isDragging ? 'none' : 'translateY(-1px)',
                    transition: 'all 0.2s ease'
                  },
                  '&:active': {
                    transform: 'translateY(0px)',
                    backgroundColor: 'rgba(29, 185, 84, 0.25)',
                  },
                  cursor: isDragging ? 'grabbing' : 'grab'
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
                <DragIndicator 
                  sx={{ 
                    mr: { xs: 0.5, sm: 1 },
                    color: 'rgba(255, 255, 255, 0.3)',
                    cursor: 'grab',
                    '&:active': {
                      cursor: 'grabbing'
                    }
                  }} 
                />
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
              );
            })}
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