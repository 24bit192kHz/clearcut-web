// headless test: load a file, wait for the analysis, dump the plan; optional: search + encode
// usage: PLAYWRIGHT=/path/to/playwright/index.mjs BROWSER=/path/to/chrome node test/run.mjs FILE [encode]
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const OUT = new URL(".", import.meta.url).pathname, URL_ = process.env.URL || "http://127.0.0.1:8791/";
const [file, doEncode] = [process.argv[2], process.argv[3] === "encode"];
const browser = await chromium.launch({ executablePath: process.env.BROWSER || undefined, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--enable-features=VaapiVideoEncoder,VaapiVideoDecoder"] });
const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
page.on("console", m => console.log("[page]", m.type(), m.text()));
page.on("pageerror", e => console.log("[pageerror]", e.message));
await page.goto(URL_);
const t0 = Date.now();
await page.setInputFiles("#file", file);
await page.waitForFunction(() => window.clearcut?.A && window.clearcut.cuts.length, null, { timeout: 600000, polling: 1000 });
const r = await page.evaluate(() => { const S = window.clearcut; return { duration: S.duration, fps: S.fps, demux: !!S.demux, demuxErr: String(S.demuxErr || ""), via: S.audio.via,
  cuts: S.cuts.map(c => [c.type, +c.start.toFixed(3), +c.end.toFixed(3), c.why]), keep: S.keep }; });
console.log(`analysed in ${((Date.now() - t0) / 1000).toFixed(1)} s; fps ${r.fps}; demux ${r.demux} ${r.demuxErr}; audio via ${r.via}`);
const by = {}; for (const [t, a, b] of r.cuts) by[t] = [(by[t]?.[0] || 0) + 1, (by[t]?.[1] || 0) + b - a];
console.log("cuts:", JSON.stringify(by));
(await import("fs")).writeFileSync(OUT + "plan.json", JSON.stringify(r));
await page.screenshot({ path: OUT + "shot.png", fullPage: true });
if (doEncode) {
  await page.waitForFunction(() => document.querySelector("#codec option"), null, { timeout: 60000 });
  console.log("codecs:", await page.$$eval("#codec option", o => o.map(x => x.value + ":" + x.textContent).join(" | ")));
  const t1 = Date.now();
  await page.click("#encode");
  await page.waitForFunction(() => !document.querySelector("#result").classList.contains("hidden") || /failed/.test(document.querySelector("#log").textContent), null, { timeout: 900000, polling: 2000 });
  console.log("encode:", ((Date.now() - t1) / 1000).toFixed(1), "s |", await page.$eval("#result", e => e.innerText), "|", await page.$eval("#log", e => e.textContent));
  console.log("search table:", await page.$eval("#searchTable", e => e.innerText));
  const href = await page.$eval("#result a", a => a.href).catch(() => null);
  if (href) { const b64 = await page.evaluate(async u => { const b = await (await fetch(u)).arrayBuffer(); let s = ""; const v = new Uint8Array(b); for (let i = 0; i < v.length; i += 32768) s += String.fromCharCode(...v.subarray(i, i + 32768)); return btoa(s); }, href);
    (await import("fs")).writeFileSync(OUT + "out.mp4", Buffer.from(b64, "base64")); console.log("saved test/out.mp4"); }
  await page.screenshot({ path: OUT + "shot2.png", fullPage: true });
}
await browser.close();
