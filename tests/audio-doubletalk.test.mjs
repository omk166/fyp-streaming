import test from 'node:test';
import assert from 'node:assert/strict';
import { DOUBLE_TALK, doubleTalkSeconds, gateFarEnd, doubleTalkLevels } from '../client/audio-test/doubletalk.js';

const RATE = 16000;
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; }; }
// A take: silent lead-in, then a "voice" (noise at 0.1 RMS-ish) from `speechFrom` to `speechTo` seconds;
// during far-end windows the voice is multiplied by `duck` and `echo` (uncorrelated noise) is added.
function take({ playedAt = 2.5, shift = 0, speechFrom = 1.8, speechTo = doubleTalkSeconds(), duck = 1, echo = 0, seed = 1 }) {
  const n = Math.round(doubleTalkSeconds() * RATE), out = new Float32Array(n), a = rng(seed), b = rng(seed + 9);
  for (let i = 0; i < n; i++) {
    const t = i / RATE, w = Math.floor((t - playedAt - shift) / DOUBLE_TALK.window), farEnd = w >= 0 && w < DOUBLE_TALK.windows && w % 2 === 1;
    const voice = t >= speechFrom && t < speechTo ? 0.17 * a() : 0.0005 * a();
    out[i] = farEnd ? voice * duck + echo * b() : voice;
  }
  return out;
}
const db = v => 20 * Math.log10(v);

test('far-end signal is silent in even windows and keeps the clip in odd ones', () => {
  const clip = new Float32Array(DOUBLE_TALK.window * DOUBLE_TALK.windows * RATE).fill(0.5), gated = gateFarEnd(clip, RATE);
  const w = DOUBLE_TALK.window * RATE;
  assert.equal(gated.length, clip.length);
  assert.equal(gated[Math.round(0.5 * w)], 0, 'window 0 silent');
  assert.equal(gated[Math.round(1.5 * w)], 0.5, 'window 1 kept');
  assert.equal(gated[Math.round(2.5 * w)], 0, 'window 2 silent');
  assert.ok(gated[w] < 0.01 && gated[2 * w - 1] < 0.03, 'fades at the window edges');
});

test('a kept voice reads about 0 dB, a ducked voice reads its attenuation', () => {
  const kept = doubleTalkLevels(take({}), RATE, { playedAt: 2.5, floorDb: -66 });
  assert.ok(Math.abs(kept.changeDb) < 0.6, `kept: ${kept.changeDb}`);
  assert.ok(kept.aloneWindows >= 4 && kept.overlapWindows >= 4);
  const ducked = doubleTalkLevels(take({ duck: 10 ** (-6 / 20) }), RATE, { playedAt: 2.5, floorDb: -66 });
  assert.ok(Math.abs(ducked.changeDb + 6) < 0.7, `ducked: ${ducked.changeDb}`);
});

test('echo on top of the voice reads as a level increase', () => {
  // Echo at the voice's level doubles the power: +3 dB.
  const r = doubleTalkLevels(take({ echo: 0.17 }), RATE, { playedAt: 2.5, floorDb: -66 });
  assert.ok(Math.abs(r.changeDb - 3) < 0.7, `echo: ${r.changeDb}`);
});

test('windows follow the echo and processing delay', () => {
  const out = take({ duck: 10 ** (-10 / 20), shift: 0.3 });
  const aligned = doubleTalkLevels(out, RATE, { playedAt: 2.5, shift: 0.3, floorDb: -66 });
  assert.ok(Math.abs(aligned.changeDb + 10) < 1, `aligned: ${aligned.changeDb}`);
  // Off by half a window, the two kinds of window mix and the difference shrinks towards 0.
  const wrong = doubleTalkLevels(out, RATE, { playedAt: 2.5, shift: 0.3 + DOUBLE_TALK.window / 2, floorDb: -66 });
  assert.ok(Math.abs(wrong.changeDb) < Math.abs(aligned.changeDb) - 5, `misaligned: ${wrong.changeDb}`);
});

test('only the span in which the tester was reading counts', () => {
  // Stops reading after 9 s: later far-end windows (with only silence or echo) must not count as ducking.
  const r = doubleTalkLevels(take({ speechTo: 9 }), RATE, { playedAt: 2.5, floorDb: -66 });
  assert.ok(Math.abs(r.changeDb) < 0.8, `stopped early: ${r.changeDb}`);
  assert.ok(r.overlapWindows < 5);
  assert.match(doubleTalkLevels(take({ speechFrom: 30 }), RATE, { playedAt: 2.5, floorDb: -66 }).error, /too little of your voice/);
  assert.match(doubleTalkLevels(take({}), RATE, { playedAt: null }).error, /did not play/);
  assert.ok(db(0.17) > -55, 'test voice is above the activity threshold');
});
