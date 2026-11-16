import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createTestRoom } from './test-room.mjs';

const base = process.env.BASE_URL || 'http://127.0.0.1:3100', headers = { Origin: new URL(base).origin };
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu', '--disable-accelerated-video-encode', '--disable-accelerated-video-decode'] });
const errors = [];
try {
  const room = await createTestRoom(browser, base, 'Consented recording'), pages = [];
  async function open(context, name) {
    if (name) assert.equal((await context.request.post(base + '/api/auth/guest', { headers, data: { name } })).status(), 201);
    await context.addInitScript(() => {
      const NativeSocket = WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url, protocols) { super(url, protocols); if (url === location.origin.replace(/^http/, 'ws') || url === location.origin.replace(/^http/, 'ws') + '/') window.meetingSocket = this; }
      };
      let serial = 900000;
      window.testRpc = (method, data = {}) => new Promise(resolve => {
        const id = ++serial, listener = event => { const msg = JSON.parse(event.data); if (msg.id === id) { window.meetingSocket.removeEventListener('message', listener); resolve(msg); } };
        window.meetingSocket.addEventListener('message', listener); window.meetingSocket.send(JSON.stringify({ id, method, data }));
      });
      navigator.mediaDevices.getDisplayMedia = async options => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const draw = () => { const c = canvas.getContext('2d'); c.fillStyle = `hsl(${Date.now() % 360},80%,50%)`; c.fillRect(0, 0, 640, 360); };
        draw(); const timer = setInterval(draw, 33), stream = canvas.captureStream(30);
        if (options.audio) {
          const ctx = new AudioContext(); await ctx.resume(); const tone = ctx.createOscillator(), dest = ctx.createMediaStreamDestination();
          tone.frequency.value = 880; tone.connect(dest); tone.start(); stream.addTrack(dest.stream.getAudioTracks()[0]);
          stream.getVideoTracks()[0].addEventListener('ended', () => ctx.close().catch(() => {}));
        }
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer)); return stream;
      };
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/?synthetic=1&${room.query}${room.fragment}`);
    await page.locator('#join').click(); await page.waitForFunction(() => window.lab.joined); pages.push(page); return page;
  }
  const host = await open(room.context), alice = await open(await browser.newContext(), 'Alice'), bob = await open(await browser.newContext(), 'Bob');
  for (const page of pages) await page.waitForFunction(() => window.lab.consumers.size === 4);
  assert.equal(await alice.locator('#recordRequest').isVisible(), false);
  assert.match((await alice.evaluate(() => window.testRpc('recordingRequest'))).error, /owner/);
  await host.locator('#moreToggle').click(); await host.locator('#recordRequest').click();
  for (const page of pages) await page.waitForFunction(() => window.lab.recording?.phase === 'consent');
  assert.equal(await host.evaluate(() => window.lab.recorderRunning), false);
  const id = await host.evaluate(() => window.lab.recording.id);
  assert.match((await alice.evaluate(id => window.testRpc('recordingStop', { id }), id)).error, /owner/);
  assert.match((await alice.evaluate(id => window.testRpc('recordingFailed', { id }), id)).error, /belongs/);
  await bob.locator('#recordDecline').click();
  await host.waitForFunction(() => window.lab.recording.phase === 'idle');
  assert.equal(await host.evaluate(() => Boolean(window.lab.lastRecording)), false);
  async function start(consenting = [alice, bob]) {
    await host.locator('#moreToggle').click(); await host.locator('#recordRequest').click();
    await host.waitForFunction(() => window.lab.recording.phase === 'consent');
    for (const page of consenting) await page.locator('#recordAllow').click();
    await host.waitForFunction(() => window.lab.recorderRunning);
    for (const page of [host, ...consenting]) await page.waitForFunction(() => document.querySelector('#recordingIndicator').dataset.active === 'true');
    const samples = await host.evaluate(() => window.lab.samples.length);
    await host.waitForFunction(n => window.lab.samples.length >= n + 2, samples);
  }
  await host.locator('#moreToggle').click(); await host.locator('#recordRequest').click();
  await alice.locator('#recordAllow').click();
  assert.equal(await host.evaluate(() => window.lab.recorderRunning), false);
  await bob.locator('#recordAllow').click(); await host.waitForFunction(() => window.lab.recorderRunning);
  const sampleCount = await host.evaluate(() => window.lab.samples.length);
  await host.locator('#screen').click();
  await alice.waitForFunction(() => [...window.lab.consumers.values()].some(c => c.appData.source === 'screenAudio'));
  await host.waitForFunction(n => window.lab.samples.length >= n + 3, sampleCount);
  const firstDownload = host.waitForEvent('download'); await host.locator('#moreToggle').click(); await host.locator('#recordStop').click();
  const file = await firstDownload;
  await mkdir('artifacts/private', { recursive: true }); await file.saveAs('artifacts/private/meeting-recording.webm');
  assert.equal(await file.failure(), null);
  await host.waitForFunction(() => window.lab.lastRecording?.size > 15000);
  await host.evaluate(async () => {
    const video = window.recordedPlayback = document.createElement('video'); video.muted = true; video.src = window.lab.lastRecording.url;
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; }); await video.play();
  });
  await host.waitForFunction(() => window.recordedPlayback.videoWidth === 1280 && window.recordedPlayback.captureStream().getAudioTracks().length === 1);
  await host.evaluate(() => { window.recordedPlayback.pause(); });
  for (const page of pages) assert.equal(await page.evaluate(() => window.lab.joined), true);
  await host.locator('#screen').click();
  await start();
  await host.waitForFunction(() => window.lab.samples.length > 5);
  const withdrawn = host.waitForEvent('download'); await alice.locator('#moreToggle').click(); await alice.locator('#recordWithdraw').click(); await withdrawn;
  await host.waitForFunction(() => window.lab.recording.phase === 'idle' && !window.lab.recorderRunning);
  await start();
  const newArrivalDownload = host.waitForEvent('download');
  const late = await open(await browser.newContext(), 'Late arrival'); await newArrivalDownload;
  const lateId = await late.evaluate(() => window.lab.peerId);
  assert.equal(await host.evaluate(id => window.lab.lastRecording.peerIds.includes(id), lateId), false);
  await host.waitForFunction(() => window.lab.recording.phase === 'idle');
  for (const page of pages) assert.equal(await page.evaluate(() => window.lab.joined), true);
  await start([alice, bob, late]);
  const leaving = host.waitForEvent('download'); await host.locator('#leave').click(); await leaving;
  for (const page of [alice, bob, late]) await page.waitForFunction(() => window.lab.recording.phase === 'idle' && window.lab.joined);
  await host.waitForURL(base + '/');
  await host.goto(`${base}/meeting?synthetic=1&${room.query}${room.fragment}`);
  await host.locator('#join').click(); await host.waitForFunction(() => window.lab.joined);
  // Fault injection: the optional recorder must fail without tearing down the original call.
  await host.evaluate(() => {
    window.originalRecorder = MediaRecorder;
    window.MediaRecorder = class extends MediaRecorder { constructor() { throw Error('Injected recorder failure'); } };
  });
  await host.locator('#moreToggle').click(); await host.locator('#recordRequest').click();
  for (const page of [alice, bob, late]) await page.locator('#recordAllow').click();
  await host.waitForFunction(() => window.lab.recording.phase === 'idle');
  assert.equal(await host.evaluate(() => window.lab.joined && !window.lab.recorderRunning), true);
  await host.evaluate(() => { window.MediaRecorder = window.originalRecorder; });
  for (const page of pages) assert.deepEqual(await page.evaluate(() => window.lab.errors), []);
  assert.deepEqual(errors, []);
  await host.locator('#inviteLink').evaluate(el => { el.value = '[private invitation]'; });
  await host.screenshot({ path: 'artifacts/private/recording-controls.png', fullPage: true });
  await start([alice, bob, late]);
  const logoutFile = host.waitForEvent('download'); await host.locator('#accountToggle').click(); await host.locator('#logout').click(); await logoutFile;
  await host.waitForURL('**/auth?**');
  for (const page of [alice, bob, late]) { await page.waitForFunction(() => window.lab.recording.phase === 'idle' && window.lab.joined); await page.locator('#leave').click(); }
  assert.deepEqual(errors, []);
  console.log('PASS: owner-only request, all-participant explicit consent, decline/no file, forged control rejection, playable 1280x720 file with audio and screen share, continued call media, consent withdrawal, late arrival excludes unconsented peer and stops clip, host departure and logout save clips, injected recorder failure leaves call connected.');
} finally { await browser.close(); }
