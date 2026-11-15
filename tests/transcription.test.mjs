import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscription, createTranscriber } from '../transcription.js';
import { wavBase64, exportTranscript } from '../client/transcription.js';

function fixture(transcribe = async () => [{ start: 0, end: 1, text: 'مرحبا hello' }]) {
  transcribe.enabled = true;
  const owner = { id: 'owner', username: 'Owner', role: 'owner' }, guest = { id: 'guest', username: 'Guest', role: 'guest' };
  const peers = new Set([owner, guest]), events = [];
  const room = createTranscription({ peers, transcribe, publish: (event, data) => events.push({ event, data }), now: () => 10000 });
  const data = () => ({ id: room.snapshot().id, seq: 0, offset: 0, wav: wavBase64(new Float32Array(64000).fill(0.1)) });
  return { room, owner, guest, peers, events, data };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('requires owner, unanimous consent and configured backend', () => {
  const f = fixture();
  try {
    assert.throws(() => f.room.request(f.guest));
    f.room.request(f.owner);
    assert.throws(() => f.room.audio(f.owner, f.data()), /consent/);
    f.room.consent(f.guest, f.room.snapshot().id, true);
    assert.equal(f.room.snapshot().phase, 'recording');
    assert.throws(() => f.room.audio({ id: 'outsider' }, f.data()));
    f.room.consent(f.guest, f.room.snapshot().id, false);
    assert.equal(f.room.snapshot().phase, 'idle');
  } finally { f.room.dispose(); }
  const disabled = createTranscriber({ url: '' });
  assert.equal(disabled.enabled, false);
});

test('broadcasts mixed text with server identity, validates WAV, rejects replay and mute', async () => {
  const f = fixture();
  try {
    f.room.request(f.owner); f.room.consent(f.guest, f.room.snapshot().id, true);
    assert.throws(() => f.room.audio(f.owner, { ...f.data(), wav: 'bad' }));
    f.owner.micMuted = true; assert.throws(() => f.room.audio(f.owner, f.data()), /Muted/); f.owner.micMuted = false;
    assert.deepEqual(f.room.audio(f.owner, { ...f.data(), username: 'Forged' }), { accepted: true });
    assert.throws(() => f.room.audio(f.owner, f.data()), /sequence/);
    await settle();
    const segment = f.events.find(e => e.event === 'transcriptSegment').data;
    assert.equal(segment.username, 'Owner'); assert.equal(segment.text, 'مرحبا hello');
    assert.equal(f.room.snapshot().segments.length, 1);
  } finally { f.room.dispose(); }
});

test('withdrawal cancels in-flight results, new arrival stops transcription', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    f.room.request(f.owner); f.room.consent(f.guest, f.room.snapshot().id, true);
    f.room.audio(f.owner, f.data()); await settle();
    f.room.consent(f.guest, f.room.snapshot().id, false);
    finish([{ start: 0, end: 1, text: 'late' }]); await settle();
    assert.equal(f.events.filter(e => e.event === 'transcriptSegment').length, 0);
    f.room.request(f.owner); f.room.consent(f.guest, f.room.snapshot().id, true);
    f.room.beforeJoin(); assert.equal(f.room.snapshot().phase, 'idle');
  } finally { f.room.dispose(); }
});

test('model timestamp overrun cannot discard a recognized sentence', async () => {
  const f = fixture(async () => [{ start: 1.08, end: 8.08, text: 'At the end we mentioned a green garden.' }]);
  try {
    f.room.request(f.owner); f.room.consent(f.guest, f.room.snapshot().id, true);
    f.room.audio(f.owner, f.data()); await settle();
    const entries = f.events.filter(e => e.event === 'transcriptSegment').map(e => e.data);
    assert.equal(entries.length, 1);
    assert.match(entries[0].text, /green garden/);
    assert.equal(entries[0].start, 1080); assert.equal(entries[0].end, 4000);
  } finally { f.room.dispose(); }
});

test('slow service queues consecutive speech and preserves every chunk in order', async () => {
  const calls = [], finish = [];
  const run = createTranscriber({ url: 'http://private/transcribe', fetcher: (_url, options) => {
    calls.push(options.body.toString()); return new Promise(resolve => finish.push(resolve));
  }, maxPending: 3 });
  const work = ['one', 'two', 'three'].map(text => run(Buffer.from(text)));
  await assert.rejects(run(Buffer.from('overflow')), /full/);
  await settle(); assert.deepEqual(calls, ['one']);
  for (let i = 0; i < 3; i++) {
    finish[i]({ ok: true, json: async () => ({ segments: [{ text: calls[i] }] }) });
    await settle();
  }
  assert.deepEqual((await Promise.all(work)).map(s => s[0].text), ['one', 'two', 'three']);
  assert.deepEqual(calls, ['one', 'two', 'three']);
});

test('withdrawal cancels queued inference before audio reaches worker', async () => {
  let finish; const calls = [];
  const run = createTranscriber({ url: 'http://private/transcribe', fetcher: (_url, options) => {
    calls.push(options.body.toString()); return new Promise(resolve => { finish = resolve; });
  } });
  const first = run(Buffer.from('first'));
  const controller = new AbortController();
  const queued = run(Buffer.from('cancelled'), { signal: controller.signal });
  const rejected = assert.rejects(queued, /cancelled/);
  await settle(); controller.abort();
  finish({ ok: true, json: async () => ({ segments: [] }) });
  await first; await rejected; assert.deepEqual(calls, ['first']);
});

test('normal stop accepts final audio then drains every job before ending', async () => {
  const finish = [];
  const f = fixture(() => new Promise(resolve => finish.push(resolve)));
  try {
    f.room.request(f.owner); f.room.consent(f.guest, f.room.snapshot().id, true);
    const id = f.room.snapshot().id;
    f.room.audio(f.owner, f.data()); await settle();
    f.room.stop(f.owner, id); assert.equal(f.room.snapshot().phase, 'finishing');
    f.room.audio(f.owner, { ...f.data(), seq: 1 }); await settle();
    f.room.flushed(f.owner, id); f.room.flushed(f.guest, id);
    finish[0]([{ start: 0, end: 1, text: 'first' }]); await settle();
    assert.equal(f.room.snapshot().phase, 'finishing');
    finish[1]([{ start: 0, end: 1, text: 'last' }]); await settle();
    assert.equal(f.room.snapshot().phase, 'idle');
    assert.deepEqual(f.room.snapshot().segments.map(s => s.text), ['first', 'last']);
  } finally { f.room.dispose(); }
});

test('TXT and SRT preserve mixed language and sort by speech time', () => {
  const entries = [{ start: 2000, end: 3100, username: 'B', text: 'hello' }, { start: 0, end: 1500, username: 'A', text: 'مرحبا' }];
  assert.match(exportTranscript(entries, 'txt'), /^\[00:00:00\] A: مرحبا/);
  assert.match(exportTranscript(entries, 'srt'), /1\n00:00:00,000 --> 00:00:01,500\nA: مرحبا/);
});
