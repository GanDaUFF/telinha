// Ponte mínima entre o site do Telinha e o app (só existe dentro do app).
const { contextBridge, ipcRenderer } = require('electron');

let onAudio = null;
let onStopped = null;
ipcRenderer.on('audio-data', (_e, bytes) => onAudio && onAudio(bytes));
ipcRenderer.on('audio-stopped', (_e, code) => onStopped && onStopped(code));

contextBridge.exposeInMainWorld('telinhaApp', {
  // mode: 'nodiscord' (tudo menos o Discord) | 'app' (só a janela escolhida) | 'all'
  startAudio: (mode) => ipcRenderer.invoke('audio-start', mode),
  stopAudio: () => ipcRenderer.invoke('audio-stop'),
  info: () => ipcRenderer.invoke('app-info'),
  // Assistente de IPv6
  ipv6Status: () => ipcRenderer.invoke('ipv6-status'),
  ipv6Enable: () => ipcRenderer.invoke('ipv6-enable'),
  openRouter: (ip) => ipcRenderer.invoke('open-router', ip),
  // bytes: Uint8Array com PCM float32 intercalado, 48 kHz, 2 canais
  onAudio: (cb) => (onAudio = cb),
  onAudioStopped: (cb) => (onStopped = cb),
});
