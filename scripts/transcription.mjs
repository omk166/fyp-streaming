// Uses a fake inference endpoint; verifies wiring, not recognition accuracy.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createTestRoom } from './test-room.mjs';

const temp = await mkdtemp(join(tmpdir(), 'fyp-transcription-'));
let requests = 0, browser, app, logs = '';
const speech = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const wav = Buffer.concat(chunks); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  requests++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ segments: [{ start: 0, end: 1, text: 'مرحبا hello' }] }));
});
await new Promise(resolve => speech.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:3197';
try {
  app = spawn(process.execPath, ['server.js'], { env: { ...process.env,
    HOST: '127.0.0.1', PORT: '3197', MEDIA_PORT: '41997', SCREEN_PEN: '0', AUTH_DB_PATH: join(temp, 'auth.sqlite'),
    TRANSCRIPTION_URL: `http://127.0.0.1:${speech.address().port}/transcribe` }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    await page.goto(`${base}/?synthetic=1&${room.query}${room.fragment}`);
    await page.locator('#join').click(); await page.waitForFunction(() => window.lab.joined);
  }
  await hostPage.locator('#controls [data-panel-open=captions]').click(); await hostPage.locator('#transcriptionStart').click();
  await guestPage.locator('#transcriptionConsent').waitFor({ state: 'visible' });
  assert.equal(requests, 0);
  await guestPage.locator('#transcriptionDecline').click();
  await hostPage.waitForFunction(() => document.querySelector('#transcriptionStatus').textContent.includes('stopped'));
  assert.equal(requests, 0);
  await hostPage.locator('#transcriptionStart').click();
  await guestPage.locator('#transcriptionAllow').click();
  for (const page of [hostPage, guestPage]) await page.waitForFunction(() => document.querySelector('#transcript').textContent.includes('مرحبا hello'), undefined, { timeout: 20000 });
  assert.ok(requests > 0);
  const downloading = hostPage.waitForEvent('download'); await hostPage.locator('#transcript-txt').click();
  const download = await downloading; assert.match(await readFile(await download.path(), 'utf8'), /مرحبا hello/);
  await guestPage.locator('#controls [data-panel-open=captions]').click(); await guestPage.locator('#transcriptionWithdraw').click();
  await hostPage.waitForFunction(() => document.querySelector('#transcriptionStatus').textContent.includes('stopped'));
  const stopped = requests;
  await hostPage.waitForTimeout(4500); assert.equal(requests, stopped);
  for (const page of [hostPage, guestPage]) assert.equal(await page.evaluate(() => window.lab.joined), true);
  assert.deepEqual(errors, []);
  console.log('Transcription UI passed: consent, AudioWorklet WAV upload, mixed text, export, withdrawal, call continuity.');
} finally {
  await browser?.close();
  if (app && app.exitCode === null) { const exited = new Promise(resolve => app.once('exit', resolve)); app.kill(); await exited; }
  await new Promise(resolve => speech.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
