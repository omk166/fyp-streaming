export function wavBase64(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const word = (offset, text) => [...text].forEach((c, i) => bytes[offset + i] = c.charCodeAt(0));
  word(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true));
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function timestamp(ms, srt = false) {
  const n = Math.max(0, Math.floor(ms));
  return `${String(Math.floor(n / 3600000)).padStart(2, '0')}:${String(Math.floor(n / 60000) % 60).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')}${srt ? ',' + String(n % 1000).padStart(3, '0') : ''}`;
}
export function exportTranscript(segments, format) {
  return [...segments].sort((a, b) => a.start - b.start).map((s, i) => format === 'srt'
    ? `${i + 1}\n${timestamp(s.start, true)} --> ${timestamp(s.end, true)}\n${s.username}: ${s.text}\n`
    : `[${timestamp(s.start)}] ${s.username}: ${s.text}`).join('\n');
}

export function setupTranscription({ $, state, rpc, microphone, notice }) {
  let current = { phase: 'idle', enabled: false }, segments = new Map(), ctx, source, capture, silent, generation = 0, starting = false;
  const render = () => {
    const active = current.phase === 'recording', pending = current.phase === 'consent', finishing = current.phase === 'finishing', owner = state.room?.role === 'owner';
    $('transcriptionStatus').textContent = !current.enabled ? 'Transcription needs server setup.' : finishing ? 'Finishing the remaining speech…' : active ? 'Transcription active — Arabic / English' : pending ? 'Waiting for everyone to agree…' : 'Transcription stopped';
    $('transcriptionStart').hidden = !owner || active || pending || finishing;
    $('transcriptionStart').disabled = !state.joined || !current.enabled || !globalThis.AudioWorkletNode;
    $('transcriptionStop').hidden = !owner || (!active && !pending && !finishing);
    $('transcriptionStop').disabled = finishing;
    $('transcriptionConsent').hidden = !state.joined || !pending || current.approvedPeerIds?.includes(state.peerId);
    $('transcriptionWithdraw').hidden = !state.joined || (!active && !finishing);
    for (const format of ['txt', 'srt']) $(`transcript-${format}`).disabled = !segments.size;
  };
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
      const track = microphone(); if (!track) throw Error('Microphone unavailable');
      source = context.createMediaStreamSource(new MediaStream([track]));
      capture = new AudioWorkletNode(context, 'speech-capture');
      silent = context.createGain(); silent.gain.value = 0;
      source.connect(capture); capture.connect(silent); silent.connect(context.destination);
      let seq = 0;
      const captureOffset = Math.max(0, Date.now() - current.startedAt);
      capture.port.onmessage = ({ data }) => {
        if (data.flushed) {
          stopCapture(); rpc('transcriptionFlushed', { id }).catch(error => notice(error.message)); return;
        }
        const { samples, startSample } = data;
        const offset = captureOffset + startSample / 16, sequence = seq++;
        const muted = state.producers.find(p => p.appData.source === 'microphone')?.paused;
        if (muted || track.readyState !== 'live' || token !== generation) return;
        rpc('transcriptionAudio', { id, seq: sequence, offset, language: $('transcriptionLanguage').value, wav: wavBase64(samples) }).catch(error => warning(error.message));
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
    current = next; for (const entry of next.segments || []) segment(entry);
    render();
    if (current.phase === 'recording') startCapture();
    else if (current.phase === 'idle') stopCapture();
    if (next.reason) notice(next.reason);
  }
  const act = async (method, data, needsAudio = false) => {
    try { if (needsAudio) await prepare(); await rpc(method, data); }
    catch (error) { notice(error.message); if (current.phase === 'idle') stopCapture(); }
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
    downloads() { return segments.size ? { txt: exportTranscript([...segments.values()], 'txt'), srt: exportTranscript([...segments.values()], 'srt') } : null; },
    progress(data) { $('transcriptionQueue').textContent = data.pending ? `Processing ${data.pending} speech segment(s), ${data.bufferedSeconds} seconds of audio buffered. Captions may be delayed.` : ''; },
    flush({ id }) {
      if (id !== current.id) return;
      if (capture) capture.port.postMessage('flush');
      else rpc('transcriptionFlushed', { id }).catch(error => notice(error.message));
    },
    resetAudio() { capture?.port.postMessage('reset'); },
    leave() { stopCapture(); current = { ...current, phase: 'idle' }; $('transcriptionQueue').textContent = ''; render(); },
  };
}
