import React from 'react';
import { Box, Card, CardContent, Typography, Button } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';

const NonPremiumWarning = ({ onAcknowledge }) => {
  const { user } = useAuth();

  const handleAcknowledge = () => {
    try {
      localStorage.setItem('nonPremiumAcknowledged', '1');
    } catch (e) {}
    if (onAcknowledge) onAcknowledge();
  };

  return (
    <Box sx={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Card sx={{ maxWidth: 720 }}>
        <CardContent>
          <Typography variant="h5" sx={{ mb: 1 }}>
            Accès limité — Compte non premium
          </Typography>
          <Typography sx={{ mb: 2 }}>
            Bonjour {user?.display_name || 'utilisateur'}. Votre compte n'est pas un compte Spotify Premium.
            Pour garantir une expérience de lecture partagée et respecter les limitations de l'API,
            l'accès Solo est réservé aux utilisateurs Premium. Vous pouvez cependant utiliser le mode Party
            pour gérer et participer avec les autres participants premium.
          </Typography>

          <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
            <Button variant="contained" color="primary" onClick={handleAcknowledge}>
              Continuer en Mode Party
            </Button>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
};

export default NonPremiumWarning;
