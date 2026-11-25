// Joins overlapping windows' text the way the meeting page does, from speech/benchmark.py --save output,
// and, given a reference text, reports the word error rate of the joined text (against the joined text's
// best-matching start, so words past the end of the reference are not counted).
//   node scripts/merge-windows.mjs windows.json ["reference text"]
import { readFile } from 'node:fs/promises';
import { createMerger } from '../client/transcript-merge.js';

const windows = JSON.parse(await readFile(process.argv[2], 'utf8'));
const merger = createMerger();
const shown = windows.map((w, i) => merger.add(w.text, { ...w, continues: w.continues && i < windows.length - 1 }).text);
for (const [i, w] of windows.entries()) console.log(`window ${i + 1}: ${w.text}\n   shown: ${shown[i]}`);
const joined = shown.filter(Boolean).join(' ');
console.log(`\njoined: ${joined}`);

if (process.argv[3]) {
  const words = text => text.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const ref = words(process.argv[3]), hyp = words(joined);
  let row = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) { // edit distance from ref to every start of hyp
    const next = [i];
    for (let j = 1; j <= hyp.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    row = next;
  }
  const edits = Math.min(...row);
  console.log(`word error rate: ${(100 * edits / ref.length).toFixed(1)}% (${edits} edits over ${ref.length} reference words)`);
}
