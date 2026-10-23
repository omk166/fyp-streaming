import { Device } from 'mediasoup-client';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = window.lab = { samples: [], events: [], consumers: new Map(), producers: [], joined: false, errors: [] };
let ws, device, send, recv, stream, timer, audioContext, animation;
let serial = 0;
const pending = new Map(), seen = new Set();
function event(type, data = {}) { state.events.push({ timestamp: new Date().toISOString(), type, ...data }); }
function fail(error) { state.errors.push(String(error)); $('status').textContent = String(error); event('error', { message: String(error) }); }
function rpc(method, data = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    ws.send(JSON.stringify({ id, method, data }));
  });
}
function render(track, id, muted = false) {
  const el = document.createElement(track.kind === 'video' ? 'video' : 'audio');
  el.id = `track-${id}`; el.autoplay = true; el.playsInline = true; el.muted = muted;
  el.srcObject = new MediaStream([track]); $('media').append(el);
  el.play().catch(error => event('playbackBlocked', { message: error.message }));
}
async function syntheticStream() {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const context = canvas.getContext('2d');
  const generated = typeof MediaStreamTrackGenerator === 'function' && typeof VideoFrame === 'function';
  const track = generated ? new MediaStreamTrackGenerator({ kind: 'video' }) : canvas.captureStream(0).getVideoTracks()[0];
  const writer = generated ? track.writable.getWriter() : null;
  state.metadata.syntheticClock = generated ? 'video-frame-timer' : 'manual-canvas-timer';
  state.sourceFrames = 0;
  let writing = false;
  async function draw() {
    if (writing || track.readyState === 'ended') return;
    writing = true;
    const t = performance.now() / 1000;
    context.fillStyle = '#173450'; context.fillRect(0, 0, 640, 360);
    context.fillStyle = '#9ae8cf'; context.fillRect((t * 100) % 580, 150, 60, 60);
    context.font = '30px monospace'; context.fillText(`SYNTHETIC ${t.toFixed(2)}`, 20, 70);
    try {
      if (writer) {
        const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1000000) });
        try { await writer.write(frame); } finally { frame.close(); }
      } else track.requestFrame();
      state.sourceFrames++;
    } catch (error) { if (state.joined) fail(error); }
    finally { writing = false; }
  }
  draw(); animation = setInterval(draw, 1000 / 30);
  audioContext = new AudioContext(); await audioContext.resume();
  const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();
  oscillator.frequency.value = 440; gain.gain.value = 0.03;
  oscillator.connect(gain).connect(destination); oscillator.start();
  return new MediaStream([track, ...destination.stream.getAudioTracks()]);
}
async function consume(producerId) {
  if (!recv || seen.has(producerId)) return;
  seen.add(producerId);
  try {
    const info = await rpc('consume', { producerId, transportId: recv.id, rtpCapabilities: device.rtpCapabilities });
    const consumer = await recv.consume(info); state.consumers.set(consumer.id, consumer);
    render(consumer.track, consumer.id); await rpc('resume', { id: consumer.id }); event('consumed', { kind: consumer.kind });
  } catch (error) { seen.delete(producerId); fail(error); }
}
function bindTransport(transport) {
  transport.on('connect', ({ dtlsParameters }, callback, errback) => rpc('connect', { id: transport.id, dtlsParameters }).then(callback).catch(errback));
  transport.on('connectionstatechange', connectionState => event('transport', { direction: transport.direction, connectionState }));
}
async function sample() {
  if (state.sampling) return;
  state.sampling = true;
  try {
    const reports = [];
    for (const transport of [send, recv]) {
      if (!transport || transport.closed) continue;
      const stats = await transport.getStats();
      reports.push({ direction: transport.direction, reports: [...stats.values()] });
    }
    const server = await rpc('stats');
    const item = { timestamp: new Date().toISOString(), monotonicMs: performance.now(), sourceFrames: state.sourceFrames, reports, server };
    state.samples.push(item);
    const rtp = reports.flatMap(t => t.reports).filter(r => ['inbound-rtp','outbound-rtp'].includes(r.type));
    $('metrics').textContent = JSON.stringify({ samples: state.samples.length, peers: server.peers, streams: rtp.map(r => ({ type: r.type, kind: r.kind, bytes: r.bytesReceived ?? r.bytesSent, packetsLost: r.packetsLost, jitter: r.jitter, framesPerSecond: r.framesPerSecond, frameWidth: r.frameWidth, frameHeight: r.frameHeight })) }, null, 2);
  } catch (error) { if (state.joined) fail(error); }
  finally { state.sampling = false; }
}
async function join() {
  $('join').disabled = true;
  const started = performance.now();
  try {
    state.metadata = { runId: params.get('run') || crypto.randomUUID(), mode: $('mode').value, synthetic: $('synthetic').checked, syntheticClock: $('synthetic').checked ? 'timer' : null, userAgent: navigator.userAgent, startedAt: new Date().toISOString(), origin: location.origin };
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    ws.onmessage = async ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const p = pending.get(message.id); pending.delete(message.id);
        if (p) message.error ? p.reject(Error(message.error)) : p.resolve(message.result);
      } else if (message.event === 'producer') consume(message.data.producerId);
      else if (message.event === 'consumerClosed') {
        const c = state.consumers.get(message.data.id); c?.close(); state.consumers.delete(message.data.id); $(`track-${message.data.id}`)?.remove();
      } else if (message.event === 'chat') { $('chat').textContent += `${message.data.at}: ${message.data.text}\n`; event('chat'); }
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(Error('Signaling connection failed')); });
    ws.onclose = () => { if (state.joined) { fail(Error('Disconnected; rejoin required')); leave(); } };
    const info = await rpc('join', { room: $('room').value });
    device = new Device(); await device.load(info);
    send = device.createSendTransport(await rpc('transport', { direction: 'send' })); bindTransport(send);
    recv = device.createRecvTransport(await rpc('transport', { direction: 'recv' })); bindTransport(recv);
    send.on('produce', ({ kind, rtpParameters }, callback, errback) => rpc('produce', { transportId: send.id, kind, rtpParameters }).then(callback).catch(errback));
    stream = $('synthetic').checked ? await syntheticStream() : await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 640, height: 360, frameRate: 30 } });
    render(stream.getVideoTracks()[0], 'local', true);
    state.producers.push(await send.produce({ track: stream.getAudioTracks()[0] }));
    const mode = $('mode').value;
    const codec = device.rtpCapabilities.codecs.find(c => c.mimeType.toLowerCase() === (mode === 'vp9' ? 'video/vp9' : 'video/h264'));
    if (!codec) throw Error('Requested codec unsupported; no silent fallback');
    const encodings = mode === 'simulcast' ? [{ scaleResolutionDownBy: 2, maxBitrate: 150000 }, { scaleResolutionDownBy: 1, maxBitrate: 550000 }] : mode === 'vp9' ? [{ scalabilityMode: 'L2T3', maxBitrate: 700000 }] : [{ maxBitrate: 700000 }];
    state.producers.push(await send.produce({ track: stream.getVideoTracks()[0], codec, encodings }));
    state.metadata.negotiatedProducers = state.producers.map(p => ({ kind: p.kind, rtpParameters: p.rtpParameters }));
    for (const id of await rpc('list')) await consume(id);
    state.joined = true; state.joinMs = performance.now() - started;
    event('joined', { joinMs: state.joinMs });
    for (const id of ['leave','mic','camera','send']) $(id).disabled = false;
    for (const id of ['room','mode','synthetic']) $(id).disabled = true;
    $('status').textContent = `Joined ${$('room').value}. ${state.metadata.synthetic ? 'Synthetic' : 'Camera/microphone'} media. Telemetry active.`;
    timer = setInterval(sample, 1000); await sample();
  } catch (error) { fail(error); leave(); }
}
function leave() {
  state.joined = false; clearInterval(timer); clearInterval(animation);
  for (const p of pending.values()) p.reject(Error('Left room')); pending.clear();
  send?.close(); recv?.close(); stream?.getTracks().forEach(t => t.stop()); audioContext?.close(); ws?.close();
  state.consumers.clear(); state.producers = []; seen.clear(); $('media').replaceChildren();
  for (const id of ['leave','mic','camera','send']) $(id).disabled = true;
  for (const id of ['join','room','mode','synthetic']) $(id).disabled = false;
  $('mic').textContent = 'Mute microphone'; $('camera').textContent = 'Pause camera';
  event('left');
}
async function toggle(kind, id) {
  const producer = state.producers.find(p => p.kind === kind);
  if (!producer) return;
  const paused = !producer.paused;
  await rpc('pauseProducer', { id: producer.id, paused });
  paused ? producer.pause() : producer.resume(); event('toggle', { kind, paused });
  $(id).textContent = kind === 'audio' ? (paused ? 'Unmute microphone' : 'Mute microphone') : (paused ? 'Resume camera' : 'Pause camera');
}
state.export = () => ({ metadata: state.metadata, joinMs: state.joinMs, events: state.events, samples: state.samples, errors: state.errors });
$('join').onclick = join; $('leave').onclick = leave;
$('mic').onclick = () => toggle('audio', 'mic').catch(fail); $('camera').onclick = () => toggle('video', 'camera').catch(fail);
$('chatForm').onsubmit = e => { e.preventDefault(); rpc('chat', { text: $('message').value }).catch(fail); $('message').value = ''; };
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.export(), null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${state.metadata?.runId || 'telemetry'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
if (params.has('synthetic')) $('synthetic').checked = true;
if (params.has('mode')) $('mode').value = params.get('mode');
if (params.has('room')) $('room').value = params.get('room');
