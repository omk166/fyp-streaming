import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranscription } from '../transcription.js';
import { exportTranscript } from '../client/transcription.js';
import { createLocalSpeech, speechProblem } from '../client/local-speech.js';

function fixture(options = {}) {
  const owner = { id: 'owner', username: 'Owner', role: 'owner' }, guest = { id: 'guest', username: 'Guest', role: 'guest' };
  const peers = new Set([owner, guest]), events = [];
  const room = createTranscription({ peers, publish: (event, data) => events.push({ event, data }), now: () => 10000, ...options });
  const text = (seq = 0, value = 'مرحبا hello') => ({ id: room.snapshot().id, seq, offset: 0, duration: 4000, text: value });
  const start = () => { room.request(owner); room.consent(guest, room.snapshot().id, true); };
  return { room, owner, guest, peers, events, text, start };
}

test('requires the owner and everyone’s consent before accepting text', () => {
  const f = fixture();
  try {
    assert.throws(() => f.room.request(f.guest));
    f.room.request(f.owner);
    assert.throws(() => f.room.text(f.owner, f.text()), /consent/);
    f.room.consent(f.guest, f.room.snapshot().id, true);
    assert.equal(f.room.snapshot().phase, 'recording');
    assert.throws(() => f.room.text({ id: 'outsider' }, f.text()), /consent/);
    assert.throws(() => f.room.text(f.owner, { ...f.text(), id: 'old-session' }), /consent/);
    f.room.consent(f.guest, f.room.snapshot().id, false);
    assert.equal(f.room.snapshot().phase, 'idle');
    assert.throws(() => f.room.text(f.owner, f.text()), /consent/);
  } finally { f.room.dispose(); }
});

test('shares mixed text under the server identity and rejects replays and malformed segments', () => {
  const f = fixture();
  try {
    f.start();
    assert.deepEqual(f.room.text(f.owner, { ...f.text(), username: 'Forged', peerId: 'guest' }), { accepted: true });
    assert.throws(() => f.room.text(f.owner, f.text()), /sequence/, 'replayed sequence');
    assert.throws(() => f.room.text(f.owner, { ...f.text(1), offset: 999999 }), /sequence/, 'speech from the future');
    assert.throws(() => f.room.text(f.owner, { ...f.text(1), offset: -1 }), /sequence/);
    assert.throws(() => f.room.text(f.owner, { ...f.text(1), duration: 41000 }), /duration/);
    assert.throws(() => f.room.text(f.owner, f.text(1, '   ')), /text/);
    assert.throws(() => f.room.text(f.owner, f.text(1, 'x'.repeat(2001))), /text/);
    assert.throws(() => f.room.text(f.owner, { ...f.text(1), text: 42 }), /text/);
    const segment = f.events.find(e => e.event === 'transcriptSegment').data;
    assert.deepEqual(segment, { id: `${f.room.snapshot().id}:owner:0`, peerId: 'owner', username: 'Owner', start: 0, end: 4000, text: 'مرحبا hello' });
    assert.equal(f.room.snapshot().segments.length, 1);
    f.room.text(f.guest, f.text(5, ' second speaker ')); // sequences are per participant; gaps are skipped silence
    assert.deepEqual(f.room.snapshot().segments.map(s => [s.username, s.text]), [['Owner', 'مرحبا hello'], ['Guest', 'second speaker']]);
  } finally { f.room.dispose(); }
});

test('new arrival stops transcription and a fresh session starts clean', () => {
  const f = fixture();
  try {
    f.start(); f.room.text(f.owner, f.text());
    f.room.beforeJoin(); assert.equal(f.room.snapshot().phase, 'idle');
    f.start(); assert.deepEqual(f.room.snapshot().segments, []);
    assert.deepEqual(f.room.text(f.owner, f.text()), { accepted: true }, 'sequence numbers restart with the session');
  } finally { f.room.dispose(); }
});

test('normal stop waits for every computer to finish its remaining speech', () => {
  const f = fixture();
  try {
    f.start(); const id = f.room.snapshot().id;
    f.room.text(f.owner, f.text(0, 'first'));
    f.room.stop(f.owner, id); assert.equal(f.room.snapshot().phase, 'finishing');
    assert.ok(f.events.some(e => e.event === 'transcriptionFlush' && e.data.id === id));
    f.room.text(f.owner, f.text(1, 'late but captured before stop'));
    f.room.flushed(f.owner, id);
    assert.throws(() => f.room.text(f.owner, f.text(2, 'after flush')), /consent/);
    assert.equal(f.room.snapshot().phase, 'finishing');
    f.room.text(f.guest, f.text(0, 'guest last words'));
    f.room.flushed(f.guest, id);
    assert.equal(f.room.snapshot().phase, 'idle');
    assert.deepEqual(f.room.snapshot().segments.map(s => s.text), ['first', 'late but captured before stop', 'guest last words']);
  } finally { f.room.dispose(); }
});

test('a computer that never finishes cannot hold the session open', async () => {
  const f = fixture({ finishTimeoutMs: 20 });
  try {
    f.start(); const id = f.room.snapshot().id;
    f.room.stop(f.owner, id); f.room.flushed(f.owner, id);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.room.snapshot().phase, 'idle');
    assert.match(f.events.find(e => e.event === 'transcriptionWarning').data.message, /did not finish/);
  } finally { f.room.dispose(); }
});

test('a participant leaving while finishing does not block the end', () => {
  const f = fixture();
  try {
    f.start(); const id = f.room.snapshot().id;
    f.room.stop(f.owner, id); f.room.flushed(f.owner, id);
    f.peers.delete(f.guest); f.room.memberLeft(f.guest.id);
    assert.equal(f.room.snapshot().phase, 'idle');
  } finally { f.room.dispose(); }
});

test('local speech client: WAV upload, language hint and service problems', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url.endsWith('/transcribe')) return { ok: true, json: async () => ({ text: '  hello  ' }) };
    return { ok: true, json: async () => ({ status: 'ready', model: 'omniASR_LLM_1B_v2', device: 'mps (float16)' }) };
  };
  const speech = createLocalSpeech('http://127.0.0.1:8765', fetcher);
  assert.equal((await speech.status()).status, 'ready');
  assert.equal(await speech.transcribe(new Float32Array(16000), 'apc_Arab'), 'hello');
  const upload = calls.at(-1), wav = upload.body;
  assert.equal(upload.url, 'http://127.0.0.1:8765/transcribe');
  assert.equal(upload.headers['X-Speech-Language'], 'apc_Arab');
  assert.equal(Buffer.from(wav).toString('ascii', 0, 4), 'RIFF');
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 16000);
  assert.equal(wav.length, 44 + 32000);

  const failing = createLocalSpeech('http://127.0.0.1:8765', async () => ({ ok: false, status: 503, json: async () => ({ error: 'The speech model is still loading' }) }));
  await assert.rejects(failing.transcribe(new Float32Array(16000), 'auto'), /still loading/);
  // CORS refusal: the normal request fails but an opaque one reaches the service.
  const blocked = createLocalSpeech('http://127.0.0.1:8765', async (_url, options) => { if (options.mode !== 'no-cors') throw TypeError('Failed to fetch'); return {}; });
  assert.equal((await blocked.status()).status, 'blocked');
  const offline = createLocalSpeech('http://127.0.0.1:8765', async () => { throw TypeError('Failed to fetch'); });
  assert.equal((await offline.status()).status, 'offline');

  assert.equal(speechProblem({ status: 'ready' }), null);
  assert.match(speechProblem({ status: 'loading' }), /still loading/);
  assert.match(speechProblem({ status: 'blocked' }, 'http://127.0.0.1:8765', 'https://meet.example'), /--allow-origin https:\/\/meet\.example/);
  assert.match(speechProblem({ status: 'offline' }, 'http://127.0.0.1:8765'), /npm run speech/);
});

test('TXT and SRT preserve mixed language and sort by speech time', () => {
  const entries = [{ start: 2000, end: 3100, username: 'B', text: 'hello' }, { start: 0, end: 1500, username: 'A', text: 'مرحبا' }];
  assert.match(exportTranscript(entries, 'txt'), /^\[00:00:00\] A: مرحبا/);
  assert.match(exportTranscript(entries, 'srt'), /1\n00:00:00,000 --> 00:00:01,500\nA: مرحبا/);
});
