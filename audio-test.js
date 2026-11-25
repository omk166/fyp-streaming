// Audio test page (/audio-test). The page keeps all audio in the browser. Its optional recognition check sends
// speech segments (mono 16 kHz WAV, at most 8 s each) to the speech service on the tester's own computer
// (speech/service.py), the same recognizer live transcription uses; nothing goes to this server.
import express from 'express';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('./public/audio-test.html', import.meta.url));
// /call-bench plays the call benchmark's playlist into a meeting app and records what arrives (all in the browser).
const CALL_PAGE = fileURLToPath(new URL('./public/call-bench.html', import.meta.url));
const csp = speechService => `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ${speechService}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;

export function createAudioTest({ auth, speechService }) {
  const router = express.Router();
  router.get('/audio-test', auth.requireSession, (_req, res) => res.set('Content-Security-Policy', csp(speechService)).sendFile(PAGE));
  router.get('/call-bench', auth.requireSession, (_req, res) => res.set('Content-Security-Policy', csp(speechService)).sendFile(CALL_PAGE));
  router.get('/api/audio-test/status', (req, res) => {
    if (!auth.getSession(req)) return res.status(401).json({ error: 'Please log in or continue as guest.' });
    res.set('Cache-Control', 'no-store').json({ speechService });
  });
  return router;
}
