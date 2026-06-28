# SIGNAL -> Tab Audio Visualizer

A local, no-backend, no-framework audio visualizer that captures **browser tab audio**
and renders it in real time across six visualization modes. Built with plain
HTML, CSS, and vanilla JavaScript — no build step, no dependencies.

Everything happens on-device. Audio is analyzed in the browser via the Web
Audio API and never leaves the machine.

---

## How it works

1. Click **Start capture**.
2. The browser's native tab picker appears — choose a tab.
3. Check **"Share tab audio"** in that dialog.
4. The visualizer connects instantly and starts rendering.
5. Click **Stop** (square icon) to disconnect everything cleanly.

The captured audio is analyzed but **not** played back out of your speakers —
since the source tab is already producing sound, looping it back through
would create an echo. SIGNAL only listens; the original tab keeps playing
normally on its own.

---

## Visualization modes

| # | Mode | Description |
|---|------|--------------|
| 1 | **Spectrum Bars** | Classic log-scaled FFT bars with rounded tops, peak-hold indicators, adaptive smoothing, and optional mirror mode. |
| 2 | **Waveform** | Smooth bezier oscilloscope trace of the time-domain signal, with glow and adjustable thickness. |
| 3 | **Circular Spectrum** | Radial FFT bars rotating around a bass-reactive center pulse, with a particle ring driven by treble. |
| 4 | **Line Graph** | Scrolling, layered bass/mid/treble energy traces over a grid background. |
| 5 | **Particle Visualizer** | Drifting particle field — bass controls particle size, treble controls velocity, mid controls color blend. |
| 6 | **Orchestra Mode** | A seven-band meter bank (Sub Bass → Brilliance), each row showing an icon, a scrolling filled waveform, and a live dB/percent/peak meter. |

Switch modes anytime with the toolbar or number keys **1–6**.

---

## Controls

**Toolbar:** Play/Pause, Stop, mode selector, Sensitivity / Gain / Smoothing
sliders, theme picker, Screenshot, Record.

**Settings panel** (gear icon): FFT size, bar count, peak-hold time, mirror
mode, line width, circular radius & rotation speed, particle count, glow
intensity, background blur, wave thickness.

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `Space` | Pause / Resume |
| `F` | Fullscreen |
| `1`–`6` | Switch visualization mode |
| `S` | Screenshot (PNG) |
| `R` | Start / stop recording (WebM) |
| `Esc` | Exit fullscreen |

---

## Themes

Cyber Purple · Neon Blue · Synthwave · Aurora · Matrix Green · Fire · Ocean ·
Sunset · Monochrome · **Phosphor** (default — an oscilloscope-green/amber
instrument-panel look). Each theme is a set of CSS custom properties; switching
is instant and re-tints both the UI chrome and the canvas drawing (canvas reads
live accent colors from computed CSS each frame).

A separate light/dark toggle sits next to the theme picker.

---

## Performance notes

- All per-frame buffers (`Uint8Array`/`Float32Array` for FFT, waveform, and
  per-mode smoothing/peak state) are allocated once and reused — no per-frame
  allocation in the hot path.
- Canvas size tracks the container via `ResizeObserver` and is capped at
  2.5x device pixel ratio to avoid runaway buffer sizes on high-DPI displays.
- Rendering pauses automatically when the tab is hidden (`visibilitychange`)
  and resumes cleanly when it becomes visible again.
- FPS is measured with a rolling accumulator and shown live in the top bar.

---

## Project structure

```
index.html       Markup: top bar, canvas stage, toolbar, settings panel
style.css        Theming (CSS variables), glassmorphism chrome, responsive layout
script.js        AudioEngine, ThemeManager, SettingsManager, AnimationEngine,
                 6 visualizer classes, UIController
assets/
  icons/         (reserved — current icon set is inline SVG, no files needed)
  themes/        (reserved — themes are pure CSS variables, no files needed)
README.md
```

### Code organization (`script.js`)

- `AudioEngine` — `getDisplayMedia` capture, Web Audio graph, FFT/waveform
  buffers, band-energy analysis, beat/BPM detection, silence detection.
- `ThemeManager` — theme registry and live accent-color reads for canvas.
- `SettingsManager` — single source of truth for tunable parameters.
- `Visualizer` (base) + `SpectrumBars`, `WaveformViz`, `CircularVisualizer`,
  `LineGraphViz`, `ParticleViz`, `OrchestraMode` — one class per mode.
- `AnimationEngine` — canvas sizing, the `requestAnimationFrame` loop, FPS
  tracking, mode switching, hidden-tab pausing.
- `UIController` — binds all of the above to the DOM, handles start/stop/pause,
  screenshots, recording, and keyboard shortcuts.

---

## Browser support

Tab audio capture via `getDisplayMedia({ audio: true })` requires Chromium-based
browsers:

- ✅ Chrome, Edge, Opera — full support
- ⚠️ Firefox — `getDisplayMedia` video works, but tab/system **audio** capture
  support is inconsistent across versions
- ❌ Safari — no tab-audio capture support

If the API is unavailable, SIGNAL shows a clear inline error instead of
failing silently.

---

## Privacy

No backend, no analytics, no network calls. The only "network" activity is
loading the two Google Fonts referenced in `style.css` — everything else,
including all audio processing, is 100% local to the browser tab.
