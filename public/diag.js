'use strict';
// 📋 Logs: histórico de eventos + diagnóstico de rede (por que a conexão
// direta funciona com uns e não com outros). Usa variáveis do app.js
// (peers, myName, iceServers...) só na hora em que roda.

const eventLog = []; // { t, text }

function logEvent(text) {
  eventLog.push({ t: new Date(), text });
  if (eventLog.length > 500) eventLog.shift();
  const box = document.getElementById('logEvents');
  if (box && !document.getElementById('logs').hidden) renderLogEvents();
}

window.addEventListener('error', (e) => logEvent(`Erro: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => logEvent(`Erro: ${e.reason?.message || e.reason}`));

// ---------------------------------------------------------------------------
// Teste de rede: pergunta o endereço público a 2 servidores STUN diferentes
// pela MESMA porta local. Se as portas públicas vierem diferentes, o roteador
// é "simétrico" (troca a porta para cada destino) -> conexão direta difícil.
// ---------------------------------------------------------------------------
const NAT_TEXT = {
  open: { label: 'Aberta (IP público)', ok: 'bom', why: 'Sem roteador no caminho: conexão direta funciona com quase todo mundo.' },
  cone: { label: 'NAT cone (normal)', ok: 'bom', why: 'O roteador mantém o mesmo endereço: conexão direta costuma funcionar.' },
  symmetric: {
    label: 'NAT simétrico',
    ok: 'ruim',
    why: 'O roteador troca o endereço para cada destino (comum em CGNAT de operadora, 4G/5G e redes de empresa/faculdade). Conexão direta só funciona se o outro lado tiver rede aberta ou cone.',
  },
  blocked: { label: 'UDP bloqueado', ok: 'ruim', why: 'Nenhum servidor STUN respondeu: firewall/antivírus/rede bloqueia UDP. Conexão direta não funciona; só o plano B.' },
  unknown: { label: 'Não deu para saber', ok: '?', why: 'Só um servidor respondeu; não dá para dizer o tipo.' },
};

async function runNetTest() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const pc = new RTCPeerConnection({ iceServers: servers, iceCandidatePoolSize: 0 });
  const cands = [];
  pc.createDataChannel('teste');
  pc.onicecandidate = (e) => e.candidate && e.candidate.candidate && cands.push(e.candidate);
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => {
    const t = setTimeout(r, 4000);
    pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && (clearTimeout(t), r());
  });
  pc.close();

  const parse = (c) => {
    const f = c.candidate.split(' ');
    const get = (k) => f[f.indexOf(k) + 1];
    return { type: get('typ'), proto: f[2]?.toLowerCase(), ip: f[4], port: Number(f[5]), raddr: f.includes('raddr') ? get('raddr') : null, rport: f.includes('rport') ? Number(get('rport')) : null };
  };
  const all = cands.map(parse).filter((c) => c.proto === 'udp');
  const srflx = all.filter((c) => c.type === 'srflx');
  const v4 = srflx.filter((c) => !c.ip.includes(':'));
  const v6 = srflx.filter((c) => c.ip.includes(':'));
  const host = all.filter((c) => c.type === 'host');

  let nat = 'unknown';
  if (!srflx.length) nat = 'blocked';
  else {
    // Mesma porta local, portas públicas diferentes = simétrico.
    // (O Chrome às vezes esconde a porta local: aí compara quantos endereços
    // públicos diferentes apareceram com quantas portas locais existem.)
    const fam = v4.length ? v4 : v6;
    const mapped = new Set(fam.map((c) => `${c.ip}:${c.port}`));
    const byLocal = new Map();
    for (const c of fam) {
      if (!c.rport) continue;
      const k = `${c.raddr}:${c.rport}`;
      if (!byLocal.has(k)) byLocal.set(k, new Set());
      byLocal.get(k).add(`${c.ip}:${c.port}`);
    }
    const symmetric = byLocal.size ? [...byLocal.values()].some((s) => s.size > 1) : mapped.size > Math.max(1, host.length);
    if (symmetric) nat = 'symmetric';
    else if (host.some((h) => srflx.some((s) => s.ip === h.ip))) nat = 'open';
    else nat = 'cone';
  }
  const pub = v4[0]?.ip || v6[0]?.ip || null;
  return {
    nat,
    ipv6: v6.length > 0,
    cgnat: !!pub && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(pub), // 100.64.0.0/10
    srflx: srflx.length,
    at: Date.now(),
  };
}

let myNet = null;
async function refreshMyNet() {
  try {
    myNet = await runNetTest();
    logEvent(`Sua rede: ${NAT_TEXT[myNet.nat].label}${myNet.ipv6 ? ' · tem IPv6' : ''}${myNet.cgnat ? ' · CGNAT' : ''}`);
  } catch (err) {
    logEvent('Teste de rede falhou: ' + err.message);
  }
  return myNet;
}

// Palpite do motivo para uma conexão direta com alguém.
function guessDirect(mine, theirs) {
  if (!mine || !theirs) return 'Esperando o teste de rede dos dois lados...';
  if (mine.nat === 'blocked' || theirs.nat === 'blocked') return 'Um dos lados bloqueia UDP: direta impossível, vai pelo plano B.';
  const sym = [mine.nat, theirs.nat].filter((n) => n === 'symmetric').length;
  if (sym === 2) return 'Os dois têm NAT simétrico: direta praticamente impossível sem TURN (pago). Plano B.';
  if (sym === 1) {
    const other = mine.nat === 'symmetric' ? theirs.nat : mine.nat;
    if (other === 'open') return 'Um lado é simétrico, mas o outro é aberto: direta deve funcionar.';
    if (mine.ipv6 && theirs.ipv6) return 'Um lado é simétrico, mas os dois têm IPv6: a direta pode funcionar pelo IPv6.';
    const symName = mine.nat === 'symmetric' ? 'você' : 'ele';
    const noV6 = [!mine.ipv6 && 'você', !theirs.ipv6 && 'ele'].filter(Boolean).join(' e ');
    return `NAT simétrico (${symName}): a direta costuma falhar. Solução grátis: ativar IPv6 no roteador/operadora (${noV6 || 'quem não tem'} não tem IPv6) ou pedir IP público à operadora.`;
  }
  return 'Redes compatíveis: a direta deve funcionar. Se falhar, pode ser firewall/antivírus.';
}

// Detalhes da conexão direta com cada pessoa (getStats).
async function pairInfo(p) {
  const out = { state: p.pc?.connectionState || '-', ice: p.pc?.iceConnectionState || '-', route: null };
  if (!p.pc) return out;
  try {
    const stats = await p.pc.getStats();
    let pair = null;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && (pair = s));
    if (pair) {
      const l = stats.get(pair.localCandidateId);
      const r = stats.get(pair.remoteCandidateId);
      const name = { host: 'rede local', srflx: 'internet (STUN)', prflx: 'internet', relay: 'TURN' };
      out.route = `${name[l?.candidateType] || l?.candidateType} ↔ ${name[r?.candidateType] || r?.candidateType} (${l?.protocol || '?'}${l?.address?.includes(':') ? ', IPv6' : ''}) · ${pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) + ' ms' : ''}`;
    }
  } catch {}
  return out;
}

// ---------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------
const fmtTime = (d) => d.toLocaleTimeString('pt-BR', { hour12: false });

function renderLogEvents() {
  const box = document.getElementById('logEvents');
  box.textContent = eventLog.map((e) => `${fmtTime(e.t)}  ${e.text}`).join('\n');
  box.scrollTop = box.scrollHeight;
}

async function renderLogs() {
  const me = myNet ? NAT_TEXT[myNet.nat] : null;
  document.getElementById('logMyNet').innerHTML = '';
  const mine = document.createElement('div');
  mine.className = 'net ' + (me?.ok === 'bom' ? 'good' : me?.ok === 'ruim' ? 'bad' : '');
  mine.innerHTML = '<b></b><span></span>';
  mine.querySelector('b').textContent = me ? `Sua rede: ${me.label}${myNet.ipv6 ? ' · IPv6 ✓' : ''}${myNet.cgnat ? ' · CGNAT' : ''}` : 'Testando sua rede...';
  mine.querySelector('span').textContent = me ? ' ' + me.why : '';
  document.getElementById('logMyNet').appendChild(mine);

  const list = document.getElementById('logPeers');
  list.innerHTML = '';
  for (const [id, p] of peers) {
    const info = await pairInfo(p);
    const theirs = p.netInfo ? NAT_TEXT[p.netInfo.nat] : null;
    const relay = relayIn.get(id);
    const row = document.createElement('div');
    row.className = 'peer-diag';
    const lines = [
      `${p.name}${p.sharing ? ' (transmitindo)' : ''}`,
      `Rede dele: ${theirs ? theirs.label + (p.netInfo.ipv6 ? ' · IPv6 ✓' : '') + (p.netInfo.cgnat ? ' · CGNAT' : '') : 'sem informação (versão antiga?)'}`,
      `Conexão direta: ${info.state === 'connected' ? 'conectada ✓' : info.state}${info.route ? ' · ' + info.route : ''}`,
      relay ? `Vendo pelo plano B (${{ auto: 'a direta falhou', sender: 'ele ligou p/ todos', manual: 'escolhido na mão' }[relay.reason] || relay.reason})` : p.sharing ? 'Vendo pela conexão direta' : '',
      `Por quê: ${guessDirect(myNet, p.netInfo)}`,
    ].filter(Boolean);
    row.innerHTML = '<b></b>' + lines.slice(1).map(() => '<div></div>').join('');
    row.querySelector('b').textContent = lines[0];
    [...row.querySelectorAll('div')].forEach((d, i) => (d.textContent = lines[i + 1]));
    list.appendChild(row);
  }
  if (!peers.size) list.textContent = 'Ninguém mais na sessão.';
  renderLogEvents();
}

async function logsAsText() {
  const lines = [`Telinha v${APP_VERSION}${window.telinhaApp ? ' (app)' : ''} · ${navigator.userAgent}`];
  lines.push(`Eu: ${myName} · rede ${myNet ? NAT_TEXT[myNet.nat].label : '?'}${myNet?.ipv6 ? ' · IPv6' : ''}${myNet?.cgnat ? ' · CGNAT' : ''} · servidor ${ws?.readyState === 1 ? 'conectado' : 'desconectado'}`);
  for (const [id, p] of peers) {
    const info = await pairInfo(p);
    lines.push(`- ${p.name}: rede ${p.netInfo ? NAT_TEXT[p.netInfo.nat].label + (p.netInfo.ipv6 ? ' · IPv6' : ' · sem IPv6') + (p.netInfo.cgnat ? ' · CGNAT' : '') : '? (versão antiga)'} · direta ${info.state}/${info.ice}${info.route ? ' · ' + info.route : ''}${relayIn.has(id) ? ' · plano B (' + relayIn.get(id).reason + ')' : ''}`);
  }
  lines.push('', 'Eventos:');
  for (const e of eventLog) lines.push(`${fmtTime(e.t)}  ${e.text}`);
  return lines.join('\n');
}

let logsTimer = null;
function openLogs() {
  document.getElementById('logs').hidden = false;
  renderLogs();
  clearInterval(logsTimer);
  logsTimer = setInterval(renderLogs, 2000);
}

function closeLogs() {
  document.getElementById('logs').hidden = true;
  clearInterval(logsTimer);
}

document.getElementById('logsBtn').addEventListener('click', openLogs);
document.getElementById('logsClose').addEventListener('click', closeLogs);
document.getElementById('logsRetest').addEventListener('click', async () => {
  myNet = null;
  renderLogs();
  await refreshMyNet();
  shareMyNet();
  renderLogs();
});
document.getElementById('logsCopy').addEventListener('click', async () => {
  const text = await logsAsText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Logs copiados! Cole onde quiser (ex.: manda pro Claude).');
  } catch {
    toast('Não deu para copiar automaticamente.');
  }
});

// Conta para os outros como é minha rede (eles mostram no painel deles).
function shareMyNet(to) {
  if (!myNet) return;
  const data = { netInfo: { nat: myNet.nat, ipv6: myNet.ipv6, cgnat: myNet.cgnat } };
  if (to) send({ type: 'signal', to, data });
  else for (const id of peers.keys()) send({ type: 'signal', to: id, data });
}

// ---------------------------------------------------------------------------
// 🌐 Assistente de IPv6 (⚙ Configurações). Com IPv6 dos dois lados não existe
// NAT no caminho e a conexão direta funciona mesmo com "NAT simétrico".
// O que dá para mexer daqui: o Windows (só no app, pede administrador).
// Roteador/operadora: abre a página do roteador e explica o que fazer.
// ---------------------------------------------------------------------------
async function hasIpv6Internet() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch('https://api6.ipify.org?format=json', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return !!(await r.json()).ip;
  } catch {
    return false;
  }
}

function ipv6Step(state, title, text, actions = []) {
  const div = document.createElement('div');
  div.className = 'net ' + (state === 'ok' ? 'good' : state === 'bad' ? 'bad' : '');
  div.innerHTML = '<b></b><div class="hint"></div><div class="ipv6-actions"></div>';
  div.querySelector('b').textContent = (state === 'ok' ? '✓ ' : state === 'bad' ? '✗ ' : '• ') + title;
  div.querySelector('.hint').textContent = text;
  for (const [label, fn, primary] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', fn);
    div.querySelector('.ipv6-actions').appendChild(b);
  }
  return div;
}

async function runIpv6Wizard() {
  const box = document.getElementById('ipv6Steps');
  box.innerHTML = '<p class="hint">Testando...</p>';
  const app = window.telinhaApp && window.telinhaApp.ipv6Status ? window.telinhaApp : null;
  const [online, status] = await Promise.all([hasIpv6Internet(), app ? app.ipv6Status().catch(() => null) : null]);
  box.innerHTML = '';

  if (online) {
    box.appendChild(ipv6Step('ok', 'Você tem IPv6 funcionando!', 'Nada a fazer aqui. Se a conexão direta com alguém não pega, quem precisa ativar o IPv6 é a outra pessoa (mande este assistente para ela).'));
    refreshMyNet().then(() => shareMyNet());
    return;
  }
  box.appendChild(ipv6Step('bad', 'Sem IPv6 na internet', 'Seu PC não consegue acessar a internet por IPv6. Vamos ver onde está o problema:'));

  // 1) Windows
  if (status) {
    const winOff = status.bindingOff.length || status.registryOff;
    box.appendChild(
      winOff
        ? ipv6Step('bad', '1. Windows: IPv6 desligado', `Desligado em: ${status.bindingOff.join(', ') || 'configuração do sistema'}. O botão liga de novo (o Windows vai pedir permissão de administrador; às vezes precisa reiniciar o PC).`, [
            ['Ativar IPv6 no Windows', async () => {
              const r = await app.ipv6Enable();
              toast(r.ok ? 'IPv6 ativado no Windows. Testando de novo...' : 'Não foi ativado (permissão negada?).');
              if (r.ok) setTimeout(runIpv6Wizard, 3000);
            }, true],
          ])
        : ipv6Step('ok', '1. Windows: IPv6 ligado', 'O Windows está pronto. O problema está no roteador ou na operadora.'),
    );
  } else {
    box.appendChild(ipv6Step('', '1. Windows', 'No navegador não dá para conferir. Confira: Configurações de rede → Alterar opções do adaptador → Propriedades da sua conexão → "Protocolo IP Versão 6 (TCP/IPv6)" marcado. (No app do Telinha isso é automático.)'));
  }

  // 2) Roteador
  const gw = status?.gateway;
  const routerActions = gw
    ? [[`Abrir o roteador (${gw})`, () => app.openRouter(gw), true]]
    : [
        ['Abrir 192.168.0.1', () => window.open('http://192.168.0.1/', '_blank')],
        ['Abrir 192.168.1.1', () => window.open('http://192.168.1.1/', '_blank')],
      ];
  box.appendChild(
    ipv6Step(
      '',
      '2. Roteador: ligar o IPv6',
      'Entre na página do roteador (usuário e senha costumam estar na etiqueta embaixo dele). Procure "IPv6" (às vezes dentro de "WAN", "Rede" ou "Avançado"), ative, escolha "Dual Stack" ou "IPv4 e IPv6" com tipo automático (DHCPv6/SLAAC ou PPPoE), salve e reinicie o roteador.',
      routerActions,
    ),
  );
  // 3) Operadora
  box.appendChild(
    ipv6Step(
      '',
      '3. Operadora',
      'Se o roteador não tiver a opção ou continuar sem IPv6, ligue para a operadora e peça: "ativar IPv6 na minha linha". Vivo, Claro, TIM e a maioria das de fibra fazem de graça. Outra opção é pedir "IP público" (sair do CGNAT).',
    ),
  );
}

document.getElementById('ipv6Btn').addEventListener('click', () => {
  document.getElementById('ipv6').hidden = false;
  runIpv6Wizard();
});
document.getElementById('ipv6Close').addEventListener('click', () => (document.getElementById('ipv6').hidden = true));
document.getElementById('ipv6Retest').addEventListener('click', runIpv6Wizard);
