// Real recognizer check: Chrome feeds a known spoken WAV into its microphone, the page sends speech to the
// actual local speech service (npm run speech, Omnilingual ASR) and only text to a disposable meeting server.
//   SPEECH_TEST_WAV=path/to/spoken.wav npm run test:transcription-real
// Optional: SPEECH_EXPECT_WORDS=a,b,c  SPEECH_LANGUAGE=eng_Latn|apc_Arab|arb_Arab|auto  SPEECH_MIN_WORDS=5
//           LOCAL_SPEECH_URL=http://127.0.0.1:8766 for a service started with --port 8766
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestRoom } from './test-room.mjs';

const base = 'http://127.0.0.1:3198';
const wav = resolve(process.env.SPEECH_TEST_WAV || 'data/transcription-test/english.wav');
const speechUrl = process.env.LOCAL_SPEECH_URL || 'http://127.0.0.1:8765';
const expected = (process.env.SPEECH_EXPECT_WORDS || 'meeting,transcription,system').toLowerCase().split(',');
await readFile(wav);
const health = await fetch(`${speechUrl}/health`).then(r => r.json()).catch(() => ({ status: 'offline' }));
assert.equal(health.status, 'ready', 'Start the local speech service first (npm run speech) and wait until it reports ready');
const temp = await mkdtemp(join(tmpdir(), 'fyp-speech-real-'));
let app, browser, logs = '';
try {
  app = spawn(process.execPath, ['server.js'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '3198', MEDIA_PORT: '41998', SCREEN_PEN: '0',
    AUTH_DB_PATH: join(temp, 'auth.sqlite'), TLS_CERT: '', TLS_KEY: '', LOCAL_SPEECH_URL: speechUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', data => { logs += data; }); app.stderr.on('data', data => { logs += data; });
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + '/health').then(r => r.ok).catch(() => false)) break;
    if (app.exitCode !== null) throw Error(logs);
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', '--disable-gpu'] });
  const room = await createTestRoom(browser, base, 'Real speech check');
  await room.context.grantPermissions(['microphone', 'camera']);
  const page = await room.context.newPage(), errors = [];
  await page.addInitScript(() => {
    window.speechCheck = { texts: [], warnings: [], audioToServer: 0 };
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          const message = JSON.parse(data);
          if (message.event === 'transcriptionWarning') window.speechCheck.warnings.push(message.data.message);
          if (message.event === 'transcriptSegment') console.info('Speech check caption: ' + message.data.text);
        });
      }
      send(raw) {
        const message = JSON.parse(raw);
        if (message.method === 'transcriptionText') window.speechCheck.texts.push({ seq: message.data.seq, offset: message.data.offset, duration: message.data.duration });
        if (raw.includes('"wav"')) window.speechCheck.audioToServer++;
        return super.send(raw);
      }
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().startsWith('Speech check caption:')) console.log(message.text()); });
  await page.goto(`${base}/?${room.query}${room.fragment}`);
  await page.locator('#join').click(); await page.waitForFunction(() => window.lab.joined);
  if (process.env.SPEECH_LANGUAGE) await page.locator('#transcriptionLanguage').selectOption(process.env.SPEECH_LANGUAGE);
  const started = Date.now();
  await page.locator('#controls [data-panel-open=captions]').click();
  await page.locator('#transcriptionStart').click();
  try {
    await page.waitForFunction(words => words.every(word => document.querySelector('#transcript').textContent.toLowerCase().includes(word)), expected, { timeout: 180000 });
  } catch (error) {
    console.error('Transcript before timeout:', await page.locator('#transcript').innerText());
    console.error('Capture metrics:', await page.evaluate(() => window.speechCheck));
    throw error;
  }
  const delayMs = Date.now() - started;
  const remaining = Number(process.env.SPEECH_CAPTURE_MS || 0) - (Date.now() - started);
  if (remaining > 0) await page.waitForTimeout(remaining);
  await page.locator('#transcriptionStop').click();
  await page.waitForFunction(() => document.querySelector('#transcriptionStatus').textContent.includes('stopped'), undefined, { timeout: 180000 });
  const transcript = await page.locator('#transcript').innerText();
  assert.ok(transcript.split(/\s+/).length >= Number(process.env.SPEECH_MIN_WORDS || 5));
  const downloading = page.waitForEvent('download'); await page.locator('#transcript-srt').click();
  const download = await downloading, srt = await readFile(await download.path(), 'utf8');
  assert.match(srt, /\d\d:\d\d:\d\d,\d{3} -->/);
  assert.equal(await page.evaluate(() => window.lab.joined), true);
  assert.deepEqual(errors, []);
  const metrics = await page.evaluate(() => window.speechCheck);
  assert.deepEqual(metrics.warnings, []);
  assert.equal(metrics.audioToServer, 0, 'audio must never reach the meeting server');
  assert.equal(await page.locator('#transcriptionWarning').textContent(), '');
  const result = { testedAt: new Date().toISOString(), model: health.model, device: health.device, delayMs, expected, transcript, srt, errors, ...metrics,
    scope: 'Real local Omnilingual ASR recognition of one WAV through Chrome microphone, app, local service, text relay, captions and SRT. Not an accuracy benchmark.' };
  await mkdir('data/transcription-test', { recursive: true });
  await writeFile('data/transcription-test/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  if (app && app.exitCode === null) { const exited = new Promise(r => app.once('exit', r)); app.kill(); await exited; }
  await rm(temp, { recursive: true, force: true });
}
