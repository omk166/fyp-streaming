import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { browserConstraints, normalizePrefs, loadPrefs, savePrefs, compareSettings, readSettings, describe, DEFAULT_PREFS, STORAGE_KEY } from '../client/audio/modes.js';
import { createAudioTest } from '../audio-test.js';
import { encodeWav } from '../client/audio/dsp.js';

test('modes map onto browser constraints: Off and Ours turn everything off, Browser follows the switches', () => {
  const none = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  assert.deepEqual(browserConstraints({ mode: 'off', echo: true, noise: true }), none);
  assert.deepEqual(browserConstraints({ mode: 'ours', echo: true, noise: true }), none);
  assert.deepEqual(browserConstraints({ mode: 'browser', echo: true, noise: true }), { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  assert.deepEqual(browserConstraints({ mode: 'browser', echo: false, noise: true }), { echoCancellation: false, noiseSuppression: true, autoGainControl: true });
  assert.equal(DEFAULT_PREFS.mode, 'browser', 'default is the previous behaviour');
  assert.match(describe({ mode: 'ours', echo: true, noise: false }), /noise suppression off/);
});

test('saved choice is validated and storage failures never break the page', () => {
  const store = new Map(), storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(loadPrefs(storage), DEFAULT_PREFS);
  assert.ok(savePrefs(storage, { mode: 'ours', echo: false, noise: true, extra: 1 }));
  assert.deepEqual(JSON.parse(store.get(STORAGE_KEY)), { mode: 'ours', echo: false, noise: true });
  assert.deepEqual(loadPrefs(storage), { mode: 'ours', echo: false, noise: true });
  store.set(STORAGE_KEY, '{"mode":"loud","echo":"yes"}');
  assert.deepEqual(loadPrefs(storage), DEFAULT_PREFS);
  store.set(STORAGE_KEY, 'not json');
  assert.deepEqual(loadPrefs(storage), DEFAULT_PREFS);
  const broken = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.deepEqual(loadPrefs(broken), DEFAULT_PREFS); assert.equal(savePrefs(broken, DEFAULT_PREFS), false);
  assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS);
});

test('settings read-back reports ignored and unreported constraints', () => {
  const track = { getSettings: () => ({ echoCancellation: true, noiseSuppression: false }) };
  const reported = readSettings(track);
  assert.deepEqual(reported, { echoCancellation: true, noiseSuppression: false, autoGainControl: null });
  assert.deepEqual(compareSettings({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }, reported), { ignored: ['echoCancellation'], unreported: ['autoGainControl'] });
  assert.deepEqual(readSettings({ getSettings() { throw Error('ended'); } }), { echoCancellation: null, noiseSuppression: null, autoGainControl: null });
});

async function server(options) {
  const app = express();
  const auth = { getSession: req => (req.headers['x-test-session'] ? { hash: req.headers['x-test-session'] } : null), sameOrigin: req => req.headers.origin === 'http://test', requireSession: (_req, _res, next) => next() };
  app.use(createAudioTest({ auth, ...options }));
  const listener = app.listen(0); await new Promise(r => listener.once('listening', r));
  const url = `http://127.0.0.1:${listener.address().port}`;
  const post = (body, headers = {}) => fetch(`${url}/api/audio-test/transcribe`, { method: 'POST', body, headers: { 'x-test-session': 's1', origin: 'http://test', 'content-type': 'audio/wav', ...headers } });
  return { url, post, close: () => listener.close() };
}

test('recognition check endpoint: session, origin, configuration, format and rate limits', async () => {
  const calls = [];
  const transcribe = Object.assign(async (wav, options) => { calls.push({ bytes: wav.length, ...options }); return [{ text: ' hello ' }, { text: 'world' }, { bad: 1 }]; }, { enabled: true });
  const s = await server({ transcribe, maxRequests: 2 });
  try {
    const wav = Buffer.from(encodeWav(new Float32Array(16000), 16000));
    assert.equal((await s.post(wav, { 'x-test-session': '' })).status, 401);
    assert.equal((await s.post(wav, { origin: 'http://evil' })).status, 403);
    assert.equal((await s.post(wav, { 'content-type': 'application/json' })).status, 415);
    assert.equal((await s.post(wav, { 'x-speech-language': 'fr' })).status, 400);
    const ok = await s.post(wav, { 'x-speech-language': 'en' });
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { text: 'hello world' });
    assert.deepEqual(calls, [{ bytes: wav.length, language: 'en' }]);
    assert.equal((await s.post(Buffer.from(encodeWav(new Float32Array(16000), 48000)))).status, 400, 'only 16 kHz mono PCM');
    assert.equal((await s.post(Buffer.alloc(300000))).status, 429, 'over the per-session limit');
    assert.equal((await s.post(wav, { 'x-test-session': 's2' })).status, 200, 'other sessions unaffected');
    assert.equal((await s.post(Buffer.alloc(300000), { 'x-test-session': 's3' })).status, 413);
    const status = await fetch(`${s.url}/api/audio-test/status`, { headers: { 'x-test-session': 's1' } });
    assert.deepEqual(await status.json(), { transcription: true });
  } finally { s.close(); }
  const disabled = await server({ transcribe: Object.assign(async () => [], { enabled: false }) });
  try {
    assert.equal((await disabled.post(Buffer.from(encodeWav(new Float32Array(16000), 16000)))).status, 503);
  } finally { disabled.close(); }
});
