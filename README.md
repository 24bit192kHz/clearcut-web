# clearcut (browser)

Cut pauses, “uh / aaa” fillers, stretched sounds and breaths out of a video, check every cut on a timeline,
then encode it at the smallest size that still looks right. Everything runs in the browser tab: the video
never leaves your computer. It is a static site, so it runs on GitHub Pages as is.

## What it does

1. **Analysis** (two Web Workers, about 1 s per minute of video)
   - **Pauses:** Silero VAD v6 (the same model and version clearcut/jumpcutter use), one probability per
     32 ms, hysteresis 0.5 / 0.35, 75 ms padding around speech, pauses shorter than 180 ms kept. On a lecture
     test clip it reproduces the Python planner to the frame (99.5 % of the cut time, 98.7 % precision).
   - **Fillers and stretched sounds:** clearcut's `fillers.py` detector: MFCC c1–c12 frame-to-frame flux
     (Hamming 25 ms, 40 mel bands 80–7600 Hz, 100 ms smoothing) below 2.5, pitch within 1.5 semitones of its
     150 ms median, at least 200 ms. A filler with a pause on both sides is removed (70 ms of each pause kept);
     one between words is shortened to 80 ms; a stretched sound is shortened to 130 ms (the "tight" plan;
     "gentle" = 100/120/180 ms).
   - **Breaths** (optional): unvoiced, spectrally flat bursts next to a pause.
2. **Timeline:** waveform, every cut coloured by type. Click a cut to keep it, drag on the waveform to add
   your own, zoom with the wheel. Every option replans instantly.
3. **Preview before encoding:** the player skips the cuts live (*Preview result*), plays the untouched
   original, or plays **only the cuts**, so you can hear everything that would be removed.
4. **Encode**
   - MP4/MOV: WebCodecs (hardware where the browser offers it) → AV1 / HEVC / H.264 + Opus or AAC, muxed with
     mp4-muxer. Audio is cut sample-exactly with 6 ms raised-cosine fades; video frames follow the audio by
     error diffusion (jumpcutter), so picture and sound never drift more than half a frame. The MP4 edit list
     is applied, so B-frame files stay in sync.
   - MKV, WebM, TS, AVI, …: the video stream is first repackaged into MP4 without re-encoding (ffmpeg.wasm), then
     the same fast path. If the browser cannot decode the codec at all, ffmpeg.wasm does the whole cut with
     exact `trim`/`atrim` (single-threaded, slow).
5. **Smart size (shrinkvid in the browser):** three 2 s windows spread over the cut video are encoded at a
   quantizer ladder, decoded back and scored with full-resolution luma SSIM against the source frames. *Smart*
   picks the knee of the size/quality frontier like shrinkvid's Smart mode; *high / balanced / small* pick the
   smallest setting above a floor. VMAF is not available in the browser; the SSIM floors were calibrated with
   libvmaf on a lecture screen recording (SSIM 0.997 ≈ VMAF 96).

## Limits

- The whole file is read into memory (fine for lectures up to an hour or two on a normal laptop).
- No denoiser (clearcut uses DeepFilterNet3) and no Whisper word check: unlabelled fillers with a pause on
  only one side are shortened, never removed, exactly as clearcut does for runs Whisper did not label.
- Hardware encoders depend on the browser and GPU; Chrome/Edge/Brave have the widest WebCodecs support.

## Run locally

Any static server, e.g. `python3 -m http.server`, then open the page. Test harness: `test/run.mjs`
(Playwright, headless).

## Credits

Silero VAD (MIT) · ONNX Runtime Web (MIT) · mp4box.js (BSD-3) · mp4-muxer (MIT) · ffmpeg.wasm (MIT; ffmpeg
core LGPL/GPL). Licences in `vendor/`.
