// App do Telinha para Windows (quem transmite). Abre o próprio site, mas:
// - tem um seletor de tela/janela próprio;
// - captura o som por programa (telinha-audio.exe), deixando o Discord de fora;
// - não fica lento quando a janela está atrás do jogo.
const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const SITE = process.env.TELINHA_URL || 'https://telinha.discontaoofc.workers.dev';
const SITE_ORIGIN = new URL(SITE).origin;

// Sem "economia" do Chromium com janela escondida/atrás do jogo.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let win = null;
let picked = null; // { id, name, kind: 'screen'|'window', hwnd }
let helper = null;

const helperPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'telinha-audio.exe')
    : path.join(__dirname, 'bin', 'telinha-audio.exe');

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    title: 'Telinha',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.loadURL(SITE);
  // Links externos abrem no navegador; navegação fica só no site do Telinha.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== SITE_ORIGIN) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on('closed', () => {
    win = null;
    stopHelper();
  });
}

// Só o site do Telinha pode compartilhar a tela; o resto é negado.
function fromSite(details) {
  try {
    return new URL(details.requestingUrl || details.securityOrigin || '').origin === SITE_ORIGIN;
  } catch {
    return false;
  }
}

// ---- Seletor de tela/janela ----
async function pickSource() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  const list = sources
    .filter((s) => s.name !== 'Telinha' || s.id.startsWith('screen'))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumb: s.thumbnail.toDataURL(),
      icon: s.appIcon ? s.appIcon.toDataURL() : null,
    }));
  // Para testes automáticos: TELINHA_AUTOPICK=screen|window escolhe o primeiro.
  const auto = process.env.TELINHA_AUTOPICK && list.find((s) => s.kind === process.env.TELINHA_AUTOPICK);
  if (auto) return { source: sources.find((s) => s.id === auto.id), info: auto };
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win,
      modal: true,
      width: 860,
      height: 620,
      backgroundColor: '#0f1115',
      autoHideMenuBar: true,
      title: 'Escolha o que compartilhar',
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true },
    });
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler('picker-sources');
      ipcMain.removeAllListeners('picker-choose');
      if (!picker.isDestroyed()) picker.close();
      resolve(id ? { source: sources.find((s) => s.id === id), info: list.find((s) => s.id === id) } : null);
    };
    ipcMain.handle('picker-sources', () => list);
    ipcMain.on('picker-choose', (_e, id) => finish(id));
    picker.on('closed', () => finish(null));
    picker.loadFile(path.join(__dirname, 'picker.html'));
  });
}

// ---- Áudio por programa ----
function stopHelper() {
  if (!helper) return;
  console.log('[telinha-audio] parando');
  helper.removeAllListeners();
  helper.stdout.removeAllListeners();
  try {
    helper.stdin.end();
    helper.kill();
  } catch {}
  helper = null;
}

function startHelper(mode) {
  stopHelper();
  if (!fs.existsSync(helperPath())) return { ok: false, error: 'telinha-audio.exe não encontrado' };
  let args = ['--exclude-discord'];
  if (mode === 'all') args = ['--system'];
  if (mode === 'app' && picked?.kind === 'window' && picked.hwnd) args = ['--include-hwnd', String(picked.hwnd)];
  const proc = spawn(helperPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  helper = proc;
  console.log('[telinha-audio] iniciando', args.join(' '));
  let rest = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    // Só quadros inteiros (2 canais x float32 = 8 bytes).
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const whole = buf.length - (buf.length % 8);
    rest = buf.subarray(whole);
    if (whole && win && !win.isDestroyed()) win.webContents.send('audio-data', buf.subarray(0, whole));
  });
  proc.stderr.on('data', (d) => console.log('[telinha-audio]', String(d).trim()));
  proc.on('exit', (code, signal) => {
    console.log('[telinha-audio] exit', code, signal);
    if (helper !== proc) return;
    helper = null;
    console.log('[telinha-audio] saiu', code);
    if (win && !win.isDestroyed()) win.webContents.send('audio-stopped', code);
  });
  proc.on('error', (err) => {
    console.log('[telinha-audio] erro', err.message);
    if (helper === proc) helper = null;
  });
  return { ok: true, args };
}

ipcMain.handle('audio-start', (e, mode) => {
  if (new URL(e.senderFrame.url).origin !== SITE_ORIGIN) return { ok: false };
  try {
    return startHelper(mode);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('audio-stop', () => stopHelper());

// ---- Assistente de IPv6 (só o que dá para fazer no Windows) ----
const os = require('os');
const { execFile } = require('child_process');
const fromSiteFrame = (e) => new URL(e.senderFrame.url).origin === SITE_ORIGIN;

function powershell(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 }, (err, out) =>
      resolve(err ? null : String(out).trim()),
    );
  });
}

ipcMain.handle('ipv6-status', async (e) => {
  if (!fromSiteFrame(e)) return null;
  // Endereços IPv6 "de internet" (2000::/3) nas placas de rede.
  const global = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv6' && !a.internal && /^[23]/.test(a.address) && !/^2001:0?:|^2002:/i.test(a.address)) global.push(name); // sem Teredo/6to4 (túneis velhos)
  }
  const raw = await powershell(`
    $up = Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty Name
    $off = Get-NetAdapterBinding -ComponentID ms_tcpip6 | Where-Object { -not $_.Enabled -and $up -contains $_.Name } | Select-Object -ExpandProperty Name
    $dc = (Get-ItemProperty 'HKLM:/SYSTEM/CurrentControlSet/Services/Tcpip6/Parameters' -Name DisabledComponents -ErrorAction SilentlyContinue).DisabledComponents
    $gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop
    @{ off = @($off); dc = $dc; gw = $gw } | ConvertTo-Json -Compress`);
  let info = {};
  try {
    info = JSON.parse(raw || '{}');
  } catch {}
  return {
    globalOn: [...new Set(global)],
    bindingOff: (info.off || []).filter(Boolean),
    // DisabledComponents: 0xFF/0x01... desligam o IPv6; 0x20 = prefere IPv4 (não atrapalha).
    registryOff: typeof info.dc === 'number' && (info.dc & 0x11) !== 0,
    gateway: typeof info.gw === 'string' && /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+(\.\d+)?$/.test(info.gw) ? info.gw : null,
  };
});

// Liga o IPv6 em todas as placas e tira o bloqueio do registro (pede administrador).
ipcMain.handle('ipv6-enable', async (e) => {
  if (!fromSiteFrame(e)) return { ok: false };
  const inner = [
    "Enable-NetAdapterBinding -Name '*' -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue",
    "$k = 'HKLM:/SYSTEM/CurrentControlSet/Services/Tcpip6/Parameters'",
    '$v = (Get-ItemProperty $k -Name DisabledComponents -ErrorAction SilentlyContinue).DisabledComponents',
    'if ($v -ne $null -and ($v -band 0x11)) { Set-ItemProperty $k -Name DisabledComponents -Value ($v -band 0x20) -Type DWord }',
  ].join('\n');
  // Vai codificado (base64 UTF-16) para não ter problema com aspas.
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const out = await powershell(
    `try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; 'ok:' + $p.ExitCode } catch { 'cancelado' }`,
  );
  return { ok: !!out && out.startsWith('ok'), out };
});

ipcMain.handle('open-router', (e, ip) => {
  if (!fromSiteFrame(e)) return;
  if (/^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+(\.\d+)?$/.test(String(ip))) shell.openExternal('http://' + ip + '/');
});
ipcMain.handle('app-info', () => ({ version: app.getVersion(), picked: picked && { kind: picked.kind, name: picked.name } }));

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(fromSite(details) && ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!fromSite(request)) return callback({});
    const choice = await pickSource();
    if (!choice || !choice.source) return callback({});
    const hwnd = choice.info.kind === 'window' ? Number(choice.info.id.split(':')[1]) : null;
    picked = { ...choice.info, hwnd };
    // O som não vem daqui: o site pede pelo telinha-audio (por programa).
    callback({ video: choice.source });
  });
  // Downloads (ex.: "Atualizar app") vão direto para a pasta Downloads e,
  // ao terminar, a pasta abre com o arquivo selecionado.
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
    item.once('done', (_ev, state) => state === 'completed' && shell.showItemInFolder(item.getSavePath()));
  });
  createWindow();
});

app.on('window-all-closed', () => {
  stopHelper();
  app.quit();
});
