import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:3196', temp = await mkdtemp(join(tmpdir(), 'fyp-home-'));
let browser, server, logs = '';
try {
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '3196', MEDIA_PORT: '41996',
    MEDIA_IP: '127.0.0.1', APP_ORIGIN: base, SCREEN_PEN: '0', TRANSCRIPTION_URL: '', TLS_CERT: '', TLS_KEY: '', AUTH_DB_PATH: join(temp, 'auth.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + '/health').then(r => r.ok).catch(() => false)) break;
    if (server.exitCode !== null) throw Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }), guestContext = await browser.newContext(), errors = [];
  await context.addInitScript(() => {
    const NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); window.testMeetingSocket = this; } };
  });
  const host = await context.newPage(), guest = await guestContext.newPage();
  for (const page of [host, guest]) page.on('pageerror', error => errors.push(error.message));
  await host.goto(base);
  await host.waitForURL('**/auth?**'); await host.locator('#signupTab').click();
  await host.locator('#signupName').fill('Alex Morgan'); await host.locator('#signupEmail').fill(`${crypto.randomUUID()}@example.test`);
  await host.locator('#signupPassword').fill('a memorable homepage passphrase'); await host.locator('#signupForm [type=submit]').click();
  await host.waitForURL(base + '/'); await host.waitForFunction(() => !document.querySelector('#newMeeting').disabled);
  assert.equal(await host.locator('#emptyHistory').isVisible(), true);
  await host.locator('#newMeeting').click(); await host.locator('#newMeetingName').fill('Design catch-up'); await host.locator('#createMeeting').click();
  await host.waitForURL('**/meeting?**'); await host.waitForFunction(() => !document.querySelector('#join').disabled);
  const invitation = await host.locator('#inviteLink').inputValue(); assert.ok(invitation.includes('#invite='));
  await host.locator('#synthetic').evaluate(box => { box.checked = true; }); await host.locator('#join').click(); await host.waitForFunction(() => window.lab.joined);
  await guestContext.request.post(base + '/api/auth/guest', { headers: { Origin: base }, data: { name: 'Sam' } });
  const legacy = new URL(invitation); legacy.pathname = '/';
  await guest.goto(legacy.href); await guest.waitForURL('**/meeting?**');
  assert.equal(new URL(guest.url()).hash, new URL(invitation).hash);
  await guest.locator('#synthetic').evaluate(box => { box.checked = true; }); await guest.locator('#join').click(); await guest.waitForFunction(() => window.lab.joined);
  await host.evaluate(() => window.testMeetingSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'transcriptSegment', data: { id: 'test-caption', username: 'Alex', peerId: 'test', start: 0, end: 1000, text: 'Project notes are ready.' } }) })));
  await host.locator('#leave').click(); await host.waitForURL(base + '/'); await host.waitForFunction(() => document.querySelectorAll('#historyRows tr').length === 1);
  assert.equal(await guest.evaluate(() => window.lab.joined), true);
  await host.locator('#lastTxt').waitFor({ state: 'visible' });
  const downloading = host.waitForEvent('download'); await host.locator('#lastTxt').click();
  assert.match(await readFile(await (await downloading).path(), 'utf8'), /Project notes are ready/);
  await host.reload(); await host.getByRole('button', { name: 'Open meeting: Design catch-up' }).click();
  await host.waitForURL('**/meeting?**'); await host.locator('#synthetic').evaluate(box => { box.checked = true; }); await host.locator('#join').click(); await host.waitForFunction(() => window.lab.joined);
  await host.locator('#controls [data-panel-open=people]').click(); await host.locator('#endRoom').click(); await host.locator('#confirmOk').click();
  for (const page of [host, guest]) { await page.waitForURL(base + '/'); await page.waitForFunction(() => document.querySelector('#historyRows').textContent.includes('Ended')); }
  assert.match(await guest.locator('#exitTitle').textContent(), /ended/);
  assert.equal(await guest.locator('#newMeeting').isDisabled(), true);
  assert.equal(await guest.locator('#hostSignIn').isVisible(), true);
  await host.locator('#newMeeting').click(); await host.locator('#newMeetingName').fill('Weekly sync'); await host.locator('#createMeeting').click();
  await host.waitForURL('**/meeting?**'); await host.waitForFunction(() => !document.querySelector('#join').disabled);
  const second = new URL(await host.locator('#inviteLink').inputValue()), code = new URLSearchParams(second.hash.slice(1)).get('invite');
  await host.locator('#home').click(); await host.waitForURL(base + '/');
  await guest.locator('#meetingName').fill('Weekly sync'); await guest.locator('#joinMeeting').click();
  await guest.locator('#feedback').waitFor({ state: 'visible' }); assert.match(await guest.locator('#feedback').textContent(), /invitation/i);
  await guest.locator('#invitationCode').fill(code); await guest.locator('#joinMeeting').click(); await guest.waitForURL('**/meeting?**');
  await guest.locator('#synthetic').evaluate(box => { box.checked = true; }); await guest.locator('#join').click(); await guest.waitForFunction(() => window.lab.joined);
  await guest.locator('#leave').click(); await guest.waitForURL(base + '/'); await guest.waitForFunction(() => document.querySelectorAll('#historyRows tr').length === 2);
  await host.reload(); await host.waitForFunction(() => document.querySelectorAll('#historyRows tr').length === 2);
  await host.locator('#historySearch').fill('Weekly'); assert.equal(await host.locator('#historyRows tr').count(), 1);
  await host.locator('#historySearch').fill(''); await host.getByRole('button', { name: 'Past', exact: true }).click(); assert.equal(await host.locator('#historyRows tr').count(), 1);
  await host.getByRole('button', { name: 'All meetings', exact: true }).click();
  await mkdir('artifacts/private', { recursive: true }); await host.screenshot({ path: 'artifacts/private/home-desktop.png', fullPage: true });
  await host.setViewportSize({ width: 390, height: 844 });
  await host.screenshot({ path: 'artifacts/private/home-mobile.png', fullPage: true });
  assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    JSON.stringify(await host.evaluate(() => [...document.querySelectorAll('body *')].filter(el => !el.closest('.table-scroll') && el.getBoundingClientRect().right > innerWidth).slice(0, 8).map(el => ({ tag: el.tagName, id: el.id, className: el.className, right: el.getBoundingClientRect().right })))));
  await host.locator('#logout').click(); await host.waitForURL(base + '/auth');
  assert.equal((await context.request.get(base + '/api/auth/session')).status(), 401);
  assert.deepEqual(errors, []);
  console.log('Homepage passed: signup landing, create, legacy invitation, media, leave/home, caption download, persistent history, rejoin, owner/guest end redirects, name + invitation join, search, filters, mobile, logout.');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; }
  await rm(temp, { recursive: true, force: true });
}
