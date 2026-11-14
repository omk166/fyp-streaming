import { randomUUID } from 'node:crypto';

// Coordinates permission only. Media is captured locally by the consenting host's browser.
export function createRoomRecording({ peers, publish, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let current = null, timer = null;
  const snapshot = reason => current ? { phase: current.phase, id: current.id, hostPeerId: current.hostPeerId,
    hostName: current.hostName, startedAt: current.startedAt, approvedPeerIds: [...current.approved] } : { phase: 'idle', id: null, approvedPeerIds: [], ...(reason ? { reason } : {}) };
  const emit = reason => publish(snapshot(reason));
  const member = peer => { if (!peers.has(peer)) throw Error('Join the room first'); };
  function stop(reason) {
    if (!current) return;
    clearTimer(timer); timer = null; current = null; emit(reason);
  }
  function maybeStart() {
    if (!current || current.phase !== 'consent') return;
    if ([...peers].every(peer => current.approved.has(peer.id))) {
      clearTimer(timer); current.phase = 'recording'; current.startedAt = now();
      timer = setTimer(() => stop('The 30-minute recording limit was reached. You can start a new recording.'), 30 * 60000); timer?.unref?.();
    }
    emit();
  }
  return {
    snapshot,
    request(peer) {
      member(peer);
      if (peer.role !== 'owner') throw Error('Only the room owner can request recording');
      if (current) throw Error('A recording or consent request is already in progress');
      current = { id: randomUUID(), phase: 'consent', hostPeerId: peer.id, hostName: peer.username, approved: new Set([peer.id]), startedAt: null };
      timer = setTimer(() => stop('Recording consent timed out. No recording was started.'), 2 * 60000); timer?.unref?.();
      maybeStart(); return snapshot();
    },
    consent(peer, id, allow) {
      member(peer);
      if (!current || current.id !== id || typeof allow !== 'boolean') throw Error('This recording request is no longer available');
      if (!allow) { stop(`${peer.username} ${current.phase === 'recording' ? 'withdrew recording consent' : 'declined recording'}.`); return snapshot(); }
      if (current.phase !== 'consent') throw Error('Recording has already started');
      current.approved.add(peer.id); maybeStart(); return snapshot();
    },
    stop(peer, id) {
      member(peer);
      if (!current || current.id !== id) throw Error('No matching recording is active');
      if (peer.role !== 'owner') throw Error('Only the owner can stop recording; participants may withdraw their consent');
      stop('Recording stopped by the room owner.'); return snapshot();
    },
    failed(peer, id) {
      member(peer);
      if (current?.id !== id || current.hostPeerId !== peer.id) throw Error('No matching recorder belongs to this connection');
      stop('The host recorder stopped or was unavailable. The call continues.'); return snapshot();
    },
    beforeJoin() { if (current?.phase === 'recording') stop('Recording stopped because someone joined. Everyone must consent to a new recording.'); },
    membershipChanged() { if (current?.phase === 'consent') maybeStart(); },
    memberLeft(peerId) {
      if (!current) return;
      if (current.hostPeerId === peerId) { stop('The recording host left.'); return; }
      current.approved.delete(peerId); maybeStart();
    },
    dispose() { clearTimer(timer); current = null; },
  };
}
