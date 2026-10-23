import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as mediasoup from 'mediasoup';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const mediaIp = process.env.MEDIA_IP || '127.0.0.1';
const announcedAddress = process.env.ANNOUNCED_ADDRESS || (mediaIp === '0.0.0.0' ? '127.0.0.1' : undefined);
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
    const room = { router: await worker.createRouter({ mediaCodecs }), peers: new Set() };
    rooms.set(id, room);
    return room;
  })());
  try { return await creating.get(id); } finally { creating.delete(id); }
}
const app = express();
app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 128 * 1024 });
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
async function action(peer, method, data) {
  if (method === 'join') {
    if (peer.room || !/^[a-zA-Z0-9_-]{1,48}$/.test(data.room)) throw Error('Invalid room');
    peer.room = await getRoom(data.room);
    peer.roomId = data.room;
    peer.room.peers.add(peer);
    return { routerRtpCapabilities: peer.room.router.rtpCapabilities };
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
      const producer = await transport.produce({ kind: data.kind, rtpParameters: data.rtpParameters });
      peer.producers.set(producer.id, producer);
      broadcast(room, peer, 'producer', { producerId: producer.id });
      return { id: producer.id };
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
      consumer.on('producerclose', () => { peer.consumers.delete(consumer.id); emit(peer, 'consumerClosed', { id: consumer.id }); });
      return { id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
    }
    case 'resume': await owned(peer.consumers, data.id).resume(); return {};
    case 'pauseProducer': {
      const producer = owned(peer.producers, data.id);
      await (data.paused ? producer.pause() : producer.resume()); return {};
    }
    case 'chat': {
      if (typeof data.text !== 'string' || data.text.length > 1000) throw Error('Invalid message');
      broadcast(room, null, 'chat', { text: data.text, at: new Date().toISOString() }); return {};
    }
    case 'stats': {
      const transports = [];
      for (const t of peer.transports.values()) transports.push({ id: t.id, direction: t.appData.direction, reports: await t.getStats() });
      return { timestamp: new Date().toISOString(), nodeMemory: process.memoryUsage(), nodeCpu: process.cpuUsage(), worker: await worker.getResourceUsage(), peers: room.peers.size, transports };
    }
    default: throw Error('Unknown method');
  }
}
wss.on('connection', ws => {
  const peer = { ws, room: null, transports: new Map(), producers: new Map(), consumers: new Map() };
  let queue = Promise.resolve();
  ws.on('message', raw => {
    queue = queue.then(async () => {
      let request;
      try {
        request = JSON.parse(raw.toString());
        const result = await action(peer, request.method, request.data || {});
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request.id, result }));
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: request?.id, error: error.message }));
      }
    });
  });
  ws.on('close', () => {
    queue.finally(() => {
      for (const t of peer.transports.values()) t.close();
      const room = peer.room;
      if (room) {
        room.peers.delete(peer);
        if (!room.peers.size) { room.router.close(); rooms.delete(peer.roomId); }
      }
    });
  });
});
server.listen(port, host, () => console.log(`Streaming lab: http://${host}:${port}`));
function stop() { for (const client of wss.clients) client.terminate(); worker.close(); server.close(); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
