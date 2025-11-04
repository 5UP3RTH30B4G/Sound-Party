import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { io } from 'socket.io-client';

import LoginPage from './components/LoginPage';
import MainApp from './components/MainApp';
import AdminSimulator from './components/AdminSimulator';
import { AuthProvider } from './contexts/AuthContext';
import { SocketProvider } from './contexts/SocketContext';
import './styles/theme.css';

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#1DB954', // Vert Spotify
    },
    secondary: {
      main: '#1ed760',
    },
    background: {
      default: '#121212',
      paper: '#1e1e1e',
    },
  },
  typography: {
    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
  },
});

function App() {
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    // Initialiser la connexion Socket.IO
    // Use same origin for Socket.IO in production (served by nginx)
    const defaultDevServer = `http://127.0.0.1:${process.env.PORT_SERVER || process.env.PORT || 5000}`;
    const serverUrl = process.env.NODE_ENV === 'production'
      ? window.location.origin
      : (process.env.REACT_APP_SERVER_URL || process.env.REACT_APP_API_BASE_URL || defaultDevServer);
    console.log('🔌 Connecting to Socket.IO server:', serverUrl);
    const newSocket = io(serverUrl);
    setSocket(newSocket);

    return () => {
      if (newSocket) {
        newSocket.disconnect();
      }
    };
  }, []);

  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      <AuthProvider>
        <SocketProvider socket={socket}>
          <Router>
            <div className="App app-shell">
                  <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/admin-sim" element={<AdminSimulator />} />
                    <Route path="/" element={<MainApp />} />
                  </Routes>
            </div>
          </Router>
        </SocketProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
