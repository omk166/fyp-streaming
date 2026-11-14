import { Device } from 'mediasoup-client';
import { setupRooms } from './rooms.js';
import { setupRecording } from './recording-controls.js';
let pipWin = null; // pop-out drawing window (Document Picture-in-Picture); see popOut()
// Look in the pop-out window too: the toolbar and screen tile move there while it is open.
const $ = id => document.getElementById(id) || pipWin?.document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = window.lab = { samples: [], events: [], consumers: new Map(), producers: [], joined: false, activeSpeaker: null, errors: [] };
let ws, device, send, recv, stream, timer, audioContext, animation;
let screenStream, screenProducer, screenAudioProducer, screenBusy = false, session = 0;
let pinned = null;
const tiles = new Map(), participants = new Map(), reactionTimers = new Set();
const reactionIcons = { 'thumbs-up': '\u{1F44D}', heart: '\u{2764}\u{FE0F}', laugh: '\u{1F602}' };
let serial = 0;
const pending = new Map(), seen = new Set();
const entryUrl = () => `/auth?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
let identity = null;
const roomControls = setupRooms({ $, identity: () => identity, joined: () => state.joined,
  onChange: value => { state.room = value; }, onError: fail });
const recordingControls = setupRecording({ $, state, rpc, tiles: () => [...tiles.values()],
  audioTracks: () => [
    ...(stream?.getAudioTracks() || []).map(track => ({ track, peerId: state.peerId })),
    ...(screenStream?.getAudioTracks() || []).map(track => ({ track, peerId: state.peerId })),
    ...[...state.consumers.values()].filter(c => c.kind === 'audio').map(c => ({ track: c.track, peerId: c.appData.peerId })),
  ], notice: message => { $('status').textContent = message; } });
Object.defineProperty(state, 'recorderRunning', { get: () => recordingControls.running });
async function loadIdentity() {
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    if (response.status === 401) { location.replace(entryUrl()); return; }
    if (!response.ok) throw Error('Could not check your session. Please refresh to try again.');
    identity = await response.json();
    $('username').value = identity.name;
    $('identity').textContent = `${identity.kind === 'guest' ? 'Guest' : 'Signed in'} · ${identity.name}`;
    $('logout').textContent = identity.kind === 'guest' ? 'Exit guest session' : 'Sign out';
    $('logout').disabled = false;
    await roomControls.init();
  } catch (error) { fail(error); }
}
$('logout').onclick = async () => {
  $('logout').disabled = true;
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw Error('Could not sign out. Please try again.');
    await leave(); location.assign(entryUrl());
  } catch (error) { fail(error); $('logout').disabled = false; }
};
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
function refreshParticipantUI() {
  for (const tile of tiles.values()) {
    const peer = participants.get(tile.dataset.peerId);
    const speaking = peer && peer.peerId === state.activeSpeaker;
    tile.classList.toggle('active-speaker', Boolean(speaking && tile.dataset.source === 'camera'));
    tile.querySelector('.participant-status').textContent = peer ? `${peer.micMuted ? '\u{1F507} Mic muted' : ''}${peer.handRaised ? ' \u{270B} Hand raised' : ''}${speaking ? ' · Speaking' : ''}` : '';
  }
  $('participants').replaceChildren();
  for (const peer of participants.values()) {
    const item = document.createElement('li'); item.dataset.peerId = peer.peerId;
    item.textContent = `${peer.username}${peer.kind === 'guest' ? ' (Guest)' : ''}${peer.role === 'owner' ? ' (Owner)' : ''}${peer.peerId === state.peerId ? ' (You)' : ''}${peer.micMuted ? ' \u{1F507} Mic muted' : ''}${peer.handRaised ? ' \u{270B} Hand raised' : ''}${peer.peerId === state.activeSpeaker ? ' · Speaking' : ''}`;
    $('participants').append(item);
  }
  const raised = participants.get(state.peerId)?.handRaised || false;
  $('hand').textContent = raised ? 'Lower hand' : 'Raise hand';
  $('hand').setAttribute('aria-pressed', String(raised));
}
function showReaction(data) {
  if (!reactionIcons[data.reaction]) return;
  const item = document.createElement('div'); item.className = 'reaction';
  item.textContent = `${reactionIcons[data.reaction]} ${data.username}`;
  // Bound the visible queue even when several people react at once.
  if ($('reactions').children.length >= 8) $('reactions').firstElementChild.remove();
  $('reactions').append(item);
  const timer = setTimeout(() => { item.remove(); reactionTimers.delete(timer); }, 4000);
  reactionTimers.add(timer);
}
function updatePin() {
  $('stage').hidden = !pinned;
  for (const [id, tile] of tiles) {
    if (pipWin && tile.ownerDocument === pipWin.document) continue; // popped out: stays in the floating window
    (id === pinned ? $('stage') : $('media')).append(tile);
    tile.querySelector('button').textContent = id === pinned ? 'Unpin' : 'Pin';
    tile.querySelector('button').setAttribute('aria-pressed', String(id === pinned));
  }
}
function setVideoPaused(id, paused) {
  const tile = tiles.get(id);
  if (tile) {
    tile.classList.toggle('camera-paused', paused);
    tile.dataset.paused = String(paused);
  }
}
function removeTrack(id) {
  const tile = tiles.get(id);
  tile?.remove(); tiles.delete(id); $(`track-${id}`)?.remove();
  for (const [target, o] of overlays) if (o.id === id) { overlays.delete(target); frozen.delete(target); }
  updateBar();
  if (pinned === id) pinned = null;
  updatePin();
}
function render(track, id, muted = false, info = {}) {
  const el = document.createElement(track.kind === 'video' ? 'video' : 'audio');
  el.id = `track-${id}`; el.autoplay = true; el.playsInline = true; el.muted = muted;
  el.srcObject = new MediaStream([track]);
  if (track.kind === 'video') {
    const tile = document.createElement('section'); tile.className = 'tile';
    tile.dataset.source = info.source || 'camera'; tile.dataset.peerId = info.peerId || state.peerId;
    const footer = document.createElement('footer'), label = document.createElement('span'), button = document.createElement('button');
    label.textContent = `${info.username || state.username}${muted ? ' (You)' : ''}${info.source === 'screen' ? ' - Screen' : ''}`;
    button.type = 'button'; button.onclick = () => { pinned = pinned === id ? null : id; updatePin(); };
    const badges = document.createElement('span'); badges.className = 'participant-status'; badges.setAttribute('aria-live', 'polite');
    label.append(badges);
    footer.append(label, button); tile.append(el, footer); tiles.set(id, tile); updatePin(); refreshParticipantUI();
    if (info.source === 'screen') attachOverlay(tile.dataset.peerId, tile, el, id);
  } else $('media').append(el);
  el.play().catch(error => event('playbackBlocked', { message: error.message }));
}
async function stopScreen() {
  const closing = [screenAudioProducer, screenProducer].filter(Boolean);
  screenProducer = null; screenAudioProducer = null;
  screenStream?.getTracks().forEach(t => t.stop()); screenStream = null;
  removeTrack('screen-local');
  for (const producer of closing) producer.close();
  state.producers = state.producers.filter(p => !closing.includes(p));
  $('screen').textContent = 'Share screen'; $('wbBar').hidden = true; setDrawing(false); pipWin?.close(); penStop();
  $('screenSound').disabled = false; $('screenAudioStatus').textContent = '';
  for (const producer of closing) if (state.joined) await rpc('closeProducer', { id: producer.id });
}
async function shareScreen() {
  if (screenBusy || !state.joined) return;
  screenBusy = true; $('screen').disabled = true;
  const currentSession = session;
  let captured;
  try {
    if (screenProducer) { await stopScreen(); return; }
    if (!navigator.mediaDevices.getDisplayMedia) throw Error('Screen sharing is unavailable in this browser');
    const soundRequested = $('screenSound').checked;
    captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: soundRequested });
    if (!state.joined || session !== currentSession) { captured.getTracks().forEach(t => t.stop()); return; }
    screenStream = captured;
    const track = captured.getVideoTracks()[0];
    const producer = await send.produce({ track, codec: device.rtpCapabilities.codecs.find(c => c.mimeType.toLowerCase() === ($('mode').value === 'vp9' ? 'video/vp9' : 'video/h264')), appData: { source: 'screen' } });
    if (!state.joined || session !== currentSession) { producer.close(); captured.getTracks().forEach(t => t.stop()); return; }
    screenProducer = producer; state.producers.push(producer);
    const sound = captured.getAudioTracks()[0];
    if (sound) {
      screenAudioProducer = await send.produce({ track: sound, appData: { source: 'screenAudio' } });
      if (!state.joined || session !== currentSession) { screenAudioProducer.close(); captured.getTracks().forEach(t => t.stop()); return; }
      state.producers.push(screenAudioProducer);
      sound.onended = async () => {
        const ended = screenAudioProducer; screenAudioProducer = null;
        if (!ended) return;
        ended.close(); state.producers = state.producers.filter(p => p !== ended);
        $('screenAudioStatus').textContent = 'Screen sound ended; video sharing continues.';
        if (state.joined) try { await rpc('closeProducer', { id: ended.id }); } catch (error) { fail(error); }
      };
    }
    $('screenSound').disabled = true;
    $('screenAudioStatus').textContent = sound ? 'Screen sound is shared. Microphone mute controls your microphone only.' : soundRequested ? 'Video only: no sound was provided by the browser. For tab audio, choose a tab and enable Share tab audio.' : 'Screen sound is off for this share.';
    track.onended = () => stopScreen().catch(fail);
    render(track, 'screen-local', true, { source: 'screen' });
    $('screen').textContent = 'Stop sharing'; $('wbBar').hidden = false;
    $('status').textContent = 'Sharing. Drawing tools are on the right; \u29C9 pops them out with a live preview so you can draw while on other pages or apps.';
    penStart();
    if (track.readyState === 'ended') await stopScreen();
  } catch (error) {
    captured?.getTracks().forEach(t => t.stop());
    if (screenProducer || screenAudioProducer) await stopScreen().catch(fail);
    if (error.name !== 'NotAllowedError' && state.joined) fail(error);
  } finally { screenBusy = false; $('screen').disabled = !state.joined; }
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
    render(consumer.track, consumer.id, false, info.appData);
    const { producerPaused } = await rpc('resume', { id: consumer.id });
    setVideoPaused(consumer.id, producerPaused); event('consumed', { kind: consumer.kind });
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
  if (!identity) return;
  if (!$('username').value.trim()) { $('username').focus(); $('status').textContent = 'Enter your name to join.'; return; }
  session++;
  $('join').disabled = true;
  const started = performance.now();
  let receivedRecording = null;
  try {
    state.metadata = { runId: params.get('run') || crypto.randomUUID(), mode: $('mode').value, synthetic: $('synthetic').checked, syntheticClock: $('synthetic').checked ? 'timer' : null, userAgent: navigator.userAgent, startedAt: new Date().toISOString(), origin: location.origin };
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    ws.onmessage = async ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const p = pending.get(message.id); pending.delete(message.id);
        if (p) message.error ? p.reject(Error(message.error)) : p.resolve(message.result);
      } else if (message.event === 'producer') consume(message.data.producerId);
      else if (message.event === 'consumerPaused') {
        setVideoPaused(message.data.id, message.data.paused);
      } else if (message.event === 'consumerClosed') {
        const c = state.consumers.get(message.data.id); c?.close(); state.consumers.delete(message.data.id); removeTrack(message.data.id);
      } else if (message.event === 'participant') {
        participants.set(message.data.peerId, message.data); refreshParticipantUI();
      } else if (message.event === 'participantLeft') {
        participants.delete(message.data.peerId); refreshParticipantUI();
      } else if (message.event === 'roomSettings') {
        roomControls.changed(message.data);
      } else if (message.event === 'activeSpeaker') {
        state.activeSpeaker = message.data.peerId; refreshParticipantUI();
      } else if (message.event === 'recordingState') {
        receivedRecording = message.data;
        recordingControls.update(message.data);
      } else if (message.event === 'roomEnded') {
        leave(); roomControls.changed(message.data); $('status').textContent = 'The owner ended this room.';
      } else if (message.event === 'wbSegment') {
        annotationRemote(message.data);
      } else if (message.event === 'wbFreeze') {
        setFrozen(message.data.target, message.data.frozen, message.data.image || null);
        $('status').textContent = `${message.data.username} ${message.data.frozen ? 'paused' : 'resumed'} the shared screen.`;
      } else if (message.event === 'wbRemove') {
        annotationRemove(message.data.target, message.data.key);
      } else if (message.event === 'wbClear') {
        annotationClear(message.data.target);
        if (!message.data.silent) $('status').textContent = `${message.data.username} cleared the screen annotations.`;
      } else if (message.event === 'reaction') {
        showReaction(message.data);
      } else if (message.event === 'chat') { $('chat').textContent += `${message.data.username || 'Guest'}: ${message.data.text}\n`; event('chat'); }
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(Error('Signaling connection failed')); });
    ws.onclose = async ({ code }) => {
      if (code === 1008) { await leave(); location.replace(entryUrl()); return; }
      if (code === 4000) { leave(); $('status').textContent = 'This room has ended.'; return; }
      if (state.joined) { fail(Error('Disconnected; rejoin required')); leave(); }
    };
    const info = await rpc('join', roomControls.credentials());
    state.peerId = info.peerId; state.username = info.username;
    state.activeSpeaker = info.activeSpeaker;
    for (const peer of info.participants) participants.set(peer.peerId, peer);
    annotationsLoad(info.board || []); frozen.clear(); for (const f of info.frozen || []) frozen.set(f.target, f.image || null);
    refreshParticipantUI();
    device = new Device(); await device.load(info);
    send = device.createSendTransport(await rpc('transport', { direction: 'send' })); bindTransport(send);
    recv = device.createRecvTransport(await rpc('transport', { direction: 'recv' })); bindTransport(recv);
    send.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => rpc('produce', { transportId: send.id, kind, rtpParameters, source: appData.source }).then(callback).catch(errback));
    stream = $('synthetic').checked ? await syntheticStream() : await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 640, height: 360, frameRate: 30 } });
    render(stream.getVideoTracks()[0], 'local', true);
    state.producers.push(await send.produce({ track: stream.getAudioTracks()[0], appData: { source: 'microphone' } }));
    const mode = $('mode').value;
    const codec = device.rtpCapabilities.codecs.find(c => c.mimeType.toLowerCase() === (mode === 'vp9' ? 'video/vp9' : 'video/h264'));
    if (!codec) throw Error('Requested codec unsupported; no silent fallback');
    const encodings = mode === 'simulcast' ? [{ scaleResolutionDownBy: 2, maxBitrate: 150000 }, { scaleResolutionDownBy: 1, maxBitrate: 550000 }] : mode === 'vp9' ? [{ scalabilityMode: 'L2T3', maxBitrate: 700000 }] : [{ maxBitrate: 700000 }];
    state.producers.push(await send.produce({ track: stream.getVideoTracks()[0], codec, encodings, appData: { source: 'camera' } }));
    state.metadata.negotiatedProducers = state.producers.map(p => ({ kind: p.kind, rtpParameters: p.rtpParameters }));
    for (const id of await rpc('list')) await consume(id);
    state.joined = true; state.joinMs = performance.now() - started;
    recordingControls.update(receivedRecording || info.recording);
    roomControls.refresh();
    event('joined', { joinMs: state.joinMs });
    for (const id of ['leave','mic','camera','send','screen','hand','react-like','react-heart','react-laugh','wbDraw','wbFreeze','wbPop','wbColor','wbSize','wbUndo','wbClear']) $(id).disabled = false;

    for (const id of ['room','mode','synthetic','username']) $(id).disabled = true;
    $('status').textContent = `Joined ${$('room').value}. ${state.metadata.synthetic ? 'Synthetic' : 'Camera/microphone'} media. Telemetry active.`;
    timer = setInterval(sample, 1000); await sample();
  } catch (error) { fail(error); leave(); }
}
function leave() {
  state.joined = false; session++;
  const recordingFinished = recordingControls.leave();
  state.activeSpeaker = null;
  for (const timer of reactionTimers) clearTimeout(timer); reactionTimers.clear();
  $('reactions').replaceChildren(); participants.clear(); refreshParticipantUI();
  screenProducer?.close(); screenProducer = null;
  screenAudioProducer?.close(); screenAudioProducer = null;
  screenStream?.getTracks().forEach(t => t.stop()); screenStream = null;
  $('screen').textContent = 'Share screen';
  $('screenSound').disabled = false; $('screenAudioStatus').textContent = '';
  clearInterval(timer); clearInterval(animation);
  for (const p of pending.values()) p.reject(Error('Left room')); pending.clear();
  send?.close(); recv?.close(); stream?.getTracks().forEach(t => t.stop());
  // Logout and session revocation can both tear down the same call.
  const closingAudio = audioContext; audioContext = null;
  if (closingAudio && closingAudio.state !== 'closed') closingAudio.close().catch(() => {});
  ws?.close();
  state.consumers.clear(); state.producers = []; seen.clear(); $('media').replaceChildren(); $('stage').replaceChildren(); tiles.clear(); pinned = null; updatePin();
  for (const id of ['leave','mic','camera','send','screen','hand','react-like','react-heart','react-laugh','wbDraw','wbFreeze','wbPop','wbColor','wbSize','wbUndo','wbClear']) $(id).disabled = true;
  $('wbBar').hidden = true; pipWin?.close(); penStop(); clearTimeout(wbTimer); setDrawing(false); overlays.clear(); annotations.clear(); frozen.clear();
  for (const id of ['join','room','mode','synthetic','username']) $(id).disabled = false;
  roomControls.refresh();
  $('mic').textContent = 'Mute microphone'; $('camera').textContent = 'Pause camera';
  event('left');
  return recordingFinished;
}
async function toggle(kind, id) {
  const producer = state.producers.find(p => p.appData.source === (kind === 'audio' ? 'microphone' : 'camera'));
  if (!producer) return;
  const paused = !producer.paused;
  await rpc('pauseProducer', { id: producer.id, paused });
  paused ? producer.pause() : producer.resume();
  if (kind === 'video') setVideoPaused('local', paused);
  event('toggle', { kind, paused });
  $(id).textContent = kind === 'audio' ? (paused ? 'Unmute microphone' : 'Mute microphone') : (paused ? 'Resume camera' : 'Pause camera');
}
state.export = () => ({ metadata: state.metadata, joinMs: state.joinMs, events: state.events, samples: state.samples, errors: state.errors });
$('screen').onclick = shareScreen;
$('hand').onclick = async () => {
  $('hand').disabled = true;
  try { await rpc('hand', { raised: !participants.get(state.peerId)?.handRaised }); }
  catch (error) { fail(error); }
  finally { $('hand').disabled = !state.joined; }
};
for (const [id, reaction] of [['react-like','thumbs-up'], ['react-heart','heart'], ['react-laugh','laugh']]) {
  $(id).onclick = async () => {
    const currentSession = session;
    for (const button of document.querySelectorAll('[data-reaction]')) button.disabled = true;
    try { await rpc('reaction', { reaction }); } catch (error) { fail(error); }
    setTimeout(() => {
      if (session === currentSession) for (const button of document.querySelectorAll('[data-reaction]')) button.disabled = !state.joined;
    }, 900);
  };
}

// ---- Screen whiteboard: strokes are drawn over the VIDEO of a shared screen, never onto the screen itself.
// Coordinates are 0..1 of the shared picture, so every viewer sees the same marks whatever their window size.
// `target` = the sharer's peerId. Because the ink is a separate layer, pausing only freezes the picture under it:
// drawings keep arriving live on top of the paused frame.
const annotations = new Map(), overlays = new Map();
let drawing = null, wbTimer = null, wbBuffer = [], drawOn = false, pauseBusy = false;
const frozen = new Map(); // target -> still image (data URL) or null when only the live video can be snapshotted
function paintStroke(canvas, stroke, from) {
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = ctx.fillStyle = stroke.color; ctx.lineWidth = stroke.size; ctx.lineCap = ctx.lineJoin = 'round';
  const px = ([x, y]) => [x * canvas.width, y * canvas.height];
  if (stroke.pts.length === 1) { const [x, y] = px(stroke.pts[0]); ctx.beginPath(); ctx.arc(x, y, stroke.size / 2, 0, 7); ctx.fill(); return; }
  ctx.beginPath(); ctx.moveTo(...px(stroke.pts[Math.max(0, from - 1)]));
  for (let i = Math.max(1, from); i < stroke.pts.length; i++) ctx.lineTo(...px(stroke.pts[i]));
  ctx.stroke();
}
function repaint(target) {
  const o = overlays.get(target); if (!o) return;
  o.canvas.getContext('2d').clearRect(0, 0, o.canvas.width, o.canvas.height);
  for (const stroke of annotations.get(target)?.values() || []) if (stroke.pts.length) paintStroke(o.canvas, stroke, 0);
}
function layoutOverlay(target) {
  const o = overlays.get(target); if (!o) return;
  const { canvas, video } = o, vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  // Match the picture inside the video box (object-fit: contain leaves letterbox bars).
  const bw = video.clientWidth, bh = video.clientHeight, scale = Math.min(bw / vw, bh / vh), w = vw * scale, h = vh * scale;
  const box = { left: `${video.offsetLeft + (bw - w) / 2}px`, top: `${video.offsetTop + (bh - h) / 2}px`, width: `${w}px`, height: `${h}px` };
  Object.assign(canvas.style, box); if (o.freeze) Object.assign(o.freeze.style, box);
  applyFreeze(target);
  const ih = Math.round(1280 * vh / vw);
  if (canvas.width !== 1280 || canvas.height !== ih) { canvas.width = 1280; canvas.height = ih; repaint(target); }
}
// Pause = show a still picture under the drawing layer. The sharer sends the exact frame they paused on, so
// everyone (including people who join later) sees the same image; their own real screen stays live.
function applyFreeze(target) {
  const o = overlays.get(target); if (!o) return;
  const want = frozen.has(target), { video, canvas } = o;
  if (want && !o.freeze) {
    const image = frozen.get(target);
    let still;
    if (image) { still = canvas.ownerDocument.createElement('img'); still.src = image; still.alt = ''; }
    else if (video.videoWidth) { // Fallback: snapshot the frame this viewer is currently showing.
      still = canvas.ownerDocument.createElement('canvas');
      still.width = Math.min(1280, video.videoWidth); still.height = Math.round(still.width * video.videoHeight / video.videoWidth);
      still.getContext('2d').drawImage(video, 0, 0, still.width, still.height);
    } else return;
    still.className = 'freeze';
    Object.assign(still.style, { left: canvas.style.left, top: canvas.style.top, width: canvas.style.width, height: canvas.style.height });
    canvas.before(still); o.freeze = still;
  } else if (!want && o.freeze) { o.freeze.remove(); o.freeze = null; }
}
function setFrozen(target, on, image = null) {
  const o = overlays.get(target);
  if (o?.freeze) { o.freeze.remove(); o.freeze = null; } // a new pause always gets its new picture
  on ? frozen.set(target, image) : frozen.delete(target); applyFreeze(target); updateBar();
}
function setDrawing(on) {
  drawOn = on && state.joined && Boolean(screenProducer);
  document.body.classList.toggle('drawing', drawOn); pipWin?.document.body.classList.toggle('drawing', drawOn);
  $('wbDraw').setAttribute('aria-pressed', String(drawOn));
  if (!drawOn && drawing) { annotateFlush(); drawing = null; }
}
function updateBar() {
  const paused = frozen.has(state.peerId);
  $('wbFreeze').setAttribute('aria-pressed', String(paused));
  $('wbFreeze').textContent = paused ? '▶' : '⏸';
  $('wbFreeze').title = paused ? 'Resume: viewers see your live screen again' : 'Pause: viewers see a still of your screen; drawings stay live';
  $('wbPop').setAttribute('aria-pressed', String(Boolean(pipWin)));
  $('wbDraw').setAttribute('aria-pressed', String(penWs ? penOn : drawOn));
  penSend({ cmd: 'paused', on: paused });
}
function annotatePoint(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}
function annotateFlush() {
  clearTimeout(wbTimer); wbTimer = null;
  if (!drawing || !wbBuffer.length || !state.joined) { wbBuffer = []; return; }
  // Fire-and-forget: no id, so the server sends no reply.
  ws.send(JSON.stringify({ method: 'wbSegment', data: { id: drawing.id, target: drawing.target, color: drawing.color, size: drawing.size, pts: wbBuffer.splice(0, 200) } }));
  if (wbBuffer.length) annotateFlush();
}
function annotateAdd(p) {
  const from = drawing.pts.length; drawing.pts.push(p); wbBuffer.push(p); paintStroke(overlays.get(drawing.target).canvas, drawing, from);
  if (!wbTimer) wbTimer = setTimeout(annotateFlush, 50);
}
function attachOverlay(target, tile, video, id) {
  const canvas = document.createElement('canvas'); canvas.className = 'annot'; canvas.setAttribute('aria-label', 'Screen annotations');
  tile.append(canvas); overlays.set(target, { canvas, video, id });
  canvas.classList.toggle('mine', target === state.peerId);
  const relayout = () => layoutOverlay(target);
  video.addEventListener('loadedmetadata', relayout); video.addEventListener('resize', relayout);
  new ResizeObserver(relayout).observe(video); relayout(); updateBar();
  canvas.onpointerdown = e => {
    if (!state.joined || e.button > 0 || !drawOn || target !== state.peerId) return;
    canvas.setPointerCapture(e.pointerId);
    const sid = crypto.randomUUID().slice(0, 12);
    drawing = { id: sid, key: `${state.peerId}:${sid}`, target, color: $('wbColor').value, size: Number($('wbSize').value), pts: [] };
    if (!annotations.has(target)) annotations.set(target, new Map());
    annotations.get(target).set(drawing.key, drawing); annotateAdd(annotatePoint(e, canvas));
  };
  canvas.onpointermove = e => { if (drawing?.target === target) annotateAdd(annotatePoint(e, canvas)); };
  canvas.onpointerup = canvas.onpointercancel = () => { if (drawing) { annotateFlush(); drawing = null; } };
}
function annotationsLoad(list) {
  annotations.clear();
  for (const s of list) { if (!annotations.has(s.target)) annotations.set(s.target, new Map()); annotations.get(s.target).set(s.key, s); }
  for (const target of overlays.keys()) repaint(target);
}
function annotationRemote(seg) {
  if (!annotations.has(seg.target)) annotations.set(seg.target, new Map());
  const strokes = annotations.get(seg.target); let stroke = strokes.get(seg.key);
  const from = stroke ? stroke.pts.length : 0;
  if (!stroke) { stroke = { key: seg.key, target: seg.target, color: seg.color, size: seg.size, pts: [] }; strokes.set(seg.key, stroke); }
  stroke.pts.push(...seg.pts);
  const o = overlays.get(seg.target); if (o) paintStroke(o.canvas, stroke, from);
}
function annotationRemove(target, key) { annotations.get(target)?.delete(key); repaint(target); }
function annotationClear(target) { annotations.delete(target); repaint(target); }

// The frame being shared right now, as a JPEG small enough for one signaling message.
async function grabStill() {
  const track = screenStream?.getVideoTracks()[0]; if (!track) return null;
  let source = null;
  // grabFrame works even while this tab is in the background (you are presenting another page).
  try { source = await new ImageCapture(track).grabFrame(); } catch { source = tiles.get('screen-local')?.querySelector('video'); }
  const isVideo = source instanceof HTMLVideoElement, w0 = isVideo ? source.videoWidth : source?.width, h0 = isVideo ? source.videoHeight : source?.height;
  if (!w0 || !h0) return null;
  for (const width of [1280, 960, 640]) {
    const c = document.createElement('canvas'); c.width = Math.min(width, w0); c.height = Math.round(c.width * h0 / w0);
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    for (const quality of [0.75, 0.55]) { const url = c.toDataURL('image/jpeg', quality); if (url.length <= 880000) { source.close?.(); return url; } }
  }
  source.close?.(); return null;
}
async function togglePause() {
  const target = state.peerId; if (!screenProducer || !overlays.has(target) || pauseBusy) return;
  pauseBusy = true;
  try {
    if (frozen.has(target)) { setFrozen(target, false); await rpc('wbFreeze', { target, frozen: false }); return; }
    const image = await grabStill();
    setFrozen(target, true, image); await rpc('wbFreeze', { target, frozen: true, image });
    event('wbPause', { stillBytes: image?.length || 0 });
  } catch (error) { fail(error); } finally { pauseBusy = false; }
}

// Pop-out: an always-on-top Picture-in-Picture window with a live preview of your shared screen and the toolbar.
// It floats over any page or app, so you can switch away from this tab and still draw on what everyone sees.
const PIP_CSS = `body.pip-body{margin:0;padding:0;display:flex;height:100vh;overflow:hidden;background:#101827}
body.pip-body .tile{flex:1;min-width:0;border-radius:0;display:flex;flex-direction:column}
body.pip-body .tile video{flex:1;min-height:0;height:auto;aspect-ratio:auto;border-radius:0}
body.pip-body .tile footer{display:none}
body.pip-body #wbBar{overflow-y:auto;padding:6px}`;
async function popOut() {
  if (pipWin) { pipWin.close(); return; }
  if (!window.documentPictureInPicture) { $('status').textContent = 'Pop-out needs Chrome or Edge 116+. You can still draw on your screen tile in this page.'; return; }
  const tile = tiles.get('screen-local'); if (!tile) return;
  const video = tile.querySelector('video'), bar = $('wbBar'), relayout = () => layoutOverlay(state.peerId);
  try {
    const win = pipWin = await documentPictureInPicture.requestWindow({ width: 760, height: 460 });
    for (const style of document.querySelectorAll('style')) win.document.head.append(style.cloneNode(true));
    const extra = win.document.createElement('style'); extra.textContent = PIP_CSS; win.document.head.append(extra);
    win.document.title = 'Draw on your shared screen';
    win.document.body.className = 'pip-body'; win.document.body.classList.toggle('drawing', drawOn);
    bar.classList.add('pip'); win.document.body.append(tile, bar);
    video.play().catch(() => {});
    win.addEventListener('resize', relayout); setTimeout(relayout, 50);
    win.addEventListener('keydown', e => { if (e.key === 'Escape' && drawOn) setDrawing(false); });
    win.addEventListener('pagehide', () => {
      pipWin = null; bar.classList.remove('pip'); document.body.append(bar);
      updatePin(); video.play().catch(() => {}); setTimeout(relayout, 50); updateBar();
    });
    updateBar();
  } catch (error) { pipWin = null; fail(error); }
}
$('wbPop').onclick = popOut;
$('wbDraw').onclick = () => {
  if (!screenProducer) return;
  if (penWs?.readyState === WebSocket.OPEN) penSend({ cmd: 'pen', on: !penOn }); // draw over the whole screen
  else setDrawing(!drawOn);
};
$('wbFreeze').onclick = togglePause;
addEventListener('keydown', e => { if (e.key === 'Escape' && drawOn) setDrawing(false); });
$('wbUndo').onclick = async () => {
  const target = state.peerId; if (!screenProducer || !overlays.has(target)) return;
  try { const { key } = await rpc('wbUndo', { target }); if (key) { annotationRemove(target, key); penSend({ cmd: 'remove', id: key.slice(target.length + 1) }); } } catch (error) { fail(error); }
};
$('wbClear').onclick = () => {
  const target = state.peerId; if (!screenProducer || !overlays.has(target)) return;
  annotationClear(target); rpc('wbClear', { target }).catch(fail); penSend({ cmd: 'clear' });
};

// ---- Screen pen (optional helper, `npm run overlay`): draws over your whole screen and any app.
// It only works with an "Entire screen" share, because its marks are positioned on the whole display.
// Its strokes come here and go out as ordinary whiteboard strokes, so pause/undo/clear/late joiners all work the same.
let penWs = null, penOn = false;
function penSend(message) { if (penWs?.readyState === WebSocket.OPEN) penWs.send(JSON.stringify(message)); }
function penStop() {
  const socket = penWs; penWs = null; penOn = false;
  try { socket?.close(); } catch { /* already closed */ } // closing hides the screen pen
}
function penStart() {
  penStop();
  if (screenStream?.getVideoTracks()[0]?.getSettings().displaySurface !== 'monitor') {
    $('status').textContent = 'You shared a window or tab, so \u270F\uFE0F draws on your screen tile here only. To draw over your whole screen and other apps, stop and share your Entire screen.';
    return;
  }
  const noPen = 'Screen pen is not running, so \u270F\uFE0F draws on your screen tile here only. To draw over your whole screen and other apps, start the server with "npm start" on this computer (or run "npm run overlay"), then share again.';
  let socket; try { socket = new WebSocket('ws://127.0.0.1:47321'); } catch { $('status').textContent = noPen; return; }
  penWs = socket; let opened = false;
  socket.onopen = () => {
    opened = true; penSend({ cmd: 'show' }); penSend({ cmd: 'paused', on: frozen.has(state.peerId) });
    $('status').textContent = 'Screen pen on: \u270F\uFE0F draws over your whole screen and any app (Cmd/Ctrl+Shift+D toggles it, Esc stops).';
    event('screenPen', { state: 'connected' });
  };
  socket.onmessage = ({ data }) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.event === 'seg') penSegment(m);
    else if (m.event === 'pen') { penOn = Boolean(m.on); updateBar(); }
    else if (m.event === 'pause') togglePause();
    else if (m.event === 'undo') $('wbUndo').onclick();
    else if (m.event === 'clear') $('wbClear').onclick();
  };
  socket.onclose = () => {
    if (penWs !== socket) return;
    penWs = null; penOn = false; updateBar();
    if (!opened && screenProducer) $('status').textContent = noPen;
    else if (opened && screenProducer) $('status').textContent = 'Screen pen closed; \u270F\uFE0F now draws on your screen tile here only.';
  };
}
function penSegment(m) {
  if (!screenProducer || typeof m.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(m.id) || !/^#[0-9a-f]{6}$/i.test(m.color) || !Array.isArray(m.pts)) return;
  const clamp = n => Math.min(1, Math.max(0, Number(n) || 0));
  const data = { id: m.id, target: state.peerId, color: m.color, size: Math.min(40, Math.max(1, Math.round(Number(m.size) * 1280) || 6)),
    pts: m.pts.slice(0, 200).filter(p => Array.isArray(p) && p.length === 2).map(p => [clamp(p[0]), clamp(p[1])]) };
  if (!data.pts.length) return;
  annotationRemote({ key: `${state.peerId}:${data.id}`, ...data });
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'wbSegment', data }));
}
$('username').value = params.get('username') || '';
$('join').onclick = join; $('leave').onclick = leave;
$('mic').onclick = () => toggle('audio', 'mic').catch(fail); $('camera').onclick = () => toggle('video', 'camera').catch(fail);
$('chatForm').onsubmit = e => { e.preventDefault(); rpc('chat', { text: $('message').value }).catch(fail); $('message').value = ''; };
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.export(), null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${state.metadata?.runId || 'telemetry'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
if (params.has('synthetic')) $('synthetic').checked = true;
if (params.has('mode')) $('mode').value = params.get('mode');
loadIdentity();
