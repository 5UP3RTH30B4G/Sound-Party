import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import PlayerControls from './PlayerControls';
import SearchComponent from './SearchComponent';
import QueueComponent from './QueueComponent';
import ConnectedUsers from './ConnectedUsers';
import ChatComponent from './ChatComponent';
import NonPremiumWarning from './NonPremiumWarning';
import '../styles/theme.css';

const MainApp = () => {
  const navigate = useNavigate();
  const { user, authenticated, loading, logout, checkAuthStatus } = useAuth();
  const { connectionStatus, connectedUsers, playbackState, isSyncedWithParty, togglePartySync } = useSocket();
  const [nonPremiumAck, setNonPremiumAck] = useState(() => {
    try { return localStorage.getItem('nonPremiumAcknowledged') === '1'; } catch (e) { return false; }
  });

  useEffect(() => {
    if (!loading && !authenticated) navigate('/login');
    }, [authenticated, loading, navigate]);

  // Force non-premium users into Party mode and show a warning before entering the app
  useEffect(() => {
    if (user && user.product !== 'premium') {
      if (!isSyncedWithParty) {
        try { togglePartySync(true); } catch (e) {}
      }
    }
  }, [user, isSyncedWithParty, togglePartySync]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const handleModeToggle = () => {
    togglePartySync(!isSyncedWithParty);
  };

  if (loading) {
    return (
      <div className="app-container">
        <div className="loading-screen">
          <div className="loading-spinner"></div>
          <p>Chargement de Sound Party...</p>
        </div>
      </div>
    );
  }

  if (!authenticated) return null;

  // Show non-premium warning page if applicable
  if (user && user.product !== 'premium' && !nonPremiumAck) {
    return <NonPremiumWarning onAcknowledge={() => setNonPremiumAck(true)} />;
  }

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="header-content">
          <div className="logo-section">
            <h1 className="app-title">
              <span className="app-emoji">🎵</span>
              <span className="title-label">Sound Party</span>
            </h1>
          </div>
          
          <div className="header-info">
            <div className={`connection-status ${connectionStatus}`}>
              <span className="status-dot"></span>
              {connectionStatus === 'connected' ? 'Connecté' : 'Déconnecté'}
            </div>

            {user && user.product === 'premium' ? (
              <button 
                className={`mode-toggle-btn ${isSyncedWithParty ? 'party-mode' : 'solo-mode'}`}
                onClick={handleModeToggle}
                title={isSyncedWithParty ? 'Passer en mode Solo' : 'Passer en mode Party'}
              >
                <span className="mode-emoji">{isSyncedWithParty ? '🎉' : '🎧'}</span>
                <span className="mode-label">{isSyncedWithParty ? 'Mode Party' : 'Mode Solo'}</span>
              </button>
            ) : (
              <button 
                className={`mode-toggle-btn ${isSyncedWithParty ? 'party-mode' : 'solo-mode'}`}
                disabled
                title="Mode Solo réservé aux utilisateurs Premium"
                style={{ opacity: 0.7, cursor: 'not-allowed' }}
              >
                <span className="mode-emoji">{isSyncedWithParty ? '🎉' : '🎧'}</span>
                <span className="mode-label">{isSyncedWithParty ? 'Mode Party' : 'Mode Solo'}</span>
              </button>
            )}
            
            {user && (
              <div className="user-info">
                {user.images?.[0]?.url && (
                  <img src={user.images[0].url} alt="Avatar" className="user-avatar" />
                )}
                <span className="user-name">{user.display_name}</span>
              </div>
            )}
            
            {/* Admin simulator quick access - visible only to the designated admin Spotify id */}
            {user && String(user.id) === 'j9w2obu6y02aq4w8hy6h2585j' && (
              <button
                className="admin-sim-btn"
                onClick={() => navigate('/admin-sim')}
                title="Ouvrir l'Admin Simulator"
                style={{ marginRight: 8 }}
              >
                <span className="admin-emoji">🛠️</span>
                <span className="admin-label">Admin</span>
              </button>
            )}

            <button className="logout-btn" onClick={handleLogout} title="Se déconnecter">
              <span className="logout-emoji">🚪</span>
              <span className="logout-label">Déconnexion</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="app-main">
        <div className="main-content">
          {/* Player Section */}
          <section className="player-section">
            <PlayerControls/>
          </section>

          {/* Content Grid */}
          <div className="content-grid">
            {/* Search */}
            <section className="search-section">
              <div className="section-header">
                <h2>🔍 Recherche Musicale</h2>
              </div>
              <div className="section-content">
                <SearchComponent />
              </div>
            </section>

            {/* Queue */}
            <section className="queue-section">
              <div className="section-header">
                <h2>📋 File d'attente</h2>
                <span className="queue-count">({playbackState?.queue?.length || 0})</span>
              </div>
              <div className="section-content">
                <QueueComponent />
              </div>
            </section>

            {/* Users */}
            <section className="users-section">
              <div className="section-header">
                <h2>👥 Utilisateurs connectés</h2>
                <span className="user-count">({connectedUsers.length})</span>
              </div>
              <div className="section-content">
                <ConnectedUsers />
              </div>
            </section>

            {/* Chat */}
            <section className="chat-section">
              <div className="section-header">
                <h2>💬 Chat en direct</h2>
              </div>
              <div className="section-content">
                <ChatComponent />
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
};

export default MainApp;
