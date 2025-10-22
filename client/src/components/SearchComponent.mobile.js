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
import { useSocket } from '../contexts/SocketContext';

const SearchComponent = ({ onTrackQueued }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const { socket, isSyncedWithParty, playbackState, partyState } = useSocket();

  const emitTrackQueued = useCallback((track) => {
    if (socket) {
      socket.emit('addToQueue', track);
      console.log('🎵 Track émis au serveur:', track);
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
      const response = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
      if (response.ok) {
        const data = await response.json();
        const tracks = data.tracks?.items || [];
        setResults(tracks);

        // Émettre les résultats au serveur pour synchronisation
        socket?.emit('searchResults', {
          query: searchQuery,
          results: tracks.slice(0, 5) // Partager seulement les 5 premiers
        });
      }
    } catch (error) {
      console.error('Erreur lors de la recherche:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [socket]);

  const handleSearch = useCallback(debounce(searchTracks, 300), [searchTracks]);

  const handleAddToQueue = async (track) => {
    console.log('🎵 Tentative d\'ajout à la file d\'attente:', track.name);
    
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
      emitTrackQueued(trackData);

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
      {!(isSyncedWithParty || ((partyState && partyState.fetcher) || (playbackState && playbackState.fetcher))) && (
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
            🔍 Recherche disponible uniquement en mode Party
          </Typography>
        </Box>
      )}
      
      {/* Barre de recherche optimisée pour mobile */}
        <TextField
        fullWidth
        variant="outlined"
        placeholder="Rechercher des musiques..."
        value={query}
        disabled={!(isSyncedWithParty || ((partyState && partyState.fetcher) || (playbackState && playbackState.fetcher)))}
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

      {/* Liste des résultats avec scroll optimisé */}
      <Box sx={{ 
        flex: 1, 
        overflow: 'auto',
        // Style de scrollbar personnalisé
        '&::-webkit-scrollbar': {
          width: { xs: 4, sm: 6 },
        },
        '&::-webkit-scrollbar-track': {
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          borderRadius: 3,
        },
        '&::-webkit-scrollbar-thumb': {
          backgroundColor: 'rgba(255, 255, 255, 0.3)',
          borderRadius: 3,
          '&:hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.5)',
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
                  <Box className="scrolling-text-container" sx={{ 
                    maxWidth: { xs: 'calc(100% - 150px)', sm: 'calc(100% - 170px)' }
                  }}>
                    <Typography 
                      variant="body1" 
                      className={`scrolling-text ${((track.name || '').length) > 10 ? 'scrolling-text-active' : 'scrolling-text-inactive'}`}
                      sx={{ 
                        color: 'white',
                        fontWeight: 'medium',
                        fontSize: { xs: '0.85rem', sm: '0.9rem' },
                        animationName: ((track.name || '').length) > 10 ? 'scrollTextSearchComplete' : 'none'
                      }}
                    >
                      {track.name}
                    </Typography>
                  </Box>
                }
                secondary={
                  <Box sx={{ 
                    maxWidth: { xs: 'calc(100% - 150px)', sm: 'calc(100% - 170px)' },
                    overflow: 'hidden'
                  }}>
                    <Typography 
                      variant="body2" 
                      color="text.secondary" 
                      noWrap
                      sx={{ 
                        display: 'block',
                        fontSize: { xs: '0.8rem', sm: '0.875rem' },
                        maxWidth: '100%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
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
                      <Box className="scrolling-text-container" sx={{ 
                        flex: 1,
                        maxWidth: 'calc(100% - 60px)'
                      }}>
                        <Typography 
                          variant="caption" 
                          color="text.secondary"
                          className={`scrolling-text ${track.album?.name?.length > 8 ? 'scrolling-text-active' : 'scrolling-text-inactive'}`}
                          sx={{ 
                            fontSize: { xs: '0.65rem', sm: '0.7rem' },
                            animationName: track.album?.name?.length > 8 ? 'scrollTextAlbumSearchComplete' : 'none'
                          }}
                        >
                          {track.album?.name}
                        </Typography>
                      </Box>
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