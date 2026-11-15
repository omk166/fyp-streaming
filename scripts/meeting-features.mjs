import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createTestRoom } from './test-room.mjs';

const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge', args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu', '--disable-accelerated-video-encode', '--disable-accelerated-video-decode'] });
const pages = [], errors = [];
const base = process.env.BASE_URL || 'http://127.0.0.1:3100';
const room = `features-${Date.now()}`;
try {
  const testRoom = await createTestRoom(browser, base, room);
  for (const name of ['Alice', 'Bob', '<b>Charlie</b>']) {
    const context = await browser.newContext();
    const entry = await context.request.post(`${base}/api/auth/guest`, { headers: { Origin: new URL(base).origin }, data: { name } });
    assert.equal(entry.status(), 201);
    // A generated display track exercises publishing and remote reception.
    // Native OS display selection still needs a manual browser check.
    await context.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        if (window.cancelShare) throw new DOMException('Cancelled', 'NotAllowedError');
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d');
        const draw = () => { context.fillStyle = `hsl(${Date.now() % 360},70%,50%)`; context.fillRect(0, 0, 640, 360); };
        draw(); const timer = setInterval(draw, 33);
        const stream = canvas.captureStream(30);
        window.testDisplay = stream;
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        return stream;
      };
    });
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/?synthetic=1&${testRoom.query}${testRoom.fragment}`);
    await page.waitForFunction(() => !document.querySelector('#join').disabled);
    assert.equal(await page.locator('#username').inputValue(), name);
    await page.locator('#join').click();
    await page.waitForFunction(() => window.lab.joined);
  }
  for (const page of pages) await page.waitForFunction(() => window.lab.consumers.size === 4);
  const [alice, bob, charlie] = pages;
  assert.equal(await alice.locator('.tile footer span').filter({ hasText: '<b>Charlie</b>' }).count(), 1);
  assert.equal(await alice.locator('.tile footer b').count(), 0);
  const bobTile = alice.locator('.tile').filter({ hasText: 'Bob' });
  await bobTile.getByRole('button', { name: 'Pin', exact: true }).click();
  assert.match(await alice.locator('#stage').innerText(), /Bob/);
  assert.equal(await bob.locator('[aria-pressed="true"]').filter({ hasText: 'Unpin' }).count(), 0); // pins are local only
  await alice.locator('#stage button').click();
  assert.equal(await alice.locator('.tile button[aria-pressed="true"]').count(), 0);
  // Three people, nobody pinned: speaker view puts one remote camera on the stage and the rest in the filmstrip.
  assert.equal(await alice.locator('#videoArea').getAttribute('data-layout'), 'speaker');
  assert.notEqual(await alice.locator('#stage .tile').getAttribute('data-peer-id'), await alice.evaluate(() => window.lab.peerId));
  await alice.locator('#viewMode').click();
  assert.equal(await alice.locator('#videoArea').getAttribute('data-layout'), 'gallery');
  assert.equal(await alice.locator('#stage').isVisible(), false);
  await alice.locator('#viewMode').click();
  await alice.locator('#message').fill('Hello everyone'); await alice.locator('#send').click();
  await bob.waitForFunction(() => document.querySelector('#chat').textContent.includes('Alice: Hello everyone'));
  await bob.locator('#mic').click();
  await bob.locator('#hand').click();
  for (const page of pages) {
    await page.waitForFunction(() => [...document.querySelectorAll('#participants li')].some(t => t.textContent.includes('Bob') && t.textContent.includes('Mic muted') && t.textContent.includes('Hand raised')));
    const tile = page.locator('.tile').filter({ hasText: 'Bob' });
    assert.match(await tile.locator('.participant-status').innerText(), /Mic muted.*Hand raised/);
  }
  // Both persistent indicators must be correct for someone joining later.
  const charlieRoomUrl = charlie.url();
  await charlie.locator('#leave').click(); await charlie.waitForURL(base + '/'); await charlie.goto(charlieRoomUrl); await charlie.locator('#join').click();
  await charlie.waitForFunction(() => window.lab.joined && [...document.querySelectorAll('.tile')].some(t => t.textContent.includes('Bob') && t.textContent.includes('Mic muted') && t.textContent.includes('Hand raised')));
  for (const id of ['react-like', 'react-heart', 'react-laugh']) {
    await alice.locator(`#${id}`).click();
    for (const page of pages) await page.waitForFunction(() => [...document.querySelectorAll('#reactions .reaction')].some(t => t.textContent.includes('Alice')));
    for (const page of pages) await page.waitForFunction(() => document.querySelector('#reactions').children.length === 0);
  }
  await bob.locator('#mic').click(); await bob.locator('#hand').click();
  for (const page of pages) await page.waitForFunction(() => [...document.querySelectorAll('#participants li')].some(t => /^Bob \(Guest\)( \(You\))?( · Speaking)?$/.test(t.textContent)));
  await alice.evaluate(() => { window.cancelShare = true; });
  await alice.locator('#screen').click();
  await alice.waitForFunction(() => !document.querySelector('#screen').disabled);
  assert.equal(await alice.locator('[data-source="screen"]').count(), 0);
  await alice.evaluate(() => { window.cancelShare = false; });
  await alice.locator('#screen').click();
  await bob.waitForFunction(() => [...window.lab.consumers.values()].some(c => c.appData.source === 'screen'));
  await bob.waitForFunction(() => [...document.querySelectorAll('[data-source="screen"] video')].some(v => v.currentTime > 0 && v.videoWidth > 0));
  // A share takes the stage automatically for viewers.
  await bob.waitForFunction(() => document.querySelector('#videoArea').dataset.layout === 'share' && document.querySelector('#stage .tile').dataset.source === 'screen');
  await bob.locator('[data-source="screen"] button').click();
  const remoteBob = alice.locator('.tile[data-source="camera"]').filter({ hasText: 'Bob' });
  await remoteBob.getByRole('button', { name: 'Pin', exact: true }).click();
  await bob.locator('#camera').click();
  await alice.waitForFunction(() => document.querySelector('#stage .tile')?.dataset.paused === 'true');
  await bob.waitForFunction(() => document.querySelector('#track-local')?.closest('.tile')?.dataset.paused === 'true');
  assert.equal(await remoteBob.locator('video').evaluate(v => getComputedStyle(v).visibility), 'hidden');
  assert.equal(await remoteBob.evaluate(t => getComputedStyle(t).backgroundColor), 'rgb(0, 0, 0)');
  assert.equal(await bob.locator('#track-local').evaluate(v => getComputedStyle(v).visibility), 'hidden');
  // A participant joining while Bob's camera is off must also see black.
  await charlie.locator('#leave').click(); await charlie.waitForURL(base + '/'); await charlie.goto(charlieRoomUrl);
  await charlie.locator('#join').click();
  await charlie.waitForFunction(() => window.lab.joined && [...document.querySelectorAll('.tile')].some(t => t.textContent.includes('Bob') && t.dataset.paused === 'true'));
  assert.equal(await bob.locator('#screen').innerText(), 'Share screen');
  await bob.locator('#camera').click();
  await alice.waitForFunction(() => document.querySelector('#stage .tile')?.dataset.paused === 'false');
  assert.equal(await remoteBob.locator('video').evaluate(v => getComputedStyle(v).visibility), 'visible');
  await remoteBob.locator('video').evaluate(v => { window.resumeTime = v.currentTime; });
  await alice.waitForFunction(() => document.querySelector('#stage video').currentTime > window.resumeTime);
  await alice.locator('#stage button').click();
  await charlie.locator('#screen').click();
  await bob.waitForFunction(() => document.querySelectorAll('[data-source="screen"]').length === 2);
  await alice.locator('#screen').click();
  await bob.waitForFunction(() => document.querySelectorAll('[data-source="screen"]').length === 1 && document.querySelector('#stage .tile')?.dataset.source === 'screen' && !document.querySelector('.tile button[aria-pressed="true"]'));
  await alice.locator('#screen').click();
  await bob.waitForFunction(() => document.querySelectorAll('[data-source="screen"]').length === 2);
  await alice.evaluate(() => { const track = window.testDisplay.getVideoTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended')); });
  await bob.waitForFunction(() => document.querySelectorAll('[data-source="screen"]').length === 1);
  await charlie.locator('#leave').click();
  await bob.waitForFunction(() => window.lab.consumers.size === 2 && !document.querySelector('[data-source="screen"]'));
  const bobRoomUrl = bob.url();
  await bob.locator('#leave').click(); await bob.waitForURL(base + '/'); await bob.goto(bobRoomUrl);
  await bob.locator('#join').click(); await bob.waitForFunction(() => window.lab.joined && window.lab.consumers.size === 2);
  for (const page of pages) assert.deepEqual(await page.evaluate(() => window.lab?.errors || []), []);
  assert.deepEqual(errors, []);
  console.log('PASS: three participants, usernames and safe text, local pin/unpin, speaker/gallery/share layouts, named chat, local/remote mute and hand indicators, late join state, all three reactions delivered and expired, share cancellation, decoded screen video, simultaneous shares, black paused camera (local, remote, pinned and late join), resumed moving video, camera controls, stop/restart, browser stop, leave cleanup and rejoin.');
} finally { await browser.close(); }
