// "Audio processing" panel: chooses how the microphone is processed and switches live during a call.
// Every change captures a new microphone track for the requested mode (and, for Ours, builds a new
// pipeline), swaps it into the existing producer with replaceTrack, then stops the old track/pipeline.
// The call and its producer stay up. If the new mode cannot start, the previous one stays active and
// the panel says why: there is no silent fallback.
import { createOursPipeline } from './pipeline.js';
import { createPlayout } from './playout.js';
import { MODES, browserConstraints, loadPrefs, savePrefs, readSettings, compareSettings, describe, formatSettings } from './modes.js';

const storage = (() => { try { return globalThis.localStorage; } catch { return null; } })();
const ms = value => (value === null || value === undefined ? null : Math.round(value));

export function setupAudioProcessing({ $, event = () => {}, onActive = () => {} }) {
  const playout = createPlayout();
  let prefs = loadPrefs(storage); // what the user chose (saved)
  let active = null; // what is running now: { prefs, raw, owned, track, pipeline, requested, settings }
  let producer = null, trackChanged = () => {}, synthetic = null, busy = false, next = null, switching = null, statsText = '';
  const state = { lastStats: null };
  const radios = () => [...document.querySelectorAll('input[name="audioMode"]')];

  function setError(message) { $('audioError').textContent = message || ''; }
  function render() {
    const shown = busy ? (next || switching || prefs) : (active?.prefs || prefs);
    for (const radio of radios()) { radio.checked = radio.value === shown.mode; radio.disabled = busy; }
    $('audioEcho').checked = shown.echo; $('audioNoise').checked = shown.noise;
    $('audioEcho').disabled = $('audioNoise').disabled = busy;
    $('audioSwitchHint').textContent = shown.mode === 'off' ? 'Off sends the unprocessed microphone; the two switches apply when you choose Browser or Ours.' : '';
    if (busy) $('audioActive').textContent = `Switching to ${describe(next || switching || prefs)}…`;
    else if (!active) $('audioActive').textContent = `Selected: ${describe(prefs)}. Applies when you join.`;
    else $('audioActive').textContent = `Active: ${describe(active.prefs)}`;
    if (!active) { $('audioSettings').textContent = ''; $('audioStats').textContent = ''; return; }
    const { ignored, unreported } = compareSettings(active.requested, active.settings);
    const source = active.synthetic ? 'Synthetic test tone' : active.prefs.mode === 'ours' ? 'Microphone capture (input to Ours)' : 'Microphone track';
    let text = `${source} reports: ${formatSettings(active.settings)}.`;
    if (active.synthetic) text += ' Browser processing settings do not apply to the generated tone.';
    else if (ignored.length) text += ` The browser did not apply the requested ${ignored.join(', ')}; the values shown are what it actually uses.`;
    else if (unreported.length === 3) text += ' This browser does not report its audio processing settings.';
    if (active.prefs.mode === 'ours' && active.settings.echoCancellation === true) text += ' Warning: browser echo cancellation is still on, so audio is processed twice.';
    $('audioSettings').textContent = text;
    $('audioStats').textContent = active.pipeline ? statsText || 'Ours is running; measurements appear after a few seconds of audio.' : '';
  }
  function showStats(stats) {
    const e = stats.engine, w = stats.worklet, parts = [];
    const buffered = w ? w.bufferedMs : null, chain = e?.chainDelay?.ms ?? null;
    if (buffered !== null && chain !== null) parts.push(`Added latency ${ms(buffered + chain)} ms (measured: ${ms(chain)} ms model + resampling, ${ms(buffered)} ms buffering${e?.aec ? "; DTLN-aec's own 24 ms is part of the first figure" : ''}).`);
    else parts.push(`Added latency: buffering ${buffered === null ? 'not measured yet' : `${ms(buffered)} ms`}; model + resampling delay ${chain === null ? 'not measured yet (needs a few seconds of speech)' : `${ms(chain)} ms`}.`);
    if (e?.aec) parts.push(`Echo canceller: ${e.aec.mean.toFixed(2)} ms per ${e.aecBlockMs} ms block (p95 ${e.aec.p95.toFixed(2)}).`);
    if (e?.ns) parts.push(`Noise suppression: ${e.ns.mean.toFixed(2)} ms per ${e.nsHopMs} ms frame (p95 ${e.ns.p95.toFixed(2)}).`);
    if (e?.busyRatio !== null && e?.busyRatio !== undefined) parts.push(`Worker busy ${(e.busyRatio * 100).toFixed(1)}% of real time.`);
    if (e?.refDelayMs !== null && e?.refDelayMs !== undefined) parts.push(`Far-end reference delayed ${ms(e.refDelayMs)} ms (${e.refDelaySource}).`);
    if (w?.underruns) parts.push(`${w.underruns} buffer underrun(s).`);
    if (w?.droppedMs) parts.push(`Could not keep up: ${ms(w.droppedMs)} ms of audio dropped.`);
    statsText = parts.join(' ');
    if (active?.pipeline) $('audioStats').textContent = statsText;
    state.lastStats = stats;
  }

  const openMic = async constraints => (await navigator.mediaDevices.getUserMedia({ audio: constraints })).getAudioTracks()[0];
  // previous: the capture still feeding the call. Chrome may give a new capture the processing of a capture
  // of the same microphone that is still open, ignoring the new constraints. If the read-back shows that,
  // release our old capture and ask once more (a short gap in the sent audio; the call itself stays up).
  async function capture(p, previous = null) {
    const requested = browserConstraints(p);
    let raw = synthetic, owned = false;
    if (!raw) {
      raw = await openMic(requested); owned = true;
      if (compareSettings(requested, readSettings(raw)).ignored.length && previous?.owned && previous.raw.readyState === 'live') {
        const first = readSettings(raw);
        raw.stop(); previous.raw.stop(); previous.released = true;
        raw = await openMic(requested);
        event('audioProcessingRecapture', { mode: p.mode, firstReported: first, reported: readSettings(raw) });
      }
    }
    try { return await build(p, raw, owned, requested); }
    catch (error) { if (owned) raw.stop(); throw error; }
  }
  async function build(p, raw, owned, requested) {
    const item = { prefs: { ...p }, raw, owned, requested, synthetic: raw === synthetic, settings: readSettings(raw), track: raw, pipeline: null };
    if (p.mode === 'ours') {
      raw.enabled = true; // a reused tone may have been disabled by a muted producer
      statsText = '';
      item.pipeline = await createOursPipeline({ source: raw, echo: p.echo, noise: p.noise, onStats: showStats,
        onError: error => { setError(`Ours reported an error: ${error.message}`); event('audioProcessingError', { message: error.message }); } });
      item.track = item.pipeline.track;
    }
    return item;
  }
  function route(item) {
    if (item?.pipeline && item.prefs.echo) item.pipeline.connectReference(playout.route(item.pipeline.ctx));
    else playout.unroute();
  }
  function release(item) {
    if (!item) return;
    item.pipeline?.dispose();
    if (item.owned) item.raw.stop();
  }
  function record(item) {
    const detail = { mode: item.prefs.mode, echo: item.prefs.echo, noise: item.prefs.noise, requested: item.requested, reported: item.settings, synthetic: item.synthetic };
    event('audioProcessing', detail); onActive(detail);
  }

  async function change(wanted) {
    if (!producer) { prefs = wanted; savePrefs(storage, prefs); render(); return; }
    // In Off the switches change nothing that is running: remember them for the next mode.
    if (!busy && wanted.mode === 'off' && active?.prefs.mode === 'off') { active.prefs = { ...wanted }; prefs = wanted; savePrefs(storage, prefs); render(); return; }
    if (busy) { next = wanted; render(); return; }
    busy = true; next = wanted; setError(''); render();
    while (next) {
      const target = switching = next; next = null;
      render();
      const previous = active;
      let fresh = null;
      try {
        fresh = await capture(target, previous);
        await swapTo(fresh);
      } catch (error) {
        release(fresh);
        event('audioProcessingFailed', { mode: target.mode, message: error.message });
        if (!producer) continue;
        let outcome = previous ? `Still using ${describe(previous.prefs)}.` : '';
        if (previous?.released) {
          // We closed the previous microphone to retry; reopen it in the previous mode.
          try { await swapTo(await capture(previous.prefs)); outcome = `${describe(previous.prefs)} was restored.`; }
          catch (restoreError) { outcome = `The previous microphone could not be reopened either (${restoreError.message}); choose a mode to try again.`; }
        } else route(previous); // the previous pipeline is still running: give it back the far-end reference
        setError(`Could not switch to ${MODES[target.mode].label}: ${error.message.replace(/\.$/, '')}. ${outcome}`);
        continue;
      }
      prefs = target; savePrefs(storage, prefs);
    }
    busy = false; switching = null; render();
  }
  // Put a built capture on the producer, then stop whatever it replaces.
  async function swapTo(item) {
    if (!producer) throw Error('left the meeting');
    const previous = active;
    route(item);
    await producer.replaceTrack({ track: item.track });
    active = item;
    trackChanged(previous?.track, item.track);
    if (previous !== item) release(previous);
    record(item);
  }
  function wanted() {
    const mode = radios().find(r => r.checked)?.value || prefs.mode;
    return { mode, echo: $('audioEcho').checked, noise: $('audioNoise').checked };
  }
  for (const radio of radios()) radio.onchange = () => change(wanted());
  $('audioEcho').onchange = $('audioNoise').onchange = () => change(wanted());
  $('audioInfoToggle').onclick = () => {
    const open = $('audioInfo').hidden;
    $('audioInfo').hidden = !open; $('audioInfoToggle').setAttribute('aria-expanded', String(open));
  };
  render();

  return {
    // getUserMedia audio constraints for the join-time capture.
    constraints: () => browserConstraints(prefs),
    // At join: `track` is the captured microphone (or the synthetic tone). Returns the track to publish.
    async start(track, { isSynthetic = false } = {}) {
      synthetic = isSynthetic ? track : null;
      const requested = browserConstraints(prefs);
      busy = true; next = prefs; render();
      try {
        try { active = await build(prefs, track, !isSynthetic, requested); }
        catch (error) {
          // Joining needs a microphone track. Say plainly that Ours did not start and what is used instead.
          if (!isSynthetic) track.stop();
          const fallback = { ...prefs, mode: 'browser' };
          setError(`Ours could not start: ${error.message.replace(/\.$/, '')}. Your microphone is using ${describe(fallback)} until you choose a mode again.`);
          event('audioProcessingFailed', { mode: prefs.mode, message: error.message, atJoin: true });
          active = await capture(fallback);
        }
        route(active); record(active);
        return active.track;
      } finally { busy = false; next = null; render(); }
    },
    attach(micProducer, onTrackChanged) { producer = micProducer; trackChanged = onTrackChanged; },
    addRemoteAudio: (id, el, track) => playout.add(id, el, track),
    removeRemoteAudio: id => playout.remove(id),
    setLocalScreenAudio: track => playout.setLocalScreenAudio(track),
    get active() { return active ? { ...active.prefs, reported: active.settings, requested: active.requested } : null; },
    get stats() { return state.lastStats; },
    leave() {
      producer = null; next = null;
      playout.clear(); release(active); active = null; synthetic = null; statsText = '';
      busy = false; setError(''); render();
    },
  };
}
