const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const MAX_USERS = 12;

async function lookup(id) {
  if (!/^\d{1,12}$/.test(String(id))) return null;
  try {
    const u = await (await fetch(`https://users.roblox.com/v1/users/${id}`)).json();
    if (!u.name) return null;
    let img = null;
    try {
      const t = await (await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png`)).json();
      img = t.data?.[0]?.imageUrl || null;
    } catch {}
    return { robloxId: String(id), name: u.name, displayName: u.displayName, img };
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/roblox/')) {
    const info = await lookup(req.url.split('/').pop());
    res.writeHead(info ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(info || {}));
  }
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
    res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(d);
  });
});

const wss = new WebSocketServer({ server });
const peers = new Map();
let counter = 0;
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const broadcast = (o, except) => peers.forEach((s, k) => k !== except && send(s, o));

wss.on('connection', ws => {
  const pid = String(++counter);
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join' && !ws.info) {
      if (peers.size >= MAX_USERS) return send(ws, { type: 'error', msg: 'The room is full.' });
      const info = await lookup(m.id);
      if (!info) return send(ws, { type: 'error', msg: 'Could not find that Roblox ID.' });
      for (const [k, s] of peers) if (s.info.robloxId === info.robloxId) { send(s, { type: 'error', msg: 'Joined from another tab.' }); s.close(); }
      ws.info = { pid, ...info };
      send(ws, { type: 'welcome', me: ws.info, peers: [...peers.values()].map(p => p.info) });
      peers.set(pid, ws);
      broadcast({ type: 'joined', peer: ws.info }, pid);
    } else if (ws.info && m.to && peers.get(m.to) && ['offer', 'answer', 'ice'].includes(m.type)) {
      send(peers.get(m.to), { ...m, from: pid });
    }
  });
  ws.on('close', () => { if (peers.delete(pid)) broadcast({ type: 'left', pid }); });
});

server.listen(PORT, () => console.log('Umeå Kommun Roblox VC running on http://localhost:' + PORT));
