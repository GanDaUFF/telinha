'use strict';
// Clipes e replay: guarda os últimos segundos da live de alguém, já comprimidos
// (H.264 na placa de vídeo quando tem), numa memória curta. "Clipe" salva um
// MP4; "Replay" abre um player para voltar alguns segundos sem largar a live.
// Usa a biblioteca mp4-muxer (vendor/mp4-muxer.min.js) para montar o MP4.

const CLIP_KEEP_MS = 65000; // quanto guardar (um pouco mais que o replay)
const CLIP_FPS = 30;
const CLIP_KEY_MS = 2000; // quadro-chave a cada 2 s (dá para começar o clipe dali)
const CLIP_PRESETS = {
  720: { height: 720, bitrate: 3_000_000, codecs: ['avc1.4d401f', 'avc1.42e01f', 'avc1.640028'] },
  1080: { height: 1080, bitrate: 6_000_000, codecs: ['avc1.640028', 'avc1.4d4028', 'avc1.42e028'] },
};
const clipsSupported = () =>
  'VideoEncoder' in window && 'MediaStreamTrackProcessor' in window && 'OffscreenCanvas' in window && 'Mp4Muxer' in window;

class ClipBuffer {
  constructor(preset) {
    this.preset = CLIP_PRESETS[preset] || CLIP_PRESETS[720];
    this.items = []; // { kind: 'v'|'a', data, key, ts (µs), dur }
    this.venc = null;
    this.vConfig = null; // decoderConfig (avcC) do vídeo
    this.size = '';
    this.width = 0;
    this.height = 0;
    this.lastFrameAt = 0;
    this.lastKeyAt = 0;
    this.starting = false;
    this.aenc = null;
    this.aConfig = null;
    this.aCodec = null;
    this.aFmt = '';
    this.aOffset = null;
    this.canvas = null;
    this.closed = false;
  }

  // Recebe um quadro da live (quem chama continua dono e fecha o quadro).
  addFrame(frame) {
    if (this.closed || this.starting) return;
    const now = performance.now();
    if (now - this.lastFrameAt < 1000 / CLIP_FPS - 3) return;
    if (this.venc && this.venc.encodeQueueSize > 3) return; // PC não acompanha: pula
    this.lastFrameAt = now;
    const scale = Math.min(1, this.preset.height / frame.displayHeight);
    const w = Math.max(2, Math.round((frame.displayWidth * scale) / 2) * 2);
    const h = Math.max(2, Math.round((frame.displayHeight * scale) / 2) * 2);
    if (!this.venc || this.venc.state === 'closed' || this.size !== `${w}x${h}`) {
      this.setupVideo(w, h); // assíncrono: os próximos quadros entram quando estiver pronto
      return;
    }
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = new OffscreenCanvas(w, h);
      this.ctx = this.canvas.getContext('2d');
    }
    this.ctx.drawImage(frame, 0, 0, w, h);
    const copy = new VideoFrame(this.canvas, { timestamp: Math.round(now * 1000) });
    const key = now - this.lastKeyAt >= CLIP_KEY_MS;
    if (key) this.lastKeyAt = now;
    try {
      this.venc.encode(copy, { keyFrame: key });
    } catch {}
    copy.close();
  }

  async setupVideo(w, h) {
    this.starting = true;
    try {
      if (this.venc && this.venc.state !== 'closed') this.venc.close();
      // Mudou o tamanho: o que estava guardado não combina mais com o novo.
      this.items = this.items.filter((i) => i.kind === 'a');
      this.vConfig = null;
      const base = { width: w, height: h, bitrate: this.preset.bitrate, framerate: CLIP_FPS, latencyMode: 'realtime', avc: { format: 'avc' } };
      let cfg = null;
      for (const codec of this.preset.codecs) {
        try {
          if ((await VideoEncoder.isConfigSupported({ ...base, codec })).supported) {
            cfg = { ...base, codec };
            break;
          }
        } catch {}
      }
      if (!cfg || this.closed) return;
      this.venc = new VideoEncoder({
        output: (chunk, meta) => {
          if (meta?.decoderConfig) this.vConfig = meta.decoderConfig;
          this.push('v', chunk);
        },
        error: (err) => console.warn('clipe (vídeo)', err),
      });
      this.venc.configure(cfg);
      this.size = `${w}x${h}`;
      this.width = w;
      this.height = h;
      this.lastKeyAt = 0;
    } finally {
      this.starting = false;
    }
  }

  // Recebe um pedaço de áudio da live (quem chama fecha).
  addAudio(data) {
    if (this.closed || !('AudioEncoder' in window)) return;
    const now = performance.now() * 1000;
    // Relógio do áudio -> relógio do vídeo (performance.now).
    if (this.aOffset === null || Math.abs(data.timestamp + this.aOffset - now) > 500_000) this.aOffset = now - data.timestamp;
    const fmt = `${data.sampleRate}/${data.numberOfChannels}`;
    if (!this.aenc || this.aenc.state === 'closed' || this.aFmt !== fmt) {
      if (!this.aStarting) this.setupAudio(data.sampleRate, data.numberOfChannels, fmt);
      return;
    }
    try {
      this.aenc.encode(data);
    } catch {}
  }

  async setupAudio(sampleRate, numberOfChannels, fmt) {
    this.aStarting = true;
    try {
      if (this.aenc && this.aenc.state !== 'closed') this.aenc.close();
      this.items = this.items.filter((i) => i.kind === 'v');
      this.aConfig = null;
      for (const [codec, name] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
        const cfg = { codec, sampleRate, numberOfChannels, bitrate: 128000 };
        try {
          if (!(await AudioEncoder.isConfigSupported(cfg)).supported) continue;
        } catch {
          continue;
        }
        if (this.closed) return;
        this.aenc = new AudioEncoder({
          output: (chunk, meta) => {
            if (meta?.decoderConfig) this.aConfig = meta.decoderConfig;
            this.push('a', chunk, this.aOffset || 0);
          },
          error: (err) => console.warn('clipe (áudio)', err),
        });
        this.aenc.configure(cfg);
        this.aCodec = name;
        this.aRate = sampleRate;
        this.aChannels = numberOfChannels;
        this.aFmt = fmt;
        return;
      }
    } finally {
      this.aStarting = false;
    }
  }

  push(kind, chunk, offset = 0) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.items.push({ kind, data, key: chunk.type === 'key', ts: chunk.timestamp + offset, dur: chunk.duration || 0 });
    // Joga fora o que passou do limite, começando sempre num quadro-chave.
    const cutoff = performance.now() * 1000 - CLIP_KEEP_MS * 1000;
    if (this.items.length && this.items[0].ts < cutoff - 5_000_000) {
      const k = this.items.findIndex((i) => i.kind === 'v' && i.key && i.ts >= cutoff);
      if (k > 0) {
        const start = this.items[k].ts;
        this.items = this.items.filter((i, idx) => idx >= k || (i.kind === 'a' && i.ts >= start));
      }
    }
  }

  // Segundos realmente guardados (para mostrar ao usuário).
  seconds() {
    const v = this.items.filter((i) => i.kind === 'v');
    return v.length ? (v[v.length - 1].ts - v[0].ts) / 1e6 : 0;
  }

  // Monta um MP4 com os últimos `seconds` segundos.
  async export(seconds) {
    if (this.venc && this.venc.state === 'configured') await this.venc.flush().catch(() => {});
    if (this.aenc && this.aenc.state === 'configured') await this.aenc.flush().catch(() => {});
    const video = this.items.filter((i) => i.kind === 'v');
    if (!video.length || !this.vConfig) return null;
    const cutoff = video[video.length - 1].ts - seconds * 1e6;
    // Começa no último quadro-chave antes do corte (ou no primeiro que tiver).
    let startIdx = -1;
    for (let i = 0; i < video.length; i++) {
      if (!video[i].key) continue;
      if (video[i].ts <= cutoff || startIdx === -1) startIdx = i;
      if (video[i].ts > cutoff) break;
    }
    if (startIdx < 0) return null;
    // O MP4 exige tempos sempre crescentes; se o relógio de algum lado deu
    // um pulo para trás (ex.: a live passou do plano B para a direta), descarta.
    const increasing = (list) => {
      let last = -Infinity;
      return list.filter((i) => (i.ts > last ? ((last = i.ts), true) : false));
    };
    const v = increasing(video.slice(startIdx));
    const start = v[0].ts;
    const a = this.aConfig || this.aCodec === 'opus' ? increasing(this.items.filter((i) => i.kind === 'a' && i.ts >= start)) : [];
    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: this.width, height: this.height },
      audio: a.length ? { codec: this.aCodec, sampleRate: this.aRate, numberOfChannels: this.aChannels } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'cross-track-offset',
    });
    v.forEach((c, i) => {
      const dur = i + 1 < v.length ? v[i + 1].ts - c.ts : 1e6 / CLIP_FPS;
      muxer.addVideoChunkRaw(c.data, c.key ? 'key' : 'delta', c.ts - start, Math.max(1, dur), i === 0 ? { decoderConfig: this.vConfig } : undefined);
    });
    a.forEach((c, i) => {
      muxer.addAudioChunkRaw(c.data, 'key', c.ts - start, c.dur || 20000, i === 0 && this.aConfig ? { decoderConfig: this.aConfig } : undefined);
    });
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }

  close() {
    this.closed = true;
    for (const e of [this.venc, this.aenc]) if (e && e.state !== 'closed') e.close();
    this.items = [];
  }
}
