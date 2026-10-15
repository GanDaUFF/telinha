'use strict';
// Webcam e o "Duelo de Aura".
//
// Câmera: cada par de pessoas tem uma conexão WebRTC só para as câmeras
// (separada da tela, para uma não atrapalhar a outra). Se a direta não
// conectar (NAT simétrico etc.), a câmera vai pelo servidor como fotos JPEG
// pequenas, algumas por segundo ("plano B da câmera").
//
// Duelo de Aura: alguém desafia outra pessoa; os dois recebem um desafio
// (ex.: "olhar de protagonista na chuva") e farmam aura na câmera por 15 s.
// Quem dá a nota é o sistema: aura.js analisa o rosto na câmera de cada
// duelista (no PC dele) e manda a nota para quem desafiou, que organiza o
// duelo e avisa todo mundo. A galera só manda 🔥 de hype.
// A aura de cada um fica salva no próprio navegador e vai junto para as
// próximas sessões.
//
// Usa as funções globais de app.js (send, peers, getPeer, toast, sys...).

const CAM_RELAY_FPS = 4;
const CAM_RELAY_W = 320;
const CAM_DIRECT_TIMEOUT = 8000;
const CAM_MAGIC = 0xca; // 1º byte do corpo binário = foto da câmera

let camStream = null; // minha câmera
const camPeers = new Map(); // id -> { pc, polite, makingOffer, ignoreOffer, sender, on, stream, relay, since, frameUrl, lastFrame }
const camRelayTo = new Set(); // quem recebe minha câmera pelo plano B
let camRelayTimer = null;
const camViews = new Map(); // id -> Set de elementos .camview que mostram a câmera dessa pessoa

// ---------------------------------------------------------------------------
// Ligar/desligar a minha câmera
// ---------------------------------------------------------------------------
async function startCam() {
  if (camStream) return true;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } },
      audio: false,
    });
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Câmera bloqueada. Libere a câmera para o site (cadeado na barra de endereço).' : 'Não achei uma câmera neste PC.');
    return false;
  }
  const track = camStream.getVideoTracks()[0];
  track.contentHint = 'motion';
  track.addEventListener('ended', () => stopCam());
  logEvent('Câmera ligada');
  for (const id of peers.keys()) camSendTo(id);
  camBroadcast({ camOn: true });
  updateCamBtn();
  renderCams();
  return true;
}

function stopCam() {
  if (!camStream) return;
  camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  for (const c of camPeers.values()) {
    if (c.sender) {
      try { c.pc.removeTrack(c.sender); } catch {}
      c.sender = null;
    }
  }
  camRelayTo.clear();
  camUpdateRelayLoop();
  camBroadcast({ camOn: false });
  logEvent('Câmera desligada');
  updateCamBtn();
  renderCams();
}

function updateCamBtn() {
  const b = $('camBtn');
  b.classList.toggle('on', !!camStream);
  b.textContent = camStream ? '📷 Desligar câmera' : '📷 Câmera';
}
$('camBtn').addEventListener('click', () => (camStream ? stopCam() : startCam()));

// Manda um sinal para todo mundo da sala (o servidor só repassa de um para um).
function camBroadcast(data) {
  for (const id of peers.keys()) send({ type: 'signal', to: id, data });
}

// ---------------------------------------------------------------------------
// Conexão das câmeras (uma por par, "perfect negotiation" como a da tela)
// ---------------------------------------------------------------------------
function camPeer(id) {
  let c = camPeers.get(id);
  if (c) return c;
  c = { pc: null, polite: myId > id, makingOffer: false, ignoreOffer: false, sender: null, on: false, stream: null, relay: false, since: 0 };
  camPeers.set(id, c);
  const pc = new RTCPeerConnection({ iceServers });
  c.pc = pc;
  pc.onicecandidate = ({ candidate }) => candidate && send({ type: 'signal', to: id, data: { cam: { candidate } } });
  pc.onnegotiationneeded = async () => {
    try {
      c.makingOffer = true;
      await pc.setLocalDescription();
      send({ type: 'signal', to: id, data: { cam: { description: pc.localDescription } } });
    } catch (err) {
      console.warn('câmera', err);
    } finally {
      c.makingOffer = false;
    }
  };
  pc.ontrack = ({ track, streams }) => {
    c.stream = streams[0] || new MediaStream([track]);
    refreshCamViews(id);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
    if (pc.connectionState === 'connected') camTune(c);
  };
  return c;
}

function camSendTo(id) {
  if (!camStream) return;
  const c = camPeer(id);
  if (c.sender) return;
  c.sender = c.pc.addTrack(camStream.getVideoTracks()[0], camStream);
  camTune(c);
}

// Câmera não precisa de muito: ~600 kbps, no máximo 480p.
async function camTune(c) {
  if (!c.sender) return;
  try {
    const params = c.sender.getParameters();
    if (!params.encodings?.length) return;
    params.encodings[0].maxBitrate = 600_000;
    params.encodings[0].maxFramerate = 24;
    params.degradationPreference = 'maintain-framerate';
    await c.sender.setParameters(params);
  } catch {}
}

async function onCamDescription(from, { description, candidate }) {
  const c = camPeer(from);
  const pc = c.pc;
  try {
    if (description) {
      const collision = description.type === 'offer' && (c.makingOffer || pc.signalingState !== 'stable');
      c.ignoreOffer = !c.polite && collision;
      if (c.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        send({ type: 'signal', to: from, data: { cam: { description: pc.localDescription } } });
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!c.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.warn('câmera (sinal)', err);
  }
}

// Vigia: câmera de alguém ligada mas sem imagem pela direta -> pede o plano B.
let camLastCheck = new Map();
setInterval(async () => {
  const now = Date.now();
  for (const [id, c] of camPeers) {
    if (!c.on) continue;
    let bytes = 0;
    try {
      (await c.pc.getStats()).forEach((s) => s.type === 'inbound-rtp' && s.kind === 'video' && (bytes += s.bytesReceived || 0));
    } catch {}
    const prev = camLastCheck.get(id) || 0;
    camLastCheck.set(id, bytes);
    const flowing = bytes > prev;
    if (flowing) c.lastDirect = now;
    if (!c.relay && now - Math.max(c.since, c.lastDirect || 0) > CAM_DIRECT_TIMEOUT) {
      c.relay = true;
      logEvent(`${peers.get(id)?.name || '?'}: câmera pelo plano B (direta não conectou)`);
      send({ type: 'signal', to: id, data: { camRelay: true } });
      refreshCamViews(id);
    } else if (c.relay && flowing && c.pc.connectionState === 'connected' && now - (c.relaySince || 0) > 5000) {
      c.relay = false;
      send({ type: 'signal', to: id, data: { camRelay: false } });
      refreshCamViews(id);
    }
    if (c.relay && !c.relaySince) c.relaySince = now;
    if (!c.relay) c.relaySince = 0;
    // Plano B parou de chegar: pede de novo (o pedido pode ter se perdido).
    if (c.relay && now - (c.lastFrame || c.relaySince) > 6000 && now - (c.lastAsk || 0) > 6000) {
      c.lastAsk = now;
      send({ type: 'signal', to: id, data: { camRelay: true } });
    }
  }
}, 1000);

// ---- Plano B da câmera: fotos JPEG pelo servidor ----
const camCanvas = document.createElement('canvas');
const camVideo = document.createElement('video');
camVideo.muted = true;
camVideo.playsInline = true;

function camUpdateRelayLoop() {
  const want = camStream && camRelayTo.size > 0;
  if (!want) {
    clearInterval(camRelayTimer);
    camRelayTimer = null;
    camVideo.srcObject = null;
    return;
  }
  if (camRelayTimer) return;
  camVideo.srcObject = camStream;
  camVideo.play().catch(() => {});
  camRelayTimer = setInterval(camSendFrame, 1000 / CAM_RELAY_FPS);
}

let camSending = false;
async function camSendFrame() {
  if (camSending || !camStream || !camRelayTo.size || !ws || ws.readyState !== 1) return;
  if (ws.bufferedAmount > 256 * 1024 || !camVideo.videoWidth) return; // rede apertada: pula esta foto
  camSending = true;
  try {
    const w = CAM_RELAY_W;
    const h = Math.round((camVideo.videoHeight / camVideo.videoWidth) * w / 2) * 2;
    camCanvas.width = w;
    camCanvas.height = h;
    camCanvas.getContext('2d').drawImage(camVideo, 0, 0, w, h);
    const blob = await new Promise((r) => camCanvas.toBlob(r, 'image/jpeg', 0.6));
    if (!blob) return;
    const jpg = new Uint8Array(await blob.arrayBuffer());
    const ids = [...camRelayTo].filter((id) => peers.has(id));
    const out = new Uint8Array(1 + ids.length * 36 + 1 + jpg.length);
    out[0] = ids.length;
    ids.forEach((id, i) => out.set(new TextEncoder().encode(id), 1 + i * 36));
    out[1 + ids.length * 36] = CAM_MAGIC;
    out.set(jpg, 2 + ids.length * 36);
    ws.send(out);
  } finally {
    camSending = false;
  }
}

// Chamado por onRelayData (app.js) quando o corpo começa com CAM_MAGIC.
function onCamRelay(id, bytes) {
  const c = camPeers.get(id);
  if (!c || !c.on) return;
  c.lastFrame = Date.now();
  const url = URL.createObjectURL(new Blob([bytes.subarray(37)], { type: 'image/jpeg' }));
  const old = c.frameUrl;
  c.frameUrl = url;
  for (const view of camViews.get(id) || []) {
    const img = view.querySelector('img');
    if (img) img.src = url;
  }
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  if (!camViews.get(id)?.size || ![...camViews.get(id)].some((v) => v.querySelector('img'))) refreshCamViews(id);
}

// ---------------------------------------------------------------------------
// Mostrar as câmeras
// ---------------------------------------------------------------------------
// Cria um quadradinho que mostra a câmera de alguém (myId = a minha).
function makeCamView(id, cls = '') {
  const view = document.createElement('div');
  view.className = 'camview ' + cls;
  view.dataset.id = id;
  if (!camViews.has(id)) camViews.set(id, new Set());
  camViews.get(id).add(view);
  fillCamView(view);
  return view;
}

function dropCamView(view) {
  const set = camViews.get(view.dataset.id);
  if (set) set.delete(view);
  const v = view.querySelector('video');
  if (v) v.srcObject = null;
  view.remove();
}

function fillCamView(view) {
  const id = view.dataset.id;
  const mine = id === myId;
  const c = camPeers.get(id);
  const label = mine ? 'Você' : peers.get(id)?.name || '???';
  let media = null;
  if (mine && camStream) {
    media = document.createElement('video');
    media.srcObject = camStream;
    media.classList.add('mirror');
  } else if (c?.on && c.relay) {
    media = document.createElement('img');
    media.alt = '';
    if (c.frameUrl) media.src = c.frameUrl;
  } else if (c?.on && c.stream) {
    media = document.createElement('video');
    media.srcObject = c.stream;
  }
  if (media?.tagName === 'VIDEO') {
    media.muted = true;
    media.autoplay = true;
    media.playsInline = true;
    media.play().catch(() => {});
  }
  const old = view.querySelector('video');
  if (old) old.srcObject = null;
  view.textContent = '';
  if (media) view.append(media);
  else {
    const ph = document.createElement('div');
    ph.className = 'cam-off';
    ph.textContent = (label[0] || '?').toUpperCase();
    view.append(ph);
  }
  const tag = document.createElement('span');
  tag.className = 'cam-name';
  tag.textContent = label + (c?.on && c.relay ? ' · plano B' : '');
  view.append(tag);
}

function refreshCamViews(id) {
  for (const view of camViews.get(id) || []) fillCamView(view);
  renderCams();
}

// A faixa de câmeras em cima das telas.
function renderCams() {
  const bar = $('camBar');
  const want = [];
  if (camStream) want.push(myId);
  for (const [id, c] of camPeers) if (c.on && peers.has(id)) want.push(id);
  const have = new Map([...bar.querySelectorAll('.camview')].map((v) => [v.dataset.id, v]));
  for (const [id, v] of have) if (!want.includes(id)) dropCamView(v);
  for (const id of want) if (!have.has(id)) bar.append(makeCamView(id));
  bar.hidden = !want.length;
  renderPeers();
}

// ---------------------------------------------------------------------------
// Ganchos chamados por app.js
// ---------------------------------------------------------------------------
// Sinais extras (câmera, aura, duelo). Devolve true se tratou.
function onExtraSignal(from, data) {
  if (!data) return false;
  if (data.cam) {
    onCamDescription(from, data.cam);
    return true;
  }
  if (data.camOn !== undefined) {
    const c = camPeer(from);
    c.on = !!data.camOn;
    c.since = Date.now();
    c.lastDirect = 0;
    if (!c.on) {
      c.stream = null;
      c.relay = false;
      if (c.frameUrl) URL.revokeObjectURL(c.frameUrl);
      c.frameUrl = null;
    }
    refreshCamViews(from);
    return true;
  }
  if (data.camRelay !== undefined) {
    if (data.camRelay) camRelayTo.add(from);
    else camRelayTo.delete(from);
    camUpdateRelayLoop();
    return true;
  }
  if (data.aura !== undefined) {
    getPeer(from).aura = Number(data.aura) || 0;
    renderPeers();
    return true;
  }
  if (data.duel) {
    onDuel(from, data.duel);
    return true;
  }
  if (data.bell) {
    playBell(peers.get(from)?.name || 'Alguém');
    return true;
  }
  return false;
}

// Alguém entrou (ou voltou com id novo): conta como estão minha câmera e aura.
function camPeerJoined(id) {
  send({ type: 'signal', to: id, data: { aura: myAura() } });
  if (camStream) {
    camSendTo(id);
    send({ type: 'signal', to: id, data: { camOn: true } });
  }
}

function camPeerLeft(id) {
  const c = camPeers.get(id);
  if (c) {
    c.pc.close();
    if (c.frameUrl) URL.revokeObjectURL(c.frameUrl);
    camPeers.delete(id);
  }
  camRelayTo.delete(id);
  camUpdateRelayLoop();
  for (const view of [...(camViews.get(id) || [])]) {
    if (view.closest('#camBar')) dropCamView(view);
    else fillCamView(view);
  }
  if (duel && (duel.a === id || duel.b === id || duel.host === id)) duelCancel(`${peers.get(id)?.name || 'Alguém'} saiu. Duelo cancelado.`);
  renderCams();
}

// Reconectou ao servidor: reavisa todo mundo.
function camRejoined(newId, oldId) {
  if (oldId && newId !== oldId) {
    const mine = camViews.get(oldId);
    if (mine) {
      camViews.delete(oldId);
      camViews.set(newId, mine);
      mine.forEach((v) => (v.dataset.id = newId));
    }
  }
  camBroadcast({ aura: myAura() });
  if (camStream) {
    for (const id of peers.keys()) camSendTo(id);
    camBroadcast({ camOn: true });
  }
}

// Itens extras na lista de participantes.
function decoratePeer(li, p) {
  const aura = p.id ? p.aura || 0 : myAura();
  const a = document.createElement('span');
  a.className = 'aura-pill' + (aura < 0 ? ' neg' : '');
  a.textContent = '✨ ' + fmtAura(aura);
  a.title = 'Aura farmada nos duelos';
  li.querySelector('.n').after(a);
  const camOn = p.id ? camPeers.get(p.id)?.on : !!camStream;
  if (camOn) a.after(Object.assign(document.createElement('span'), { className: 'cam-ico', textContent: '📷', title: 'Câmera ligada' }));
  if (p.id && !p.away) {
    const b = document.createElement('button');
    b.className = 'watch duel-btn';
    b.textContent = '⚔️';
    b.title = `Desafiar ${p.name} para um duelo de aura`;
    b.disabled = !!duel;
    b.addEventListener('click', () => duelChallenge(p.id));
    li.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Aura
// ---------------------------------------------------------------------------
const myAura = () => {
  try { return Number(localStorage.getItem('telinhaAura')) || 0; } catch { return 0; }
};
function addAura(delta) {
  const v = myAura() + delta;
  try { localStorage.setItem('telinhaAura', String(v)); } catch {}
  camBroadcast({ aura: v });
  renderPeers();
}
const fmtAura = (n) => {
  const s = n < 0 ? '-' : '';
  n = Math.abs(n);
  return s + (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1).replace('.0', '') + 'k' : String(n));
};

// ---------------------------------------------------------------------------
// Duelo de Aura (quem julga é o sistema: aura.js analisa a câmera)
// ---------------------------------------------------------------------------
const DUEL_PROMPTS = [
  { text: 'Olhar de protagonista de anime na chuva 🌧️', kind: 'protagonist' },
  { text: 'Olhar penetrante: encare como se lesse a alma 👁️', kind: 'protagonist' },
  { text: 'Cara de quem ganhou a luta e nem suou 😮‍💨', kind: 'calm' },
  { text: 'Cara de quem levou o gol e continua tranquilo 🧘', kind: 'calm' },
  { text: 'Pose de vilão revelando o plano final 😈', kind: 'villain' },
  { text: 'Encarar a câmera sem rir nem piscar 😐', kind: 'stare' },
  { text: 'Desafio do sigma: zero expressão por 15 segundos 🗿', kind: 'sigma' },
  { text: 'Sorriso de quem sabe de algo que você não sabe 😏', kind: 'smirk' },
  { text: 'Cara de "eu avisei" 🗿', kind: 'smirk' },
  { text: 'Respirar fundo e liberar o poder máximo 🔥', kind: 'power' },
  { text: 'Olhar pela janela pensando na vida 🌆', kind: 'away' },
  { text: 'Ajeitar o cabelo em câmera lenta 💇', kind: 'slow' },
  { text: 'Tirar o óculos (ou fingir) bem devagar 🕶️', kind: 'slow' },
  { text: 'Sorriso de vitória com a música mais épica na cabeça 🏆', kind: 'victory' },
];
const DUEL_TIMES = { ready: 4000, farm: 15000, judge: 1500, result: 8000 };
const DUEL_READY_MAX = 25000; // espera o juiz carregar nos dois PCs até isso
const DUEL_WIN = 500; // bônus de quem ganha (e o que o perdedor perde)

// Estado visto por todos (quem desafiou manda as atualizações).
let duel = null; // { id, host, a, b, phase, prompt, kind, endsAt, taps, sys, result, mine }
// Só em quem desafiou (organiza o duelo):
let duelHost = null; // { id, a, b, phase, timer, taps, sys: {a, b}, ready: {a, b}, ... }
let duelInvite = null; // convite que recebi: { id, from }
let duelJudge = null; // a análise da MINHA câmera, se estou duelando

function duelChallenge(id) {
  const p = peers.get(id);
  if (!p) return;
  if (duel || duelHost) return toast('Já tem um duelo rolando.');
  const did = Math.random().toString(36).slice(2, 10);
  duelHost = { id: did, a: myId, b: id, phase: 'invite', taps: { a: 0, b: 0 }, sys: { a: null, b: null }, ready: { a: false, b: false } };
  duelHost.timer = setTimeout(() => {
    if (duelHost?.id !== did || duelHost.phase !== 'invite') return;
    duelHost = null;
    toast(`${p.name} não respondeu ao desafio.`);
  }, 30000);
  send({ type: 'signal', to: id, data: { duel: { t: 'invite', id: did } } });
  toast(`Desafio mandado para ${p.name}. Esperando aceitar...`);
  if (!camStream) startCam();
  loadFaceLm().catch(() => {});
}

function onDuel(from, d) {
  switch (d.t) {
    case 'invite': {
      if (duel || duelHost || duelInvite) {
        send({ type: 'signal', to: from, data: { duel: { t: 'decline', id: d.id, busy: true } } });
        return;
      }
      duelInvite = { id: d.id, from };
      const name = peers.get(from)?.name || 'Alguém';
      $('duelInviteText').textContent = `${name} te desafiou para um ⚔️ Duelo de Aura!`;
      $('duelInvite').hidden = false;
      clearTimeout(duelInvite.timer);
      duelInvite.timer = setTimeout(() => answerInvite(false), 25000);
      sys(`${name} te desafiou para um duelo de aura.`);
      loadFaceLm().catch(() => {});
      return;
    }
    case 'accept':
    case 'decline': {
      if (!duelHost || duelHost.id !== d.id || from !== duelHost.b) return;
      clearTimeout(duelHost.timer);
      if (d.t === 'decline') {
        duelHost = null;
        toast(`${peers.get(from)?.name || 'Ele'} ${d.busy ? 'está ocupado' : 'recusou o duelo'}. Medo de perder aura? 🐔`);
        return;
      }
      hostStart();
      return;
    }
    case 'state':
      if (duelHost) return; // eu organizo: já sei
      if (d.id === duelDismissed) return; // fechei a janela desse duelo
      if (duel && duel.id !== d.id && duel.host !== from) return;
      applyDuelState({ ...d, host: from });
      return;
    case 'tap':
      if (duelHost && duelHost.id === d.id && duelHost.phase === 'farm') hostTap(from, d.side);
      return;
    case 'ready':
    case 'aura':
      if (duelHost && duelHost.id === d.id) hostReport(from, d);
      return;
    case 'cancel':
      if (duel && duel.id === d.id) duelCancel(d.reason || 'Duelo cancelado.');
      return;
  }
}

function answerInvite(yes) {
  if (!duelInvite) return;
  clearTimeout(duelInvite.timer);
  $('duelInvite').hidden = true;
  send({ type: 'signal', to: duelInvite.from, data: { duel: { t: yes ? 'accept' : 'decline', id: duelInvite.id } } });
  duelInvite = null;
  if (yes && !camStream) startCam();
}
$('duelAccept').addEventListener('click', () => answerInvite(true));
$('duelDecline').addEventListener('click', () => answerInvite(false));

// ---- Quem desafiou: organiza; a nota vem da análise de cada câmera ----
function hostStart() {
  const h = duelHost;
  const p = DUEL_PROMPTS[Math.floor(Math.random() * DUEL_PROMPTS.length)];
  h.prompt = p.text;
  h.kind = p.kind;
  h.readySince = Date.now();
  hostPhase('ready');
}

function hostPhase(phase) {
  const h = duelHost;
  if (!h) return;
  h.phase = phase;
  h.endsAt = Date.now() + (DUEL_TIMES[phase] || 0);
  clearTimeout(h.timer);
  if (phase === 'result') h.result = hostResult();
  hostBroadcast();
  const next = { ready: 'farm', farm: 'judge', judge: 'result', result: null }[phase];
  const go = () => {
    if (duelHost !== h) return;
    // Só começa quando o juiz carregou nos dois PCs (ou cansou de esperar).
    if (phase === 'ready' && !(h.ready.a && h.ready.b) && Date.now() - h.readySince < DUEL_READY_MAX) {
      h.waiting = true;
      hostBroadcastSoon();
      h.timer = setTimeout(go, 300);
      return;
    }
    h.waiting = false;
    if (next) hostPhase(next);
    else hostEnd();
  };
  h.timer = setTimeout(go, DUEL_TIMES[phase]);
}

function hostTap(from, side) {
  const h = duelHost;
  if (side !== 'a' && side !== 'b') return;
  if (h[side] === from) return;
  const now = Date.now();
  h.lastTap ??= new Map();
  const k = from + side;
  if (now - (h.lastTap.get(k) || 0) < 150) return;
  h.lastTap.set(k, now);
  h.taps[side]++;
  hostBroadcastSoon();
}

// Um duelista mandou como está a análise da câmera dele.
function hostReport(from, d) {
  const h = duelHost;
  const side = h.a === from ? 'a' : h.b === from ? 'b' : null;
  if (!side) return;
  if (d.t === 'ready') {
    h.ready[side] = true;
    if (d.fail) h.sys[side] = { score: 0, live: 0, tag: d.fail, fail: true };
    return hostBroadcastSoon();
  }
  if (h.phase !== 'farm' && h.phase !== 'judge') return;
  if (h.sys[side]?.final) return;
  h.sys[side] = {
    score: Math.max(-5000, Math.min(2000, Math.round(d.score) || 0)),
    live: clamp(d.live || 0),
    tag: String(d.tag || '').slice(0, 40),
    final: !!d.final,
    seen: d.seen,
    laughs: d.laughs,
    blinks: d.blinks,
  };
  hostBroadcastSoon();
}

function hostResult() {
  const h = duelHost;
  const score = (s) => h.sys[s]?.score || 0;
  const sa = score('a');
  const sb = score('b');
  const winner = sa === sb ? null : sa > sb ? 'a' : 'b';
  const delta = {
    a: sa + (winner === 'a' ? DUEL_WIN : winner ? -DUEL_WIN : 100),
    b: sb + (winner === 'b' ? DUEL_WIN : winner ? -DUEL_WIN : 100),
  };
  return { winner, delta, score: { a: sa, b: sb } };
}

let hostSoonTimer = null;
function hostBroadcastSoon() {
  if (hostSoonTimer) return;
  hostSoonTimer = setTimeout(() => {
    hostSoonTimer = null;
    hostBroadcast();
  }, 250);
}

function hostBroadcast() {
  const h = duelHost;
  if (!h) return;
  const state = {
    t: 'state', id: h.id, a: h.a, b: h.b, phase: h.phase, prompt: h.prompt, kind: h.kind,
    left: Math.max(0, h.endsAt - Date.now()), waiting: !!h.waiting, taps: h.taps, sys: h.sys, result: h.result || null,
  };
  camBroadcast({ duel: state });
  applyDuelState({ ...state, host: myId });
}

function hostEnd() {
  const h = duelHost;
  duelHost = null;
  if (h) camBroadcast({ duel: { t: 'cancel', id: h.id, reason: '' } });
  closeDuel();
}

// ---- Duelista: liga a análise da própria câmera ----
function duelReport(d) {
  if (!duel) return;
  d.id = duel.id;
  if (duelHost) hostReport(myId, d);
  else send({ type: 'signal', to: duel.host, data: { duel: d } });
}

async function judgePrepare() {
  try {
    await loadFaceLm();
    if (!camStream && !(await startCam())) throw new Error('sem câmera');
    duelReport({ t: 'ready' });
  } catch (err) {
    console.warn('juiz da aura', err);
    duelReport({ t: 'ready', fail: camStream ? 'juiz não carregou 😵' : 'sem câmera 📷❌' });
  }
}

function judgeStart() {
  if (duelJudge || !camStream || !faceLm) return;
  let lastSent = 0;
  duelJudge = startAuraJudge(camStream, duel.kind, DUEL_TIMES.farm, (u) => {
    if (!duel) return;
    duel.mine = u;
    const now = Date.now();
    if (now - lastSent > 400) {
      lastSent = now;
      duelReport({ t: 'aura', ...u });
    }
  });
}

function judgeStop(report = true) {
  if (!duelJudge) return;
  const fin = duelJudge.stop();
  duelJudge = null;
  if (report) duelReport({ t: 'aura', score: fin.score, live: 0, tag: 'nota final', final: true, seen: fin.seen, laughs: fin.laughs, blinks: fin.blinks });
}

// ---- Todo mundo: mostrar o duelo ----
function applyDuelState(s) {
  const first = !duel || duel.id !== s.id;
  const prevPhase = duel?.phase;
  const prevTaps = duel?.taps || { a: 0, b: 0 };
  duel = { ...(first ? {} : duel), ...s, endsAt: Date.now() + s.left };
  if (first) openDuel();
  for (const side of ['a', 'b']) {
    const n = Math.min(8, (s.taps?.[side] || 0) - (prevTaps[side] || 0));
    for (let i = 0; i < n; i++) setTimeout(() => duelFx(side), i * 60);
  }
  if (prevPhase !== s.phase) onDuelPhase(s.phase);
  renderDuel();
}

function openDuel() {
  const box = $('duel');
  box.hidden = false;
  for (const side of ['a', 'b']) {
    const slot = box.querySelector(`.duel-cam[data-side="${side}"]`);
    slot.querySelector('.camview')?.remove();
    slot.prepend(makeCamView(duel[side], 'big'));
  }
  renderPeers();
  clearInterval(duel.ticker);
  duel.ticker = setInterval(renderDuel, 200);
}

const iDuel = () => !!duel && (duel.a === myId || duel.b === myId);

function onDuelPhase(phase) {
  if (phase === 'ready' && iDuel()) judgePrepare();
  if (phase === 'farm') {
    duelSound(660);
    if (iDuel()) judgeStart();
  }
  if (phase === 'judge' && iDuel()) judgeStop();
  if (phase === 'result' && duel.result) {
    judgeStop(false);
    const r = duel.result;
    const name = (side) => (duel[side] === myId ? 'Você' : peers.get(duel[side])?.name || '???');
    if (r.winner) sys(`⚔️ Duelo de aura (${duel.prompt}): o sistema deu a vitória para ${name(r.winner)}! ${fmtAura(r.score.a)} x ${fmtAura(r.score.b)}`);
    else sys(`⚔️ Duelo de aura: empate (${fmtAura(r.score.a)} x ${fmtAura(r.score.b)})!`);
    for (const side of ['a', 'b']) {
      if (duel[side] !== myId || duel.counted) continue;
      duel.counted = true;
      addAura(r.delta[side]);
    }
    duelSound(r.winner ? 880 : 520, 0.4);
  }
}

function renderDuel() {
  if (!duel) return;
  const box = $('duel');
  const left = Math.max(0, Math.ceil((duel.endsAt - Date.now()) / 1000));
  const nameOf = (side) => (duel[side] === myId ? 'Você' : peers.get(duel[side])?.name || '???');
  const titles = {
    ready: duel.waiting ? 'Carregando o juiz... 🤖' : `Prepara... ${left}`,
    farm: `FARMANDO AURA · ${left}s`,
    judge: 'O sistema está julgando... 🤖',
    result: duel.result?.winner ? `${nameOf(duel.result.winner)} venceu!` : 'Empate!',
  };
  box.querySelector('.duel-phase').textContent = titles[duel.phase] || '';
  box.querySelector('.duel-prompt').textContent = duel.prompt || '';
  box.classList.toggle('farming', duel.phase === 'farm');
  const what = AURA_KINDS[duel.kind]?.what;
  for (const side of ['a', 'b']) {
    const slot = box.querySelector(`.duel-cam[data-side="${side}"]`);
    const me = duel[side] === myId;
    // A minha nota eu vejo na hora; a do outro chega por quem organiza.
    const sysv = (me && duel.mine && duel.phase === 'farm' ? duel.mine : null) || duel.sys?.[side] || null;
    slot.querySelector('.duel-name').textContent = nameOf(side);
    slot.querySelector('.duel-score').textContent = '✨ ' + fmtAura(sysv?.score || 0);
    slot.querySelector('.duel-meter i').style.width = Math.round((duel.phase === 'farm' ? sysv?.live || 0 : 0) * 100) + '%';
    slot.querySelector('.duel-tag').textContent = duel.phase === 'farm' || sysv?.fail ? sysv?.tag || 'analisando...' : '';
    const btn = slot.querySelector('.duel-act');
    btn.hidden = me || duel.phase !== 'farm';
    btn.textContent = '🔥 hype';
    slot.classList.toggle('winner', duel.phase === 'result' && duel.result?.winner === side);
    slot.classList.toggle('loser', duel.phase === 'result' && !!duel.result?.winner && duel.result.winner !== side);
    const res = slot.querySelector('.duel-delta');
    if (duel.phase === 'result' && duel.result) {
      const d = duel.result.delta[side];
      const s = duel.sys?.[side];
      const extra = s
        ? [s.fail ? s.tag : '', s.laughs ? `riu ${s.laughs}x` : '', s.blinks ? `piscou ${s.blinks}x` : '', s.seen !== undefined && s.seen < 0.5 ? 'quase não apareceu' : '']
            .filter(Boolean)
            .join(' · ')
        : 'sem análise';
      res.textContent = (d >= 0 ? '+' : '') + fmtAura(d) + ' de aura' + (extra ? ` (${extra})` : '');
      res.classList.toggle('neg', d < 0);
      res.hidden = false;
    } else res.hidden = true;
  }
  box.querySelector('.duel-hint').textContent =
    duel.phase === 'ready' || duel.phase === 'farm'
      ? `🤖 O sistema vai medir: ${what || 'sua aura'}.` + (iDuel() ? '' : ' Mande 🔥 para dar hype (não muda a nota).')
      : duel.phase === 'result'
        ? 'Nota dada pelo sistema, analisando o rosto na câmera de cada um.'
        : '';
}

for (const side of ['a', 'b']) {
  document.querySelector(`#duel .duel-cam[data-side="${side}"] .duel-act`).addEventListener('click', () => {
    if (!duel || duel.phase !== 'farm') return;
    if (duelHost) hostTap(myId, side);
    else {
      send({ type: 'signal', to: duel.host, data: { duel: { t: 'tap', id: duel.id, side } } });
      duelFx(side);
    }
  });
}

function duelFx(side) {
  const slot = document.querySelector(`#duel .duel-cam[data-side="${side}"]`);
  if (!slot) return;
  const f = document.createElement('span');
  f.className = 'duel-fx';
  f.textContent = ['🔥', '✨', '🗿', '💯', '⚡'][Math.floor(Math.random() * 5)];
  f.style.left = 10 + Math.random() * 80 + '%';
  slot.append(f);
  setTimeout(() => f.remove(), 1400);
}

let duelAc = null;
function duelSound(freq, len = 0.18) {
  try {
    duelAc ??= new AudioContext();
    const o = duelAc.createOscillator();
    const g = duelAc.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.08, duelAc.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, duelAc.currentTime + len);
    o.connect(g).connect(duelAc.destination);
    o.start();
    o.stop(duelAc.currentTime + len);
  } catch {}
}

function duelCancel(reason) {
  if (duelHost) {
    clearTimeout(duelHost.timer);
    camBroadcast({ duel: { t: 'cancel', id: duelHost.id, reason } });
    duelHost = null;
  }
  if (reason) toast(reason);
  closeDuel();
}

function closeDuel() {
  judgeStop(false);
  if (duel) clearInterval(duel.ticker);
  duel = null;
  const box = $('duel');
  box.hidden = true;
  box.querySelectorAll('.camview').forEach(dropCamView);
  box.querySelectorAll('.duel-fx').forEach((f) => f.remove());
  renderPeers();
}

let duelDismissed = null;
$('duelClose').addEventListener('click', () => {
  if (duelHost) return duelCancel('Duelo cancelado.');
  // Quem só assiste (ou o desafiado) pode fechar a janela; o duelo continua para os outros.
  duelDismissed = duel?.id;
  closeDuel();
});

// ---------------------------------------------------------------------------
// 🎺 "Diga que valeu" (Bell Marques): toca para todo mundo da call.
// Toca pelo player do YouTube (vídeo oficial), não precisa guardar a música.
// ---------------------------------------------------------------------------
const BELL_VIDEO = 'Z6yKTRQcfYE'; // Bell Marques - Diga Que Valeu (Ao Vivo), BellMarquesVEVO
let bellLast = 0;

$('bellBtn').addEventListener('click', () => {
  if (Date.now() - bellLast < 10000) return toast('Calma, a música acabou de tocar 😅');
  camBroadcast({ bell: true });
  playBell(null);
});

function playBell(from) {
  bellLast = Date.now();
  sys(`🎺 ${from || 'Você'} tocou "Diga que valeu"! VALEU!`);
  const box = $('bell');
  box.querySelector('iframe')?.remove();
  const f = document.createElement('iframe');
  f.src = `https://www.youtube.com/embed/${BELL_VIDEO}?autoplay=1&playsinline=1&rel=0`;
  f.allow = 'autoplay; encrypted-media; picture-in-picture';
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  f.title = 'Diga que valeu';
  box.querySelector('.bell-who').textContent = from ? `${from} tocou para a call` : 'Tocando para a call';
  box.append(f);
  box.hidden = false;
}
$('bellClose').addEventListener('click', () => {
  $('bell').querySelector('iframe')?.remove();
  $('bell').hidden = true;
});
