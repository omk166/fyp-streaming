// Real recognizer smoke check: Chrome feeds a known WAV into its microphone.
// Requires speech/run-local.ps1 and a spoken 16kHz mono WAV (no synthetic tone).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestRoom } from './test-room.mjs';

const base = process.env.BASE_URL || 'http://127.0.0.1:3198';
const wav = resolve(process.env.SPEECH_TEST_WAV || 'data/transcription-test/english.wav');
const expected = (process.env.SPEECH_EXPECT_WORDS || 'meeting,transcription,system').toLowerCase().split(',');
await readFile(wav);
assert.equal((await fetch('http://127.0.0.1:8765/health')).status, 200, 'Start the real speech worker first');
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', '--disable-gpu'] });
try {
  const room = await createTestRoom(browser, base, 'Real speech check');
  await room.context.grantPermissions(['microphone', 'camera']);
  const page = await room.context.newPage(), errors = [];
  await page.addInitScript(() => {
    window.speechCheck = { uploads: [], warnings: [] };
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
        if (message.method === 'transcriptionAudio') window.speechCheck.uploads.push({ seq: message.data.seq, offset: message.data.offset, bytes: message.data.wav.length });
        return super.send(raw);
      }
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().startsWith('Speech check caption:')) console.log(message.text()); });
  await page.goto(`${base}/?${room.query}${room.fragment}`);
  await page.locator('#join').click(); await page.waitForFunction(() => window.lab.joined);
  const started = Date.now();
  await page.locator('#transcriptionStart').click();
  if (process.env.SPEECH_LANGUAGE) await page.locator('#transcriptionLanguage').selectOption(process.env.SPEECH_LANGUAGE);
  try {
    await page.waitForFunction(words => words.every(word => document.querySelector('#transcript').textContent.toLowerCase().includes(word)), expected, { timeout: 120000 });
  } catch (error) {
    console.error('Transcript before timeout:', await page.locator('#transcript').innerText());
    console.error('Capture metrics:', await page.evaluate(() => window.speechCheck));
    throw error;
  }
  const delayMs = Date.now() - started;
  const remaining = Number(process.env.SPEECH_CAPTURE_MS || 0) - (Date.now() - started);
  if (remaining > 0) await page.waitForTimeout(remaining);
  await page.locator('#transcriptionStop').click();
  await page.waitForFunction(() => document.querySelector('#transcriptionStatus').textContent.includes('stopped'), undefined, { timeout: 120000 });
  const transcript = await page.locator('#transcript').innerText();
  assert.ok(transcript.split(/\s+/).length >= Number(process.env.SPEECH_MIN_WORDS || 5));
  const downloading = page.waitForEvent('download'); await page.locator('#transcript-srt').click();
  const download = await downloading, srt = await readFile(await download.path(), 'utf8');
  assert.match(srt, /\d\d:\d\d:\d\d,\d{3} -->/);
  assert.equal(await page.evaluate(() => window.lab.joined), true);
  assert.deepEqual(errors, []);
  const metrics = await page.evaluate(() => window.speechCheck);
  assert.deepEqual(metrics.warnings, []);
  assert.equal(await page.locator('#transcriptionWarning').textContent(), '');
  const result = { testedAt: new Date().toISOString(), delayMs, expected, transcript, srt, errors, ...metrics,
    scope: 'Real CPU recognition of Windows English speech through Chrome microphone, app, worker, captions and SRT. Does not establish Arabic accuracy.' };
  await writeFile('data/transcription-test/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
