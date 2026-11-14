import { randomUUID } from 'node:crypto';
import express from 'express';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import * as mediasoup from 'mediasoup';
import { createAuth } from './auth.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const mediaIp = process.env.MEDIA_IP || '127.0.0.1';
const announcedAddress = process.env.ANNOUNCED_ADDRESS || (mediaIp === '0.0.0.0' ? '127.0.0.1' : undefined);
if (Boolean(process.env.TLS_CERT) !== Boolean(process.env.TLS_KEY)) throw Error('Set both TLS_CERT and TLS_KEY');
const tls = process.env.TLS_CERT ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) } : null;
const worker = await mediasoup.createWorker({ logLevel: 'warn' });
worker.on('died', () => process.exit(1));
const webRtcServer = await worker.createWebRtcServer({ listenInfos: [
  { protocol: 'udp', ip: mediaIp, announcedAddress, port: Number(process.env.MEDIA_PORT || 40000) },
  { protocol: 'tcp', ip: mediaIp, announcedAddress, port: Number(process.env.MEDIA_PORT || 40000) }
] });
const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: {
    'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1
  } },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 0 } }
];
const rooms = new Map();
const creating = new Map();
async function getRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  if (!creating.has(id)) creating.set(id, (async () => {
    const room = { router: await worker.createRouter({ mediaCodecs }), peers: new Set(), board: { strokes: [], index: new Map(), points: 0, frozen: new Map() } };
    rooms.set(id, room);
    return room;
  })());
  try { return await creating.get(id); } finally { creating.delete(id); }
}
const app = express();
let wss;
const auth = createAuth({ secureCookies: Boolean(tls), onRevoke(hash) {
  for (const ws of wss?.clients || []) if (ws.sessionHash === hash) ws.close(1008, 'Session ended');
} });
app.disable('x-powered-by');
app.use((_req, res, next) => { res.set('Referrer-Policy', 'no-referrer'); res.set('X-Content-Type-Options', 'nosniff'); next(); });
app.use(auth.router);
app.get(['/auth', '/auth.html'], (_req, res) => res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" }).sendFile(fileURLToPath(new URL('./public/auth.html', import.meta.url))));
app.get(['/', '/index.html'], auth.requireSession, (_req, res) => res.sendFile(fileURLToPath(new URL('./public/index.html', import.meta.url))));
app.use(express.static('public', { index: false }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = tls ? createHttpsServer(tls, app) : createServer(app);
// 1 MiB so a paused screen's still image (a JPEG data URL, capped below) fits in one message.
wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const session = auth.getSession(req);
  if (!auth.sameOrigin(req) || !session) {
    socket.end(`HTTP/1.1 ${session ? '403 Forbidden' : '401 Unauthorized'}\r\nConnection: close\r\n\r\n`); return;
  }
  req.session = session;
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
function emit(peer, event, data) {
  if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify({ event, data }));
}
function broadcast(room, except, event, data) {
  for (const peer of room.peers) if (peer !== except) emit(peer, event, data);
}
function owned(map, id) {
  const item = map.get(id);
  if (!item || item.closed) throw Error('Object unavailable or not owned by this connection');
  return item;
}
function participant(peer) {
  return { peerId: peer.id, username: peer.username, kind: peer.identity.kind, micMuted: peer.micMuted, handRaised: peer.handRaised };
}
function sharing(room, target) {
  return typeof target === 'string' && [...room.peers].some(p => p.id === target && [...p.producers.values()].some(pr => pr.appData.source === 'screen'));
}
function dropStroke(board, stroke) {
  board.strokes.splice(board.strokes.indexOf(stroke), 1); board.index.delete(stroke.key); board.points -= stroke.pts.length;
}
function clearStrokes(room, target) {
  for (const stroke of room.board.strokes.filter(s => s.target === target)) dropStroke(room.board, stroke);
}
// Share stopped or sharer left: drop the drawings AND the pause.
function clearTarget(room, target) {
  room.board.frozen.delete(target);
  clearStrokes(room, target);
}
const STILL = /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/]+=*$/;
async function action(peer, method, data) {
  if (method === 'join') {
    if (peer.room || !/^[a-zA-Z0-9_-]{1,48}$/.test(data.room)) throw Error('Invalid room');
    // Identity comes from the authenticated/guest session, never a client-supplied label.
    peer.username = peer.identity.name;
    peer.room = await getRoom(data.room);
    peer.roomId = data.room;
    peer.room.peers.add(peer);
    broadcast(peer.room, peer, 'participant', participant(peer));
    return { routerRtpCapabilities: peer.room.router.rtpCapabilities, peerId: peer.id, username: peer.username, participants: [...peer.room.peers].map(participant), board: peer.room.board.strokes, frozen: [...peer.room.board.frozen].map(([target, image]) => ({ target, image })) };
  }
  const room = peer.room;
  if (!room) throw Error('Join first');
  switch (method) {
    case 'transport': {
      if (peer.transports.size >= 2 || !['send', 'recv'].includes(data.direction)) throw Error('Invalid transport');
      const transport = await room.router.createWebRtcTransport({ webRtcServer, appData: { direction: data.direction } });
      peer.transports.set(transport.id, transport);
      return { id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters };
    }
    case 'connect':
      await owned(peer.transports, data.id).connect({ dtlsParameters: data.dtlsParameters }); return {};
    case 'produce': {
      const transport = owned(peer.transports, data.transportId);
      if (transport.appData.direction !== 'send' || peer.producers.size >= 3) throw Error('Invalid producer');
      const source = data.source || (data.kind === 'audio' ? 'microphone' : 'camera');
      if (!['microphone','camera','screen'].includes(source) || (source === 'microphone' ? data.kind !== 'audio' : data.kind !== 'video') || [...peer.producers.values()].some(p => p.appData.source === source)) throw Error('Invalid media source');
      const producer = await transport.produce({ kind: data.kind, rtpParameters: data.rtpParameters, appData: { source, peerId: peer.id, username: peer.username } });
      peer.producers.set(producer.id, producer);
      broadcast(room, peer, 'producer', { producerId: producer.id });
      return { id: producer.id };
    }
    case 'closeProducer': {
      const producer = owned(peer.producers, data.id);
      producer.close(); peer.producers.delete(producer.id);
      if (producer.appData.source === 'screen') { clearTarget(room, peer.id); broadcast(room, null, 'wbClear', { target: peer.id, silent: true }); }
      return {};
    }
    case 'list':
      return [...room.peers].filter(p => p !== peer).flatMap(p => [...p.producers.keys()]);
    case 'consume': {
      const producer = [...room.peers].filter(p => p !== peer).flatMap(p => [...p.producers.values()]).find(p => p.id === data.producerId);
      if (!producer || !room.router.canConsume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities })) throw Error('Cannot consume');
      const transport = owned(peer.transports, data.transportId);
      if (transport.appData.direction !== 'recv' || peer.consumers.size >= 48) throw Error('Invalid consumer');
      const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities, paused: true });
      peer.consumers.set(consumer.id, consumer);
      consumer.on('producerpause', () => emit(peer, 'consumerPaused', { id: consumer.id, paused: true }));
      consumer.on('producerresume', () => emit(peer, 'consumerPaused', { id: consumer.id, paused: false }));
      consumer.on('producerclose', () => { peer.consumers.delete(consumer.id); emit(peer, 'consumerClosed', { id: consumer.id }); });
      return { id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters, appData: producer.appData };
    }
    case 'resume': {
      const consumer = owned(peer.consumers, data.id);
      await consumer.resume(); return { producerPaused: consumer.producerPaused };
    }
    case 'pauseProducer': {
      const producer = owned(peer.producers, data.id);
      if (typeof data.paused !== 'boolean') throw Error('Invalid pause state');
      await (data.paused ? producer.pause() : producer.resume());
      if (producer.appData.source === 'microphone') {
        peer.micMuted = data.paused; broadcast(room, null, 'participant', participant(peer));
      }
      return {};
    }
    case 'hand': {
      if (typeof data.raised !== 'boolean') throw Error('Invalid hand state');
      peer.handRaised = data.raised;
      broadcast(room, null, 'participant', participant(peer)); return {};
    }
    case 'reaction': {
      if (!['thumbs-up', 'heart', 'laugh'].includes(data.reaction)) throw Error('Invalid reaction');
      if (Date.now() - peer.lastReaction < 800) throw Error('Please wait before reacting again');
      peer.lastReaction = Date.now();
      broadcast(room, null, 'reaction', { ...participant(peer), reaction: data.reaction }); return {};
    }
    case 'chat': {
      if (typeof data.text !== 'string' || data.text.length > 1000) throw Error('Invalid message');
      broadcast(room, null, 'chat', { text: data.text, username: peer.username, at: new Date().toISOString() }); return {};
    }
    case 'stats': {
      const transports = [];
      for (const t of peer.transports.values()) transports.push({ id: t.id, direction: t.appData.direction, reports: await t.getStats() });
      return { timestamp: new Date().toISOString(), nodeMemory: process.memoryUsage(), nodeCpu: process.cpuUsage(), worker: await worker.getResourceUsage(), peers: room.peers.size, transports };
    }
    case 'wbSegment': {
      const now = Date.now();
      if (now - peer.wbWindow > 1000) { peer.wbWindow = now; peer.wbCount = 0; }
      if (++peer.wbCount > 60) throw Error('Whiteboard rate limit');
      const { id, color, size, pts, target } = data;
      if (!sharing(room, target)) throw Error('That screen is not being shared');
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(id) || !/^#[0-9a-fA-F]{6}$/.test(color) || !(size >= 1 && size <= 40)) throw Error('Invalid stroke');
      if (!Array.isArray(pts) || !pts.length || pts.length > 200 || !pts.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && n >= 0 && n <= 1))) throw Error('Invalid points');
      const board = room.board, key = `${peer.id}:${id}`;
      let stroke = board.index.get(key);
      if (!stroke) {
        stroke = { key, target, color, size, pts: [] };
        board.index.set(key, stroke); board.strokes.push(stroke);
      }
      stroke.pts.push(...pts); board.points += pts.length;
      while (board.points > 50000 && board.strokes.length > 1) dropStroke(board, board.strokes[0]);
      broadcast(room, peer, 'wbSegment', { key, target, color: stroke.color, size: stroke.size, pts }); return {};
    }
    case 'wbFreeze': {
      // Only the sharer can pause their own screen. The still is the exact frame they paused on, so viewers
      // (and anyone who joins later) all see the same picture under the live drawings.
      if (data.target !== peer.id || !sharing(room, data.target) || typeof data.frozen !== 'boolean') throw Error('Invalid freeze request');
      const image = data.frozen && typeof data.image === 'string' && data.image.length <= 900000 && STILL.test(data.image) ? data.image : null;
      data.frozen ? room.board.frozen.set(data.target, image) : room.board.frozen.delete(data.target);
      broadcast(room, peer, 'wbFreeze', { target: data.target, frozen: data.frozen, image, username: peer.username }); return {};
    }
    case 'wbClear': {
      // Clears drawings only; a paused screen stays paused.
      if (!sharing(room, data.target)) throw Error('That screen is not being shared');
      clearStrokes(room, data.target);
      broadcast(room, peer, 'wbClear', { target: data.target, username: peer.username }); return {};
    }
    case 'wbUndo': {
      if (!sharing(room, data.target)) throw Error('That screen is not being shared');
      const stroke = room.board.strokes.findLast(s => s.target === data.target && s.key.startsWith(`${peer.id}:`));
      if (!stroke) return { key: null };
      dropStroke(room.board, stroke);
      broadcast(room, peer, 'wbRemove', { target: data.target, key: stroke.key }); return { key: stroke.key };
    }
    default: throw Error('Unknown method');
  }
}
wss.on('connection', (ws, req) => {
  ws.sessionHash = req.session.hash;
  const expiry = setTimeout(() => ws.close(1008, 'Session expired'), Math.max(1, req.session.expiresAt - Date.now()));
  expiry.unref();
  const peer = { id: randomUUID(), identity: req.session.identity, micMuted: false, handRaised: false, lastReaction: 0, wbWindow: 0, wbCount: 0, ws, room: null, transports: new Map(), producers: new Map(), consumers: new Map() };
  let queue = Promise.resolve();
  ws.on('message', raw => {
    queue = queue.then(async () => {
      let request;
      try {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!auth.getSession(req)) { ws.close(1008, 'Session ended'); return; }
        request = JSON.parse(raw.toString());
        const result = await action(peer, request.method, request.data || {});
        if (request.id !== undefined && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, result }));
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request?.id, error: error.message }));
      }
    });
  });
  ws.on('close', () => {
    clearTimeout(expiry);
    queue.finally(() => {
      for (const t of peer.transports.values()) t.close();
      const room = peer.room;
      if (room) {
        room.peers.delete(peer); clearTarget(room, peer.id);
        broadcast(room, null, 'participantLeft', { peerId: peer.id });
        if (!room.peers.size) { room.router.close(); rooms.delete(peer.roomId); }
      }
    });
  });
});
server.listen(port, host, () => { console.log(`Streaming lab: ${tls ? 'https' : 'http'}://${host}:${port}`); startScreenPen(); });
// Screen pen (overlay/): on the Mac/PC you present from, start the draw-over-any-app helper together with the
// server, so there is nothing extra to run. Skipped on Linux servers; SCREEN_PEN=0 turns it off.
let screenPen = null;
function startScreenPen() {
  if (!['darwin', 'win32'].includes(process.platform) || process.env.SCREEN_PEN === '0') return;
  const dir = fileURLToPath(new URL('./overlay/', import.meta.url)), cli = `${dir}node_modules/electron/cli.js`;
  // electron's cli.js forwards SIGINT/SIGTERM to the app, so stopping the server stops the pen too.
  const run = () => { screenPen = spawn(process.execPath, [cli, '.'], { cwd: dir, stdio: 'inherit' }); screenPen.on('exit', () => { screenPen = null; }); };
  if (existsSync(cli)) return run();
  console.log('[screen pen] Installing (first run only)...');
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
    .on('exit', code => code ? console.log('[screen pen] Install failed; drawing over other apps is unavailable.') : run());
}
function stop() { screenPen?.kill(); for (const client of wss.clients) client.terminate(); worker.close(); server.close(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
