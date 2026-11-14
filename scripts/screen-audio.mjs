import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createTestRoom } from './test-room.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:3100', headers = { Origin: new URL(base).origin };
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu'] });
const errors = [];
try {
  const room = await createTestRoom(browser, base, 'Screen audio check'), pages = [];
  for (const name of ['Sharer', 'Listener']) {
    const context = await browser.newContext();
    await context.request.post(base + '/api/auth/guest', { headers, data: { name } });
    await context.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async options => {
        if (window.cancelShare) throw new DOMException('Cancelled', 'NotAllowedError');
        window.captureOptions = options;
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const draw = () => { const c = canvas.getContext('2d'); c.fillStyle = `hsl(${Date.now() % 360},80%,50%)`; c.fillRect(0, 0, 640, 360); };
        draw(); const timer = setInterval(draw, 33), stream = canvas.captureStream(30);
        let ctx;
        if (options.audio) {
          ctx = new AudioContext(); await ctx.resume();
          const oscillator = ctx.createOscillator(), gain = ctx.createGain(), destination = ctx.createMediaStreamDestination();
          oscillator.frequency.value = 880; gain.gain.value = .15; oscillator.connect(gain).connect(destination); oscillator.start();
          stream.addTrack(destination.stream.getAudioTracks()[0]);
        }
        stream.getVideoTracks()[0].addEventListener('ended', () => { clearInterval(timer); ctx?.close().catch(() => {}); });
        window.testDisplay = stream; return stream;
      };
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); pages.push(page);
    await page.goto(`${base}/?synthetic=1&${room.query}${room.fragment}`);
    await page.locator('#join').click(); await page.waitForFunction(() => window.lab.joined);
    await page.locator('#mic').click();
  }
  const [sharer, listener] = pages;
  await sharer.locator('#screen').click();
  await listener.waitForFunction(() => [...window.lab.consumers.values()].some(c => c.appData.source === 'screenAudio'));
  assert.equal(await sharer.evaluate(() => window.captureOptions.audio), true);
  await listener.evaluate(async () => {
    const track = [...window.lab.consumers.values()].find(c => c.appData.source === 'screenAudio').track;
    const ctx = window.probeContext = new AudioContext(); await ctx.resume();
    const input = ctx.createMediaStreamSource(new MediaStream([track]));
    window.probe = ctx.createAnalyser(); input.connect(window.probe);
  });
  await listener.waitForFunction(() => { const samples = new Float32Array(window.probe.fftSize); window.probe.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, n) => sum + n*n, 0) / samples.length) > .01; });
  for (const page of pages) await page.waitForFunction(() => window.lab.activeSpeaker === null);
  assert.equal(await sharer.evaluate(() => window.lab.producers.find(p => p.appData.source === 'microphone').paused), true);
  await sharer.evaluate(() => { const sound = window.testDisplay.getAudioTracks()[0]; sound.stop(); sound.dispatchEvent(new Event('ended')); });
  await listener.waitForFunction(() => ![...window.lab.consumers.values()].some(c => c.appData.source === 'screenAudio') && [...window.lab.consumers.values()].some(c => c.appData.source === 'screen'));
  await sharer.locator('#screen').click();
  await sharer.locator('#screenSound').uncheck();
  await sharer.locator('#screen').click();
  await listener.waitForFunction(() => [...window.lab.consumers.values()].some(c => c.appData.source === 'screen'));
  assert.equal(await sharer.evaluate(() => window.captureOptions.audio), false);
  assert.equal(await listener.evaluate(() => [...window.lab.consumers.values()].some(c => c.appData.source === 'screenAudio')), false);
  await sharer.locator('#screen').click(); await sharer.locator('#screenSound').check();
  await sharer.locator('#screen').click();
  await listener.waitForFunction(() => [...window.lab.consumers.values()].some(c => c.appData.source === 'screenAudio'));
  await sharer.evaluate(() => { const video = window.testDisplay.getVideoTracks()[0]; video.stop(); video.dispatchEvent(new Event('ended')); });
  await listener.waitForFunction(() => ![...window.lab.consumers.values()].some(c => ['screen','screenAudio'].includes(c.appData.source)));
  await sharer.evaluate(() => { window.cancelShare = true; }); await sharer.locator('#screen').click();
  await sharer.waitForFunction(() => !document.querySelector('#screen').disabled);
  assert.deepEqual(errors, []);
  for (const page of pages) { assert.deepEqual(await page.evaluate(() => window.lab.errors), []); await page.locator('#leave').click(); }
  console.log('PASS: requested display audio is separately published and decoded at receiver, survives microphone mute, does not trigger speaker highlighting, audio-only end retains video, unchecked sound shares video only, browser stop removes both tracks, cancellation is clean. Native picker/OS sound support remains a manual device check.');
} finally { await browser.close(); }
