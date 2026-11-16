import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createTestRoom } from './test-room.mjs';

const base = process.env.BASE_URL || 'http://127.0.0.1:3100', origin = new URL(base).origin;
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu', '--disable-accelerated-video-encode', '--disable-accelerated-video-decode'] });
const errors = [];
try {
  const room = await createTestRoom(browser, base, 'UI review');
  await room.context.addInitScript(() => {
    window.previewRequests = []; window.produceRequests = [];
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const stream = canvas.captureStream(0);
      window.previewRequests.push({ stream, resolve: () => resolve(stream) });
    });
    const Native = WebSocket;
    window.WebSocket = class extends Native {
      send(raw) { const message = JSON.parse(raw); if (message.method === 'produce') window.produceRequests.push(message.data); return super.send(raw); }
    };
  });
  const host = await room.context.newPage(); host.on('pageerror', e => errors.push(e.message));
  await host.setViewportSize({ width: 1440, height: 1000 });
  const target = `${base}/meeting?synthetic=1&${room.query}${room.fragment}`;
  await host.goto(target); await host.waitForFunction(() => !document.querySelector('#join').disabled);
  assert.equal(await host.locator('#debugPanel').isVisible(), false);
  await host.locator('#preferredLanguage').selectOption('en');
  assert.equal(await host.locator('#transcriptionLanguage').inputValue(), 'en');
  await host.locator('#previewToggle').click(); await host.locator('#previewToggle').click();
  await host.evaluate(() => window.previewRequests[0].resolve());
  await host.waitForFunction(() => window.previewRequests[0].stream.getTracks()[0].readyState === 'ended');
  await host.evaluate(() => window.previewRequests[1].resolve());
  await host.waitForFunction(() => document.querySelector('#preview').srcObject !== null);
  await host.locator('#lobbyCam').click();
  await host.waitForFunction(() => window.previewRequests[1].stream.getTracks()[0].readyState === 'ended');
  await host.locator('#previewToggle').click(); // Delayed permission must not revive capture after joining.
  await host.locator('#lobbyMic').click();
  await host.locator('#inviteLink').evaluate(el => { el.value = '[private invitation]'; });
  await mkdir('artifacts/private', { recursive: true });
  await host.screenshot({ path: 'artifacts/private/ui-redesign-lobby.png', fullPage: true });
  const guestContext = await browser.newContext();
  await guestContext.request.post(base + '/api/auth/guest', { headers: { Origin: origin }, data: { name: 'Guest' } });
  const guest = await guestContext.newPage(); guest.on('pageerror', e => errors.push(e.message));
  await guest.goto(target); await guest.locator('#join').click(); await guest.waitForFunction(() => window.lab.joined);
  await host.locator('#join').click(); await host.waitForFunction(() => window.lab.joined);
  await host.evaluate(() => window.previewRequests[2].resolve());
  await host.waitForFunction(() => window.previewRequests.every(r => r.stream.getTracks().every(t => t.readyState === 'ended')));
  assert.equal(await host.locator('body').getAttribute('data-phase'), 'call');
  assert.equal(await host.evaluate(() => document.querySelector('#preview').srcObject), null);
  const initial = await host.evaluate(() => window.produceRequests.filter(r => ['microphone', 'camera'].includes(r.source)));
  assert.equal(initial.length, 2); assert.ok(initial.every(r => r.paused));
  assert.ok(await host.evaluate(() => window.lab.producers.every(p => p.paused)));
  const hostId = await host.evaluate(() => window.lab.peerId);
  await guest.waitForFunction(id => document.querySelector(`.tile[data-peer-id="${id}"]`)?.dataset.paused === 'true' && document.querySelector('#participants').textContent.includes('Mic muted'), hostId);
  const samples = await guest.evaluate(() => window.lab.samples.length);
  await guest.waitForFunction(n => window.lab.samples.length >= n + 2, samples);
  const inbound = await guest.evaluate(() => window.lab.samples.at(-1).reports.flatMap(s => s.reports).filter(r => r.type === 'inbound-rtp').map(r => ({ kind: r.kind, bytesReceived: r.bytesReceived, framesDecoded: r.framesDecoded })));
  // Video RTP padding probes may still increment byte counters while the source is paused.
  assert.ok(inbound.every(r => !(r.framesDecoded > 0) && (r.kind !== 'audio' || !(r.bytesReceived > 0))), JSON.stringify(inbound));
  await host.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await host.getByRole('button', { name: 'Resume camera', exact: true }).click();
  await guest.waitForFunction(() => window.lab.samples.at(-1).reports.flatMap(s => s.reports).some(r => r.type === 'inbound-rtp' && r.kind === 'audio' && r.bytesReceived > 0) && window.lab.samples.at(-1).reports.flatMap(s => s.reports).some(r => r.type === 'inbound-rtp' && r.kind === 'video' && r.framesDecoded > 0));
  assert.equal(await host.locator('#mic svg').count(), 2); // On/off icons remain intact after label changes.
  assert.equal(await host.locator('#mic .label').textContent(), 'Mute microphone');
  await host.locator('#chatTo').selectOption(await guest.evaluate(() => window.lab.peerId));
  await host.locator('#message').fill('Private UI check'); await host.locator('#send').click();
  await guest.waitForFunction(() => [...document.querySelectorAll('#chat .private')].some(item => item.textContent.includes('Private UI check')));
  await host.locator('#chat .private.mine').waitFor({ state: 'visible' });
  await host.locator('#moreToggle').click(); await host.locator('#moreMenu [data-open-settings]').click();
  assert.equal(await host.locator('#settingsModal').isVisible(), true); await host.keyboard.press('Escape');
  assert.equal(await host.locator('#settingsModal').isVisible(), false);
  await host.screenshot({ path: 'artifacts/private/ui-redesign-desktop.png', fullPage: true });
  await host.setViewportSize({ width: 390, height: 844 });
  await host.locator('#controls [data-panel-open=chat]').click();
  await host.screenshot({ path: 'artifacts/private/ui-redesign-mobile.png', fullPage: true });
  assert.ok(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  await guest.locator('#leave').click(); await host.locator('#leave').click();
  console.log('PASS: normal lobby/call, language sync, preview cancellation/replacement, initially paused producer negotiation with zero remote media, unmute/resume media, icon labels, settings/Escape, mobile layout.');
} finally { await browser.close(); }
