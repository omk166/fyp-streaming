// Joins overlapping windows' text the way the meeting page does, from speech/benchmark.py --save output,
// and, given a reference text, reports the word error rate of the joined text (against the joined text's
// best-matching start, so words past the end of the reference are not counted). It also reports the
// character error rate. Both texts are normalized first: punctuation and Arabic diacritics/tatweel are
// removed and Arabic letter variants unified (أ إ آ → ا, ى → ي, ة → ه), so spelling conventions don't count.
//   node scripts/merge-windows.mjs windows.json ["reference text" | reference.txt]
import { readFile } from 'node:fs/promises';
import { createMerger } from '../client/transcript-merge.js';

const windows = JSON.parse(await readFile(process.argv[2], 'utf8'));
const merger = createMerger();
const shown = windows.map((w, i) => merger.add(w.text, { ...w, continues: w.continues && i < windows.length - 1 }).text);
for (const [i, w] of windows.entries()) console.log(`window ${i + 1}: ${w.text}\n   shown: ${shown[i]}`);
const joined = shown.filter(Boolean).join(' ');
console.log(`\njoined: ${joined}`);

// Edit distance from ref to the best-matching start of hyp.
function edits(ref, hyp) {
  let row = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const next = [i];
    for (let j = 1; j <= hyp.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    row = next;
  }
  return Math.min(...row);
}
const normalize = text => text.toLocaleLowerCase()
  .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ');
const words = text => normalize(text).split(/\s+/).filter(Boolean);

if (process.argv[3]) {
  const reference = process.argv[3].endsWith('.txt') ? await readFile(process.argv[3], 'utf8') : process.argv[3];
  const ref = words(reference), hyp = words(joined);
  const wordEdits = edits(ref, hyp), refChars = [...ref.join(' ')], charEdits = edits(refChars, [...hyp.join(' ')]);
  console.log(`word error rate: ${(100 * wordEdits / ref.length).toFixed(1)}% (${wordEdits} edits over ${ref.length} reference words)`);
  console.log(`character error rate: ${(100 * charEdits / refChars.length).toFixed(1)}% (${charEdits} edits over ${refChars.length} reference characters)`);
}
