import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { browserConstraints, normalizePrefs, loadPrefs, savePrefs, compareSettings, readSettings, describe, DEFAULT_PREFS, STORAGE_KEY } from '../client/audio/modes.js';
import { createAudioTest } from '../audio-test.js';

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
  const auth = { getSession: req => (req.headers['x-test-session'] ? { hash: req.headers['x-test-session'] } : null), requireSession: (_req, _res, next) => next() };
  app.use(createAudioTest({ auth, ...options }));
  const listener = app.listen(0); await new Promise(r => listener.once('listening', r));
  return { url: `http://127.0.0.1:${listener.address().port}`, close: () => listener.close() };
}

test('audio test page: recognition goes to the local speech service, never this server', async () => {
  const s = await server({ speechService: 'http://127.0.0.1:8765' });
  try {
    assert.equal((await fetch(`${s.url}/api/audio-test/status`)).status, 401);
    const status = await fetch(`${s.url}/api/audio-test/status`, { headers: { 'x-test-session': 's1' } });
    assert.deepEqual(await status.json(), { speechService: 'http://127.0.0.1:8765' });
    const page = await fetch(`${s.url}/audio-test`, { headers: { 'x-test-session': 's1' } });
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self' http:\/\/127\.0\.0\.1:8765;/);
    assert.equal((await fetch(`${s.url}/api/audio-test/transcribe`, { method: 'POST', headers: { 'x-test-session': 's1' } })).status, 404, 'no server-side recognition endpoint');
  } finally { s.close(); }
});
