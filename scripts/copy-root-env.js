#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const src = path.join(root, '.env');

function safeCopy(dest) {
  try {
    if (!fs.existsSync(src)) {
      console.warn(`Root .env not found at ${src}, skipping copy to ${dest}`);
      return false;
    }
    const data = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(dest, data, { encoding: 'utf8' });
    try {
      const s = fs.statSync(dest);
      console.log(`Copied ${src} -> ${dest} (${s.size} bytes, mtime=${s.mtime.toISOString()})`);
    } catch (e) {
      console.log(`Copied ${src} -> ${dest}`);
    }
    return true;
  } catch (err) {
    console.warn(`Failed to copy ${src} -> ${dest}: ${err && err.message ? err.message : err}`);
    return false;
  }
}

// Attempt to copy to client/.env and server/.env
const clientDest = path.join(root, 'client', '.env');
const serverDest = path.join(root, 'server', '.env');

let okClient = safeCopy(clientDest);
let okServer = safeCopy(serverDest);

// If direct server copy fails due to OneDrive lock, try server/.env.local
if (!okServer) {
  const fallback = path.join(root, 'server', '.env.local');
  if (safeCopy(fallback)) {
    try { const s = fs.statSync(fallback); console.log(`Wrote fallback server env to ${fallback} (${s.size} bytes, mtime=${s.mtime.toISOString()})`); } catch(e) { console.log(`Wrote fallback server env to ${fallback}`); }
  }
}

// Similarly for client fallback
if (!okClient) {
  const fallbackClient = path.join(root, 'client', '.env.local');
  if (safeCopy(fallbackClient)) {
    try { const s = fs.statSync(fallbackClient); console.log(`Wrote fallback client env to ${fallbackClient} (${s.size} bytes, mtime=${s.mtime.toISOString()})`); } catch(e) { console.log(`Wrote fallback client env to ${fallbackClient}`); }
  }
}

// Final summary
console.log('\nCopy summary:');
console.log(`  client: ${okClient ? 'copied' : 'not-copied'}`);
console.log(`  server: ${okServer ? 'copied' : 'not-copied'}`);

// Exit success even if copies partially failed; generator will still regenerate files if needed
process.exit(0);
