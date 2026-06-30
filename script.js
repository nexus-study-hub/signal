/* ============================================================
   SIGNAL — Tab Audio Visualizer
   script.js
   Modules: AudioEngine, AnalysisUtils, ThemeManager, SettingsManager,
            Visualizer base + 6 modes, AnimationEngine, UIController
   No frameworks. No backend. Everything runs locally.
   ============================================================ */

'use strict';

/* ============================================================
   SECTION 1 — SMALL MATH / UTILITY HELPERS
   ============================================================ */
const Util = {
  lerp(a, b, t) { return a + (b - a) * t; },
  clamp(v, min, max) { return v < min ? min : v > max ? max : v; },
  map(v, inMin, inMax, outMin, outMax) {
    return outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin);
  },
  easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); },
  easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; },
  // Spring-ish smoothing toward a target. Returns new value.
  spring(current, target, velocity, stiffness = 0.18, damping = 0.78) {
    const force = (target - current) * stiffness;
    velocity = (velocity + force) * damping;
    return { value: current + velocity, velocity };
  },
  hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 255, g: 255, b: 255 };
  },
  // Reads a CSS variable's resolved color and returns rgb components
  cssVarRgb(name) {
    const val = getComputedStyle(document.body).getPropertyValue(name).trim();
    if (val.startsWith('#')) return Util.hexToRgb(val);
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(val);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };
    return { r: 255, g: 255, b: 255 };
  },
  formatHz(hz) {
    if (hz >= 1000) return (hz / 1000).toFixed(1) + 'k';
    return Math.round(hz).toString();
  },
  downloadCanvasPNG(canvas, filename) {
    const link = document.getElementById('downloadLink');
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  }
};

/* ============================================================
   SECTION 2 — AUDIO ENGINE
   Captures tab audio via getDisplayMedia, builds the Web Audio
   graph (source -> gain -> analyser -> destination-less sink),
   and exposes per-frame analysis data (FFT, waveform, bands).
   ============================================================ */
class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.analyser = null;
    this.gainNode = null;
    this.sourceNode = null;
    this.displayStream = null;

    this.fftSize = 2048;
    this.smoothing = 0.78;
    this.gain = 1;
    this.sensitivity = 1;

    // Reusable typed arrays — never reallocate per frame.
    this.freqData = null;      // Uint8Array frequency domain
    this.freqDataF = null;     // Float32Array frequency domain (dB)
    this.timeData = null;      // Uint8Array time domain

    this.sampleRate = 0;
    this.isCapturing = false;
    this.isPaused = false;

    // Frequency bands (Hz) used for Orchestra mode + bass/mid/treble analysis
    this.bandDefs = [
      { name: 'Sub Bass', lo: 20, hi: 60, icon: 'sub' },
      { name: 'Bass', lo: 60, hi: 250, icon: 'bass' },
      { name: 'Low Mid', lo: 250, hi: 500, icon: 'lowmid' },
      { name: 'Mid', lo: 500, hi: 2000, icon: 'mid' },
      { name: 'High Mid', lo: 2000, hi: 4000, icon: 'highmid' },
      { name: 'Presence', lo: 4000, hi: 6000, icon: 'presence' },
      { name: 'Brilliance', lo: 6000, hi: 20000, icon: 'brilliance' },
    ];

    // Beat detection state
    this.beatEnergyHistory = [];
    this.beatHistorySize = 43; // ~ last second at 60fps-ish sampling of energy
    this.lastBeatTime = 0;
    this.beatIntervals = [];
    this.bpm = 0;
    this.beatFlashCallback = null;

    // Output metrics (read by UI every frame)
    this.metrics = {
      volume: 0,        // 0-100 %
      peakFreq: 0,       // Hz
      rms: 0,
      peak: 0,
      average: 0,
      db: -Infinity,
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      isSilent: true,
    };

    this.latencyMs = 0;
  }

  get isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && (window.AudioContext || window.webkitAudioContext));
  }

  async start() {
    if (!this.isSupported) {
      throw new Error('UNSUPPORTED');
    }

    const t0 = performance.now();

    // Ask the user to pick a tab and share its audio.
    this.displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,        // required by spec to trigger the tab picker on most browsers
      audio: true,
      systemAudio: 'include',
      preferCurrentTab: false,
    });

    const audioTracks = this.displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      this.stop();
      throw new Error('NO_AUDIO_TRACK');
    }

    // We don't need the video track at all — drop it immediately to save resources.
    this.displayStream.getVideoTracks().forEach(t => t.stop());

    const AC = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AC();
    this.sampleRate = this.audioCtx.sampleRate;

    this.sourceNode = this.audioCtx.createMediaStreamSource(this.displayStream);

    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = this.gain;

    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = this.smoothing;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    // Intentionally NOT connecting to audioCtx.destination:
    // we don't want to play the captured tab audio back out of the speakers
    // (that would create an echo since the tab is already playing audio).

    this._allocateBuffers();

    this.isCapturing = true;
    this.isPaused = false;

    // If the user stops sharing from the browser's native "Stop sharing" bar.
    audioTracks[0].addEventListener('ended', () => {
      if (this.onExternalStop) this.onExternalStop();
    });

    this.latencyMs = Math.round(performance.now() - t0);
  }

  _allocateBuffers() {
    const binCount = this.analyser.frequencyBinCount;
    this.freqData = new Uint8Array(binCount);
    this.freqDataF = new Float32Array(binCount);
    this.timeData = new Uint8Array(this.analyser.fftSize);
  }

  setFftSize(size) {
    this.fftSize = size;
    if (this.analyser) {
      this.analyser.fftSize = size;
      this._allocateBuffers();
    }
  }

  setSmoothing(val) {
    this.smoothing = val;
    if (this.analyser) this.analyser.smoothingTimeConstant = val;
  }

  setGain(val) {
    this.gain = val;
    if (this.gainNode) this.gainNode.gain.value = val;
  }

  setSensitivity(val) {
    this.sensitivity = val;
  }

  pause() {
    this.isPaused = true;
    if (this.audioCtx && this.audioCtx.state === 'running') this.audioCtx.suspend();
  }

  resume() {
    this.isPaused = false;
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
  }

  stop() {
    this.isCapturing = false;
    this.isPaused = false;
    try {
      if (this.displayStream) this.displayStream.getTracks().forEach(t => t.stop());
    } catch (e) { /* noop */ }
    try {
      if (this.sourceNode) this.sourceNode.disconnect();
      if (this.gainNode) this.gainNode.disconnect();
      if (this.analyser) this.analyser.disconnect();
    } catch (e) { /* noop */ }
    try {
      if (this.audioCtx) this.audioCtx.close();
    } catch (e) { /* noop */ }

    this.audioCtx = null;
    this.analyser = null;
    this.gainNode = null;
    this.sourceNode = null;
    this.displayStream = null;
    this.beatEnergyHistory.length = 0;
    this.beatIntervals.length = 0;
    this.bpm = 0;
  }

  /** Pull the latest frequency + time domain data into the reusable buffers. */
  update() {
    if (!this.analyser) return;
    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getFloatFrequencyData(this.freqDataF);
    this.analyser.getByteTimeDomainData(this.timeData);
    this._computeMetrics();
    this._detectBeat();
  }

  /** Convert an FFT bin index to its corresponding frequency in Hz. */
  binToFreq(bin) {
    return (bin * this.sampleRate) / this.fftSize;
  }
  freqToBin(freq) {
    return Math.round((freq * this.fftSize) / this.sampleRate);
  }

  /** Get averaged energy (0-255) for a Hz range. */
  getBandEnergy(loHz, hiHz) {
    const loBin = Util.clamp(this.freqToBin(loHz), 0, this.freqData.length - 1);
    const hiBin = Util.clamp(this.freqToBin(hiHz), loBin + 1, this.freqData.length - 1);
    let sum = 0;
    let count = 0;
    for (let i = loBin; i <= hiBin; i++) {
      sum += this.freqData[i];
      count++;
    }
    return count > 0 ? sum / count : 0;
  }

  _computeMetrics() {
    const freq = this.freqData;
    const time = this.timeData;
    const n = freq.length;

    // RMS from time-domain (centered at 128)
    let sumSquares = 0;
    let maxDevi = 0;
    for (let i = 0; i < time.length; i++) {
      const v = (time[i] - 128) / 128;
      sumSquares += v * v;
      const dev = Math.abs(v);
      if (dev > maxDevi) maxDevi = dev;
    }
    const rms = Math.sqrt(sumSquares / time.length);

    // Peak / average / dominant frequency from frequency-domain
    let peak = 0, peakBin = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      const v = freq[i];
      sum += v;
      if (v > peak) { peak = v; peakBin = i; }
    }
    const average = sum / n;

    const bass = this.getBandEnergy(20, 250);
    const mid = this.getBandEnergy(250, 4000);
    const treble = this.getBandEnergy(4000, 16000);

    const sensApplied = (val) => Util.clamp(val * this.sensitivity, 0, 255);

    const m = this.metrics;
    m.rms = rms;
    m.peak = sensApplied(peak) / 255;
    m.average = sensApplied(average) / 255;
    m.peakFreq = this.binToFreq(peakBin);
    m.bass = sensApplied(bass) / 255;
    m.mid = sensApplied(mid) / 255;
    m.treble = sensApplied(treble) / 255;
    m.volume = Util.clamp(rms * this.sensitivity * 140, 0, 100);
    m.db = rms > 0 ? 20 * Math.log10(rms) : -90;
    m.energy = (m.bass * 0.5 + m.mid * 0.3 + m.treble * 0.2);
    m.isSilent = m.volume < 1.2;
  }

  _detectBeat() {
    const energy = this.metrics.bass; // bass-weighted energy works best for beat onset
    const hist = this.beatEnergyHistory;
    hist.push(energy);
    if (hist.length > this.beatHistorySize) hist.shift();

    if (hist.length < 8) return;

    let avg = 0;
    for (let i = 0; i < hist.length; i++) avg += hist[i];
    avg /= hist.length;

    let variance = 0;
    for (let i = 0; i < hist.length; i++) variance += (hist[i] - avg) ** 2;
    variance /= hist.length;

    // Adaptive threshold: more variance => need a bigger spike to count as a beat
    const threshold = 1.5 - 0.0025 * variance * 1000;
    const now = performance.now();

    if (energy > avg * Math.max(threshold, 1.08) && energy > 0.12 && (now - this.lastBeatTime) > 240) {
      if (this.lastBeatTime > 0) {
        const interval = now - this.lastBeatTime;
        if (interval > 240 && interval < 2000) {
          this.beatIntervals.push(interval);
          if (this.beatIntervals.length > 8) this.beatIntervals.shift();
          const avgInterval = this.beatIntervals.reduce((a, b) => a + b, 0) / this.beatIntervals.length;
          this.bpm = Math.round(60000 / avgInterval);
        }
      }
      this.lastBeatTime = now;
      if (this.beatFlashCallback) this.beatFlashCallback(energy);
    }
  }
}

/* ============================================================
   SECTION 3 — THEME MANAGER
   ============================================================ */
class ThemeManager {
  constructor() {
    this.themes = [
      { id: 'phosphor', label: 'Phosphor' },
      { id: 'cyber-purple', label: 'Cyber Purple' },
      { id: 'neon-blue', label: 'Neon Blue' },
      { id: 'synthwave', label: 'Synthwave' },
      { id: 'aurora', label: 'Aurora' },
      { id: 'matrix-green', label: 'Matrix Green' },
      { id: 'fire', label: 'Fire' },
      { id: 'ocean', label: 'Ocean' },
      { id: 'sunset', label: 'Sunset' },
      { id: 'monochrome', label: 'Monochrome' },
    ];
    this.current = 'phosphor';
    this.lightMode = false;
  }

  populateSelect(selectEl) {
    selectEl.innerHTML = '';
    this.themes.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      selectEl.appendChild(opt);
    });
    selectEl.value = this.current;
  }

  apply(themeId) {
    this.current = themeId;
    document.body.setAttribute('data-theme', themeId);
  }

  toggleLightMode() {
    this.lightMode = !this.lightMode;
    document.body.classList.toggle('light-mode', this.lightMode);
    return this.lightMode;
  }

  /** Returns the three accent colors as {r,g,b} for canvas drawing, read fresh each call. */
  getAccentColors() {
    return {
      accent: Util.cssVarRgb('--accent'),
      accent2: Util.cssVarRgb('--accent-2'),
      accent3: Util.cssVarRgb('--accent-3'),
    };
  }
}

/* ============================================================
   SECTION 4 — SETTINGS MANAGER
   Central store for all tunable parameters, with sensible
   defaults. UIController binds inputs to these values.
   ============================================================ */
class SettingsManager {
  constructor() {
    this.values = {
      fftSize: 2048,
      barCount: 64,
      sensitivity: 1,
      gain: 1,
      smoothing: 0.78,
      lineWidth: 2.5,
      glowIntensity: 14,
      particleCount: 600,
      bgBlur: 18,
      mirrorMode: false,
      rotationSpeed: 0.20,
      radius: 100,
      peakHoldTime: 900,
      waveThickness: 2,
    };
    this.listeners = {};
  }

  set(key, value) {
    this.values[key] = value;
    if (this.listeners[key]) this.listeners[key].forEach(fn => fn(value));
  }

  get(key) { return this.values[key]; }

  on(key, fn) {
    if (!this.listeners[key]) this.listeners[key] = [];
    this.listeners[key].push(fn);
  }
}

/* ============================================================
   SECTION 5 — VISUALIZER BASE CLASS
   Each mode extends this. Subclasses implement draw(ctx, audio, dt).
   The base class supplies shared canvas geometry + helpers so each
   mode file doesn't repeat boilerplate.
   ============================================================ */
class Visualizer {
  constructor(ctx, settings, theme) {
    this.ctx = ctx;
    this.settings = settings;
    this.theme = theme;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
  }

  resize(width, height, dpr) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
  }

  /** Apply a glow via shadow blur. Cheap & GPU-composited on most browsers. */
  applyGlow(color, intensityMultiplier = 1) {
    const ctx = this.ctx;
    const intensity = this.settings.get('glowIntensity') * intensityMultiplier;
    ctx.shadowBlur = intensity;
    ctx.shadowColor = color;
  }

  clearGlow() {
    this.ctx.shadowBlur = 0;
  }

  reset() { /* override if a mode keeps internal state (particles, trails) */ }
}

/* ---------------- MODE 1: SPECTRUM BARS ---------------- */
class SpectrumBars extends Visualizer {
  constructor(ctx, settings, theme) {
    super(ctx, settings, theme);
    this.peaks = null;       // current peak height per bar
    this.peakVelocity = null;
    this.peakHoldUntil = null;
    this.smoothedBars = null;
  }

  _ensureArrays(count) {
    if (!this.peaks || this.peaks.length !== count) {
      this.peaks = new Float32Array(count);
      this.peakVelocity = new Float32Array(count);
      this.peakHoldUntil = new Float32Array(count);
      this.smoothedBars = new Float32Array(count);
    }
  }

  draw(audio, now) {
    const ctx = this.ctx;
    const { width, height } = this;
    const barCount = this.settings.get('barCount');
    const mirror = this.settings.get('mirrorMode');
    const peakHoldTime = this.settings.get('peakHoldTime');

    this._ensureArrays(barCount);

    const freq = audio.freqData;
    const binCount = freq.length;
    const gap = Math.max(1, width / barCount * 0.18);
    const barWidth = (width / barCount) - gap;

    const colors = this.theme.getAccentColors();
    const baseline = mirror ? height / 2 : height;

    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < barCount; i++) {
      // Log-scaled bin mapping so low frequencies aren't crushed into 2px
      const t0 = i / barCount;
      const t1 = (i + 1) / barCount;
      const startBin = Math.floor(Math.pow(t0, 1.6) * binCount);
      const endBin = Math.max(startBin + 1, Math.floor(Math.pow(t1, 1.6) * binCount));

      let sum = 0, cnt = 0;
      for (let b = startBin; b < endBin && b < binCount; b++) { sum += freq[b]; cnt++; }
      const raw = (cnt > 0 ? sum / cnt : 0) / 255 * audio.sensitivity;

      // Adaptive smoothing — bigger jumps move faster than small ones
      const prev = this.smoothedBars[i];
      const diff = raw - prev;
      const smoothFactor = diff > 0 ? 0.55 : 0.18;
      const smoothed = prev + diff * smoothFactor;
      this.smoothedBars[i] = smoothed;

      const barHeight = Util.clamp(smoothed, 0, 1) * (mirror ? height / 2 - 4 : height - 4);
      const x = i * (barWidth + gap);

      // Peak hold + fall-off
      if (barHeight >= this.peaks[i]) {
        this.peaks[i] = barHeight;
        this.peakVelocity[i] = 0;
        this.peakHoldUntil[i] = now + peakHoldTime;
      } else if (now > this.peakHoldUntil[i]) {
        this.peakVelocity[i] += 0.4; // gravity
        this.peaks[i] = Math.max(barHeight, this.peaks[i] - this.peakVelocity[i]);
      }

      // Gradient fill: accent -> accent2 bottom to top
      const grad = ctx.createLinearGradient(0, baseline, 0, baseline - barHeight);
      grad.addColorStop(0, `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.95)`);
      grad.addColorStop(1, `rgba(${colors.accent2.r},${colors.accent2.g},${colors.accent2.b},0.85)`);

      ctx.fillStyle = grad;
      this.applyGlow(`rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.7)`, 0.6);

      const r = Math.min(barWidth / 2, 5);
      this._roundedBarTop(ctx, x, baseline, barWidth, barHeight, r, mirror ? 1 : -1);

      if (mirror) {
        ctx.globalAlpha = 0.5;
        this._roundedBarTop(ctx, x, baseline, barWidth, barHeight, r, -1);
        ctx.globalAlpha = 1;
      }

      this.clearGlow();

      // Peak indicator
      ctx.fillStyle = `rgba(${colors.accent2.r},${colors.accent2.g},${colors.accent2.b},0.9)`;
      const peakY = mirror ? baseline - this.peaks[i] : baseline - this.peaks[i];
      ctx.fillRect(x, peakY - 2, barWidth, 2);
      if (mirror) ctx.fillRect(x, baseline + this.peaks[i], barWidth, 2);
    }
  }

  /** Draws a vertical bar with rounded top (dir=-1 grows up, dir=1 grows down). */
  _roundedBarTop(ctx, x, baseline, w, h, r, dir) {
    if (h < 1) return;
    const yTop = dir === -1 ? baseline - h : baseline;
    const yBot = dir === -1 ? baseline : baseline + h;
    ctx.beginPath();
    if (dir === -1) {
      ctx.moveTo(x, yBot);
      ctx.lineTo(x, yTop + r);
      ctx.arcTo(x, yTop, x + r, yTop, r);
      ctx.lineTo(x + w - r, yTop);
      ctx.arcTo(x + w, yTop, x + w, yTop + r, r);
      ctx.lineTo(x + w, yBot);
    } else {
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBot - r);
      ctx.arcTo(x, yBot, x + r, yBot, r);
      ctx.lineTo(x + w - r, yBot);
      ctx.arcTo(x + w, yBot, x + w, yBot - r, r);
      ctx.lineTo(x + w, yTop);
    }
    ctx.closePath();
    ctx.fill();
  }

  reset() {
    if (this.peaks) this.peaks.fill(0);
    if (this.smoothedBars) this.smoothedBars.fill(0);
  }
}

/* ---------------- MODE 2: WAVEFORM (Oscilloscope) ---------------- */
/* ---------------- MODE 2a: WAVEFORM MODE 1 (raw oscilloscope, original) ---------------- */
class WaveformViz1 extends Visualizer {
  draw(audio) {
    const ctx = this.ctx;
    const { width, height } = this;
    const time = audio.timeData;
    const n = time.length;
    const lineWidth = this.settings.get('lineWidth');
    const colors = this.theme.getAccentColors();

    ctx.clearRect(0, 0, width, height);

    const midY = height / 2;
    const ampScale = (height / 2 - 8) * audio.sensitivity;
    const sliceWidth = width / (n - 1);

    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, `rgba(${colors.accent3.r},${colors.accent3.g},${colors.accent3.b},0.95)`);
    grad.addColorStop(0.5, `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.95)`);
    grad.addColorStop(1, `rgba(${colors.accent3.r},${colors.accent3.g},${colors.accent3.b},0.95)`);
    ctx.strokeStyle = grad;
    this.applyGlow(`rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.8)`);

    ctx.beginPath();
    // Smooth bezier curve through time-domain samples
    let prevX = 0, prevY = midY;
    for (let i = 0; i < n; i++) {
      const v = (time[i] - 128) / 128;
      const x = i * sliceWidth;
      const y = midY + v * ampScale;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        const cx = (prevX + x) / 2;
        const cy = (prevY + y) / 2;
        ctx.quadraticCurveTo(prevX, prevY, cx, cy);
      }
      prevX = x; prevY = y;
    }
    ctx.lineTo(width, prevY);
    ctx.stroke();
    this.clearGlow();

    // Faint center line for instrument-panel feel
    ctx.strokeStyle = `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.12)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();
  }
}

/* ---------------- MODE 2b: WAVEFORM MODE 2 (temporally smoothed, settled) ---------------- */
class WaveformViz2 extends Visualizer {
  constructor(ctx, settings, theme) {
    super(ctx, settings, theme);
    // Fixed-position sample points across the width (same idea as Orchestra
    // Mode 2): each point's x-position never moves, only its height eases
    // toward the live sample each frame, so the trace settles instead of
    // jittering raw sample-to-sample.
    this.pointCount = 160;
    this.samples = new Float32Array(this.pointCount);
    this._initialized = false;
  }

  draw(audio) {
    const ctx = this.ctx;
    const { width, height } = this;
    const time = audio.timeData;
    const n = time.length;
    const lineWidth = this.settings.get('lineWidth');
    const colors = this.theme.getAccentColors();

    ctx.clearRect(0, 0, width, height);

    const midY = height / 2;
    const ampScale = (height / 2 - 8) * audio.sensitivity;
    const pointCount = this.pointCount;

    // Resample the raw time-domain buffer down to a fixed point count, then
    // ease each fixed point toward its new target instead of redrawing the
    // raw signal directly — this is what removes the frame-to-frame jitter.
    for (let p = 0; p < pointCount; p++) {
      const srcIndex = Math.min(n - 1, Math.floor((p / (pointCount - 1)) * (n - 1)));
      const raw = (time[srcIndex] - 128) / 128;
      const prev = this.samples[p];
      const smoothFactor = this._initialized ? 0.22 : 1; // snap on first frame, ease after
      this.samples[p] = prev + (raw - prev) * smoothFactor;
    }
    this._initialized = true;

    const step = width / (pointCount - 1);

    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, `rgba(${colors.accent3.r},${colors.accent3.g},${colors.accent3.b},0.95)`);
    grad.addColorStop(0.5, `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.95)`);
    grad.addColorStop(1, `rgba(${colors.accent3.r},${colors.accent3.g},${colors.accent3.b},0.95)`);
    ctx.strokeStyle = grad;
    this.applyGlow(`rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.8)`);

    ctx.beginPath();
    let prevX = 0, prevY = midY;
    for (let p = 0; p < pointCount; p++) {
      const x = p * step;
      const y = midY + this.samples[p] * ampScale;
      if (p === 0) {
        ctx.moveTo(x, y);
      } else {
        const cx = (prevX + x) / 2;
        const cy = (prevY + y) / 2;
        ctx.quadraticCurveTo(prevX, prevY, cx, cy);
      }
      prevX = x; prevY = y;
    }
    ctx.lineTo(width, prevY);
    ctx.stroke();
    this.clearGlow();

    // Faint center line for instrument-panel feel
    ctx.strokeStyle = `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.12)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();
  }

  reset() {
    this.samples.fill(0);
    this._initialized = false;
  }
}

/* ---------------- MODE 3: CIRCULAR SPECTRUM ---------------- */
class CircularVisualizer extends Visualizer {
  constructor(ctx, settings, theme) {
    super(ctx, settings, theme);
    this.rotation = 0;
    this.particles = [];
    this.smoothedBars = null;
    this.pulseRadius = 0;
  }

  _ensureParticles(count) {
    if (this.particles.length === count) return;
    this.particles = [];
    for (let i = 0; i < count; i++) {
      this.particles.push({ angle: (i / count) * Math.PI * 2, dist: 0, speed: 0.3 + Math.random() * 0.4 });
    }
  }

  draw(audio, now, dt) {
    const ctx = this.ctx;
    const { width, height } = this;
    const cx = width / 2, cy = height / 2;
    const baseRadius = this.settings.get('radius') * (Math.min(width, height) / 480);
    const rotSpeed = this.settings.get('rotationSpeed');
    const barCount = Math.max(32, this.settings.get('barCount'));
    const colors = this.theme.getAccentColors();
    const freq = audio.freqData;
    const binCount = freq.length;

    if (!this.smoothedBars || this.smoothedBars.length !== barCount) {
      this.smoothedBars = new Float32Array(barCount);
    }

    ctx.clearRect(0, 0, width, height);
    this.rotation += rotSpeed * dt * 0.001;

    // Rotating outer glow ring
    const ringGrad = ctx.createRadialGradient(cx, cy, baseRadius * 0.5, cx, cy, baseRadius * 1.9);
    ringGrad.addColorStop(0, `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.08)`);
    ringGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ringGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius * 1.9, 0, Math.PI * 2);
    ctx.fill();

    // Radial FFT bars
    for (let i = 0; i < barCount; i++) {
      const t0 = i / barCount, t1 = (i + 1) / barCount;
      const startBin = Math.floor(Math.pow(t0, 1.5) * binCount);
      const endBin = Math.max(startBin + 1, Math.floor(Math.pow(t1, 1.5) * binCount));
      let sum = 0, cnt = 0;
      for (let b = startBin; b < endBin && b < binCount; b++) { sum += freq[b]; cnt++; }
      const raw = (cnt > 0 ? sum / cnt : 0) / 255 * audio.sensitivity;

      const prev = this.smoothedBars[i];
      const smoothed = prev + (raw - prev) * (raw > prev ? 0.5 : 0.15);
      this.smoothedBars[i] = smoothed;

      const angle = (i / barCount) * Math.PI * 2 + this.rotation;
      const barLen = smoothed * baseRadius * 1.1;
      const x0 = cx + Math.cos(angle) * baseRadius;
      const y0 = cy + Math.sin(angle) * baseRadius;
      const x1 = cx + Math.cos(angle) * (baseRadius + barLen);
      const y1 = cy + Math.sin(angle) * (baseRadius + barLen);

      const hue = Util.lerp(0, 1, i / barCount);
      ctx.strokeStyle = `rgba(${Util.lerp(colors.accent.r, colors.accent3.r, hue)},${Util.lerp(colors.accent.g, colors.accent3.g, hue)},${Util.lerp(colors.accent.b, colors.accent3.b, hue)},0.9)`;
      ctx.lineWidth = Math.max(1.5, (Math.PI * 2 * baseRadius / barCount) * 0.6);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // Center pulse (reacts to bass)
    const targetPulse = baseRadius * (0.55 + audio.metrics.bass * 0.5);
    this.pulseRadius += (targetPulse - this.pulseRadius) * 0.18;
    const pulseGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, this.pulseRadius);
    pulseGrad.addColorStop(0, `rgba(${colors.accent2.r},${colors.accent2.g},${colors.accent2.b},0.55)`);
    pulseGrad.addColorStop(1, `rgba(${colors.accent2.r},${colors.accent2.g},${colors.accent2.b},0)`);
    ctx.fillStyle = pulseGrad;
    this.applyGlow(`rgba(${colors.accent2.r},${colors.accent2.g},${colors.accent2.b},0.6)`, 1.2);
    ctx.beginPath();
    ctx.arc(cx, cy, this.pulseRadius, 0, Math.PI * 2);
    ctx.fill();
    this.clearGlow();

    // Album-art placeholder ring (subtle bezel)
    ctx.strokeStyle = `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.25)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, baseRadius * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // Particle ring
    this._ensureParticles(48);
    for (const p of this.particles) {
      p.angle += p.speed * dt * 0.0008;
      const targetDist = baseRadius * (1.15 + audio.metrics.treble * 0.4);
      p.dist += (targetDist - p.dist) * 0.06;
      const x = cx + Math.cos(p.angle) * p.dist;
      const y = cy + Math.sin(p.angle) * p.dist;
      ctx.fillStyle = `rgba(${colors.accent3.r},${colors.accent3.g},${colors.accent3.b},0.7)`;
      ctx.beginPath();
      ctx.arc(x, y, 1.6 + audio.metrics.treble * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  reset() {
    if (this.smoothedBars) this.smoothedBars.fill(0);
    this.pulseRadius = 0;
  }
}

/* ---------------- MODE 4: LINE GRAPH (scrolling frequency history) ---------------- */
/* ---------------- MODE: LINE GRAPH 1 (scrolling history, original) ---------------- */
/* ---------------- MODE: LINE GRAPH 1 (real-time, anchored — no scroll/delay) ---------------- */
/* ---------------- MODE: LINE GRAPH 1 (sweep style, wraps left→right) ---------------- */
/* ---------------- MODE: LINE GRAPH 1 (sweep style, 3 stacked rows) ---------------- */
class LineGraphV1 extends Visualizer {
  constructor(ctx, settings, theme) {
    super(ctx, settings, theme);
    this.maxPoints = 220;
    // Fixed-position circular buffers — sweep cursor writes into them and
    // wraps, instead of the whole trace scrolling sideways.
    this.buffers = [
      new Float32Array(this.maxPoints), // bass
      new Float32Array(this.maxPoints), // mid
      new Float32Array(this.maxPoints), // treble
    ];
    this.writeIndex = 0;
  }

  draw(audio) {
    const ctx = this.ctx;
    const { width, height } = this;
    const colors = this.theme.getAccentColors();

    ctx.clearRect(0, 0, width, height);

    const n = this.maxPoints;
    const step = width / (n - 1);
    const fadeSpan = Math.max(8, Math.round(n * 0.12));

    // Write the latest sample at the sweep cursor position (shared cursor
    // across all three rows so they stay in sync)
    this.buffers[0][this.writeIndex] = audio.metrics.bass;
    this.buffers[1][this.writeIndex] = audio.metrics.mid;
    this.buffers[2][this.writeIndex] = audio.metrics.treble;

    const traceColors = [colors.accent, colors.accent3, colors.accent2];
    const labels = ['BASS', 'MID', 'TREBLE'];

    const rowCount = 3;
    const rowGap = 8;
    const weights = [1.7, 1, 1]; // [bass, mid, treble]
    const totalWeight = weights[0] + weights[1] + weights[2];
    const availableHeight = height - rowGap * (rowCount - 1);
    const rowHeights = weights.map(w => (w / totalWeight) * availableHeight);

    let cursorY = 0;
    const rowYs = rowHeights.map(h => {
      const y = cursorY;
      cursorY += h + rowGap;
      return y;
    });

    this.buffers.forEach((buf, idx) => {
      const c = traceColors[idx];
      const rowY = rowYs[idx];
      const rowHeight = rowHeights[idx];
      const baseY = rowY + rowHeight - 8;
      const topY = rowY + 8;
      const ampRange = baseY - topY;

      // Row background card
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.04)`;
      ctx.fillRect(0, rowY, width, rowHeight);

      // Per-row grid
      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},0.08)`;
      ctx.lineWidth = 1;
      const gridLines = 4;
      for (let g = 0; g <= gridLines; g++) {
        const y = topY + (ampRange / gridLines) * g;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }
      const cols = 12;
      for (let g = 0; g <= cols; g++) {
        const x = (width / cols) * g;
        ctx.beginPath(); ctx.moveTo(x, rowY); ctx.lineTo(x, rowY + rowHeight); ctx.stroke();
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, rowY, width, rowHeight);
      ctx.clip();

      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      this.applyGlow(`rgba(${c.r},${c.g},${c.b},0.6)`, 0.5);

      for (let i = 1; i < n; i++) {
        const prevIdx = i - 1;
        const age = (this.writeIndex - i + n) % n;
        const alpha = age < fadeSpan
          ? 0.15 + 0.85 * (1 - age / fadeSpan)   // bright trail right behind the cursor
          : 0.18;                                 // dim leftover from the previous sweep

        const x0 = prevIdx * step, x1 = i * step;
        const y0 = baseY - buf[prevIdx] * ampRange;
        const y1 = baseY - buf[i] * ampRange;

        ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${alpha})`;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      this.clearGlow();

      // Sweep cursor dot
      const cx = this.writeIndex * step;
      const cy = baseY - buf[this.writeIndex] * ampRange;
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},1)`;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      // Row label + live readout
      ctx.font = '600 11px "JetBrains Mono", monospace';
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.9)`;
      ctx.fillText(labels[idx], 10, rowY + 16);

      const current = buf[this.writeIndex];
      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.7)`;
      ctx.fillText(`${Math.round(current * 100)}%`, width - 10, rowY + 16);
      ctx.textAlign = 'left';
    });

    // Advance the shared cursor; wraps to 0 at the right edge of every row
    this.writeIndex = (this.writeIndex + 1) % n;
  }

  reset() {
    for (const buf of this.buffers) buf.fill(0);
    this.writeIndex = 0;
  }
}

/* ---------------- MODE: LINE GRAPH 2 (static, anchored in place) ---------------- */
class LineGraphV2 extends Visualizer {
  constructor(ctx, settings, theme) {
    super(ctx, settings, theme);
    // Fixed-position sample points (NOT a scrolling history). Each point
    // samples a fixed sub-slice of the full audible spectrum, so the three
    // traces reshape live in place instead of crawling sideways.
    this.pointsPerTrace = 48;
    this.traceSamples = [
      new Float32Array(this.pointsPerTrace), // bass
      new Float32Array(this.pointsPerTrace), // mid
      new Float32Array(this.pointsPerTrace), // treble
    ];
    // Each trace samples its own Hz range, split into pointsPerTrace slices.
    this.ranges = [
      { lo: 20, hi: 250 },     // bass
      { lo: 250, hi: 4000 },   // mid
      { lo: 4000, hi: 16000 }, // treble
    ];
  }

  draw(audio) {
    const ctx = this.ctx;
    const { width, height } = this;
    const colors = this.theme.getAccentColors();

    ctx.clearRect(0, 0, width, height);

    const traceColors = [colors.accent, colors.accent3, colors.accent2];
    const labels = ['BASS', 'MID', 'TREBLE'];
    const n = this.pointsPerTrace;

    const rowCount = 3;
    const rowGap = 8;
    const rowHeight = (height - rowGap * (rowCount - 1)) / rowCount;
    const step = width / (n - 1);

    this.traceSamples.forEach((samples, idx) => {
      const range = this.ranges[idx];
      const span = range.hi - range.lo;
      const rowY = idx * (rowHeight + rowGap);
      const baseY = rowY + rowHeight - 8;
      const topY = rowY + 8;
      const c = traceColors[idx];

      // Row background card
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.04)`;
      ctx.fillRect(0, rowY, width, rowHeight);

      // Per-row grid (own baseline, independent of the other two panels)
      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},0.08)`;
      ctx.lineWidth = 1;
      const gridLines = 4;
      for (let g = 0; g <= gridLines; g++) {
        const y = topY + ((baseY - topY) / gridLines) * g;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }
      const cols = 12;
      for (let g = 0; g <= cols; g++) {
        const x = (width / cols) * g;
        ctx.beginPath(); ctx.moveTo(x, rowY); ctx.lineTo(x, rowY + rowHeight); ctx.stroke();
      }

      // Sample n fixed points across this trace's own Hz range — only the
      // height at each fixed x updates frame to frame, never the x itself.
      for (let p = 0; p < n; p++) {
        const loP = range.lo + (p / n) * span;
        const hiP = range.lo + ((p + 1) / n) * span;
        const raw = audio.getBandEnergy(loP, hiP) / 255 * audio.sensitivity;
        const prev = samples[p];
        samples[p] = prev + (raw - prev) * (raw > prev ? 0.5 : 0.15);
      }

      // Filled area under the trace, scoped to this row only
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, rowY, width, rowHeight);
      ctx.clip();

      ctx.beginPath();
      ctx.moveTo(0, baseY);
      for (let p = 0; p < n; p++) {
        const x = p * step;
        const y = baseY - samples[p] * (baseY - topY);
        ctx.lineTo(x, y);
      }
      ctx.lineTo((n - 1) * step, baseY);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, topY, 0, baseY);
      grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},0.30)`);
      grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0.02)`);
      ctx.fillStyle = grad;
      ctx.fill();

      // Trace line itself
      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},0.9)`;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      this.applyGlow(`rgba(${c.r},${c.g},${c.b},0.6)`, 0.5);
      ctx.beginPath();
      for (let p = 0; p < n; p++) {
        const x = p * step;
        const y = baseY - samples[p] * (baseY - topY);
        if (p === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      this.clearGlow();
      ctx.restore();

      // Row label + live readout
      ctx.font = '600 11px "JetBrains Mono", monospace';
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.9)`;
      ctx.fillText(labels[idx], 10, rowY + 16);

      const current = samples[n - 1];
      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.7)`;
      ctx.fillText(`${Math.round(current * 100)}%`, width - 10, rowY + 16);
      ctx.textAlign = 'left';
    });
  }

  reset() {
    for (const arr of this.traceSamples) arr.fill(0);
  }
}

/* ---------------- MODE 5: PARTICLE VISUALIZER ---------------- */
class ParticleViz extends Visualizer {
  constructor(ctx, settings, theme) {
    super(ctx, settings, theme);
    this.particles = [];
  }

  _ensure(count) {
    while (this.particles.length < count) {
      this.particles.push(this._spawn());
    }
    if (this.particles.length > count) this.particles.length = count;
  }

  _spawn() {
    return {
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      baseSize: 0.8 + Math.random() * 1.6,
      hueT: Math.random(),
    };
  }

  draw(audio, now, dt) {
    const ctx = this.ctx;
    const { width, height } = this;
    const count = this.settings.get('particleCount');
    const colors = this.theme.getAccentColors();
    this._ensure(count);

    // Trail effect via low-alpha overpaint (motion blur). Note: this canvas is
    // created with {alpha:false}, so 'destination-out' compositing has no
    // alpha channel to act on — a plain semi-transparent fill fades old
    // pixels toward black instead, which reads the same visually.
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, width, height);

    const bass = audio.metrics.bass, mid = audio.metrics.mid, treble = audio.metrics.treble;
    const speedMul = 1 + treble * 3;
    const sizeMul = 1 + bass * 2.6;

    for (const p of this.particles) {
      p.x += p.vx * speedMul * (dt * 0.06);
      p.y += p.vy * speedMul * (dt * 0.06);

      if (p.x < 0) p.x += width;
      if (p.x > width) p.x -= width;
      if (p.y < 0) p.y += height;
      if (p.y > height) p.y -= height;

      const size = p.baseSize * sizeMul;
      const r = Util.lerp(colors.accent.r, colors.accent3.r, Util.lerp(p.hueT, mid, 0.5));
      const g = Util.lerp(colors.accent.g, colors.accent3.g, Util.lerp(p.hueT, mid, 0.5));
      const b = Util.lerp(colors.accent.b, colors.accent3.b, Util.lerp(p.hueT, mid, 0.5));

      ctx.fillStyle = `rgba(${r},${g},${b},${0.55 + bass * 0.4})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Occasional connecting lines on strong beats for cohesion (cheap O(n) sampled pairs)
    if (bass > 0.45) {
      ctx.strokeStyle = `rgba(${colors.accent2.r},${colors.accent2.g},${colors.accent2.b},${0.12 * bass})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < this.particles.length; i += 9) {
        const a = this.particles[i];
        const b2 = this.particles[(i + 9) % this.particles.length];
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b2.x, b2.y);
      }
      ctx.stroke();
    }
  }

  reset() { this.particles = []; }
}

/* ---------------- MODE 6: ORCHESTRA MODE (multi-band meter bank) ---------------- */
/* ---------------- shared helpers for both Orchestra variants ---------------- */
class OrchestraBase extends Visualizer {
  _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2 > 0 ? w / 2 : r);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Minimal glyph set so we don't need external icon assets. */
  _drawBandGlyph(ctx, cx, cy, type, colors, energy) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = ctx.fillStyle;
    const s = 5 + energy * 2;
    switch (type) {
      case 'sub':
        ctx.beginPath(); ctx.arc(0, 0, s * 0.9, 0, Math.PI * 2); ctx.fill(); break;
      case 'bass':
        ctx.beginPath(); ctx.arc(0, 0, s * 0.7, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, s * 0.3, 0, Math.PI * 2); ctx.fill(); break;
      case 'lowmid':
        ctx.beginPath(); ctx.moveTo(-s, 3); ctx.lineTo(0, -s); ctx.lineTo(s, 3); ctx.closePath(); ctx.fill(); break;
      case 'mid':
        ctx.beginPath(); ctx.rect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4); ctx.fill(); break;
      case 'highmid':
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(a) * s, y = Math.sin(a) * s;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.fill(); break;
      case 'presence':
        ctx.beginPath(); ctx.moveTo(-s, -s * 0.5); ctx.lineTo(s, -s * 0.5); ctx.lineTo(0, s); ctx.closePath(); ctx.fill(); break;
      case 'brilliance':
      default:
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s);
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
        break;
    }
    ctx.restore();
  }

  /** Shared left-column icon + label + Hz-range caption, identical in both variants. */
  _drawLeftColumn(ctx, band, y, rowHeight, colors, smoothed) {
    ctx.save();
    ctx.fillStyle = `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},${0.5 + smoothed * 0.5})`;
    ctx.font = '600 12px "Space Grotesk", sans-serif';
    ctx.textBaseline = 'middle';
    this._drawBandGlyph(ctx, 16, y + rowHeight / 2, band.icon, colors, smoothed);
    ctx.fillStyle = `rgba(${colors.accent.r + 40},${colors.accent.g + 40},${colors.accent.b + 40},0.92)`;
    ctx.fillText(band.name, 40, y + rowHeight / 2);
    ctx.font = '400 9px "JetBrains Mono", monospace';
    ctx.fillStyle = `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.45)`;
    ctx.fillText(`${band.lo}–${band.hi >= 1000 ? (band.hi / 1000) + 'k' : band.hi}Hz`, 40, y + rowHeight / 2 + 13);
    ctx.restore();
  }

  /** Shared right-column dB/% meter + peak tick, identical in both variants. */
  _drawRightMeter(ctx, width, rightColW, y, rowHeight, smoothed, peak, colors, c) {
    const meterX = width - rightColW + 10;
    const meterW = rightColW - 24;
    const meterY = y + rowHeight / 2 - 4;

    ctx.fillStyle = `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.12)`;
    this._roundRect(ctx, meterX, meterY, meterW, 8, 4);
    ctx.fill();

    ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},0.9)`;
    this._roundRect(ctx, meterX, meterY, meterW * Util.clamp(smoothed, 0, 1), 8, 4);
    ctx.fill();

    const peakX = meterX + meterW * Util.clamp(peak, 0, 1);
    ctx.fillStyle = `rgba(${colors.accent2.r},${colors.accent2.g},${colors.accent2.b},0.95)`;
    ctx.fillRect(peakX - 1, meterY - 2, 2, 12);

    const db = smoothed > 0.001 ? (20 * Math.log10(smoothed)).toFixed(0) : '-∞';
    ctx.font = '500 9px "JetBrains Mono", monospace';
    ctx.fillStyle = `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.7)`;
    ctx.textAlign = 'right';
    ctx.fillText(`${db}dB  ${Math.round(smoothed * 100)}%`, width - 14, y + rowHeight / 2 + 14);
    ctx.textAlign = 'left';
  }
}

/* ---------------- MODE 6: ORCHESTRA MODE 1 (scrolling history, original) ---------------- */
class OrchestraModeV1 extends OrchestraBase {
  constructor(ctx, settings, theme) {
    super(ctx, settings, theme);
    this.bandSmoothed = new Float32Array(7);
    this.bandPeaks = new Float32Array(7);
    this.bandPeakHold = new Float32Array(7);
    // Scrolling history buffer per row — each new sample pushes in from the
    // right and the whole trace crawls left, like a seismograph feed.
    this.waveHistories = [[], [], [], [], [], [], []];
    this.historyLen = 64;
  }

  draw(audio, now) {
    const ctx = this.ctx;
    const { width, height } = this;
    const colors = this.theme.getAccentColors();
    const bands = audio.bandDefs;
    const rowCount = bands.length;
    const rowGap = 4;
    const rowHeight = (height - rowGap * (rowCount - 1)) / rowCount;

    ctx.clearRect(0, 0, width, height);

    const leftColW = Math.min(150, width * 0.22);
    const rightColW = Math.min(110, width * 0.16);
    const centerX = leftColW;
    const centerW = width - leftColW - rightColW;

    for (let i = 0; i < rowCount; i++) {
      const band = bands[i];
      const y = i * (rowHeight + rowGap);
      const energy = audio.getBandEnergy(band.lo, band.hi) / 255 * audio.sensitivity;

      const prev = this.bandSmoothed[i];
      const smoothed = prev + (energy - prev) * (energy > prev ? 0.45 : 0.12);
      this.bandSmoothed[i] = smoothed;

      if (smoothed >= this.bandPeaks[i]) {
        this.bandPeaks[i] = smoothed;
        this.bandPeakHold[i] = now + 900;
      } else if (now > this.bandPeakHold[i]) {
        this.bandPeaks[i] = Math.max(smoothed, this.bandPeaks[i] - 0.006);
      }

      // Row background card
      ctx.fillStyle = `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.035)`;
      this._roundRect(ctx, 0, y, width, rowHeight, 6);
      ctx.fill();

      this._drawLeftColumn(ctx, band, y, rowHeight, colors, smoothed);

      // --- CENTER: filled waveform area, scrolling ---
      const hist = this.waveHistories[i];
      hist.push(smoothed);
      if (hist.length > this.historyLen) hist.shift();

      ctx.save();
      ctx.beginPath();
      ctx.rect(centerX, y + 2, centerW, rowHeight - 4);
      ctx.clip();

      const baseY = y + rowHeight - 4;
      const topY = y + 4;
      const step = centerW / (this.historyLen - 1);
      const startX = centerX + centerW - (hist.length - 1) * step;

      ctx.beginPath();
      ctx.moveTo(startX, baseY);
      for (let h = 0; h < hist.length; h++) {
        const x = startX + h * step;
        const yVal = baseY - hist[h] * (rowHeight - 10);
        ctx.lineTo(x, yVal);
      }
      ctx.lineTo(startX + (hist.length - 1) * step, baseY);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, topY, 0, baseY);
      const c = i < 2 ? colors.accent : i < 5 ? colors.accent3 : colors.accent2;
      grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},0.75)`);
      grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0.05)`);
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},0.9)`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let h = 0; h < hist.length; h++) {
        const x = startX + h * step;
        const yVal = baseY - hist[h] * (rowHeight - 10);
        if (h === 0) ctx.moveTo(x, yVal); else ctx.lineTo(x, yVal);
      }
      ctx.stroke();
      ctx.restore();

      this._drawRightMeter(ctx, width, rightColW, y, rowHeight, smoothed, this.bandPeaks[i], colors, c);
    }
  }

  reset() {
    this.bandSmoothed.fill(0);
    this.bandPeaks.fill(0);
    this.waveHistories = [[], [], [], [], [], [], []];
  }
}

/* ---------------- MODE 7: ORCHESTRA MODE 2 (static, anchored in place) ---------------- */
class OrchestraModeV2 extends OrchestraBase {
  constructor(ctx, settings, theme) {
    super(ctx, settings, theme);
    this.bandSmoothed = new Float32Array(7);
    this.bandPeaks = new Float32Array(7);
    this.bandPeakHold = new Float32Array(7);
    // Fixed-position sample points per row (NOT a scrolling history). Each
    // point samples a fixed sub-slice of that band's own Hz range, so the
    // silhouette reshapes live in place instead of crawling sideways.
    this.pointsPerRow = 28;
    this.rowSamples = Array.from({ length: 7 }, () => new Float32Array(this.pointsPerRow));
  }

  draw(audio, now) {
    const ctx = this.ctx;
    const { width, height } = this;
    const colors = this.theme.getAccentColors();
    const bands = audio.bandDefs;
    const rowCount = bands.length;
    const rowGap = 4;
    const rowHeight = (height - rowGap * (rowCount - 1)) / rowCount;

    ctx.clearRect(0, 0, width, height);

    const leftColW = Math.min(150, width * 0.22);
    const rightColW = Math.min(110, width * 0.16);
    const centerX = leftColW;
    const centerW = width - leftColW - rightColW;

    for (let i = 0; i < rowCount; i++) {
      const band = bands[i];
      const y = i * (rowHeight + rowGap);
      const energy = audio.getBandEnergy(band.lo, band.hi) / 255 * audio.sensitivity;

      const prev = this.bandSmoothed[i];
      const smoothed = prev + (energy - prev) * (energy > prev ? 0.45 : 0.12);
      this.bandSmoothed[i] = smoothed;

      if (smoothed >= this.bandPeaks[i]) {
        this.bandPeaks[i] = smoothed;
        this.bandPeakHold[i] = now + 900;
      } else if (now > this.bandPeakHold[i]) {
        this.bandPeaks[i] = Math.max(smoothed, this.bandPeaks[i] - 0.006);
      }

      // Row background card
      ctx.fillStyle = `rgba(${colors.accent.r},${colors.accent.g},${colors.accent.b},0.035)`;
      this._roundRect(ctx, 0, y, width, rowHeight, 6);
      ctx.fill();

      this._drawLeftColumn(ctx, band, y, rowHeight, colors, smoothed);

      // --- CENTER: filled waveform area, anchored in place ---
      // Sample N fixed points across THIS band's own Hz range, so each
      // point's x-position is permanent — only its height changes frame
      // to frame. No scrolling, no shifting buffer.
      const samples = this.rowSamples[i];
      const n = this.pointsPerRow;
      const span = band.hi - band.lo;
      for (let p = 0; p < n; p++) {
        const loP = band.lo + (p / n) * span;
        const hiP = band.lo + ((p + 1) / n) * span;
        const raw = audio.getBandEnergy(loP, hiP) / 255 * audio.sensitivity;
        const sPrev = samples[p];
        samples[p] = sPrev + (raw - sPrev) * (raw > sPrev ? 0.5 : 0.15);
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(centerX, y + 2, centerW, rowHeight - 4);
      ctx.clip();

      const baseY = y + rowHeight - 4;
      const topY = y + 4;
      const step = centerW / (n - 1);

      ctx.beginPath();
      ctx.moveTo(centerX, baseY);
      for (let p = 0; p < n; p++) {
        const x = centerX + p * step;
        const yVal = baseY - samples[p] * (rowHeight - 10);
        ctx.lineTo(x, yVal);
      }
      ctx.lineTo(centerX + (n - 1) * step, baseY);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, topY, 0, baseY);
      const c = i < 2 ? colors.accent : i < 5 ? colors.accent3 : colors.accent2;
      grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},0.75)`);
      grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0.05)`);
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},0.9)`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let p = 0; p < n; p++) {
        const x = centerX + p * step;
        const yVal = baseY - samples[p] * (rowHeight - 10);
        if (p === 0) ctx.moveTo(x, yVal); else ctx.lineTo(x, yVal);
      }
      ctx.stroke();
      ctx.restore();

      this._drawRightMeter(ctx, width, rightColW, y, rowHeight, smoothed, this.bandPeaks[i], colors, c);
    }
  }

  reset() {
    this.bandSmoothed.fill(0);
    this.bandPeaks.fill(0);
    for (const arr of this.rowSamples) arr.fill(0);
  }
}

/* ============================================================
   SECTION 6 — ANIMATION ENGINE
   Owns the canvas, the rAF loop, FPS measurement, mode switching,
   high-DPI handling, resize observation, and pause-when-hidden.
   ============================================================ */
class AnimationEngine {
  constructor(canvas, settings, theme, audio) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.settings = settings;
    this.theme = theme;
    this.audio = audio;

    this.modes = {
      spectrum: new SpectrumBars(this.ctx, settings, theme),
      waveform1: new WaveformViz1(this.ctx, settings, theme),
      waveform2: new WaveformViz2(this.ctx, settings, theme),
      circular: new CircularVisualizer(this.ctx, settings, theme),
      linegraph1: new LineGraphV1(this.ctx, settings, theme),
      linegraph2: new LineGraphV2(this.ctx, settings, theme),
      particles: new ParticleViz(this.ctx, settings, theme),
      orchestra1: new OrchestraModeV1(this.ctx, settings, theme),
      orchestra2: new OrchestraModeV2(this.ctx, settings, theme),
    };
    this.modeOrder = ['spectrum', 'waveform1', 'waveform2', 'circular', 'linegraph1', 'linegraph2', 'particles', 'orchestra1', 'orchestra2'];
    this.currentModeKey = 'spectrum';

    this.running = false;
    this.rafId = null;
    this.lastFrameTime = 0;
    this.fps = 0;
    this._fpsFrames = 0;
    this._fpsAccum = 0;

    this.beatFlashIntensity = 0;

    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    this._resizeObserver = new ResizeObserver(() => this._handleResize());
  }

  observe(container) {
    this._resizeObserver.observe(container);
    this._handleResize();
  }

  _handleResize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx.setTransform(1, 0, 0, 1, 0, 0); // reset, we draw in device pixels
      for (const key in this.modes) {
        this.modes[key].resize(w, h, dpr);
      }
    }
  }

  setMode(key) {
    if (!this.modes[key]) return;
    this.currentModeKey = key;
  }

  get currentMode() { return this.modes[this.currentModeKey]; }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this._loop(this.lastFrameTime);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    // Clear canvas
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  resetAllModes() {
    for (const key in this.modes) this.modes[key].reset();
  }

  triggerBeatFlash() {
    this.beatFlashIntensity = 1;
  }

  _onVisibilityChange() {
    if (document.hidden) {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    } else if (this.running) {
      this.lastFrameTime = performance.now();
      this._loop(this.lastFrameTime);
    }
  }

  _loop(now) {
    if (!this.running) return;
    this.rafId = requestAnimationFrame((t) => this._loop(t));

    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;

    // FPS measurement (rolling, updated ~4x/sec)
    this._fpsFrames++;
    this._fpsAccum += dt;
    if (this._fpsAccum >= 250) {
      this.fps = Math.round((this._fpsFrames * 1000) / this._fpsAccum);
      this._fpsFrames = 0;
      this._fpsAccum = 0;
    }

    if (!this.audio.isPaused) {
      this.audio.update();
    }

    this.currentMode.draw(this.audio, now, dt);

    if (this.onFrame) this.onFrame(dt);
  }
}

/* ============================================================
   SECTION 7 — UI CONTROLLER
   Wires DOM elements to AudioEngine / AnimationEngine / ThemeManager
   / SettingsManager. Handles start/stop/pause, recording, screenshots,
   keyboard shortcuts, and live readout updates.
   ============================================================ */
class UIController {
  constructor() {
    this.audio = new AudioEngine();
    this.theme = new ThemeManager();
    this.settings = new SettingsManager();

    this.canvas = document.getElementById('vizCanvas');
    this.stage = document.getElementById('stage');
    this.app = document.getElementById('app');

    this.engine = new AnimationEngine(this.canvas, this.settings, this.theme, this.audio);
    this.engine.observe(this.stage);

    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;

    this.modeLabels = {
      spectrum: 'Spectrum Bars',
      waveform1: 'Waveform Mode 1',
      waveform2: 'Waveform Mode 2',
      circular: 'Circular Spectrum',
      linegraph1: 'Line Graph Mode 1',
      linegraph2: 'Line Graph Mode 2',
      particles: 'Particle Visualizer',
      orchestra1: 'Orchestra Mode 1',
      orchestra2: 'Orchestra Mode 2',
    };

    this._cacheDom();
    this._buildVizSelector();
    this._bindThemeSelect();
    this._bindToolbar();
    this._bindSettingsPanel();
    this._bindKeyboard();
    this._bindStart();

    this.audio.beatFlashCallback = () => this.engine.triggerBeatFlash();
    this.audio.onExternalStop = () => this._handleStop();

    this.engine.onFrame = (dt) => this._onFrame(dt);

    this._renderLoopId = requestAnimationFrame(() => this._idleRenderTick());
  }

  _cacheDom() {
    this.el = {
      startOverlay: document.getElementById('startOverlay'),
      btnStart: document.getElementById('btnStart'),
      startError: document.getElementById('startError'),
      btnPlayPause: document.getElementById('btnPlayPause'),
      iconPlayPause: document.getElementById('iconPlayPause'),
      btnStop: document.getElementById('btnStop'),
      vizSelect: document.getElementById('vizSelect'),
      modeChip: document.getElementById('modeChip'),
      beatFlash: document.getElementById('beatFlash'),
      sliderSensitivity: document.getElementById('sliderSensitivity'),
      sliderGain: document.getElementById('sliderGain'),
      sliderSmoothing: document.getElementById('sliderSmoothing'),
      themeSelect: document.getElementById('themeSelect'),
      btnThemeMode: document.getElementById('btnThemeMode'),
      btnFullscreen: document.getElementById('btnFullscreen'),
      btnScreenshot: document.getElementById('btnScreenshot'),
      btnRecord: document.getElementById('btnRecord'),
      btnSettings: document.getElementById('btnSettings'),
      btnCloseSettings: document.getElementById('btnCloseSettings'),
      settingsPanel: document.getElementById('settingsPanel'),
      settingsScrim: document.getElementById('settingsScrim'),
      toolbar: document.getElementById('toolbar'),

      rVolume: document.getElementById('rVolume'),
      rPeakFreq: document.getElementById('rPeakFreq'),
      rFps: document.getElementById('rFps'),
      rLatency: document.getElementById('rLatency'),
      rSampleRate: document.getElementById('rSampleRate'),
      rBpm: document.getElementById('rBpm'),

      selFftSize: document.getElementById('selFftSize'),
      vFftSize: document.getElementById('vFftSize'),
      rngBarCount: document.getElementById('rngBarCount'),
      vBarCount: document.getElementById('vBarCount'),
      rngPeakHold: document.getElementById('rngPeakHold'),
      vPeakHold: document.getElementById('vPeakHold'),
      chkMirror: document.getElementById('chkMirror'),
      rngLineWidth: document.getElementById('rngLineWidth'),
      vLineWidth: document.getElementById('vLineWidth'),
      rngRadius: document.getElementById('rngRadius'),
      vRadius: document.getElementById('vRadius'),
      rngRotSpeed: document.getElementById('rngRotSpeed'),
      vRotSpeed: document.getElementById('vRotSpeed'),
      rngParticleCount: document.getElementById('rngParticleCount'),
      vParticleCount: document.getElementById('vParticleCount'),
      rngGlow: document.getElementById('rngGlow'),
      vGlow: document.getElementById('vGlow'),
      rngBgBlur: document.getElementById('rngBgBlur'),
      vBgBlur: document.getElementById('vBgBlur'),
      rngWaveThick: document.getElementById('rngWaveThick'),
      vWaveThick: document.getElementById('vWaveThick'),
    };
  }

  /* ---------------- VIZ MODE SELECTOR ---------------- */
  _buildVizSelector() {
    const order = this.engine.modeOrder;
    order.forEach((key, idx) => {
      const btn = document.createElement('button');
      btn.className = 'viz-btn' + (key === this.engine.currentModeKey ? ' active' : '');
      btn.dataset.mode = key;
      btn.innerHTML = `<span class="num">${idx + 1}</span><span>${this.modeLabels[key]}</span>`;
      btn.addEventListener('click', () => this._setMode(key));
      this.el.vizSelect.appendChild(btn);
    });
  }

  _setMode(key) {
    this.engine.setMode(key);
    this.el.modeChip.textContent = this.modeLabels[key];
    [...this.el.vizSelect.children].forEach(b => {
      b.classList.toggle('active', b.dataset.mode === key);
    });
  }

  /* ---------------- THEME ---------------- */
  _bindThemeSelect() {
    this.theme.populateSelect(this.el.themeSelect);
    this.el.themeSelect.addEventListener('change', (e) => {
      this.theme.apply(e.target.value);
    });

    this.el.btnThemeMode.addEventListener('click', () => {
      this.theme.toggleLightMode();
    });
  }

  /* ---------------- START / STOP / PAUSE ---------------- */
  _bindStart() {
    this.el.btnStart.addEventListener('click', () => this._handleStartClick());
  }

  async _handleStartClick() {
    this.el.startError.textContent = '';

    if (!this.audio.isSupported) {
      this.el.startError.textContent = 'Your browser does not support tab audio capture (getDisplayMedia). Try Chrome, Edge, or Opera.';
      return;
    }

    this.el.btnStart.disabled = true;
    this.el.btnStart.style.opacity = '0.6';

    try {
      await this.audio.start();
      this._onCaptureStarted();
    } catch (err) {
      console.error(err);
      if (err && err.name === 'NotAllowedError') {
        this.el.startError.textContent = 'Permission was denied. Click "Start capture" and choose a tab with audio.';
      } else if (err && err.message === 'NO_AUDIO_TRACK') {
        this.el.startError.textContent = 'No audio track found — make sure "Share tab audio" is checked in the share dialog.';
      } else if (err && err.message === 'UNSUPPORTED') {
        this.el.startError.textContent = 'Tab audio capture is not supported in this browser.';
      } else {
        this.el.startError.textContent = 'Could not start capture. Please try again.';
      }
    } finally {
      this.el.btnStart.disabled = false;
      this.el.btnStart.style.opacity = '1';
    }
  }

  _onCaptureStarted() {
    this.el.startOverlay.classList.add('hidden');
    this.el.btnPlayPause.disabled = false;
    this.el.btnStop.disabled = false;
    this.el.rSampleRate.textContent = (this.audio.sampleRate / 1000).toFixed(1) + ' kHz';
    this.el.rLatency.textContent = this.audio.latencyMs + ' ms';
    this.engine.resetAllModes();
    this.engine.start();
    this._setPlayPauseIcon(true);
  }

  _bindToolbar() {
    this.el.btnPlayPause.addEventListener('click', () => this._togglePause());
    this.el.btnStop.addEventListener('click', () => this._handleStop());

    this.el.sliderSensitivity.addEventListener('input', (e) => {
      this.audio.setSensitivity(parseFloat(e.target.value));
    });
    this.el.sliderGain.addEventListener('input', (e) => {
      this.audio.setGain(parseFloat(e.target.value));
    });
    this.el.sliderSmoothing.addEventListener('input', (e) => {
      this.audio.setSmoothing(parseFloat(e.target.value));
      this.settings.set('smoothing', parseFloat(e.target.value));
    });

    this.el.btnFullscreen.addEventListener('click', () => this._toggleFullscreen());
    this.el.btnScreenshot.addEventListener('click', () => this._takeScreenshot());
    this.el.btnRecord.addEventListener('click', () => this._toggleRecording());
  }

  _togglePause() {
    if (!this.audio.isCapturing) return;
    if (this.audio.isPaused) {
      this.audio.resume();
      this._setPlayPauseIcon(true);
    } else {
      this.audio.pause();
      this._setPlayPauseIcon(false);
    }
  }

  _setPlayPauseIcon(isPlaying) {
    this.el.iconPlayPause.innerHTML = isPlaying
      ? '<rect x="5" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="15" y="4" width="4" height="16" rx="1" fill="currentColor"/>'
      : '<path d="M6 4l14 8-14 8V4z" fill="currentColor"/>';
  }

  _handleStop() {
    this.audio.stop();
    this.engine.stop();
    this.el.btnPlayPause.disabled = true;
    this.el.btnStop.disabled = true;
    this._setPlayPauseIcon(true);
    this.el.startOverlay.classList.remove('hidden');
    this.el.rVolume.textContent = '— %';
    this.el.rPeakFreq.textContent = '— Hz';
    this.el.rBpm.textContent = '—';
    this.el.rSampleRate.textContent = '— kHz';
    this.el.rLatency.textContent = '— ms';
    if (this.isRecording) this._toggleRecording();
  }

  /* ---------------- PER-FRAME UI UPDATES ---------------- */
  _onFrame() {
    const m = this.audio.metrics;
    this.el.rVolume.textContent = Math.round(m.volume) + ' %';
    this.el.rPeakFreq.textContent = Util.formatHz(m.peakFreq) + ' Hz';
    this.el.rFps.textContent = this.engine.fps || '—';
    this.el.rBpm.textContent = this.audio.bpm > 0 ? this.audio.bpm : '—';

    // Beat flash decay
    if (this.engine.beatFlashIntensity > 0) {
      this.engine.beatFlashIntensity *= 0.88;
      this.el.beatFlash.style.opacity = this.engine.beatFlashIntensity.toFixed(3);
      if (this.engine.beatFlashIntensity < 0.01) this.engine.beatFlashIntensity = 0;
    }
  }

  /** Lightweight tick that keeps idle UI (e.g. before capture starts) responsive without the heavy audio loop. */
  _idleRenderTick() {
    requestAnimationFrame(() => this._idleRenderTick());
  }

  /* ---------------- SETTINGS PANEL ---------------- */
  _bindSettingsPanel() {
    const open = () => {
      this.el.settingsPanel.classList.add('open');
      this.el.settingsScrim.classList.add('open');
    };
    const close = () => {
      this.el.settingsPanel.classList.remove('open');
      this.el.settingsScrim.classList.remove('open');
    };
    this.el.btnSettings.addEventListener('click', open);
    this.el.btnCloseSettings.addEventListener('click', close);
    this.el.settingsScrim.addEventListener('click', close);

    // FFT size
    this.el.selFftSize.addEventListener('change', (e) => {
      const size = parseInt(e.target.value, 10);
      this.audio.setFftSize(size);
      this.el.vFftSize.textContent = size;
    });

    // Bar count
    this.el.rngBarCount.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      this.settings.set('barCount', v);
      this.el.vBarCount.textContent = v;
    });

    // Peak hold
    this.el.rngPeakHold.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      this.settings.set('peakHoldTime', v);
      this.el.vPeakHold.textContent = v;
    });

    // Mirror mode
    this.el.chkMirror.addEventListener('change', (e) => {
      this.settings.set('mirrorMode', e.target.checked);
    });

    // Line width
    this.el.rngLineWidth.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      this.settings.set('lineWidth', v);
      this.el.vLineWidth.textContent = v.toFixed(1);
    });

    // Radius
    this.el.rngRadius.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      this.settings.set('radius', v);
      this.el.vRadius.textContent = v;
    });

    // Rotation speed
    this.el.rngRotSpeed.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      this.settings.set('rotationSpeed', v);
      this.el.vRotSpeed.textContent = v.toFixed(2);
    });

    // Particle count
    this.el.rngParticleCount.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      this.settings.set('particleCount', v);
      this.el.vParticleCount.textContent = v;
    });

    // Glow intensity
    this.el.rngGlow.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      this.settings.set('glowIntensity', v);
      this.el.vGlow.textContent = v;
    });

    // Background blur (applied to the .stage backdrop via CSS var)
    this.el.rngBgBlur.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      this.settings.set('bgBlur', v);
      this.el.vBgBlur.textContent = v;
      document.querySelector('.bg-glow').style.filter = `blur(${v * 2.2}px)`;
    });

    // Wave thickness (used by waveform mode as additional thickness multiplier)
    this.el.rngWaveThick.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      this.settings.set('waveThickness', v);
      this.el.vWaveThick.textContent = v.toFixed(1);
      this.settings.set('lineWidth', v);
      this.el.vLineWidth.textContent = v.toFixed(1);
      this.el.rngLineWidth.value = v;
    });
  }

  /* ---------------- FULLSCREEN ---------------- */
  _toggleFullscreen() {
    if (!document.fullscreenElement) {
      this.app.requestFullscreen().catch(() => { });
    } else {
      document.exitFullscreen().catch(() => { });
    }
  }

  /* ---------------- SCREENSHOT ---------------- */
  _takeScreenshot() {
    if (!this.audio.isCapturing) return;
    Util.downloadCanvasPNG(this.canvas, `signal-${this.engine.currentModeKey}-${Date.now()}.png`);
    this._flashToolbarButton(this.el.btnScreenshot);
  }

  _flashToolbarButton(btn) {
    btn.style.color = 'var(--accent)';
    setTimeout(() => { btn.style.color = ''; }, 300);
  }

  /* ---------------- RECORDING ---------------- */
  _toggleRecording() {
    if (!this.audio.isCapturing) return;
    if (this.isRecording) {
      this.mediaRecorder.stop();
      return;
    }
    const stream = this.canvas.captureStream(60);
    let mimeType = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

    this.mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    this.recordedChunks = [];

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.getElementById('downloadLink');
      link.href = url;
      link.download = `signal-recording-${Date.now()}.webm`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      this.isRecording = false;
      this.el.toolbar.classList.remove('recording');
    };

    this.mediaRecorder.start();
    this.isRecording = true;
    this.el.toolbar.classList.add('recording');
  }

  /* ---------------- KEYBOARD SHORTCUTS ---------------- */
  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Ignore shortcuts while typing in an input/select
      const tag = document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault();
          this._togglePause();
          break;
        case 'f':
          this._toggleFullscreen();
          break;
        case 's':
          this._takeScreenshot();
          break;
        case 'r':
          this._toggleRecording();
          break;
        case '1': this._setMode('spectrum'); break;
        case '2': this._setMode('waveform1'); break;
        case '3': this._setMode('waveform2'); break;
        case '4': this._setMode('circular'); break;
        case '5': this._setMode('linegraph1'); break;
        case '6': this._setMode('linegraph2'); break;
        case '7': this._setMode('particles'); break;
        case '8': this._setMode('orchestra1'); break;
        case '9': this._setMode('orchestra2'); break;
        default: break;
      }
    });
  }
}

/* ============================================================
   SECTION 8 — BOOTSTRAP
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  window.__signalApp = new UIController();
});
