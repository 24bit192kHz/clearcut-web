// WebCodecs render (decode -> keep frames -> encode -> mux) and the "smart size" search (shrinkvid in the browser:
// sample windows encoded at a quantizer ladder, decoded back and scored with SSIM against the source frames).
import { Muxer, ArrayBufferTarget } from "../vendor/mp4-muxer.mjs";

export const CODECS = {
  av1:  { label: "AV1",   mux: "av1",  qMax: 63, ladder: [16, 24, 32, 40, 48, 56, 63], strings: ["av01.0.08M.08", "av01.0.05M.08", "av01.0.04M.08"] },
  hevc: { label: "HEVC",  mux: "hevc", qMax: 51, ladder: [18, 22, 26, 30, 34, 38, 42], strings: ["hvc1.1.6.L120.90", "hvc1.1.6.L93.90"] },
  avc:  { label: "H.264", mux: "avc",  qMax: 51, ladder: [16, 20, 24, 28, 32, 36, 40], strings: ["avc1.640033", "avc1.640028", "avc1.4d0028"] },
};
// full-resolution luma SSIM floors (mean; p5 >= floor - 0.003). Calibrated with libvmaf on a lecture screen recording:
// SSIM 0.997 ~ VMAF 96, 0.999 ~ VMAF 97. "smart" = shrinkvid's Smart mode: the knee of the size/quality frontier,
// never below the "small" floor.
export const QUALITY = { smart: "smart", high: 0.999, balanced: 0.997, small: 0.993 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// first codec string the browser can encode at this size, preferring hardware and quantizer (CQ) rate control
export async function encoderConfig(kind, width, height, fps) {
  for (const hw of ["prefer-hardware", "no-preference"]) {
    for (const codec of CODECS[kind].strings) {
      for (const mode of ["quantizer", "variable"]) {
        const cfg = { codec, width, height, framerate: fps, bitrateMode: mode, latencyMode: "quality", hardwareAcceleration: hw,
          ...(mode === "variable" ? { bitrate: Math.round(width * height * fps * 0.08) } : {}), ...(kind === "avc" ? { avc: { format: "avc" } } : {}), ...(kind === "hevc" ? { hevc: { format: "hevc" } } : {}) };
        try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return { ...r.config, hw: hw === "prefer-hardware", mode }; } catch { }
      }
    }
  }
  return null;
}
export async function availableCodecs(w, h, fps) {
  const out = {};
  for (const k of Object.keys(CODECS)) out[k] = await encoderConfig(k, w, h, fps);
  return out;
}
const encOpts = (kind, q) => q == null ? {} : ({ av1: { av1: { quantizer: q } }, hevc: { hevc: { quantizer: q } }, avc: { avc: { quantizer: q } } })[kind];

// ---------------------------------------------------------------- source decoding
async function decoderFor(video, onFrame) {
  const t = video.track, base = { codec: t.codec, codedWidth: t.video.width, codedHeight: t.video.height, description: video.description };
  let cfg = null;
  for (const hw of ["prefer-hardware", "no-preference", "prefer-software"]) {
    try { const r = await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration: hw }); if (r.supported) { cfg = r.config; break; } } catch { }
  }
  if (!cfg) throw new Error(`this browser cannot decode ${t.codec}`);
  const dec = new VideoDecoder({ output: onFrame, error: e => console.error("decoder", e) });
  dec.configure(cfg);
  return dec;
}
const chunkOf = s => new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: Math.round(s.cts * 1e6 / s.ts), duration: Math.round(s.duration * 1e6 / s.ts), data: s.data });

// decode the frames whose timestamps fall in [a, b) seconds (decoding starts at the keyframe before a)
async function decodeRange(video, a, b) {
  const S = video.samples, frames = [];
  let k = S.findIndex(s => s.cts / s.ts >= a); if (k < 0) return frames;
  while (k > 0 && !S[k].key) k--;
  const dec = await decoderFor(video, f => { const t = f.timestamp / 1e6; if (t >= a && t < b) frames.push(f); else f.close(); });
  for (let i = k; i < S.length && S[i].dts / S[i].ts < b + 1; i++) { dec.decode(chunkOf(S[i])); if (dec.decodeQueueSize > 16) await sleep(1); }
  await dec.flush(); dec.close();
  return frames.sort((x, y) => x.timestamp - y.timestamp);
}

// ---------------------------------------------------------------- SSIM on luma at 480 px width
let AW = 480;   // analysis width: set to the source width (capped) per search
function lumaOf(frame, ctxCache) {
  const h = Math.round(AW * frame.displayHeight / frame.displayWidth);
  let c = ctxCache.c; if (!c || c.canvas.height !== h) { ctxCache.c = c = new OffscreenCanvas(AW, h).getContext("2d", { willReadFrequently: true }); }
  c.drawImage(frame, 0, 0, AW, h);
  const d = c.getImageData(0, 0, AW, h).data, y = new Float32Array(AW * h);
  for (let i = 0; i < y.length; i++) y[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
  return { y, w: AW, h };
}
function ssim(A, B) {
  const { w, h } = A, C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2; let s = 0, n = 0;
  for (let by = 0; by + 8 <= h; by += 4) for (let bx = 0; bx + 8 <= w; bx += 4) {
    let ma = 0, mb = 0, va = 0, vb = 0, cv = 0;
    for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) { const a = A.y[y * w + x], b = B.y[y * w + x]; ma += a; mb += b; va += a * a; vb += b * b; cv += a * b; }
    ma /= 64; mb /= 64; va = va / 64 - ma * ma; vb = vb / 64 - mb * mb; cv = cv / 64 - ma * mb;
    s += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); n++;
  }
  return s / n;
}

// encode frames with one setting and decode them back: bytes + per-frame SSIM against refs
async function trial(frames, refs, cfg, kind, q, scaleH, fps) {
  const chunks = []; let meta = null;
  const enc = new VideoEncoder({ output: (c, m) => { chunks.push(c); if (m?.decoderConfig) meta = m.decoderConfig; }, error: e => { throw e; } });
  const W = scaleH ? Math.round(frames[0].displayWidth * scaleH / frames[0].displayHeight / 2) * 2 : frames[0].displayWidth;
  const H = scaleH || frames[0].displayHeight;
  enc.configure({ ...cfg, width: W, height: H });
  const cv = scaleH ? new OffscreenCanvas(W, H).getContext("2d") : null;
  frames.forEach((f, i) => {
    let src = f;
    if (cv) { cv.drawImage(f, 0, 0, W, H); src = new VideoFrame(cv.canvas, { timestamp: Math.round(i * 1e6 / fps) }); }
    else src = new VideoFrame(f, { timestamp: Math.round(i * 1e6 / fps) });
    enc.encode(src, { keyFrame: i === 0, ...encOpts(kind, cfg.mode === "quantizer" ? q : null) }); src.close();
  });
  await enc.flush(); enc.close();
  const bytes = chunks.reduce((s, c) => s + c.byteLength, 0), scores = [], cache = {};
  const dec = new VideoDecoder({ output: f => { const i = Math.round(f.timestamp * fps / 1e6); if (refs[i]) scores.push(ssim(refs[i], lumaOf(f, cache))); f.close(); }, error: e => { throw e; } });
  dec.configure(meta);
  for (const c of chunks) dec.decode(c);
  await dec.flush(); dec.close();
  return { bytes, scores };
}

// shrinkvid-style search. Returns { q, scaleH, bytesPerSec, mean, p5, table }
export async function smartSize(video, keep, kind, target, { allowDownscale = false, fps, onProgress } = {}) {
  const W = video.track.video.width, H = video.track.video.height;
  AW = Math.min(1280, W - (W % 8));   // full-resolution luma: text/whiteboard detail is what degrades first
  const cfg = await encoderConfig(kind, W, H, fps);
  if (!cfg) throw new Error(`${CODECS[kind].label} encoding is not supported in this browser`);
  // three 2 s windows spread over the kept timeline (shrinkvid: deterministic, evenly spread)
  const total = keep.reduce((s, [a, b]) => s + b - a, 0), wins = [];
  for (const frac of [0.2, 0.5, 0.8]) {
    let t = frac * total;
    for (const [a, b] of keep) { if (t <= b - a) { wins.push([a + t, Math.min(b, a + t + 2)]); break; } t -= b - a; }
  }
  const sets = [];
  for (const [a, b] of wins) {
    const frames = await decodeRange(video, a, b), cache = {};
    if (frames.length) sets.push({ frames, refs: frames.map(f => lumaOf(f, cache)), secs: frames.length / fps });
  }
  const families = [0, ...(allowDownscale && H > 720 ? [720] : []), ...(allowDownscale && H > 540 ? [Math.round(H * 3 / 5 / 2) * 2] : [])];
  const table = [], ladder = cfg.mode === "quantizer" ? CODECS[kind].ladder : [0.5, 1, 2, 4, 8];
  const measure = async (q, scaleH) => {
    let bytes = 0, secs = 0; const all = [];
    for (const s of sets) {
      const c = cfg.mode === "quantizer" ? cfg : { ...cfg, bitrate: Math.round(q * 1e6 * (scaleH ? scaleH / H : 1) ** 2) };
      const r = await trial(s.frames, s.refs, c, kind, q, scaleH, fps); bytes += r.bytes; secs += s.secs; all.push(...r.scores);
    }
    all.sort((x, y) => x - y);
    const row = { q, scaleH: scaleH || H, bytesPerSec: bytes / secs, mean: all.reduce((s, x) => s + x, 0) / all.length, p5: all[Math.floor(all.length * 0.05)] };
    table.push(row); onProgress?.(row); return row;
  };
  const floor = target === "smart" ? QUALITY.small : target;
  const pass = r => r.mean >= floor && r.p5 >= floor - 0.003;
  let best = null;
  for (const fam of families) {
    let lastPass = null, firstFail = null;
    for (const q of (cfg.mode === "quantizer" ? ladder : [...ladder].reverse())) {
      const r = await measure(q, fam);
      if (pass(r)) lastPass = r; else { firstFail = r; break; }
    }
    if (lastPass && firstFail && cfg.mode === "quantizer" && Math.abs(firstFail.q - lastPass.q) > 2) {   // one bisection step
      const r = await measure(Math.round((lastPass.q + firstFail.q) / 2), fam); if (pass(r)) lastPass = r;
    }
    if (!lastPass) lastPass = table.filter(r => (r.scaleH === (fam || H))).sort((x, y) => y.mean - x.mean)[0];
    if (!best || lastPass.bytesPerSec < best.bytesPerSec && pass(lastPass)) best = lastPass;
  }
  for (const s of sets) s.frames.forEach(f => f.close());
  if (target === "smart") best = knee(table.filter(pass)) || best;
  return { ...best, mode: cfg.mode, codec: cfg.codec, hw: cfg.hw, table };
}

// shrinkvid Smart mode: normalised (size, quality) frontier, the point farthest from the chord between its ends
function knee(rows) {
  const F = rows.filter(r => !rows.some(o => o !== r && o.bytesPerSec <= r.bytesPerSec && o.mean >= r.mean && (o.bytesPerSec < r.bytesPerSec || o.mean > r.mean)))
    .sort((a, b) => a.bytesPerSec - b.bytesPerSec);
  if (F.length < 3) return F[0] || null;          // shrinkvid: insufficient_points -> smallest safe point
  const x0 = F[0].bytesPerSec, x1 = F.at(-1).bytesPerSec, y0 = F[0].mean, y1 = F.at(-1).mean;
  const nx = r => (r.bytesPerSec - x0) / (x1 - x0 || 1), ny = r => (r.mean - y0) / (y1 - y0 || 1);
  let best = F[0], bd = -1;
  for (const r of F) { const d = Math.abs(ny(r) - nx(r)) / Math.SQRT2; if (d > bd) { bd = d; best = r; } }
  return bd < 0.05 ? F[0] : best;                 // linear curve: no knee, the smallest safe point
}

// ---------------------------------------------------------------- full render
export async function render(video, audioOut, keep, choice, { fps, onProgress, audioKbps = 64 }) {
  const kind = choice.kind, W0 = video.track.video.width, H0 = video.track.video.height;
  const H = choice.scaleH && choice.scaleH < H0 ? choice.scaleH : H0, W = H === H0 ? W0 : Math.round(W0 * H / H0 / 2) * 2;
  const cfg = await encoderConfig(kind, W, H, fps);
  if (!cfg) throw new Error(`${CODECS[kind].label} encoding is not supported at ${W}x${H}`);
  if (cfg.mode === "variable") cfg.bitrate = Math.round(choice.q * 1e6 * (H / H0) ** 2);   // search ladder was in Mbit/s
  const ach = audioOut.channels.length;
  let acodec = null;
  for (const c of [{ codec: "opus", mux: "opus" }, { codec: "mp4a.40.2", mux: "aac" }]) {
    try { if ((await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: audioOut.sampleRate, numberOfChannels: ach, bitrate: audioKbps * 1000 })).supported) { acodec = c; break; } } catch { }
  }
  const muxer = new Muxer({ target: new ArrayBufferTarget(), fastStart: "in-memory", firstTimestampBehavior: "offset",
    video: { codec: CODECS[kind].mux, width: W, height: H, frameRate: fps },
    ...(acodec ? { audio: { codec: acodec.mux, sampleRate: audioOut.sampleRate, numberOfChannels: ach } } : {}) });

  // audio first (fast): 20 ms planar chunks
  if (acodec) {
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { throw e; } });
    aenc.configure({ codec: acodec.codec, sampleRate: audioOut.sampleRate, numberOfChannels: ach, bitrate: audioKbps * 1000 });
    const n = audioOut.channels[0].length, step = Math.round(audioOut.sampleRate / 50);
    for (let i = 0; i < n; i += step) {
      const len = Math.min(step, n - i), data = new Float32Array(len * ach);
      audioOut.channels.forEach((ch, c) => data.set(ch.subarray(i, i + len), c * len));
      aenc.encode(new AudioData({ format: "f32-planar", sampleRate: audioOut.sampleRate, numberOfFrames: len, numberOfChannels: ach, timestamp: Math.round(i * 1e6 / audioOut.sampleRate), data }));
      if (aenc.encodeQueueSize > 32) await sleep(1);
    }
    await aenc.flush(); aenc.close();
  }

  // video: decode everything in order, keep frames by error diffusion against the kept audio time (jumpcutter)
  const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { throw e; } });
  enc.configure({ ...cfg, width: W, height: H });
  const cv = H !== H0 ? new OffscreenCanvas(W, H).getContext("2d") : null;
  const fdur = 1 / fps, gop = Math.round(fps * 10);   // 10 s GOP: lectures are mostly static
  const keptUntil = t => { let s = 0; for (const [a, b] of keep) { if (t <= a) break; s += Math.min(t, b) - a; } return s; };
  let out = 0, seen = 0; const total = video.samples.length;
  const pending = [];
  const dec = await decoderFor(video, f => pending.push(f));
  const drain = async () => {
    pending.sort((a, b) => a.timestamp - b.timestamp);
    while (pending.length > 4 || (pending.length && drain.final)) {
      const f = pending.shift(), t = f.timestamp / 1e6; seen++;
      if ((out + 1) * fdur <= keptUntil(t + fdur) + fdur / 2) {
        let src = cv ? (cv.drawImage(f, 0, 0, W, H), new VideoFrame(cv.canvas, { timestamp: Math.round(out * 1e6 * fdur), duration: Math.round(1e6 * fdur) }))
                     : new VideoFrame(f, { timestamp: Math.round(out * 1e6 * fdur), duration: Math.round(1e6 * fdur) });
        enc.encode(src, { keyFrame: out % gop === 0, ...encOpts(kind, cfg.mode === "quantizer" ? choice.q : null) }); src.close(); out++;
        while (enc.encodeQueueSize > 8) await sleep(1);
      }
      f.close();
      if (seen % 30 === 0) onProgress?.(seen / total);
    }
  };
  for (const s of video.samples) { dec.decode(chunkOf(s)); while (dec.decodeQueueSize > 8) await sleep(1); await drain(); }
  await dec.flush(); drain.final = true; await drain(); dec.close();
  await enc.flush(); enc.close();
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), frames: out, codec: cfg.codec, hw: cfg.hw, audio: acodec?.mux, width: W, height: H };
}
