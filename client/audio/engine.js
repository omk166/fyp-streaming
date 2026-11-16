// The "Ours" processing chain, independent of where it runs (a Worker during calls and test-page runs,
// Node in unit tests).
//
//   mic 48 kHz ─► [AEC stage: 48k→16k, DTLN-aec 128, 16k→48k] ─► [NS stage: DeepFilterNet3 at 48k] ─► out 48 kHz
//   far-end reference 48 kHz ─► 48k→16k ─► delay line (playout latency compensation) ─┘ (second AEC input)
//
// Sample rates: the call path, the AudioContext and Opus stay at 48 kHz. DTLN-aec only exists at 16 kHz,
// so the AEC stage resamples explicitly (Kaiser-windowed sinc FIR, factor 3, cut-off 7.2 kHz; see dsp.js).
// With echo cancellation on, the microphone signal is therefore limited to that band (below 8 kHz).
// DeepFilterNet3 runs natively at 48 kHz, so noise suppression alone keeps the full band.
import { Downsampler, Upsampler, SampleFifo, DelayLine, estimateDelay, meanSquare, powerDb, summarize } from './dsp.js';
import { DTLN_SHIFT, DTLN_RATE } from './dtln-aec.js';

const RATE = 48000;
const HISTORY = 2 * DTLN_RATE; // 2 s of 16 kHz audio kept for the delay estimators
const WINDOW = DTLN_RATE; // each estimate correlates the newest 1 s
export const MAX_REF_DELAY_MS = 400;

// Keeps the newest samples of a stream together with their absolute sample index.
class History {
  constructor(size) { this.fifo = new SampleFifo(size * 2); this.size = size; this.total = 0; }
  push(samples) {
    this.fifo.push(samples); this.total += samples.length;
    if (this.fifo.length > this.size) this.fifo.shift(this.fifo.length - this.size);
  }
  get first() { return this.total - this.fifo.length; }
  // Samples with absolute indices [start, end).
  range(start, end) {
    const f = this.fifo, from = start - this.first;
    return f.data.subarray(f.start + from, f.start + from + (end - start));
  }
}

export class OursEngine {
  // aec: DtlnAec | null; ns: DeepFilter | null; initialRefDelayMs: compensation used until the echo path is measured.
  // schedule: how the once-a-second delay measurement runs. Inline by default (offline runs, tests); the live
  // worker defers it so its large FFTs never delay a chunk of audio on its way back to the call.
  constructor({ aec = null, ns = null, initialRefDelayMs = 0, now = () => performance.now(), adaptRefDelay = true, schedule = run => run() } = {}) {
    Object.assign(this, { aec, ns, now, adaptRefDelay, schedule });
    this.micDown = new Downsampler(); this.refDown = new Downsampler(); this.up = new Upsampler();
    this.mic16 = new SampleFifo(); this.ref16 = new SampleFifo(); this.stage2 = new SampleFifo(); this.out = new SampleFifo();
    this.refDelay = new DelayLine(Math.round(MAX_REF_DELAY_MS * DTLN_RATE / 1000));
    this.refDelay.setDelay(initialRefDelayMs * DTLN_RATE / 1000);
    this.refDelaySource = initialRefDelayMs ? 'browser-reported playout latency' : 'none';
    this.times = { aec: [], ns: [] }; this.busy = 0; this.audioMs = 0;
    // Down-sampled copies of the chain's input and output (for its delay), and of the AEC's two inputs (echo path).
    this.inDown = new Downsampler(); this.outDown = new Downsampler();
    this.inHist = new History(HISTORY); this.outHist = new History(HISTORY);
    this.micHist = new History(HISTORY); this.refHist = new History(HISTORY);
    this.chainDelay = null; this.echoPath = null; this.refCandidates = []; this.sinceMeasure = 0;
  }
  // mic, ref: Float32Array at 48 kHz of equal length (any length). Returns processed 48 kHz samples (may be empty).
  async process(mic, ref) {
    const started = this.now();
    let stageInput = mic;
    if (this.aec) {
      const m16 = this.micDown.process(mic), r16 = this.refDown.process(ref || new Float32Array(mic.length));
      this.micHist.push(m16); this.refHist.push(r16);
      this.mic16.push(m16); this.ref16.push(this.refDelay.process(r16));
      const produced = new SampleFifo();
      while (this.mic16.length >= DTLN_SHIFT) {
        const t = this.now();
        produced.push(await this.aec.process(this.mic16.shift(DTLN_SHIFT), this.ref16.shift(DTLN_SHIFT)));
        this.record(this.times.aec, this.now() - t);
      }
      stageInput = this.up.process(produced.shift(produced.length));
    }
    this.stage2.push(stageInput);
    if (this.ns) {
      const hop = this.ns.frameLength;
      while (this.stage2.length >= hop) {
        const t = this.now();
        this.out.push(this.ns.process(this.stage2.shift(hop)));
        this.record(this.times.ns, this.now() - t);
      }
    } else if (this.stage2.length) this.out.push(this.stage2.shift(this.stage2.length));
    const output = this.out.shift(this.out.length);
    this.inHist.push(this.inDown.process(mic));
    if (output.length) this.outHist.push(this.outDown.process(output));
    this.busy += this.now() - started; this.audioMs += mic.length / RATE * 1000;
    this.sinceMeasure += mic.length;
    if (this.sinceMeasure >= RATE) {
      this.sinceMeasure = 0;
      this.schedule(() => { const t = this.now(); this.measure(); this.busy += this.now() - t; });
    }
    return output;
  }
  record(list, value) { list.push(value); if (list.length > 3000) list.splice(0, list.length - 3000); }
  // Once per second of audio. Both measurements compare equal absolute sample indices, so the lag found
  // is the stream delay itself, not including samples that are merely waiting in a queue.
  measure() {
    // Chain (algorithmic) delay: output sample k vs input sample k. Needs audible input and output.
    const end = this.outHist.total, start = Math.max(this.outHist.first, this.inHist.first, end - WINDOW);
    if (end - start >= DTLN_RATE) {
      const a = this.inHist.range(start, end), b = this.outHist.range(start, end);
      if (powerDb(meanSquare(a)) > -55 && powerDb(meanSquare(b)) > -60) {
        const { lag, confidence } = estimateDelay(a, b, Math.round(0.25 * DTLN_RATE));
        if (confidence > 8) this.chainDelay = { ms: lag / DTLN_RATE * 1000, confidence: Math.round(confidence), atMs: Math.round(this.audioMs) };
      }
    }
    if (!this.aec || !this.adaptRefDelay) return;
    // Echo path: how far the echo in the microphone trails the far-end reference we tapped before playout.
    const e2 = Math.min(this.micHist.total, this.refHist.total), s2 = Math.max(this.micHist.first, this.refHist.first, e2 - WINDOW);
    if (e2 - s2 < DTLN_RATE) return;
    const ref = this.refHist.range(s2, e2), mic = this.micHist.range(s2, e2);
    if (powerDb(meanSquare(ref)) < -50) return;
    const { lag, confidence } = estimateDelay(ref, mic, Math.round(MAX_REF_DELAY_MS * DTLN_RATE / 1000));
    if (confidence < 10) return;
    this.echoPath = { ms: lag / DTLN_RATE * 1000, confidence: Math.round(confidence), atMs: Math.round(this.audioMs) };
    this.refCandidates.push(lag); if (this.refCandidates.length > 3) this.refCandidates.shift();
    const sorted = [...this.refCandidates].sort((x, y) => x - y);
    // Three consistent estimates (within 10 ms): delay the reference so it stays 4 ms ahead of its echo.
    if (sorted.length === 3 && sorted[2] - sorted[0] <= DTLN_RATE * 0.01) {
      this.refDelay.setDelay(Math.max(0, sorted[1] - DTLN_RATE * 0.004));
      this.refDelaySource = 'measured echo path';
    }
  }
  stats() {
    return {
      aec: this.aec ? summarize(this.times.aec) : null, ns: this.ns ? summarize(this.times.ns) : null,
      aecBlockMs: DTLN_SHIFT / DTLN_RATE * 1000, nsHopMs: this.ns ? this.ns.frameLength / RATE * 1000 : null,
      busyRatio: this.audioMs ? this.busy / this.audioMs : null, processedMs: Math.round(this.audioMs),
      chainDelay: this.chainDelay, echoPath: this.echoPath,
      refDelayMs: this.aec ? this.refDelay.delay / DTLN_RATE * 1000 : null, refDelaySource: this.aec ? this.refDelaySource : null,
    };
  }
}
