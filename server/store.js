const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'db.json');
let db = { routes: [], buses: [], trips: [] };

try {
  db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch { /* first run */ }

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE); // atomic replace so a crash can't corrupt the file
}

// Accounts + signing secret live in their own file (gitignored) so they never get committed.
const AUTH_FILE = path.join(__dirname, '..', 'data', 'auth.json');
let auth = { users: [], secret: '' };
try { auth = { ...auth, ...JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) }; } catch { /* first run */ }
if (!auth.secret) auth.secret = crypto.randomBytes(32).toString('hex');

function saveAuth() {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  const tmp = AUTH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2));
  fs.renameSync(tmp, AUTH_FILE);
}
saveAuth();

const id = () => crypto.randomBytes(5).toString('hex');

module.exports = { db, save, id, auth, saveAuth };
