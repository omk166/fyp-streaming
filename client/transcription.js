import { createLocalSpeech, speechProblem } from './local-speech.js';

export function timestamp(ms, srt = false) {
  const n = Math.max(0, Math.floor(ms));
  return `${String(Math.floor(n / 3600000)).padStart(2, '0')}:${String(Math.floor(n / 60000) % 60).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')}${srt ? ',' + String(n % 1000).padStart(3, '0') : ''}`;
}
export function exportTranscript(segments, format) {
  return [...segments].sort((a, b) => a.start - b.start).map((s, i) => format === 'srt'
    ? `${i + 1}\n${timestamp(s.start, true)} --> ${timestamp(s.end, true)}\n${s.username}: ${s.text}\n`
    : `[${timestamp(s.start)}] ${s.username}: ${s.text}`).join('\n');
}

// Speech waiting for this computer's recognizer: 48 segments is up to about six minutes of continuous speech.
const MAX_QUEUE = 48;

// Live transcription. The microphone is cut into speech segments in an AudioWorklet, recognized by the speech
// service on this computer, and only the text goes to the meeting server, which shares it with the room.
export function setupTranscription({ $, state, rpc, microphone, notice, createSpeech = createLocalSpeech }) {
  let current = { phase: 'idle' }, segments = new Map(), ctx, source, capture, silent, generation = 0, starting = false, captureTrack = null;
  let speech = null, health = { status: 'unknown' }, healthTimer = null, queue = [], working = null, idleWaiters = [];
  const render = () => {
    const active = current.phase === 'recording', pending = current.phase === 'consent', finishing = current.phase === 'finishing', owner = state.room?.role === 'owner';
    $('transcriptionStatus').textContent = finishing ? 'Finishing: each computer is transcribing its remaining speech…' : active ? 'Transcription active' : pending ? 'Waiting for everyone to agree…' : 'Transcription stopped';
    $('transcriptionService').textContent = health.status === 'ready' ? `Speech recognized on this computer: ${health.model} (${health.device}).${health.languageHints === false ? ' This model detects the language itself, so the language choice does not change it.' : ''}`
      : health.status === 'unknown' || !speech ? 'Speech is recognized on each participant’s own computer.' : speechProblem(health, speech.url, location.origin);
    $('transcriptionConsentNote').textContent = health.status === 'unknown' || health.status === 'ready' || !speech ? '' : speechProblem(health, speech.url, location.origin);
    $('transcriptionStart').hidden = !owner || active || pending || finishing;
    $('transcriptionStart').disabled = !state.joined || !globalThis.AudioWorkletNode;
    $('transcriptionStop').hidden = !owner || (!active && !pending && !finishing);
    $('transcriptionStop').disabled = finishing;
    $('transcriptionConsent').hidden = !state.joined || !pending || current.approvedPeerIds?.includes(state.peerId);
    $('transcriptionWithdraw').hidden = !state.joined || (!active && !finishing);
    for (const format of ['txt', 'srt']) $(`transcript-${format}`).disabled = !segments.size;
  };
  // Only checked when transcription is about to involve this person: on a deployed site the browser may ask
  // for permission to reach this computer, which should not happen to people who never use transcription.
  async function checkService() {
    clearTimeout(healthTimer);
    if (!speech) return 'Join the meeting first.';
    health = await speech.status(); render();
    if (health.status === 'loading' && state.joined) healthTimer = setTimeout(checkService, 5000);
    return speechProblem(health, speech.url, location.origin);
  }
  const progress = () => {
    const jobs = [...queue, ...(working ? [working.job] : [])], seconds = Math.round(jobs.reduce((sum, job) => sum + job.duration, 0) / 1000);
    $('transcriptionQueue').textContent = jobs.length ? `This computer is transcribing ${jobs.length} speech segment(s), about ${seconds} s of audio. Captions may be delayed.` : '';
  };
  function enqueue(job) {
    if (queue.length >= MAX_QUEUE) { warning('This computer cannot keep up with live transcription, so some speech was skipped.'); return; }
    queue.push(job); progress();
    if (!working) pump();
  }
  // One segment at a time, in order, so a slow computer delays captions but does not reorder or drop them.
  async function pump() {
    while (queue.length) {
      const job = queue.shift(), controller = new AbortController();
      working = { job, controller }; progress();
      try {
        const text = await speech.transcribe(job.samples, job.language, controller.signal);
        if (text && !controller.signal.aborted && job.id === current.id) await rpc('transcriptionText', { id: job.id, seq: job.seq, offset: job.offset, duration: job.duration, text });
      } catch (error) {
        if (!controller.signal.aborted && job.id === current.id && current.phase !== 'idle') warning(`Some speech could not be transcribed: ${error.message}.`);
      }
    }
    working = null; progress();
    for (const resolve of idleWaiters.splice(0)) resolve();
  }
  const whenIdle = () => (working || queue.length ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve());
  function cancelQueue() { queue = []; working?.controller.abort(); progress(); }
  // Tell the server once every segment captured before Stop has been transcribed and sent.
  function finish(id) {
    whenIdle().then(() => { if (current.id === id && current.phase === 'finishing') return rpc('transcriptionFlushed', { id }); })
      .catch(error => notice(error.message));
  }
  function stopCapture() {
    generation++; starting = false;
    if (capture) { capture.port.onmessage = null; capture.disconnect(); }
    source?.disconnect(); silent?.disconnect(); capture = source = silent = null;
    const old = ctx; ctx = null; old?.close().catch(() => {});
  }
  async function prepare() {
    if (!ctx) ctx = new AudioContext();
    await ctx.resume();
  }
  async function startCapture() {
    if (capture || starting || !state.joined) return;
    starting = true; const token = generation, id = current.id;
    try {
      await prepare(); const context = ctx;
      await context.audioWorklet.addModule('/transcription-worklet.js');
      if (token !== generation || current.id !== id || !state.joined) return;
      captureTrack = microphone(); if (!captureTrack) throw Error('Microphone unavailable');
      source = context.createMediaStreamSource(new MediaStream([captureTrack]));
      capture = new AudioWorkletNode(context, 'speech-capture');
      silent = context.createGain(); silent.gain.value = 0;
      source.connect(capture); capture.connect(silent); silent.connect(context.destination);
      let seq = 0;
      const captureOffset = Math.max(0, Date.now() - current.startedAt);
      capture.port.onmessage = ({ data }) => {
        if (data.flushed) { stopCapture(); finish(id); return; }
        const { samples, startSample } = data;
        const offset = captureOffset + startSample / 16, sequence = seq++;
        const muted = state.producers.find(p => p.appData.source === 'microphone')?.paused;
        if (muted || captureTrack?.readyState !== 'live' || token !== generation) return;
        enqueue({ id, seq: sequence, offset, duration: samples.length / 16, samples, language: $('transcriptionLanguage').value });
      };
    } catch (error) {
      stopCapture(); notice(`Transcription capture failed: ${error.message}`);
      if (current.id === id && state.joined) rpc('transcriptionFailed', { id }).catch(() => {});
    } finally { if (token === generation) starting = false; }
  }
  function segment(entry) {
    if (segments.has(entry.id)) return;
    segments.set(entry.id, entry);
    if (segments.size > 2000) segments.delete(segments.keys().next().value);
    const list = $('transcript'); list.replaceChildren();
    for (const s of [...segments.values()].sort((a, b) => a.start - b.start)) {
      const p = document.createElement('p'); p.dir = 'auto'; p.textContent = `[${timestamp(s.start)}] ${s.username}: ${s.text}`; list.append(p);
    }
    list.scrollTop = list.scrollHeight; render();
  }
  function update(next) {
    if (next.id && next.id !== current.id) { segments.clear(); $('transcript').replaceChildren(); $('transcriptionWarning').textContent = ''; }
    const asked = next.phase === 'consent' && current.phase !== 'consent' && !next.approvedPeerIds?.includes(state.peerId);
    current = next; for (const entry of next.segments || []) segment(entry);
    render();
    if (current.phase === 'recording') startCapture();
    else if (current.phase === 'idle') { stopCapture(); cancelQueue(); }
    if (asked && state.joined) checkService().catch(() => {});
    if (next.reason) notice(next.reason);
  }
  const act = async (method, data, needsSpeech = false) => {
    try {
      if (needsSpeech) {
        const problem = await checkService();
        if (problem) throw Error(problem);
        await prepare();
      }
      await rpc(method, data);
    } catch (error) { notice(error.message); if (current.phase === 'idle') stopCapture(); }
  };
  $('transcriptionStart').onclick = () => act('transcriptionRequest', {}, true);
  $('transcriptionAllow').onclick = () => act('transcriptionConsent', { id: current.id, allow: true }, true);
  $('transcriptionDecline').onclick = $('transcriptionWithdraw').onclick = () => act('transcriptionConsent', { id: current.id, allow: false });
  $('transcriptionStop').onclick = () => act('transcriptionStop', { id: current.id });
  for (const format of ['txt', 'srt']) $(`transcript-${format}`).onclick = () => {
    const url = URL.createObjectURL(new Blob([exportTranscript([...segments.values()], format)], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `meeting-transcript.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  render();
  function warning(message) { $('transcriptionWarning').textContent = message; notice(message); }
  return { update, segment, warning,
    // The meeting server tells each page where its local speech service is expected (LOCAL_SPEECH_URL).
    configure(url) { speech = url ? createSpeech(url) : null; health = { status: 'unknown' }; render(); },
    downloads() { return segments.size ? { txt: exportTranscript([...segments.values()], 'txt'), srt: exportTranscript([...segments.values()], 'srt') } : null; },
    flush({ id }) {
      if (id !== current.id) return;
      if (capture) capture.port.postMessage('flush');
      else finish(id);
    },
    resetAudio() { capture?.port.postMessage('reset'); },
    // The audio panel swapped the published microphone track: keep the same capture (and sequence) running on it.
    replaceMicrophone(track) {
      if (!capture || !ctx || !track) return;
      source?.disconnect();
      captureTrack = track; source = ctx.createMediaStreamSource(new MediaStream([track])); source.connect(capture);
    },
    leave() { stopCapture(); cancelQueue(); clearTimeout(healthTimer); current = { ...current, phase: 'idle' }; render(); },
  };
}
