import { createRoomRecording } from './recording.js';

// Speech recognition runs on each participant's own computer (speech/service.py, Omnilingual ASR).
// Audio never reaches this server: browsers send only recognized text, and the server enforces consent,
// stamps the authenticated speaker and shares the text with the room.
const FINISH_TIMEOUT_MS = 120000; // Local recognition may lag behind speech on slower computers.

export function createTranscription({ peers, publish, now = Date.now, finishTimeoutMs = FINISH_TIMEOUT_MS }) {
  let history = [], sequences = new Map(), finishing = null;
  const snapshot = () => ({ ...policy.snapshot(), ...(finishing ? { phase: 'finishing' } : {}), segments: history });
  const cancel = () => {
    if (finishing) clearTimeout(finishing.timer);
    finishing = null;
  };
  const policy = createRoomRecording({ peers, now, publish(data) {
    if (data.phase === 'idle') cancel();
    publish('transcriptionState', { ...data, segments: history,
      reason: data.reason?.replaceAll('recording', 'transcription').replaceAll('Recording', 'Transcription') });
  } });
  function maybeFinish() {
    if (!finishing || finishing.waiting.size) return;
    const { peer, id, timer } = finishing; clearTimeout(timer); finishing = null;
    policy.stop(peer, id);
  }
  return {
    snapshot,
    request(peer) {
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
        publish('transcriptionWarning', { message: 'A participant’s computer did not finish transcribing in time; their last sentences may be missing.' });
        finishing.waiting.clear(); maybeFinish();
      }, finishTimeoutMs); finishing.timer.unref?.();
      publish('transcriptionState', snapshot()); publish('transcriptionFlush', { id });
      return snapshot();
    },
    // The participant's computer has transcribed all of its remaining speech.
    flushed(peer, id) {
      if (!peers.has(peer) || finishing?.id !== id) throw Error('No matching transcription is finishing');
      finishing.waiting.delete(peer.id); maybeFinish(); return {};
    },
    failed(peer, id) {
      if (!peers.has(peer) || policy.snapshot().id !== id) throw Error('No matching transcription session');
      return policy.consent(peer, id, false);
    },
    // One recognized speech segment from a participant's own computer.
    text(peer, data) {
      const active = policy.snapshot();
      if (!peers.has(peer) || active.phase !== 'recording' || active.id !== data?.id || !active.approvedPeerIds.includes(peer.id) || (finishing && !finishing.waiting.has(peer.id))) throw Error('Transcription consent required');
      // offset is when the speech started (ms since the session began). Recognition may finish much later.
      if (!Number.isInteger(data.seq) || data.seq <= (sequences.get(peer.id) ?? -1) || !Number.isFinite(data.offset) || data.offset < 0 || data.offset > now() - active.startedAt + 1000) throw Error('Invalid speech sequence');
      if (!Number.isFinite(data.duration) || data.duration < 100 || data.duration > 40000) throw Error('Invalid speech duration');
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 2000) throw Error('Invalid transcript text');
      sequences.set(peer.id, data.seq);
      // Speaker identity comes from the authenticated session, never from the client.
      const entry = { id: `${active.id}:${peer.id}:${data.seq}`, peerId: peer.id, username: peer.username,
        start: data.offset, end: data.offset + data.duration, text: data.text.trim() };
      history.push(entry); if (history.length > 2000) history.shift(); publish('transcriptSegment', entry);
      return { accepted: true };
    },
    beforeJoin: policy.beforeJoin, membershipChanged: policy.membershipChanged,
    memberLeft(id) { if (finishing) finishing.waiting.delete(id); policy.memberLeft(id); maybeFinish(); },
    dispose() { cancel(); history = []; policy.dispose(); },
  };
}
