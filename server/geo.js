// Route geometry + trip simulation.

const R = 6371000;
const rad = d => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function cumulative(pathPts) {
  const cum = [0];
  for (let i = 1; i < pathPts.length; i++) cum.push(cum[i - 1] + haversine(pathPts[i - 1], pathPts[i]));
  return cum;
}

// One OSRM request. Rejects answers where a stop was snapped far from where it was placed
// (the public OSRM server silently returns a wrong path for long multi-stop requests).
const MAX_SNAP_M = 3000;
async function osrmRoute(stops) {
  const coords = stops.map(s => `${s.lng},${s.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  let j;
  try { j = await (await fetch(url, { signal: ctl.signal })).json(); }
  finally { clearTimeout(timer); }
  if (j.code !== 'Ok') throw new Error(j.message || j.code);
  j.waypoints.forEach((w, i) => {
    if (w.distance > MAX_SNAP_M) throw new Error(`"${stops[i].name}" is ${Math.round(w.distance / 1000)} km from the nearest road - move its pin onto a road`);
  });
  const r = j.routes[0];
  return { coords: r.geometry.coordinates.map(c => [c[1], c[0]]), legs: r.legs.map(l => l.distance), distance: r.distance, duration: r.duration };
}

// Ask OSRM to snap the stops to roads, a few stops at a time, then stitch the pieces.
// Falls back to straight lines if it's unreachable.
const CHUNK = 6;
async function buildGeometry(stops) {
  try {
    let pts = [], legs = [], distance = 0, duration = 0;
    for (let i = 0; i < stops.length - 1; i += CHUNK - 1) {
      const part = await osrmRoute(stops.slice(i, i + CHUNK));
      pts = pts.concat(i === 0 ? part.coords : part.coords.slice(1)); // chunks share their join point
      legs = legs.concat(part.legs);
      distance += part.distance;
      duration += part.duration;
    }
    const legCum = [0];
    legs.forEach(d => legCum.push(legCum[legCum.length - 1] + d));
    const total = legCum[legCum.length - 1] || 1;
    return {
      path: pts,
      distanceM: distance,
      osrmDurationMin: duration / 60,
      stopFractions: legCum.map(d => d / total),
      snapped: true,
    };
  } catch (err) {
    const pts = stops.map(s => [s.lat, s.lng]);
    const cum = cumulative(pts);
    const total = cum[cum.length - 1] || 1;
    return {
      path: pts,
      distanceM: total,
      osrmDurationMin: total / 1000 / 30 * 60, // assume 30 km/h
      stopFractions: cum.map(d => d / total),
      snapped: false,
      warning: 'Road routing unavailable (' + err.message + '); using straight lines.',
    };
  }
}

function pointAt(route, frac) {
  const { path: p, cum } = route;
  const total = cum[cum.length - 1];
  const d = Math.min(Math.max(frac, 0), 1) * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = (d - cum[i - 1]) / seg;
  const a = p[i - 1], b = p[i];
  return { lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t, bearing: bearing(a, b) };
}

// Departure times are wall-clock times in the bus's own timezone (the server runs in UTC).
const validTz = tz => { if (typeof tz !== 'string' || !tz) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const DEFAULT_TZ = validTz(process.env.DEFAULT_TIMEZONE) ? process.env.DEFAULT_TIMEZONE : 'UTC';
const fmtCache = new Map();
function tzOffsetMs(ts, tz) { // how far wall-clock time in tz is ahead of UTC at instant ts
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second) - Math.floor(ts / 1000) * 1000;
}

// "HH:MM" on the current calendar day in timezone tz -> epoch ms
function todayAt(hhmm, now, tz = DEFAULT_TZ) {
  const [h, m] = hhmm.split(':').map(Number);
  const off = tzOffsetMs(now, tz);
  const local = new Date(now + off);
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m);
  let ts = guess - off;
  const off2 = tzOffsetMs(ts, tz); // offset can differ across a DST change
  if (off2 !== off) ts = guess - off2;
  return ts;
}

// Work out where a bus is right now.
function busState(bus, route, now = Date.now()) {
  const dur = route.durationMin * 60000;
  const departures = (bus.departures || []).slice().sort();
  const tz = validTz(bus.timezone) ? bus.timezone : DEFAULT_TZ;
  let start = null;

  if (bus.tripStart && now >= bus.tripStart && now - bus.tripStart <= dur) {
    start = bus.tripStart; // manual "start now" trip
  } else {
    for (const t of departures) { // yesterday's departure too: an overnight trip is still running after midnight
      const today = todayAt(t, now, tz);
      for (const s of [today - 86400000, today]) if (s <= now && now - s <= dur && (start === null || s > start)) start = s;
    }
  }

  const base = {
    id: bus.id, name: bus.name, plate: bus.plate, routeId: bus.routeId,
    active: bus.active !== false,
  };

  if (bus.active === false) return { ...base, status: 'inactive' };

  if (start !== null) {
    const progress = (now - start) / dur;
    const pos = pointAt(route, progress);
    const stops = route.stops.map((s, i) => ({
      name: s.name,
      etaMin: Math.max(0, Math.round(((route.stopFractions[i] - progress) * dur) / 60000)),
      passed: route.stopFractions[i] <= progress,
    }));
    const next = stops.find(s => !s.passed);
    return { ...base, status: 'running', progress, ...pos, startedAt: start, stops, nextStop: next || null };
  }

  // not running: find next departure
  let next = departures.map(t => todayAt(t, now, tz)).find(s => s > now);
  if (!next && departures.length) next = todayAt(departures[0], now, tz) + 86400000;
  if (bus.tripStart && bus.tripStart > now) next = Math.min(next ?? Infinity, bus.tripStart);
  const first = route.path[0];
  return { ...base, status: 'scheduled', progress: 0, lat: first[0], lng: first[1], bearing: 0, nextDeparture: next || null };
}

// ---------- realistic trip schedule ----------
// Turns a route + start/end time into a time->position timeline that
//  - halts at intermediate stops for route.stops[i].haltMin minutes,
//  - eases out of / into the origin, stops and destination,
//  - slows for sharp turns and cruises on straights.
// The trip still starts at startAt and reaches the destination exactly at endAt.

const DEFAULT_HALT_MIN = 2;

// Add points along long segments so speed can change smoothly. Points stay collinear,
// so a point's fraction of total distance is the same on the original path.
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const parts = Math.ceil(haversine(a, b) / step);
    for (let k = 1; k < parts; k++) out.push([a[0] + ((b[0] - a[0]) * k) / parts, a[1] + ((b[1] - a[1]) * k) / parts]);
    out.push(b);
  }
  return out;
}

// For each stop, the index of the nearest path point at or after the previous stop's.
function stopIndices(pts, stops) {
  const last = pts.length - 1;
  const idx = [0];
  for (let s = 1; s < stops.length - 1; s++) {
    let best = idx[s - 1], bestD = Infinity;
    for (let i = idx[s - 1]; i <= last; i++) {
      const d = haversine(pts[i], [stops[s].lat, stops[s].lng]);
      if (d < bestD) { bestD = d; best = i; }
    }
    idx.push(best);
  }
  idx.push(last);
  return idx;
}

function speedFactors(pts, cum, stopDists) {
  const n = pts.length;
  const turn = new Array(n).fill(1);
  let b = 0, f = 0;
  for (let i = 1; i < n - 1; i++) {
    while (b + 1 < i && cum[i] - cum[b + 1] >= 30) b++;
    f = Math.max(f, i + 1);
    while (f < n - 1 && cum[f] - cum[i] < 30) f++;
    const diff = Math.abs(((bearing(pts[b], pts[i]) - bearing(pts[i], pts[f]) + 540) % 360) - 180);
    turn[i] = 1 - 0.7 * Math.min(1, diff / 80); // 80°+ turn -> 30% speed
  }
  // a slowdown covers the ~80 m around the turn, not just one point
  const v = new Array(n);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    while (cum[i] - cum[lo] > 80) lo++;
    while (hi + 1 < n && cum[hi + 1] - cum[i] <= 80) hi++;
    let m = 1;
    for (let j = lo; j <= hi; j++) if (turn[j] < m) m = turn[j];
    let d = Infinity;
    for (const sd of stopDists) d = Math.min(d, Math.abs(cum[i] - sd));
    v[i] = Math.max(0.2, Math.min(m, 0.3 + (0.7 * d) / 350)); // ramp up over 350 m from a stop
  }
  return v;
}

// Drop keyframes the client could recreate by interpolating, keeping every position within `tolM` metres.
// Halts (flat stretches) and speed changes survive because dropping them would exceed the tolerance.
function thin(tl, total, tolM = 3) {
  const keep = new Uint8Array(tl.length);
  keep[0] = keep[tl.length - 1] = 1;
  const stack = [[0, tl.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = 0, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const k = tl[b][0] === tl[a][0] ? 0 : (tl[i][0] - tl[a][0]) / (tl[b][0] - tl[a][0]);
      const err = Math.abs(tl[i][1] - (tl[a][1] + (tl[b][1] - tl[a][1]) * k)) * total;
      if (err > worst) { worst = err; wi = i; }
    }
    if (wi >= 0 && worst > tolM) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return tl.filter((_, i) => keep[i]);
}

function buildSchedule(route, startAt, endAt) {
  const durMs = endAt - startAt;
  const rawTotal = route.cum[route.cum.length - 1];
  const pts = densify(route.path, Math.max(40, rawTotal / 4000));
  const cum = cumulative(pts);
  const total = cum[cum.length - 1] || 1;
  const n = pts.length;
  const idx = stopIndices(pts, route.stops);
  const last = route.stops.length - 1;
  const haltMs = route.stops.map((s, i) => (i === 0 || i === last ? 0 : Math.round(Math.max(0, Math.min(60, s.haltMin ?? DEFAULT_HALT_MIN)) * 60000)));
  const haltTotal = haltMs.reduce((a, b) => a + b, 0);
  const travelMs = durMs - haltTotal;
  if (travelMs < 60000) {
    throw new Error(`Trip is too short: the stops alone take ${Math.round(haltTotal / 60000)} min. Make the trip longer or shorten the halt times.`);
  }

  const v = speedFactors(pts, cum, idx.map(i => cum[i]));
  const w = [0];
  let W = 0;
  for (let i = 1; i < n; i++) { W += (cum[i] - cum[i - 1]) / ((v[i - 1] + v[i]) / 2); w.push(W); }

  const atVertex = new Map(); // vertex -> stop numbers halting there
  idx.forEach((vi, s) => { if (haltMs[s] > 0) atVertex.set(vi, [...(atVertex.get(vi) || []), s]); });

  const timeline = [[0, 0]];
  const stops = route.stops.map(() => ({ arrive: 0, depart: 0 }));
  let halted = 0;
  const addHalts = (i, t) => {
    for (const s of atVertex.get(i) || []) {
      stops[s].arrive = t;
      t += haltMs[s];
      stops[s].depart = t;
      timeline.push([t, +(cum[i] / total).toFixed(6)]);
    }
    return t;
  };
  halted = addHalts(0, 0) - 0;
  for (let i = 1; i < n; i++) {
    let t = Math.round((w[i] / W) * travelMs + halted);
    timeline.push([t, +(cum[i] / total).toFixed(6)]);
    const t2 = addHalts(i, t);
    halted += t2 - t;
  }
  timeline[timeline.length - 1] = [durMs, 1];
  stops[last] = { arrive: durMs, depart: durMs };
  // stops without a halt: arrive when the bus passes them
  route.stops.forEach((s, i) => {
    if (i > 0 && i < last && haltMs[i] === 0) {
      const f = cum[idx[i]] / total;
      const k = timeline.findIndex(p => p[1] >= f);
      stops[i] = { arrive: timeline[Math.max(0, k)][0], depart: timeline[Math.max(0, k)][0] };
    }
  });
  const avgKmh = total / 1000 / (travelMs / 3600000);
  return { timeline: thin(timeline, total), stops, haltMin: haltTotal / 60000, avgKmh };
}

module.exports = { buildGeometry, cumulative, busState, pointAt, buildSchedule, todayAt, validTz };
