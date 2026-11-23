// The speech service on this computer (speech/service.py, Omnilingual ASR). Audio goes there over loopback and
// never to the meeting server. Used by the meeting page and the audio test page.
import { encodeWav } from './audio/dsp.js';

export function createLocalSpeech(url, fetcher = (...args) => fetch(...args)) {
  return {
    url,
    async status() {
      try {
        const response = await fetcher(`${url}/health`, { cache: 'no-store' });
        const body = await response.json().catch(() => ({}));
        return response.ok ? body : { status: 'blocked', error: body.error };
      } catch {
        // A refused cross-origin request and a stopped service look the same to fetch; an opaque request tells them apart.
        const running = await fetcher(`${url}/health`, { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false);
        return { status: running ? 'blocked' : 'offline' };
      }
    },
    async transcribe(samples, language, signal) {
      const response = await fetcher(`${url}/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Speech-Language': language }, body: encodeWav(samples, 16000), signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(body.error || `the speech service answered HTTP ${response.status}`);
      return typeof body.text === 'string' ? body.text.trim() : '';
    },
  };
}

// What to tell the user about the local service, or null when it is ready.
export function speechProblem(health, url, origin) {
  switch (health.status) {
    case 'ready': return null;
    case 'loading': return 'The speech model on this computer is still loading (its first start downloads the model, 1.2 GiB by default). Try again once it is ready.';
    case 'failed': return `The speech model on this computer failed to load: ${health.error || 'see the speech service window'}.`;
    case 'blocked': return `The speech service on this computer does not accept this site. Restart it with: npm run speech -- --allow-origin ${origin}`;
    default: return `No speech service is running on this computer (${url}). Transcription runs on your own computer: start it with "npm run speech" (see speech/README.md).`;
  }
}
