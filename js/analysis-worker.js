// Analysis worker: Silero VAD probabilities (one per 512 samples at 16 kHz, as jumpcutter) and the 10 ms features
// clearcut's filler pass uses: MFCC c1..c12 frame-to-frame flux, pitch (autocorrelation), level (dB), spectral flatness.
import * as ort from "../vendor/ort/ort.wasm.min.mjs";

ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
ort.env.wasm.numThreads = 1;   // GitHub Pages has no cross-origin isolation, so no wasm threads

const post = (type, data, transfer) => self.postMessage({ type, ...data }, transfer || []);

// ---------------------------------------------------------------- FFT (radix-2, in place)
function fftPlan(n) {
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  return { n, rev, cos, sin };
}
function fft(P, re, im) {
  const { n, rev, cos, sin } = P;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step], a = s + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

// ---------------------------------------------------------------- Silero VAD
async function vad(pcm) {
  // Silero VAD v6 (silero-vad 6.2.3, the version jumpcutter pins): 512-sample windows with 64 samples of context
  const session = await ort.InferenceSession.create(new URL("../vendor/silero_vad_v6.onnx", import.meta.url).href,
    { executionProviders: ["wasm"] });
  const n = Math.ceil(pcm.length / 512), probs = new Float32Array(n);
  let state = new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]);
  const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
  const buf = new Float32Array(576);
  for (let i = 0; i < n; i++) {
    buf.copyWithin(0, 512, 576);                     // context = last 64 samples of the previous input
    buf.fill(0, 64); buf.set(pcm.subarray(i * 512, Math.min(pcm.length, i * 512 + 512)), 64);
    const out = await session.run({ input: new ort.Tensor("float32", buf.slice(), [1, 576]), state, sr });
    probs[i] = out.output.data[0]; state = out.stateN;
    if (i % 2000 === 0) post("progress", { stage: "vad", done: i / n });
  }
  return probs;
}

// ---------------------------------------------------------------- 10 ms features
function features(pcm) {
  const sr = 16000, hop = 160, win = 400, nfft = 512;
  const m = Math.max(0, Math.floor((pcm.length - win) / hop) + 1);
  // mel filterbank exactly as fillers.py: 40 triangles between 80 and 7600 Hz
  const mel = f => 2595 * Math.log10(1 + f / 700), imel = x => 700 * (10 ** (x / 2595) - 1);
  const bins = [], m0 = mel(80), m1 = mel(7600);
  for (let i = 0; i < 42; i++) bins.push(Math.floor((nfft + 1) * imel(m0 + (m1 - m0) * i / 41) / sr));
  const fb = [];
  for (let k = 0; k < 40; k++) {
    const lo = bins[k], c = bins[k + 1], hi = bins[k + 2], row = new Float32Array(nfft / 2 + 1);
    for (let j = lo; j < c; j++) row[j] = (j - lo) / Math.max(1, c - lo);
    for (let j = c; j < hi; j++) row[j] = (hi - j) / Math.max(1, hi - c);
    fb.push(row);
  }
  const ham = new Float32Array(win); for (let i = 0; i < win; i++) ham[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (win - 1));
  const dctM = []; // DCT-II ortho, rows 1..12
  for (let k = 1; k <= 12; k++) { const row = new Float32Array(40), s = Math.sqrt(2 / 40); for (let n = 0; n < 40; n++) row[n] = s * Math.cos(Math.PI * k * (2 * n + 1) / 80); dctM.push(row); }
  const P = fftPlan(nfft), re = new Float64Array(nfft), im = new Float64Array(nfft);
  const flux = new Float32Array(m), flat = new Float32Array(m), level = new Float32Array(m);
  let prev = null; const cep = new Float32Array(12), logmel = new Float32Array(40), pw = new Float64Array(nfft / 2 + 1);
  for (let f = 0; f < m; f++) {
    const o = f * hop; let e = 0;
    for (let i = 0; i < nfft; i++) { const x = i < win ? pcm[o + i] : 0; e += i < win ? x * x : 0; re[i] = i < win ? x * ham[i] : 0; im[i] = 0; }
    fft(P, re, im);
    let lsum = 0, asum = 0, nb = 0;
    for (let j = 0; j <= nfft / 2; j++) {
      pw[j] = re[j] * re[j] + im[j] * im[j];
      if (j >= 16 && j <= 192) { lsum += Math.log(pw[j] + 1e-12); asum += pw[j]; nb++; }   // 500..6000 Hz
    }
    flat[f] = Math.exp(lsum / nb) / (asum / nb + 1e-12);
    for (let k = 0; k < 40; k++) { let s = 0; const row = fb[k]; for (let j = 0; j <= nfft / 2; j++) s += pw[j] * row[j]; logmel[k] = Math.log(s + 1e-9); }
    for (let k = 0; k < 12; k++) { let s = 0; const row = dctM[k]; for (let n = 0; n < 40; n++) s += row[n] * logmel[n]; cep[k] = s; }
    if (prev) { let d = 0; for (let k = 0; k < 12; k++) d += (cep[k] - prev[k]) ** 2; flux[f] = Math.sqrt(d); } else prev = new Float32Array(12);
    prev.set(cep);
    level[f] = 10 * Math.log10(e / win + 1e-10) + 94;   // ~dB SPL-like scale (Praat-style intensity, only differences matter)
    if (f % 20000 === 0) post("progress", { stage: "features", done: f / m * 0.5 });
  }
  return { flux, flat, level };
}

// pitch: normalised autocorrelation on an 8 kHz copy, 75..500 Hz, 10 ms step, 40 ms window; NaN = unvoiced
function pitch(pcm, level) {
  const n8 = Math.floor(pcm.length / 2), x = new Float32Array(n8);
  for (let i = 0; i < n8; i++) x[i] = 0.5 * (pcm[2 * i] + pcm[2 * i + 1]);   // crude 2:1 decimation (pitch band only)
  const sr = 8000, hop = 80, win = 320, nfft = 1024, lmin = Math.floor(sr / 500), lmax = Math.ceil(sr / 75);
  const m = level.length, f0 = new Float32Array(m).fill(NaN);
  const P = fftPlan(nfft), re = new Float64Array(nfft), im = new Float64Array(nfft);
  let maxLevel = -Infinity; for (const v of level) if (v > maxLevel) maxLevel = v;
  const hann = new Float32Array(win); for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1));
  // autocorrelation of the window itself, to normalise (Boersma 1993)
  re.fill(0); im.fill(0); for (let i = 0; i < win; i++) re[i] = hann[i]; fft(P, re, im);
  for (let j = 0; j < nfft; j++) { re[j] = re[j] * re[j] + im[j] * im[j]; im[j] = 0; } fft(P, re, im);
  const wac = Float64Array.from(re.subarray(0, lmax + 2), v => v / re[0]);
  for (let f = 0; f < m; f++) {
    if (level[f] < maxLevel - 45) continue;                 // silence: unvoiced
    const o = f * hop + 40 - win / 2; if (o < 0 || o + win > n8) continue;
    let mean = 0; for (let i = 0; i < win; i++) mean += x[o + i]; mean /= win;
    for (let i = 0; i < nfft; i++) { re[i] = i < win ? (x[o + i] - mean) * hann[i] : 0; im[i] = 0; }
    fft(P, re, im);
    for (let j = 0; j < nfft; j++) { re[j] = re[j] * re[j] + im[j] * im[j]; im[j] = 0; }
    fft(P, re, im);
    const r0 = re[0]; if (r0 <= 0) continue;
    let best = 0, bl = 0;
    for (let l = lmin; l <= lmax; l++) { const r = re[l] / r0 / wac[l]; if (r > best) { best = r; bl = l; } }
    if (best > 0.45 && bl > lmin && bl < lmax) {             // Praat voicing threshold 0.45; parabolic refinement
      const a = re[bl - 1] / r0 / wac[bl - 1], b = best, c = re[bl + 1] / r0 / wac[bl + 1];
      const d = (a - c) / (2 * (a - 2 * b + c) || 1e-9);
      f0[f] = sr / (bl + d);
    }
    if (f % 20000 === 0) post("progress", { stage: "features", done: 0.5 + f / m * 0.5 });
  }
  return f0;
}

self.onmessage = async e => {
  try {
    const { pcm, job } = e.data;
    if (job === "vad") { const probs = await vad(pcm); post("vad", { probs }, [probs.buffer]); }
    else {
      const F = features(pcm); const f0 = pitch(pcm, F.level);
      post("features", { ...F, f0 }, [F.flux.buffer, F.flat.buffer, F.level.buffer, f0.buffer]);
    }
  } catch (err) { post("error", { message: String(err && err.stack || err) }); }
};
