// Media I/O: audio decode (browser, ffmpeg.wasm fallback), MP4 demux (mp4box), sample-exact audio splicing,
// and an ffmpeg.wasm fallback for containers/codecs WebCodecs cannot read.
import { FFmpeg } from "../vendor/ffmpeg/index.js";

let ff = null;
export async function ffmpeg(log) {
  if (ff) return ff;
  ff = new FFmpeg();
  if (log) ff.on("log", ({ message }) => log(message));
  const base = new URL("../vendor/ffmpeg-core/", import.meta.url).href;
  await ff.load({ coreURL: base + "ffmpeg-core.js", wasmURL: base + "ffmpeg-core.wasm" });
  return ff;
}

// decoded audio at a given rate: { channels: Float32Array[], sampleRate }
export async function decodeAudio(file, sampleRate, onLog) {
  try {
    const ctx = new OfflineAudioContext(1, 1, sampleRate);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const ch = []; for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
    return { channels: ch, sampleRate: buf.sampleRate, via: "browser" };
  } catch (err) {
    onLog?.("browser could not decode the audio, using ffmpeg.wasm");
    const f = await ffmpeg(onLog);
    await f.writeFile("in", new Uint8Array(await file.arrayBuffer()));
    await f.exec(["-i", "in", "-vn", "-ac", "2", "-ar", String(sampleRate), "-f", "f32le", "out.raw"]);
    const raw = new Float32Array((await f.readFile("out.raw")).buffer);
    const n = raw.length / 2, L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = raw[2 * i]; R[i] = raw[2 * i + 1]; }
    await f.deleteFile("out.raw");
    return { channels: [L, R], sampleRate, via: "ffmpeg" };
  }
}

export function mono16k(audio) {
  const { channels, sampleRate } = audio, n = channels[0].length, out = new Float32Array(Math.floor(n * 16000 / sampleRate));
  const r = sampleRate / 16000;
  for (let i = 0; i < out.length; i++) {      // box-filter decimation (enough for VAD / pitch / MFCC to 7.6 kHz)
    const a = Math.floor(i * r), b = Math.max(a + 1, Math.floor((i + 1) * r)); let s = 0;
    for (let k = a; k < b; k++) for (const ch of channels) s += ch[k] || 0;
    out[i] = s / ((b - a) * channels.length);
  }
  return out;
}

// sample-exact splice of the kept intervals with short raised-cosine fades at every join (clearcut: 6 ms)
export function spliceAudio(audio, keep, { fadeMs = 6, mono = false } = {}) {
  const sr = audio.sampleRate, src = mono ? [mixdown(audio.channels)] : audio.channels;
  const segs = keep.map(([a, b]) => [Math.round(a * sr), Math.round(b * sr)]);
  const total = segs.reduce((s, [a, b]) => s + (b - a), 0), fade = Math.round(fadeMs / 1000 * sr);
  const out = src.map(() => new Float32Array(total));
  let o = 0;
  for (const [a, b] of segs) {
    const len = b - a;
    src.forEach((ch, c) => {
      out[c].set(ch.subarray(a, b), o);
      const f = Math.min(fade, len >> 1);
      for (let i = 0; i < f; i++) { const g = 0.5 - 0.5 * Math.cos(Math.PI * i / f); out[c][o + i] *= g; out[c][o + len - 1 - i] *= g; }
    });
    o += len;
  }
  return { channels: out, sampleRate: sr };
}
function mixdown(chs) { const n = chs[0].length, m = new Float32Array(n); for (const ch of chs) for (let i = 0; i < n; i++) m[i] += ch[i] / chs.length; return m; }

// simple loudness normalisation: gated RMS to target LUFS-ish, then a peak ceiling
export function normalize(a, targetDb = -16, peakDb = -2) {
  const sr = a.sampleRate, blk = Math.round(0.4 * sr), en = [];
  for (let i = 0; i + blk <= a.channels[0].length; i += blk >> 1) { let s = 0; for (const ch of a.channels) for (let k = i; k < i + blk; k++) s += ch[k] * ch[k]; en.push(s / (blk * a.channels.length)); }
  const abs = en.filter(e => 10 * Math.log10(e + 1e-12) > -70); const m1 = abs.reduce((s, e) => s + e, 0) / (abs.length || 1);
  const rel = abs.filter(e => e > m1 / 10); const m = rel.reduce((s, e) => s + e, 0) / (rel.length || 1);
  const loud = -0.691 + 10 * Math.log10(m + 1e-12), gain = 10 ** ((targetDb - loud) / 20), ceil = 10 ** (peakDb / 20);
  const knee = ceil * 0.9;   // soft knee: linear below 90 % of the ceiling, tanh into the ceiling above
  for (const ch of a.channels) for (let i = 0; i < ch.length; i++) {
    const v = ch[i] * gain, m = Math.abs(v);
    ch[i] = m <= knee ? v : Math.sign(v) * (knee + (ceil - knee) * Math.tanh((m - knee) / (ceil - knee)));
  }
  return { gainDb: 20 * Math.log10(gain), loudness: loud };
}

// ---------------------------------------------------------------- MP4 demux with mp4box (whole file in memory)
export async function demuxMp4(file, onProgress) {
  const MP4Box = globalThis.MP4Box;
  const mp4 = MP4Box.createFile();
  const tracks = {}; let info = null, error = null;
  mp4.onError = e => { error = e; };
  mp4.onReady = i => {
    info = i;
    for (const t of i.tracks) if (t.video || t.audio) { tracks[t.id] = { track: t, samples: [] }; mp4.setExtractionOptions(t.id, null, { nbSamples: 1000 }); }
    mp4.start();
  };
  mp4.onSamples = (id, _u, samples) => { tracks[id].samples.push(...samples.map(s => ({ data: s.data, cts: s.cts, dts: s.dts, duration: s.duration, ts: s.timescale, key: s.is_sync }))); };
  const chunk = 8 << 20; let off = 0;
  while (off < file.size) {
    const buf = await file.slice(off, off + chunk).arrayBuffer(); buf.fileStart = off;
    mp4.appendBuffer(buf); off += buf.byteLength; onProgress?.(off / file.size);
  }
  mp4.flush();
  if (error || !info) throw new Error("not an MP4/MOV file" + (error ? `: ${error}` : ""));
  const v = info.videoTracks[0];
  if (!v) throw new Error("no video track");
  const vt = mp4.getTrackById(v.id);
  const entry = vt.mdia.minf.stbl.stsd.entries[0];
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  let description;
  if (box) { const s = new globalThis.DataStream(undefined, 0, globalThis.DataStream.BIG_ENDIAN); box.write(s); description = new Uint8Array(s.buffer, 8); }
  // edit list: presentation starts at media_time (B-frame delay); players apply it, so must we (else video lags audio)
  const S = tracks[v.id].samples, el = vt.edts?.elst?.entries?.[0];
  const shift = el && el.media_time >= 0 ? el.media_time : Math.min(...S.slice(0, 64).map(s => s.cts));
  for (const s of S) s.cts -= shift;
  return { info, video: { track: v, description, samples: S, shift } };
}

// MKV/WebM/TS/...: repackage the streams into MP4 without re-encoding, so WebCodecs can take over (fast path)
export async function remuxToMp4(file, log) {
  const f = await ffmpeg(log);
  await f.writeFile("rm_in", new Uint8Array(await file.arrayBuffer()));
  try { await f.exec(["-i", "rm_in", "-map", "0:v:0", "-c:v", "copy", "-an", "-f", "mp4", "rm_out.mp4"]); }
  finally { await f.deleteFile("rm_in"); }
  const data = await f.readFile("rm_out.mp4"); await f.deleteFile("rm_out.mp4");
  if (!data.length) throw new Error("remux produced nothing");
  return new File([data.buffer], "remux.mp4", { type: "video/mp4" });
}

// ffmpeg.wasm full fallback: exact trim/atrim/concat (the lesson from the "reverse" bug: never concat-demuxer in/out points)
export async function renderWithFfmpeg(file, keep, { crf = 26, audioKbps = 64, mono = true, height = 0 }, log, progress) {
  const f = await ffmpeg(log);
  f.on("progress", ({ progress: p }) => progress?.(p));
  await f.writeFile("in", new Uint8Array(await file.arrayBuffer()));
  const parts = keep.map(([a, b], i) => `[0:v]trim=start=${a.toFixed(4)}:end=${b.toFixed(4)},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=start=${a.toFixed(4)}:end=${b.toFixed(4)},asetpts=PTS-STARTPTS,afade=t=in:d=0.006,afade=t=out:st=${Math.max(0, b - a - 0.006).toFixed(4)}:d=0.006[a${i}]`);
  const fc = parts.join(";") + ";" + keep.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${keep.length}:v=1:a=1[v][a]` + (height ? `;[v]scale=-2:${height}[vs]` : "");
  await f.writeFile("fc.txt", new TextEncoder().encode(fc));
  await f.exec(["-i", "in", "-filter_complex_script", "fc.txt", "-map", height ? "[vs]" : "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf),
    "-c:a", "aac", "-b:a", `${audioKbps}k`, ...(mono ? ["-ac", "1"] : []), "-movflags", "+faststart", "out.mp4"]);
  const data = await f.readFile("out.mp4");
  await f.deleteFile("out.mp4"); await f.deleteFile("in");
  return new Blob([data.buffer], { type: "video/mp4" });
}
