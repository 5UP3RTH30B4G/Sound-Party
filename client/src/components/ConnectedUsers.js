import React from 'react';
import {
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Avatar,
  Typography,
  Box,
  Chip,
  Tooltip
} from '@mui/material';
import { PersonAdd, MusicNote } from '@mui/icons-material';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import { Button, CircularProgress } from '@mui/material';

const ConnectedUsers = () => {
  const { connectedUsers, playbackState } = useSocket();
  const { user: authUser, authenticated, refreshToken } = useAuth();
  const [refreshing, setRefreshing] = React.useState({});

  const formatConnectedTime = (timestamp) => {
    if (!timestamp) return null;

    const now = new Date();
    const connected = new Date(timestamp);
    const diffMinutes = Math.floor((now - connected) / 60000);

    if (diffMinutes < 1) return "À l'instant";
    if (diffMinutes < 60) return `${diffMinutes}min`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}j`;
    return connected.toLocaleDateString('fr-FR');
  };

  const getUserStatus = (user) => {
    return { label: 'Connecté', color: 'success' };
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {connectedUsers && connectedUsers.length > 0 ? (
        <List sx={{ flex: 1, overflow: 'auto' }}>
          {connectedUsers.map((user) => {
            const status = getUserStatus(user);
            return (
              <ListItem
                key={user.id}
                sx={{
                  borderRadius: 1,
                  mb: 1,
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  '&:hover': {
                    backgroundColor: 'rgba(255, 255, 255, 0.1)'
                  }
                }}
              >
                <ListItemAvatar>
                  <Tooltip title={user.name}>
                    <Avatar
                      src={user.avatar}
                      alt={user.name}
                      className="user-avatar"
                      sx={{ 
                        width: 40, 
                        height: 40,
                        border: status.color === 'primary' ? '2px solid #1DB954' : '2px solid rgba(255,255,255,0.3)'
                      }}
                    >
                      {user.name.charAt(0).toUpperCase()}
                    </Avatar>
                  </Tooltip>
                </ListItemAvatar>
                
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="body2" noWrap>
                        {user.name}
                      </Typography>
                      <Chip
                        label={status.label}
                        size="small"
                        color={status.color}
                        sx={{ height: 18, fontSize: '0.7rem' }}
                      />
                      {(user.premium || user.product === 'premium') && (
                        <Chip
                          label="Premium"
                          size="small"
                          sx={{
                            height: 18,
                            fontSize: '0.7rem',
                            bgcolor: '#FFD700',
                            color: '#000',
                            fontWeight: 600,
                            borderRadius: 1
                          }}
                        />
                      )}
                      {/* If this entry is the local authenticated user but our auth state says unauthenticated,
                          show it as disconnected and provide a refresh button to attempt token refresh. */}
                      {authUser && (user.spotifyId === authUser.id) && !authenticated && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, ml: 1 }}>
                          <Button
                            size="small"
                            variant="contained"
                            color="primary"
                            onClick={async () => {
                              setRefreshing(r => ({ ...r, [user.spotifyId]: true }));
                              try {
                                await refreshToken();
                                // refreshToken will update auth context; if successful the UI will update automatically
                              } finally {
                                setRefreshing(r => ({ ...r, [user.spotifyId]: false }));
                              }
                            }}
                            disabled={!!refreshing[user.spotifyId]}
                            title="Rafraîchir le token Spotify"
                          >
                            {refreshing[user.spotifyId] ? <CircularProgress size={14} color="inherit" /> : 'Rafraîchir'}
                          </Button>
                        </Box>
                      )}
                    </Box>
                  }
                  secondary={
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        ID: {user.spotifyId}
                      </Typography>
                      {user.connectedAt ? (
                        (() => {
                          const t = formatConnectedTime(user.connectedAt);
                          if (!t) return (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              Connecté
                            </Typography>
                          );
                          // If the formatter returned "À l'instant", don't prepend "il y a"
                          const prefix = t === "À l'instant" ? 'Connecté' : 'Connecté il y a';
                          return (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              {prefix} {t}
                            </Typography>
                          );
                        })()
                      ) : (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          Connecté
                        </Typography>
                      )}
                    </Box>
                  }
                />
                
                {status.color === 'primary' && (
                  <MusicNote sx={{ color: '#1DB954', ml: 1 }} />
                )}
              </ListItem>
            );
          })}
        </List>
      ) : (
        <Box sx={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          justifyContent: 'center',
          height: '100%',
          textAlign: 'center'
        }}>
          <PersonAdd sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
          <Typography variant="h6" color="text.secondary" sx={{ mb: 1 }}>
            Aucun utilisateur connecté
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Partagez le lien pour inviter des amis !
          </Typography>
        </Box>
      )}
      
      {/* Statistiques rapides */}
      {connectedUsers && connectedUsers.length > 0 && (
        <Box sx={{ 
          mt: 2, 
          p: 2, 
          backgroundColor: 'rgba(29, 185, 84, 0.1)', 
          borderRadius: 1,
          border: '1px solid rgba(29, 185, 84, 0.2)'
        }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            Total: {connectedUsers.length} utilisateur{connectedUsers.length > 1 ? 's' : ''}
          </Typography>
          {playbackState.queue && playbackState.queue.length > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              File d'attente: {playbackState.queue.length} chanson{playbackState.queue.length > 1 ? 's' : ''}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
};

export default ConnectedUsers;