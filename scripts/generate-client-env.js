#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Small .env parser (no deps)
function parseDotEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const src = fs.readFileSync(filePath, 'utf8');
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.substring(0, eq).trim();
    let val = trimmed.substring(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.substring(1, val.length - 1);
    }
    out[key] = val;
  }
  return out;
}

const rootEnvPath = path.join(process.cwd(), '.env');
const rootEnv = parseDotEnv(rootEnvPath);
// Merge into process.env but keep existing env overrides
for (const k of Object.keys(rootEnv)) {
  if (!process.env[k]) process.env[k] = rootEnv[k];
}

const APP_ENV = (process.env.APP_ENV || process.env.NODE_ENV || 'development').toLowerCase();
const envKey = APP_ENV.startsWith('prod') ? 'PROD' : 'DEV';

function resolve(name) {
  if (process.env[name]) return process.env[name];
  const key = `${envKey}_${name}`;
  if (process.env[key]) return process.env[key];
  return undefined;
}

// Build server and client URLs
const apiBase = resolve('API_BASE_URL') || `http://127.0.0.1:${process.env.PORT_SERVER || process.env.PORT || 5000}`;
const clientHost = resolve('CLIENT_URL') || `http://127.0.0.1:${process.env.PORT_CLIENT || 3000}`;

const clientEnv = {
  REACT_APP_API_BASE_URL: apiBase,
  REACT_APP_API_URL: apiBase,
  REACT_APP_SERVER_URL: apiBase,
  REACT_APP_CLIENT_URL: clientHost,
  REACT_APP_SPOTIFY_REDIRECT_URI: resolve('SPOTIFY_REDIRECT_URI') || ''
};

const clientOut = Object.entries(clientEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
const clientDest = path.join(process.cwd(), 'client', '.env.local');
try {
  fs.writeFileSync(clientDest, clientOut, { encoding: 'utf8' });
  try { const s = fs.statSync(clientDest); console.log(`Wrote client env to ${clientDest} (${s.size} bytes) with APP_ENV=${APP_ENV}`); } catch(e) { console.log(`Wrote client env to ${clientDest} with APP_ENV=${APP_ENV}`); }
} catch (err) {
  console.warn(`Failed to write ${clientDest}: ${err && err.message ? err.message : err}`);
}

// Server env
const serverEnv = {
  NODE_ENV: process.env.NODE_ENV || APP_ENV,
  PORT: resolve('PORT') || resolve('PORT') || process.env.PORT || '5000',
  PORT: resolve('PORT') || process.env.PORT || '3000',
  CLIENT_URL: resolve('CLIENT_URL') || clientHost,
  API_BASE_URL: resolve('API_BASE_URL') || apiBase,
  SPOTIFY_CLIENT_ID: resolve('SPOTIFY_CLIENT_ID') || '',
  SPOTIFY_CLIENT_SECRET: resolve('SPOTIFY_CLIENT_SECRET') || '',
  SPOTIFY_REDIRECT_URI: resolve('SPOTIFY_REDIRECT_URI') || '',
  SSL_KEY_PATH: resolve('SSL_KEY_PATH') || '',
  SSL_CERT_PATH: resolve('SSL_CERT_PATH') || ''
};

const serverOut = Object.entries(serverEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
const serverDest = path.join(process.cwd(), 'server', '.env');
try {
  fs.writeFileSync(serverDest, serverOut, { encoding: 'utf8' });
  try { const s = fs.statSync(serverDest); console.log(`Wrote server env to ${serverDest} (${s.size} bytes) with APP_ENV=${APP_ENV}`); } catch(e) { console.log(`Wrote server env to ${serverDest} with APP_ENV=${APP_ENV}`); }
} catch (err) {
  console.warn(`Could not write ${serverDest}: ${err && err.message ? err.message : err}. Falling back to server/.env.local`);
  try {
    const fallback = path.join(process.cwd(), 'server', '.env.local');
    fs.writeFileSync(fallback, serverOut, { encoding: 'utf8' });
    try { const s = fs.statSync(fallback); console.log(`Wrote server env to fallback ${fallback} (${s.size} bytes) with APP_ENV=${APP_ENV}`); } catch(e) { console.log(`Wrote server env to fallback ${fallback} with APP_ENV=${APP_ENV}`); }
  } catch (err2) {
    console.error('Failed to write server env fallback file as well:', err2 && err2.message ? err2.message : err2);
    throw err;
  }
}

// Final summary
console.log('\nGeneration summary:');
console.log(`  client file: ${fs.existsSync(clientDest) ? clientDest : 'missing'}`);
console.log(`  server file: ${fs.existsSync(serverDest) ? serverDest : (fs.existsSync(path.join(process.cwd(),'server','.env.local')) ? path.join(process.cwd(),'server','.env.local') : 'missing')}`);

process.exit(0);
