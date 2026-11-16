// Audio test page: compare Off, Browser and Ours on this machine with measurements only.
import { createOursPipeline, oursSupport } from '../audio/pipeline.js';
import { createPlayout } from '../audio/playout.js';
import { MODES, browserConstraints, readSettings, compareSettings, formatSettings, loadPrefs } from '../audio/modes.js';
import { encodeWav, estimateDelay, Downsampler, meanSquare, powerDb, rmsDbfs, speechToNoise, frameLevels, wordErrorRate } from '../audio/dsp.js';
import { speechLikeClip, pinkNoise, averageTo16k } from './signals.js';
import { SpeechBuffer } from '../../public/speech-buffer.js';

const RATE = 48000, LEAD_IN = 3, TAKE_SECONDS = 20;
const ECHO_SILENCE = 1.5, ECHO_CLIP = 8, ECHO_TAIL = 0.7;
export const SCRIPT = 'The quick test begins now. I am reading this short passage so the meeting can compare three ways of cleaning my voice. Each version should sound clear, and the speech recognizer should still understand every word I say.';
const ORDER = ['off', 'browser', 'ours'];
const $ = id => document.getElementById(id);
const results = Object.fromEntries(ORDER.map(mode => [mode, { take: null, echo: null, recognition: null }]));
let busy = false, stopRequested = null;
const round = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(d)));

$('script').textContent = SCRIPT;
const saved = loadPrefs((() => { try { return localStorage; } catch { return null; } })());
$('echoSwitch').checked = saved.echo; $('noiseSwitch').checked = saved.noise;
const unsupported = oursSupport();
$('capability').textContent = `Browser: ${navigator.userAgent}. ${unsupported ? `Ours cannot run here: ${unsupported}.` : 'AudioWorklet, WebAssembly and Workers are available.'} ${'PressureObserver' in globalThis ? 'CPU pressure readings are available.' : 'This browser offers no CPU pressure readings.'}`;

function setStatus(text) { $('status').textContent = text; }
function setError(text) { $('error').textContent = text || ''; }
function lock(on) {
  busy = on;
  for (const b of document.querySelectorAll('button[data-record]')) b.disabled = on;
  $('echoRun').disabled = on; $('werRun').disabled = on || !ORDER.some(m => results[m].take?.out);
  $('echoSwitch').disabled = $('noiseSwitch').disabled = on;
}
const switches = () => ({ echo: $('echoSwitch').checked, noise: $('noiseSwitch').checked });

// ---- Capture per mode. Browser also gets a parallel unprocessed capture when the browser allows it,
// so latency and in-run echo reduction can be measured against the same sound.
async function microphone(constraints) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  return stream.getAudioTracks()[0];
}
function closeCapture(c) { c.pipeline?.dispose(); c.track?.stop(); if (c.raw !== c.track) c.raw?.stop(); }
async function openMode(mode) {
  const prefs = { mode, ...switches() }, requested = browserConstraints(prefs);
  const c = { mode, prefs, requested, track: null, raw: null, pipeline: null, notes: [], stats: null };
  try {
    if (mode === 'off') { c.track = c.raw = await microphone(requested); }
    else if (mode === 'browser') {
      c.track = await microphone(requested);
      const raw = await microphone(browserConstraints({ mode: 'off' }));
      const processed = readSettings(c.track), unprocessed = readSettings(raw);
      const separate = !compareSettings(requested, processed).ignored.length && ![unprocessed.echoCancellation, unprocessed.noiseSuppression, unprocessed.autoGainControl].includes(true);
      if (separate) c.raw = raw;
      else { raw.stop(); c.notes.push('The browser would not keep an unprocessed copy of the microphone open next to the processed one, so latency and in-run echo reduction were not measured for Browser.'); }
    } else {
      c.raw = await microphone(requested);
      c.pipeline = await createOursPipeline({ source: c.raw, ...switches(), onStats: s => { c.stats = JSON.parse(JSON.stringify(s)); } });
      c.track = c.pipeline.track;
    }
    c.settings = readSettings(mode === 'ours' ? c.raw : c.track);
    c.rawSettings = c.raw && c.raw !== c.track ? readSettings(c.raw) : null;
    return c;
  } catch (error) { closeCapture(c); throw error; }
}

// ---- Sample-aligned recording of the track under test (and the raw reference) in one AudioContext.
function concat(parts) { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
async function record(c, seconds, { onChunk = () => {}, onTime = () => {} } = {}) {
  const ctx = new AudioContext({ sampleRate: RATE });
  try {
    await ctx.resume();
    await ctx.audioWorklet.addModule('/audio/recorder-worklet.js');
    const node = new AudioWorkletNode(ctx, 'pcm-recorder', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute).connect(ctx.destination);
    ctx.createMediaStreamSource(new MediaStream([c.track])).connect(node, 0, 0);
    const separateRaw = c.raw && c.raw !== c.track;
    if (separateRaw) ctx.createMediaStreamSource(new MediaStream([c.raw])).connect(node, 0, 1);
    const a = [], b = []; let total = 0, stopping = false;
    stopRequested = () => { if (!stopping) { stopping = true; node.port.postMessage('stop'); } };
    await new Promise(resolve => {
      node.port.onmessage = ({ data }) => {
        if (data.done) return resolve();
        a.push(data.a); b.push(data.b); total += data.a.length;
        onChunk(data.a); onTime(total / RATE);
        if (total >= seconds * RATE) stopRequested();
      };
    });
    const out = concat(a);
    return { out, raw: separateRaw ? concat(b) : c.raw === c.track ? out : null };
  } finally { stopRequested = null; ctx.close().catch(() => {}); }
}

// Delay of `out` relative to `raw`, from the speech part of a take (both recorded in one context).
function measureLatency(raw, out, fromSeconds = 0) {
  const down = x => new Downsampler().process(x.subarray(Math.round(fromSeconds * RATE)));
  const a = down(raw), b = down(out);
  if (a.length < 16000 || powerDb(meanSquare(a)) < -55 || powerDb(meanSquare(b)) < -60) return null;
  const { lag, confidence } = estimateDelay(a, b, Math.round(0.4 * 16000));
  return confidence > 8 ? { ms: lag / 16, confidence: Math.round(confidence) } : null;
}

// ---- Optional noise clip and CPU pressure.
function startNoise(levelDb) {
  const ctx = new AudioContext({ sampleRate: RATE }), buffer = ctx.createBuffer(1, RATE * 10, RATE);
  buffer.copyToChannel(pinkNoise(RATE, 10, levelDb), 0);
  const source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true; source.connect(ctx.destination); source.start();
  return { levelDb, stop: () => { try { source.stop(); } catch { /* stopped */ } ctx.close().catch(() => {}); } };
}
function watchPressure() {
  if (!('PressureObserver' in globalThis)) return { stop: () => null };
  const order = ['nominal', 'fair', 'serious', 'critical']; let worst = null;
  let observer;
  try {
    observer = new PressureObserver(records => { for (const r of records) if (order.indexOf(r.state) > order.indexOf(worst)) worst = r.state; });
    observer.observe('cpu', { sampleInterval: 1000 }).catch(() => {});
  } catch { return { stop: () => null }; }
  return { stop: () => { observer.disconnect(); return worst || 'no reading'; } };
}

// ---- 1. A/B recording.
function buildTakes() {
  for (const mode of ORDER) {
    const box = document.createElement('section'); box.className = 'take'; box.setAttribute('aria-label', `${MODES[mode].label} recording`);
    box.innerHTML = `<h3>${MODES[mode].label}</h3><button data-record="${mode}">Record</button><button class="secondary" data-stop="${mode}" disabled>Stop</button>
      <p class="cue" id="cue-${mode}" role="status"></p><div class="meter" aria-hidden="true"><span id="meter-${mode}"></span></div>
      <p class="note" id="take-${mode}"></p><div id="playback-${mode}"></div><canvas id="graph-${mode}" width="600" height="70" aria-label="Level over time" hidden></canvas>`;
    $('takes').append(box);
    box.querySelector('[data-record]').onclick = () => recordTake(mode);
    box.querySelector('[data-stop]').onclick = () => stopRequested?.();
  }
}
function meter(mode, chunk) {
  const db = powerDb(meanSquare(chunk));
  $(`meter-${mode}`).style.width = `${Math.max(0, Math.min(100, (db + 70) / 70 * 100))}%`;
}
function drawLevels(mode, samples) {
  const canvas = $(`graph-${mode}`), ctx = canvas.getContext('2d'), levels = frameLevels(samples, RATE, 50);
  canvas.hidden = false; ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#b5f1dd';
  const w = canvas.width / Math.max(1, levels.length);
  levels.forEach((db, i) => { const h = Math.max(0, Math.min(1, (db + 70) / 70)) * canvas.height; ctx.fillRect(i * w, canvas.height - h, Math.max(1, w - 1), h); });
}
function playback(mode, samples) {
  const url = URL.createObjectURL(new Blob([encodeWav(samples, RATE)], { type: 'audio/wav' }));
  const holder = $(`playback-${mode}`); holder.replaceChildren();
  const audio = document.createElement('audio'); audio.controls = true; audio.src = url;
  const link = document.createElement('a'); link.href = url; link.download = `audio-test-${mode}.wav`; link.textContent = 'Download WAV';
  holder.append(audio, link);
}
async function recordTake(mode) {
  if (busy) return;
  lock(true); setError('');
  const stopButton = document.querySelector(`[data-stop="${mode}"]`);
  setStatus(`Opening the microphone for ${MODES[mode].label}…`);
  let c;
  try { c = await openMode(mode); }
  catch (error) {
    results[mode].take = { error: error.message };
    setError(`${MODES[mode].label} could not start: ${error.message}`); setStatus('Nothing was recorded.'); lock(false); render(); return;
  }
  const noise = $('noiseClip').checked ? startNoise(Number($('noiseLevel').value)) : null;
  const pressure = watchPressure();
  stopButton.disabled = false;
  setStatus(`Recording ${MODES[mode].label}.`);
  try {
    const rec = await record(c, TAKE_SECONDS, {
      onChunk: chunk => meter(mode, chunk),
      onTime: t => {
        $(`cue-${mode}`).textContent = t < LEAD_IN ? `Stay silent… ${Math.ceil(LEAD_IN - t)}` : `Read the script now (${Math.ceil(TAKE_SECONDS - t)} s left, Stop when done)`;
        $('script').classList.toggle('reading', t >= LEAD_IN);
      },
    });
    const pressureState = pressure.stop(), stats = c.stats;
    noise?.stop(); closeCapture(c);
    const snr = speechToNoise(rec.out, RATE, LEAD_IN);
    // Noise in the same lead-in before processing (Ours always has it; Browser only with a parallel raw capture).
    const rawLeadInDb = rec.raw && rec.raw !== rec.out ? rmsDbfs(rec.raw, Math.round(0.25 * RATE), Math.round((LEAD_IN - 0.25) * RATE)) : null;
    const latency = mode === 'off' ? { ms: 0, baseline: true } : rec.raw ? measureLatency(rec.raw, rec.out, LEAD_IN) : null;
    results[mode].take = {
      out: rec.out, seconds: round(rec.out.length / RATE), requested: c.requested, settings: c.settings, rawSettings: c.rawSettings,
      prefs: c.prefs, noiseClipDb: noise?.levelDb ?? null, snr, rawLeadInDb, latency, pressure: pressureState, notes: c.notes,
      pipeline: c.pipeline ? { loadMs: c.pipeline.info.loadMs, stages: c.pipeline.info.stages.map(s => s.model), stats } : null,
    };
    $(`take-${mode}`).textContent = `${formatSettings(c.settings)}.${c.notes.length ? ` ${c.notes.join(' ')}` : ''}`;
    playback(mode, rec.out); drawLevels(mode, rec.out);
    setStatus(`${MODES[mode].label} recorded (${round(rec.out.length / RATE)} s).`);
  } catch (error) {
    pressure.stop(); noise?.stop(); closeCapture(c);
    setError(`Recording failed: ${error.message}`);
  } finally {
    stopButton.disabled = true; $(`cue-${mode}`).textContent = ''; $('script').classList.remove('reading'); $(`meter-${mode}`).style.width = '0';
    lock(false); render();
  }
}

// ---- 2. Echo test: a generated far-end clip through a local WebRTC loopback, played like a remote participant.
async function loopback() {
  const ctx = new AudioContext({ sampleRate: RATE }); await ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = e => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
  b.onicecandidate = e => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
  const remote = new Promise(resolve => { b.ontrack = e => resolve(e.track); });
  a.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
  await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
  const track = await Promise.race([remote, new Promise((_, reject) => setTimeout(() => reject(Error('local WebRTC loopback did not connect')), 10000))]);
  const el = document.createElement('audio'); el.autoplay = true; el.srcObject = new MediaStream([track]); el.hidden = true; document.body.append(el);
  await el.play().catch(() => {});
  return {
    track, el,
    play(samples) {
      const buffer = ctx.createBuffer(1, samples.length, RATE); buffer.copyToChannel(samples, 0);
      const source = ctx.createBufferSource(); source.buffer = buffer; source.connect(dest); source.start();
    },
    close() { el.remove(); a.close(); b.close(); ctx.close().catch(() => {}); },
  };
}
async function echoTest() {
  if (busy) return;
  lock(true); setError('');
  const clip = speechLikeClip(RATE, ECHO_CLIP);
  let link;
  try { link = await loopback(); }
  catch (error) { setError(`Echo test could not start: ${error.message}`); lock(false); return; }
  for (const mode of ORDER) {
    $('echoStatus').textContent = `${MODES[mode].label}: stay silent…`;
    let c;
    try { c = await openMode(mode); } catch (error) { results[mode].echo = { error: error.message }; render(); continue; }
    let playout = null;
    if (c.pipeline && c.prefs.echo) {
      // Same routing as in a meeting: the far-end plays through Web Audio and feeds the echo canceller.
      playout = createPlayout(); playout.add('far-end', link.el, link.track);
      c.pipeline.connectReference(playout.route(c.pipeline.ctx));
    }
    let started = false;
    try {
      const rec = await record(c, ECHO_SILENCE + ECHO_CLIP + ECHO_TAIL, { onTime: t => { if (!started && t >= ECHO_SILENCE) { started = true; link.play(clip); } } });
      const quiet = [Math.round(0.25 * RATE), Math.round((ECHO_SILENCE - 0.1) * RATE)];
      const active = [Math.round((ECHO_SILENCE + 0.5) * RATE), Math.round((ECHO_SILENCE + ECHO_CLIP) * RATE)];
      const level = (x, [s, e]) => (x ? powerDb(meanSquare(x, s, e)) : null);
      results[mode].echo = { echoPath: rec.raw ? echoPresence(clip, rec.raw) : null,
        floorDb: level(rec.out, quiet), residualDb: level(rec.out, active),
        rawFloorDb: level(rec.raw, quiet), rawEchoDb: level(rec.raw, active), notes: c.notes, stats: c.stats, settings: c.settings,
      };
    } catch (error) { results[mode].echo = { error: error.message }; }
    finally { playout?.clear(); closeCapture(c); }
    render();
  }
  link.close();
  // Validity: in the Off run the microphone must contain the clip itself (correlated with it, not just any sound)
  // clearly above the room noise; otherwise there was no echo to remove (headphones, muted speakers, someone talking).
  const off = results.off.echo;
  const correlated = Boolean(off?.echoPath);
  const audible = correlated && off.rawEchoDb !== null && off.rawFloorDb !== null && off.rawEchoDb - off.rawFloorDb >= 10;
  for (const mode of ORDER) if (results[mode].echo && !results[mode].echo.error) results[mode].echo.valid = audible;
  $('echoStatus').textContent = audible ? `Echo test finished. The echo reached the microphone about ${round(off.echoPath.ms, 0)} ms after playback.`
    : !correlated ? 'Echo test finished, but in the Off run the microphone did not pick up the played clip (it did not correlate with it: headphones, muted speakers, or other sound such as speech?). The echo results are not valid.'
      : 'Echo test finished, but in the Off run the clip was less than 10 dB above the room noise (speakers too quiet?). The echo results are not valid.';
  lock(false); render();
}

// Does the microphone recording contain the far-end clip? GCC-PHAT between the clip and the recording.
function echoPresence(clip, recorded) {
  const start = Math.round(ECHO_SILENCE * RATE);
  const a = new Downsampler().process(clip), b = new Downsampler().process(recorded.subarray(start, start + clip.length + Math.round(0.5 * RATE)));
  const n = Math.min(a.length, b.length);
  const { lag, confidence } = estimateDelay(a.subarray(0, n), b.subarray(0, n), Math.round(0.5 * 16000));
  return confidence > 8 ? { ms: lag / 16, confidence: Math.round(confidence) } : null;
}

// ---- 3. Recognition check through the server's transcription path.
async function recognition() {
  if (busy) return;
  lock(true); setError('');
  try {
    const status = await fetch('/api/audio-test/status', { cache: 'no-store' }).then(r => (r.ok ? r.json() : { transcription: false }));
    if (!status.transcription) {
      for (const mode of ORDER) if (results[mode].take?.out) results[mode].recognition = { error: 'transcription is not configured on this server' };
      $('werStatus').textContent = 'Not measured: this server has no speech recognizer configured (TRANSCRIPTION_URL). Nothing was uploaded.';
      return;
    }
    for (const mode of ORDER) {
      const take = results[mode].take;
      if (!take?.out) continue;
      // Segment exactly like the meeting transcription worklet: 16 kHz averaging, then SpeechBuffer.
      const chunks = [], buffer = new SpeechBuffer(m => chunks.push(m.samples)), s16 = averageTo16k(take.out, RATE);
      for (let i = 0; i + 320 <= s16.length; i += 320) buffer.push(s16.subarray(i, i + 320));
      buffer.flush();
      const texts = [];
      for (let i = 0; i < chunks.length; i++) {
        $('werStatus').textContent = `${MODES[mode].label}: uploading segment ${i + 1} of ${chunks.length}…`;
        const response = await fetch('/api/audio-test/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Speech-Language': 'en' }, body: encodeWav(chunks[i], 16000) });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw Error(body.error || `HTTP ${response.status}`);
        if (body.text) texts.push(body.text);
      }
      const hypothesis = texts.join(' ');
      results[mode].recognition = { segments: chunks.length, hypothesis, ...wordErrorRate(SCRIPT, hypothesis) };
      render();
    }
    $('werStatus').textContent = 'Recognition check finished.';
  } catch (error) { setError(`Recognition check failed: ${error.message}`); $('werStatus').textContent = ''; }
  finally { lock(false); render(); }
}

// ---- 4. Results table: measured values, or the reason there is none.
const na = reason => ({ na: reason });
function cell(mode, row) {
  const r = results[mode], take = r.take, echo = r.echo, rec = r.recognition;
  const noTake = take?.error ? na(`could not record: ${take.error}`) : na('not recorded yet');
  switch (row) {
    case 'settings': return take?.settings ? `${formatSettings(take.settings)}${take.notes?.length ? ` (${take.notes.join(' ')})` : ''}` : noTake;
    case 'speech': return !take?.out ? noTake : take.snr?.speechDb === undefined || take.snr.speechDb === null ? na('no speech detected above the lead-in noise') : `${round(take.snr.speechDb)} dBFS`;
    case 'snr': return !take?.out ? noTake : take.snr?.noiseDb < -100
      ? (take.rawLeadInDb !== null && take.rawLeadInDb > -90 && take.snr.speechDb !== undefined
        ? `more than ${round(take.snr.speechDb + 100)} dB: the lead-in noise (${round(take.rawLeadInDb)} dBFS before processing) was removed to below −100 dBFS`
        : na('the silent lead-in was digital silence (no room noise reached the page), so there is no noise level to compare with'))
      : take.snr?.snrDb === null || take.snr?.snrDb === undefined ? na('no speech detected above the lead-in noise') : `${round(take.snr.snrDb)} dB (noise ${round(take.snr.noiseDb)} dBFS${take.noiseClipDb !== null ? `, noise clip ${take.noiseClipDb} dBFS` : ', own room'})`;
    case 'echo': {
      if (!echo) return na('echo test not run');
      if (echo.error) return na(`could not run: ${echo.error}`);
      if (!echo.valid) return na('the Off run did not pick up the played clip clearly, so there was no measurable echo');
      const parts = [`residual ${round(echo.residualDb)} dBFS (room ${round(echo.floorDb)} dBFS)`];
      const offRaw = results.off.echo?.rawEchoDb;
      if (mode !== 'off' && offRaw !== null && offRaw !== undefined) parts.push(`${round(offRaw - echo.residualDb)} dB below the Off run`);
      if (mode !== 'off' && echo.rawEchoDb !== null) parts.push(`in-run ERLE ${round(echo.rawEchoDb - echo.residualDb)} dB`);
      else if (mode === 'browser') parts.push('in-run ERLE not measured (no parallel raw capture)');
      if (echo.residualDb - echo.floorDb < 3) parts.push('residual is at the room noise floor, so the true reduction may be larger');
      return parts.join('; ');
    }
    case 'wer': {
      if (!rec) return take?.out ? na('recognition check not run') : noTake;
      if (rec.error) return na(rec.error);
      return `${round(rec.wer * 100)}% (${rec.substitutions} sub, ${rec.deletions} del, ${rec.insertions} ins of ${rec.referenceWords} words): “${rec.hypothesis}”`;
    }
    case 'cost': {
      if (mode === 'off') return 'none (no processing)';
      if (mode === 'browser') return na('not measurable from a web page: the browser processes audio inside its own audio service');
      const s = take?.pipeline?.stats?.engine || echo?.stats?.engine;
      if (!s) return take?.error ? noTake : na('record a take with Ours first');
      const parts = [];
      if (s.aec) parts.push(`DTLN-aec ${round(s.aec.mean, 2)} ms per ${s.aecBlockMs} ms block (p95 ${round(s.aec.p95, 2)}, max ${round(s.aec.max, 2)})`);
      if (s.ns) parts.push(`DeepFilterNet3 ${round(s.ns.mean, 2)} ms per ${s.nsHopMs} ms frame (p95 ${round(s.ns.p95, 2)}, max ${round(s.ns.max, 2)})`);
      if (!parts.length) parts.push('both stages switched off');
      return parts.join('; ');
    }
    case 'cpu': {
      const pressure = take?.pressure;
      const own = mode === 'ours' ? (take?.pipeline?.stats?.engine?.busyRatio ?? null) : null;
      const parts = [];
      if (own !== null) parts.push(`worker busy ${round(own * 100)}% of real time (≈ share of one core)`);
      if (pressure) parts.push(`system CPU pressure: ${pressure}`);
      return parts.length ? parts.join('; ') : na(!take?.out ? 'not recorded yet' : 'browser exposes no CPU readings');
    }
    case 'latency': {
      if (!take?.out) return noTake;
      if (take.latency?.baseline) return '0 ms (reference)';
      const parts = [];
      if (take.latency) parts.push(`${round(take.latency.ms)} ms vs the raw microphone (track to track, measured)`);
      else parts.push(mode === 'browser' && take.notes?.length ? 'not measured (no parallel raw capture)' : 'not measured (no clear speech to align)');
      const w = take.pipeline?.stats?.worklet, chain = take.pipeline?.stats?.engine?.chainDelay;
      if (w && chain) parts.push(`pipeline: ${round(chain.ms)} ms model + resampling, ${round(w.bufferedMs)} ms buffering`);
      if (w?.underruns) parts.push(`${w.underruns} underrun(s)`);
      if (w?.droppedMs) parts.push(`${round(w.droppedMs)} ms dropped (could not keep up)`);
      return take.latency || parts.length > 1 ? parts.join('; ') : na(parts[0]);
    }
  }
}
const ROWS = [['settings', 'Settings the browser reports'], ['speech', 'Speech level'], ['snr', 'Speech-to-noise estimate'], ['echo', 'Residual echo / echo reduction'], ['wer', 'Word error rate'], ['cost', 'Processing time per frame'], ['cpu', 'CPU use'], ['latency', 'Added latency']];
function render() {
  const body = $('results'); body.replaceChildren();
  for (const [row, label] of ROWS) {
    const tr = document.createElement('tr'), th = document.createElement('th'); th.scope = 'row'; th.textContent = label; tr.append(th);
    for (const mode of ORDER) {
      const td = document.createElement('td'), value = cell(mode, row);
      if (value && typeof value === 'object') { td.className = 'na'; td.textContent = `Not measured: ${value.na}`; } else td.textContent = value;
      tr.append(td);
    }
    body.append(tr);
  }
  $('werRun').disabled = busy || !ORDER.some(m => results[m].take?.out);
}
$('exportResults').onclick = () => {
  const data = { createdAt: new Date().toISOString(), userAgent: navigator.userAgent, script: SCRIPT, results: Object.fromEntries(ORDER.map(mode => {
    const { take, echo, recognition: rec } = results[mode];
    return [mode, { take: take ? { ...take, out: undefined } : null, echo, recognition: rec, table: Object.fromEntries(ROWS.map(([row]) => [row, cell(mode, row)])) }];
  })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'audio-test-results.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('echoRun').onclick = echoTest;
$('werRun').onclick = recognition;
// Offline run of known audio through the same worker and models (used by scripts/audio-processing.mjs).
// mic/ref: Float32Array at 48 kHz. The pipeline's live input is a silent generated track.
async function offline({ mic, ref = null, echo = true, noise = false }) {
  const ctx = new AudioContext({ sampleRate: RATE }), silent = ctx.createMediaStreamDestination();
  const pipeline = await createOursPipeline({ source: silent.stream.getAudioTracks()[0], echo, noise });
  try { return await pipeline.process(mic, ref); } finally { pipeline.dispose(); ctx.close().catch(() => {}); }
}
buildTakes(); render(); lock(false);
window.audioTest = { results, SCRIPT, offline };
