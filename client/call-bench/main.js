// /call-bench: plays the call benchmark playlist into a meeting app's microphone (an output device such as BlackHole 2ch)
// and records what the receiving participant hears (an input device such as BlackHole 16ch). Playback and recording
// run in one AudioContext, so the saved stereo WAV (left: received, right: played) shares one clock and the scorer
// knows exactly when each clip was sent. Nothing leaves the browser.
import { meanSquare, powerDb } from '../audio/dsp.js';

const RATE = 48000, LEAD_IN = 1, AFTER = 3;  // seconds recorded before playback starts and after it ends
const $ = id => document.getElementById(id);
let playlist = null, devicesReady = false, run = null;

function setStatus(text) { $('status').textContent = text; }
function fail(error) { $('error').textContent = error.message || String(error); }
const minutes = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
function updateStart() {
  $('start').disabled = Boolean(run) || !playlist || !devicesReady || !$('output').value || !$('input').value;
  if (!run && !$('start').disabled) setStatus(`Ready: ${minutes(playlist.duration + LEAD_IN + AFTER)} of recording.`);
}

$('playlist').addEventListener('change', async () => {
  $('error').textContent = ''; playlist = null; updateStart();
  const file = $('playlist').files[0];
  if (!file) return;
  try {
    // An offline context at 48 kHz decodes (and if needed resamples) the file to the rate the scorer expects.
    playlist = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await file.arrayBuffer());
    $('playlistInfo').textContent = `${file.name}: ${minutes(playlist.duration)}, ${playlist.numberOfChannels === 1 ? 'mono' : `${playlist.numberOfChannels} channels (the first is played)`}.`;
  } catch (error) { fail(Error(`That file could not be read as audio (${error.message}).`)); }
  updateStart();
});

function fill(select, all, prefer) {
  // "default" and "communications" repeat a real device; keep them only if there is nothing else.
  const named = all.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications'), devices = named.length ? named : all;
  select.replaceChildren(...devices.map(d => new Option(d.label || `Device ${d.deviceId.slice(0, 6)}`, d.deviceId)));
  const preferred = devices.find(d => d.label.toLowerCase().includes(prefer));
  if (preferred) select.value = preferred.deviceId;
  select.disabled = !devices.length;
}
function checkDevices() {
  const out = $('output').selectedOptions[0]?.textContent || '', inp = $('input').selectedOptions[0]?.textContent || '';
  const base = label => label.replace(/\s*\(.*\)$/, '').trim().toLowerCase();
  $('deviceWarning').textContent = out && inp && base(out) === base(inp)
    ? 'Play into and Record from are the same virtual device: that records the playlist itself, not the app. Use two devices (for example BlackHole 2ch and BlackHole 16ch).' : '';
  updateStart();
}
$('allow').addEventListener('click', async () => {
  $('error').textContent = '';
  try {
    if (!('setSinkId' in AudioContext.prototype)) throw Error('This browser cannot choose where a page plays sound. Use Chrome or Edge 110 or later.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    fill($('output'), devices.filter(d => d.kind === 'audiooutput'), 'blackhole 2ch');
    fill($('input'), devices.filter(d => d.kind === 'audioinput'), 'blackhole 16ch');
    devicesReady = true; checkDevices();
  } catch (error) { fail(error); }
});
$('output').addEventListener('change', checkDevices);
$('input').addEventListener('change', checkDevices);

// 16-bit samples as they arrive (an 11-minute stereo run then needs about 130 MB, not 500 MB of floats).
const toPcm = x => { const out = new Int16Array(x.length); for (let i = 0; i < x.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))); return out; };
function stereoWav(left, right, rate) {
  const count = parts => parts.reduce((n, p) => n + p.length, 0), n = Math.min(count(left), count(right));
  const pcm = new Int16Array(n * 2);
  const put = (parts, channel) => { let i = 0; for (const p of parts) for (let k = 0; k < p.length && i < n; k++, i++) pcm[2 * i + channel] = p[k]; };
  put(left, 0); put(right, 1);
  const header = new DataView(new ArrayBuffer(44)), text = (o, t) => { for (let i = 0; i < t.length; i++) header.setUint8(o + i, t.charCodeAt(i)); };
  text(0, 'RIFF'); header.setUint32(4, 36 + n * 4, true); text(8, 'WAVE'); text(12, 'fmt '); header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); header.setUint16(22, 2, true); header.setUint32(24, rate, true); header.setUint32(28, rate * 4, true);
  header.setUint16(32, 4, true); header.setUint16(34, 16, true); text(36, 'data'); header.setUint32(40, n * 4, true);
  return new Blob([header.buffer, pcm.buffer], { type: 'audio/wav' });
}

async function start() {
  $('error').textContent = ''; $('save').hidden = true; $('saveInfo').textContent = 'Recording…';
  if ($('save').href) { URL.revokeObjectURL($('save').href); $('save').removeAttribute('href'); }
  const name = ($('name').value.trim() || 'run').replace(/[^\w-]+/g, '-').slice(0, 40);
  const r = run = { name, received: [], sent: [], recorded: 0, stopping: false, heardSpeech: false, warned: false };
  $('start').disabled = true; $('stop').disabled = false;
  try {
    r.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: $('input').value },
      echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    r.ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'playback' });
    await r.ctx.setSinkId($('output').value);
    await r.ctx.resume();
    await r.ctx.audioWorklet.addModule('/audio/recorder-worklet.js');
    // channelCount 1 (explicit): a stereo device is mixed down to mono for both inputs.
    const recorder = new AudioWorkletNode(r.ctx, 'pcm-recorder', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    const mute = r.ctx.createGain(); mute.gain.value = 0; recorder.connect(mute).connect(r.ctx.destination);
    const received = r.ctx.createMediaStreamSource(r.stream);
    received.connect(recorder, 0, 0);
    const done = new Promise(resolve => {
      recorder.port.onmessage = ({ data }) => {
        if (data.done) return resolve();
        r.received.push(toPcm(data.a)); r.sent.push(toPcm(data.b)); r.recorded += data.a.length;
        const seconds = r.recorded / RATE, total = playlist.duration + LEAD_IN + AFTER;
        $('progress').style.width = `${Math.min(100, seconds / total * 100)}%`;
        const inDb = powerDb(meanSquare(data.a)), outDb = powerDb(meanSquare(data.b));
        $('receivedMeter').style.width = `${Math.max(0, Math.min(100, (inDb + 70) / 60 * 100))}%`;
        $('sentMeter').style.width = `${Math.max(0, Math.min(100, (outDb + 70) / 60 * 100))}%`;
        if (inDb > -60) r.heardSpeech = true;
        if (!r.heardSpeech && seconds > LEAD_IN + 15 && !r.warned) {
          r.warned = true;
          $('error').textContent = 'Nothing is arriving from the app yet. Check that the sender\'s microphone is the "Play into" device, the receiver\'s speaker is the "Record from" device, and neither participant is muted (the receiver\'s own microphone should be).';
        }
        if (r.warned && r.heardSpeech) { $('error').textContent = ''; r.warned = false; }
        setStatus(`Recording ${minutes(seconds)} of ${minutes(total)}. Leave the call and this tab alone until the end.`);
      };
    });
    r.stop = () => { if (!r.stopping) { r.stopping = true; recorder.port.postMessage('stop'); } };
    if (r.cancelled) r.stop();  // Stop early was pressed while the devices were opening
    try { r.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not available */ }
    await new Promise(resolve => setTimeout(resolve, LEAD_IN * 1000));
    if (!r.stopping) {
      const source = r.ctx.createBufferSource(); source.buffer = playlist;
      source.connect(r.ctx.destination); source.connect(recorder, 0, 1);
      source.onended = () => setTimeout(r.stop, AFTER * 1000);
      source.start(); r.source = source;
    }
    await done;
    const blob = stereoWav(r.received, r.sent, RATE); r.received = r.sent = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    $('save').href = URL.createObjectURL(blob); $('save').download = `call-${name}-${stamp}.wav`; $('save').hidden = false;
    $('save').textContent = `Save recording (${$('save').download}, ${Math.round(blob.size / 1e6)} MB)`;
    $('saveInfo').textContent = r.heardSpeech ? 'Done. Save the recording, then score it (command below).'
      : 'Done, but nothing arrived from the app: the recording is silent. Check the set-up and run again.';
    setStatus(`Recorded ${minutes(r.recorded / RATE)}.`);
  } catch (error) {
    fail(error); setStatus('Stopped.'); $('saveInfo').textContent = 'No recording.';
  } finally {
    try { r.source?.stop(); } catch { /* ended */ }
    r.stream?.getTracks().forEach(t => t.stop()); r.ctx?.close().catch(() => {}); r.wakeLock?.release().catch(() => {});
    run = null; $('stop').disabled = true; updateStart();
  }
}
$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => { if (run) { setStatus('Stopping…'); run.cancelled = true; run.stop?.(); } });
window.callBench = { get playlist() { return playlist; } };
