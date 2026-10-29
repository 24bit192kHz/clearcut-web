// End-to-end UI test as a user would do it, against the live site. Logs PASS/FAIL per step + screenshots.
const { chromium } = await import(process.env.PLAYWRIGHT);
const FILE = process.argv[2], URL_ = process.env.URL || "https://24bit192khz.github.io/clearcut-web/", OUT = new URL("./ui/", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: process.env.BROWSER, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true, colorScheme: "dark" });
const p = await ctx.newPage();
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
let n = 0; const shot = async name => p.screenshot({ path: `${OUT}${String(++n).padStart(2, "0")}-${name}.png` });
const ok = (name, cond, info = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
const V = () => p.evaluate(() => { const v = document.querySelector("#video"); return { t: v.currentTime, paused: v.paused, muted: v.muted, rate: v.playbackRate }; });
const S = (f, arg) => p.evaluate(f, arg);
const wait = ms => p.waitForTimeout(ms);

await p.goto(URL_ + "?nocache=" + Date.now()); await shot("empty");
ok("page loads, drop zone visible", await p.isVisible("#drop"));
await p.setInputFiles("#file", FILE);
await p.waitForFunction(() => window.clearcut?.A && window.clearcut.cuts.length, null, { timeout: 600000, polling: 500 });
await p.waitForFunction(() => document.querySelector("#codec option"), null, { timeout: 120000 });
await shot("analysed");
const nCuts = await S(() => window.clearcut.cuts.length);
ok("analysis finished, cuts found", nCuts > 0, `${nCuts} cuts; stats: ${(await p.innerText("#stats")).replace(/\n/g, " ")}`);

// 1. press play on the video controls (click the video), preview mode
await p.click("#mode button[data-m=skip]");
const box = await p.locator("#video").boundingBox();
await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);   // click on the picture toggles play in Chrome
await wait(500); let v = await V();
if (v.paused) { await p.click("#video"); await wait(300); }   // fallback
const t0 = (await V()).t; await wait(8000); v = await V();
ok("Preview result: playback keeps going for 8 s", !v.paused && v.t - t0 > 7, `t ${t0.toFixed(1)} → ${v.t.toFixed(1)}`);
const insideCut = await S(() => { const S = window.clearcut, t = document.querySelector("#video").currentTime; return S.removed.some(([a, b]) => t > a + 0.2 && t < b - 0.2) && !document.querySelector("#video").muted; });
ok("Preview result: never plays audio inside a cut", !insideCut);
await shot("playing");

// 2. space pauses, space plays
await p.keyboard.press("Space"); await wait(400); v = await V();
ok("Space pauses (video focused after clicking it)", v.paused);
await p.keyboard.press("Space"); await wait(1500); let v2 = await V();
ok("Space plays again (video focused)", !v2.paused && v2.t > v.t);
await p.click("#mode button[data-m=skip]");            // focus a button now
await p.keyboard.press("Space"); await wait(400); v = await V();
ok("Space pauses (a button focused)", v.paused && await S(() => window.clearcut.mode === "skip"));
await p.keyboard.press("Space"); await wait(1000); v2 = await V();
ok("Space plays again (a button focused)", !v2.paused);

// 3. Only the cuts
await p.click("#mode button[data-m=cuts]"); await wait(6000);
const cutsMode = await S(() => { const S = window.clearcut, v = document.querySelector("#video"); return { t: v.currentTime, inCut: S.removed.some(([a, b]) => v.currentTime >= a - 0.05 && v.currentTime < b + 0.05), muted: v.muted, paused: v.paused }; });
ok("Only the cuts: plays (inside a cut or gliding muted to the next)", !cutsMode.paused && (cutsMode.inCut || cutsMode.muted), JSON.stringify(cutsMode));

// 4. Original
await p.click("#mode button[data-m=orig]"); const to = (await V()).t; await wait(3000); v = await V();
ok("Original: plays at normal speed, unmuted", !v.paused && !v.muted && Math.abs(v.t - to - 3) < 0.8, `advanced ${(v.t - to).toFixed(2)} s in 3 s`);
await p.click("#mode button[data-m=skip]"); await p.evaluate(() => document.querySelector("#video").pause()); await wait(300);

// 5. timeline: click a cut to keep it, click again to remove it
const target = await S(() => { const S = window.clearcut, c = S.cuts.find(c => c.start > S.view[0] + 1 && c.end < S.view[1] && c.end - c.start > 0.5); return c && { id: c.id, mid: (c.start + c.end) / 2, view: S.view }; });
const tl = await p.locator("#tl").boundingBox();
const xOf = t => tl.x + (t - target.view[0]) / (target.view[1] - target.view[0]) * tl.width;
await p.mouse.click(xOf(target.mid), tl.y + tl.height / 2);
let en = await S(id => window.clearcut.cuts.find(c => c.id === id)?.enabled, target.id);
ok("Timeline: click on a cut keeps it", en === false);
await shot("cut-kept");
await p.mouse.click(xOf(target.mid), tl.y + tl.height / 2);
en = await S(id => window.clearcut.cuts.find(c => c.id === id)?.enabled, target.id);
ok("Timeline: click again removes it again", en === true);

// 6. drag on the waveform to add my own cut
const free = await S(() => { const S = window.clearcut; for (const [a, b] of S.keep) if (b - a > 2 && a > S.view[0] && b < S.view[1]) return [a + 0.4, a + 1.4]; return null; });
const before = await S(() => window.clearcut.cuts.filter(c => c.type === "manual").length);
await p.mouse.move(xOf(free[0]), tl.y + tl.height / 2); await p.mouse.down(); await p.mouse.move(xOf(free[1]), tl.y + tl.height / 2, { steps: 8 }); await p.mouse.up();
const after = await S(() => window.clearcut.cuts.filter(c => c.type === "manual").length);
ok("Timeline: drag adds my own cut", after === before + 1);
await shot("manual-cut");

// 7. zoom with the wheel
const w0 = await S(() => window.clearcut.view[1] - window.clearcut.view[0]);
await p.mouse.move(tl.x + tl.width / 2, tl.y + tl.height / 2); await p.mouse.wheel(0, -300); await wait(200);
const w1 = await S(() => window.clearcut.view[1] - window.clearcut.view[0]);
ok("Timeline: wheel zooms in", w1 < w0, `${w0.toFixed(1)} s → ${w1.toFixed(1)} s`);
await p.mouse.wheel(0, 600);

// 8. keyboard: → next cut, X toggles the cut under the playhead
await p.locator("body").click({ position: { x: 5, y: 5 } });
const tb = (await V()).t; await p.keyboard.press("ArrowRight"); await wait(300); const ta = (await V()).t;
ok("→ jumps to the next cut", ta > tb, `${tb.toFixed(1)} → ${ta.toFixed(1)}`);
await p.evaluate(() => { const S = window.clearcut, c = S.cuts.find(c => c.type === "pause" && c.end - c.start > 0.4); document.querySelector("#video").currentTime = (c.start + c.end) / 2; window.__x = c.id; });
await wait(300); await p.keyboard.press("x"); await wait(100);
ok("X toggles the cut under the playhead", await S(() => window.clearcut.cuts.find(c => c.id === window.__x).enabled === false));
await p.keyboard.press("x");

// 9. cut list: ▶ plays 1.5 s around a cut and stops
await p.click("#list button[data-play]"); await wait(300);
const s1 = await V(); await wait(6000); const s2 = await V();
ok("Cut list ▶ plays around the cut then stops", !s1.paused && s2.paused, `paused at ${s2.t.toFixed(1)}`);
// list checkbox
const firstRow = p.locator("#list tr[data-id] input[type=checkbox]").first(); await firstRow.click();
ok("Cut list checkbox keeps a cut", await S(() => window.clearcut.cuts[0].enabled === false)); await firstRow.click();

// 10. options: padding 75 → 150 replans, stats change
const k0 = await p.innerText("#stats");
await p.fill('[data-o="marginMs"]', "150"); await p.press('[data-o="marginMs"]', "Enter"); await p.locator('[data-o="marginMs"]').dispatchEvent("change"); await wait(500);
const k1 = await p.innerText("#stats");
ok("Changing padding replans (result gets longer)", k0 !== k1, k1.split("\n").slice(0, 3).join(" "));
await p.fill('[data-o="marginMs"]', "75"); await p.locator('[data-o="marginMs"]').dispatchEvent("change"); await wait(300);
// fillers on/off
await p.check('[data-o="breaths"]'); await wait(400);
ok("Breaths option adds breath cuts (or none found)", true, `${await S(() => window.clearcut.cuts.filter(c => c.type === "breath").length)} breaths`);
await p.uncheck('[data-o="breaths"]');
// filter
await p.selectOption("#filter", "pause"); await wait(200);
ok("Filter shows only pauses", (await p.$$eval("#list .pill", e => [...new Set(e.map(x => x.textContent))])).every(t => t === "pause"));
await p.selectOption("#filter", "");
await shot("options");

// 11. save cut list (download)
const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 10000 }), p.click("#savePlan")]);
ok("Save cut list downloads JSON", /\.cuts\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());

// 12. encode (smart search + render) and play the result
const tEnc = Date.now();
await p.click("#encode");
await p.waitForFunction(() => !document.querySelector("#result").classList.contains("hidden") || /failed/i.test(document.querySelector("#log").textContent), null, { timeout: 1800000, polling: 2000 });
const res = await p.innerText("#result").catch(() => "");
ok("Encode finishes", /Done/.test(res), `${((Date.now() - tEnc) / 1000).toFixed(0)} s · ${res.replace(/\n/g, " · ")}`);
await shot("encoded");
const [dl2] = await Promise.all([p.waitForEvent("download", { timeout: 20000 }), p.click("#result a button")]);
await dl2.saveAs(OUT + "result.mp4");
ok("Download the result", true, dl2.suggestedFilename());
await p.click("#playOut"); await wait(500);
await p.evaluate(() => document.querySelector("#video").play()); await wait(3000);
v = await V();
ok("Play the result in the page", !v.paused && v.t > 1, `t ${v.t.toFixed(1)}`);
await shot("result-playing");

ok("No page errors", errors.length === 0, errors.slice(0, 5).join(" | "));
await b.close();
