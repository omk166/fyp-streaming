import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createTestRoom } from './test-room.mjs';
const base = process.env.BASE_URL || 'http://127.0.0.1:3100', headers = { Origin: new URL(base).origin };
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu'] });
try {
  const room = await createTestRoom(browser, base, 'Active speaker check'), pages = [];
  for (const name of ['Alice', 'Bob']) {
    const context = await browser.newContext();
    assert.equal((await context.request.post(base + '/api/auth/guest', { headers, data: { name } })).status(), 201);
    const page = await context.newPage(); pages.push(page);
    await page.goto(`${base}/?synthetic=1&${room.query}${room.fragment}`);
    await page.locator('#join').click(); await page.waitForFunction(() => window.lab.joined);
  }
  const [a, b] = pages, aId = await a.evaluate(() => window.lab.peerId), bId = await b.evaluate(() => window.lab.peerId);
  await b.locator('#mic').click();
  for (const p of pages) await p.waitForFunction(id => window.lab.activeSpeaker === id && document.querySelector(`.tile[data-peer-id="${id}"]`)?.classList.contains('active-speaker'), aId);
  await a.locator('#mic').click();
  for (const p of pages) await p.waitForFunction(() => window.lab.activeSpeaker === null && !document.querySelector('.active-speaker'));
  await a.locator('.tile[data-source=camera]').filter({ hasText: 'Alice' }).getByRole('button', { name: 'Pin', exact: true }).click();
  await b.locator('#mic').click();
  for (const p of pages) await p.waitForFunction(id => window.lab.activeSpeaker === id && document.querySelector('#participants').textContent.includes('Speaking'), bId);
  assert.equal(await a.locator('#stage .tile').getAttribute('data-peer-id'), aId);
  await b.locator('#camera').click();
  await a.waitForFunction(id => document.querySelector(`.tile[data-peer-id="${id}"]`)?.dataset.paused === 'true' && window.lab.activeSpeaker === id, bId);
  assert.deepEqual(await b.evaluate(() => window.lab.errors), []);
  await b.locator('#leave').click();
  await a.waitForFunction(() => window.lab.activeSpeaker === null && !document.querySelector('.active-speaker'));
  assert.deepEqual(await a.evaluate(() => window.lab.errors), []);
  await a.locator('#leave').click();
  console.log('PASS: real microphone RTP audio levels highlight Alice/Bob on both endpoints; all-muted silence clears highlight; local pin remains stable; camera-off speaker remains identified; departure clears state.');
} finally { await browser.close(); }
