// Servidor de sinalização WebRTC + arquivos estáticos + túnel Cloudflare opcional.
// Uso: node server.js [--no-tunnel]   (PORT=3000 por padrão)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const USE_TUNNEL = !process.argv.includes('--no-tunnel');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Servidores ICE. STUN resolve a maioria dos casos; se alguém estiver atrás de
// NAT restritivo (ex.: 4G/CGNAT) configure um TURN via env ICE_SERVERS (JSON).
const ICE_SERVERS = process.env.ICE_SERVERS
  ? JSON.parse(process.env.ICE_SERVERS)
  : [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ iceServers: ICE_SERVERS }));
  }
  let file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Sessões: nome -> { passHash, salt, clients: Map<id, ws> }
// A sessão é criada por quem entra primeiro (definindo a senha, se quiser) e
// some quando o último participante sai.
// ---------------------------------------------------------------------------
const sessions = new Map();

const hash = (pass, salt) => crypto.scryptSync(pass, salt, 32);
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (session, msg, exceptId) => {
  for (const [id, c] of session.clients) if (id !== exceptId) send(c, msg);
};

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw, isBinary) => {
    // Binário = vídeo/áudio do "plano B": repassa para quem pediu, com o id
    // de quem envia (36 bytes) na frente.
    // A mensagem começa com [u8 n][n ids de 36 bytes]: para quem vai (cada
    // qualidade do plano B tem seu próprio vídeo).
    if (isBinary) {
      if (!ws.session || !raw.length) return;
      const n = raw[0];
      const cam = raw[1 + n * 36] === 0xca; // foto da câmera: vai para quem o remetente listar
      if (!cam && !ws.relayTo?.size) return;
      const to = new Set();
      for (let i = 0; i < n; i++) to.add(raw.toString('latin1', 1 + i * 36, 37 + i * 36));
      const out = Buffer.concat([Buffer.from(ws.id), raw.subarray(1 + n * 36)]);
      for (const id of cam ? to : ws.relayTo) {
        if (!to.has(id) || id === ws.id) continue;
        const target = ws.session.clients.get(id);
        if (target && target.bufferedAmount < 4 * 1024 * 1024) target.send(out);
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join' && !ws.session) {
      const name = String(msg.session || '').trim().toLowerCase().slice(0, 64);
      const nick = String(msg.name || '').trim().slice(0, 32) || 'Anônimo';
      const pass = String(msg.password || '');
      if (!name) return send(ws, { type: 'error', message: 'Informe o nome da sessão.' });

      let session = sessions.get(name);
      let created = false;
      if (!session) {
        const salt = crypto.randomBytes(16);
        session = { passHash: pass ? hash(pass, salt) : null, salt, clients: new Map() };
        sessions.set(name, session);
        created = true;
      } else if (session.passHash) {
        if (!crypto.timingSafeEqual(hash(pass, session.salt), session.passHash)) {
          return send(ws, { type: 'error', message: 'Senha incorreta.' });
        }
      }
      if (session.clients.size >= 12) return send(ws, { type: 'error', message: 'Sessão cheia (máx. 12).' });

      ws.id = crypto.randomUUID();
      ws.nick = nick;
      ws.sharing = false;
      ws.relayTo = new Set();
      ws.session = session;
      ws.sessionName = name;

      const peers = [...session.clients.values()].map((c) => ({ id: c.id, name: c.nick, sharing: c.sharing }));
      session.clients.set(ws.id, ws);
      send(ws, { type: 'joined', id: ws.id, peers, created, protected: !!session.passHash });
      broadcast(session, { type: 'peer-joined', id: ws.id, name: nick }, ws.id);
      return;
    }

    const session = ws.session;
    if (!session) return;

    switch (msg.type) {
      case 'signal': {
        const target = session.clients.get(msg.to);
        if (target) send(target, { type: 'signal', from: ws.id, data: msg.data });
        break;
      }
      case 'sharing':
        ws.sharing = !!msg.on;
        broadcast(session, { type: 'sharing', id: ws.id, on: ws.sharing }, ws.id);
        break;
      case 'relay-sub': {
        // Quem assiste pede (ou cancela) o vídeo de `to` pelo plano B.
        const target = session.clients.get(msg.to);
        if (!target || target === ws) break;
        if (msg.on) target.relayTo.add(ws.id);
        else target.relayTo.delete(ws.id);
        send(target, { type: 'relay-sub', from: ws.id, on: !!msg.on });
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 1000);
        if (text.trim()) broadcast(session, { type: 'chat', id: ws.id, name: ws.nick, text });
        break;
      }
    }
  });

  ws.on('close', () => {
    const session = ws.session;
    if (!session) return;
    session.clients.delete(ws.id);
    for (const c of session.clients.values()) c.relayTo.delete(ws.id);
    broadcast(session, { type: 'peer-left', id: ws.id });
    if (session.clients.size === 0) sessions.delete(ws.sessionName);
  });
});

// Derruba conexões mortas.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// ---------------------------------------------------------------------------
// Túnel (Cloudflare Quick Tunnel – não precisa de conta)
// ---------------------------------------------------------------------------
let tunnel;
function startTunnel() {
  tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
    windowsHide: true,
  });
  let announced = false;
  const onData = (buf) => {
    const m = !announced && buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      announced = true;
      console.log('\n  ================================================');
      console.log('   Link público (mande para os amigos):');
      console.log(`   ${m[0]}`);
      console.log('  ================================================\n');
    }
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('error', () => {
    console.log('  [túnel] cloudflared não encontrado. Instale com: winget install Cloudflare.cloudflared');
  });
  tunnel.on('exit', (code) => {
    if (code !== null && code !== 0) console.log(`  [túnel] cloudflared saiu (código ${code}).`);
  });
}

const shutdown = () => {
  if (tunnel) tunnel.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`  Local: http://localhost:${PORT}`);
  if (USE_TUNNEL) {
    console.log('  Iniciando túnel Cloudflare...');
    startTunnel();
  }
});
