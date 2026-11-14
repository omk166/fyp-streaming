import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { createAuth } from '../auth.js';
import { createRoomAccess } from '../rooms.js';

async function harness(t, options = {}) {
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = createAuth({ filename: ':memory:', publicOrigin: '', googleClientId: '', googleClientSecret: '' });
  const access = createRoomAccess({ auth, ...options });
  app.use(auth.router, access.router);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); auth.close(); });
  const request = (path, body, cookie, headers = {}) => fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function identity(kind, name) {
    const response = await request(`/api/auth/${kind === 'account' ? 'signup' : 'guest'}`, kind === 'account' ? { name, email: `${name}@example.test`, password: 'a memorable room password' } : { name });
    assert.equal(response.status, 201); return response.headers.getSetCookie()[0].split(';')[0];
  }
  return { auth, access, request, identity };
}
test('only accounts create rooms and only owners list/manage them', async t => {
  const h = await harness(t), owner = await h.identity('account', 'owner'), other = await h.identity('account', 'other'), guest = await h.identity('guest', 'Guest');
  assert.equal((await h.request('/api/rooms', { name: 'Private' })).status, 401);
  assert.equal((await h.request('/api/rooms', { name: 'Private' }, guest)).status, 403);
  const response = await h.request('/api/rooms', { name: 'Private meeting' }, owner);
  assert.equal(response.status, 201);
  const { room, invitation } = await response.json();
  assert.equal(room.role, 'owner'); assert.equal(invitation.length, 43);
  assert.equal((await (await h.request('/api/rooms', undefined, owner)).json()).rooms.length, 1);
  assert.deepEqual((await (await h.request('/api/rooms', undefined, other)).json()).rooms, []);
  for (const cookie of [other, guest]) for (const action of ['lock', 'invitation', 'end']) assert.equal((await h.request(`/api/rooms/${room.id}/${action}`, { locked: true, owner_id: 'forged' }, cookie)).status, 403);
  assert.equal((await h.request('/api/rooms', { name: 'x' }, owner, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal(h.auth.database.prepare('SELECT invite_hash FROM meeting_rooms').get().invite_hash.includes(invitation), false);
});
test('guest and account admission requires a valid invitation; names do not grant ownership', async t => {
  const h = await harness(t), owner = await h.identity('account', 'owner'), guest = await h.identity('guest', 'owner');
  const { room, invitation } = await (await h.request('/api/rooms', { name: 'Team' }, owner)).json();
  for (const value of [undefined, '', 'a'.repeat(43), invitation + 'x']) assert.equal((await h.request('/api/rooms/resolve', { roomId: room.id, invitation: value }, guest)).status, 403);
  assert.equal((await h.request('/api/rooms/resolve', { roomId: 'guessed-room', invitation }, guest)).status, 403);
  const accepted = await (await h.request('/api/rooms/resolve', { roomId: room.id, invitation }, guest)).json();
  assert.equal(accepted.room.role, 'participant');
  assert.equal((await h.request('/api/rooms/resolve', { roomId: room.id }, owner)).status, 200);
});
test('locking, rotating invitations, ending, and expiry apply on the server', async t => {
  let clock = Date.now(); const changes = [];
  const h = await harness(t, { now: () => clock, onChange: room => changes.push(room) });
  const owner = await h.identity('account', 'owner'), guest = await h.identity('guest', 'Guest');
  const { room, invitation } = await (await h.request('/api/rooms', { name: 'Team' }, owner)).json();
  await h.request(`/api/rooms/${room.id}/lock`, { locked: true }, owner);
  assert.equal((await h.request('/api/rooms/resolve', { roomId: room.id, invitation }, guest)).status, 403);
  assert.equal((await h.request('/api/rooms/resolve', { roomId: room.id }, owner)).status, 200);
  await h.request(`/api/rooms/${room.id}/lock`, { locked: false }, owner);
  const rotated = await (await h.request(`/api/rooms/${room.id}/invitation`, {}, owner)).json();
  assert.notEqual(rotated.invitation, invitation);
  assert.equal((await h.request('/api/rooms/resolve', { roomId: room.id, invitation }, guest)).status, 403);
  assert.equal((await h.request('/api/rooms/resolve', { roomId: room.id, invitation: rotated.invitation }, guest)).status, 200);
  clock += 8 * 86400000;
  assert.equal((await h.request('/api/rooms/resolve', { roomId: room.id }, owner)).status, 403);
  clock -= 8 * 86400000;
  await h.request(`/api/rooms/${room.id}/end`, {}, owner);
  assert.equal((await h.request('/api/rooms/resolve', { roomId: room.id, invitation: rotated.invitation }, guest)).status, 403);
  assert.equal((await h.request('/api/rooms/resolve', { roomId: room.id }, owner)).status, 403);
  assert.equal(changes.at(-1).ended, true);
});
