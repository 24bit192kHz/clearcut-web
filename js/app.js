import { DEFAULTS, buildPlan, keptIntervals } from "./plan.js";
import { decodeAudio, mono16k, spliceAudio, normalize, demuxMp4, remuxToMp4, ffmpeg, renderWithFfmpeg } from "./media.js";
import { CODECS, QUALITY, availableCodecs, smartSize, render } from "./encode.js";

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const TYPES = { pause: "pause", filler: "uh / aaa", stretch: "stretched sound", breath: "breath", manual: "your cut" };
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const color = t => css(`--c-${t}`);
const fmt = (s, ms = false) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + ":" + (ms ? x.toFixed(2).padStart(5, "0") : String(Math.floor(x)).padStart(2, "0")); };
const mb = b => b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB";

const S = { file: null, duration: 0, fps: 30, audio: null, pcm: null, A: null, cuts: [], removed: [], keep: [], opts: { ...DEFAULTS },
  mode: "skip", view: [0, 60], peaks: null, demux: null, demuxErr: null, choice: null, playable: true };
let saved; try { saved = JSON.parse(localStorage.getItem("clearcut-opts") || "null"); } catch { }
if (saved) Object.assign(S.opts, saved);

// ---------------------------------------------------------------- options panel
for (const el of $$("[data-o]")) {
  const k = el.dataset.o, v = S.opts[k];
  if (el.type === "checkbox") el.checked = !!v; else el.value = v;
  el.addEventListener("change", () => {
    S.opts[k] = el.type === "checkbox" ? el.checked : el.tagName === "SELECT" ? el.value : +el.value;
    try { localStorage.setItem("clearcut-opts", JSON.stringify(S.opts)); } catch { }
    if (S.A) replan(true);
  });
}
$("#legend").innerHTML = Object.entries(TYPES).map(([t, n]) => `<span><i class="sw" style="background:${color(t)}"></i>${n}</span>`).join("") + `<span><i class="sw" style="border:1px dashed var(--mut)"></i>kept (click to remove again)</span>`;
$("#filter").innerHTML += Object.entries(TYPES).map(([t, n]) => `<option value="${t}">${n}</option>`).join("");

// ---------------------------------------------------------------- progress / log
const prog = (text, f) => { $("#progress").classList.toggle("hidden", f == null); $("#ptext").textContent = text; $("#pbar").style.width = `${Math.round((f || 0) * 100)}%`; };
const log = m => { const L = $("#log"); L.classList.remove("hidden"); L.textContent += m + "\n"; L.scrollTop = L.scrollHeight; };

// ---------------------------------------------------------------- loading
const drop = $("#drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); });
$("#file").addEventListener("change", e => e.target.files[0] && load(e.target.files[0]));

async function load(file) {
  S.file = file; S.cuts = []; S.A = null; S.choice = null; S.demux = null; S.demuxErr = null;
  $("#work").classList.remove("hidden"); drop.classList.add("small"); drop.querySelector("b").textContent = `📄 ${file.name} (${mb(file.size)}) — drop or click to open another`;
  $("#result").classList.add("hidden"); $("#searchTable").classList.add("hidden");
  const video = $("#video");
  video.src = URL.createObjectURL(file);
  S.playable = await new Promise(r => { video.onloadedmetadata = () => r(true); video.onerror = () => r(false); });
  if (!S.playable) {   // not playable here: make a light preview copy with ffmpeg.wasm (the encode still uses the original)
    prog("This format does not play in the browser: making a preview copy with ffmpeg.wasm…", 0.02);
    const f = await ffmpeg(log); await f.writeFile("src", new Uint8Array(await file.arrayBuffer()));
    f.on("progress", ({ progress }) => prog("Making a preview copy with ffmpeg.wasm…", progress));
    await f.exec(["-i", "src", "-vf", "scale=-2:min(480\\,ih)", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-c:a", "aac", "-b:a", "96k", "prev.mp4"]);
    video.src = URL.createObjectURL(new Blob([(await f.readFile("prev.mp4")).buffer], { type: "video/mp4" }));
    await new Promise(r => { video.onloadedmetadata = r; });
  }
  S.duration = video.duration;
  prog("Decoding audio…", 0.03);
  S.audio = await decodeAudio(file, 48000, log);
  S.pcm = mono16k(S.audio);
  S.duration = S.audio.channels[0].length / S.audio.sampleRate;
  S.peaks = peaks(S.pcm);
  S.view = [0, Math.min(S.duration, 60)];
  draw();
  // demux in parallel with the analysis (MP4/MOV only; anything else is rendered with ffmpeg.wasm)
  demuxMp4(file).catch(async () => {   // not MP4/MOV: repackage (no re-encode) so the fast WebCodecs path still works
    log("not an MP4: repackaging the video stream with ffmpeg.wasm (no re-encode)…");
    return demuxMp4(await remuxToMp4(file, log));
  }).then(async d => {
    const t = d.video.track, ok = (await VideoDecoder.isConfigSupported({ codec: t.codec, codedWidth: t.video.width, codedHeight: t.video.height, description: d.video.description }).catch(() => ({}))).supported;
    if (!ok) throw new Error(`this browser cannot decode ${t.codec}`);
    S.demux = d; S.fps = fpsOf(d); setupCodecs();
  }).catch(e => { S.demuxErr = e; log("using ffmpeg.wasm for the encode: " + e.message); setupCodecs(); });
  await analyse();
}
const fpsOf = d => { const t = d.video.track; const f = t.nb_samples / (t.movie_duration / t.movie_timescale || t.duration / t.timescale); return Math.abs(f - Math.round(f)) < 0.05 ? Math.round(f) : +f.toFixed(3); };

function analyse() {
  return new Promise((resolve, reject) => {
    const got = {}; let pv = 0, pf = 0;
    const show = () => prog(`Finding speech, pauses and fillers… ${Math.round((pv + pf) * 50)}%`, (pv + pf) / 2);
    const start = job => {
      const w = new Worker(new URL("./analysis-worker.js", import.meta.url), { type: "module" });
      w.onmessage = e => {
        const d = e.data;
        if (d.type === "progress") { if (job === "vad") pv = d.done; else pf = d.done; show(); return; }
        if (d.type === "error") { prog("Analysis failed: " + d.message, 0); reject(new Error(d.message)); return; }
        Object.assign(got, d); got[job] = true; w.terminate();
        if (job === "vad") pv = 1; else pf = 1; show();
        if (got.vad && got.features) {
          S.A = { probs: got.probs, f0: got.f0, flux: got.flux, flat: got.flat, level: got.level };
          prog("", null); replan(false); resolve();
        }
      };
      w.postMessage({ pcm: S.pcm.slice(), job });
    };
    start("vad"); start("features"); show();
  });
}

// ---------------------------------------------------------------- plan
function replan(keepManual) {
  const manual = keepManual ? S.cuts.filter(c => c.type === "manual") : [];
  const off = new Set(S.cuts.filter(c => !c.enabled).map(c => `${c.type}@${c.start.toFixed(2)}`));
  S.cuts = [...buildPlan(S.A, S.duration, S.fps, S.opts), ...manual].sort((a, b) => a.start - b.start).map((c, i) => ({ ...c, id: i, enabled: !off.has(`${c.type}@${c.start.toFixed(2)}`) && c.enabled !== false }));
  update();
}
function update() {
  const { keep, removed } = keptIntervals(S.cuts, S.duration);
  S.keep = keep; S.removed = removed; S.choice = null; $("#searchTable").classList.add("hidden");
  const kept = keep.reduce((s, [a, b]) => s + b - a, 0), by = {};
  for (const c of S.cuts) if (c.enabled) by[c.type] = (by[c.type] || 0) + (c.end - c.start);
  $("#stats").innerHTML = `<div><b>${fmt(S.duration)}</b><span>original</span></div><div><b style="color:var(--ok)">${fmt(kept)}</b><span>after cutting (−${Math.round((1 - kept / S.duration) * 100)}%)</span></div>` +
    Object.entries(by).map(([t, s]) => `<div><b style="color:${color(t)}">${s < 60 ? s.toFixed(1) + " s" : fmt(s)}</b><span>${TYPES[t]} · ${S.cuts.filter(c => c.enabled && c.type === t).length}</span></div>`).join("");
  list(); draw();
}

// ---------------------------------------------------------------- cut list
function list() {
  const f = $("#filter").value, rows = S.cuts.filter(c => !f || c.type === f);
  const shown = rows.slice(0, 1500);
  $("#list").innerHTML = `<table><tr><th></th><th>at</th><th>length</th><th>type</th><th>why</th><th></th></tr>` + shown.map(c =>
    `<tr data-id="${c.id}" class="${c.enabled ? "" : "off"}"><td><input type="checkbox" ${c.enabled ? "checked" : ""} title="remove this"></td><td>${fmt(c.start, true)}</td><td>${((c.end - c.start) * 1000 | 0)} ms</td>` +
    `<td><span class="pill" style="background:${color(c.type)}">${TYPES[c.type]}</span></td><td>${c.why || ""}</td><td><button data-play="${c.id}" title="play 1.5 s before to 1.5 s after, with the cut">▶</button></td></tr>`).join("") +
    (rows.length > shown.length ? `<tr><td colspan="6">… ${rows.length - shown.length} more (use the timeline)</td></tr>` : "") + `</table>`;
}
$("#filter").addEventListener("change", list);
$("#list").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-id]"); if (!tr) return;
  const c = S.cuts[+tr.dataset.id];
  if (e.target.dataset.play != null) { playAround(c); return; }
  if (e.target.type === "checkbox") { c.enabled = e.target.checked; update(); return; }
  seek(c.start - 1);
});
$("#allOn").onclick = () => { const f = $("#filter").value; S.cuts.forEach(c => { if (!f || c.type === f) c.enabled = true; }); update(); };
$("#allOff").onclick = () => { const f = $("#filter").value; S.cuts.forEach(c => { if (!f || c.type === f) c.enabled = false; }); update(); };

// ---------------------------------------------------------------- player: preview the cut result without encoding
const video = $("#video");
for (const b of $$("#mode button")) b.onclick = () => { S.mode = b.dataset.m; $$("#mode button").forEach(x => x.classList.toggle("on", x === b)); };
const findRemoved = t => { let lo = 0, hi = S.removed.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1, [a, b] = S.removed[m]; if (t < a) hi = m - 1; else if (t >= b) lo = m + 1; else return m; } return -lo - 1; };
let stopAt = null;
function tick() {
  if (!video.paused && S.removed.length) {
    const t = video.currentTime, i = findRemoved(t + 0.015);
    if (S.mode === "skip" && i >= 0) video.currentTime = S.removed[i][1] + 0.002;
    if (S.mode === "cuts") {
      if (i < 0) { const n = -i - 1; if (n < S.removed.length) video.currentTime = S.removed[n][0]; else video.pause(); }
    }
    if (stopAt != null && t >= stopAt) { video.pause(); stopAt = null; }
  }
  if (S.peaks) drawPlayhead();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
function seek(t) { video.currentTime = Math.max(0, Math.min(S.duration, t)); const w = S.view[1] - S.view[0]; if (t < S.view[0] || t > S.view[1]) setView(t - w * 0.3); }
function playAround(c) { seek(c.start - 1.5); stopAt = c.end + 1.5; video.play(); }

// ---------------------------------------------------------------- timeline
const tl = $("#tl"), mini = $("#mini");
function peaks(pcm) { const n = Math.ceil(pcm.length / 160), p = new Float32Array(n); for (let i = 0; i < n; i++) { let m = 0; for (let k = i * 160; k < Math.min(pcm.length, i * 160 + 160); k++) { const v = Math.abs(pcm[k]); if (v > m) m = v; } p[i] = m; } return p; }
function setView(a, w = S.view[1] - S.view[0]) { w = Math.max(2, Math.min(S.duration, w)); a = Math.max(0, Math.min(S.duration - w, a)); S.view = [a, a + w]; draw(); }
const X = t => (t - S.view[0]) / (S.view[1] - S.view[0]) * tl.width, T = x => S.view[0] + x / tl.width * (S.view[1] - S.view[0]);
function fit(c) { const r = c.getBoundingClientRect(), d = devicePixelRatio || 1; if (c.width !== Math.round(r.width * d)) { c.width = Math.round(r.width * d); c.height = Math.round(r.height * d); } }
let base = null;
function draw() {
  if (!S.peaks) return;
  fit(tl); fit(mini);
  const g = tl.getContext("2d"), W = tl.width, H = tl.height, d = devicePixelRatio || 1;
  g.clearRect(0, 0, W, H);
  // time grid
  const span = S.view[1] - S.view[0], step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(s => span / s < 12) || 1200;
  g.fillStyle = css("--mut"); g.font = `${11 * d}px system-ui`; g.strokeStyle = css("--line"); g.lineWidth = 1;
  for (let t = Math.ceil(S.view[0] / step) * step; t < S.view[1]; t += step) { const x = X(t); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(fmt(t, step < 1), x + 3 * d, 12 * d); }
  // cuts
  for (const c of S.cuts) {
    if (c.end < S.view[0] || c.start > S.view[1]) continue;
    const x0 = X(c.start), x1 = Math.max(x0 + 2, X(c.end));
    g.globalAlpha = c.enabled ? 0.35 : 0.08; g.fillStyle = color(c.type); g.fillRect(x0, 16 * d, x1 - x0, H - 16 * d);
    g.globalAlpha = 1;
    if (!c.enabled) { g.setLineDash([4 * d, 3 * d]); g.strokeStyle = color(c.type); g.strokeRect(x0, 16 * d, x1 - x0, H - 17 * d); g.setLineDash([]); }
    else { g.fillStyle = color(c.type); g.fillRect(x0, H - 5 * d, x1 - x0, 5 * d); }
  }
  // waveform
  const mid = (H + 16 * d) / 2, amp = (H - 20 * d) / 2, i0 = S.view[0] * 100, per = span * 100 / W;
  g.fillStyle = css("--fg"); g.globalAlpha = 0.8;
  for (let x = 0; x < W; x++) {
    let m = 0; const a = Math.floor(i0 + x * per), b = Math.max(a + 1, Math.floor(i0 + (x + 1) * per));
    for (let k = a; k < b && k < S.peaks.length; k++) if (S.peaks[k] > m) m = S.peaks[k];
    const h = Math.max(1, Math.sqrt(m) * amp); g.fillRect(x, mid - h, 1, 2 * h);
  }
  g.globalAlpha = 1;
  if (drag?.mode === "add" && drag.moved) { const [a, b] = [drag.t0, drag.t1].sort((p, q) => p - q); g.fillStyle = color("manual"); g.globalAlpha = 0.4; g.fillRect(X(a), 16 * d, X(b) - X(a), H); g.globalAlpha = 1; }
  base = g.getImageData(0, 0, W, H);
  // minimap
  const m = mini.getContext("2d"), MW = mini.width, MH = mini.height;
  m.clearRect(0, 0, MW, MH);
  for (const c of S.cuts) if (c.enabled) { m.fillStyle = color(c.type); m.fillRect(c.start / S.duration * MW, 0, Math.max(1, (c.end - c.start) / S.duration * MW), MH); }
  m.strokeStyle = css("--acc"); m.lineWidth = 2 * d; m.strokeRect(S.view[0] / S.duration * MW, 1, Math.max(4, span / S.duration * MW), MH - 2);
  drawPlayhead(true);
}
let lastPx = -1;
function drawPlayhead(force) {
  const x = Math.round(X(video.currentTime));
  if (!force && x === lastPx) return; lastPx = x;
  const g = tl.getContext("2d"); if (base) g.putImageData(base, 0, 0);
  g.fillStyle = css("--acc"); g.fillRect(x - 1, 0, 2 * (devicePixelRatio || 1), tl.height);
  if (!video.paused && (x < 0 || x > tl.width)) setView(video.currentTime - (S.view[1] - S.view[0]) * 0.1);
}
let drag = null;
const evT = e => { const r = tl.getBoundingClientRect(); return T((e.clientX - r.left) * tl.width / r.width); };
tl.addEventListener("pointerdown", e => { tl.setPointerCapture(e.pointerId); const t = evT(e); drag = { mode: "add", t0: t, t1: t, moved: false, x: e.clientX }; });
tl.addEventListener("pointermove", e => { if (!drag) return; drag.t1 = evT(e); if (Math.abs(e.clientX - drag.x) > 5) { drag.moved = true; draw(); } });
tl.addEventListener("pointerup", e => {
  const d = drag; drag = null; if (!d) return;
  if (d.moved) { const [a, b] = [d.t0, d.t1].sort((p, q) => p - q); if (b - a > 0.05) { S.cuts.push({ id: S.cuts.length, type: "manual", start: a, end: b, enabled: true, why: "added by you" }); S.cuts.sort((p, q) => p.start - q.start).forEach((c, i) => c.id = i); update(); } else draw(); return; }
  const t = d.t0, hit = S.cuts.find(c => t >= c.start && t <= c.end) || S.cuts.find(c => Math.abs(X(c.start) - X(t)) < 3 || Math.abs(X(c.end) - X(t)) < 3);
  if (hit) { hit.enabled = !hit.enabled; update(); } else seek(t);
});
tl.addEventListener("wheel", e => {
  e.preventDefault();
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { setView(S.view[0] + (e.deltaX || e.deltaY) / tl.clientWidth * (S.view[1] - S.view[0])); return; }
  const t = evT(e), w = (S.view[1] - S.view[0]) * (e.deltaY > 0 ? 1.25 : 0.8), f = (t - S.view[0]) / (S.view[1] - S.view[0]);
  setView(t - f * w, w);
}, { passive: false });
let mdrag = false;
const miniT = e => { const r = mini.getBoundingClientRect(); return (e.clientX - r.left) / r.width * S.duration; };
mini.addEventListener("pointerdown", e => { mdrag = true; mini.setPointerCapture(e.pointerId); const w = S.view[1] - S.view[0]; setView(miniT(e) - w / 2); seek(miniT(e)); });
mini.addEventListener("pointermove", e => { if (mdrag) { const w = S.view[1] - S.view[0]; setView(miniT(e) - w / 2); } });
mini.addEventListener("pointerup", () => { mdrag = false; });
addEventListener("resize", draw);
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { draw(); update(); });
addEventListener("keydown", e => {
  if (!S.peaks || ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  const t = video.currentTime;
  if (e.key === " ") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); const c = S.cuts.find(c => c.start > t + 0.05); if (c) seek(c.start - 1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); const c = [...S.cuts].reverse().find(c => c.start < t - 1.1); if (c) seek(c.start - 1); }
  else if (e.key.toLowerCase() === "x") { const c = S.cuts.find(c => t >= c.start - 0.05 && t <= c.end + 0.05); if (c) { c.enabled = !c.enabled; update(); } }
});

// ---------------------------------------------------------------- encode
async function setupCodecs() {
  const sel = $("#codec");
  if (!S.demux) { sel.innerHTML = `<option value="ffmpeg">H.264 with ffmpeg.wasm (this format: slow, single-threaded)</option>`; return; }
  const t = S.demux.video.track, have = await availableCodecs(t.video.width, t.video.height, S.fps);
  const order = ["av1", "hevc", "avc"].filter(k => have[k]);
  S.have = have;
  sel.innerHTML = (order.length > 1 ? `<option value="auto">Auto: the smallest file (tries ${order.map(k => CODECS[k].label).join(", ")})</option>` : "") +
    order.map(k => `<option value="${k}">${CODECS[k].label} · ${have[k].hw ? "GPU" : "CPU"}${k === "avc" ? " · plays everywhere" : ""}</option>`).join("") +
    `<option value="ffmpeg">H.264 with ffmpeg.wasm (slow)</option>`;
  sel.value = order.length > 1 ? "auto" : order[0] || "ffmpeg";
  const gpu = order.filter(k => have[k].hw).map(k => CODECS[k].label);
  $("#gpu").innerHTML = gpu.length ? `⚡ Your GPU encodes ${gpu.join(", ")} here.`
    : `This browser offers no GPU video encoder on this computer (on Linux with an NVIDIA card, browsers can only <i>decode</i> on the GPU), so encoding runs on the CPU, ${Math.min(3, Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 4)))} encoders in parallel. Chrome/Edge/Brave on Windows or macOS, or Linux with an Intel/AMD GPU, use the GPU automatically.`;
}
$("#codec").addEventListener("change", () => { S.choice = null; $("#searchTable").classList.add("hidden"); });
$("#quality").addEventListener("change", () => { S.choice = null; });
$("#downscale").addEventListener("change", () => { S.choice = null; });

async function search() {
  const pickKind = $("#codec").value;
  if (pickKind === "ffmpeg" || !S.demux) { log("Smart size needs a WebCodecs encoder; ffmpeg.wasm uses CRF 26."); return null; }
  const kinds = pickKind === "auto" ? ["av1", "hevc", "avc"].filter(k => S.have?.[k]) : [pickKind];
  const target = QUALITY[$("#quality").value], tb = $("#searchTable"), kept = S.keep.reduce((s, [a, b]) => s + b - a, 0);
  tb.classList.remove("hidden"); tb.innerHTML = `<tr><th>codec</th><th>setting</th><th>height</th><th>SSIM mean</th><th>p5</th><th>est. video size</th></tr>`;
  let res = null;
  for (const kind of kinds) {
    prog(`Encoding samples with ${CODECS[kind].label} at several settings and comparing them with the original…`, 0.1);
    const r = await smartSize(S.demux.video, S.keep, kind, target, { allowDownscale: $("#downscale").checked, fps: S.fps,
      onProgress: x => { tb.insertAdjacentHTML("beforeend", `<tr data-k="${kind}" data-q="${x.q}" data-h="${x.scaleH}"><td>${CODECS[kind].label}</td><td>${x.q}</td><td>${x.scaleH}p</td><td>${x.mean.toFixed(4)}</td><td>${x.p5.toFixed(4)}</td><td>${mb(x.bytesPerSec * kept)}</td></tr>`); } });
    r.kind = kind;
    if (!res || (r.belowFloor === res.belowFloor ? r.bytesPerSec < res.bytesPerSec : !r.belowFloor)) res = r;
  }
  prog("", null);
  for (const tr of tb.querySelectorAll("tr[data-q]")) tr.classList.toggle("pick", tr.dataset.k === res.kind && tr.dataset.q === String(res.q) && +tr.dataset.h === res.scaleH);
  tb.insertAdjacentHTML("beforeend", `<tr><td colspan="6" style="text-align:left">Picked ${CODECS[res.kind].label}, ${res.vbr ? "bitrate" : res.mode === "quantizer" ? "quantizer" : "Mbit/s"} ${res.q} at ${res.scaleH}p (${res.hw ? "GPU" : "CPU"}), about ${mb(res.bytesPerSec * kept)} of video.${res.belowFloor ? " The source is already very efficiently encoded: nothing smaller reached the quality target, so its own bitrate is kept and the file only shrinks by the cut time." : ""}</td></tr>`);
  S.choice = { kind: res.kind, q: res.q, scaleH: res.scaleH, vbr: res.vbr, from: pickKind };
  return S.choice;
}
$("#search").onclick = () => search().catch(e => { prog("", null); log("Size search failed: " + e.message); });

$("#encode").onclick = async () => {
  const btn = $("#encode"); btn.disabled = true; $("#result").classList.add("hidden");
  try {
    const t0 = performance.now(), kind = $("#codec").value, mono = $("#mono").checked, akbps = +$("#akbps").value;
    let blob, info = "";
    if (kind === "ffmpeg" || !S.demux) {
      prog("Encoding with ffmpeg.wasm…", 0.01);
      blob = await renderWithFfmpeg(S.file, S.keep, { crf: 26, audioKbps: akbps, mono }, log, p => prog("Encoding with ffmpeg.wasm…", p));
      info = "H.264 · ffmpeg.wasm";
    } else {
      const choice = S.choice && (S.choice.from === kind || S.choice.kind === kind) ? S.choice : await search();
      prog("Cutting the audio…", 0.01);
      const a = spliceAudio(S.audio, S.keep, { mono });
      if ($("#norm").checked) { const n = normalize(a); log(`loudness ${n.loudness.toFixed(1)} LUFS → gain ${n.gainDb.toFixed(1)} dB`); }
      const r = await render(S.demux.video, a, S.keep, choice, { fps: S.fps, audioKbps: akbps, onProgress: p => prog("Encoding the video…", p) });
      blob = r.blob; info = `${r.width}×${r.height} · ${r.codec} (${r.hw ? "hardware" : "software"}) · ${r.audio || "no"} audio · ${r.frames} frames`;
    }
    prog("", null);
    const name = S.file.name.replace(/\.[^.]+$/, "") + "-clearcut.mp4", url = URL.createObjectURL(blob), kept = S.keep.reduce((s, [a, b]) => s + b - a, 0);
    $("#result").classList.remove("hidden");
    $("#result").innerHTML = `<b>Done in ${((performance.now() - t0) / 1000).toFixed(0)} s.</b> ${fmt(S.duration)} → ${fmt(kept)}, ${mb(S.file.size)} → <b>${mb(blob.size)}</b> (${Math.round(blob.size / S.file.size * 100)}%)<br><span class="hint">${info}</span><br>` +
      `<a class="primary" href="${url}" download="${name}"><button class="primary">Download ${name}</button></a> <button id="playOut">Play the result</button>`;
    $("#playOut").onclick = () => { $$("#mode button")[1].click(); video.src = url; };
  } catch (e) { prog("", null); log("Encode failed: " + (e.stack || e)); }
  btn.disabled = false;
};

$("#savePlan").onclick = () => {
  const data = { file: S.file?.name, duration: S.duration, options: S.opts, cuts: S.cuts.map(({ type, start, end, enabled, why }) => ({ type, start, end, enabled, why })), keep: S.keep };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  a.download = (S.file?.name || "video").replace(/\.[^.]+$/, "") + ".cuts.json"; a.click();
};
$("#loadPlanBtn").onclick = () => $("#loadPlan").click();
$("#loadPlan").addEventListener("change", async e => {
  const d = JSON.parse(await e.target.files[0].text());
  if (d.options) Object.assign(S.opts, d.options);
  S.cuts = d.cuts.map((c, i) => ({ ...c, id: i })); update();
});
window.clearcut = S;   // for tests and the console
