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
export async function encoderConfig(kind, width, height, fps, onlyMode = null) {
  for (const hw of ["prefer-hardware", "no-preference"]) {
    for (const codec of CODECS[kind].strings) {
      for (const mode of onlyMode ? [onlyMode] : ["quantizer", "variable"]) {
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
// GPU decoders can fail mid-stream (seen: VA-API on NVIDIA in Brave). After the first failure every decoder of the
// session is software. Test hook: globalThis.CLEARCUT_FAIL_HW = frames after which a "hardware" decoder dies.
let softwareOnly = false;
async function decoderFor(video, onFrame) {
  const t = video.track, base = { codec: t.codec, codedWidth: t.video.width, codedHeight: t.video.height, description: video.description };
  let cfg = null;
  for (const hw of softwareOnly ? ["prefer-software", "no-preference"] : ["prefer-hardware", "no-preference", "prefer-software"]) {
    try { const r = await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration: hw }); if (r.supported) { cfg = r.config; break; } } catch { }
  }
  if (!cfg) throw new Error(`this browser cannot decode ${t.codec}`);
  let failAfter = !softwareOnly && globalThis.CLEARCUT_FAIL_HW ? globalThis.CLEARCUT_FAIL_HW : 0;
  const dec = new VideoDecoder({
    output: f => { onFrame(f); if (failAfter && --failAfter === 0) queueMicrotask(() => { dec.error = new Error("simulated GPU decoder failure"); try { dec.close(); } catch { } }); },
    error: e => { dec.error = e; console.warn("video decoder failed:", e.message || e); } });
  dec.configure(cfg);
  dec.software = cfg.hardwareAcceleration === "prefer-software" || softwareOnly;
  return dec;
}
const chunkOf = s => new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: Math.round(s.cts * 1e6 / s.ts), duration: Math.round(s.duration * 1e6 / s.ts), data: s.data });

// stream the frames whose timestamps fall in [a, b) seconds to onFrame (which must close them); decoding starts at
// the keyframe before a. Nothing is held: a GPU decoder has a small frame pool and 1440p frames are 11 MB each.
async function decodeRange(video, a, b, onFrame, busy = () => false) {
  const S = video.samples;
  let k = S.findIndex(s => s.cts / s.ts >= a); if (k < 0) return 0;
  while (k > 0 && !S[k].key) k--;
  let delivered = 0;                     // frames already handed out: a retry skips them (no duplicates)
  for (let attempt = 0; ; attempt++) {
    let n = 0;
    const dec = await decoderFor(video, f => { const t = f.timestamp / 1e6; if (t >= a && t < b && n++ >= delivered) { delivered++; onFrame(f); } else f.close(); });
    try {
      for (let i = k; i < S.length && S[i].dts / S[i].ts < b + 1; i++) {
        if (dec.state === "closed") throw dec.error || new Error("decoder closed");
        dec.decode(chunkOf(S[i]));
        while ((dec.decodeQueueSize > 4 || busy()) && dec.state !== "closed") await sleep(1);
      }
      if (dec.state === "closed") throw dec.error || new Error("decoder closed");
      await dec.flush(); dec.close();
      return delivered;
    } catch (e) {
      try { dec.close(); } catch { }
      if (dec.software || attempt >= 1) throw e;
      softwareOnly = true;               // GPU decoder died: software from now on, redo this range
      console.warn("GPU video decoder failed, continuing with the software decoder:", e.message || e);
    }
  }
}

// ---------------------------------------------------------------- SSIM on luma at 480 px width
let AW = 480;   // analysis width: set to the source width (capped) per search
function lumaOf(frame, ctxCache) {
  const h = Math.round(AW * frame.displayHeight / frame.displayWidth);
  let c = ctxCache.c; if (!c || c.canvas.height !== h) { ctxCache.c = c = new OffscreenCanvas(AW, h).getContext("2d", { willReadFrequently: true }); }
  c.drawImage(frame, 0, 0, AW, h);
  const d = c.getImageData(0, 0, AW, h).data, y = new Uint8Array(AW * h);
  for (let i = 0; i < y.length; i++) y[i] = (77 * d[4 * i] + 150 * d[4 * i + 1] + 29 * d[4 * i + 2]) >> 8;
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

// encode one window with one setting (frames streamed from the decoder) and decode it back: bytes + per-frame SSIM
async function trial(video, win, refs, cfg, kind, q, scaleH, fps, warm = 0) {
  // warm: seconds encoded before the window but not scored (VBR rate control needs a few seconds to settle)
  const chunks = []; let meta = null, enc = null, cv = null, i = 0, W = 0, H = 0;
  const w0 = Math.max(0, win[0] - warm), skip = Math.round((win[0] - w0) * fps);
  const encOut = (c, m) => { chunks.push(c); if (m?.decoderConfig) meta = m.decoderConfig; };
  await decodeRange(video, w0, win[1], f => {
    if (!enc) {
      W = scaleH ? Math.round(f.displayWidth * scaleH / f.displayHeight / 2) * 2 : f.displayWidth; H = scaleH || f.displayHeight;
      enc = new VideoEncoder({ output: encOut, error: e => console.error("encoder", e) }); enc.configure({ ...cfg, width: W, height: H });
      if (scaleH) cv = new OffscreenCanvas(W, H).getContext("2d");
    }
    let src;
    if (cv) { cv.drawImage(f, 0, 0, W, H); src = new VideoFrame(cv.canvas, { timestamp: Math.round(i * 1e6 / fps) }); }
    else src = new VideoFrame(f, { timestamp: Math.round(i * 1e6 / fps) });
    f.close();
    enc.encode(src, { keyFrame: i === 0, ...encOpts(kind, cfg.mode === "quantizer" ? q : null) }); src.close(); i++;
  });
  if (!enc) return { bytes: 0, scores: [] };
  await enc.flush(); enc.close();
  // bytes of the scored part, with its keyframe counted at the real rate (one per 10 s GOP)
  const scored = chunks.filter(c => c.timestamp >= skip * 1e6 / fps), key = chunks[0].byteLength, secs = Math.max(1 / fps, (i - skip) / fps);
  const bytes = (warm ? scored.reduce((s, c) => s + c.byteLength, 0) : chunks.slice(1).reduce((s, c) => s + c.byteLength, 0) + key * Math.min(1, secs / 10));
  const scores = [], cache = {};
  const dec = new VideoDecoder({ output: f => { const j = Math.round(f.timestamp * fps / 1e6) - skip; if (j >= 0 && refs[j]) scores.push(ssim(refs[j], lumaOf(f, cache))); f.close(); }, error: e => console.error("decoder", e) });
  dec.configure({ ...meta, hardwareAcceleration: "prefer-software" });
  for (const c of chunks) { if (dec.state === "closed") break; dec.decode(c); while (dec.decodeQueueSize > 4) await sleep(1); }
  await dec.flush(); dec.close();
  return { bytes, scores };
}

// shrinkvid-style search. Returns { q, scaleH, bytesPerSec, mean, p5, table }
export async function smartSize(video, keep, kind, target, { allowDownscale = false, fps, onProgress } = {}) {
  const W = video.track.video.width, H = video.track.video.height;
  AW = Math.min(960, W - (W % 8));   // full-resolution luma: text/whiteboard detail is what degrades first
  const cfg = await encoderConfig(kind, W, H, fps);
  if (!cfg) throw new Error(`${CODECS[kind].label} encoding is not supported in this browser`);
  // three 2 s windows spread over the kept timeline (shrinkvid: deterministic, evenly spread)
  const total = keep.reduce((s, [a, b]) => s + b - a, 0), wins = [];
  for (const frac of [0.2, 0.5, 0.8]) {
    let t = frac * total;
    for (const [a, b] of keep) { if (t <= b - a) { wins.push([a + t, Math.min(b, a + t + 2)]); break; } t -= b - a; }
  }
  const sets = [];
  for (const win of wins) {
    const refs = [], cache = {};
    await decodeRange(video, win[0], win[1], f => { refs.push(lumaOf(f, cache)); f.close(); });
    if (refs.length) sets.push({ win, refs, secs: refs.length / fps });
  }
  const families = [0, ...(allowDownscale && H > 720 ? [720] : []), ...(allowDownscale && H > 540 ? [Math.round(H * 3 / 5 / 2) * 2] : [])];
  const table = [], ladder = cfg.mode === "quantizer" ? CODECS[kind].ladder : [0.5, 1, 2, 4, 8];
  const measure = async (q, scaleH) => {
    let bytes = 0, secs = 0; const all = [];
    const c = cfg.mode === "quantizer" ? cfg : { ...cfg, bitrate: Math.round(q * 1e6 * (scaleH ? scaleH / H : 1) ** 2) };
    const rs = await Promise.all(sets.map(s => trial(video, s.win, s.refs, c, kind, q, scaleH, fps)));   // windows in parallel
    rs.forEach((r, k) => { bytes += r.bytes; secs += sets[k].secs; all.push(...r.scores); });
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
  if (target === "smart") best = knee(table.filter(pass)) || best;
  // shrinkvid never publishes something bigger than it needs: if the ladder cannot beat the source's own bitrate,
  // try bitrate targets below the source (VBR) and keep the smallest that still passes the quality floor
  // shrinkvid never publishes something bigger than it needs. Browser encoders are real-time tuned and can need more
  // bits than a careful x264 source: then try bitrate targets around the source rate (VBR, 6 s warm-up so rate
  // control settles) and never go above the source's own bitrate.
  const srcBps = video.samples.reduce((s, x) => s + x.data.byteLength, 0) / (video.samples.length / fps);
  if (!best || best.bytesPerSec > srcBps * 0.95) {
    const vcfg = await encoderConfig(kind, W, H, fps, "variable");
    const vrows = [];
    if (vcfg) for (const f of [1.0, 0.8, 0.6]) {
      let bytes = 0, secs = 0; const all = [];
      const rs = await Promise.all(sets.map(s => trial(video, s.win, s.refs, { ...vcfg, bitrate: Math.round(srcBps * 8 * f) }, kind, null, 0, fps, 6)));
      rs.forEach((r, k) => { bytes += r.bytes; secs += sets[k].secs; all.push(...r.scores); });
      all.sort((x, y) => x - y);
      const row = { q: `${Math.round(srcBps * 8 * f / 1000)}k`, vbr: Math.round(srcBps * 8 * f), scaleH: H, bytesPerSec: bytes / secs, mean: all.reduce((s, x) => s + x, 0) / all.length, p5: all[Math.floor(all.length * 0.05)] };
      table.push(row); onProgress?.(row); vrows.push(row);
      if (!pass(row)) break;
    }
    const ok = vrows.filter(pass).sort((a, b) => a.bytesPerSec - b.bytesPerSec)[0];
    if (ok) best = ok;
    else if (vrows.length) best = { ...vrows[0], belowFloor: true };   // nothing smaller meets the floor: keep the source's rate
  }
  return { ...best, mode: best.vbr ? "variable" : cfg.mode, codec: cfg.codec, hw: cfg.hw, table, srcBps };
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
  const cfg = await encoderConfig(kind, W, H, fps, choice.vbr ? "variable" : null);
  if (!cfg) throw new Error(`${CODECS[kind].label} encoding is not supported at ${W}x${H}`);
  if (choice.vbr) cfg.bitrate = choice.vbr;                                                       // source-relative VBR pick
  else if (cfg.mode === "variable") cfg.bitrate = Math.round(choice.q * 1e6 * (H / H0) ** 2);   // search ladder was in Mbit/s
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

  // video: which source frames to keep (error diffusion against the kept audio time, as jumpcutter), decided up
  // front so the timeline can be split into segments that encode in parallel (one encoder per CPU core pair; each
  // segment starts with a keyframe). A GPU encoder is used whenever the browser offers one.
  const fdur = 1 / fps, gop = Math.round(fps * 10);
  const keptUntil = t => { let s = 0; for (const [a, b] of keep) { if (t <= a) break; s += Math.min(t, b) - a; } return s; };
  const order = video.samples.map((x, i) => [x.cts / x.ts, i]).sort((p, q) => p[0] - q[0]);
  const kept = []; let out = 0;   // [source time, output index]
  for (const [t] of order) if ((out + 1) * fdur <= keptUntil(t + fdur) + fdur / 2) kept.push([t, out++]);
  const nseg = globalThis.CLEARCUT_SEGS || Math.max(1, Math.min(cfg.hw ? 2 : 3, Math.floor((navigator.hardwareConcurrency || 4) / 4) || 1,   // measured: 2-4 best, 8 slower
     Math.floor(kept.length / (gop * 2)) || 1));
  const segs = []; for (let k = 0; k < nseg; k++) segs.push(kept.slice(Math.floor(k * kept.length / nseg), Math.floor((k + 1) * kept.length / nseg)));
  let doneFrames = 0;
  const encodeSegment = async seg => {
    const chunks = [], want = new Map(seg.map(([t, o]) => [Math.round(t * 1e6), o]));
    const enc = new VideoEncoder({ output: (c, m) => chunks.push([c, m]), error: e => console.error("encoder", e) });
    enc.configure({ ...cfg, width: W, height: H });
    const cv = H !== H0 ? new OffscreenCanvas(W, H).getContext("2d") : null;
    let first = true;
    const t0 = seg[0][0], t1 = seg.at(-1)[0] + fdur / 2;
    await decodeRange(video, t0 - 1e-6, t1, f => {     // streamed: each decoded frame is encoded (or dropped) at once
      const o = want.get(f.timestamp) ?? want.get(f.timestamp + 1) ?? want.get(f.timestamp - 1);
      if (o != null) {
        const src = cv ? (cv.drawImage(f, 0, 0, W, H), new VideoFrame(cv.canvas, { timestamp: Math.round(o * 1e6 * fdur), duration: Math.round(1e6 * fdur) }))
                       : new VideoFrame(f, { timestamp: Math.round(o * 1e6 * fdur), duration: Math.round(1e6 * fdur) });
        enc.encode(src, { keyFrame: first || (o - seg[0][1]) % gop === 0, ...encOpts(kind, cfg.mode === "quantizer" && !choice.vbr ? choice.q : null) });
        src.close(); first = false; doneFrames++;
        if (doneFrames % 30 === 0) onProgress?.(doneFrames / kept.length);
      }
      f.close();
    }, () => enc.encodeQueueSize > 6);
    await enc.flush(); enc.close();
    return chunks;
  };
  const results = await Promise.all(segs.map(encodeSegment));
  for (const chunks of results) for (const [c, m] of chunks) muxer.addVideoChunk(c, m);
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), frames: out, segments: nseg, codec: cfg.codec, hw: cfg.hw, audio: acodec?.mux, width: W, height: H };
}
