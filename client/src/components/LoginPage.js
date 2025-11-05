import React, { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { 
  Container, 
  Paper, 
  Typography, 
  Button, 
  Box, 
  Alert,
  CircularProgress 
} from '@mui/material';
import { MusicNote, Groups, PlayArrow } from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';

const LoginPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, authenticated, loading } = useAuth();

  useEffect(() => {
    // Vérifier les paramètres d'URL pour les messages de succès/erreur
  const success = searchParams.get('success');
  const userParam = searchParams.get('user');

    if (success === 'true' && userParam) {
      // Rediriger vers l'application principale après connexion réussie
      setTimeout(() => {
        navigate('/');
      }, 2000);
    }
  }, [searchParams, navigate]);

  useEffect(() => {
    // Si déjà authentifié, rediriger vers l'application
    if (authenticated) {
      navigate('/');
    }
  }, [authenticated, navigate]);

  const handleLogin = () => {
    login();
  };

  const getErrorMessage = (error) => {
    switch (error) {
      case 'state_mismatch':
        return 'Erreur de sécurité. Veuillez réessayer.';
      case 'authentication_failed':
        return 'Échec de l\'authentification. Veuillez réessayer.';
      default:
        return 'Une erreur est survenue. Veuillez réessayer.';
    }
  };

  if (loading) {
    return (
      <Container maxWidth="sm" sx={{ 
        minHeight: '100vh', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center' 
      }}>
        <CircularProgress size={60} />
      </Container>
    );
  }

  return (
    <Container maxWidth="sm" sx={{ 
      minHeight: '100vh', 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center',
      py: 4
    }}>
      <Paper elevation={8} sx={{ 
        p: 4, 
        textAlign: 'center',
        background: 'linear-gradient(135deg, #1e1e1e 0%, #2d2d2d 100%)',
        border: '1px solid rgba(29, 185, 84, 0.2)'
      }}>
        {/* Logo et titre */}
        <Box sx={{ mb: 4 }}>
          <MusicNote sx={{ fontSize: 60, color: '#1DB954', mb: 2 }} />
          <Typography variant="h3" component="h1" sx={{ 
            fontWeight: 'bold',
            background: 'linear-gradient(45deg, #1DB954 30%, #1ed760 90%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            mb: 1
          }}>
            Sound Party
          </Typography>
        </Box>

        {/* Description */}
        <Box sx={{ mb: 4 }}>
          <Typography variant="h6" sx={{ mb: 2, color: 'text.primary' }}>
            Contrôlez Spotify ensemble !
          </Typography>
          <Typography variant="body1" sx={{ mb: 3, color: 'text.secondary' }}>
            Connectez-vous avec plusieurs amis et gérez votre musique Spotify de manière collaborative.
          </Typography>
          
          {/* Fonctionnalités */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
              <Groups sx={{ color: '#1DB954' }} />
              <Typography variant="body2">Session collaborative multi-utilisateurs</Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
              <PlayArrow sx={{ color: '#1DB954' }} />
              <Typography variant="body2">Contrôles de lecture synchronisés</Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
              <MusicNote sx={{ color: '#1DB954' }} />
              <Typography variant="body2">File d'attente partagée</Typography>
            </Box>
          </Box>
        </Box>

        {/* Messages d'erreur/succès */}
        {searchParams.get('error') && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {getErrorMessage(searchParams.get('error'))}
          </Alert>
        )}

        {searchParams.get('success') === 'true' && searchParams.get('user') && (
          <Alert severity="success" sx={{ mb: 3 }}>
            Connexion réussie ! Bienvenue {decodeURIComponent(searchParams.get('user'))} ! 
            Redirection en cours...
          </Alert>
        )}

        {/* Bouton de connexion */}
        <Button
          variant="contained"
          size="large"
          onClick={handleLogin}
          startIcon={<MusicNote />}
          sx={{
            backgroundColor: '#1DB954',
            color: 'white',
            py: 1.5,
            px: 4,
            fontSize: '1.1rem',
            fontWeight: 'bold',
            '&:hover': {
              backgroundColor: '#1ed760',
              transform: 'translateY(-2px)',
              transition: 'all 0.3s ease'
            },
            '&:active': {
              transform: 'translateY(0)'
            }
          }}
          disabled={searchParams.get('success') === 'true'}
        >
          Se connecter avec Spotify
        </Button>

        {/* Note importante */}
        <Typography variant="caption" sx={{ 
          display: 'block', 
          mt: 3, 
          color: 'text.secondary',
          fontStyle: 'italic'
        }}>
          Note: Vous devez avoir un compte Spotify Premium ou avoir une personne avec un compte Premium pour contrôler la lecture
        </Typography>
      </Paper>
    </Container>
  );
};

export default LoginPage;