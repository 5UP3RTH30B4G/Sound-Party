import React, { useState, useCallback, useEffect } from 'react';
import {
  Box,
  TextField,
  List,
  ListItem,
  ListItemText,
  ListItemAvatar,
  Avatar,
  Typography,
  IconButton,
  InputAdornment,
  Chip
} from '@mui/material';
import { Search, Add } from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

const SearchComponent = ({ onTrackQueued }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const { API_BASE_URL, user } = useAuth();
  const { socket, playbackState, isSyncedWithParty } = useSocket();

  const emitTrackQueued = useCallback((track) => {
    console.log('🔌 Socket disponible:', !!socket);
    console.log('🔌 Socket connecté:', socket?.connected);
    if (socket) {
      console.log('📤 Émission événement track_queued vers serveur:', track);
      socket.emit('track_queued', track); // Changé de 'addToQueue' à 'track_queued'
      console.log('✅ Événement track_queued émis avec succès');
    } else {
      console.error('❌ Socket non disponible pour émettre track_queued');
    }
  }, [socket]);

  useEffect(() => {
    if (socket) {
      const handleTrackAdded = (data) => {
        console.log('🎵 Track ajouté à la queue:', data);
        if (onTrackQueued) {
          onTrackQueued(data);
        }
      };

      socket.on('trackQueued', handleTrackAdded);
      return () => socket.off('trackQueued', handleTrackAdded);
    }
  }, [socket, onTrackQueued]);

  const debounce = (func, delay) => {
    let timeoutId;
    return (...args) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func.apply(null, args), delay);
    };
  };

  const searchTracks = useCallback(async (searchQuery) => {
    // Allow searches for any non-empty query (previously required >=2 chars)
    if (!searchQuery) {
      setResults([]);
      return;
    }

    setLoading(true);
    try {
      console.log('🔍 Recherche pour:', searchQuery, 'URL:', `${API_BASE_URL}/api/spotify/search`);
      const response = await fetch(`${API_BASE_URL}/api/spotify/search?q=${encodeURIComponent(searchQuery)}`, {
        credentials: 'include' // Important pour inclure les cookies de session
      });
      console.log('📡 Réponse recherche:', response.status, response.statusText);
      if (response.ok) {
        const data = await response.json();
        const tracks = data.tracks?.items || [];
        console.log('🎵 Résultats trouvés:', tracks.length, 'tracks');
        // Afficher tous les résultats sans limitation
  setResults(tracks);

        // Émettre les résultats au serveur pour synchronisation
        socket?.emit('searchResults', {
          query: searchQuery,
          results: tracks.slice(0, 5) // Partager seulement les 5 premiers
        });
      } else {
        console.error('❌ Erreur recherche - Status:', response.status);
        const errorText = await response.text();
        console.error('❌ Détails erreur:', errorText);
        setResults([]);
      }
    } catch (error) {
      console.error('❌ Erreur lors de la recherche:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [API_BASE_URL, socket]);

  const handleSearch = useCallback((searchQuery) => {
    const debounced = debounce(() => searchTracks(searchQuery), 300);
    debounced();
  }, [searchTracks]);

  const handleAddToQueue = async (track) => {
    console.log('🎵 Tentative d\'ajout à la file d\'attente:', track.name);
    console.log('📊 État actuel playbackState:', playbackState);
    console.log('📋 File actuelle:', playbackState?.queue);
    
    try {
      // Émettre directement à la queue serveur (pas à Spotify)
      const trackData = {
        id: track.id,
        name: track.name,
        artist: track.artists[0]?.name,
        album: track.album?.name,
        image: track.album?.images?.[0]?.url,
        uri: track.uri,
        duration_ms: track.duration_ms,
        external_urls: track.external_urls
      };
      
      console.log('📤 Émission vers le serveur:', trackData);
      
      // Vérifier si auto-play nécessaire AVANT d'ajouter à la file
      const { queue } = playbackState || {};
      const shouldAutoPlay = !queue || queue.length === 0;
      
      if (shouldAutoPlay) {
        console.log('🎵 File vide détectée, lecture automatique programmée');
      } else {
        console.log('📋 File non vide, ajout normal à la queue:', queue.length, 'éléments');
      }

      emitTrackQueued(trackData);

      // Auto-play si la file était vide
      if (shouldAutoPlay) {
        console.log('🚀 Déclenchement auto-play pour:', trackData.name);
        socket?.emit('auto_play_track', trackData);
      }

      console.log('✅ Chanson ajoutée à la file d\'attente serveur:', track.name);
    } catch (error) {
      console.error('❌ Erreur lors de l\'ajout à la file d\'attente:', error);
      alert('Erreur: Impossible d\'ajouter la chanson à la file d\'attente');
    }
  };

  const formatDuration = (ms) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <Box sx={{ 
      height: '100%', 
      display: 'flex', 
      flexDirection: 'column',
      overflow: 'hidden',
      position: 'relative'
    }}>
      {(() => {
        const isAllowed = isSyncedWithParty || user?.product === 'premium';
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
              borderRadius: 1
            }}>
              <Typography variant="h6" sx={{ color: 'warning.main', textAlign: 'center', px: 2 }}>
                🔍 Recherche disponible uniquement en mode Party ou pour les utilisateurs premium
              </Typography>
            </Box>
          );
        }
        return null;
      })()}
      
      {/* Barre de recherche optimisée pour mobile */}
      <TextField
        fullWidth
        variant="outlined"
        placeholder="Rechercher des musiques..."
        value={query}
        disabled={(() => {
          return !(isSyncedWithParty || user?.product === 'premium');
        })()}
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value.length > 0) {
            handleSearch(e.target.value);
          } else if (e.target.value.length === 0) {
            setResults([]);
          }
        }}
        sx={{
          mb: 2,
          '& .MuiOutlinedInput-root': {
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            height: { xs: 48, sm: 56 }, // Plus haut sur mobile
            fontSize: { xs: '1rem', sm: '1rem' },
            '& fieldset': {
              borderColor: 'rgba(255, 255, 255, 0.2)',
            },
            '&:hover fieldset': {
              borderColor: 'rgba(255, 255, 255, 0.4)',
            },
            '&.Mui-focused fieldset': {
              borderColor: '#1DB954',
            },
          },
          '& .MuiInputBase-input': {
            color: 'white',
            fontSize: { xs: '1rem', sm: '1rem' },
            padding: { xs: '14px 16px', sm: '16px' }
          },
          '& .MuiInputBase-input::placeholder': {
            color: 'rgba(255, 255, 255, 0.5)',
          }
        }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <Search sx={{ 
                color: 'rgba(255, 255, 255, 0.5)',
                fontSize: { xs: 20, sm: 24 }
              }} />
            </InputAdornment>
          ),
        }}
      />

      {/* Liste des résultats avec scroll optimisé et hauteur flexible */}
      <Box sx={{ 
        flex: 1, 
        overflow: 'auto',
        minHeight: '200px', // Hauteur minimale 
        maxHeight: 'calc(100vh - 200px)', // Hauteur maximale dynamique
        // Style de scrollbar personnalisé et plus visible
        '&::-webkit-scrollbar': {
          width: { xs: 8, sm: 10 }, // Scrollbar plus visible
        },
        '&::-webkit-scrollbar-track': {
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          borderRadius: 5,
        },
        '&::-webkit-scrollbar-thumb': {
          backgroundColor: 'rgba(29, 185, 84, 0.6)', // Couleur Spotify verte
          borderRadius: 5,
          '&:hover': {
            backgroundColor: 'rgba(29, 185, 84, 0.8)',
          },
        },
      }}>
        {loading && (
          <Typography 
            variant="body2" 
            color="text.secondary" 
            sx={{ 
              textAlign: 'center', 
              py: 2,
              fontSize: { xs: '0.875rem', sm: '0.875rem' }
            }}
          >
            Recherche en cours...
          </Typography>
        )}

        {results.length === 0 && query.length > 0 && !loading && (
          <Typography 
            variant="body2" 
            color="text.secondary" 
            sx={{ 
              textAlign: 'center', 
              py: 2,
              fontSize: { xs: '0.875rem', sm: '0.875rem' }
            }}
          >
            Aucun résultat trouvé
          </Typography>
        )}

        {results.length === 0 && query.length === 0 && !loading && (
          <Typography 
            variant="body2" 
            color="text.secondary" 
            sx={{ 
              textAlign: 'center', 
              py: 2,
              fontSize: { xs: '0.875rem', sm: '0.875rem' }
            }}
          >
            Tapez pour rechercher des chansons
          </Typography>
        )}

        <List sx={{ 
          py: 0,
          '& .MuiListItem-root': {
            borderRadius: 1,
            mb: 0.5,
            '&:hover': {
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
            },
          }
        }}>
          {results.map((track) => (
            <ListItem
              key={track.id}
              sx={{
                px: { xs: 1, sm: 2 },
                py: { xs: 1.5, sm: 1.5 },
                cursor: 'pointer',
                borderRadius: 1,
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                '&:hover': {
                  backgroundColor: 'rgba(29, 185, 84, 0.1)',
                  transform: 'translateY(-1px)',
                  transition: 'all 0.2s ease'
                },
                '&:active': {
                  transform: 'translateY(0px)',
                  backgroundColor: 'rgba(29, 185, 84, 0.15)',
                },
              }}
              onClick={() => handleAddToQueue(track)}
            >
              <ListItemAvatar>
                <Avatar
                  src={track.album?.images?.[2]?.url || track.album?.images?.[0]?.url}
                  variant="rounded"
                  sx={{ 
                    width: { xs: 48, sm: 56 }, 
                    height: { xs: 48, sm: 56 },
                    borderRadius: 1
                  }}
                >
                  🎵
                </Avatar>
              </ListItemAvatar>
              
              <ListItemText
                primary={
                  <Typography 
                    variant="body1" 
                    sx={{
                      color: 'white',
                      fontWeight: 'medium',
                      fontSize: { xs: '0.9rem', sm: '1rem' }
                    }}
                  >
                    {track.name}
                  </Typography>
                }
                secondary={
                  <Box>
                    <Typography 
                      variant="body2" 
                      color="text.secondary" 
                      sx={{
                        display: 'block',
                        fontSize: { xs: '0.8rem', sm: '0.875rem' }
                      }}
                    >
                      {(track.artists && track.artists.map(artist => artist.name).join(', ')) || ''}
                    </Typography>
                    <Box sx={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: { xs: 0.5, sm: 1 }, 
                      mt: 0.5,
                      flexWrap: 'wrap'
                    }}>
                      <Typography 
                        variant="caption" 
                        color="text.secondary"
                        noWrap
                        sx={{ 
                          fontSize: { xs: '0.7rem', sm: '0.75rem' },
                          flex: 1,
                          minWidth: 0
                        }}
                      >
                        {track.album?.name}
                      </Typography>
                      <Chip
                        label={formatDuration(track.duration_ms)}
                        size="small"
                        variant="outlined"
                        sx={{ 
                          height: { xs: 16, sm: 18 }, 
                          fontSize: { xs: '0.6rem', sm: '0.7rem' },
                          backgroundColor: 'rgba(255, 255, 255, 0.1)',
                          borderColor: 'rgba(255, 255, 255, 0.2)'
                        }}
                      />
                      {track.explicit && (
                        <Chip
                          label="E"
                          size="small"
                          color="warning"
                          sx={{ 
                            height: { xs: 16, sm: 18 }, 
                            fontSize: { xs: '0.6rem', sm: '0.7rem' }, 
                            minWidth: { xs: 16, sm: 20 }
                          }}
                        />
                      )}
                    </Box>
                  </Box>
                }
                sx={{ 
                  ml: { xs: 1, sm: 2 },
                  mr: { xs: 1, sm: 2 } 
                }}
              />

              {/* Bouton d'ajout plus grand sur mobile */}
              <IconButton
                onClick={(e) => {
                  e.stopPropagation();
                  handleAddToQueue(track);
                }}
                sx={{
                  color: '#1DB954',
                  backgroundColor: 'rgba(29, 185, 84, 0.1)',
                  width: { xs: 44, sm: 48 },
                  height: { xs: 44, sm: 48 },
                  minWidth: { xs: 44, sm: 48 },
                  '&:hover': {
                    backgroundColor: 'rgba(29, 185, 84, 0.2)',
                    transform: 'scale(1.1)',
                  },
                  '&:active': {
                    transform: 'scale(0.95)',
                  },
                  transition: 'all 0.2s ease'
                }}
                size="small"
              >
                <Add sx={{ fontSize: { xs: 22, sm: 24 } }} />
              </IconButton>
            </ListItem>
          ))}
        </List>
      </Box>
    </Box>
  );
};

export default SearchComponent;