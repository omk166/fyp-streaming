import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhiteboard } from '../whiteboard.js';
const owner = { id: 'owner', role: 'owner' }, guest = { id: 'guest', role: 'participant' };
const stroke = board => ({ revision: board.snapshot().revision, tool: 'pencil', color: '#2563eb', size: 5, pts: [[0, 0], [1, 1]] });
test('erasures share the ordered history and undo preserves the original drawing', () => {
  const board = createWhiteboard();
  const drawing = board.add(owner, stroke(board)).item;
  const erasure = board.add(guest, { ...stroke(board), tool: 'eraser', clientId: 'pending-eraser' }).item;
  assert.equal(erasure.clientId, 'pending-eraser');
  assert.deepEqual(board.snapshot().items.map(item => item.tool), ['pencil', 'eraser']);
  assert.equal(board.undo(guest).id, erasure.id);
  assert.deepEqual(board.snapshot().items, [drawing]);
});
test('presentation is included for late arrivals and survives clearing the board', () => {
  const board = createWhiteboard();
  assert.equal(board.snapshot().showing, false);
  assert.equal(board.show({ ...guest, username: 'Guest' }).presenter, 'Guest');
  assert.equal(board.snapshot().showing, true);
  board.clear(owner);
  assert.equal(board.snapshot().showing, true);
});
test('shared snapshot retains drawings; undo only removes the caller’s last drawing', () => {
  const board = createWhiteboard();
  const a = board.add(owner, stroke(board)).item, b = board.add(guest, stroke(board)).item;
  assert.deepEqual(board.snapshot().items.map(x => x.id), [a.id, b.id]);
  assert.equal(board.undo(owner).id, a.id);
  assert.equal(board.undo(owner).id, null);
  assert.deepEqual(board.snapshot().items.map(x => x.id), [b.id]);
});
test('owner clear invalidates in-flight drawings; participants cannot clear', () => {
  const board = createWhiteboard(), old = stroke(board);
  assert.throws(() => board.clear(guest), /owner/);
  board.clear(owner);
  assert.throws(() => board.add(guest, old), /cleared/);
  assert.equal(board.snapshot().items.length, 0);
});
test('validates coordinates, tools, sizes, shape endpoints, and board capacity', () => {
  const board = createWhiteboard();
  for (const change of [{ tool: 'script' }, { color: 'red' }, { size: Infinity }, { size: 0 }, { pts: [[-1, 0], [0, 0]] }, { pts: [[NaN, 0], [0, 0]] }, { tool: 'rectangle', pts: [[0, 0], [0, 0], [1, 1]] }]) {
    assert.throws(() => board.add(owner, { ...stroke(board), ...change }), /Invalid/);
  }
  for (let i = 0; i < 600; i++) board.add(owner, stroke(board));
  assert.throws(() => board.add(owner, stroke(board)), /full/);
  board.undo(owner); board.add(owner, stroke(board));
});
