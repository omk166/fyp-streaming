// Small, dependency-free signal processing used by our audio pipeline and the audio test page.
// Everything here is plain JS so it runs in the page, in a Worker and in Node unit tests.

// ---- FFT (radix-2, complex, in place). Sizes must be powers of two.
const fftCache = new Map();
function fftTables(n) {
  if (fftCache.has(n)) return fftCache.get(n);
  if (n < 2 || (n & (n - 1))) throw Error(`FFT size must be a power of two, got ${n}`);
  const rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0, bits = Math.log2(n); i < n; i++) {
    let r = 0; for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  const tables = { rev, cos, sin }; fftCache.set(n, tables); return tables;
}
export function fftInPlace(re, im, inverse = false) {
  const n = re.length, { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = inverse ? -sin[k * step] : sin[k * step];
        const a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
// numpy.fft.rfft / irfft equivalents for one real block.
export class RealFFT {
  constructor(n) { this.n = n; this.re = new Float64Array(n); this.im = new Float64Array(n); }
  forward(input, outRe, outIm) {
    const { n, re, im } = this;
    for (let i = 0; i < n; i++) { re[i] = input[i]; im[i] = 0; }
    fftInPlace(re, im);
    for (let k = 0; k <= n / 2; k++) { outRe[k] = re[k]; outIm[k] = im[k]; }
  }
  inverse(inRe, inIm, output) {
    const { n, re, im } = this;
    for (let k = 0; k <= n / 2; k++) { re[k] = inRe[k]; im[k] = inIm[k]; }
    // Hermitian symmetry; like numpy, the imaginary parts of DC and Nyquist are ignored.
    im[0] = 0; im[n / 2] = 0;
    for (let k = 1; k < n / 2; k++) { re[n - k] = inRe[k]; im[n - k] = -inIm[k]; }
    fftInPlace(re, im, true);
    for (let i = 0; i < n; i++) output[i] = re[i];
  }
}

// ---- Resampling between the 48 kHz call path and the 16 kHz echo canceller.
// A windowed-sinc low-pass FIR (Kaiser window) shared by a factor-3 decimator and interpolator.
function bessel0(x) { let sum = 1, term = 1; for (let k = 1; k < 30; k++) { term *= (x / (2 * k)) ** 2; sum += term; } return sum; }
export function designLowpass(taps, cutoff, beta = 8) {
  // cutoff: fraction of the *input* Nyquist frequency (0..1).
  const h = new Float32Array(taps), mid = (taps - 1) / 2, norm = bessel0(beta);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - mid, sinc = t === 0 ? cutoff : Math.sin(Math.PI * cutoff * t) / (Math.PI * t);
    const w = bessel0(beta * Math.sqrt(Math.max(0, 1 - (t / mid) ** 2))) / norm;
    h[i] = sinc * w; sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum; // unity gain at DC
  return h;
}
export const RESAMPLE_FACTOR = 3; // 48000 / 16000
export const RESAMPLE_TAPS = 96;
// Cut-off at 7.2 kHz (0.3 of 24 kHz): well inside the 8 kHz Nyquist of the 16 kHz side.
const lowpass = designLowpass(RESAMPLE_TAPS, 0.3);
// Group delay of one FIR pass, in 48 kHz samples. Each direction adds this once.
export const RESAMPLE_DELAY_48K = (RESAMPLE_TAPS - 1) / 2;

// Streaming 48 kHz -> 16 kHz: low-pass, then keep every third sample (phase carried across calls).
export class Downsampler {
  constructor() { this.history = new Float32Array(RESAMPLE_TAPS - 1); this.next = 0; }
  process(input) {
    const h = lowpass, taps = h.length, hist = this.history;
    const buf = new Float32Array(hist.length + input.length); buf.set(hist); buf.set(input, hist.length);
    const count = this.next < input.length ? Math.floor((input.length - 1 - this.next) / RESAMPLE_FACTOR) + 1 : 0;
    const out = new Float32Array(count);
    for (let j = 0, i = this.next; j < count; j++, i += RESAMPLE_FACTOR) {
      let acc = 0; const end = i + taps - 1;
      for (let k = 0; k < taps; k++) acc += h[k] * buf[end - k];
      out[j] = acc;
    }
    this.next = this.next + count * RESAMPLE_FACTOR - input.length;
    this.history = buf.slice(buf.length - hist.length);
    return out;
  }
}
export class Upsampler {
  constructor() { this.history = new Float32Array(Math.ceil(RESAMPLE_TAPS / RESAMPLE_FACTOR)); }
  process(input) {
    // Zero-stuffing followed by the low-pass, computed per output phase (polyphase).
    const h = lowpass, taps = h.length, L = RESAMPLE_FACTOR, hist = this.history, hl = hist.length;
    const buf = new Float32Array(hl + input.length); buf.set(hist); buf.set(input, hl);
    const out = new Float32Array(input.length * L);
    for (let n = 0; n < input.length; n++) {
      for (let p = 0; p < L; p++) {
        let acc = 0;
        for (let k = p; k < taps; k += L) acc += h[k] * buf[hl + n - (k - p) / L];
        out[n * L + p] = acc * L;
      }
    }
    this.history = buf.slice(buf.length - hl);
    return out;
  }
}

// ---- A growable FIFO of float samples.
export class SampleFifo {
  constructor(capacity = 4096) { this.data = new Float32Array(capacity); this.start = 0; this.length = 0; }
  push(samples) {
    const need = this.length + samples.length;
    if (this.start + need > this.data.length) {
      const grown = new Float32Array(Math.max(need * 2, this.data.length));
      grown.set(this.data.subarray(this.start, this.start + this.length)); this.data = grown; this.start = 0;
    }
    this.data.set(samples, this.start + this.length); this.length += samples.length;
  }
  shift(count) {
    const out = this.data.slice(this.start, this.start + count);
    this.start += count; this.length -= count;
    if (!this.length) this.start = 0;
    return out;
  }
  clear() { this.start = 0; this.length = 0; }
}

// ---- A fixed delay line (used to line the far-end reference up with its echo).
export class DelayLine {
  constructor(maxDelay) { this.buffer = new Float32Array(maxDelay + 1); this.write = 0; this.delay = 0; }
  setDelay(samples) { this.delay = Math.max(0, Math.min(this.buffer.length - 1, Math.round(samples))); }
  process(input) {
    const out = new Float32Array(input.length), buf = this.buffer, size = buf.length;
    for (let i = 0; i < input.length; i++) {
      buf[this.write] = input[i];
      out[i] = buf[(this.write - this.delay + size) % size];
      this.write = (this.write + 1) % size;
    }
    return out;
  }
}

// ---- Delay estimation: GCC-PHAT cross-correlation.
// Returns the lag (in samples, >= 0) by which `delayed` trails `reference`, and a confidence
// (correlation peak divided by the mean absolute correlation over the searched lags).
export function estimateDelay(reference, delayed, maxLag) {
  const n = Math.min(reference.length, delayed.length);
  let size = 1; while (size < 2 * n) size <<= 1;
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  for (let i = 0; i < n; i++) { ar[i] = reference[i]; br[i] = delayed[i]; }
  fftInPlace(ar, ai); fftInPlace(br, bi);
  // cross-spectrum conj(A) * B, PHAT weighted
  for (let k = 0; k < size; k++) {
    const re = ar[k] * br[k] + ai[k] * bi[k], im = ar[k] * bi[k] - ai[k] * br[k];
    const mag = Math.hypot(re, im) || 1;
    ar[k] = re / mag; ai[k] = im / mag;
  }
  fftInPlace(ar, ai, true);
  let best = -Infinity, lag = 0, sum = 0;
  const limit = Math.min(maxLag, n - 1);
  for (let l = 0; l <= limit; l++) { const v = ar[l]; sum += Math.abs(v); if (v > best) { best = v; lag = l; } }
  const mean = sum / (limit + 1) || 1e-12;
  return { lag, confidence: best / mean };
}

// ---- Level and quality helpers for the test page.
export function meanSquare(samples, start = 0, end = samples.length) {
  let sum = 0; const s = Math.max(0, start), e = Math.min(samples.length, end);
  for (let i = s; i < e; i++) sum += samples[i] * samples[i];
  return e > s ? sum / (e - s) : 0;
}
export const powerDb = power => 10 * Math.log10(Math.max(power, 1e-12));
export const rmsDbfs = (samples, start, end) => powerDb(meanSquare(samples, start, end));
// Echo return loss enhancement: how much quieter the processed signal is than the unprocessed one.
export function erleDb(unprocessedPower, processedPower) { return powerDb(unprocessedPower) - powerDb(processedPower); }
// Frame energies in dB (20 ms frames by default).
export function frameLevels(samples, rate, frameMs = 20) {
  const size = Math.round(rate * frameMs / 1000), out = [];
  for (let i = 0; i + size <= samples.length; i += size) out.push(rmsDbfs(samples, i, i + size));
  return out;
}
// A simple speech-to-noise estimate. The first `leadInSeconds` are a silent lead-in (noise only);
// speech frames are the frames after it that are at least 6 dB above that noise level.
// SNR = 10 log10((P_speech+noise - P_noise) / P_noise). Returns null when it cannot be estimated.
export function speechToNoise(samples, rate, leadInSeconds) {
  const leadEnd = Math.round(leadInSeconds * rate), skip = Math.round(0.25 * rate);
  if (samples.length < leadEnd + rate) return null;
  const noise = meanSquare(samples, skip, leadEnd - skip);
  const size = Math.round(rate * 0.02); let speech = 0, frames = 0, total = 0;
  for (let i = leadEnd; i + size <= samples.length; i += size) {
    total++;
    const p = meanSquare(samples, i, i + size);
    if (p > noise * 4) { speech += p; frames++; }
  }
  if (!frames || frames < total * 0.1) return { snrDb: null, noiseDb: powerDb(noise), speechFrames: frames, frames: total };
  const speechPower = speech / frames;
  return { snrDb: powerDb(Math.max(speechPower - noise, 1e-12)) - powerDb(noise || 1e-12), noiseDb: powerDb(noise), speechDb: powerDb(speechPower), speechFrames: frames, frames: total };
}

// ---- Word error rate against a reference script.
export function normalizeWords(text) {
  return String(text).toLowerCase().normalize('NFKC')
    .replace(/[‘’]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, ' ').split(/\s+/).filter(Boolean);
}
export function wordErrorRate(reference, hypothesis) {
  const ref = normalizeWords(reference), hyp = normalizeWords(hypothesis);
  if (!ref.length) return null;
  // Levenshtein over words, keeping the substitution / deletion / insertion counts.
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => ({ cost: j, s: 0, d: 0, i: j }));
  for (let r = 1; r <= ref.length; r++) {
    const row = [{ cost: r, s: 0, d: r, i: 0 }];
    for (let h = 1; h <= hyp.length; h++) {
      const same = ref[r - 1] === hyp[h - 1], diag = prev[h - 1], up = prev[h], left = row[h - 1];
      const options = [
        { cost: diag.cost + (same ? 0 : 1), s: diag.s + (same ? 0 : 1), d: diag.d, i: diag.i },
        { cost: up.cost + 1, s: up.s, d: up.d + 1, i: up.i },
        { cost: left.cost + 1, s: left.s, d: left.d, i: left.i + 1 },
      ];
      row.push(options.reduce((a, b) => (b.cost < a.cost ? b : a)));
    }
    prev = row;
  }
  const end = prev[hyp.length];
  return { wer: end.cost / ref.length, substitutions: end.s, deletions: end.d, insertions: end.i, referenceWords: ref.length, hypothesisWords: hyp.length };
}

// ---- Percentile summary of timing samples (milliseconds).
export function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) };
}

// ---- WAV encoding (16-bit PCM, mono) for downloads and the recognition check.
export function encodeWav(samples, rate) {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const word = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  word(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return bytes;
}
export function decodeWav(buffer) {
  const view = new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  const text = (o, n) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + o, n));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw Error('Not a WAV file');
  let offset = 12, format = null, data = null;
  while (offset + 8 <= view.byteLength) {
    const id = text(offset, 4), size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') format = { channels: view.getUint16(offset + 10, true), rate: view.getUint32(offset + 12, true), bits: view.getUint16(offset + 22, true), type: view.getUint16(offset + 8, true) };
    if (id === 'data') data = { offset: offset + 8, size };
    offset += 8 + size + (size & 1);
  }
  if (!format || !data) throw Error('Incomplete WAV file');
  const frames = Math.floor(data.size / (format.bits / 8) / format.channels), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const at = data.offset + i * format.channels * (format.bits / 8);
    out[i] = format.type === 3 ? view.getFloat32(at, true) : format.bits === 16 ? view.getInt16(at, true) / 32768 : view.getInt32(at, true) / 2147483648;
  }
  return { samples: out, rate: format.rate };
}
