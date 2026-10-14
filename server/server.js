const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { db, save, id, auth, saveAuth, init } = require('./store');
const { buildGeometry, cumulative, busState, buildSchedule } = require('./geo');

const PORT = process.env.PORT || 3000;
const secret = () => process.env.TOKEN_SECRET || auth.secret; // auth.secret is generated once and stored with the accounts
const TOKEN_TTL = 12 * 3600 * 1000;

const compression = require('compression');
const app = express();
app.use(compression({ filter: (req, res) => req.path !== '/api/live' && compression.filter(req, res) })); // gzip everything except the live event stream
app.use((req, res, next) => { // the frontend may be hosted elsewhere (Vercel); auth uses a bearer header, not cookies, so * is safe
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- auth ----------
const sign = payload => crypto.createHmac('sha256', secret()).update(payload).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function requireAdmin(req, res, next) {
  const [uid, exp, sig] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  const user = auth.users.find(u => u.id === uid);
  if (!user || !exp || !sig || !safeEq(sign(`${uid}.${exp}`), sig) || Date.now() > Number(exp)) {
    return res.status(401).json({ error: 'Not authorised' });
  }
  req.user = user;
  next();
}

const issueToken = user => {
  const exp = String(Date.now() + TOKEN_TTL);
  return `${user.id}.${exp}.${sign(`${user.id}.${exp}`)}`;
};
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');

const attempts = new Map(); // ip -> {n, until}
function throttle(req, res) {
  const a = attempts.get(req.ip);
  if (a && a.n >= 8 && Date.now() < a.until) { res.status(429).json({ error: 'Too many attempts, try again in a minute' }); return false; }
  return true;
}
const fail = req => {
  const a = attempts.get(req.ip);
  attempts.set(req.ip, { n: (a && Date.now() < a.until ? a.n : 0) + 1, until: Date.now() + 60000 });
};

app.post('/api/auth/register', (req, res) => {
  if (!throttle(req, res)) return;
  fail(req); // counts toward the limit so signups can't be spammed
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-30 letters, numbers, . _ -' });
  if (password.length < 6 || password.length > 200) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (auth.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'That username is taken' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: id(), username, salt, hash: hashPassword(password, salt), createdAt: Date.now() };
  const first = auth.users.length === 0;
  auth.users.push(user);
  saveAuth();
  if (first) { // data created before accounts existed goes to the first account
    for (const list of [db.routes, db.buses, db.trips]) for (const x of list) if (!x.ownerId) x.ownerId = user.id;
    save();
  }
  res.status(201).json({ token: issueToken(user), username });
});

app.post('/api/auth/login', (req, res) => {
  if (!throttle(req, res)) return;
  const { username = '', password = '' } = req.body || {};
  const user = auth.users.find(u => u.username.toLowerCase() === String(username).trim().toLowerCase());
  if (user && safeEq(hashPassword(String(password), user.salt), user.hash)) {
    attempts.delete(req.ip);
    return res.json({ token: issueToken(user), username: user.username });
  }
  fail(req);
  res.status(401).json({ error: 'Wrong username or password' });
});

const mine = (list, req) => list.filter(x => x.ownerId === req.user.id);
const findMine = (list, req, idv) => list.find(x => x.id === idv && x.ownerId === req.user.id);

// ---------- helpers ----------
const num = v => typeof v === 'number' && Number.isFinite(v);

function cleanStops(stops) {
  if (!Array.isArray(stops) || stops.length < 2) throw new Error('A route needs at least 2 stops');
  if (stops.length > 25) throw new Error('Maximum 25 stops per route');
  return stops.map((s, i) => {
    if (!num(s.lat) || !num(s.lng) || Math.abs(s.lat) > 90 || Math.abs(s.lng) > 180) throw new Error(`Stop ${i + 1} has invalid coordinates`);
    const middle = i > 0 && i < stops.length - 1;
    const halt = Number(s.haltMin ?? 2);
    if (middle && !(halt >= 0 && halt <= 60)) throw new Error(`Halt time at "${s.name || `Stop ${i + 1}`}" must be 0-60 minutes`);
    return { name: String(s.name || `Stop ${i + 1}`).slice(0, 80), lat: s.lat, lng: s.lng, haltMin: middle ? halt : 0 };
  });
}

function cleanDepartures(list) {
  const out = (Array.isArray(list) ? list : []).map(String).map(s => s.trim()).filter(Boolean);
  for (const t of out) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`"${t}" is not a valid HH:MM time`);
  return [...new Set(out)].sort();
}

const wrap = fn => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
};

const publicRoute = r => ({
  id: r.id, name: r.name, stops: r.stops, path: r.path, stopFractions: r.stopFractions,
  distanceM: r.distanceM, durationMin: r.durationMin, snapped: r.snapped,
});

// ---------- admin API ----------
app.post('/api/admin/routes/preview', requireAdmin, wrap(async (req, res) => {
  const stops = cleanStops(req.body.stops);
  const g = await buildGeometry(stops);
  res.json({ path: g.path, distanceM: g.distanceM, suggestedDurationMin: Math.max(1, Math.round(g.osrmDurationMin)), snapped: g.snapped, warning: g.warning });
}));

async function writeRoute(route, body) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('Route name is required');
  const stops = cleanStops(body.stops);
  const g = await buildGeometry(stops);
  const durationMin = Number(body.durationMin) || Math.max(1, Math.round(g.osrmDurationMin));
  if (durationMin < 1 || durationMin > 1440) throw new Error('Duration must be between 1 and 1440 minutes');
  Object.assign(route, {
    name: name.slice(0, 80), stops, path: g.path, cum: cumulative(g.path), stopFractions: g.stopFractions,
    distanceM: g.distanceM, durationMin, snapped: g.snapped,
  });
  return route;
}

app.get('/api/admin/routes', requireAdmin, (req, res) => res.json(mine(db.routes, req).map(publicRoute)));

app.post('/api/admin/routes', requireAdmin, wrap(async (req, res) => {
  const route = await writeRoute({ id: id(), ownerId: req.user.id }, req.body);
  db.routes.push(route);
  save();
  res.status(201).json(publicRoute(route));
}));

app.put('/api/admin/routes/:id', requireAdmin, wrap(async (req, res) => {
  const route = findMine(db.routes, req, req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found' });
  await writeRoute(route, req.body);
  save();
  res.json(publicRoute(route));
}));

app.delete('/api/admin/routes/:id', requireAdmin, (req, res) => {
  if (!findMine(db.routes, req, req.params.id)) return res.status(404).json({ error: 'Route not found' });
  if (db.buses.some(b => b.routeId === req.params.id)) return res.status(409).json({ error: 'Remove the buses on this route first' });
  if (db.trips.some(t => t.routeId === req.params.id)) return res.status(409).json({ error: 'Delete the trips on this route first' });
  db.routes = db.routes.filter(r => r.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.get('/api/admin/buses', requireAdmin, (req, res) => res.json(mine(db.buses, req)));

function writeBus(bus, body, req) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('Bus name is required');
  if (!findMine(db.routes, req, body.routeId)) throw new Error('Choose a valid route');
  Object.assign(bus, {
    name: name.slice(0, 60), plate: String(body.plate || '').trim().slice(0, 20), routeId: body.routeId,
    departures: cleanDepartures(body.departures), active: body.active !== false,
  });
  return bus;
}

app.post('/api/admin/buses', requireAdmin, wrap(async (req, res) => {
  const bus = writeBus({ id: id(), ownerId: req.user.id }, req.body, req);
  db.buses.push(bus);
  save();
  res.status(201).json(bus);
}));

app.put('/api/admin/buses/:id', requireAdmin, wrap(async (req, res) => {
  const bus = findMine(db.buses, req, req.params.id);
  if (!bus) return res.status(404).json({ error: 'Bus not found' });
  writeBus(bus, req.body, req);
  save();
  res.json(bus);
}));

app.post('/api/admin/buses/:id/start-now', requireAdmin, (req, res) => {
  const bus = findMine(db.buses, req, req.params.id);
  if (!bus) return res.status(404).json({ error: 'Bus not found' });
  bus.tripStart = Date.now();
  save();
  res.json(bus);
});

app.post('/api/admin/buses/:id/stop', requireAdmin, (req, res) => {
  const bus = findMine(db.buses, req, req.params.id);
  if (!bus) return res.status(404).json({ error: 'Bus not found' });
  delete bus.tripStart;
  save();
  res.json(bus);
});

app.delete('/api/admin/buses/:id', requireAdmin, (req, res) => {
  if (!findMine(db.buses, req, req.params.id)) return res.status(404).json({ error: 'Bus not found' });
  db.buses = db.buses.filter(b => b.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// ---------- trips (shareable live-tracking links) ----------
const baseUrl = req => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const endOf = t => t.endAt ?? t.startAt + t.durationMin * 60000;
const tripView = (t, req) => ({ ...t, endAt: endOf(t), url: `${baseUrl(req)}/t/${t.id}` });

app.get('/api/admin/trips', requireAdmin, (req, res) => res.json(mine(db.trips, req).map(t => tripView(t, req))));

app.post('/api/admin/trips', requireAdmin, wrap(async (req, res) => {
  const route = findMine(db.routes, req, req.body.routeId);
  if (!route) throw new Error('Choose a valid route');
  const busName = String(req.body.busName || '').trim();
  if (!busName) throw new Error('Bus name is required');
  const startAt = Number(req.body.startAt);
  const endAt = Number(req.body.endAt);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) throw new Error('Start and end date/time are required');
  if (startAt < Date.now() - 86400000 || startAt > Date.now() + 365 * 86400000) throw new Error('Invalid start time');
  if (endAt <= startAt) throw new Error('End time must be after the start time');
  if (endAt - startAt > 7 * 86400000) throw new Error('A trip can be at most 7 days long');
  const trip = { id: crypto.randomBytes(6).toString('hex'), ownerId: req.user.id, routeId: route.id, busName: busName.slice(0, 60), plate: String(req.body.plate || '').trim().slice(0, 20), startAt, endAt, createdAt: Date.now() };
  buildSchedule(route, startAt, endAt); // throws a friendly error if the halts don't fit in the trip time
  db.trips.push(trip);
  save();
  res.status(201).json(tripView(trip, req));
}));

app.delete('/api/admin/trips/:id', requireAdmin, (req, res) => {
  if (!findMine(db.trips, req, req.params.id)) return res.status(404).json({ error: 'Trip not found' });
  db.trips = db.trips.filter(t => t.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// Public: everything the link page needs. The browser animates the bus itself using serverNow to correct clock drift.
// A trip's schedule only changes if its times or its route's stops/halts change, so build it once.
const scheduleCache = new Map();
const scheduleKey = (trip, route) => [trip.id, trip.startAt, endOf(trip), route.path.length, route.stops.map(s => `${s.lat},${s.lng},${s.haltMin}`).join(';')].join('|');
// Short fingerprint of everything the trip page was built from. If it changes, open pages reload.
const tripRev = (trip, route) => crypto.createHash('md5').update(scheduleKey(trip, route)).digest('hex').slice(0, 10);

function scheduleFor(trip, route) {
  const key = scheduleKey(trip, route);
  let sch = scheduleCache.get(key);
  if (!sch) {
    sch = buildSchedule(route, trip.startAt, endOf(trip));
    scheduleCache.set(key, sch);
    if (scheduleCache.size > 100) scheduleCache.delete(scheduleCache.keys().next().value); // keep memory bounded
  }
  return sch;
}

// Tiny heartbeat for the trip page: proves the connection works, corrects its clock, and flags edits.
app.get('/api/trips/:id/ping', (req, res) => {
  const t = db.trips.find(x => x.id === req.params.id);
  const route = t && db.routes.find(r => r.id === t.routeId);
  res.set('Cache-Control', 'no-store');
  if (!t || !route) return res.status(404).json({ error: 'gone' });
  res.json({ serverNow: Date.now(), rev: tripRev(t, route) });
});

app.get('/api/trips/:id', (req, res) => {
  const t = db.trips.find(x => x.id === req.params.id);
  const route = t && db.routes.find(r => r.id === t.routeId);
  if (!t || !route) return res.status(404).json({ error: 'This trip link is not valid or has been removed.' });
  let schedule;
  try { schedule = scheduleFor(t, route); }
  catch (e) { return res.status(409).json({ error: e.message }); }
  res.json({
    trip: { busName: t.busName, plate: t.plate, startAt: t.startAt, endAt: endOf(t) },
    route: { name: route.name, stops: route.stops, path: route.path },
    schedule,
    rev: tripRev(t, route),
    serverNow: Date.now(),
  });
});

app.get('/t/:id', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'trip.html')));

// ---------- public API (rider app) ----------
app.get('/api/routes', (req, res) => res.json(db.routes.map(publicRoute)));

function liveBuses(routeId) {
  const now = Date.now();
  return db.buses
    .filter(b => !routeId || b.routeId === routeId)
    .map(b => {
      const route = db.routes.find(r => r.id === b.routeId);
      return route ? busState(b, route, now) : null;
    })
    .filter(Boolean);
}

app.get('/api/buses', (req, res) => res.json(liveBuses(req.query.routeId)));

// Server-Sent Events: pushes bus positions to every connected rider.
const clients = new Set();
app.get('/api/live', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(liveBuses())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

setInterval(() => {
  if (!clients.size) return;
  const msg = `data: ${JSON.stringify(liveBuses())}\n\n`;
  for (const c of clients) c.write(msg);
}, 2000);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

init().then(() => {
  app.listen(PORT, () => {
    console.log(`Bus tracker:   http://localhost:${PORT}`);
    console.log(`Admin:         http://localhost:${PORT}/admin.html`);
  });
}).catch(e => { console.error('Failed to start:', e.message); process.exit(1); });
