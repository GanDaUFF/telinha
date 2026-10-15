// Versão Cloudflare Workers do server.js: cada sessão é um Durable Object.
// Os arquivos de public/ são servidos como static assets (ver wrangler.jsonc).

import { DurableObject } from 'cloudflare:workers';

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const MAX_CLIENTS = 12;
// Quem cai (internet piscou, celular trocou de rede...) tem esse tempo para
// voltar com o mesmo id, sem que os outros vejam a pessoa sair.
const GRACE_MS = 30000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/config') {
      const iceServers = env.ICE_SERVERS ? JSON.parse(env.ICE_SERVERS) : ICE_SERVERS;
      return Response.json({ iceServers });
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Esperado WebSocket', { status: 426 });
      const name = normalize(url.searchParams.get('s'));
      if (!name) return new Response('Sessão inválida', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(request);
    }
    return new Response('404', { status: 404 });
  },
};

const normalize = (s) => String(s || '').trim().toLowerCase().slice(0, 64);
const enc = new TextEncoder();
const dec = new TextDecoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

async function hash(pass, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: 100000 },
    key,
    256,
  );
  return toHex(bits);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Pings do cliente são respondidos sem acordar o objeto.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.pending = new Map(); // id de quem caiu -> sinais WebRTC guardados para a volta
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({});
    return new Response(null, { status: 101, webSocket: client });
  }

  // Participantes conectados agora (exceto `except`).
  members(except) {
    return this.ctx.getWebSockets().filter((w) => w !== except && w.deserializeAttachment()?.id);
  }

  byId(id) {
    return this.members().find((w) => w.deserializeAttachment().id === id);
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  broadcast(msg, except) {
    for (const w of this.members(except)) this.send(w, msg);
  }

  // Cada participante tem um registro "m:<id>" que sobrevive à queda da conexão.
  async records() {
    return [...(await this.ctx.storage.list({ prefix: 'm:' })).values()];
  }

  // Lista de quem está na sessão (exceto `self`): conectados + quem caiu e ainda pode voltar.
  async roster(self) {
    const live = this.members().map((w) => w.deserializeAttachment());
    const liveIds = new Set(live.map((a) => a.id));
    const away = (await this.records()).filter((r) => !liveIds.has(r.id));
    return [
      ...live.map((a) => ({ id: a.id, name: a.nick, sharing: a.sharing })),
      ...away.map((r) => ({ id: r.id, name: r.nick, sharing: !!r.sharing, away: true })),
    ].filter((p) => p.id !== self);
  }

  async webSocketMessage(ws, raw) {
    const me = ws.deserializeAttachment() || {};

    // Binário = vídeo/áudio do "plano B": repassa para quem pediu, com o id
    // de quem envia (36 bytes) na frente. A mensagem começa com
    // [u8 n][n ids de 36 bytes]: para quem vai (cada qualidade tem seu vídeo).
    if (typeof raw !== 'string') {
      if (!me.id || !raw.byteLength) return;
      const bytes = new Uint8Array(raw);
      const n = bytes[0];
      // Fotos da câmera (plano B da câmera) vão para qualquer um da sala que
      // o remetente listar; o resto só para quem pediu o plano B dessa tela.
      const cam = bytes[1 + n * 36] === 0xca;
      if (!cam && !me.relayTo?.length) return;
      const to = new Set();
      for (let i = 0; i < n; i++) to.add(dec.decode(bytes.subarray(1 + i * 36, 37 + i * 36)));
      const body = bytes.subarray(1 + n * 36);
      const out = new Uint8Array(36 + body.length);
      out.set(enc.encode(me.id));
      out.set(body, 36);
      for (const w of this.members(ws)) {
        const id = w.deserializeAttachment().id;
        if (!to.has(id) || (!cam && !me.relayTo.includes(id))) continue;
        try {
          w.send(out);
        } catch {}
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join' && !me.id) {
      if (msg.resume) return this.resume(ws, msg.resume);
      const nick = String(msg.name || '').trim().slice(0, 32) || 'Anônimo';
      const pass = String(msg.password || '');
      const others = await this.roster();

      let created = false;
      let auth = await this.ctx.storage.get('auth');
      if (others.length === 0) {
        // Sessão nova (ou vazia): quem chega define a senha.
        const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
        auth = { salt, hash: pass ? await hash(pass, salt) : null };
        await this.ctx.storage.put('auth', auth);
        created = true;
      } else if (auth?.hash) {
        const given = enc.encode(await hash(pass, auth.salt));
        if (!crypto.subtle.timingSafeEqual(given, enc.encode(auth.hash))) {
          return this.send(ws, { type: 'error', message: 'Senha incorreta.' });
        }
      }
      if (others.length >= MAX_CLIENTS) {
        return this.send(ws, { type: 'error', message: `Sessão cheia (máx. ${MAX_CLIENTS}).` });
      }

      const id = crypto.randomUUID();
      const token = crypto.randomUUID(); // permite voltar com o mesmo id se a conexão cair
      ws.serializeAttachment({ id, nick, sharing: false, relayTo: [] });
      await this.ctx.storage.put('m:' + id, { id, nick, token, sharing: false, relayTo: [] });
      this.send(ws, { type: 'joined', id, token, peers: others, created, protected: !!auth?.hash });
      this.broadcast({ type: 'peer-joined', id, name: nick }, ws);
      if (others.some((p) => p.away)) await this.ensureAlarm();
      return;
    }

    if (!me.id) return;

    switch (msg.type) {
      case 'signal': {
        const target = this.byId(msg.to);
        const out = { type: 'signal', from: me.id, data: msg.data };
        if (target) {
          this.send(target, out);
        } else if (typeof msg.to === 'string' && (await this.ctx.storage.get('m:' + msg.to))) {
          // Caiu e deve voltar logo: guarda para entregar na volta.
          const q = this.pending.get(msg.to) || [];
          if (q.length < 200) q.push(out);
          this.pending.set(msg.to, q);
        }
        break;
      }
      case 'sharing':
        if (me.sharing === !!msg.on) break;
        me.sharing = !!msg.on;
        ws.serializeAttachment(me);
        this.broadcast({ type: 'sharing', id: me.id, on: me.sharing }, ws);
        break;
      case 'relay-sub': {
        // Quem assiste pede (ou cancela) o vídeo de `to` pelo plano B.
        const target = this.byId(msg.to);
        if (!target || target === ws) break;
        const a = target.deserializeAttachment();
        a.relayTo = (a.relayTo || []).filter((id) => id !== me.id);
        if (msg.on) a.relayTo.push(me.id);
        target.serializeAttachment(a);
        this.send(target, { type: 'relay-sub', from: me.id, on: !!msg.on });
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').slice(0, 1000);
        if (text.trim()) this.broadcast({ type: 'chat', id: me.id, name: me.nick, text });
        break;
      }
      case 'leave': // botão "Sair": sai na hora, sem período de tolerância
        ws.serializeAttachment({});
        await this.forget(me.id);
        try {
          ws.close(1000, 'saiu');
        } catch {}
        break;
    }
  }

  // Volta de quem caiu: mesmo id e mesmo estado, sem pedir a senha de novo.
  async resume(ws, { id, token }) {
    const rec = typeof id === 'string' && (await this.ctx.storage.get('m:' + id));
    if (!rec || !token || rec.token !== token) {
      return this.send(ws, { type: 'error', code: 'expired', message: 'Seu lugar na sessão expirou.' });
    }
    // A conexão antiga pode ainda parecer aberta aqui (caiu sem avisar).
    const old = this.byId(id);
    let me;
    if (old) {
      me = old.deserializeAttachment();
      old.serializeAttachment({});
      try {
        old.close(4001, 'reconectou');
      } catch {}
    } else {
      me = { id, nick: rec.nick, sharing: !!rec.sharing, relayTo: rec.relayTo || [] };
    }
    ws.serializeAttachment(me);
    if (rec.away) await this.ctx.storage.put('m:' + id, { ...rec, away: null });
    const auth = await this.ctx.storage.get('auth');
    this.send(ws, { type: 'joined', id, token, peers: await this.roster(id), resumed: true, protected: !!auth?.hash });
    this.broadcast({ type: 'peer-back', id, sharing: me.sharing }, ws);
    for (const m of this.pending.get(id) || []) this.send(ws, m);
    this.pending.delete(id);
  }

  async webSocketClose(ws) {
    // Responde o fechamento (1005/1006 não podem ser reenviados, por isso 1000).
    try {
      ws.close(1000, 'tchau');
    } catch {}
    await this.drop(ws);
  }

  async webSocketError(ws) {
    await this.drop(ws);
  }

  // Conexão caiu: guarda o lugar por GRACE_MS antes de avisar que a pessoa saiu.
  async drop(ws) {
    const me = ws.deserializeAttachment();
    if (!me?.id) return;
    ws.serializeAttachment({});
    const rec = await this.ctx.storage.get('m:' + me.id);
    if (!rec) return;
    await this.ctx.storage.put('m:' + me.id, { ...rec, sharing: me.sharing, relayTo: me.relayTo, away: Date.now() });
    this.broadcast({ type: 'peer-away', id: me.id }, ws);
    await this.ensureAlarm();
  }

  async ensureAlarm() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 5000);
  }

  // Confere quem caiu e não voltou a tempo.
  async alarm() {
    const live = new Set(this.members().map((w) => w.deserializeAttachment().id));
    const now = Date.now();
    let waiting = false;
    for (const r of await this.records()) {
      if (live.has(r.id)) continue;
      if (!r.away) {
        // Sem registro da queda (ex.: o servidor reiniciou): começa a contar agora.
        await this.ctx.storage.put('m:' + r.id, { ...r, away: now });
        this.broadcast({ type: 'peer-away', id: r.id });
        waiting = true;
      } else if (now - r.away > GRACE_MS) {
        await this.forget(r.id);
      } else {
        waiting = true;
      }
    }
    if (waiting) await this.ctx.storage.setAlarm(Date.now() + 5000);
  }

  // Saída definitiva.
  async forget(id) {
    await this.ctx.storage.delete('m:' + id);
    this.pending.delete(id);
    this.broadcast({ type: 'peer-left', id });
    for (const w of this.members()) {
      const a = w.deserializeAttachment();
      if (!a.relayTo?.includes(id)) continue;
      a.relayTo = a.relayTo.filter((x) => x !== id);
      w.serializeAttachment(a);
    }
    if (this.members().length === 0 && (await this.records()).length === 0) await this.ctx.storage.deleteAll();
  }
}
