import test from 'node:test';
import assert from 'node:assert/strict';
import { privateMessage } from '../chat.js';

const peer = (id, username) => ({ id, username });
function setup() {
  const a = peer('a', 'Alice'), b = peer('b', 'Bob'), c = peer('c', 'Carol');
  return { a, b, c, room: { peers: new Set([a, b, c]) } };
}

test('private message targets only the named recipient and trims text', () => {
  const { a, b, room } = setup();
  const { recipient, payload } = privateMessage(room, a, { to: 'b', text: '  hi  ' });
  assert.equal(recipient, b);
  assert.deepEqual(payload.from, { peerId: 'a', username: 'Alice' });
  assert.deepEqual(payload.to, { peerId: 'b', username: 'Bob' });
  assert.equal(payload.text, 'hi');
});
test('rejects self, unknown, departed, empty, oversized and non-string input', () => {
  const { a, room } = setup();
  for (const data of [{ to: 'a', text: 'x' }, { to: 'zzz', text: 'x' }, { to: 'b', text: '   ' }, { to: 'b', text: 'x'.repeat(1001) }, { to: 'b', text: 5 }, { to: 7, text: 'x' }, {}])
    assert.throws(() => privateMessage(room, a, data));
  room.peers.delete([...room.peers].find(p => p.id === 'b'));
  assert.throws(() => privateMessage(room, a, { to: 'b', text: 'x' }), /no longer/);
});
test('rate limits a sender per window', () => {
  const { a, room } = setup();
  for (let i = 0; i < 10; i++) privateMessage(room, a, { to: 'b', text: 'x' }, 1000);
  assert.throws(() => privateMessage(room, a, { to: 'b', text: 'x' }, 1000), /slow down/);
  assert.doesNotThrow(() => privateMessage(room, a, { to: 'b', text: 'x' }, 7000));
});
