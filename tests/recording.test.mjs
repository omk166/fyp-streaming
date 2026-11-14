import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomRecording } from '../recording.js';
function room() {
  const host = { id: 'host', username: 'Host', role: 'owner' }, guest = { id: 'guest', username: 'Guest', role: 'participant' };
  const peers = new Set([host, guest]), events = [], timers = new Map(); let serial = 0;
  const policy = createRoomRecording({ peers, publish: value => events.push(value), now: () => 1234,
    setTimer(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearTimer(id) { timers.delete(id); } });
  return { host, guest, peers, events, timers, policy };
}
test('recording requires owner request and explicit approval from every current participant', () => {
  const r = room();
  assert.throws(() => r.policy.request(r.guest), /owner/);
  const request = r.policy.request(r.host);
  assert.equal(request.phase, 'consent'); assert.deepEqual(request.approvedPeerIds, ['host']);
  assert.throws(() => r.policy.consent({ id: 'outside' }, request.id, true), /Join/);
  assert.throws(() => r.policy.consent(r.guest, 'stale', true), /no longer/);
  assert.throws(() => r.policy.request(r.host), /already/);
  const active = r.policy.consent(r.guest, request.id, true);
  assert.equal(active.phase, 'recording'); assert.equal(active.startedAt, 1234);
  assert.throws(() => r.policy.stop(r.guest, request.id), /owner/);
  assert.equal(r.policy.consent(r.guest, request.id, false).phase, 'idle');
  assert.match(r.events.at(-1).reason, /withdrew/);
});
test('declining cancels; stale consent cannot start a later request', () => {
  const r = room(), first = r.policy.request(r.host);
  r.policy.consent(r.guest, first.id, false);
  assert.equal(r.policy.snapshot().phase, 'idle');
  const second = r.policy.request(r.host);
  assert.notEqual(first.id, second.id);
  assert.throws(() => r.policy.consent(r.guest, first.id, true), /no longer/);
  assert.equal(r.policy.snapshot().phase, 'consent');
});
test('new join stops recording before their media and requires new consent', () => {
  const r = room(), request = r.policy.request(r.host);
  r.policy.consent(r.guest, request.id, true); r.policy.beforeJoin();
  assert.equal(r.policy.snapshot().phase, 'idle'); assert.match(r.events.at(-1).reason, /someone joined/);
  const late = { id: 'late', username: 'Late', role: 'participant' }; r.peers.add(late);
  const next = r.policy.request(r.host); r.policy.consent(r.guest, next.id, true);
  assert.equal(r.policy.snapshot().phase, 'consent');
  assert.equal(r.policy.consent(late, next.id, true).phase, 'recording');
});
test('pending join must consent; participant leave updates quorum; host leave/failure stops', () => {
  const r = room(), request = r.policy.request(r.host), late = { id: 'late', username: 'Late', role: 'participant' };
  r.peers.add(late); r.policy.membershipChanged(); r.policy.consent(r.guest, request.id, true);
  assert.equal(r.policy.snapshot().phase, 'consent');
  r.peers.delete(late); r.policy.memberLeft(late.id); assert.equal(r.policy.snapshot().phase, 'recording');
  assert.throws(() => r.policy.failed(r.guest, request.id), /belongs/);
  r.policy.failed(r.host, request.id); assert.equal(r.policy.snapshot().phase, 'idle');
  r.policy.request(r.host); r.peers.delete(r.host); r.policy.memberLeft(r.host.id);
  assert.equal(r.policy.snapshot().phase, 'idle'); assert.equal(r.timers.size, 0);
});
test('consent timeout and duration cap stop cleanly without leaked timers', () => {
  const r = room(); r.policy.request(r.host);
  const pending = [...r.timers.values()][0]; assert.equal(pending.ms, 120000); pending.fn();
  assert.equal(r.policy.snapshot().phase, 'idle');
  const next = r.policy.request(r.host); r.policy.consent(r.guest, next.id, true);
  const active = [...r.timers.values()][0]; assert.equal(active.ms, 1800000); active.fn();
  assert.equal(r.policy.snapshot().phase, 'idle'); assert.equal(r.timers.size, 0);
  r.policy.dispose();
});
