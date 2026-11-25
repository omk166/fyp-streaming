// Double-talk test for the audio test page. The far end talks in alternating windows (silent, talking, silent, …)
// while the tester keeps reading. Comparing the output level in the two kinds of window shows what the echo
// canceller does to the tester's voice while the far end talks over it:
//   about 0 dB          voice kept, and little echo added on top of it
//   clearly below 0 dB  voice turned down during double talk (the canceller suppresses too much)
//   above 0 dB          echo coming through on top of the voice (the Off run shows how much echo there is)
import { meanSquare, powerDb } from '../audio/dsp.js';

// Seconds: silent lead-in, start of the far-end signal, window length, number of windows, tail.
export const DOUBLE_TALK = Object.freeze({ lead: 1.5, start: 2.5, window: 1.5, windows: 10, tail: 0.5 });
export const doubleTalkSeconds = (p = DOUBLE_TALK) => p.start + p.window * p.windows + p.tail;

// The far-end signal: `clip` kept only in windows 1, 3, 5, … (window 0 is silent), with 20 ms fades.
export function gateFarEnd(clip, rate, p = DOUBLE_TALK) {
  const w = Math.round(p.window * rate), out = new Float32Array(w * p.windows), fade = Math.round(0.02 * rate);
  for (let i = 1; i < p.windows; i += 2) {
    for (let j = 0; j < w; j++) {
      const k = i * w + j;
      if (k >= clip.length) break;
      out[k] = clip[k] * Math.min(1, j / fade, (w - 1 - j) / fade);
    }
  }
  return out;
}

// Output level in the far-end windows against the silent ones, over the span in which the tester was reading.
// playedAt: recording time (s) at which the far-end signal started playing.
// shift: echo path delay plus the mode's processing delay (s), so windows line up with what the microphone heard.
// floorDb: level of the output's silent lead-in; speech must be 10 dB above it (and above -55 dBFS) to count.
export function doubleTalkLevels(out, rate, { playedAt, shift = 0, floorDb = -100, guard = 0.25, p = DOUBLE_TALK }) {
  if (playedAt === null || playedAt === undefined) return { error: 'the far end did not play' };
  const threshold = Math.max(floorDb + 10, -55), frame = Math.round(0.02 * rate), windows = [];
  for (let i = 0; i < p.windows; i++) {
    const s = Math.round((playedAt + shift + i * p.window + guard) * rate), e = Math.round((playedAt + shift + (i + 1) * p.window - guard) * rate);
    if (s < 0 || e > out.length) break;
    let active = 0, frames = 0;
    for (let k = s; k + frame <= e; k += frame, frames++) if (powerDb(meanSquare(out, k, k + frame)) > threshold) active++;
    windows.push({ index: i, farEnd: i % 2 === 1, power: meanSquare(out, s, e), active: frames ? active / frames : 0 });
  }
  // Reading span: from the first to the last silent window in which the tester was speaking.
  const speaking = windows.filter(w => !w.farEnd && w.active >= 0.3);
  if (speaking.length < 2) return { error: 'too little of your voice was found while the far end was silent (keep reading until the test ends)' };
  const first = speaking[0].index, last = speaking.at(-1).index;
  const span = windows.filter(w => w.index >= first && w.index <= last);
  const alone = span.filter(w => !w.farEnd), overlap = span.filter(w => w.farEnd);
  if (!overlap.length) return { error: 'you stopped reading before the far end talked over you' };
  const mean = list => list.reduce((sum, w) => sum + w.power, 0) / list.length;
  const aloneDb = powerDb(mean(alone)), overlapDb = powerDb(mean(overlap));
  return { aloneDb, overlapDb, changeDb: overlapDb - aloneDb, aloneWindows: alone.length, overlapWindows: overlap.length };
}
