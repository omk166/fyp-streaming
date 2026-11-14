import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';

const derive = promisify(scrypt);
const DAY = 24 * 60 * 60 * 1000;
// OWASP's lower-memory scrypt option: N=2^15, r=8, p=3 (about 32 MiB per job).
const KDF = { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
const digest = value => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const validName = value => typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 40 && !/[\u0000-\u001f\u007f]/.test(value);
const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value);
const emailOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;
const cookieValue = (req, name) => {
  const value = (req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
};

export function meetingTarget(value) {
  if (typeof value !== 'string' || value.length > 2048) return '/';
  try {
    const target = new URL(value, 'http://meeting.invalid');
    if (target.origin !== 'http://meeting.invalid' || !['/', '/index.html'].includes(target.pathname)) return '/';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch { return '/'; }
}

export function createAuth({
  filename = process.env.AUTH_DB_PATH || resolve('data/auth.sqlite'),
  secureCookies = false,
  publicOrigin = process.env.APP_ORIGIN || '',
  googleClientId = process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '',
  // Injectable only for deterministic provider-protocol tests; production uses Google's verifier.
  googleClient,
  onRevoke = () => {},
  now = Date.now,
  rateLimit = 30,
} = {}) {
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== publicOrigin) throw Error('APP_ORIGIN must be an origin without a path or trailing slash');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('APP_ORIGIN must use HTTPS outside localhost');
  }
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) throw Error('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  if (googleClientId && !publicOrigin) throw Error('Set APP_ORIGIN before enabling Google sign-in');
  const secure = secureCookies || publicOrigin.startsWith('https:');
  const cookieName = secure ? '__Host-fyp_session' : 'fyp_session';
  const oauthCookie = secure ? '__Host-fyp_oauth' : 'fyp_oauth';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/' };
  const originFor = req => publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  const sameOrigin = req => req.headers.origin === originFor(req);
  const tokenOf = req => cookieValue(req, cookieName);
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(filename, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    chmodSync(filename, 0o600);
  }
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT, google_sub TEXT UNIQUE, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      guest_name TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL,
      return_to TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  const googleEnabled = Boolean(googleClientId && googleClientSecret);
  const redirectUri = `${publicOrigin}/api/auth/google/callback`;
  const oauth = googleEnabled ? googleClient || new OAuth2Client(googleClientId, googleClientSecret, redirectUri) : null;
  const router = express.Router();
  const attempts = new Map();
  let activeHashes = 0;
  async function passwordKey(password, salt) {
    if (activeHashes >= 2) {
      const error = Error('Sign-in is busy. Please try again shortly.'); error.status = 503; throw error;
    }
    activeHashes++;
    try { return await derive(password, salt, 64, KDF); } finally { activeHashes--; }
  }
  const dummySalt = randomBytes(16).toString('hex');
  async function passwordHash(password) {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${(await passwordKey(password, salt)).toString('hex')}`;
  }
  async function passwordMatches(password, stored) {
    const [salt, hash] = stored?.split(':') || [dummySalt, '0'.repeat(128)];
    const candidate = await passwordKey(password, salt);
    return timingSafeEqual(candidate, Buffer.from(hash, 'hex')) && Boolean(stored);
  }
  function getSession(req) {
    const token = tokenOf(req);
    if (!token) return null;
    const row = db.prepare(`SELECT s.token_hash, s.expires_at, s.user_id, s.guest_name, u.name
      FROM sessions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(digest(token), now());
    if (!row) return null;
    return { hash: row.token_hash, expiresAt: row.expires_at,
      identity: { id: row.user_id || `guest:${row.token_hash}`, name: row.name || row.guest_name, kind: row.user_id ? 'account' : 'guest' } };
  }
  function revoke(req) {
    const token = tokenOf(req);
    if (!token) return;
    const hash = digest(token);
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    onRevoke(hash);
  }
  function issueSession(req, res, userId, guestName) {
    const token = randomToken(), expiresAt = now() + (userId ? 7 * DAY : DAY / 2);
    db.prepare('INSERT INTO sessions (token_hash, user_id, guest_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(digest(token), userId, guestName, now(), expiresAt);
    revoke(req);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: expiresAt - now() });
    return getSession({ headers: { cookie: `${cookieName}=${token}` } });
  }
  const publicSession = session => ({ name: session.identity.name, kind: session.identity.kind, expiresAt: session.expiresAt });
  function limit(req, res, next) {
    const key = req.socket.remoteAddress || 'unknown', at = now();
    let entry = attempts.get(key);
    if (!entry || entry.until <= at) {
      if (attempts.size >= 10000 && !attempts.has(key)) return res.status(429).json({ error: 'Too many requests. Try again later.' });
      entry = { count: 0, until: at + 15 * 60 * 1000 }; attempts.set(key, entry);
    }
    if (++entry.count > rateLimit) return res.status(429).set('Retry-After', String(Math.ceil((entry.until - at) / 1000))).json({ error: 'Too many attempts. Try again later.' });
    next();
  }
  const clean = setInterval(() => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now());
    for (const [key, entry] of attempts) if (entry.until <= now()) attempts.delete(key);
  }, 60000);
  clean.unref();
  router.use('/api/auth', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use('/api/auth', (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (!sameOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Please submit this request from the meeting website.' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
    next();
  });
  router.use('/api/auth', express.json({ limit: '8kb', strict: true }));
  router.get('/api/auth/options', (_req, res) => res.json({ google: googleEnabled }));
  router.get('/api/auth/session', (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in or continue as guest.' });
    res.json(publicSession(session));
  });
  router.post('/api/auth/signup', limit, async (req, res) => {
    const { name, password } = req.body || {}, email = emailOf(req.body?.email);
    if (!validName(name) || !validEmail(email) || !validPassword(password)) return res.status(400).json({ error: 'Enter a name (1–40 characters), valid email, and password (12–128 characters).' });
    const hash = await passwordHash(password), id = randomUUID();
    const result = db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, email, name.trim(), hash, now());
    if (!result.changes) return res.status(409).json({ error: 'An account already uses this email. Please use its existing sign-in method.' });
    res.status(201).json(publicSession(issueSession(req, res, id, null)));
  });
  router.post('/api/auth/login', limit, async (req, res) => {
    const email = emailOf(req.body?.email), password = req.body?.password;
    if (!validEmail(email) || typeof password !== 'string' || !password.length || password.length > 128) return res.status(400).json({ error: 'Enter your email and password.' });
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    if (!await passwordMatches(password, user?.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    res.json(publicSession(issueSession(req, res, user.id, null)));
  });
  router.post('/api/auth/guest', limit, (req, res) => {
    const { name } = req.body || {};
    if (!validName(name)) return res.status(400).json({ error: 'Enter a guest name (1–40 characters).' });
    res.status(201).json(publicSession(issueSession(req, res, null, name.trim())));
  });
  router.post('/api/auth/logout', (req, res) => {
    revoke(req); res.clearCookie(cookieName, cookieOptions); res.status(204).end();
  });
  router.get('/api/auth/google', limit, (req, res) => {
    const target = meetingTarget(req.query.next);
    if (!googleEnabled) return res.redirect(`/auth?next=${encodeURIComponent(target)}&error=google_unavailable`);
    const state = randomToken(), verifier = randomToken(), nonce = randomToken();
    // A browser-bound state and nonce prevent login CSRF and replay; PKCE binds the code exchange.
    const oldState = cookieValue(req, oauthCookie);
    if (oldState) db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(digest(oldState));
    db.prepare('INSERT INTO oauth_states VALUES (?, ?, ?, ?, ?)').run(digest(state), verifier, nonce, target, now() + 5 * 60 * 1000);
    res.cookie(oauthCookie, state, { ...cookieOptions, maxAge: 5 * 60 * 1000 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: googleClientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid email profile', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
    res.redirect(url.href);
  });
  router.get('/api/auth/google/callback', async (req, res) => {
    const state = cookieValue(req, oauthCookie), returned = req.query.state;
    res.clearCookie(oauthCookie, cookieOptions);
    if (!googleEnabled || !state || returned !== state) return res.redirect('/auth?error=google_failed');
    const pending = db.prepare('SELECT * FROM oauth_states WHERE state_hash = ? AND expires_at > ?').get(digest(state), now());
    db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(digest(state));
    if (!pending) return res.redirect('/auth?error=google_failed');
    const fail = code => res.redirect(`/auth?next=${encodeURIComponent(pending.return_to)}&error=${code}`);
    if (req.query.error || typeof req.query.code !== 'string') return fail('google_cancelled');
    try {
      const { tokens } = await oauth.getToken({ code: req.query.code, codeVerifier: pending.verifier, redirect_uri: redirectUri });
      if (!tokens.id_token) return fail('google_failed');
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: googleClientId });
      const claims = ticket.getPayload();
      if (typeof claims?.sub !== 'string' || !claims.sub || claims.email_verified !== true || claims.nonce !== pending.nonce || !validEmail(emailOf(claims.email))) return fail('google_failed');
      let user = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(claims.sub);
      if (!user) {
        // Never silently link an unverified local-email account to a Google identity.
        const email = emailOf(claims.email), id = randomUUID();
        const name = typeof claims.name === 'string' ? claims.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
        const inserted = db.prepare('INSERT OR IGNORE INTO users (id, email, name, google_sub, created_at) VALUES (?, ?, ?, ?, ?)').run(id, email, name || 'Google user', claims.sub, now());
        user = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(claims.sub);
        if (!inserted.changes && !user) return fail('account_method');
      }
      issueSession(req, res, user.id, null);
      res.redirect(pending.return_to);
    } catch { return fail('google_failed'); }
  });
  router.use('/api/auth', (error, _req, res, _next) => {
    const status = error.status === 503 ? 503 : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: status === 503 ? error.message : status === 400 ? 'Invalid request.' : status === 413 ? 'Request too large.' : 'Sign-in could not be completed. Please try again.' });
  });
  return { router, getSession, sameOrigin, database: db,
    requireSession(req, res, next) {
      res.set('Cache-Control', 'no-store');
      if (!getSession(req)) return res.redirect(`/auth?next=${encodeURIComponent(meetingTarget(req.originalUrl))}`);
      next();
    },
    close() { clearInterval(clean); db.close(); }
  };
}
