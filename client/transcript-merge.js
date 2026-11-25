// Joins the text of overlapping speech windows (public/speech-buffer.js) without repeating words.
// When speech runs past a window, that window's last word may be cut in half, and the next window
// starts 1 s earlier and says the same words again. So a window that continues holds back its last
// word, and the next window's text is lined up against the end of the previous one: the repeated
// words are dropped, and the next window's (whole) copy of the held word is used instead.

// Arabic spellings the model varies between windows (hamza forms, alef maqsura, taa marbuta, diacritics,
// tatweel) count as the same letters.
const normal = word => word.toLocaleLowerCase()
  .replace(/[\u064B-\u0652\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[^\p{L}\p{N}]/gu, '');

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// Edit distance between all of `a` and the closest ending of `p`.
function endingDistance(p, a) {
  let row = new Array(p.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= p.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === p[j - 1] ? 0 : 1));
    row = next;
  }
  return row[p.length];
}

// Same spoken word in both windows: identical, one is the cut-off start of the other, or one letter apart.
export function sameWord(x, y) {
  const a = normal(x), b = normal(y);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 2 && (a.startsWith(b) || b.startsWith(a))) return true;
  return Math.min(a.length, b.length) >= 4 && distance(a, b) <= 1;
}

// Where `next` (words of the following window) carries on after `previous` (all words of the window
// before, including its held-back last word): { keep: index of the first word of `next` to show, matched }.
export function continuation(previous, next) {
  let best = null;
  // dropLast 0: the held word was recognized again (keep the next window's copy, it is whole);
  // dropLast 1: it was a fragment the next window does not have. skip: a fragment at the next window's start.
  for (const dropLast of [0, 1]) {
    const tail = previous.slice(0, previous.length - dropLast).slice(-8);
    for (let k = Math.min(tail.length, next.length); k >= 1; k--) {
      if (best && k <= best.k) break;
      for (let skip = 0; skip <= 2 && skip + k <= next.length; skip++) {
        if (tail.slice(-k).every((word, i) => sameWord(word, next[skip + i]))) {
          best = { k, keep: dropLast ? skip + k : skip + k - 1 };
          break;
        }
      }
    }
  }
  if (best) return { keep: best.keep, matched: true };
  // The same speech heard as different words ("وإرسال ملاحقين", then "و الرسالة ملاحظاتكم"): compare letters.
  // The next window's first 1-4 words repeat the end of the previous one when their letters (at least 8) are
  // within 45% edits of it. Measured on Arabic windows: repeats 33-42%, windows sharing no audio 50% or more.
  const ending = previous.slice(-6).map(normal).join('');
  let close = null;
  for (let d = 1; d <= Math.min(4, next.length); d++) {
    const head = next.slice(0, d).map(normal).join('');
    if (head.length < 8) continue;
    const ratio = endingDistance(ending, head) / head.length;
    if (ratio <= 0.45 && (!close || ratio <= close.ratio)) close = { keep: d, ratio };
  }
  if (close) return { keep: close.keep, matched: true };
  // Nothing lines up: the previous window most likely stopped short of the overlap (the decoder often
  // leaves out speech cut at a window's end), so show all of this one rather than lose words.
  return { keep: 0, matched: false };
}

export function createMerger() {
  let previous = null; // { seq, words, held } of the last window, when the next one may overlap it
  return {
    // One window's recognized text, in order: { text to show ('' for none), joined: lined up with the window before }.
    add(text, { seq, overlapSamples = 0, continues = false }) {
      const words = text.split(/\s+/).filter(Boolean);
      let fresh = words, carried = [];
      const joined = Boolean(overlapSamples && previous && previous.seq === seq - 1);
      if (joined) {
        const { keep, matched } = continuation(previous.words, words);
        // If nothing lined up, the held word may not be in this window: show it rather than lose it.
        if (!matched && previous.held) carried = [previous.held];
        fresh = words.slice(keep);
      }
      const shown = [...carried, ...fresh];
      const held = continues && shown.length ? shown.pop() : null;
      previous = continues ? { seq, words, held } : null;
      return { text: shown.join(' '), joined };
    },
    // A window was skipped or failed: its neighbour cannot be lined up with it.
    reset() { previous = null; },
  };
}
