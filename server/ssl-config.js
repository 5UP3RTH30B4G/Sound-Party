const fs = require('fs');
const https = require('https');

// Defensive SSL loader: do not attempt to read files at module import time.
// Call loadSSL() at runtime and handle missing / unreadable files gracefully.
function loadSSL() {
  const sslKeyPath = process.env.SSL_KEY_PATH;
  const sslCertPath = process.env.SSL_CERT_PATH;

  if (!sslKeyPath || !sslCertPath) {
    return null;
  }

  try {
    const sslOptions = {
      key: fs.readFileSync(sslKeyPath),
      cert: fs.readFileSync(sslCertPath)
    };
    return sslOptions;
  } catch (err) {
    console.error('❌ Failed to read SSL files:', err.message);
    return null;
  }
}

module.exports = { loadSSL, https };