// Audio test page (/audio-test) and its recognition check endpoint.
// The page keeps all audio in the browser. The only upload is the explicit recognition check, which sends
// speech segments (mono 16 kHz WAV, at most 8 s each) through the same transcriber queue meetings use.
// Nothing is stored here; the speech worker processes audio in memory (see speech/README.md).
import express from 'express';
import { fileURLToPath } from 'node:url';
import { isSpeechWav } from './transcription.js';

const PAGE = fileURLToPath(new URL('./public/audio-test.html', import.meta.url));
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export function createAudioTest({ auth, transcribe, now = Date.now, windowMs = 10 * 60 * 1000, maxRequests = 120 }) {
  const router = express.Router(), usage = new Map(), busy = new Set();
  router.get('/audio-test', auth.requireSession, (_req, res) => res.set('Content-Security-Policy', CSP).sendFile(PAGE));
  router.get('/api/audio-test/status', (req, res) => {
    if (!auth.getSession(req)) return res.status(401).json({ error: 'Please log in or continue as guest.' });
    res.set('Cache-Control', 'no-store').json({ transcription: Boolean(transcribe.enabled) });
  });
  router.post('/api/audio-test/transcribe', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const session = auth.getSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in or continue as guest.' });
    if (!auth.sameOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Please send this from the audio test page.' });
    if (!transcribe.enabled) return res.status(503).json({ error: 'Transcription is not configured on this server.' });
    if (!req.is('audio/wav')) return res.status(415).json({ error: 'A WAV request is required.' });
    const language = req.get('X-Speech-Language') || 'en';
    if (!['auto', 'en', 'ar'].includes(language)) return res.status(400).json({ error: 'Choose Arabic and/or English.' });
    const key = session.hash, at = now();
    let entry = usage.get(key);
    if (!entry || at > entry.until) { entry = { count: 0, until: at + windowMs }; usage.set(key, entry); }
    if (usage.size > 10000) for (const [k, v] of usage) if (at > v.until) usage.delete(k);
    if (++entry.count > maxRequests) return res.status(429).json({ error: 'Too many recognition requests. Try again later.' });
    if (busy.has(key)) return res.status(429).json({ error: 'One recognition request at a time, please.' });
    busy.add(key); res.on('close', () => busy.delete(key));
    req.audioTest = { language };
    next();
  }, express.raw({ type: 'audio/wav', limit: 256044 }), async (req, res) => {
    const { language } = req.audioTest;
    if (!isSpeechWav(req.body)) return res.status(400).json({ error: 'Expected mono 16 kHz PCM WAV of 0.1 to 8 seconds.' });
    try {
      const segments = await transcribe(req.body, { language });
      const text = segments.filter(s => typeof s?.text === 'string').map(s => s.text.trim()).filter(Boolean).join(' ').slice(0, 4000);
      res.json({ text });
    } catch (error) {
      res.status(502).json({ error: `Recognition failed: ${error.message}` });
    }
  });
  router.use('/api/audio-test', (error, _req, res, _next) => {
    res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: error.type === 'entity.too.large' ? 'Audio segment too large.' : 'Invalid request.' });
  });
  return router;
}
