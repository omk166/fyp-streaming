import test from 'node:test';
import assert from 'node:assert/strict';
import { RealFFT, Downsampler, Upsampler, DelayLine, SampleFifo, estimateDelay, meanSquare, powerDb, speechToNoise, wordErrorRate, encodeWav, decodeWav, summarize, RESAMPLE_DELAY_48K } from '../client/audio/dsp.js';
import { DtlnAec, DTLN_BLOCK, DTLN_SHIFT, DTLN_DELAY_SAMPLES } from '../client/audio/dtln-aec.js';
import { OursEngine } from '../client/audio/engine.js';
import { speechLikeClip, pinkNoise, averageTo16k } from '../client/audio-test/signals.js';

let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
const noise = (n, amp = 0.1) => Float32Array.from({ length: n }, () => amp * rnd());
const sine = (n, freq, rate, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * freq * i / rate));
const rms = (x, from = 0) => Math.sqrt(meanSquare(x, from));
const inChunks = (proc, input, sizes) => {
  const parts = []; let i = 0, k = 0;
  while (i < input.length) { const n = sizes[k++ % sizes.length]; parts.push(proc.process(input.subarray(i, i + n))); i += n; }
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
};

test('real FFT matches a direct DFT and inverts exactly (numpy rfft/irfft semantics)', () => {
  const n = 64, x = noise(n, 1), fft = new RealFFT(n), re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
  fft.forward(x, re, im);
  for (let k = 0; k <= n / 2; k++) {
    let r = 0, i = 0; for (let t = 0; t < n; t++) { r += x[t] * Math.cos(2 * Math.PI * k * t / n); i -= x[t] * Math.sin(2 * Math.PI * k * t / n); }
    assert.ok(Math.abs(re[k] - r) < 1e-9 && Math.abs(im[k] - i) < 1e-9);
  }
  const back = new Float32Array(n); fft.inverse(re, im, back);
  for (let t = 0; t < n; t++) assert.ok(Math.abs(back[t] - x[t]) < 1e-6);
});

test('48 kHz -> 16 kHz -> 48 kHz resampling keeps speech-band tones, rejects aliases and streams consistently', () => {
  const tone = sine(48000, 1000, 48000);
  const down = new Downsampler().process(tone);
  assert.equal(down.length, 16000);
  assert.ok(Math.abs(rms(down, 1000) - rms(tone)) / rms(tone) < 0.01, 'passband gain within 1%');
  const alias = new Downsampler().process(sine(48000, 12000, 48000)); // would fold to 4 kHz
  assert.ok(powerDb(meanSquare(alias, 1000)) - powerDb(meanSquare(tone)) < -50, 'stopband below -50 dB');
  const chunked = inChunks(new Downsampler(), tone, [128, 7, 480, 1, 333]);
  assert.equal(chunked.length, down.length);
  for (let i = 0; i < down.length; i++) assert.ok(Math.abs(chunked[i] - down[i]) < 1e-6);
  const up = new Upsampler().process(down);
  assert.equal(up.length, 48000);
  assert.ok(Math.abs(rms(up, 3000) - rms(tone)) / rms(tone) < 0.02);
  const upChunked = inChunks(new Upsampler(), down, [42, 160, 1, 128]);
  for (let i = 0; i < up.length; i++) assert.ok(Math.abs(upChunked[i] - up[i]) < 1e-6);
  assert.equal(RESAMPLE_DELAY_48K, 47.5);
});

test('GCC-PHAT finds a known delay; delay line and FIFO behave', () => {
  const x = noise(16000), lag = 123, y = new Float32Array(16000);
  for (let i = lag; i < y.length; i++) y[i] = 0.5 * x[i - lag];
  const found = estimateDelay(x, y, 800);
  assert.equal(found.lag, lag); assert.ok(found.confidence > 20);
  const line = new DelayLine(100); line.setDelay(10);
  const out = line.process(Float32Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(out[9], 0); assert.equal(out[10], 1); assert.equal(out[29], 20);
  const fifo = new SampleFifo(4); fifo.push(Float32Array.of(1, 2, 3)); fifo.push(Float32Array.of(4, 5, 6));
  assert.deepEqual([...fifo.shift(4)], [1, 2, 3, 4]); assert.equal(fifo.length, 2);
});

test('speech-to-noise estimate uses the silent lead-in as the noise reference', () => {
  const rate = 16000, n = rate * 6, x = noise(n, 0.001 * Math.sqrt(3)); // about -60 dBFS
  for (let i = rate * 3; i < n; i++) if (Math.floor(i / 4000) % 2 === 0) x[i] += 0.1 * Math.sqrt(2) * Math.sin(2 * Math.PI * 300 * i / rate); // -20 dBFS bursts
  const r = speechToNoise(x, rate, 3);
  assert.ok(Math.abs(r.snrDb - 40) < 1.5, `snr ${r.snrDb}`);
  assert.equal(speechToNoise(noise(rate * 6, 0.01), rate, 3).snrDb, null, 'no speech, no estimate');
});

test('word error rate counts substitutions, deletions and insertions after normalisation', () => {
  assert.equal(wordErrorRate('Hello, World!', 'hello world').wer, 0);
  const counts = (a, b) => { const r = wordErrorRate(a, b); return [r.substitutions, r.deletions, r.insertions]; };
  assert.deepEqual(counts('a b c', 'a x c'), [1, 0, 0]);
  assert.deepEqual(counts('a b c', 'a c'), [0, 1, 0]);
  assert.deepEqual(counts('a b c', 'a b x c'), [0, 0, 1]);
  assert.equal(wordErrorRate('the cat sat on the mat', 'the bat sat on mat today').wer, 0.5);
  assert.equal(wordErrorRate("I'm here", 'Im here').substitutions, 1);
  assert.equal(wordErrorRate('', 'anything'), null);
});

test('WAV encoding round-trips and timing summaries are ordered', () => {
  const x = sine(1600, 440, 16000, 0.4), back = decodeWav(encodeWav(x, 16000));
  assert.equal(back.rate, 16000); assert.equal(back.samples.length, x.length);
  for (let i = 0; i < x.length; i++) assert.ok(Math.abs(back.samples[i] - x[i]) < 1 / 16000);
  const s = summarize([5, 1, 3, 2, 4]);
  assert.deepEqual([s.p50, s.max, s.mean], [3, 5, 3]);
});

// A fake runtime: the mask passes everything and model 2 returns its block scaled for 4x overlap-add.
const fakeModels = { stateSize1: 4, stateSize2: 4, run1: async (mag, states) => ({ mask: new Float32Array(mag.length).fill(1), states }), run2: async (block, states) => ({ block: block.map(v => v * DTLN_SHIFT / DTLN_BLOCK), states }) };

test('DTLN-aec framing follows run_aec.py: 512/128 blocks and a 384-sample (24 ms) output delay', async () => {
  assert.equal(DTLN_DELAY_SAMPLES, 384);
  const aec = new DtlnAec(fakeModels), x = noise(DTLN_SHIFT * 40), out = [];
  for (let i = 0; i < x.length; i += DTLN_SHIFT) out.push(...await aec.process(x.subarray(i, i + DTLN_SHIFT), new Float32Array(DTLN_SHIFT)));
  for (let i = 384; i < x.length; i++) assert.ok(Math.abs(out[i] - x[i - 384]) < 1e-5);
});

test('engine measures its own delay from the streams and lines the far-end reference up with its echo', async () => {
  // AEC stage with the fake model: the measured chain delay is DTLN's 24 ms plus two resampling filters.
  const engine = new OursEngine({ aec: new DtlnAec(fakeModels), now: () => 0 });
  const mic = noise(48000 * 4, 0.2);
  for (let i = 0; i < mic.length; i += 128) await engine.process(mic.subarray(i, i + 128), new Float32Array(128));
  const expected = 24 + 2 * RESAMPLE_DELAY_48K / 48;
  assert.ok(Math.abs(engine.stats().chainDelay.ms - expected) < 0.5, `chain ${engine.stats().chainDelay.ms} vs ${expected}`);

  // Pass-through noise stage: no added delay, output length tracks the input in whole frames.
  const ns = new OursEngine({ ns: { frameLength: 480, process: f => f.slice() }, now: () => 0 });
  let produced = 0;
  for (let i = 0; i < mic.length; i += 128) produced += (await ns.process(mic.subarray(i, i + 128), null)).length;
  assert.equal(produced, Math.floor(mic.length / 480) * 480);
  assert.ok(Math.abs(ns.stats().chainDelay.ms) < 0.1);

  // Echo 60 ms behind the reference: the reference ends up delayed by 60 - 4 ms.
  const ref = noise(48000 * 5, 0.2), echoed = new Float32Array(ref.length), d = 0.06 * 48000;
  for (let i = d; i < ref.length; i++) echoed[i] = 0.4 * ref[i - d];
  const aecEngine = new OursEngine({ aec: new DtlnAec(fakeModels), now: () => 0 });
  for (let i = 0; i < ref.length; i += 128) await aecEngine.process(echoed.subarray(i, i + 128), ref.subarray(i, i + 128));
  const stats = aecEngine.stats();
  assert.equal(stats.refDelaySource, 'measured echo path');
  assert.ok(Math.abs(stats.echoPath.ms - 60) < 0.5 && Math.abs(stats.refDelayMs - 56) < 0.5, JSON.stringify(stats));
});

test('generated test signals are deterministic and at their stated levels', () => {
  const clip = speechLikeClip(48000, 2), again = speechLikeClip(48000, 2);
  assert.equal(clip.length, 96000); assert.deepEqual(clip.slice(0, 50), again.slice(0, 50));
  assert.ok(Math.abs(powerDb(meanSquare(clip)) + 20) < 0.01);
  assert.ok(Math.abs(powerDb(meanSquare(pinkNoise(48000, 1, -30))) + 30) < 0.01);
  assert.equal(averageTo16k(new Float32Array(48000), 48000).length, 16000);
});
