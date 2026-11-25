// Timing check for scripts/audio-bench.mjs. A live capture should be its input delayed by one fixed amount. A skip in
// Chrome's capture (seen with Chrome's own processing: about 20 ms dropped mid-clip) or an underrun in Ours's playout
// shifts everything after it, which is not what the benchmark measures but makes STOI and SDR read far too low. So the
// delay is measured one second at a time (GCC-PHAT at 16 kHz) over the scored part, against the input file.
import { Downsampler, estimateDelay, meanSquare, powerDb } from '../client/audio/dsp.js';

const RATE16 = 16000;
const down16 = x => new Downsampler().process(x);

// input: the 48 kHz file the fake microphone played. output: the 48 kHz capture. scoredFrom: seconds of the input
// before scoring starts (the pre-roll), which is also the most the capture can lead its input by.
// Returns { slipMs, segments }: slipMs = how far the delay moved (null if under 2 segments could be measured).
export function timingSlip(input, output, scoredFrom) {
  const a = down16(input), pad = Math.round(scoredFrom * RATE16);
  // Pad the capture so it always lags the input (estimateDelay only looks at positive lags).
  const b = new Float32Array(pad + Math.ceil(output.length / 3)); b.set(down16(output), pad);
  const global = estimateDelay(a, b.subarray(0, a.length + pad), pad + RATE16).lag;
  const seg = RATE16, margin = 0.25 * RATE16, devs = [];
  for (let u = pad; u + seg <= a.length; u += seg) {
    const start = u + global - margin;
    if (start < 0 || start + seg > b.length) continue;
    const ref = a.subarray(u, u + seg), cap = b.subarray(start, start + seg);
    if (powerDb(meanSquare(ref)) < -60 || powerDb(meanSquare(cap)) < -60) continue;  // silent (Ours removes noise-only parts)
    const { lag, confidence } = estimateDelay(ref, cap, 2 * margin);
    if (confidence > 8) devs.push(lag - margin);
  }
  if (devs.length < 2) return { slipMs: null, segments: devs.length };
  return { slipMs: (Math.max(...devs) - Math.min(...devs)) / RATE16 * 1000, segments: devs.length };
}
