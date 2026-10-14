const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Storage: Postgres when DATABASE_URL is set (production), JSON files in data/ otherwise (local dev).
// Everything is held in memory and written through on save(), so the rest of the server stays synchronous.
const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
const AUTH_FILE = path.join(__dirname, '..', 'data', 'auth.json'); // gitignored: holds password hashes

const db = { routes: [], buses: [], trips: [] };
const auth = { users: [], secret: '' };

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // atomic replace so a crash can't corrupt the file
}

let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 3 });
}

// One row per document, writes coalesced: while a write is in flight, further saves just mark it dirty.
const writers = {};
function persist(key, value, file) {
  if (!pool) return writeJson(file, value);
  const w = writers[key] || (writers[key] = { running: false, dirty: false });
  w.dirty = true;
  if (w.running) return;
  w.running = true;
  (async () => {
    while (w.dirty) {
      w.dirty = false;
      try {
        await pool.query(
          'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
          [key, JSON.stringify(value)]);
      } catch (e) { console.error(`! Failed to save "${key}" to the database:`, e.message); w.dirty = true; await new Promise(r => setTimeout(r, 2000)); }
    }
    w.running = false;
  })();
}

const save = () => persist('db', db, DB_FILE);
const saveAuth = () => persist('auth', auth, AUTH_FILE);

// Must finish before the server starts listening.
async function init() {
  let storedDb, storedAuth;
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb NOT NULL)');
    const { rows } = await pool.query('SELECT key, value FROM kv');
    storedDb = rows.find(r => r.key === 'db')?.value;
    storedAuth = rows.find(r => r.key === 'auth')?.value;
    storedDb = storedDb || readJson(DB_FILE); // first run on a fresh database: seed from the bundled data file
  } else {
    storedDb = readJson(DB_FILE);
    storedAuth = readJson(AUTH_FILE);
  }
  Object.assign(db, storedDb || {});
  Object.assign(auth, storedAuth || {});
  for (const k of ['routes', 'buses', 'trips']) if (!Array.isArray(db[k])) db[k] = [];
  if (!Array.isArray(auth.users)) auth.users = [];
  if (!auth.secret) auth.secret = crypto.randomBytes(32).toString('hex');
  save();
  saveAuth();
  console.log(pool ? 'Storage: Postgres' : 'Storage: local files in data/');
}

const id = () => crypto.randomBytes(5).toString('hex');

module.exports = { db, save, id, auth, saveAuth, init };
