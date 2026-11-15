import { randomUUID } from 'node:crypto';

// Separate from screen annotations. Board state lives for the active room only.
export function createWhiteboard() {
  let revision = randomUUID(), items = [], points = 0, showing = false;
  const snapshot = () => ({ revision, items: [...items], showing });
  return {
    snapshot,
    add(peer, data) {
      if (data.revision !== revision) throw Error('The whiteboard was cleared. Please draw again.');
      const { tool, color, size, pts, clientId } = data;
      if (!['pencil', 'marker', 'highlighter', 'eraser', 'line', 'arrow', 'rectangle', 'ellipse'].includes(tool)
        || (clientId !== undefined && (typeof clientId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(clientId)))
        || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)
        || !Number.isFinite(size) || size < 1 || size > 32
        || !Array.isArray(pts) || pts.length < 2 || pts.length > 2000
        || !pts.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && n >= 0 && n <= 1))
        || (['line', 'arrow', 'rectangle', 'ellipse'].includes(tool) && pts.length !== 2)) throw Error('Invalid whiteboard drawing');
      if (items.length >= 600 || points + pts.length > 50000) throw Error('Whiteboard is full. Undo drawings or ask the owner to clear it.');
      const item = { id: randomUUID(), clientId, peerId: peer.id, tool, color, size, pts: pts.map(p => [...p]) };
      items.push(item); points += pts.length;
      return { revision, item };
    },
    show(peer) {
      showing = true;
      return { revision, presenter: peer.username };
    },
    undo(peer) {
      const item = items.findLast(item => item.peerId === peer.id);
      if (item) { items = items.filter(entry => entry !== item); points -= item.pts.length; }
      return { revision, id: item?.id || null };
    },
    clear(peer) {
      if (peer.role !== 'owner') throw Error('Only the room owner can clear the whiteboard');
      items = []; points = 0; revision = randomUUID(); return snapshot();
    },
  };
}
