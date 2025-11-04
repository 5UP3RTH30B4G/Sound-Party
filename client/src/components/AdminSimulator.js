import React, { useState } from 'react';
import { Box, Card, CardContent, Typography, Button, TextField, Divider, Switch, FormControlLabel } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

// Admin-only simulator/debug page
// Access control: set REACT_APP_ADMIN_SPOTIFY_ID to the Spotify id that should be allowed

const AdminSimulator = () => {
  const { user } = useAuth();
  const {
    playbackState,
    partyState,
    connectedUsers,
    emitPlayNextFromQueue,
    emitTrackQueued,
    emitTrackRemovedFromQueue,
    emitPlaybackControl,
    socket
  } = useSocket();

  // Allow configuring the admin id via env, otherwise fallback to the developer's Spotify id
  const defaultAdminId = 'j9w2obu6y02aq4w8hy6h2585j';
  const adminId = process.env.REACT_APP_ADMIN_SPOTIFY_ID || defaultAdminId;
  const [simulateNonPremium, setSimulateNonPremium] = useState(() => {
    try { return localStorage.getItem('simulate_non_premium') === '1'; } catch (e) { return false; }
  });
  const [testUri, setTestUri] = useState('spotify:track:3n3Ppam7vgaVa1iaRUc9Lp');
  const [log, setLog] = useState('');

  const appendLog = (s) => setLog(prev => `${new Date().toISOString()} - ${s}\n` + prev);

  // Simple access guard — only the configured admin id (or the fallback id) may access
  if (!user || String(user.id) !== String(adminId)) {
    return (
      <Box sx={{ p: 3 }}>
        <Card>
          <CardContent>
            <Typography variant="h6">Access denied</Typography>
            <Typography sx={{ mt: 1 }}>This simulator page is restricted. You are not authorized.</Typography>
            <Typography sx={{ mt: 1 }}>Logged user: {user?.display_name || 'none'}</Typography>
            <Typography sx={{ mt: 1 }}>Expected admin id: {adminId}</Typography>
          </CardContent>
        </Card>
      </Box>
    );
  }

  const toggleSimNonPremium = () => {
    try { localStorage.setItem('simulate_non_premium', simulateNonPremium ? '0' : '1'); } catch (e) {}
    setSimulateNonPremium(v => !v);
    appendLog(`simulate_non_premium => ${!simulateNonPremium}`);
  };

  const handleEmitPlayNext = () => {
    try {
      if (emitPlayNextFromQueue) emitPlayNextFromQueue();
      appendLog('Emitted play_next_from_queue');
    } catch (e) { appendLog('Error emitting play_next_from_queue: ' + e.message); }
  };

  const handleQueueTestTrack = async () => {
    try {
      const fake = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        name: 'Admin Test Track',
        artists: [{ name: 'Admin' }],
        uri: testUri,
        album: { name: 'Admin Single', images: [] },
        duration_ms: 180000
      };
      if (emitTrackQueued) emitTrackQueued(fake);
      appendLog(`Queued test track ${testUri}`);
    } catch (e) { appendLog('Error queueing test track: ' + e.message); }
  };

  const handleClearQueue = () => {
    try {
      const q = (partyState && partyState.queue) || (playbackState && playbackState.queue) || [];
      q.slice().forEach(item => {
        try { if (emitTrackRemovedFromQueue) emitTrackRemovedFromQueue(item.id); } catch (e) { appendLog('remove error: ' + e.message); }
      });
      appendLog('Requested removal of all queue items (for current state)');
    } catch (e) { appendLog('Error clearing queue: ' + e.message); }
  };

  const handleForcePlayOnSocket = () => {
    try {
      // If we have an active socket and connectedUsers include others, pick first
      const other = connectedUsers && connectedUsers.length > 0 ? connectedUsers[0] : null;
      appendLog('Connected users: ' + JSON.stringify((connectedUsers || []).map(u => u.name)));
      if (other) {
        // emit an event only the server will use (for debug) - we can't force other sockets directly
        appendLog('Note: cannot force playback on other sockets from here; use play_next or instruct clients manually.');
      } else {
        appendLog('No connected users to force.');
      }
    } catch (e) { appendLog('Error in force play: ' + e.message); }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6">Admin Simulator</Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>You are authorized as admin: {user.display_name}</Typography>

          <Divider sx={{ my: 2 }} />

          <FormControlLabel
            control={<Switch checked={simulateNonPremium} onChange={toggleSimNonPremium} />}
            label="Simulate non-premium for this browser (local)"
          />
          <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>When enabled, client-side checks that gate Solo based on user.product may be overridden if you implement that check in your code to read localStorage 'simulate_non_premium'. This page stores the flag locally.</Typography>

          <Divider sx={{ my: 2 }} />

          <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
            <Button variant="contained" onClick={handleEmitPlayNext}>Emit play_next_from_queue</Button>
            <Button variant="outlined" onClick={handleForcePlayOnSocket}>Inspect connected users</Button>
          </Box>

          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2 }}>
            <TextField label="Test track URI" value={testUri} onChange={(e) => setTestUri(e.target.value)} sx={{ flex: 1 }} />
            <Button variant="contained" onClick={handleQueueTestTrack}>Queue test track</Button>
            <Button color="error" variant="outlined" onClick={handleClearQueue}>Clear current queue</Button>
          </Box>

        </CardContent>
      </Card>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6">Server State (party & playback)</Typography>
          <Typography variant="caption">partyState</Typography>
          <Box component="pre" sx={{ maxHeight: 220, overflow: 'auto', bgcolor: '#0b0b0b', p: 1, mt: 1 }}>{JSON.stringify(partyState, null, 2)}</Box>
          <Typography variant="caption" sx={{ mt: 1 }}>playbackState</Typography>
          <Box component="pre" sx={{ maxHeight: 220, overflow: 'auto', bgcolor: '#0b0b0b', p: 1, mt: 1 }}>{JSON.stringify(playbackState, null, 2)}</Box>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="h6">Connected users</Typography>
          <Box component="pre" sx={{ maxHeight: 200, overflow: 'auto', bgcolor: '#0b0b0b', p: 1, mt: 1 }}>{JSON.stringify(connectedUsers, null, 2)}</Box>
        </CardContent>
      </Card>

      <Card sx={{ mt: 2 }}>
        <CardContent>
          <Typography variant="h6">Action Log</Typography>
          <Box component="pre" sx={{ maxHeight: 240, overflow: 'auto', bgcolor: '#0b0b0b', p: 1, mt: 1 }}>{log || 'no actions yet'}</Box>
        </CardContent>
      </Card>
    </Box>
  );
};

export default AdminSimulator;
