const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const socketIo = require('socket.io');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// Vérification et configuration des variables d'environnement
// Support a single .env that contains both DEV_ and PROD_ prefixed values and an APP_ENV selector.
const NODE_ENV = process.env.NODE_ENV || 'development';
// APP_ENV allows explicit selection: 'development' or 'production' (also accept 'dev'/'prod')
const APP_ENV = (process.env.APP_ENV || NODE_ENV || 'development').toString().toLowerCase();

const envKey = APP_ENV.startsWith('prod') ? 'PROD' : 'DEV';

// Helper: prefer unprefixed value, then prefixed (e.g. PROD_CLIENT_URL or DEV_CLIENT_URL)
function resolveEnv(name) {
  if (process.env[name]) return process.env[name];
  const keyed = `${envKey}_${name}`;
  if (process.env[keyed]) return process.env[keyed];
  return undefined;
}

// Prefer explicit server port variable, then generic PORT, then default 5000
const PORT = resolveEnv('PORT_SERVER') || resolveEnv('PORT') || process.env.PORT || 5000;
const CLIENT_URL = resolveEnv('CLIENT_URL') || resolveEnv('CLIENT_ORIGIN') || `http://127.0.0.1:3000`;
const API_BASE_URL = resolveEnv('API_BASE_URL') || process.env.API_BASE_URL || `http://127.0.0.1:${PORT}`;

// Vérifications des variables Spotify critiques
if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
  console.error('❌ Variables Spotify manquantes dans .env:');
  console.error('   - SPOTIFY_CLIENT_ID');
  console.error('   - SPOTIFY_CLIENT_SECRET');
  console.error('   Veuillez les configurer avant de démarrer le serveur.');
  process.exit(1);
}

console.log('🔧 Configuration du serveur:');
console.log(`   NODE_ENV: ${NODE_ENV}`);
console.log(`   PORT: ${PORT}`);
console.log(`   CLIENT_URL: ${CLIENT_URL}`);
console.log(`   API_BASE_URL: ${API_BASE_URL}`);
console.log(`   SPOTIFY_REDIRECT_URI: ${process.env.SPOTIFY_REDIRECT_URI}`);
console.log('   SSL_KEY_PATH:', `${process.env.SSL_KEY_PATH}`);
console.log('   SSL_CERT_PATH:', `${process.env.SSL_CERT_PATH}`);

const authRoutes = require('./routes/auth');
const spotifyRoutes = require('./routes/spotify');
const socketHandler = require('./socket/socketHandler');

const app = express();
const path = require('path');

// Configuration SSL using defensive loader
let server;
const isProduction = NODE_ENV === 'production';

if (isProduction) {
  const { loadSSL } = require('./ssl-config');
  const sslOptions = loadSSL();
  if (sslOptions) {
    server = https.createServer(sslOptions, app);
    console.log('🔒 HTTPS server configured with SSL certificates');
  } else {
    // Fallback to HTTP in production when SSL files are not provided.
    console.warn('⚠️ SSL non configuré ou fichiers introuvables (SSL_KEY_PATH / SSL_CERT_PATH). Démarrage en HTTP (fallback).');
    server = http.createServer(app);
  }
} else {
  // Use HTTP in development
  server = http.createServer(app);
}

const io = socketIo(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors({
  origin: CLIENT_URL,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
 
// Routes
app.use('/auth', authRoutes);
app.use('/api/spotify', spotifyRoutes);

// Serve client build in production (so client routes like /login work)
// Allow opt-in serving of client build from the backend. In a reverse-proxy
// setup (nginx serving the client on port 3000), we should avoid letting the
// backend also serve the static files to prevent the frontend being available
// on the backend port (5000). Set SERVE_CLIENT=true in the env to enable.
const SERVE_CLIENT = resolveEnv('SERVE_CLIENT') || process.env.SERVE_CLIENT;
if (isProduction && String(SERVE_CLIENT).toLowerCase() === 'true') {
  const clientBuildPath = path.join(__dirname, '..', 'client', 'build');
  try {
    app.use(express.static(clientBuildPath));

    // Return index.html for all non-API GET requests (SPA routing)
    app.get('*', (req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
      res.sendFile(path.join(clientBuildPath, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
  } catch (err) {
    console.warn('Client build not found or error serving static files:', err.message);
  }
}

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Not found' });
});

// Generic error handler (prevents unhandled exceptions from crashing the process)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  // Attach request context when possible
  try {
    console.error('Request context:', { method: req.method, url: req.originalUrl, headers: req.headers, cookies: req.cookies });
  } catch (e) {
    // ignore
  }
  const status = err?.status || 500;
  res.status(status).json({ error: err?.message || 'Internal Server Error' });
});

// Global process-level handlers to log unexpected errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason && reason.stack ? reason.stack : reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err && err.stack ? err.stack : err);
  // Do not exit — rely on PM2 restart policy if needed. But log clearly so operator can investigate.
});

// Socket.IO
socketHandler(io);
socketHandler.setIO(io);

// Health check
app.get('/health', (req, res) => {
  const protocol = isProduction ? 'HTTPS' : 'HTTP';
  res.json({ status: `Server is running with ${protocol}!` });
});

server.listen(PORT, () => {
  const protocol = isProduction ? 'HTTPS' : 'HTTP';
  console.log(`🚀 Serveur ${protocol} démarré sur le port ${PORT}`);
  console.log(`${isProduction ? '🔒' : '🔓'} Sound Party Backend ${isProduction ? 'avec SSL' : 'en mode développement'}`);
});