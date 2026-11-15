import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';

const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const unavailable = () => Object.assign(Error('This invitation is unavailable, expired, or the room is closed.'), { status: 403 });
export function createRoomAccess({ auth, onChange = () => {}, now = Date.now }) {
  const db = auth.database;
  db.exec(`CREATE TABLE IF NOT EXISTS meeting_rooms (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_hash TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS rooms_owner ON meeting_rooms(owner_id);
  CREATE TABLE IF NOT EXISTS meeting_visits (
    id TEXT PRIMARY KEY, identity_key TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES meeting_rooms(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL, left_at INTEGER
  ); CREATE INDEX IF NOT EXISTS visits_identity ON meeting_visits(identity_key, joined_at);`);
  // A previous process cannot still have live peers. Do not invent offline time.
  db.prepare('UPDATE meeting_visits SET left_at = joined_at WHERE left_at IS NULL').run();
  const get = id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id) ? db.prepare('SELECT * FROM meeting_rooms WHERE id = ?').get(id) : null;
  const isOwner = (identity, row) => identity.kind === 'account' && row.owner_id === identity.id;
  const view = (row, identity) => ({ id: row.id, name: row.name, locked: Boolean(row.locked), ended: Boolean(row.ended), createdAt: row.created_at, expiresAt: row.expires_at, role: isOwner(identity, row) ? 'owner' : 'participant' });
  function authorize(identity, id, invitation) {
    const row = get(id);
    if (!row || row.ended || row.expires_at <= now()) throw unavailable();
    if (isOwner(identity, row)) return view(row, identity);
    if (row.locked || typeof invitation !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(invitation) || !timingSafeEqual(Buffer.from(row.invite_hash, 'hex'), Buffer.from(hash(invitation), 'hex'))) throw unavailable();
    return view(row, identity);
  }
  function owner(identity, id) {
    const row = get(id);
    if (!row || !isOwner(identity, row)) throw Object.assign(Error('Only the room owner can do that.'), { status: 403 });
    if (row.ended || row.expires_at <= now()) throw unavailable();
    return row;
  }
  const router = express.Router(), recent = new Map();
  router.use('/api/rooms', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const session = auth.getSession(req);
    if (!session) return res.status(401).json({ error: 'Please log in or continue as guest.' });
    req.identity = session.identity;
    if (req.method === 'POST') {
      if (!auth.sameOrigin(req)) return res.status(403).json({ error: 'Please use the meeting website.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
      const key = session.hash, at = now(), entry = recent.get(key);
      if (entry && entry.until > at) {
        if (++entry.count > 60) return res.status(429).json({ error: 'Please wait before trying again.' });
      } else {
        for (const [key, entry] of recent) if (entry.until <= at) recent.delete(key);
        if (recent.size >= 10000) return res.status(429).json({ error: 'Please try again later.' });
        recent.set(key, { count: 1, until: at + 60000 });
      }
    }
    next();
  }, express.json({ limit: '4kb', strict: true }));
  router.get('/api/rooms', (req, res) => {
    const rows = req.identity.kind === 'account' ? db.prepare('SELECT * FROM meeting_rooms WHERE owner_id = ? AND ended = 0 AND expires_at > ? ORDER BY created_at DESC').all(req.identity.id, now()) : [];
    res.json({ rooms: rows.map(row => view(row, req.identity)) });
  });
  router.get('/api/rooms/history', (req, res) => {
    const rows = db.prepare(`SELECT r.*, v.last_joined_at, v.last_left_at, v.visits
      FROM meeting_rooms r LEFT JOIN (
        SELECT room_id, max(joined_at) AS last_joined_at, max(left_at) AS last_left_at, count(*) AS visits
        FROM meeting_visits WHERE identity_key = ? GROUP BY room_id
      ) v ON v.room_id = r.id
      WHERE (r.owner_id = ? AND ? = 'account') OR v.room_id IS NOT NULL
      ORDER BY coalesce(v.last_joined_at, r.created_at) DESC, r.id LIMIT 100`)
      .all(req.identity.id, req.identity.id, req.identity.kind);
    res.json({ meetings: rows.map(row => ({ ...view(row, req.identity),
      lastJoinedAt: row.last_joined_at || null, lastLeftAt: row.last_left_at || null, visits: row.visits || 0 })) });
  });
  router.post('/api/rooms', (req, res) => {
    if (req.identity.kind !== 'account') return res.status(403).json({ error: 'Log in to an account to create a room. Guests can join by invitation.' });
    const name = req.body?.name;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 48 || /[\u0000-\u001f\u007f]/.test(name)) return res.status(400).json({ error: 'Enter a room name (1–48 characters).' });
    const count = db.prepare('SELECT count(*) AS n FROM meeting_rooms WHERE owner_id = ? AND ended = 0 AND expires_at > ?').get(req.identity.id, now()).n;
    if (count >= 100) return res.status(409).json({ error: 'End an existing room before creating another.' });
    const id = randomBytes(12).toString('hex'), invitation = token();
    db.prepare('INSERT INTO meeting_rooms (id, name, owner_id, invite_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name.trim(), req.identity.id, hash(invitation), now(), now() + 7 * 86400000);
    res.status(201).json({ room: view(get(id), req.identity), invitation });
  });
  router.post('/api/rooms/resolve', (req, res) => res.json({ room: authorize(req.identity, req.body?.roomId, req.body?.invitation) }));
  router.post('/api/rooms/find', (req, res) => {
    const { name, invitation, roomId } = req.body || {};
    if (roomId) return res.json({ room: authorize(req.identity, roomId, invitation) });
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 48) return res.status(400).json({ error: 'Enter a meeting name or paste an invitation link.' });
    let rows = [];
    if (typeof invitation === 'string' && /^[A-Za-z0-9_-]{43}$/.test(invitation)) {
      rows = db.prepare('SELECT * FROM meeting_rooms WHERE name = ? COLLATE NOCASE AND invite_hash = ?').all(name.trim(), hash(invitation));
    } else if (req.identity.kind === 'account') {
      rows = db.prepare('SELECT * FROM meeting_rooms WHERE name = ? COLLATE NOCASE AND owner_id = ? AND ended = 0 AND expires_at > ?').all(name.trim(), req.identity.id, now());
    }
    if (rows.length > 1) return res.status(409).json({ error: 'Several of your meetings share this name. Open one from history or use its invitation link.' });
    if (!rows.length) return res.status(403).json({ error: 'Use a current invitation link, or enter the meeting name and invitation code. Owners can open their meetings from history.' });
    res.json({ room: authorize(req.identity, rows[0].id, invitation) });
  });
  router.post('/api/rooms/:id/lock', (req, res) => {
    owner(req.identity, req.params.id);
    if (typeof req.body?.locked !== 'boolean') return res.status(400).json({ error: 'Choose whether to lock the room.' });
    db.prepare('UPDATE meeting_rooms SET locked = ? WHERE id = ?').run(req.body.locked ? 1 : 0, req.params.id);
    const room = view(get(req.params.id), req.identity); onChange(room);
    res.json({ room });
  });
  router.post('/api/rooms/:id/invitation', (req, res) => {
    owner(req.identity, req.params.id);
    const invitation = token(); db.prepare('UPDATE meeting_rooms SET invite_hash = ? WHERE id = ?').run(hash(invitation), req.params.id);
    res.json({ room: view(get(req.params.id), req.identity), invitation });
  });
  router.post('/api/rooms/:id/end', (req, res) => {
    owner(req.identity, req.params.id);
    db.prepare('UPDATE meeting_rooms SET ended = 1 WHERE id = ?').run(req.params.id);
    db.prepare('UPDATE meeting_visits SET left_at = ? WHERE room_id = ? AND left_at IS NULL').run(now(), req.params.id);
    const room = view(get(req.params.id), req.identity); onChange(room);
    res.json({ room });
  });
  router.use('/api/rooms', (error, _req, res, _next) => {
    const status = [400, 403, 413].includes(error.status) ? error.status : 500;
    res.status(status).json({ error: status === 403 ? error.message : status === 400 ? 'Invalid request.' : status === 413 ? 'Request too large.' : 'Room request could not be completed.' });
  });
  return { router, authorize,
    joined(identity, roomId) {
      const id = randomBytes(16).toString('hex');
      db.prepare('INSERT INTO meeting_visits (id, identity_key, room_id, joined_at) VALUES (?, ?, ?, ?)').run(id, identity.id, roomId, now());
      return id;
    },
    left(id) { if (id) db.prepare('UPDATE meeting_visits SET left_at = ? WHERE id = ? AND left_at IS NULL').run(now(), id); },
  };
}
