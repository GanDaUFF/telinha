'use strict';
// O "juiz" do Duelo de Aura: analisa a câmera de quem está duelando, no
// próprio PC, com o MediaPipe Face Landmarker (vendor/mediapipe). Ele acha o
// rosto e dá ~50 medidas (sorriso, boca aberta, piscada, sobrancelha, para
// onde os olhos olham...) e o ângulo da cabeça. Cada desafio tem sua conta
// de aura em cima dessas medidas. Nada da câmera sai do PC para isso.

const AURA_MP = new URL('vendor/mediapipe/', location.href).href;
const AURA_HZ = 10; // análises por segundo
let faceLm = null;
let faceLmLoading = null;

function loadFaceLm() {
  faceLmLoading ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import(AURA_MP + 'vision_bundle.mjs');
    const files = await FilesetResolver.forVisionTasks(AURA_MP + 'wasm');
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: AURA_MP + 'face_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    try {
      faceLm = await FaceLandmarker.createFromOptions(files, opts('GPU'));
    } catch {
      faceLm = await FaceLandmarker.createFromOptions(files, opts('CPU'));
    }
    return faceLm;
  })().catch((err) => {
    faceLmLoading = null;
    throw err;
  });
  return faceLmLoading;
}

const clamp = (x) => Math.max(0, Math.min(1, x));
const deg = (r) => (r * 180) / Math.PI;

// Medidas de um quadro (ou null se não tem rosto).
function faceFeatures(res, prevNose) {
  const shapes = res.faceBlendshapes?.[0]?.categories;
  if (!shapes?.length) return null;
  const b = {};
  for (const c of shapes) b[c.categoryName] = c.score;
  const avg = (x, y) => ((b[x] || 0) + (b[y] || 0)) / 2;
  // Matriz 4x4 (coluna a coluna) -> ângulos da cabeça.
  const m = res.facialTransformationMatrixes?.[0]?.data;
  const yaw = m ? deg(Math.atan2(m[8], m[10])) : 0;
  const pitch = m ? deg(Math.asin(Math.max(-1, Math.min(1, -m[9])))) : 0;
  const roll = m ? deg(Math.atan2(m[1], m[5])) : 0;
  const nose = res.faceLandmarks?.[0]?.[1];
  const motion = nose && prevNose ? Math.hypot(nose.x - prevNose.x, nose.y - prevNose.y) : 0;
  const lookL = avg('eyeLookOutLeft', 'eyeLookInRight');
  const lookR = avg('eyeLookInLeft', 'eyeLookOutRight');
  return {
    nose,
    smile: avg('mouthSmileLeft', 'mouthSmileRight'),
    smirk: Math.abs((b.mouthSmileLeft || 0) - (b.mouthSmileRight || 0)),
    jaw: b.jawOpen || 0,
    blink: avg('eyeBlinkLeft', 'eyeBlinkRight'),
    brow: avg('browDownLeft', 'browDownRight'),
    browUp: b.browInnerUp || 0,
    squint: avg('eyeSquintLeft', 'eyeSquintRight'),
    gazeOff: Math.max(avg('eyeLookUpLeft', 'eyeLookUpRight'), avg('eyeLookDownLeft', 'eyeLookDownRight'), lookL, lookR),
    yaw,
    pitch,
    roll,
    motion,
  };
}

// Pedaços comuns das contas (0..1).
const still = (f) => clamp(1 - f.motion * 60);
const neutral = (f) => clamp(1 - f.smile * 2 - f.jaw * 2);
const contact = (f) => clamp(1 - f.gazeOff * 1.5) * clamp(1 - Math.abs(f.yaw) / 25);
const intense = (f) => clamp((f.brow + f.squint) * 1.3);

// Cada tipo de desafio: o que o juiz procura, a conta e se rir tira aura.
const AURA_KINDS = {
  sigma: { what: 'cara neutra, cabeça parada, olhando para a câmera', laughHurts: true,
    score: (f) => 0.4 * still(f) + 0.35 * neutral(f) + 0.25 * contact(f) },
  stare: { what: 'olhar fixo na câmera, sem rir e sem piscar', laughHurts: true, blinkHurts: true,
    score: (f) => 0.45 * contact(f) + 0.3 * neutral(f) + 0.25 * still(f) },
  protagonist: { what: 'olhar intenso (sobrancelha franzida, olhos apertados) e fixo', laughHurts: true,
    score: (f) => 0.4 * intense(f) + 0.3 * contact(f) + 0.15 * still(f) + 0.15 * neutral(f) },
  villain: { what: 'sobrancelha franzida + sorriso de canto, encarando', laughHurts: false,
    score: (f) => 0.35 * clamp(f.brow * 1.6) + 0.35 * clamp(f.smile * 0.8 + f.smirk * 1.5) + 0.3 * contact(f) },
  smirk: { what: 'sorriso de canto (só de um lado), sem gargalhar', laughHurts: true,
    score: (f) => (0.5 * clamp(f.smirk * 3) + 0.2 * clamp(f.smile * 1.5) + 0.3 * contact(f)) * (f.jaw > 0.35 ? 0.3 : 1) },
  power: { what: 'intensidade crescendo: sobrancelha, olhos e boca, até o fim', laughHurts: false, ramp: true,
    score: (f) => clamp(f.brow + f.squint + f.jaw * 0.6 + f.browUp * 0.2) },
  away: { what: 'cabeça virada de lado, parada, cara pensativa', laughHurts: true,
    score: (f) => 0.6 * clamp((Math.abs(f.yaw) - 10) / 25) + 0.25 * still(f) + 0.15 * neutral(f) },
  slow: { what: 'movimento lento e contínuo (nem parado, nem rápido)', laughHurts: true,
    score: (f) => 0.7 * clamp(f.motion / 0.002) * clamp(1 - (f.motion - 0.006) / 0.01) + 0.3 * neutral(f) },
  calm: { what: 'tranquilidade: cabeça parada, boca fechada, no máximo um sorrisinho', laughHurts: true,
    score: (f) => 0.5 * still(f) + 0.3 * clamp(1 - f.jaw * 2) + 0.2 * clamp(1 - Math.abs(f.smile - 0.25) * 2) },
  victory: { what: 'sorriso grande de vitória, olhando para a câmera', laughHurts: false,
    score: (f) => 0.6 * clamp(f.smile * 1.3) + 0.2 * clamp(f.browUp * 1.5) + 0.2 * contact(f) },
};

const LAUGH_PENALTY = 250;
// Sumir da câmera também tira aura (senão ficar fora seria melhor que errar).
const BLINK_PENALTY = 40;

// Analisa uma câmera durante `ms`. onUpdate({ score, live, tag }) a cada análise.
// Devolve { stop() -> placar final }.
function startAuraJudge(stream, kind, ms, onUpdate) {
  const k = AURA_KINDS[kind] || AURA_KINDS.sigma;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.play().catch(() => {});
  const st = { score: 0, live: 0, tag: '', seen: 0, samples: 0, laughs: 0, blinks: 0, laughRun: 0, blinkOpen: true, prevNose: null, start: performance.now(), lastTs: 0 };
  let lastEvent = { text: '', until: 0 };
  const event = (text) => (lastEvent = { text, until: performance.now() + 1500 });
  const timer = setInterval(() => {
    if (!faceLm || video.readyState < 2) return;
    const now = performance.now();
    const ts = Math.max(st.lastTs + 1, now);
    st.lastTs = ts;
    let res;
    try {
      res = faceLm.detectForVideo(video, ts);
    } catch {
      return;
    }
    st.samples++;
    // Conta pelo tempo que passou (PC lento analisa menos vezes, mas vale igual).
    const dt = Math.min(0.5, (now - (st.lastNow || now - 1000 / AURA_HZ)) / 1000);
    st.lastNow = now;
    const f = faceFeatures(res, st.prevNose);
    if (!f) {
      st.live = 0;
      st.prevNose = null;
      st.score -= 20 * dt; // sumiu da câmera: perde 20 de aura por segundo
      st.tag = 'cadê você? 👀 -aura';
      return onUpdate({ score: Math.round(st.score), live: 0, tag: st.tag });
    }
    st.seen++;
    st.prevNose = f.nose;
    f.motion *= 0.1 / Math.max(0.05, dt);
    let pts = clamp(k.score(f));
    if (k.ramp) pts *= 0.5 + clamp((now - st.start) / ms); // vale mais no final
    // Gargalhada (sorriso grande ou boca aberta rindo) por ~0,3 s seguidos.
    const laughing = f.smile > 0.6 || (f.jaw > 0.45 && f.smile > 0.3);
    st.laughRun = laughing ? st.laughRun + 1 : 0;
    if (k.laughHurts && st.laughRun === 3) {
      st.laughs++;
      st.score -= LAUGH_PENALTY;
      event(`RIU! -${LAUGH_PENALTY} 🤣`);
    }
    if (k.laughHurts && laughing) pts = 0;
    if (k.blinkHurts) {
      if (st.blinkOpen && f.blink > 0.55) {
        st.blinkOpen = false;
        st.blinks++;
        st.score -= BLINK_PENALTY;
        event(`piscou -${BLINK_PENALTY}`);
      } else if (f.blink < 0.3) st.blinkOpen = true;
    }
    st.score += pts * 100 * dt; // até 100 de aura por segundo
    st.live = st.live * 0.6 + pts * 0.4;
    st.tag =
      now < lastEvent.until
        ? lastEvent.text
        : st.live > 0.75
          ? 'AURA MÁXIMA 🗿'
          : st.live > 0.5
            ? 'farmando aura ✨'
            : st.live > 0.25
              ? 'meh 😐'
              : 'perdendo aura 📉';
    onUpdate({ score: Math.round(st.score), live: st.live, tag: st.tag });
  }, 1000 / AURA_HZ);
  return {
    stop() {
      clearInterval(timer);
      video.srcObject = null;
      return { score: Math.round(st.score), seen: st.samples ? st.seen / st.samples : 0, laughs: st.laughs, blinks: st.blinks };
    },
  };
}
