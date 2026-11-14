import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { createAuth, meetingTarget } from '../auth.js';

const password = 'four memorable words today';
const account = { name: 'Haya', email: 'haya@example.test', password };
const cookieOf = response => response.headers.getSetCookie().find(c => c.includes('fyp_session='))?.split(';')[0];
async function harness(t, options = {}) {
  const folder = options.folder || await mkdtemp(join(tmpdir(), 'fyp-auth-'));
  if (!options.folder) t.after(() => rm(folder, { recursive: true, force: true }));
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = createAuth({ filename: join(folder, 'auth.sqlite'), publicOrigin: '', googleClientId: '', googleClientSecret: '', ...options,
    ...(options.googleClient ? { publicOrigin: origin, googleClientId: 'test-client', googleClientSecret: 'test-secret' } : {}) });
  app.use(auth.router);
  app.get('/', auth.requireSession, (_req, res) => res.send('meeting'));
  const request = (path, { body, cookie, headers, ...init } = {}) => fetch(origin + path, {
    ...init, redirect: 'manual', headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); auth.close();
  };
  t.after(close);
  return { request, origin, folder, auth, close, inspect(sql) {
    const db = new DatabaseSync(join(folder, 'auth.sqlite'), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  } };
}

test('email signup, normalized login, private credentials, and logout', async t => {
  const h = await harness(t);
  const signup = await h.request('/api/auth/signup', { body: { ...account, email: ' HAYA@EXAMPLE.TEST ' } });
  assert.equal(signup.status, 201);
  const cookie = cookieOf(signup);
  assert.match(signup.headers.get('set-cookie'), /HttpOnly/);
  assert.match(signup.headers.get('set-cookie'), /SameSite=Lax/);
  assert.match(signup.headers.get('cache-control'), /no-store/);
  const profile = await signup.json();
  assert.equal(profile.name, 'Haya'); assert.equal(profile.kind, 'account');
  assert.equal(profile.email, undefined); assert.equal(profile.password_hash, undefined);
  const [user] = h.inspect('SELECT * FROM users');
  assert.equal(user.email, 'haya@example.test');
  assert.ok(!user.password_hash.includes(password));
  assert.match(user.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  const [session] = h.inspect('SELECT * FROM sessions');
  assert.ok(!cookie.includes(session.token_hash));
  assert.equal((await h.request('/', { cookie })).status, 200);
  assert.equal((await h.request('/api/auth/session')).status, 401);
  assert.equal((await h.request('/api/auth/session', { cookie: cookie + 'tamper' })).status, 401);
  const missing = await h.request('/', { headers: { Origin: h.origin } });
  assert.equal(missing.status, 302); assert.equal(missing.headers.get('location'), '/auth?next=%2F');
  const logout = await h.request('/api/auth/logout', { body: {}, cookie });
  assert.equal(logout.status, 204);
  assert.equal((await h.request('/api/auth/session', { cookie })).status, 401);
  const login = await h.request('/api/auth/login', { body: { email: 'HAYA@example.test', password } });
  assert.equal(login.status, 200); assert.notEqual(cookieOf(login), cookie);
  const wrong = await h.request('/api/auth/login', { body: { email: account.email, password: 'wrong password' } });
  const unknown = await h.request('/api/auth/login', { body: { email: 'missing@example.test', password } });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
});

test('signup validates inputs and prevents duplicate email accounts', async t => {
  const h = await harness(t);
  for (const change of [{ name: '' }, { name: 'x'.repeat(41) }, { name: '\nName' }, { email: 'bad' }, { password: 'short' }, { password: 'x'.repeat(129) }]) {
    assert.equal((await h.request('/api/auth/signup', { body: { ...account, ...change } })).status, 400);
  }
  assert.equal((await h.request('/api/auth/signup', { body: account })).status, 201);
  assert.equal((await h.request('/api/auth/signup', { body: { ...account, email: 'HAYA@example.test' } })).status, 409);
  assert.equal(h.inspect('SELECT * FROM users').length, 1);
});

test('guest sessions create no account and rotate when replaced by an account', async t => {
  const revoked = [], h = await harness(t, { onRevoke: hash => revoked.push(hash) });
  const guest = await h.request('/api/auth/guest', { body: { name: '<b>Guest</b>', role: 'host', user_id: 'forged' } });
  assert.equal(guest.status, 201);
  assert.equal((await guest.json()).kind, 'guest');
  assert.equal(h.inspect('SELECT * FROM users').length, 0);
  const oldCookie = cookieOf(guest);
  const accountResponse = await h.request('/api/auth/signup', { body: account, cookie: oldCookie });
  assert.equal(accountResponse.status, 201);
  assert.equal(revoked.length, 1);
  assert.equal((await h.request('/api/auth/session', { cookie: oldCookie })).status, 401);
  assert.equal((await (await h.request('/api/auth/session', { cookie: cookieOf(accountResponse) })).json()).kind, 'account');
});

test('sessions and accounts persist across server restart; expired sessions fail', async t => {
  let clock = Date.now();
  const h = await harness(t, { now: () => clock });
  const signup = await h.request('/api/auth/signup', { body: account });
  const cookie = cookieOf(signup);
  await h.close();
  const restarted = await harness(t, { folder: h.folder, now: () => clock });
  assert.equal((await restarted.request('/api/auth/session', { cookie })).status, 200);
  clock += 8 * 24 * 60 * 60 * 1000;
  assert.equal((await restarted.request('/api/auth/session', { cookie })).status, 401);
  assert.equal((await restarted.request('/api/auth/login', { body: { email: account.email, password } })).status, 200);
});

test('origin, JSON and payload checks reject forged browser submissions', async t => {
  const h = await harness(t);
  for (const endpoint of ['signup', 'login', 'guest', 'logout']) {
    const foreign = await h.request(`/api/auth/${endpoint}`, { body: account, headers: { Origin: 'https://attacker.example' } });
    assert.equal(foreign.status, 403);
    assert.equal((await h.request(`/api/auth/${endpoint}`, { body: account, headers: { Origin: '' } })).status, 403);
  }
  assert.equal((await h.request('/api/auth/guest', { body: { name: 'Guest' }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await h.request('/api/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: undefined })).status, 400);
  assert.equal((await h.request('/api/auth/guest', { body: { name: 'x'.repeat(10000) } })).status, 413);
  assert.equal(h.auth.sameOrigin({ headers: { origin: h.origin, host: new URL(h.origin).host }, socket: {} }), true);
  assert.equal(h.auth.sameOrigin({ headers: { origin: 'https://attacker.example', host: new URL(h.origin).host }, socket: {} }), false);
});

test('secure deployment uses host-only secure cookies and rate limits attempts', async t => {
  const h = await harness(t, { secureCookies: true, rateLimit: 2 });
  const response = await h.request('/api/auth/guest', { body: { name: 'Guest' } });
  assert.match(response.headers.get('set-cookie'), /^__Host-fyp_session=/);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.ok(!response.headers.get('set-cookie').includes('Domain='));
  assert.equal((await h.request('/api/auth/guest', { body: { name: 'Guest' } })).status, 201);
  const limited = await h.request('/api/auth/guest', { body: { name: 'Guest' } });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('meeting redirects preserve room parameters and block external redirects', () => {
  assert.equal(meetingTarget('/?room=team&mode=vp9'), '/?room=team&mode=vp9');
  for (const value of ['https://attacker.example', '//attacker.example/', '/auth', '/\\attacker.example/', 'javascript:alert(1)']) assert.equal(meetingTarget(value), '/');
});

test('Google is optional and unavailable state is actionable', async t => {
  const h = await harness(t);
  assert.deepEqual(await (await h.request('/api/auth/options')).json(), { google: false });
  const response = await h.request('/api/auth/google?next=%2F%3Froom%3Dteam');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/auth?next=%2F%3Froom%3Dteam&error=google_unavailable');
});

test('Google state, PKCE, nonce, verified identity, replay and safe account matching', async t => {
  let nonce, email = 'google@example.test', sub = 'google-subject', verified = true, verifierSeen, verificationSeen;
  const h = await harness(t, { googleClient: {
    async getToken(options) { verifierSeen = options; return { tokens: { id_token: 'provider-token' } }; },
    async verifyIdToken(options) { verificationSeen = options; return { getPayload: () => ({ sub, email, name: 'Google Guest', email_verified: verified, nonce }) }; },
  } });
  async function start() {
    const response = await h.request('/api/auth/google?next=%2F%3Froom%3Dteam');
    const url = new URL(response.headers.get('location'));
    nonce = url.searchParams.get('nonce');
    const state = url.searchParams.get('state'), cookie = response.headers.getSetCookie().find(c => c.startsWith('fyp_oauth='))?.split(';')[0];
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
    return { cookie, path: `/api/auth/google/callback?state=${state}&code=one-use-code` };
  }
  const first = await start();
  assert.equal((await h.request(first.path)).headers.get('location'), '/auth?error=google_failed');
  const success = await h.request(first.path, { cookie: first.cookie });
  assert.equal(success.headers.get('location'), '/?room=team');
  assert.equal((await (await h.request('/api/auth/session', { cookie: cookieOf(success) })).json()).kind, 'account');
  assert.ok(verifierSeen.codeVerifier.length >= 43);
  assert.equal(verificationSeen.audience, 'test-client');
  assert.equal(verificationSeen.idToken, 'provider-token');
  assert.equal((await h.request(first.path, { cookie: first.cookie })).headers.get('location'), '/auth?error=google_failed');
  const badNonce = await start(); nonce = 'wrong-nonce';
  assert.match((await h.request(badNonce.path, { cookie: badNonce.cookie })).headers.get('location'), /error=google_failed/);
  const unverified = await start(); verified = false;
  assert.match((await h.request(unverified.path, { cookie: unverified.cookie })).headers.get('location'), /error=google_failed/);
  verified = true;
  assert.equal((await h.request('/api/auth/signup', { body: account })).status, 201);
  email = account.email; sub = 'different-google-subject';
  const collision = await start();
  assert.match((await h.request(collision.path, { cookie: collision.cookie })).headers.get('location'), /error=account_method/);
  assert.equal(h.inspect('SELECT * FROM users').length, 2);
  assert.equal(h.inspect("SELECT google_sub FROM users WHERE email = 'haya@example.test'")[0].google_sub, null);
});
