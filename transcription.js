import { createRoomRecording } from './recording.js';

// Serialize inference with a bounded queue; being busy never drops audio.
export function createTranscriber({ url = process.env.TRANSCRIPTION_URL, fetcher = fetch, maxPending = 24 } = {}) {
  let tail = Promise.resolve(), pending = 0;
  const run = (wav, { language = 'auto', signal } = {}) => {
    if (pending >= maxPending) return Promise.reject(Error('Speech queue is full. The processor cannot keep up.'));
    pending++;
    const result = tail.then(async () => {
      if (signal?.aborted) throw Error('Transcription cancelled');
      const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Speech-Language': language }, body: wav, signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw Error('Speech service unavailable');
      const result = await response.json();
      if (!Array.isArray(result.segments)) throw Error('Invalid speech service response');
      return result.segments;
    }).finally(() => { pending--; });
    tail = result.catch(() => {});
    return result;
  };
  run.enabled = Boolean(url);
  return run;
}

export function createTranscription({ peers, publish, transcribe, now = Date.now }) {
  let history = [], jobs = new Set(), sequences = new Map(), finishing = null;
  const snapshot = () => ({ ...policy.snapshot(), ...(finishing ? { phase: 'finishing' } : {}), enabled: transcribe.enabled, segments: history });
  const progress = () => publish('transcriptionProgress', { pending: jobs.size, bufferedSeconds: Math.round([...jobs].reduce((sum, job) => sum + job.duration / 1000, 0)) });
  const cancel = () => {
    if (finishing) clearTimeout(finishing.timer);
    finishing = null;
    for (const job of jobs) job.controller.abort();
    jobs.clear(); progress();
  };
  const policy = createRoomRecording({ peers, now, publish(data) {
    if (data.phase === 'idle') cancel();
    publish('transcriptionState', { ...data, enabled: transcribe.enabled, segments: history,
      reason: data.reason?.replaceAll('recording', 'transcription').replaceAll('Recording', 'Transcription') });
  } });
  function maybeFinish() {
    if (!finishing || finishing.waiting.size || jobs.size) return;
    const { peer, id, timer } = finishing; clearTimeout(timer); finishing = null;
    policy.stop(peer, id);
  }
  return {
    snapshot,
    request(peer) {
      if (!transcribe.enabled) throw Error('Transcription is not configured on this server yet.');
      if (!peers.has(peer) || peer.role !== 'owner' || policy.snapshot().phase !== 'idle') throw Error('Only the owner can start an idle transcription session');
      history = []; sequences.clear(); return policy.request(peer);
    },
    consent: policy.consent,
    stop(peer, id) {
      const active = policy.snapshot();
      if (!peers.has(peer) || peer.role !== 'owner' || active.id !== id || !['consent', 'recording'].includes(active.phase)) throw Error('Only the owner can stop the current transcription');
      if (active.phase === 'consent') return policy.stop(peer, id);
      if (finishing) return snapshot();
      finishing = { peer, id, waiting: new Set([...peers].map(p => p.id)) };
      finishing.timer = setTimeout(() => {
        if (!finishing) return;
        publish('transcriptionWarning', { message: 'A participant did not finish uploading; its final audio may be incomplete.' });
        finishing.waiting.clear(); maybeFinish();
      }, 10000); finishing.timer.unref?.();
      publish('transcriptionState', snapshot()); publish('transcriptionFlush', { id });
      return snapshot();
    },
    flushed(peer, id) {
      if (!peers.has(peer) || finishing?.id !== id) throw Error('No matching transcription is finishing');
      finishing.waiting.delete(peer.id); maybeFinish(); return {};
    },
    failed(peer, id) {
      if (!peers.has(peer) || policy.snapshot().id !== id) throw Error('No matching transcription session');
      return policy.consent(peer, id, false);
    },
    audio(peer, data) {
      const active = policy.snapshot();
      if (!peers.has(peer) || active.phase !== 'recording' || active.id !== data.id || !active.approvedPeerIds.includes(peer.id) || (finishing && !finishing.waiting.has(peer.id))) throw Error('Transcription consent required');
      if (peer.micMuted) throw Error('Muted microphone');
      if (!Number.isInteger(data.seq) || data.seq <= (sequences.get(peer.id) ?? -1) || !Number.isFinite(data.offset) || data.offset < 0 || data.offset > now() - active.startedAt + 1000) throw Error('Invalid audio sequence');
      if (data.language !== undefined && !['auto', 'en', 'ar'].includes(data.language)) throw Error('Choose Arabic and/or English');
      if (typeof data.wav !== 'string' || data.wav.length > 350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.wav)) throw Error('Invalid audio');
      const wav = Buffer.from(data.wav, 'base64');
      if (wav.length < 3244 || wav.length > 256044 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16) throw Error('Expected mono 16kHz PCM WAV');
      if (jobs.size >= 24) throw Error('Speech queue is full. Stop and wait for the processor to catch up.');
      sequences.set(peer.id, data.seq);
      const job = { peerId: peer.id, controller: new AbortController(), duration: (wav.length - 44) / 32 }; jobs.add(job); progress();
      Promise.resolve().then(() => transcribe(wav, { language: data.language || 'auto', signal: job.controller.signal })).then(segments => {
        if (job.controller.signal.aborted || policy.snapshot().id !== active.id || !peers.has(peer)) return;
        for (const segment of segments.slice(0, 100)) {
          if (typeof segment.text !== 'string' || !segment.text.trim() || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) continue;
          // Model timestamps can extend beyond a short clip, especially after VAD.
          // Keep recognized speech and clamp its times instead of losing the sentence.
          const start = Math.max(0, Math.min(segment.start * 1000, job.duration - 1));
          const end = Math.max(start + 1, Math.min(segment.end * 1000, job.duration));
          const entry = { id: `${active.id}:${peer.id}:${data.seq}:${history.length}`, peerId: peer.id, username: peer.username,
            start: data.offset + start, end: data.offset + end, text: segment.text.trim().slice(0, 2000) };
          history.push(entry); if (history.length > 2000) history.shift(); publish('transcriptSegment', entry);
        }
      }).catch(error => {
        if (!job.controller.signal.aborted) publish('transcriptionWarning', { message: `Some audio could not be transcribed: ${error.message}.` });
      }).finally(() => { jobs.delete(job); progress(); maybeFinish(); });
      return { accepted: true };
    },
    beforeJoin: policy.beforeJoin, membershipChanged: policy.membershipChanged,
    memberLeft(id) { for (const job of jobs) if (job.peerId === id) job.controller.abort(); if (finishing) finishing.waiting.delete(id); policy.memberLeft(id); maybeFinish(); },
    dispose() { cancel(); history = []; policy.dispose(); },
  };
}
