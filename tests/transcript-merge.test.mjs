import test from 'node:test';
import assert from 'node:assert/strict';
import { createMerger, sameWord } from '../client/transcript-merge.js';

const overlap = { overlapSamples: 16000, samples: 64000 };

test('overlapping windows show each word once and replace a cut-off word with the whole one', () => {
  const merger = createMerger();
  const shown = [
    merger.add('we are testing the me', { seq: 0, continues: true }),
    merger.add('ting the meeting transcription system every', { seq: 1, ...overlap, continues: true }),
    merger.add('system every participant runs', { seq: 2, ...overlap }),
  ];
  assert.deepEqual(shown.map(s => s.text), ['we are testing the', 'meeting transcription system', 'every participant runs']);
  assert.deepEqual(shown.map(s => s.joined), [false, true, true]);
  assert.equal(shown.map(s => s.text).join(' '), 'we are testing the meeting transcription system every participant runs');
});

test('a fragment the next window does not repeat is dropped', () => {
  const merger = createMerger();
  assert.equal(merger.add('hello my friend t', { seq: 0, continues: true }).text, 'hello my friend');
  assert.equal(merger.add('my friend today we go', { seq: 1, ...overlap }).text, 'today we go');
});

test('Arabic text lines up the same way', () => {
  const merger = createMerger();
  assert.equal(merger.add('مرحبا كيف حالك', { seq: 0, continues: true }).text, 'مرحبا كيف');
  assert.equal(merger.add('كيف حالك اليوم', { seq: 1, ...overlap }).text, 'حالك اليوم');
});

test('when nothing lines up, the held word is kept and nothing is dropped', () => {
  const merger = createMerger();
  assert.equal(merger.add('alpha beta gamma', { seq: 0, continues: true }).text, 'alpha beta');
  assert.equal(merger.add('xxx yyy zzz www', { seq: 1, ...overlap }).text, 'gamma xxx yyy zzz www');
});

test('words the previous window left out at its cut are kept (Arabic, LLM 1B)', () => {
  const merger = createMerger();
  assert.equal(merger.add('الزمني للاسابيع القادمة', { seq: 0, continues: true }).text, 'الزمني للاسابيع');
  assert.equal(merger.add('ارجو من الجميع مراجعة التقرير قبل', { seq: 1, ...overlap }).text, 'القادمة ارجو من الجميع مراجعة التقرير قبل');
});

test('the same speech heard as different words is matched by its letters', () => {
  const merger = createMerger();
  assert.equal(merger.add('قبل يوم الخميس وإرسال ملاحقين', { seq: 0, continues: true }).text, 'قبل يوم الخميس وإرسال');
  assert.equal(merger.add('و الرسالة ملاحظاتكم إلى الفريق شكرا لكم', { seq: 1, ...overlap }).text, 'إلى الفريق شكرا لكم');
});

test('Arabic spelling variants count as the same word', () => {
  assert.ok(sameWord('أرجو', 'ارجو'));
  assert.ok(sameWord('للأسابيع', 'للاسابيع'));
  assert.ok(sameWord('الفريقُ', 'الفريق'));
});

test('the last window at stop, made only of the overlap, releases the held word', () => {
  const merger = createMerger();
  assert.equal(merger.add('one two three', { seq: 0, continues: true }).text, 'one two');
  assert.equal(merger.add('two three', { seq: 1, overlapSamples: 16000, samples: 16000 }).text, 'three');
});

test('a skipped window, a pause or a reset means nothing to line up with', () => {
  const merger = createMerger();
  merger.add('a b c', { seq: 0, continues: true });
  assert.deepEqual(merger.add('c d e', { seq: 2, ...overlap }), { text: 'c d e', joined: false });
  merger.add('f g h', { seq: 3 });
  assert.equal(merger.add('h i j', { seq: 4, ...overlap }).text, 'h i j');
  merger.add('k l m', { seq: 5, continues: true }); merger.reset();
  assert.equal(merger.add('m n o', { seq: 6, ...overlap }).text, 'm n o');
});

test('word matching tolerates cut words and one-letter slips, not different words', () => {
  assert.ok(sameWord('me', 'meeting'));
  assert.ok(sameWord('Participent', 'participant,'));
  assert.ok(!sameWord('cat', 'cut'), 'short words one letter apart are different words');
  assert.ok(!sameWord('t', 'today'));
  assert.ok(!sameWord('speech', 'model'));
});
