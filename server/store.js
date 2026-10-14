const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Storage: Postgres when DATABASE_URL is set (production), JSON files in data/ otherwise (local dev).
// Everything is held in memory and written through on save(); the rest of the server stays synchronous.
// In Postgres each record is its own row, and save() writes only the rows that changed.
// Single-instance design: run one server process (the in-memory copy is the source of truth).
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
  pool.on('error', e => console.error('! Database connection error:', e.message));
}

// ---------- Postgres: one table per collection, one row per record ----------
const TABLES = { users: () => auth.users, routes: () => db.routes, buses: () => db.buses, trips: () => db.trips };
const shadow = Object.fromEntries(Object.keys(TABLES).map(t => [t, new Map()])); // id -> JSON last written
let queue = Promise.resolve();

function diff() {
  const ops = [];
  for (const [table, get] of Object.entries(TABLES)) {
    const seen = new Set();
    for (const rec of get()) {
      const json = JSON.stringify(rec);
      seen.add(rec.id);
      if (shadow[table].get(rec.id) !== json) { ops.push({ table, id: rec.id, owner: rec.ownerId || null, json }); shadow[table].set(rec.id, json); }
    }
    for (const rid of [...shadow[table].keys()]) {
      if (!seen.has(rid)) { ops.push({ table, id: rid, del: true }); shadow[table].delete(rid); }
    }
  }
  return ops;
}

async function runOps(ops) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const o of ops) {
      if (o.del) await client.query(`DELETE FROM ${o.table} WHERE id = $1`, [o.id]);
      else await client.query(
        `INSERT INTO ${o.table} (id, owner_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, data = EXCLUDED.data`,
        [o.id, o.owner, o.json]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

function enqueue(ops) {
  if (!ops.length) return;
  queue = queue.then(async () => {
    for (let attempt = 1; ; attempt++) {
      try { return await runOps(ops); }
      catch (e) {
        console.error(`! Database write failed (attempt ${attempt}):`, e.message);
        if (attempt >= 5) return; // give up on this batch; the next change re-diffs only what it touches
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  });
}

const save = () => { if (pool) enqueue(diff()); else writeJson(DB_FILE, db); };
const saveAuth = () => { if (pool) enqueue(diff()); else writeJson(AUTH_FILE, auth); };
const flush = () => queue; // resolves once every queued write has finished (used on shutdown)

async function setupPostgres() {
  for (const t of Object.keys(TABLES)) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${t} (id text PRIMARY KEY, owner_id text, data jsonb NOT NULL)`);
  }
  await pool.query('CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value text NOT NULL)');
  const meta = Object.fromEntries((await pool.query('SELECT key, value FROM meta')).rows.map(r => [r.key, r.value]));

  const load = async t => (await pool.query(`SELECT id, data FROM ${t}`)).rows.map(r => r.data);
  let loaded = { users: await load('users'), routes: await load('routes'), buses: await load('buses'), trips: await load('trips') };
  for (const t of Object.keys(TABLES)) for (const rec of loaded[t]) shadow[t].set(rec.id, JSON.stringify(rec));
  auth.users = loaded.users; db.routes = loaded.routes; db.buses = loaded.buses; db.trips = loaded.trips;
  auth.secret = meta.secret || '';

  if (!meta.migrated) {
    // First start on these tables: import from the earlier single-blob "kv" table if it exists, else from the bundled seed file.
    let old = {};
    try { for (const r of (await pool.query('SELECT key, value FROM kv')).rows) old[r.key] = r.value; } catch { /* no kv table */ }
    const seed = old.db || readJson(DB_FILE) || {};
    db.routes = seed.routes || []; db.buses = seed.buses || []; db.trips = seed.trips || [];
    auth.users = old.auth?.users || [];
    auth.secret = old.auth?.secret || auth.secret;
    await pool.query("INSERT INTO meta (key, value) VALUES ('migrated', '1') ON CONFLICT (key) DO NOTHING");
  }
  if (!auth.secret) auth.secret = crypto.randomBytes(32).toString('hex');
  await pool.query("INSERT INTO meta (key, value) VALUES ('secret', $1) ON CONFLICT (key) DO NOTHING", [auth.secret]);
  auth.secret = (await pool.query("SELECT value FROM meta WHERE key = 'secret'")).rows[0].value;
  enqueue(diff()); // writes anything that was just migrated
  await flush();
}

// Must finish before the server starts listening.
async function init() {
  if (pool) {
    await setupPostgres();
  } else {
    Object.assign(db, readJson(DB_FILE) || {});
    Object.assign(auth, readJson(AUTH_FILE) || {});
    if (!auth.secret) auth.secret = crypto.randomBytes(32).toString('hex');
  }
  for (const k of ['routes', 'buses', 'trips']) if (!Array.isArray(db[k])) db[k] = [];
  if (!Array.isArray(auth.users)) auth.users = [];
  if (!pool) { save(); saveAuth(); }
  console.log(pool ? 'Storage: Postgres' : 'Storage: local files in data/');
}

const id = () => crypto.randomBytes(5).toString('hex');

module.exports = { db, save, id, auth, saveAuth, init, flush };
