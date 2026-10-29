// Cut planning, ported from clearcut: jumpcutter's SpeechRegionPlanner (silences) and fillers.py detect()/plan()
// (fillers, stretched sounds). Runs on the main thread in a few ms, so every option change replans at once.

export const PRESETS = {
  tight:  { keepPause: 0.07, keepFiller: 0.08, keepProlong: 0.13, minProlong: 0.25 },   // clearcut TIGHT
  gentle: { keepPause: 0.10, keepFiller: 0.12, keepProlong: 0.18, minProlong: 0.30 },   // clearcut GENTLE
};

export const DEFAULTS = {
  // silences (jumpcutter defaults)
  pauses: true, vadThreshold: 0.5, strictVad: false, marginMs: 75, minSilenceMs: 180, keepSilenceMs: 0,
  // fillers.py defaults (strict detector)
  fillers: true, chained: true, stretches: true, fluxMax: 2.5, pitchMax: 1.5, minRunMs: 200, preset: "tight",
  // breaths
  breaths: false, breathMinMs: 150, breathMaxMs: 900,
};

// ---------------------------------------------------------------- silences (jumpcutter.SpeechRegionPlanner)
export function planSilences(probs, duration, fps, o) {
  const frames = Math.max(1, Math.round(duration * fps));
  const onset = o.vadThreshold * (o.strictVad ? 1.2 : 1.0), offset = onset * (o.strictVad ? 0.82 : 0.7);
  const mask = new Uint8Array(frames);
  let speaking = false;
  for (let i = 0; i < frames; i++) {
    const a = Math.min(probs.length, Math.floor(i / fps * 16000 / 512));
    const b = Math.min(probs.length, Math.max(a + 1, Math.floor((i + 1) / fps * 16000 / 512)));
    let p = 0; for (let k = a; k < b; k++) if (probs[k] > p) p = probs[k];
    speaking = speaking ? p >= offset : p >= onset;
    mask[i] = speaking ? 1 : 0;
  }
  const margin = Math.max(0, Math.round(o.marginMs * fps / 1000));
  const padded = new Uint8Array(mask);
  if (margin) for (let i = 0; i < frames; i++) if (mask[i]) padded.fill(1, Math.max(0, i - margin), Math.min(frames, i + margin + 1));
  const minSil = Math.max(1, Math.round(o.minSilenceMs * fps / 1000));
  for (let i = 0; i < frames;) {            // bridge only short internal gaps
    if (padded[i]) { i++; continue; }
    let j = i + 1; while (j < frames && !padded[j]) j++;
    if (i > 0 && j < frames && j - i < minSil) padded.fill(1, i, j);
    i = j;
  }
  const out = [], keep = o.keepSilenceMs / 1000;
  for (let i = 0; i < frames;) {
    if (padded[i]) { i++; continue; }
    let j = i + 1; while (j < frames && !padded[j]) j++;
    let s = i / fps, e = Math.min(duration, j / fps);
    if (keep > 0) {                          // keep part of each pause (split evenly around the cut)
      if (e - s <= keep) { i = j; continue; }
      const h = keep / 2; s = i === 0 ? s : s + h; e = j >= frames ? e : e - h;
    }
    if (e - s > 0.01) out.push({ type: "pause", start: s, end: e, why: i === 0 ? "silence at the start" : j >= frames ? "silence at the end" : "pause" });
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------- fillers (fillers.py detect + plan)
function median(arr) { const v = arr.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; }

export function detectRuns(F, o) {
  const { f0, flux, level } = F, n = f0.length;
  const fl = new Float32Array(n);                       // 100 ms moving average ("same" convolution)
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i - 5; k < i + 5; k++) s += flux[Math.min(n - 1, Math.max(0, k))] || 0; fl[i] = s / 10; }
  const voiced = i => Number.isFinite(f0[i]);
  const semi = new Float32Array(n); for (let i = 0; i < n; i++) semi[i] = voiced(i) ? 12 * Math.log2(f0[i] / 200) : NaN;
  let steady = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!voiced(i) || fl[i] >= o.fluxMax) continue;
    const win = []; for (let k = Math.max(0, i - 7); k <= Math.min(n - 1, i + 7); k++) win.push(semi[k]);
    const md = median(win);
    if (Math.abs(semi[i] - md) < o.pitchMax) steady[i] = 1;
  }
  const closed = new Uint8Array(steady);                // binary_closing(structure=4) restricted to voiced frames
  for (let i = 0; i < n;) {
    if (steady[i]) { i++; continue; }
    let j = i; while (j < n && !steady[j]) j++;
    if (i > 0 && j < n && j - i <= 3) for (let k = i; k < j; k++) if (voiced(k)) closed[k] = 1;
    i = j;
  }
  steady = closed;
  const runs = [], minLen = Math.round(o.minRunMs / 10);
  for (let i = 0; i < n;) {
    if (!steady[i]) { i++; continue; }
    let j = i; while (j < n && steady[j]) j++;
    if (j - i >= minLen) {
      const lv = []; for (let k = i; k < j; k++) lv.push(level[k]);
      runs.push({ start: i * 0.01, end: j * 0.01, dur: (j - i) * 0.01, level: median(lv) });
    }
    i = j;
  }
  return runs;
}

export function planFillers(runs, level, o) {
  const P = PRESETS[o.preset] || PRESETS.tight;
  const pause = (t, dir, lvl) => {          // quiet stretch 12 dB under the run, after <= 100 ms of ramp
    const i = Math.round(t / 0.01), q = j => j >= 0 && j < level.length && level[j] < lvl - 12;
    let k = 0; while (k < 10 && !q(i + dir * k)) k++;
    if (!q(i + dir * k)) return null;
    const near = i + dir * k; let far = near;
    while (q(far + dir) && Math.abs(far - near) < 100) far += dir;
    if (Math.abs(far - near) + 1 < 6) return null;
    return [near * 0.01 + (dir > 0 ? 0 : 0.01), far * 0.01 + (dir > 0 ? 0.01 : 0)];
  };
  const out = [];
  for (const c of runs) {
    const { start: s, end: e, dur: d } = c;
    // without word labels every steady run counts as a possible filler (fillers.py: empty cover = filler);
    // one-sided pauses are then only shortened, exactly as fillers.py does for unlabelled runs
    const L = pause(s - 0.01, -1, c.level), R = pause(e, +1, c.level);
    let ed = null;
    if (L && R && o.fillers) ed = { type: "filler", start: L[1] + Math.min(P.keepPause, L[0] - L[1]), end: R[1] - Math.min(P.keepPause, R[1] - R[0]), join: "fade", why: "uh/aaa between pauses" };
    else if (o.chained && d >= P.keepFiller + 0.1 && d < P.minProlong) ed = { type: "filler", start: s + P.keepFiller / 2, end: e - P.keepFiller / 2, join: "xfade", why: "uh/aaa between words (shortened)" };
    else if (o.stretches && d >= P.minProlong) ed = { type: "stretch", start: s + P.keepProlong * 0.55, end: e - P.keepProlong * 0.45, join: "xfade", why: `stretched sound ${(d * 1000) | 0} ms (shortened)` };
    if (ed && ed.end - ed.start >= 0.04) out.push(ed);
  }
  return out;
}

// ---------------------------------------------------------------- breaths: short unvoiced noisy bursts next to a pause
export function planBreaths(F, silences, o) {
  const { f0, level, flat } = F, n = f0.length, out = [];
  const lv = Array.from(level).filter((_, i) => Number.isFinite(f0[i]));
  const speechLvl = median(lv); if (!Number.isFinite(speechLvl)) return out;
  const isB = i => !Number.isFinite(f0[i]) && level[i] > speechLvl - 35 && level[i] < speechLvl - 6 && flat[i] > 0.25;
  const nearPause = (s, e) => silences.some(x => x.end >= s - 0.12 && x.start <= e + 0.12);
  for (let i = 0; i < n;) {
    if (!isB(i)) { i++; continue; }
    let j = i; while (j < n && isB(j)) j++;
    const s = i * 0.01, e = j * 0.01, d = e - s;
    if (d * 1000 >= o.breathMinMs && d * 1000 <= o.breathMaxMs && nearPause(s, e)) out.push({ type: "breath", start: s, end: e, join: "fade", why: `breath ${(d * 1000) | 0} ms` });
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------- everything together
export function buildPlan(A, duration, fps, o) {
  const pauses = o.pauses ? planSilences(A.probs, duration, fps, o) : [];
  const runs = detectRuns(A, o);
  const fill = planFillers(runs, A.level, o);
  const breaths = o.breaths ? planBreaths(A, planSilences(A.probs, duration, fps, o), o) : [];
  const all = [...pauses, ...fill, ...breaths].sort((a, b) => a.start - b.start);
  return all.map((r, i) => ({ id: i, enabled: true, ...r, start: +r.start.toFixed(3), end: +r.end.toFixed(3) }));
}

// kept intervals (source seconds) from the enabled cuts
export function keptIntervals(cuts, duration) {
  const rem = cuts.filter(c => c.enabled).map(c => [Math.max(0, c.start), Math.min(duration, c.end)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of rem) { if (merged.length && a <= merged.at(-1)[1] + 1e-4) merged.at(-1)[1] = Math.max(merged.at(-1)[1], b); else merged.push([a, b]); }
  const keep = []; let t = 0;
  for (const [a, b] of merged) { if (a - t > 0.02) keep.push([t, a]); t = b; }
  if (duration - t > 0.02) keep.push([t, duration]);
  return { keep, removed: merged };
}
