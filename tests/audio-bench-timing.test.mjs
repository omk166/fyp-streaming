import test from 'node:test';
import assert from 'node:assert/strict';
import { timingSlip } from '../scripts/audio-bench-timing.mjs';

const RATE = 48000, PRE = 2.5;
function noise(seconds, seed = 7) {
  let s = seed >>> 0; const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = (s / 4294967296 - 0.5) * 0.2; }
  return out;
}
// The capture as the benchmark gets it: the input from sample `start` on (start < 0: leading silence), `length` long.
function captureOf(input, start, length) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) { const j = i + start; out[i] = j >= 0 && j < input.length ? input[j] : 0; }
  return out;
}

test('a capture with one fixed delay has no slip, whether it lags or leads its input', () => {
  const input = noise(12);
  for (const start of [-0.15 * RATE, 0.08 * RATE, 2 * RATE]) {
    const { slipMs, segments } = timingSlip(input, captureOf(input, start, input.length + RATE / 2), PRE);
    assert.equal(slipMs, 0, `start ${start}`);
    assert.ok(segments >= 8, `start ${start}: ${segments} segments`);
  }
});

test('a 20 ms skip partway through is measured', () => {
  const input = noise(12), lagged = captureOf(input, -0.1 * RATE, input.length + RATE / 2);
  const skipAt = 8 * RATE, skip = 0.02 * RATE;
  const skipped = new Float32Array(lagged.length);
  skipped.set(lagged.subarray(0, skipAt)); skipped.set(lagged.subarray(skipAt + skip), skipAt);
  const { slipMs } = timingSlip(input, skipped, PRE);
  assert.ok(Math.abs(slipMs - 20) <= 0.2, `slip ${slipMs} ms`);
});

test('silence cannot be measured', () => {
  const input = noise(12);
  assert.deepEqual(timingSlip(input, new Float32Array(input.length), PRE), { slipMs: null, segments: 0 });
});
