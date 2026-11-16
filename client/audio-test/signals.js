// Generated test signals for the audio test page. Generated so they are identical on every machine and
// carry no third-party licence: a speech-like far-end clip (source-filter vowel synthesis with consonant
// bursts and pauses) and pink noise.
function random(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
// Two-pole resonator (formant filter) coefficients.
function resonator(freq, bandwidth, rate) {
  const r = Math.exp(-Math.PI * bandwidth / rate), theta = 2 * Math.PI * freq / rate;
  return { a1: 2 * r * Math.cos(theta), a2: -r * r, g: 1 - r };
}
const VOWELS = [[730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410], [300, 870, 2240], [660, 1720, 2410], [440, 1020, 2240]];

export function speechLikeClip(rate = 48000, seconds = 8, seed = 7) {
  const rnd = random(seed), n = Math.round(rate * seconds), out = new Float32Array(n);
  let t = 0, phase = 0, syllable = 0;
  const state = [[0, 0], [0, 0], [0, 0]];
  while (t < n) {
    const pause = syllable > 0 && syllable % 7 === 0;
    const length = Math.round(rate * (pause ? 0.25 + rnd() * 0.2 : 0.16 + rnd() * 0.14));
    const vowel = VOWELS[Math.floor(rnd() * VOWELS.length)], burst = pause ? 0 : Math.round(rate * (0.02 + rnd() * 0.04));
    const filters = vowel.map((f, i) => resonator(f, [80, 110, 160][i], rate));
    for (let i = 0; i < length && t < n; i++, t++) {
      if (pause) { out[t] = 0; continue; }
      const progress = t / n, f0 = 150 - 40 * progress + 12 * Math.sin(2 * Math.PI * (syllable / 7 + i / length) * 0.5);
      phase += f0 / rate;
      let source;
      if (i < burst) source = (rnd() * 2 - 1) * 0.4; // consonant-like noise burst
      else { const p = phase % 1; source = p < 0.4 ? Math.sin(Math.PI * p / 0.4) ** 2 : 0; source -= 0.25; } // glottal pulse
      let y = 0;
      filters.forEach((f, k) => { const s = state[k], v = f.g * source + f.a1 * s[0] + f.a2 * s[1]; s[1] = s[0]; s[0] = v; y += v / (k + 1); });
      const env = Math.min(1, i / (rate * 0.02), (length - i) / (rate * 0.03));
      out[t] = y * env;
    }
    syllable++;
  }
  return normalize(out, -20);
}

// Pink noise (Paul Kellet's filter) at the given RMS level in dBFS.
export function pinkNoise(rate = 48000, seconds = 10, levelDb = -30, seed = 3) {
  const rnd = random(seed), n = Math.round(rate * seconds), out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const white = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179; b1 = 0.99332 * b1 + white * 0.0750759; b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856; b4 = 0.55 * b4 + white * 0.5329522; b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362; b6 = white * 0.115926;
  }
  return normalize(out, levelDb);
}

export function normalize(samples, levelDb) {
  let sum = 0; for (const v of samples) sum += v * v;
  const rms = Math.sqrt(sum / samples.length) || 1, gain = 10 ** (levelDb / 20) / rms;
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return samples;
}

// The meeting transcription path averages 48 kHz audio down to 16 kHz in its AudioWorklet
// (public/transcription-worklet.js); the recognition check does the same so it hears what a meeting would.
export function averageTo16k(samples, rate) {
  const out = []; let sum = 0, count = 0, phase = 0;
  for (const value of samples) {
    sum += value; count++; phase += 16000;
    if (phase >= rate) { out.push(sum / count); sum = count = 0; phase -= rate; }
  }
  return Float32Array.from(out);
}
