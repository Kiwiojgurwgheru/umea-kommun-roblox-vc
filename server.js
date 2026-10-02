const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_USERS = 12;

/* ------------------------------------------------------------------ config */
const envNum = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const CFG = {
  radius: envNum('PROX_RADIUS', 60),          // studs: beyond this nobody hears anybody
  ref: envNum('PROX_REF_DISTANCE', 8),        // studs: inside this = full volume
  rolloff: envNum('PROX_ROLLOFF', 2),         // curve exponent (1 = linear, 2 = soft/natural)
  linkEnter: envNum('PROX_LINK_ENTER', 1.15), // WebRTC link is created at radius * this
  linkExit: envNum('PROX_LINK_EXIT', 1.3),    // ...and torn down at radius * this (hysteresis)
  tickMs: envNum('PROX_TICK_MS', 100),        // proximity recalculation interval
  staleMs: envNum('GAME_STALE_MS', 10000),    // a game server that goes silent is dropped
  codeTtlMs: envNum('VERIFY_TTL_MS', 180000), // lifetime of an in-game verification code
};
if (!(CFG.radius > 0)) CFG.radius = 60;
if (!(CFG.ref >= 0) || CFG.ref >= CFG.radius) CFG.ref = CFG.radius * 0.15;
if (CFG.linkEnter < 1) CFG.linkEnter = 1;
if (CFG.linkExit < CFG.linkEnter + 0.05) CFG.linkExit = CFG.linkEnter + 0.05;
if (!(CFG.rolloff > 0)) CFG.rolloff = 2;

const API_KEY = process.env.ROBLOX_API_KEY || '';
if (!API_KEY) console.warn('WARNING: ROBLOX_API_KEY is not set - the Roblox endpoints are disabled and nobody can verify.');

/* ------------------------------------------------------------ roblox lookup */
async function lookup(id) {
  if (!/^\d{1,12}$/.test(String(id))) return null;
  try {
    const u = await (await fetch(`https://users.roblox.com/v1/users/${id}`, { signal: AbortSignal.timeout(6000) })).json();
    if (!u.name) return null;
    let img = null;
    try {
      const t = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png`, { signal: AbortSignal.timeout(6000) })).json();
      img = t.data?.[0]?.imageUrl || null;
    } catch {}
    return { robloxId: String(id), name: u.name, displayName: u.displayName, img };
  } catch { return null; }
}

/* -------------------------------------------------------------- game state
   Only the Roblox server (authenticated with ROBLOX_API_KEY) writes this.
   Browsers can never influence a position.                                   */
const jobs = new Map();  // jobId -> { updatedAt, players: Map(userId -> rec) }
const where = new Map(); // userId -> jobId   (which Roblox server the player is in right now)
// rec = { from, to, t0, dur }  - we interpolate from -> to so gains change smoothly between updates

const JOB_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const toId = v => {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n < 1e13 ? String(n) : null;
};
const toCoord = v => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6 ? v : null);

function removePlayer(jobId, id) {
  jobs.get(jobId)?.players.delete(id);
  if (where.get(id) === jobId) where.delete(id);
}
function dropJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  for (const id of job.players.keys()) if (where.get(id) === jobId) where.delete(id);
  jobs.delete(jobId);
}
function markPresent(jobId, id) {
  const now = Date.now();
  let job = jobs.get(jobId);
  if (!job) jobs.set(jobId, job = { updatedAt: now, players: new Map() });
  if (!job.players.has(id)) job.players.set(id, { from: null, to: null, t0: now, dur: 1 });
  where.set(id, jobId);
}

function handleUpdate(b) {
  const jobId = String(b.jobId || '');
  if (!JOB_RE.test(jobId)) return [400, { ok: false, error: 'bad jobId' }];
  const ev = b.event || 'snapshot';
  if (ev === 'shutdown') { dropJob(jobId); return [200, { ok: true }]; }
  if (ev === 'leave') {
    const id = toId(b.userId);
    if (!id) return [400, { ok: false, error: 'bad userId' }];
    removePlayer(jobId, id);
    return [200, { ok: true }];
  }
  if (ev !== 'snapshot' || !Array.isArray(b.players) || b.players.length > 200) return [400, { ok: false, error: 'bad snapshot' }];

  const now = Date.now();
  let job = jobs.get(jobId);
  if (!job) jobs.set(jobId, job = { updatedAt: now, players: new Map() });
  const seen = new Set();
  for (const p of b.players) {
    const id = p && toId(p.userId);
    if (!id) continue;
    seen.add(id);
    const x = toCoord(p.x), y = toCoord(p.y), z = toCoord(p.z);
    const pos = x !== null && y !== null && z !== null ? { x, y, z } : null;
    const rec = job.players.get(id);
    if (!rec) {
      job.players.set(id, { from: pos, to: pos, t0: now, dur: 1 });
    } else if (!pos) {
      rec.from = rec.to = null; rec.t0 = now; rec.dur = 1;
    } else {
      const cur = rec.to ? interp(rec, now) : pos;
      rec.from = cur; rec.to = pos;
      rec.dur = Math.min(1000, Math.max(100, now - rec.t0));
      rec.t0 = now;
    }
    where.set(id, jobId);
  }
  for (const id of [...job.players.keys()]) if (!seen.has(id)) removePlayer(jobId, id);
  job.updatedAt = now;
  return [200, { ok: true, players: seen.size }];
}

function interp(rec, now) {
  const f = Math.min(1, Math.max(0, (now - rec.t0) / rec.dur));
  return {
    x: rec.from.x + (rec.to.x - rec.from.x) * f,
    y: rec.from.y + (rec.to.y - rec.from.y) * f,
    z: rec.from.z + (rec.to.z - rec.from.z) * f,
  };
}
function posOf(id, now) {
  const jobId = where.get(id);
  const rec = jobId && jobs.get(jobId)?.players.get(id);
  return rec && rec.to ? interp(rec, now) : null;
}

/* ------------------------------------------------------ proximity function */
function gainFor(d) {
  if (d >= CFG.radius) return 0;          // outside the radius: exactly zero
  if (d <= CFG.ref) return 1;
  const t = (d - CFG.ref) / (CFG.radius - CFG.ref);
  return Math.round(Math.pow(1 - t, CFG.rolloff) * 1000) / 1000;
}

/* --------------------------------------------------- voice sessions (ws) */
const peers = new Map();   // pid -> ws   (verified sessions only)
const pending = new Map(); // code -> { ws, robloxId, info, exp }
const links = new Map();   // "a|b" -> [initiatorPid, otherPid]  pairs allowed to exchange WebRTC signalling
let counter = 0;
const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const broadcast = (o, except) => peers.forEach((s, k) => k !== except && send(s, o));
const pairKey = (a, b) => (Number(a) < Number(b) ? a + '|' + b : b + '|' + a);

function removePeer(pid) {
  if (!peers.delete(pid)) return;
  for (const [key, l] of links) if (l[0] === pid || l[1] === pid) links.delete(key);
  broadcast({ type: 'left', pid });
}

function admit(ws, info) {
  if (peers.size >= MAX_USERS) return false;
  for (const [k, s] of [...peers]) {
    if (s.info.robloxId === info.robloxId) {
      send(s, { type: 'error', msg: 'Joined from another tab.' });
      removePeer(k);
      s.close();
    }
  }
  ws.info = { pid: ws.pid, ...info };
  send(ws, { type: 'welcome', me: ws.info, peers: [...peers.values()].map(p => p.info) });
  peers.set(ws.pid, ws);
  broadcast({ type: 'joined', peer: ws.info }, ws.pid);
  tick();
  return true;
}

/* Called by the Roblox server when the player types the code in-game. */
function handleVerify(b) {
  const jobId = String(b.jobId || '');
  const uid = toId(b.userId);
  const code = String(b.code || '');
  if (!JOB_RE.test(jobId) || !uid || !/^\d{6}$/.test(code)) return [400, { ok: false, error: 'bad request' }];
  const p = pending.get(code);
  // Same answer for "no such code" and "code belongs to someone else"
  if (!p || p.exp < Date.now() || p.robloxId !== uid || p.ws.readyState !== 1) return [200, { ok: false, error: 'invalid_or_expired' }];
  if (peers.size >= MAX_USERS) { send(p.ws, { type: 'error', msg: 'The room is full.' }); pending.delete(code); p.ws.pendingCode = null; return [200, { ok: false, error: 'room_full' }]; }
  // The game server just told us this user is in this server -> proof the player is active
  if (where.get(uid) !== jobId) markPresent(jobId, uid);
  pending.delete(code);
  p.ws.pendingCode = null;
  admit(p.ws, p.info);
  return [200, { ok: true, name: p.info.name }];
}

/* ------------------------------------------------------------------- tick */
function tick() {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.updatedAt > CFG.staleMs) dropJob(id);
  for (const [code, p] of pending) {
    if (p.exp < now) {
      pending.delete(code); p.ws.pendingCode = null;
      send(p.ws, { type: 'error', msg: 'The verification code expired. Please try again.' });
    }
  }

  const list = [];
  for (const [pid, ws] of peers) {
    const id = ws.info.robloxId;
    list.push({ pid, ws, jobId: where.get(id) || null, pos: posOf(id, now) });
  }

  const want = new Map();
  const gains = new Map(list.map(e => [e.pid, {}]));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (!a.jobId || a.jobId !== b.jobId || !a.pos || !b.pos) continue; // different server / no position -> nothing
      const key = pairKey(a.pid, b.pid);
      const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
      const limit = CFG.radius * (links.has(key) ? CFG.linkExit : CFG.linkEnter);
      if (d > limit) continue;
      want.set(key, Number(a.pid) < Number(b.pid) ? [a.pid, b.pid] : [b.pid, a.pid]);
      const g = gainFor(d);
      gains.get(a.pid)[b.pid] = g;
      gains.get(b.pid)[a.pid] = g;
    }
  }

  for (const [key, [lo, hi]] of want) {
    if (links.has(key)) continue;
    links.set(key, [lo, hi]);
    send(peers.get(lo), { type: 'connect', pid: hi, initiator: true });
    send(peers.get(hi), { type: 'connect', pid: lo, initiator: false });
  }
  for (const [key, [lo, hi]] of [...links]) {
    if (want.has(key)) continue;
    links.delete(key);
    send(peers.get(lo), { type: 'disconnect', pid: hi });
    send(peers.get(hi), { type: 'disconnect', pid: lo });
  }

  for (const e of list) {
    const msg = JSON.stringify({ type: 'prox', inGame: !!e.jobId, peers: gains.get(e.pid) });
    if (msg !== e.ws.lastProx) { e.ws.lastProx = msg; if (e.ws.readyState === 1) e.ws.send(msg); }
  }
}
setInterval(() => { try { tick(); } catch (e) { console.error('tick error', e); } }, CFG.tickMs);

/* ------------------------------------------------------------------- http */
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const authOk = req => crypto.timingSafeEqual(sha(req.headers['x-api-key'] || ''), sha(API_KEY));
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function gameApi(req, res, url) {
  if (!API_KEY) return json(res, 503, { ok: false, error: 'ROBLOX_API_KEY is not configured on the server' });
  if (!authOk(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (url === '/api/game/debug' && req.method === 'GET') {
    return json(res, 200, {
      config: CFG,
      jobs: [...jobs].map(([id, j]) => ({ id, players: [...j.players].map(([u, r]) => ({ userId: u, pos: r.to })) })),
      sessions: [...peers].map(([pid, ws]) => ({ pid, robloxId: ws.info.robloxId, jobId: where.get(ws.info.robloxId) || null })),
      links: [...links.keys()],
    });
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false });
  let body;
  try { body = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
  if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'bad body' });
  if (url === '/api/game/update') { const [s, o] = handleUpdate(body); return json(res, s, o); }
  if (url === '/api/game/verify') { const [s, o] = handleVerify(body); return json(res, s, o); }
  return json(res, 404, { ok: false });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/game/')) return await gameApi(req, res, url);
    if (url === '/healthz') return json(res, 200, { ok: true });
    if (url.startsWith('/api/roblox/')) {
      const info = await lookup(url.split('/').pop());
      res.writeHead(info ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(info || {}));
    }
    fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { ok: false });
  }
});

/* -------------------------------------------------------------- websocket */
const SIGNAL = new Set(['offer', 'answer', 'ice']);
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });

wss.on('connection', ws => {
  const pid = String(++counter);
  ws.pid = pid; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.type === 'join') {
      if (ws.info || ws.pendingCode || ws.joining) return;
      if (peers.size >= MAX_USERS) return send(ws, { type: 'error', msg: 'The room is full.' });
      const digits = String(m.id ?? '').trim();
      if (!/^\d{1,12}$/.test(digits)) return send(ws, { type: 'error', msg: 'Could not find that Roblox ID.' });
      ws.joining = true;
      const info = await lookup(String(Number(digits)));
      ws.joining = false;
      if (ws.readyState !== 1) return;
      if (!info) return send(ws, { type: 'error', msg: 'Could not find that Roblox ID.' });
      if (pending.size >= 200) return send(ws, { type: 'error', msg: 'Too many pending verifications, try again shortly.' });
      // Do NOT let the user in yet: they must prove they own the account from inside the game.
      let code;
      do { code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); } while (pending.has(code));
      pending.set(code, { ws, robloxId: info.robloxId, info, exp: Date.now() + CFG.codeTtlMs });
      ws.pendingCode = code;
      send(ws, { type: 'verify', code, ttl: Math.round(CFG.codeTtlMs / 1000) });
    } else if (ws.info && SIGNAL.has(m.type) && typeof m.to === 'string' && links.has(pairKey(pid, m.to)) && peers.get(m.to)) {
      // WebRTC signalling is only relayed between players who are currently within audible range of each other
      send(peers.get(m.to), { type: m.type, from: pid, sdp: m.sdp, candidate: m.candidate });
    }
    // anything else (including any "position" a browser might try to send) is ignored
  });

  ws.on('close', () => {
    if (ws.pendingCode) pending.delete(ws.pendingCode);
    removePeer(pid);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

server.listen(PORT, () => console.log('Umeå Kommun Roblox VC running on http://localhost:' + PORT));
