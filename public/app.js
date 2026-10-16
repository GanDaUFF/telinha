'use strict';

const $ = (id) => document.getElementById(id);

// Versão mostrada no canto da tela (aumente a cada deploy).
const APP_VERSION = '1.13.2';
$('appVersion').textContent = 'Telinha v' + APP_VERSION + (window.telinhaApp ? ' · app' : '');

let ws;
let myId;
let myName;
let iceServers = [];
let localStream = null;
const peers = new Map(); // id -> { name, sharing, pc, polite, makingOffer, ignoreOffer, senders, noRelay, ... }
const tiles = new Map(); // id -> elemento .tile

// ?planoB=1 na URL força o plano B (útil para testar).
const FORCE_RELAY = new URLSearchParams(location.search).get('planoB') === '1';
// Troca automática entre conexão direta e plano B (ver checkConnections):
const DIRECT_TIMEOUT = 8000; // sem conexão direta por esse tempo -> plano B
const RELAY_TIMEOUT = 8000; // plano B sem imagem por esse tempo -> tenta direto
const DIRECT_RECOVER = 10000; // direta estável por esse tempo -> sai do plano B

// ---------------------------------------------------------------------------
// ⚙ Configurações (ficam salvas neste navegador)
// ---------------------------------------------------------------------------
const settings = { codec: 'auto', smooth: 'normal', preview: true, game: false, gamePrev: null, appAudio: 'nodiscord', clips: '720', clipLen: 30 };
try { Object.assign(settings, JSON.parse(localStorage.getItem('telinhaCfg') || '{}')); } catch {}
const saveSettings = () => { try { localStorage.setItem('telinhaCfg', JSON.stringify(settings)); } catch {} };

// Suavidade de quem assiste: quanto atraso aceitar para não engasgar (ms).
// direct = alvo do buffer do WebRTC (null = o navegador decide, como antes);
// relay = atraso da fila do plano B (que chega em lotes de 100 ms).
const SMOOTH = {
  low: { direct: null, relay: 120 },
  normal: { direct: 150, relay: 220 },
  smooth: { direct: 400, relay: 450 },
};
const smoothCfg = () => SMOOTH[settings.smooth] || SMOOTH.normal;
const smoothDelay = () => smoothCfg().relay;

function setJitter(receiver) {
  try {
    if (receiver && 'jitterBufferTarget' in receiver) receiver.jitterBufferTarget = smoothCfg().direct;
  } catch {}
}

function applySmooth() {
  for (const p of peers.values()) p.pc?.getReceivers().forEach(setJitter);
  for (const r of relayIn.values()) r.base = undefined; // refaz o relógio
}

(function setupSettings() {
  const caps = (window.RTCRtpSender && RTCRtpSender.getCapabilities('video')?.codecs) || [];
  const has = (m) => caps.some((c) => c.mimeType.toLowerCase() === 'video/' + m);
  for (const opt of [...$('codec').options]) if (opt.value !== 'auto' && !has(opt.value)) opt.remove();
  if (![...$('codec').options].some((o) => o.value === settings.codec)) settings.codec = 'auto';
  $('codec').value = settings.codec;
  $('smooth').value = settings.smooth;
  $('settingsBtn').addEventListener('click', () => ($('settingsPanel').hidden = !$('settingsPanel').hidden));
  $('settingsClose').addEventListener('click', () => ($('settingsPanel').hidden = true));
  $('codec').addEventListener('change', () => {
    settings.codec = $('codec').value;
    saveSettings();
    if (!localStream) return;
    // Troca na hora: renegocia cada conexão com a nova ordem de codecs.
    for (const p of peers.values()) {
      if (!p.pc) continue;
      preferCodec(p.pc);
      p.pc.onnegotiationneeded?.();
    }
    toast('Codec trocado.');
  });
  $('clips').value = settings.clips;
  $('clipLen').value = String(settings.clipLen);
  if (!clipsSupported()) {
    $('clips').value = 'off';
    $('clips').disabled = true;
  }
  $('clips').addEventListener('change', () => {
    settings.clips = $('clips').value;
    saveSettings();
    refreshClips();
  });
  $('clipLen').addEventListener('change', () => {
    settings.clipLen = Number($('clipLen').value);
    saveSettings();
  });
  $('smooth').addEventListener('change', () => {
    settings.smooth = $('smooth').value;
    saveSettings();
    applySmooth();
  });
})();

// 🎮 Modo jogo: pesa menos no PC de quem joga e transmite.
// H.264 = compressão na placa de vídeo (não disputa o processador com o jogo),
// 720p/30 fps = menos trabalho, e sem a prévia (um vídeo a menos para desenhar).
const GAME = { quality: 'media', mode: 'motion', fps: '30', codec: 'h264', preview: false };

function setSelect(id, value) {
  const el = $(id);
  if (!el || ![...el.options].some((o) => o.value === value) || el.value === value) return;
  el.value = value;
  el.dispatchEvent(new Event('change'));
}

function setGameMode(on) {
  if (on === settings.game) return;
  if (on) {
    settings.gamePrev = {
      quality: $('quality').value,
      mode: $('mode').value,
      fps: $('fps').value,
      codec: settings.codec,
      preview: settings.preview,
    };
  }
  const cfg = on ? GAME : settings.gamePrev || { quality: 'auto', mode: 'detail', fps: '30', codec: 'auto', preview: true };
  settings.game = on;
  for (const k of ['quality', 'mode', 'fps', 'codec']) setSelect(k, cfg[k]);
  setPreview(cfg.preview);
  saveSettings();
  updateGameBtn();
}

function updateGameBtn() {
  $('gameBtn').classList.toggle('on', settings.game);
  $('gameBtn').textContent = settings.game ? '🎮 Modo jogo: ligado' : '🎮 Modo jogo';
}

$('gameBtn').addEventListener('click', () => {
  setGameMode(!settings.game);
  toast(settings.game ? 'Modo jogo: 720p, 30 fps, placa de vídeo e sem prévia. Pesa bem menos no PC.' : 'Modo jogo desligado: configurações de antes de volta.');
});

// Prévia da própria tela: escondida economiza a placa de vídeo.
function setPreview(on) {
  settings.preview = on;
  saveSettings();
  const tile = tiles.get(myId);
  if (!tile || !localStream) return;
  const video = tile.querySelector('video');
  if (video) video.srcObject = on ? localStream : null;
  tile.classList.toggle('nopreview', !on);
  const btn = tile.querySelector('.pv');
  if (btn) btn.textContent = on ? '🙈 Ocultar prévia' : '👁 Mostrar prévia';
}

// Volta com o modo jogo como ficou da última vez.
if (settings.game) {
  for (const k of ['quality', 'mode', 'fps']) setSelect(k, GAME[k]);
}
updateGameBtn();

// ---------------------------------------------------------------------------
// App do Telinha para Windows (desktop/): o som vem do telinha-audio.exe, que
// captura por programa (dá para deixar o Discord de fora). No navegador
// comum `telinhaApp` não existe e nada disso roda.
// ---------------------------------------------------------------------------
const nativeApp = window.telinhaApp || null;
let nativeAudio = null; // { gen, writer, ts }

if (nativeApp) {
  document.documentElement.classList.add('in-app');
  $('appAudioRow').hidden = false;
  $('appAudio').value = settings.appAudio;
  $('appAudio').addEventListener('change', () => {
    settings.appAudio = $('appAudio').value;
    saveSettings();
    if (nativeAudio) nativeApp.startAudio(settings.appAudio); // troca na hora
  });
  nativeApp.onAudio((bytes) => {
    const a = nativeAudio;
    if (!a) return;
    const frames = bytes.byteLength / 8;
    if (!frames) return;
    // Cópia: o Float32Array precisa começar alinhado.
    const data = new Float32Array(bytes.slice().buffer);
    const audio = new AudioData({ format: 'f32', sampleRate: 48000, numberOfChannels: 2, numberOfFrames: frames, timestamp: a.ts, data });
    a.ts += (frames / 48000) * 1e6;
    a.writer.write(audio).catch(() => {});
  });
  nativeApp.onAudioStopped(() => {
    if (nativeAudio) toast('O som da transmissão parou (telinha-audio fechou). Pare e compartilhe de novo.');
  });
}

// Versão nova do app (.exe) publicada no site? Mostra o botão "Atualizar app".
// (Mudanças só no site chegam sozinhas: o app abre o site publicado.)
const newerVersion = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function checkAppUpdate() {
  try {
    const [mine, info] = await Promise.all([nativeApp.info(), fetch('download/app.json', { cache: 'no-cache' }).then((r) => r.json())]);
    if (!info.version || !newerVersion(info.version, mine.version)) return;
    $('updateBtn').textContent = `Atualizar app (v${info.version})`;
    $('updateBtn').hidden = false;
    $('updateBtn').onclick = () => downloadApp();
    toast(`Tem versão nova do app (v${info.version}). Clique em "Atualizar app" lá em cima.`, 8000);
  } catch {}
}
if (nativeApp) checkAppUpdate();

// Cria a trilha de áudio a partir do som que o app captura.
async function startNativeAudio() {
  if (!nativeApp || !('MediaStreamTrackGenerator' in window)) return null;
  const gen = new MediaStreamTrackGenerator({ kind: 'audio' });
  nativeAudio = { gen, writer: gen.writable.getWriter(), ts: 0 };
  const res = await nativeApp.startAudio(settings.appAudio);
  if (!res || !res.ok) {
    toast('Não consegui capturar o som pelo app: ' + (res?.error || 'erro desconhecido'));
    nativeAudio = null;
    gen.stop();
    return null;
  }
  return gen;
}

function stopNativeAudio() {
  if (!nativeAudio) return;
  nativeAudio.writer.close().catch(() => {});
  nativeAudio = null;
  nativeApp.stopAudio();
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
$('session').value = params.get('s') || '';
try { $('nick').value = localStorage.getItem('nick') || ''; } catch {}
($('nick').value ? $('session') : $('nick')).focus();
if ($('nick').value && $('session').value) $('password').focus();

// Sessões recentes (ficam só neste navegador/app). A última em que você
// estava (e não clicou em "Sair") abre sozinha quando recarrega/reabre.
const RECENT_KEY = 'telinhaRecent';
const LAST_KEY = 'telinhaLast';
const recentList = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((r) => r && r.s); } catch { return []; }
};
function saveRecent(name, pass) {
  const key = name.toLowerCase();
  const list = [{ s: name, p: pass, at: Date.now() }, ...recentList().filter((r) => r.s.toLowerCase() !== key)].slice(0, 6);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    localStorage.setItem(LAST_KEY, key);
  } catch {}
}
function forgetLast() {
  try { localStorage.removeItem(LAST_KEY); } catch {}
}
function renderRecent() {
  const list = recentList();
  $('recent').hidden = !list.length;
  const box = $('recentList');
  box.textContent = '';
  for (const r of list) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'recent-go';
    go.textContent = (r.p ? '🔒 ' : '') + r.s;
    go.title = 'Entrar em ' + r.s;
    go.addEventListener('click', () => {
      $('session').value = r.s;
      $('password').value = r.p || '';
      $('joinForm').requestSubmit();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'recent-del';
    del.textContent = '✕';
    del.title = 'Tirar da lista';
    del.addEventListener('click', () => {
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentList().filter((x) => x.s !== r.s))); } catch {}
      renderRecent();
    });
    item.append(go, del);
    box.append(item);
  }
}
renderRecent();

$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('joinError').hidden = true;
  myName = $('nick').value.trim();
  if (!myName) return $('nick').focus();
  try { localStorage.setItem('nick', myName); } catch {}

  try {
    iceServers = (await (await fetch('/config')).json()).iceServers;
  } catch {
    iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  }
  sessionName = $('session').value.trim();
  sessionPass = $('password').value;
  connect();
});

function showJoinError(text) {
  if (autoJoining) {
    // Não deu para voltar sozinho (senha mudou, sala cheia...): não tenta de novo.
    autoJoining = false;
    forgetLast();
    $('joinStatus').hidden = true;
  }
  $('joinError').textContent = text;
  $('joinError').hidden = false;
}
let autoJoining = false;
try {
  const why = sessionStorage.getItem('telinhaMsg');
  if (why) showJoinError(why);
  sessionStorage.removeItem('telinhaMsg');
} catch {}
// Recarregou/reabriu o app sem ter saído: volta para a mesma sessão.
try {
  const last = localStorage.getItem(LAST_KEY);
  const r = last && recentList().find((x) => x.s.toLowerCase() === last);
  const linkTo = (params.get('s') || '').trim().toLowerCase();
  if (r && $('nick').value.trim() && $('joinError').hidden && (!linkTo || linkTo === last)) {
    $('session').value = r.s;
    $('password').value = r.p || '';
    autoJoining = true;
    $('joinStatus').textContent = `Voltando para "${r.s}"...`;
    $('joinStatus').hidden = false;
    setTimeout(() => $('joinForm').requestSubmit(), 0);
  }
} catch {}

// Conexão com o servidor. Se cair, reconecta sozinho e volta com o mesmo id
// (o servidor guarda o lugar por 30 s); as telas diretas nem param.
let sessionName = '';
let sessionPass = '';
let resumeToken = null;
let inRoom = false;
let leaving = false;
let reconnectTimer = null;
let reconnectTries = 0;

function connect() {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch {}
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws?s=${encodeURIComponent(sessionName.toLowerCase())}`);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  let lastHeard = Date.now();
  const resume = inRoom && resumeToken ? { id: myId, token: resumeToken } : undefined;
  logEvent(resume ? 'Servidor: reconectando...' : 'Servidor: conectando...');
  sock.onopen = () => {
    logEvent('Servidor: conectado');
    lastHeard = Date.now();
    send({ type: 'join', session: sessionName, password: sessionPass, name: myName, resume });
  };
  let pingAt = 0;
  const keepAlive = setInterval(() => {
    if (sock.readyState !== 1) return;
    // Mandei ping e nada voltou (nem o pong): a conexão morreu sem avisar.
    if (pingAt && lastHeard < pingAt && Date.now() - pingAt > 15000) {
      logEvent('Servidor: sem resposta há 15 s (conexão morta)');
      return lost();
    }
    if (lastHeard >= pingAt && Date.now() - lastHeard > 10000) {
      pingAt = Date.now();
      sock.send('ping');
    }
  }, 5000);
  sock.onmessage = (ev) => {
    lastHeard = Date.now();
    if (typeof ev.data !== 'string') return onRelayData(ev.data);
    if (ev.data !== 'pong') handle(JSON.parse(ev.data));
  };
  const lost = () => {
    clearInterval(keepAlive);
    if (ws !== sock || leaving) return;
    logEvent('Servidor: conexão caiu');
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try { sock.close(); } catch {}
    if (!inRoom) return showJoinError('Não foi possível conectar ao servidor.');
    scheduleReconnect();
  };
  sock.onclose = lost;
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  setConnState(true);
  const delay = [300, 1000, 2000, 3000][reconnectTries] ?? 5000;
  reconnectTries++;
  reconnectTimer = setTimeout(connect, delay);
}

// Voltou a internet / voltou para a aba: tenta na hora.
const reconnectNow = () => inRoom && !leaving && ws && ws.readyState > 1 && connect();
window.addEventListener('online', reconnectNow);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reconnectNow());
window.addEventListener('pagehide', () => inRoom && !leaving && send({ type: 'leave' }));

function setConnState(down) {
  $('connState').hidden = !down;
}

function backToLobby(text) {
  leaving = true;
  forgetLast();
  try { sessionStorage.setItem('telinhaMsg', text); } catch {}
  location.href = location.pathname + '?s=' + encodeURIComponent(sessionName) + (FORCE_RELAY ? '&planoB=1' : '');
}

const send = (msg) => ws && ws.readyState === 1 && (ws.send(JSON.stringify(msg)), true);

// ---------------------------------------------------------------------------
// Mensagens do servidor
// ---------------------------------------------------------------------------
async function handle(msg) {
  switch (msg.type) {
    case 'error':
      if (msg.code === 'expired') {
        // Demorou demais para voltar: entra de novo como alguém novo.
        resumeToken = null;
        send({ type: 'join', session: sessionName, password: sessionPass, name: myName });
      } else if (inRoom) {
        backToLobby(msg.message);
      } else {
        showJoinError(msg.message);
        ws.onclose = null;
        ws.close();
      }
      break;

    case 'joined': {
      resumeToken = msg.token || null;
      reconnectTries = 0;
      setConnState(false);
      if (inRoom) {
        rejoined(msg);
        break;
      }
      inRoom = true;
      myId = msg.id;
      autoJoining = false;
      saveRecent(sessionName, sessionPass);
      logEvent(`Entrou na sessão (${msg.peers.length} pessoa(s) já estavam)`);
      refreshMyNet().then(() => shareMyNet());
      const session = $('session').value.trim().toLowerCase();
      history.replaceState(null, '', '?s=' + encodeURIComponent(session) + (FORCE_RELAY ? '&planoB=1' : ''));
      $('roomName').textContent = session;
      $('lockIcon').hidden = !msg.protected;
      $('lobby').hidden = true;
      $('room').hidden = false;
      for (const p of msg.peers) {
        const q = getPeer(p.id, p.name);
        q.sharing = p.sharing;
        q.away = !!p.away;
        if (p.sharing && FORCE_RELAY) relaySubscribe(p.id, 'manual');
      }
      renderPeers();
      camBroadcast({ aura: myAura() });
      setInterval(checkConnections, 1000);
      sys(msg.created ? `Sessão criada${msg.protected ? ' com senha' : ''}. Mande o link para a galera!` : 'Você entrou na sessão.');
      if (FORCE_RELAY) sys('Modo plano B forçado (?planoB=1).');
      break;
    }

    case 'peer-joined':
      getPeer(msg.id, msg.name);
      logEvent(`${msg.name} entrou`);
      shareMyNet(msg.id);
      camPeerJoined(msg.id);
      renderPeers();
      sys(`${msg.name} entrou.`);
      // Se eu já estou compartilhando, mando a tela para quem chegou.
      if (localStream) {
        addTracksTo(msg.id);
        if (relayAll) send({ type: 'signal', to: msg.id, data: { relay: true } });
      }
      break;

    case 'peer-left': {
      const p = peers.get(msg.id);
      if (!p) break;
      sys(`${p.name} saiu.`);
      dropPeer(msg.id);
      renderPeers();
      break;
    }

    case 'peer-away': {
      // Caiu, mas deve voltar em instantes (a conexão direta continua).
      const p = peers.get(msg.id);
      if (!p) break;
      p.away = true;
      renderPeers();
      break;
    }

    case 'peer-back': {
      const p = peers.get(msg.id);
      if (!p) break;
      p.away = false;
      // Ele voltou: refaz meu pedido de plano B (pode ter se perdido).
      if (relayIn.has(msg.id)) send({ type: 'relay-sub', to: msg.id, on: true });
      renderPeers();
      break;
    }

    case 'sharing': {
      const p = getPeer(msg.id);
      if (p.sharing === msg.on) break;
      p.sharing = msg.on;
      p.lastDirectOk = undefined; // recomeça a contagem da conexão direta
      if (msg.on) {
        if (FORCE_RELAY) relaySubscribe(msg.id, 'manual');
      } else {
        p.unwatched = false;
        closeClips(msg.id);
        relayUnsubscribe(msg.id, true);
        removeTile(msg.id);
      }
      renderPeers();
      sys(`${p.name} ${msg.on ? 'começou' : 'parou'} a compartilhar.`);
      break;
    }

    case 'relay-sub':
      if (msg.on) relayAddViewer(msg.from);
      else relayRemoveViewer(msg.from);
      break;

    case 'chat':
      chat(msg.id === myId ? 'Você' : msg.name, msg.text);
      break;

    case 'signal':
      if (!onExtraSignal(msg.from, msg.data)) onSignal(msg.from, msg.data);
      break;
  }
}

function dropPeer(id) {
  const p = peers.get(id);
  if (!p) return;
  camPeerLeft(id);
  closeClips(id);
  p.pc && p.pc.close();
  peers.delete(id);
  relayRemoveViewer(id);
  relayUnsubscribe(id, false);
  removeTile(id);
}

// Reconectou ao servidor depois de uma queda.
function rejoined(msg) {
  logEvent(msg.id === myId ? 'Voltou para a sessão (mesmo lugar)' : 'Voltou para a sessão (lugar novo, refazendo conexões)');
  setTimeout(() => shareMyNet(), 500);
  if (msg.id !== myId) {
    // Demorou e perdeu o lugar: refaz todas as conexões do zero.
    for (const id of [...peers.keys()]) dropPeer(id);
    const mine = tiles.get(myId);
    if (mine) {
      tiles.delete(myId);
      tiles.set(msg.id, mine);
    }
    camRejoined(msg.id, myId);
    myId = msg.id;
  }
  const listed = new Set(msg.peers.map((p) => p.id));
  for (const id of [...peers.keys()]) {
    if (listed.has(id)) continue;
    sys(`${peers.get(id).name} saiu.`);
    dropPeer(id);
  }
  for (const p of msg.peers) {
    const isNew = !peers.has(p.id);
    const q = getPeer(p.id, p.name);
    q.away = !!p.away;
    if (q.sharing && !p.sharing) {
      relayUnsubscribe(p.id, false);
      removeTile(p.id);
    }
    q.sharing = p.sharing;
    if (p.sharing && FORCE_RELAY) relaySubscribe(p.id, 'manual');
    if (isNew) camPeerJoined(p.id);
    if (isNew && localStream) {
      addTracksTo(p.id);
      if (relayAll) send({ type: 'signal', to: p.id, data: { relay: true } });
    }
  }
  if (localStream) send({ type: 'sharing', on: true });
  // Refaz os pedidos de plano B (o servidor pode ter esquecido).
  for (const id of relayIn.keys()) send({ type: 'relay-sub', to: id, on: true });
  renderPeers();
  toast('Reconectado.');
}

// ---------------------------------------------------------------------------
// WebRTC (malha: cada par tem uma RTCPeerConnection; "perfect negotiation")
// ---------------------------------------------------------------------------
function getPeer(id, name) {
  let p = peers.get(id);
  if (!p) {
    p = { name: name || '???', sharing: false, pc: null, makingOffer: false, ignoreOffer: false, senders: [] };
    p.polite = myId > id;
    peers.set(id, p);
  } else if (name) {
    p.name = name;
  }
  if (!p.pc) p.pc = createPc(id, p);
  return p;
}

function createPc(id, p) {
  const pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = ({ candidate }) => candidate && send({ type: 'signal', to: id, data: { candidate } });

  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      send({ type: 'signal', to: id, data: { description: pc.localDescription } });
    } catch (err) {
      console.error(err);
    } finally {
      p.makingOffer = false;
    }
  };

  pc.ontrack = ({ track, streams, receiver }) => {
    setJitter(receiver);
    if (relayIn.has(id) || p.unwatched) return;
    showTile(id, streams[0] || new MediaStream([track]), false);
    setTileStatus(id, pc.connectionState === 'connected' ? 'direto' : 'conectando...');
  };

  pc.onconnectionstatechange = () => {
    const st = { new: 'nova', connecting: 'conectando', connected: 'conectada ✓', disconnected: 'instável/caiu', failed: 'FALHOU', closed: 'fechada' };
    logEvent(`${p.name}: conexão direta ${st[pc.connectionState] || pc.connectionState}`);
    if (pc.connectionState === 'failed') logEvent(`${p.name}: motivo provável: ${guessDirect(myNet, p.netInfo)}`);
    if (pc.connectionState === 'connected') {
      tuneSenders(p);
      if (!relayIn.has(id)) setTileStatus(id, 'direto');
    }
    if (pc.connectionState === 'failed') {
      pc.restartIce();
      // Atalho: nem espera o vigia, já vai para o plano B.
      if (p.sharing && !p.noRelay && !relayIn.has(id)) relaySubscribe(id, 'auto');
    }
  };

  return pc;
}

// Vigia (1x por segundo) de cada pessoa compartilhando: alterna sozinho entre
// a conexão direta e o plano B conforme o que estiver funcionando.
async function checkConnections() {
  const now = Date.now();
  for (const [id, p] of peers) {
    if (!p.sharing || !p.pc || p.unwatched) continue;
    const pc = p.pc;
    const connected = pc.connectionState === 'connected';
    p.lastDirectOk ??= now;
    if (connected) {
      p.lastDirectOk = now;
      p.connectedSince ??= now;
    } else {
      p.connectedSince = null;
    }
    // A conexão direta continua recebendo vídeo mesmo durante o plano B;
    // é assim que dá para saber se ela voltou.
    let direct = null; // vídeo direto mais recente
    try {
      let bytes = 0;
      (await pc.getStats()).forEach((s) => {
        if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
        bytes += s.bytesReceived || 0;
        if (!direct || (s.lastPacketReceivedTimestamp || 0) > (direct.lastPacketReceivedTimestamp || 0)) direct = s;
      });
      if (bytes > (p.lastBytes || 0)) p.lastDirectMedia = now;
      p.lastBytes = bytes;
    } catch {}

    const r = relayIn.get(id);
    showStats(id, p, r, direct, now);
    if (p.away) {
      // Caiu do servidor e deve voltar: não adianta trocar de caminho agora.
      if (tiles.has(id) && !connected) setTileStatus(id, 'reconectando...');
      p.lastDirectOk = now;
      if (r) r.lastVideo = Math.max(r.lastVideo, now - RELAY_TIMEOUT / 2);
      continue;
    }
    if (!r) {
      const stuck = p.noRelay && now - p.lastDirectOk > DIRECT_TIMEOUT;
      if (tiles.has(id)) setTileStatus(id, connected ? 'direto' : stuck ? 'sem conexão (precisa de Chrome/Edge para o plano B)' : 'conectando...');
      if (!p.noRelay && now - p.lastDirectOk > DIRECT_TIMEOUT) relaySubscribe(id, 'auto');
      continue;
    }
    const relayDead = now - r.lastVideo > RELAY_TIMEOUT;
    if (r.reason === 'auto') {
      if (relayDead) {
        relayToDirect(id);
        toast(`Plano B com ${p.name} não respondeu. Tentando a conexão direta de novo...`);
      } else if (p.connectedSince && now - p.connectedSince > DIRECT_RECOVER && now - (p.lastDirectMedia || 0) < 2000) {
        relayToDirect(id);
        toast(`Conexão direta com ${p.name} voltou.`);
      }
    } else if (relayDead) {
      // Plano B escolhido na mão: insiste nele.
      setTileStatus(id, 'plano B · sem sinal, tentando...');
      requestKey(id, r);
    }
  }
}

async function onSignal(from, { description, candidate, relay, relayUnsupported, wantQuality, watch, reset, netInfo }) {
  // Como é a rede da outra pessoa (para o 📋 Logs).
  if (netInfo) {
    const p = getPeer(from);
    p.netInfo = netInfo;
    logEvent(`${p.name}: rede ${NAT_TEXT[netInfo.nat]?.label || netInfo.nat}${netInfo.ipv6 ? ' · IPv6' : ''}${netInfo.cgnat ? ' · CGNAT' : ''}`);
    return;
  }
  // Quem assiste parou (ou voltou) de assistir minha tela: paro de mandar
  // para ele (economiza minha internet e o PC).
  if (watch !== undefined) {
    const p = getPeer(from);
    p.noSend = !watch;
    if (!localStream) return;
    if (watch) {
      if (!p.senders.length) addTracksTo(from);
    } else {
      removeTracksFrom(p);
      relayRemoveViewer(from);
    }
    return;
  }
  // Quem assiste pediu para recomeçar a conexão comigo do zero.
  if (reset) {
    resetPeerConnection(from);
    if (localStream && !getPeer(from).noSend) addTracksTo(from);
    return;
  }
  // Quem assiste pediu outra qualidade (só para ele, na conexão direta).
  if (wantQuality !== undefined) {
    const p = getPeer(from);
    p.wantQuality = wantQuality;
    tuneSenders(p);
    relayOut.forceKey = true;
    return;
  }
  // Quem compartilha ligou/desligou o "plano B p/ todos".
  if (relay !== undefined) {
    if (relay) relaySubscribe(from, 'sender');
    else relayToDirect(from);
    return;
  }
  // Quem compartilha está num navegador que não envia pelo plano B.
  if (relayUnsupported) {
    const p = getPeer(from);
    p.noRelay = true;
    if (relayIn.has(from)) relayToDirect(from);
    toast(`${p.name} está num navegador sem plano B (precisa de Chrome ou Edge).`);
    return;
  }
  const p = getPeer(from);
  const pc = p.pc;
  try {
    if (description) {
      const collision = description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        send({ type: 'signal', to: from, data: { description: pc.localDescription } });
      } else {
        tuneSenders(p);
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!p.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Qualidade
// Quem compartilha escolhe um teto; quem assiste pode pedir menos só para si.
// Vale a mais baixa das duas. height = altura máxima; direct/relay = bitrate.
// ---------------------------------------------------------------------------
const QUALITY = {
  ultra: { rank: 6, height: 2160, direct: 20_000_000, relay: 8_000_000 },
  qhd: { rank: 5, height: 1440, direct: 12_000_000, relay: 5_500_000 },
  alta: { rank: 4, height: 1080, direct: 6_000_000, relay: 3_500_000 },
  media: { rank: 3, height: 720, direct: 2_500_000, relay: 1_800_000 },
  baixa: { rank: 2, height: 480, direct: 1_000_000, relay: 900_000 },
  minima: { rank: 1, height: 360, direct: 500_000, relay: 500_000 },
};
// Automática: o navegador se adapta sozinho à internet, com esse teto.
const AUTO_QUALITY = { height: 1080, direct: 6_000_000, relay: 2_500_000 };

// Obs.: no modo "nitidez" o WebRTC segura a resolução e descarta quadros
// (fica em ~30 fps); para 60 fps use "fluidez".
const wantsMotion = () => $('mode').value === 'motion';
const applyContentHint = () => {
  const video = localStream?.getVideoTracks()[0];
  if (video) video.contentHint = wantsMotion() ? 'motion' : 'detail';
};

function effectiveQuality(...wants) {
  const fixed = wants.filter((w) => QUALITY[w]);
  if (!fixed.length) return { name: 'auto', ...AUTO_QUALITY };
  const name = fixed.reduce((a, b) => (QUALITY[a].rank <= QUALITY[b].rank ? a : b));
  return { name, ...QUALITY[name] };
}

// Ajusta o envio direto para uma pessoa (cada conexão tem seu próprio encoder).
// Em fila: dois setParameters ao mesmo tempo no mesmo sender dão erro.
function tuneSenders(p) {
  p.tuning = (p.tuning || Promise.resolve()).then(() => applyTune(p));
  return p.tuning;
}

async function applyTune(p) {
  if (!localStream || !p.pc) return;
  const motion = wantsMotion();
  const fps = Number($('fps').value);
  const q = effectiveQuality($('quality').value, p.wantQuality);
  const srcHeight = localStream.getVideoTracks()[0]?.getSettings().height || q.height;
  for (const sender of p.pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) continue;
    const enc = params.encodings[0];
    enc.maxBitrate = motion ? Math.round(q.direct * 1.3) : q.direct;
    enc.maxFramerate = fps;
    enc.scaleResolutionDownBy = Math.max(1, srcHeight / q.height);
    // Fluidez: segura os fps. Nitidez: equilibra. ("manter resolução a
    // qualquer custo" derrubava os fps e a tela parecia travada.)
    params.degradationPreference = motion ? 'maintain-framerate' : 'balanced';
    try {
      await sender.setParameters(params);
    } catch (err) {
      // Costuma ser renegociação em andamento: tenta de novo daqui a pouco.
      console.warn('setParameters', err.name, err.message);
      logEvent(`Ajuste de qualidade falhou (${err.name}); tentando de novo`);
      clearTimeout(p.tuneRetry);
      p.tuneRetry = setTimeout(() => tuneSenders(p), 1000);
    }
  }
}

function tuneAll() {
  for (const p of peers.values()) tuneSenders(p);
  relayOut.forceKey = true;
}

// Plano B: um encoder por qualidade pedida, para que quem pede menos não
// derrube a qualidade de quem está no plano B com internet boa.
const relayGroupOf = (id) => effectiveQuality($('quality').value, peers.get(id)?.wantQuality).name;

function relaySettings() {
  const motion = wantsMotion();
  const groups = new Map(); // nome da qualidade -> { maxW, maxH, bitrate }
  for (const id of relayOut.viewers) {
    const q = effectiveQuality($('quality').value, peers.get(id)?.wantQuality);
    groups.set(q.name, {
      maxH: q.height,
      maxW: Math.round((q.height * 16) / 9),
      bitrate: motion ? Math.round(q.relay * 1.2) : q.relay,
    });
  }
  return { fps: Number($('fps').value), groups };
}

// Mostra resolução / fps / Mbps de cada tela recebida (ajuda a ver se travou).
function showStats(id, p, r, direct, now) {
  const el = tiles.get(id)?.querySelector('.stats');
  if (!el) return;
  let w, h, fps, mbps, freezes;
  if (r) {
    const dt = (now - (r.statAt || now)) / 1000;
    if (dt > 0) {
      fps = r.statFrames / dt;
      mbps = (r.statBytes * 8) / dt / 1e6;
    }
    w = r.canvas.width;
    h = r.canvas.height;
    r.statFrames = 0;
    r.statBytes = 0;
    r.statAt = now;
    freezes = r.freezes;
  } else if (direct) {
    p.freeze0 ??= direct.freezeCount || 0;
    freezes = (direct.freezeCount || 0) - p.freeze0;
    w = direct.frameWidth;
    h = direct.frameHeight;
    fps = direct.framesPerSecond;
    if (p.statBytes !== undefined && direct.timestamp > p.statTs) {
      mbps = ((direct.bytesReceived - p.statBytes) * 8) / ((direct.timestamp - p.statTs) / 1000) / 1e6;
    }
    p.statBytes = direct.bytesReceived;
    p.statTs = direct.timestamp;
  }
  if (!w || fps === undefined) {
    el.textContent = '';
    return;
  }
  el.textContent =
    `${w}x${h} · ${Math.round(fps)} fps${mbps !== undefined && mbps >= 0 ? ` · ${mbps.toFixed(1)} Mbps` : ''}` +
    (freezes > 0 ? ` · ${freezes} travada${freezes > 1 ? 's' : ''}` : '');
  el.classList.toggle('bad', fps < 8);
}

function removeTracksFrom(p) {
  for (const s of p.senders) {
    try { p.pc.removeTrack(s); } catch {}
  }
  p.senders = [];
}

// Fecha a conexão com alguém e cria uma nova (o "reiniciar").
function resetPeerConnection(id) {
  const p = peers.get(id);
  if (!p) return;
  try { p.pc.close(); } catch {}
  p.pc = createPc(id, p);
  p.senders = [];
  p.makingOffer = false;
  p.ignoreOffer = false;
  p.lastDirectOk = undefined;
  p.connectedSince = null;
  p.lastBytes = 0;
  p.statBytes = undefined;
  p.freeze0 = undefined;
}

function addTracksTo(id) {
  const p = getPeer(id);
  if (p.noSend) return; // essa pessoa não quer ver minha tela
  p.senders = localStream.getTracks().map((t) => p.pc.addTrack(t, localStream));
  preferCodec(p.pc);
}

// Codec escolhido em ⚙ Configurações. "auto" = padrão do navegador (VP8),
// como era antes. H.264 costuma dar mais fps (placa de vídeo), mas em alguns
// PCs dá umas engasgadas. Se o outro lado não tiver o codec, usa o resto.
function preferCodec(pc) {
  try {
    const want = settings.codec;
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs;
    if (!codecs) return;
    const first = want === 'auto' ? [] : codecs.filter((c) => c.mimeType.toLowerCase() === 'video/' + want);
    const order = [...first, ...codecs.filter((c) => !first.includes(c))];
    for (const t of pc.getTransceivers()) {
      if (t.sender.track?.kind === 'video' && t.setCodecPreferences) t.setCodecPreferences(order);
    }
  } catch (err) {
    console.warn('preferCodec', err);
  }
}

// ---------------------------------------------------------------------------
// Plano B: quando a conexão direta (P2P) falha, o vídeo/áudio é comprimido no
// navegador (WebCodecs) e vai pelo próprio WebSocket, repassado pelo servidor.
//
// Cada mensagem binária enviada é um lote (~100 ms) de pacotes:
//   [u32 tamanho][u8 tipo 0=vídeo 1=áudio][u8 flags bit0=key][f64 timestamp]
//   vídeo key: [u8 len][codec ascii]   áudio: [u32 sampleRate][u8 canais]
//   [dados]
// O servidor entrega com o id de quem enviou (36 bytes) na frente.
// ---------------------------------------------------------------------------
const RELAY_FLUSH_MS = 100; // lotes menores = menos mensagens cobradas no servidor
const RELAY_MAX_BUFFER = 768 * 1024; // acima disso a rede não está dando conta
const relayOut = { viewers: new Set(), running: false, tracks: [], queue: [], video: new Map(), timer: null, forceKey: false, codec: null };
const relayIn = new Map(); // id de quem compartilha -> estado do decodificador
let relayAll = false; // "Plano B p/ todos" ligado por quem compartilha
let shareAudioOn = true; // áudio da transmissão (dá para mutar se vazar a voz do Discord)

// ---- Lado de quem compartilha ----
const canSendRelay = () => 'VideoEncoder' in window && 'MediaStreamTrackProcessor' in window;

function relayAddViewer(id) {
  if (!localStream) return;
  if (!canSendRelay()) {
    send({ type: 'signal', to: id, data: { relayUnsupported: true } });
    return;
  }
  relayOut.viewers.add(id);
  relayOut.forceKey = true; // quem chegou precisa de um quadro-chave
  if (!relayOut.running) startRelay();
  updateLocalLabel();
}

function relayRemoveViewer(id) {
  if (!relayOut.viewers.delete(id)) return;
  if (!relayOut.viewers.size) stopRelay();
  updateLocalLabel();
}

function startRelay() {
  relayOut.running = true;
  relayOut.timer = setInterval(flushRelay, RELAY_FLUSH_MS);
  const video = localStream.getVideoTracks()[0];
  if (video) runVideoRelay(video.clone());
  const audio = localStream.getAudioTracks()[0];
  if (audio && 'AudioEncoder' in window) runAudioRelay(audio.clone());
}

function stopRelay() {
  relayOut.running = false;
  clearInterval(relayOut.timer);
  relayOut.tracks.forEach((t) => t.stop());
  relayOut.tracks = [];
  relayOut.queue = [];
  relayOut.video = new Map();
}

const relayCongested = () => ws.bufferedAmount > RELAY_MAX_BUFFER;

async function pickCodec(cfg) {
  const big = cfg.height > 1088; // acima de 1080p precisa de outro nível do H.264
  relayOut.codecs ??= {};
  if (relayOut.codecs[big]) return relayOut.codecs[big];
  const candidates = [
    ...(big ? [{ codec: 'avc1.640033', avc: { format: 'annexb' } }] : []), // H.264 High 5.1 (4K)
    { codec: 'avc1.640028', avc: { format: 'annexb' } }, // H.264 High 4.0
    { codec: 'avc1.42E01F', avc: { format: 'annexb' } }, // H.264 Baseline
    { codec: 'vp8' },
  ];
  for (const c of candidates) {
    try {
      if ((await VideoEncoder.isConfigSupported({ ...cfg, ...c })).supported) return (relayOut.codecs[big] = c);
    } catch {}
  }
  return null;
}

async function runVideoRelay(track) {
  relayOut.tracks.push(track);
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const encoders = new Map(); // qualidade -> { encoder, size, lastKey }
  let lastTs = -Infinity;
  let pending = null; // leitura em andamento
  let last = null; // cópia do último quadro
  const closeEnc = (g) => g.encoder.state !== 'closed' && g.encoder.close();

  try {
    while (relayOut.running) {
      // Tela parada não gera quadros novos: repete o último a cada 1 s para
      // quem assiste saber que o plano B continua vivo.
      pending ??= reader.read();
      const res = await Promise.race([pending, new Promise((r) => setTimeout(() => r(null), 1000))]);
      let frame;
      if (res === null) {
        if (!last) continue;
        frame = new VideoFrame(last, { timestamp: lastTs + 1e6 });
      } else {
        pending = null;
        if (res.done) break;
        frame = res.value;
        if (last) last.close();
        last = frame.clone();
        relayClock('v', frame.timestamp);
      }
      if (!relayOut.running) {
        frame.close();
        break;
      }
      // Lido a cada quadro: muda na hora quando alguém troca a qualidade.
      const { fps, groups } = relaySettings();
      const minGap = 1e6 / fps; // µs
      // Limita fps e descarta quadros quando a rede/encoder não acompanha.
      const congested = relayCongested();
      if (congested) relayOut.forceKey = true;
      const busy = [...encoders.values()].some((g) => g.encoder.encodeQueueSize > 2);
      if (congested || busy || frame.timestamp - lastTs < minGap * 0.9) {
        frame.close();
        continue;
      }
      lastTs = frame.timestamp;

      for (const [name, g] of encoders) {
        if (groups.has(name)) continue;
        closeEnc(g);
        encoders.delete(name);
      }
      const forceAll = relayOut.forceKey;
      relayOut.forceKey = false;
      for (const [name, s] of groups) {
        const scale = Math.min(1, s.maxW / frame.displayWidth, s.maxH / frame.displayHeight);
        const w = Math.max(2, Math.round((frame.displayWidth * scale) / 2) * 2);
        const h = Math.max(2, Math.round((frame.displayHeight * scale) / 2) * 2);
        const size = `${w}x${h}@${s.bitrate}@${fps}`;
        let g = encoders.get(name);
        if (!g || g.encoder.state === 'closed' || g.size !== size) {
          if (g) closeEnc(g);
          const cfg = { width: w, height: h, bitrate: s.bitrate, framerate: fps, latencyMode: 'realtime' };
          const codec = await pickCodec(cfg);
          if (!codec) {
            frame.close();
            toast('Seu navegador não consegue codificar vídeo para o plano B.');
            return;
          }
          const encoder = new VideoEncoder({
            output: (chunk) => queueChunk(0, chunk, codec.codec, name),
            error: (err) => console.warn('VideoEncoder', err),
          });
          encoder.configure({ ...cfg, ...codec });
          g = { encoder, size, lastKey: -Infinity, forceKey: true };
          encoders.set(name, g);
        }
        const key = forceAll || g.forceKey || frame.timestamp - g.lastKey > 3e6;
        if (key) {
          g.forceKey = false;
          g.lastKey = frame.timestamp;
        }
        g.encoder.encode(frame, { keyFrame: key });
      }
      frame.close();
    }
  } catch (err) {
    console.warn('plano B (vídeo)', err);
  } finally {
    if (last) last.close();
    if (pending) pending.then((r) => r.value && r.value.close(), () => {});
    reader.cancel().catch(() => {});
    track.stop();
    for (const g of encoders.values()) closeEnc(g);
  }
}

async function runAudioRelay(track) {
  relayOut.tracks.push(track);
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  let encoder = null;
  let fmt = '';

  try {
    while (relayOut.running) {
      const { value: data, done } = await reader.read();
      if (done) break;
      // Áudio da live desligado por quem compartilha: não manda nada.
      if (!relayOut.running || !shareAudioOn || relayCongested()) {
        data.close();
        continue;
      }
      relayClock('a', data.timestamp);
      const { sampleRate, numberOfChannels } = data;
      if (!encoder || encoder.state === 'closed' || fmt !== `${sampleRate}/${numberOfChannels}`) {
        if (encoder && encoder.state !== 'closed') encoder.close();
        encoder = new AudioEncoder({
          output: (chunk) => queueChunk(1, chunk, { sampleRate, numberOfChannels }),
          error: (err) => console.warn('AudioEncoder', err),
        });
        encoder.configure({ codec: 'opus', sampleRate, numberOfChannels, bitrate: 96000 });
        fmt = `${sampleRate}/${numberOfChannels}`;
      }
      encoder.encode(data);
      data.close();
    }
  } catch (err) {
    console.warn('plano B (áudio)', err);
  }
  reader.cancel().catch(() => {});
  track.stop();
  if (encoder && encoder.state !== 'closed') encoder.close();
}

// Vídeo vai para a fila da sua qualidade (group); áudio vai para todos.
// O vídeo e o áudio capturados têm relógios próprios. Guarda a diferença de
// cada um para o performance.now() (a menor vista = a menos atrasada).
function relayClock(kind, ts) {
  relayOut.offset ??= {};
  const off = performance.now() * 1000 - ts;
  const cur = relayOut.offset[kind];
  if (cur === undefined || off < cur || off > cur + 300_000) relayOut.offset[kind] = off;
}

function queueChunk(kind, chunk, extra, group) {
  if (!relayOut.running) return;
  const key = chunk.type === 'key';
  let head;
  if (kind === 0) {
    const codec = key ? new TextEncoder().encode(extra) : new Uint8Array(0);
    head = new Uint8Array(14 + (key ? 1 + codec.length : 0));
    if (key) {
      head[14] = codec.length;
      head.set(codec, 15);
    }
  } else {
    head = new Uint8Array(14 + 5);
    new DataView(head.buffer).setUint32(14, extra.sampleRate);
    head[18] = extra.numberOfChannels;
  }
  const dv = new DataView(head.buffer);
  dv.setUint32(0, head.length - 4 + chunk.byteLength);
  head[4] = kind;
  head[5] = key ? 1 : 0;
  // Vai no relógio comum (performance.now em µs) para quem assiste sincronizar.
  dv.setFloat64(6, chunk.timestamp + (relayOut.offset[kind === 0 ? 'v' : 'a'] || 0));
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  if (kind === 1) return relayOut.queue.push(head, data);
  if (!relayOut.video.has(group)) relayOut.video.set(group, []);
  relayOut.video.get(group).push(head, data);
}

// O servidor derruba a conexão se uma mensagem passar de 1 MiB; um lote com
// quadro-chave grande chegava perto disso. Divide em pedaços menores.
const RELAY_MAX_MSG = 256 * 1024;

// Cada mensagem começa com [u8 n][n ids de 36 bytes]: para quem ela vai.
function flushRelay() {
  const audio = relayOut.queue;
  const video = relayOut.video;
  relayOut.queue = [];
  relayOut.video = new Map();
  if (!audio.length && !video.size) return;
  if (!ws || ws.readyState !== 1) {
    relayOut.forceKey = true; // quem assiste vai precisar de um quadro-chave
    return;
  }
  const byGroup = new Map(); // qualidade -> ids de quem assiste nela
  for (const id of relayOut.viewers) {
    const g = relayGroupOf(id);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(id);
  }
  for (const [group, ids] of byGroup) {
    const q = [...(video.get(group) || []), ...audio]; // pares [cabeçalho, dados]
    if (!q.length) continue;
    const head = new Uint8Array(1 + ids.length * 36);
    head[0] = ids.length;
    ids.forEach((id, i) => head.set(new TextEncoder().encode(id), 1 + i * 36));
    let parts = [head];
    let size = head.length;
    const flush = () => {
      if (parts.length === 1) return;
      const out = new Uint8Array(size);
      let off = 0;
      for (const b of parts) {
        out.set(b, off);
        off += b.length;
      }
      ws.send(out);
      parts = [head];
      size = head.length;
    };
    for (let i = 0; i < q.length; i += 2) {
      const n = q[i].length + q[i + 1].length;
      if (n > 1000 * 1024) {
        relayOut.forceKey = true; // grande demais para mandar: pula
        continue;
      }
      if (size + n > RELAY_MAX_MSG) flush();
      parts.push(q[i], q[i + 1]);
      size += n;
    }
    flush();
  }
}

// ---- Lado de quem assiste ----
// reason: 'auto' (conexão direta falhou), 'sender' (quem compartilha ligou o
// plano B p/ todos) ou 'manual' (botão / ?planoB=1).
function relaySubscribe(id, reason) {
  if (relayIn.has(id)) return;
  const p = peers.get(id);
  if (p?.unwatched) return;
  logEvent(`${p?.name || '?'}: usando o plano B (${{ auto: 'a direta não conectou', sender: 'quem transmite ligou p/ todos', manual: 'escolhido' }[reason] || reason})`);
  if (!('VideoDecoder' in window)) {
    if (p) p.noRelay = true; // não adianta tentar de novo
    toast('Seu navegador não suporta o plano B. Use Chrome, Edge ou Firefox atualizado.');
    return;
  }
  const canvas = document.createElement('canvas');
  const r = {
    canvas,
    ctx2d: canvas.getContext('2d'),
    vdec: null,
    codec: '',
    waitingKey: true,
    lastKeyReq: 0,
    adec: null,
    afmt: '',
    statFrames: 0,
    chunks: [], // vídeo comprimido esperando a vez de ser decodificado
    pumpTimer: 0,
    base: undefined,
    lastDraw: 0,
    freezes: 0,
    statBytes: 0,
    statAt: 0,
    audioCtx: null,
    gain: null,
    volume: 1,
    playhead: 0,
    reason,
    id,
    lastVideo: Date.now(), // último quadro desenhado (o vigia usa)
  };
  relayIn.set(id, r);
  removeTile(id);
  createTile(id, canvas, {
    onVolume: (v) => ((r.volume = v), r.gain && (r.gain.gain.value = v)),
    onDirect: () => relayToDirect(id),
    onQuality: (v) => askQuality(id, v),
  });
  setTileStatus(id, 'plano B · carregando...');
  send({ type: 'relay-sub', to: id, on: true });
  const name = p ? p.name : '?';
  if (reason === 'auto') toast(`Conexão direta com ${name} falhou. Usando o plano B.`);
  if (reason === 'sender') toast(`${name} ativou o plano B para todos.`);
}

// Sai do plano B e volta a mostrar a conexão direta (se ainda tiver as trilhas).
function relayToDirect(id) {
  if (relayIn.has(id)) logEvent(`${peers.get(id)?.name || '?'}: saindo do plano B, voltando para a direta`);
  relayUnsubscribe(id, true);
  const p = peers.get(id);
  if (!p || !p.sharing || p.unwatched) return;
  const tracks = p.pc
    .getTransceivers()
    .filter((t) => ['recvonly', 'sendrecv'].includes(t.currentDirection) && t.receiver.track.readyState === 'live')
    .map((t) => t.receiver.track);
  p.lastDirectOk = Date.now(); // dá um tempo para a direta antes de voltar ao plano B
  if (!tracks.length) return;
  showTile(id, new MediaStream(tracks), false);
  setTileStatus(id, p.pc.connectionState === 'connected' ? 'direto' : 'conectando...');
}

function relayUnsubscribe(id, notify) {
  const r = relayIn.get(id);
  if (!r) return;
  relayIn.delete(id);
  clearTimeout(r.pumpTimer);
  r.chunks = [];
  for (const d of [r.vdec, r.adec]) if (d && d.state !== 'closed') d.close();
  if (r.audioCtx) r.audioCtx.close();
  removeTile(id);
  if (notify) send({ type: 'relay-sub', to: id, on: false });
}

function requestKey(id, r) {
  // Reenviar o pedido faz quem compartilha mandar um quadro-chave.
  if (performance.now() - r.lastKeyReq < 1000) return;
  r.lastKeyReq = performance.now();
  send({ type: 'relay-sub', to: id, on: true });
}

function onRelayData(buf) {
  const bytes = new Uint8Array(buf);
  const id = new TextDecoder().decode(bytes.subarray(0, 36));
  if (bytes[36] === CAM_MAGIC) return onCamRelay(id, bytes);
  const r = relayIn.get(id);
  if (!r) return;
  r.statBytes += bytes.length;
  const dv = new DataView(buf);
  let off = 36;
  while (off + 4 <= bytes.length) {
    const len = dv.getUint32(off);
    const start = off + 4;
    off = start + len;
    if (off > bytes.length) break;
    const kind = bytes[start];
    const key = (bytes[start + 1] & 1) === 1;
    const timestamp = dv.getFloat64(start + 2);
    let p = start + 10;
    try {
      if (kind === 0) {
        let codec = r.codec;
        if (key) {
          const n = bytes[p];
          codec = new TextDecoder().decode(bytes.subarray(p + 1, p + 1 + n));
          p += 1 + n;
        }
        onRelayVideo(id, r, key, codec, timestamp, bytes.subarray(p, off));
      } else {
        const sampleRate = dv.getUint32(p);
        const numberOfChannels = bytes[p + 4];
        onRelayAudio(r, sampleRate, numberOfChannels, timestamp, bytes.subarray(p + 5, off));
      }
    } catch (err) {
      console.warn('plano B (recebendo)', err);
    }
  }
}

// Os pacotes do plano B chegam em lotes (a cada 100 ms). Decodificar e
// desenhar na hora que chegam dá engasgos; então eles esperam numa fila
// (ainda comprimidos) e são decodificados no ritmo em que foram capturados,
// com um atraso fixo (a "suavidade" das configurações).
function onRelayVideo(id, r, key, codec, timestamp, data) {
  r.chunks.push({ key, codec, timestamp, data });
  if (r.chunks.length > 400) {
    // Ficou para trás demais (aba escondida etc.): recomeça do próximo quadro-chave.
    r.chunks = [];
    r.waitingKey = true;
    r.base = undefined;
    return requestKey(id, r);
  }
  pumpRelay(id, r);
}

function pumpRelay(id, r) {
  clearTimeout(r.pumpTimer);
  if (relayIn.get(id) !== r || !r.chunks.length) return;
  const now = performance.now();
  const delay = document.hidden ? 0 : smoothDelay();
  const due = (c) => r.base + c.timestamp / 1000;
  const first = r.chunks[0];
  const lastC = r.chunks[r.chunks.length - 1];
  // Relógio: tempo local = base + timestamp de captura. Refaz se saiu do eixo.
  if (r.base === undefined || due(first) > now + delay + 1000 || due(lastC) < now - 300) {
    r.base = now + delay - first.timestamp / 1000;
  }
  while (r.chunks.length && due(r.chunks[0]) <= now) {
    const c = r.chunks.shift();
    decodeRelayVideo(id, r, c.key, c.codec, c.timestamp, c.data);
  }
  if (r.chunks.length) r.pumpTimer = setTimeout(() => pumpRelay(id, r), Math.max(0, due(r.chunks[0]) - now));
}

function decodeRelayVideo(id, r, key, codec, timestamp, data) {
  if (r.waitingKey && !key) return requestKey(id, r);
  if (!r.vdec || r.vdec.state === 'closed' || (key && codec !== r.codec)) {
    if (!key) return requestKey(id, r);
    if (r.vdec && r.vdec.state !== 'closed') r.vdec.close();
    r.vdec = new VideoDecoder({
      output: (frame) => drawRelayFrame(id, r, frame),
      error: (err) => {
        console.warn('VideoDecoder', err);
        r.waitingKey = true;
      },
    });
    r.vdec.configure({ codec, optimizeForLatency: true });
    r.codec = codec;
  }
  // Atrasou demais: joga fora e espera o próximo quadro-chave.
  if (r.vdec.decodeQueueSize > 10) {
    r.vdec.close();
    r.waitingKey = true;
    return requestKey(id, r);
  }
  r.waitingKey = false;
  r.vdec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
}

function drawRelayFrame(id, r, frame) {
  const { canvas } = r;
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    setTileStatus(id, 'plano B');
  }
  r.ctx2d.drawImage(frame, 0, 0);
  clipBufs.get(id)?.addFrame(frame);
  frame.close();
  r.lastVideo = Date.now();
  r.statFrames++;
  // Travada = intervalo grande entre quadros com vídeo chegando normalmente.
  const t = performance.now();
  if (r.lastDraw && t - r.lastDraw > 300 && r.chunks.length && !document.hidden) r.freezes++;
  r.lastDraw = t;
}

function onRelayAudio(r, sampleRate, numberOfChannels, timestamp, data) {
  if (!('AudioDecoder' in window)) return;
  if (!r.audioCtx) {
    r.audioCtx = new AudioContext({ latencyHint: 'interactive' });
    r.gain = r.audioCtx.createGain();
    r.gain.gain.value = r.volume;
    r.gain.connect(r.audioCtx.destination);
  }
  if (r.audioCtx.state === 'suspended' && performance.now() - (r.resumeAt || 0) > 1000) {
    // Sem clique na página o navegador não deixa: continua suspenso.
    r.resumeAt = performance.now();
    r.audioCtx.resume().catch(() => {});
    setTimeout(() => r.audioCtx?.state === 'suspended' && relayIn.get(r.id) === r && markSoundBlocked(r.id, null), 800);
  }
  const fmt = `${sampleRate}/${numberOfChannels}`;
  if (!r.adec || r.adec.state === 'closed' || r.afmt !== fmt) {
    if (r.adec && r.adec.state !== 'closed') r.adec.close();
    r.adec = new AudioDecoder({
      output: (audio) => playRelayAudio(r, audio),
      error: (err) => console.warn('AudioDecoder', err),
    });
    r.adec.configure({ codec: 'opus', sampleRate, numberOfChannels });
    r.afmt = fmt;
  }
  r.adec.decode(new EncodedAudioChunk({ type: 'key', timestamp, data }));
}

const VIDEO_SHOW_MS = 25; // tempo até o quadro decodificado aparecer na tela

function playRelayAudio(r, audio) {
  const ctx = r.audioCtx;
  const ts = audio.timestamp;
  const buffer = ctx.createBuffer(audio.numberOfChannels, audio.numberOfFrames, audio.sampleRate);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const plane = new Float32Array(audio.numberOfFrames);
    audio.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
    buffer.copyToChannel(plane, c);
  }
  clipBufs.get(r.id)?.addAudio(audio);
  audio.close();
  const now = ctx.currentTime;
  // Hora certa de tocar: mesmo relógio da imagem (r.base, ver pumpRelay),
  // descontando o atraso da própria saída de som.
  const nowMs = performance.now();
  if (r.base === undefined) r.base = nowMs + smoothDelay() - ts / 1000;
  const outLag = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  let when = now + (r.base + ts / 1000 + VIDEO_SHOW_MS - nowMs) / 1000 - outLag;
  if (Math.abs(when - now) > 3) {
    // Relógios não batem (ex.: quem compartilha está numa versão antiga): toca com o atraso fixo.
    const lag = Math.max(0.08, smoothDelay() / 1000);
    when = r.playhead >= now + 0.02 && r.playhead <= now + lag + 0.5 ? r.playhead : now + lag;
  }
  // Emenda com o pedaço anterior se a diferença for mínima (evita estalos).
  if (Math.abs(when - r.playhead) < 0.03) when = r.playhead;
  let skip = 0;
  if (when < now) {
    skip = now - when; // chegou atrasado: pula o pedaço que já passou
    if (skip >= buffer.duration) return;
    when = now;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(r.gain);
  src.start(when, skip);
  r.playhead = when + buffer.duration - skip;
}

// ---------------------------------------------------------------------------
// Compartilhar tela
// ---------------------------------------------------------------------------
$('shareBtn').addEventListener('click', () => (localStream ? stopShare() : startShare()));
$('switchBtn').addEventListener('click', switchShare);

$('planBBtn').addEventListener('click', () => {
  relayAll = !relayAll;
  for (const id of peers.keys()) send({ type: 'signal', to: id, data: { relay: relayAll } });
  updatePlanBBtn();
  toast(relayAll ? 'Plano B ligado: todo mundo recebe sua tela pelo plano B.' : 'Plano B desligado: volta para a conexão direta.');
});

// Qualidade / modo / fps podem ser trocados durante a transmissão.
$('quality').addEventListener('change', () => {
  applyCaptureSize();
  tuneAll();
});
$('mode').addEventListener('change', () => {
  const video = localStream?.getVideoTracks()[0];
  applyContentHint();
  tuneAll();
});
$('fps').addEventListener('change', () => {
  const fps = Number($('fps').value);
  const video = localStream?.getVideoTracks()[0];
  if (video) applyCaptureSize();
  applyContentHint();
  tuneAll();
  if (fps >= 60 && $('mode').value !== 'motion') toast('Dica: em "Nitidez" fica em ~30 fps. Para 60 fps, use "Fluidez".');
});

// Liga/desliga o som que vai junto com a tela (para todos, direto e plano B).
$('audioBtn').addEventListener('click', () => {
  setShareAudio(!shareAudioOn);
  toast(shareAudioOn ? 'Som da transmissão ligado.' : 'Som da transmissão desligado: ninguém ouve o som do seu PC.');
});

function setShareAudio(on) {
  shareAudioOn = on;
  const tracks = localStream?.getAudioTracks() || [];
  for (const t of tracks) t.enabled = on;
  $('audioBtn').hidden = !tracks.length;
  $('audioBtn').textContent = on ? '🔊 Som da tela' : '🔇 Som da tela (mudo)';
  $('audioBtn').classList.toggle('off', !on);
}

function updatePlanBBtn() {
  // Só aparece se este navegador consegue enviar pelo plano B (Chrome/Edge).
  $('planBBtn').hidden = !localStream || !canSendRelay();
  $('planBBtn').textContent = relayAll ? 'Plano B p/ todos: ligado' : 'Plano B p/ todos';
  $('planBBtn').classList.toggle('on', relayAll);
}

// Tamanho da captura: 2K/4K só quando a qualidade pede (capturar grande pesa no PC).
const CAPTURE = { ultra: { width: 3840, height: 2160 }, qhd: { width: 2560, height: 1440 } };
const captureSize = () => CAPTURE[$('quality').value] || { width: 1920, height: 1080 };

function applyCaptureSize() {
  const video = localStream?.getVideoTracks()[0];
  if (!video) return;
  const { width, height } = captureSize();
  const fps = Number($('fps').value);
  video.applyConstraints({ width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } }).catch(() => {});
}

function displayMediaOptions() {
  const fps = Number($('fps').value);
  const { width, height } = captureSize();
  return {
    video: { frameRate: { ideal: fps, max: fps }, width: { ideal: width }, height: { ideal: height } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
    // Chrome 141+: ao compartilhar uma janela, pega só o som dela (e não o
    // do Discord). Navegadores antigos ignoram.
    windowAudio: 'window',
    selfBrowserSurface: 'exclude',
  };
}

async function startShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions());
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Não foi possível capturar a tela: ' + err.message);
    return;
  }
  const video = localStream.getVideoTracks()[0];
  applyContentHint();
  video.addEventListener('ended', stopShare); // botão "Parar de compartilhar" do navegador
  if (nativeApp) {
    const track = await startNativeAudio();
    if (track) localStream.addTrack(track);
  }

  for (const id of peers.keys()) addTracksTo(id);
  send({ type: 'sharing', on: true });
  showTile(myId, localStream, true);
  setPreview(settings.preview);
  $('shareBtn').textContent = 'Parar de compartilhar';
  $('shareBtn').classList.add('on');
  $('switchBtn').hidden = false;
  setShareAudio(true);
  updatePlanBBtn();
  renderPeers();
  // Tela inteira (ou janela em Chrome antigo) manda TODO o som do PC,
  // inclusive o Discord. O navegador não deixa tirar só um programa.
  if (!nativeApp && localStream.getAudioTracks().length && video.getSettings().displaySurface !== 'browser') {
    toast('Atenção: vai junto todo o som do PC, até o Discord. Para mandar só o som de um vídeo, compartilhe uma ABA; ou desligue em 🔊.', 9000);
  }
}

// Troca o que está sendo compartilhado (outra janela/tela) sem derrubar
// ninguém: o vídeo novo entra no lugar do antigo em todas as conexões.
async function switchShare() {
  if (!localStream) return startShare();
  let fresh;
  try {
    fresh = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions());
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Não foi possível capturar a tela: ' + err.message);
    return;
  }
  const oldVideo = localStream.getVideoTracks()[0];
  const video = fresh.getVideoTracks()[0];
  const oldAudio = nativeApp ? null : localStream.getAudioTracks()[0];
  const audio = nativeApp ? null : fresh.getAudioTracks()[0];
  if (!nativeApp && !!oldAudio !== !!audio) {
    // Mudou de "com som" para "sem som" (ou o contrário): recomeça tudo.
    fresh.getTracks().forEach((t) => t.stop());
    stopShare();
    return startShare();
  }
  video.addEventListener('ended', stopShare);
  for (const p of peers.values()) {
    for (const s of p.senders) {
      if (s.track === oldVideo) s.replaceTrack(video).catch(() => {});
      if (oldAudio && s.track === oldAudio) s.replaceTrack(audio).catch(() => {});
    }
  }
  localStream.removeTrack(oldVideo);
  oldVideo.removeEventListener('ended', stopShare);
  oldVideo.stop();
  localStream.addTrack(video);
  if (oldAudio) {
    localStream.removeTrack(oldAudio);
    oldAudio.stop();
    localStream.addTrack(audio);
    audio.enabled = shareAudioOn;
  }
  applyContentHint();
  // No app, o som "só do programa" segue a nova janela.
  if (nativeApp && nativeAudio) nativeApp.startAudio(settings.appAudio);
  // Plano B: recomeça com a nova captura (quem assiste continua inscrito).
  if (relayOut.running) {
    stopRelay();
    startRelay();
  }
  tuneAll();
  const tile = tiles.get(myId);
  const v = tile?.querySelector('video');
  if (v && settings.preview) {
    v.srcObject = null;
    v.srcObject = localStream;
  }
  toast('Transmissão trocada.');
}

function stopShare() {
  if (!localStream) return;
  stopNativeAudio();
  stopRelay();
  relayOut.viewers.clear();
  for (const p of peers.values()) {
    removeTracksFrom(p);
    p.noSend = false; // a próxima transmissão vai para todo mundo de novo
  }
  localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  send({ type: 'sharing', on: false });
  removeTile(myId);
  $('shareBtn').textContent = 'Compartilhar tela';
  $('shareBtn').classList.remove('on');
  $('switchBtn').hidden = true;
  relayAll = false;
  setShareAudio(true);
  updatePlanBBtn();
  renderPeers();
}

// ---------------------------------------------------------------------------
// UI: telas
// ---------------------------------------------------------------------------
const QUALITY_OPTIONS = [
  ['auto', 'Auto'],
  ['ultra', '4K'],
  ['qhd', '2K'],
  ['alta', '1080p'],
  ['media', '720p'],
  ['baixa', '480p'],
  ['minima', '360p'],
];

// ---------------------------------------------------------------------------
// Clipes e replay (clips.js): cada live que eu assisto tem uma memória curta.
// ---------------------------------------------------------------------------
const clipBufs = new Map(); // id -> ClipBuffer
const clipTaps = new Map(); // id -> { stream, stop() } (conexão direta)

function ensureClipBuffer(id) {
  if (settings.clips === 'off' || !clipsSupported()) return null;
  let b = clipBufs.get(id);
  if (!b) {
    b = new ClipBuffer(settings.clips);
    clipBufs.set(id, b);
  }
  return b;
}

function closeClips(id) {
  stopClipTap(id);
  clipBufs.get(id)?.close();
  clipBufs.delete(id);
}

// Conexão direta: lê os quadros/áudio da live (cópias das trilhas) para a memória.
function startClipTap(id, stream) {
  const old = clipTaps.get(id);
  if (old && old.stream === stream && old.count === stream.getTracks().length) return;
  stopClipTap(id);
  if (!ensureClipBuffer(id)) return;
  const tracks = stream.getTracks().map((t) => t.clone());
  let running = true;
  const pump = async (track) => {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    try {
      while (running) {
        const { value, done } = await reader.read();
        if (done) break;
        const b = clipBufs.get(id);
        if (b) track.kind === 'video' ? b.addFrame(value) : b.addAudio(value);
        value.close();
      }
    } catch {}
    reader.cancel().catch(() => {});
  };
  tracks.forEach(pump);
  clipTaps.set(id, {
    stream,
    count: tracks.length,
    stop() {
      running = false;
      tracks.forEach((t) => t.stop());
    },
  });
}

function stopClipTap(id) {
  clipTaps.get(id)?.stop();
  clipTaps.delete(id);
}

// Ligou/desligou/mudou a qualidade nas configurações.
function refreshClips() {
  for (const id of [...clipBufs.keys()]) closeClips(id);
  for (const [id, tile] of tiles) {
    if (id === myId) continue;
    tile.classList.toggle('noclips', settings.clips === 'off');
    ensureClipBuffer(id);
    const video = tile.querySelector('video');
    if (video?.srcObject) startClipTap(id, video.srcObject);
  }
}

const clipName = (id) =>
  `clipe-${(peers.get(id)?.name || 'telinha').replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.mp4`;

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function saveClip(id) {
  const b = clipBufs.get(id);
  if (!b || b.seconds() < 1) return toast('Ainda não tem nada gravado dessa live (espere alguns segundos).');
  const blob = await b.export(settings.clipLen);
  if (!blob) return toast('Não consegui montar o clipe.');
  downloadBlob(blob, clipName(id));
  toast(`Clipe salvo (${Math.min(settings.clipLen, Math.round(b.seconds()))} s) na pasta Downloads.`);
}

async function openReplay(id) {
  const b = clipBufs.get(id);
  if (!b || b.seconds() < 1) return toast('Ainda não tem nada gravado dessa live (espere alguns segundos).');
  const blob = await b.export(60);
  if (!blob) return toast('Não consegui montar o replay.');
  const url = URL.createObjectURL(blob);
  const v = $('replayVideo');
  v.src = url;
  $('replayTitle').textContent = `Replay de ${peers.get(id)?.name || '?'} (último minuto)`;
  $('replay').hidden = false;
  v.onloadedmetadata = () => {
    // Começa 15 s antes do fim; dá para arrastar para trás.
    if (Number.isFinite(v.duration)) v.currentTime = Math.max(0, v.duration - 15);
    v.play().catch(() => {});
  };
  $('replaySave').onclick = () => downloadBlob(blob, clipName(id));
  $('replayClose').onclick = () => {
    v.pause();
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
    $('replay').hidden = true;
  };
}

// Parar de assistir alguém: some a tela e ele para de me mandar o vídeo.
function stopWatching(id) {
  const p = peers.get(id);
  if (!p) return;
  p.unwatched = true;
  closeClips(id);
  relayUnsubscribe(id, true);
  removeTile(id);
  send({ type: 'signal', to: id, data: { watch: false } });
  renderPeers();
  toast(`Você parou de assistir ${p.name}. Para voltar, clique em "Assistir" na lista de participantes.`, 6000);
}

function startWatching(id) {
  const p = peers.get(id);
  if (!p) return;
  p.unwatched = false;
  p.lastDirectOk = undefined;
  send({ type: 'signal', to: id, data: { watch: true } });
  if (FORCE_RELAY) relaySubscribe(id, 'manual');
  renderPeers();
  toast(`Carregando a tela de ${p.name}...`);
}

// Recarregar a tela de alguém: refaz a conexão do zero (resolve tela
// congelada/preta sem precisar sair da sessão).
function reloadWatch(id) {
  const p = peers.get(id);
  if (!p) return;
  const wasRelay = relayIn.get(id)?.reason;
  relayUnsubscribe(id, true);
  removeTile(id);
  resetPeerConnection(id);
  if (localStream) addTracksTo(id); // se eu também transmito para ele
  send({ type: 'signal', to: id, data: { reset: true } });
  if (wasRelay === 'manual' || wasRelay === 'sender' || FORCE_RELAY) setTimeout(() => relaySubscribe(id, wasRelay || 'manual'), 500);
  toast(`Recarregando a tela de ${p.name}...`);
}

// Quem assiste pede uma qualidade só para si (útil se a internet dele é fraca).
function askQuality(id, value) {
  const p = peers.get(id);
  if (p) p.myWant = value;
  send({ type: 'signal', to: id, data: { wantQuality: value } });
  toast(value === 'auto' ? 'Qualidade automática.' : `Pedindo ${QUALITY_OPTIONS.find((o) => o[0] === value)[1]}...`);
}

function createTile(id, media, { isLocal = false, onVolume = null, onPlanB = null, onDirect = null, onQuality = null, onPreview = null } = {}) {
  const remote = !isLocal;
  removeTile(id); // nunca duas telas da mesma pessoa
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.innerHTML = `
    <span class="label"><span class="who"></span><span class="status"></span></span>
    ${isLocal ? '' : '<span class="stats"></span>'}
    <div class="controls">
      ${onQuality ? '<select class="q" title="Qualidade que você recebe (se travar, diminua)"></select>' : ''}
      ${onVolume ? '<span title="Volume">🔊</span><input type="range" min="0" max="1" step="0.05" value="1">' : ''}
      ${onPlanB ? '<button class="planb" title="A tela não carrega? Use o plano B">Plano B</button>' : ''}
      ${onDirect ? '<button class="planb direct" title="Tentar de novo a conexão direta (menos atraso)">Direto</button>' : ''}
      ${onPreview ? '<button class="pv" title="Esconder a prévia economiza o PC (os outros continuam vendo)">🙈 Ocultar prévia</button>' : ''}
      ${remote ? '<button class="clipbtn" title="Salvar clipe dos últimos segundos (MP4)">🎬</button>' : ''}
      ${remote ? '<button class="replaybtn" title="Replay: voltar alguns segundos sem largar a live">⏪</button>' : ''}
      ${remote ? '<button class="reload" title="Recarregar esta tela (se congelou ou ficou preta)">🔄</button>' : ''}
      ${remote ? '<button class="unwatch" title="Parar de assistir esta pessoa">✕</button>' : ''}
      <button class="fs" title="Tela cheia">⛶</button>
    </div>`;
  tile.prepend(media);
  tile.querySelector('.who').textContent = isLocal ? 'Você (prévia)' : peers.get(id)?.name || '???';
  const vol = tile.querySelector('input[type=range]');
  if (vol) vol.addEventListener('input', () => onVolume(Number(vol.value)));
  const qSel = tile.querySelector('.q');
  if (qSel) {
    for (const [v, t] of QUALITY_OPTIONS) qSel.add(new Option(t, v));
    qSel.value = peers.get(id)?.myWant || 'auto';
    qSel.addEventListener('change', () => onQuality(qSel.value));
  }
  const planB = tile.querySelector('.planb');
  if (planB) planB.addEventListener('click', onPlanB);
  if (remote) {
    tile.querySelector('.reload').addEventListener('click', () => reloadWatch(id));
    tile.querySelector('.clipbtn').addEventListener('click', () => saveClip(id));
    tile.querySelector('.replaybtn').addEventListener('click', () => openReplay(id));
    if (settings.clips === 'off' || !clipsSupported()) tile.classList.add('noclips');
    ensureClipBuffer(id);
    tile.querySelector('.unwatch').addEventListener('click', () => stopWatching(id));
  }
  const pv = tile.querySelector('.pv');
  if (pv) pv.addEventListener('click', onPreview);
  const direct = tile.querySelector('.direct');
  if (direct) direct.addEventListener('click', onDirect);
  const fs = () => (document.fullscreenElement ? document.exitFullscreen() : tile.requestFullscreen());
  tile.querySelector('.fs').addEventListener('click', fs);
  media.addEventListener('dblclick', fs);
  tiles.set(id, tile);
  $('stage').appendChild(tile);
  updateStage();
  return tile;
}

function showTile(id, stream, isLocal) {
  let tile = tiles.get(id);
  if (!tile) {
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;
    tile = createTile(id, video, {
      isLocal,
      onVolume: isLocal ? null : (v) => ((video.volume = v), unmuteVideo(id)),
      onPlanB: isLocal ? null : () => relaySubscribe(id, 'manual'),
      onQuality: isLocal ? null : (v) => askQuality(id, v),
      onPreview: isLocal ? () => setPreview(!settings.preview) : null,
    });
    if (isLocal) updateLocalLabel();
  }
  const video = tile.querySelector('video');
  if (!isLocal) startClipTap(id, stream);
  if (video && video.srcObject !== stream) {
    video.srcObject = stream;
    playTileVideo(id, video, isLocal);
  } else if (video && !isLocal && video.paused) {
    playTileVideo(id, video, false); // chegou a trilha de som depois do vídeo
  }
}

// O navegador só deixa tocar som depois que a pessoa clica/aperta algo na
// página. Entrando sozinho na sala (volta automática) ainda não houve clique:
// aí a tela toca muda, aparece o botão "Clique para ativar o som" e o
// primeiro clique em qualquer lugar liga o som de tudo (direto e plano B).
function playTileVideo(id, video, isLocal) {
  video.play().catch((err) => {
    if (err.name !== 'NotAllowedError' || !video.isConnected) return;
    markSoundBlocked(id, video);
    video.play().catch(() => {});
  });
}

function markSoundBlocked(id, video) {
  if (video) {
    video.muted = true;
    video.dataset.soundBlocked = '1';
  }
  const tile = tiles.get(id);
  if (!tile || tile.querySelector('.unmute')) return;
  const b = document.createElement('button');
  b.className = 'unmute primary';
  b.textContent = '🔇 Clique para ativar o som';
  tile.appendChild(b); // o clique em si já libera (ver unlockSound)
  if (!markSoundBlocked.warned) {
    markSoundBlocked.warned = true;
    toast('O navegador bloqueou o som até você clicar na página. Clique em qualquer lugar para ouvir.');
  }
}

function unmuteVideo(id) {
  const tile = tiles.get(id);
  const video = tile?.querySelector('video');
  if (video?.dataset.soundBlocked) {
    delete video.dataset.soundBlocked;
    video.muted = false;
    video.play().catch(() => {
      // Ainda não deixou: volta a tocar mudo.
      markSoundBlocked(id, video);
      video.play().catch(() => {});
    });
  }
  if (!video?.dataset.soundBlocked) tile?.querySelector('.unmute')?.remove();
}

function unlockSound() {
  for (const id of tiles.keys()) if (id !== myId && tiles.get(id).querySelector('.unmute')) unmuteVideo(id);
  for (const r of relayIn.values()) if (r.audioCtx?.state === 'suspended') r.audioCtx.resume().catch(() => {});
  markSoundBlocked.warned = false;
}
for (const ev of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(ev, () => setTimeout(unlockSound, 0), true);

function setTileStatus(id, text) {
  const el = tiles.get(id)?.querySelector('.status');
  if (el) el.textContent = text ? ` · ${text}` : '';
}

function updateLocalLabel() {
  const n = relayOut.viewers.size;
  setTileStatus(myId, n ? `plano B para ${n} pessoa${n > 1 ? 's' : ''}` : '');
}

function removeTile(id) {
  stopClipTap(id);
  const tile = tiles.get(id);
  if (!tile) return;
  const video = tile.querySelector('video');
  if (video) video.srcObject = null;
  tile.remove();
  tiles.delete(id);
  updateStage();
}

function updateStage() {
  $('empty').hidden = tiles.size > 0;
  $('stage').classList.toggle('single', tiles.size === 1);
}

function renderPeers() {
  const list = $('peerList');
  list.innerHTML = '';
  const all = [{ name: myName + ' (você)', sharing: !!localStream }, ...[...peers].map(([id, p]) => Object.assign(p, { id }))];
  for (const p of all) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="dot"></span><span class="n"></span>';
    li.querySelector('.n').textContent = p.name;
    if (p.away) li.classList.add('away');
    if (p.away) li.insertAdjacentHTML('beforeend', '<span class="hint">reconectando...</span>');
    if (p.sharing) li.insertAdjacentHTML('beforeend', '<span class="live">AO VIVO</span>');
    if (p.sharing && p.id) {
      const b = document.createElement('button');
      b.className = 'watch';
      b.textContent = p.unwatched ? 'Assistir' : 'Parar';
      b.title = p.unwatched ? 'Voltar a assistir' : 'Parar de assistir';
      b.addEventListener('click', () => (p.unwatched ? startWatching(p.id) : stopWatching(p.id)));
      li.appendChild(b);
    }
    decoratePeer(li, p);
    list.appendChild(li);
  }
  $('peerCount').textContent = `${all.length} online`;
}

// ---------------------------------------------------------------------------
// UI: chat, link, sair, toast
// ---------------------------------------------------------------------------
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  if (!send({ type: 'chat', text })) return toast('Sem conexão com o servidor agora. Tente de novo em instantes.');
  $('chatInput').value = '';
});

function chat(name, text) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = '<b></b>: <span></span>';
  div.querySelector('b').textContent = name;
  div.querySelector('span').textContent = text;
  appendLog(div);
}

function sys(text) {
  const div = document.createElement('div');
  div.className = 'sys';
  div.textContent = text;
  appendLog(div);
}

function appendLog(el) {
  const log = $('chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(el);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

$('copyBtn').addEventListener('click', async () => {
  const link = location.origin + location.pathname + '?s=' + encodeURIComponent($('roomName').textContent);
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copiado! (a senha não vai junto)');
  } catch {
    toast(link);
  }
});

$('leaveBtn').addEventListener('click', () => {
  forgetLast();
  stopShare();
  stopCam();
  send({ type: 'leave' });
  leaving = true;
  ws.close();
  location.href = location.pathname;
});

// ---------------------------------------------------------------------------
// "Baixar app": abre o meme numa aba nova e baixa o .exe. O arquivo fica no
// próprio site em pedaços de 24 MB (o Cloudflare não aceita arquivos > 25 MB);
// aqui os pedaços são baixados e juntados de volta.
// ---------------------------------------------------------------------------
let downloading = false;
for (const btn of document.querySelectorAll('.download-btn')) {
  btn.addEventListener('click', () => {
    if (window.MEME_URL) window.open(window.MEME_URL, '_blank', 'noopener'); // tem que ser já, no clique
    downloadApp();
  });
}

async function downloadApp() {
  if (downloading) return;
  downloading = true;
  const btns = [...document.querySelectorAll('.download-btn')];
  const labels = btns.map((b) => b.textContent);
  const show = (t) => btns.forEach((b) => ((b.textContent = t), (b.disabled = true)));
  try {
    show('Preparando...');
    const info = await (await fetch('download/app.json', { cache: 'no-cache' })).json();
    const blobs = [];
    let got = 0;
    for (const part of info.parts) {
      const res = await fetch('download/' + part);
      if (!res.ok) throw new Error('pedaço ' + part + ' (' + res.status + ')');
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        blobs.push(value);
        got += value.length;
        show(`Baixando ${Math.floor((got / info.size) * 100)}%`);
      }
    }
    if (got !== info.size) throw new Error('arquivo incompleto');
    const url = URL.createObjectURL(new Blob(blobs, { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = info.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(
      nativeApp
        ? 'Baixado! Feche este app e abra o ' + info.name + ' (na pasta Downloads). Pode apagar o antigo.'
        : 'Pronto! Abra o ' + info.name + '. Se o Windows reclamar: "Mais informações" → "Executar assim mesmo".',
      10000,
    );
  } catch (err) {
    toast('Não deu para baixar o app: ' + err.message);
  } finally {
    downloading = false;
    btns.forEach((b, i) => ((b.textContent = labels[i]), (b.disabled = false)));
  }
}

let toastTimer;
function toast(text, ms = 3500) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), ms);
}
