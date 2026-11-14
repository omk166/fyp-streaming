import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { mkdir } from 'node:fs/promises';

const base = process.env.BASE_URL || 'http://127.0.0.1:3100', origin = new URL(base).origin;
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu', '--disable-accelerated-video-encode', '--disable-accelerated-video-decode'] });
const headers = { Origin: origin }, errors = [];
try {
  const owner = await browser.newContext(), guest = await browser.newContext(), late = await browser.newContext();
  assert.equal((await owner.request.post(base + '/api/auth/signup', { headers, data: { name: 'Host', email: `${crypto.randomUUID()}@example.test`, password: 'protected meeting password' } })).status(), 201);
  for (const context of [guest, late]) assert.equal((await context.request.post(base + '/api/auth/guest', { headers, data: { name: 'Invited guest' } })).status(), 201);
  const hostPage = await owner.newPage(), guestPage = await guest.newPage();
  for (const page of [hostPage, guestPage]) page.on('pageerror', error => errors.push(error.message));
  await hostPage.goto(base + '/?synthetic=1');
  await hostPage.locator('#newRoomName').fill('Private team room'); await hostPage.locator('#createRoom').click();
  await hostPage.waitForFunction(() => !document.querySelector('#inviteLink').hidden && document.querySelector('#inviteLink').value.includes('#invite='));
  const link = await hostPage.locator('#inviteLink').inputValue(), url = new URL(link), roomId = url.searchParams.get('room'), invitation = new URLSearchParams(url.hash.slice(1)).get('invite');
  assert.ok(!url.searchParams.has('invite'));
  await hostPage.locator('#join').click(); await hostPage.waitForFunction(() => window.lab.joined);
  await guestPage.goto(link); await guestPage.locator('#join').click();
  for (const page of [hostPage, guestPage]) await page.waitForFunction(() => window.lab.joined && window.lab.consumers.size === 2);
  assert.equal(await guestPage.locator('#roomOwner').isVisible(), false);
  assert.equal((await guest.request.post(`${base}/api/rooms/${roomId}/lock`, { headers, data: { locked: true, role: 'owner' } })).status(), 403);
  const cookie = (await guest.cookies(base)).map(c => `${c.name}=${c.value}`).join('; ');
  async function socketJoin(data) {
    const ws = new WebSocket(origin.replace(/^http/, 'ws'), { headers: { Origin: origin, Cookie: cookie } });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const response = new Promise(resolve => ws.once('message', data => resolve(JSON.parse(data.toString()))));
    ws.send(JSON.stringify({ id: 1, method: 'join', data }));
    const result = await response;
    await new Promise(resolve => { ws.once('close', resolve); ws.close(); }); return result;
  }
  assert.match((await socketJoin({ room: roomId, role: 'owner' })).error, /invitation/i);
  const spoof = await socketJoin({ room: roomId, invitation, role: 'owner', username: 'Forged owner' });
  assert.equal(spoof.result.username, 'Invited guest');
  assert.equal(spoof.result.room.role, 'participant');
  await hostPage.locator('#lockRoom').click();
  await hostPage.waitForFunction(() => document.querySelector('#lockRoom').textContent === 'Unlock room');
  assert.equal((await late.request.post(base + '/api/rooms/resolve', { headers, data: { roomId, invitation } })).status(), 403);
  assert.equal(await guestPage.evaluate(() => window.lab.joined), true);
  assert.match((await socketJoin({ room: roomId, invitation })).error, /invitation/i);
  await hostPage.locator('#lockRoom').click();
  await hostPage.waitForFunction(() => document.querySelector('#lockRoom').textContent === 'Lock room');
  await hostPage.locator('#rotateInvite').click();
  await hostPage.waitForFunction(old => document.querySelector('#inviteLink').value !== old, link);
  assert.equal((await late.request.post(base + '/api/rooms/resolve', { headers, data: { roomId, invitation } })).status(), 403);
  const newLink = await hostPage.locator('#inviteLink').inputValue();
  const latePage = await late.newPage(); latePage.on('pageerror', error => errors.push(error.message));
  await latePage.goto(newLink); await latePage.locator('#join').click(); await latePage.waitForFunction(() => window.lab.joined);
  await hostPage.locator('#leave').click(); await hostPage.reload();
  await hostPage.waitForFunction(() => !document.querySelector('#join').disabled);
  assert.equal(await hostPage.locator('#roomOwner').isVisible(), true);
  await hostPage.locator('#join').click(); await hostPage.waitForFunction(() => window.lab.joined);
  await mkdir('artifacts/private', { recursive: true });
  // Do not publish the live invitation token in screenshots.
  await hostPage.locator('#inviteLink').evaluate(el => { el.value = '[private invitation]'; });
  await hostPage.screenshot({ path: 'artifacts/private/protected-room.png', fullPage: true });
  hostPage.once('dialog', dialog => dialog.accept()); await hostPage.locator('#endRoom').click();
  for (const page of [guestPage, latePage]) await page.waitForFunction(() => !window.lab.joined && document.querySelector('#status').textContent.includes('ended'));
  assert.equal((await owner.request.post(base + '/api/rooms/resolve', { headers, data: { roomId } })).status(), 403);
  assert.deepEqual(errors, []);
  console.log('PASS: owner creates room in UI, fragment invitation, guest admission, server rejects missing token/forged owner, lock excludes new joins while existing media remains, rotation revokes old link, owner reload persists permissions, ending closes all participants.');
} finally { await browser.close(); }
