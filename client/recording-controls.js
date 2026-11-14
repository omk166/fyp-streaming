import { MeetingRecorder } from './recording.js';

export function setupRecording({ $, state, rpc, tiles, audioTracks, notice }) {
  let recording = { phase: 'idle', approvedPeerIds: [] }, starting = null, requesting = false;
  const recorder = new MeetingRecorder({ tiles, audioTracks,
    saved(blob, id, peerIds) {
      const link = document.createElement('a'), item = document.createElement('li');
      link.href = URL.createObjectURL(blob); link.download = `meeting-${new Date().toISOString().replace(/[:.]/g, '-')}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
      link.textContent = `Download recording (${(blob.size / 1048576).toFixed(1)} MB)`; item.append(link); $('recordings').append(item);
      // Keep a visible fallback link if automatic download is blocked by the browser.
      link.click(); state.lastRecording = { id, peerIds, size: blob.size, type: blob.type, url: link.href };
      $('recordingHint').textContent = 'Recording ready. Download it before closing this page. Files are saved on this computer, not on the server.';
    },
    failed(error, id) {
      notice(error.message);
      if (state.joined && recording.id === id) rpc('recordingFailed', { id }).catch(() => {});
    },
  });
  function render() {
    const active = recording.phase === 'recording', pending = recording.phase === 'consent';
    const owner = state.room?.role === 'owner', approved = recording.approvedPeerIds.includes(state.peerId);
    $('recordRequest').hidden = !owner || active || pending; $('recordRequest').disabled = !state.joined || requesting || !MeetingRecorder.supported();
    $('recordStop').hidden = !owner || (!active && !pending); $('recordStop').textContent = pending ? 'Cancel recording request' : 'Stop recording';
    $('recordConsent').hidden = !state.joined || !pending || approved;
    $('recordConsentText').textContent = `${recording.hostName || 'The host'} wants to record the meeting’s cameras, screens and audio. Allow this recording?`;
    $('recordWithdraw').hidden = !state.joined || !active || owner;
    $('recordingIndicator').textContent = active ? `● Recording · ${recording.hostName}` : pending ? approved ? 'Waiting for everyone’s recording consent…' : 'Recording permission requested' : 'Not recording';
    $('recordingIndicator').dataset.active = String(active);
  }
  async function update(next) {
    recording = next || { phase: 'idle', approvedPeerIds: [] }; state.recording = recording; render();
    if (recording.phase !== 'recording') {
      if (recording.phase === 'idle' || recorder.job) recorder.stop();
      starting = null;
      if (recording.reason) notice(recording.reason);
      return;
    }
    if (recording.hostPeerId !== state.peerId || starting === recording.id) return;
    starting = recording.id;
    try { await recorder.start({ id: recording.id, peerIds: recording.approvedPeerIds }); }
    catch (error) {
      recorder.stop(); notice(error.message);
      if (state.joined && recording.id === starting) await rpc('recordingFailed', { id: starting }).catch(() => {});
    }
  }
  $('recordRequest').onclick = async () => {
    if (requesting || !state.joined) return;
    requesting = true; render();
    try { await recorder.prepare(); await update(await rpc('recordingRequest')); }
    catch (error) { recorder.stop(); notice(error.message); }
    finally { requesting = false; render(); }
  };
  async function consent(allow) {
    if (!state.joined || !recording.id) return;
    $('recordAllow').disabled = true; $('recordDecline').disabled = true;
    try { await update(await rpc('recordingConsent', { id: recording.id, allow })); }
    catch (error) { notice(error.message); }
    finally { $('recordAllow').disabled = false; $('recordDecline').disabled = false; }
  }
  $('recordAllow').onclick = () => consent(true); $('recordDecline').onclick = () => consent(false);
  $('recordWithdraw').onclick = () => consent(false);
  $('recordStop').onclick = async () => {
    try { await update(await rpc('recordingStop', { id: recording.id })); }
    catch (error) { notice(error.message); }
  };
  return { update, refresh: render,
    leave() { const finished = recorder.stop(); recording = { phase: 'idle', approvedPeerIds: [] }; state.recording = recording; starting = null; render(); return finished; },
    get running() { return recorder.job?.recorder?.state === 'recording'; },
  };
}
