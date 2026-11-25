// Uses a fake local speech service (same HTTP/CORS contract as speech/service.py); verifies wiring, not accuracy.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTestRoom } from './test-room.mjs';

const temp = await mkdtemp(join(tmpdir(), 'fyp-transcription-'));
const base = 'http://127.0.0.1:3197';
let requests = 0, status = 'loading', browser, app, logs = '';
const origins = new Set(), languages = new Set();
const speech = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin === base) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Speech-Language');
    res.statusCode = 204; return res.end();
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify({ status, ready: status === 'ready', model: 'fake-omniASR', device: 'test', languageHints: false }));
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const wav = Buffer.concat(chunks);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000);
  requests++; origins.add(origin); languages.add(req.headers['x-speech-language']);
  // A different ending each time, like real windows: the page drops words that overlapping windows repeat.
  res.end(JSON.stringify({ text: `مرحبا hello ${requests}` }));
});
await new Promise(resolve => speech.listen(0, '127.0.0.1', resolve));
try {
  app = spawn(process.execPath, ['server.js'], { env: { ...process.env,
    HOST: '127.0.0.1', PORT: '3197', MEDIA_PORT: '41997', SCREEN_PEN: '0', AUTH_DB_PATH: join(temp, 'auth.sqlite'),
    LOCAL_SPEECH_URL: `http://127.0.0.1:${speech.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', data => { logs += data; }); app.stderr.on('data', data => { logs += data; });
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + '/health').then(r => r.ok).catch(() => false)) break;
    if (app.exitCode !== null) throw Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu'] });
  const room = await createTestRoom(browser, base, 'Transcript test'), errors = [];
  const guest = await browser.newContext();
  assert.equal((await guest.request.post(base + '/api/auth/guest', { headers: { Origin: base }, data: { name: 'Guest' } })).status(), 201);
  const hostPage = await room.context.newPage(), guestPage = await guest.newPage();
  for (const page of [hostPage, guestPage]) {
    page.on('pageerror', e => errors.push(e.message));
    // Record what each page sends to the meeting server: text only, never audio.
    await page.addInitScript(() => {
      window.sentToServer = [];
      const NativeSocket = WebSocket;
      window.WebSocket = class extends NativeSocket {
        send(raw) { const { method, data } = JSON.parse(raw); window.sentToServer.push({ method, keys: Object.keys(data || {}) }); return super.send(raw); }
      };
    });
    await page.goto(`${base}/?synthetic=1&${room.query}${room.fragment}`);
    await page.locator('#join').click(); await page.waitForFunction(() => window.lab.joined);
  }
  const statusIs = (page, text) => page.waitForFunction(text => document.querySelector('#transcriptionStatus').textContent.includes(text), text);

  // A model that is still loading blocks the start, with the reason shown, and nobody is asked.
  await hostPage.locator('#controls [data-panel-open=captions]').click(); await hostPage.locator('#transcriptionStart').click();
  await hostPage.waitForFunction(() => document.querySelector('#transcriptionService').textContent.includes('still loading'));
  assert.equal(await guestPage.locator('#transcriptionConsent').isHidden(), true);

  status = 'ready';
  await hostPage.locator('#transcriptionStart').click();
  await guestPage.locator('#transcriptionConsent').waitFor({ state: 'visible' });
  assert.equal(requests, 0, 'no audio is recognized before everyone agrees');
  await guestPage.locator('#transcriptionDecline').click();
  await statusIs(hostPage, 'stopped');
  assert.equal(requests, 0);

  await hostPage.locator('#transcriptionStart').click();
  await guestPage.locator('#transcriptionAllow').click();
  for (const page of [hostPage, guestPage]) await page.waitForFunction(() => document.querySelector('#transcript').textContent.includes('مرحبا hello'), undefined, { timeout: 20000 });
  assert.ok(requests > 0);
  assert.deepEqual([...origins], [base], 'pages call the local service directly');
  assert.deepEqual([...languages], ['auto']);
  await hostPage.waitForFunction(() => document.querySelector('#transcriptionService').textContent.includes('fake-omniASR'));
  assert.match(await hostPage.locator('#transcriptionService').textContent(), /language choice does not change it/);
  const downloading = hostPage.waitForEvent('download'); await hostPage.locator('#transcript-txt').click();
  const download = await downloading; assert.match(await readFile(await download.path(), 'utf8'), /مرحبا hello/);

  // Withdrawal stops recognition at once.
  await guestPage.locator('#controls [data-panel-open=captions]').click(); await guestPage.locator('#transcriptionWithdraw').click();
  await statusIs(hostPage, 'stopped');
  const stopped = requests;
  await hostPage.waitForTimeout(4500); assert.equal(requests, stopped);

  // Normal stop: each computer finishes its remaining speech, then the session ends.
  await guestPage.locator('#transcriptionLanguage').selectOption('apc_Arab');
  await hostPage.locator('#transcriptionStart').click(); await guestPage.locator('#transcriptionAllow').click();
  await statusIs(guestPage, 'active');
  await hostPage.waitForFunction(() => document.querySelector('#transcript').textContent.includes('مرحبا hello'), undefined, { timeout: 20000 });
  await hostPage.locator('#transcriptionStop').click();
  for (const page of [hostPage, guestPage]) await statusIs(page, 'stopped');
  assert.ok(languages.has('apc_Arab'), 'each participant’s language hint reaches their own recognizer');

  for (const page of [hostPage, guestPage]) {
    assert.equal(await page.evaluate(() => window.lab.joined), true);
    const sent = await page.evaluate(() => window.sentToServer);
    assert.ok(!sent.some(m => m.method === 'transcriptionAudio' || m.keys.includes('wav')), 'no audio sent to the meeting server');
  }
  assert.ok((await hostPage.evaluate(() => window.sentToServer)).some(m => m.method === 'transcriptionText'));
  assert.deepEqual(errors, []);
  console.log('Transcription UI passed: local service status, consent, local recognition, text-only relay, export, withdrawal, normal stop, call continuity.');
} finally {
  await browser?.close();
  if (app && app.exitCode === null) { const exited = new Promise(resolve => app.once('exit', resolve)); app.kill(); await exited; }
  await new Promise(resolve => speech.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
