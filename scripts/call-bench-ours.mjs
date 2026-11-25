// Call benchmark through this app: for each audio mode, a sender joins a test room with the playlist as its
// microphone (Chrome's fake microphone) and a receiver in the same room records what arrives, after the SFU and
// Opus, as it would play it. The recordings go to <playlist>/recordings/<mode>.wav and are scored with
// scripts/call_bench_score.py, together with any Zoom / Meet / Teams recordings you made on /call-bench.
//
//   npm run call:bench:ours                              newest playlist in data/call-bench/
//   npm run call:bench:ours -- data/call-bench/<time>
//
// Needs the server running (BASE_URL, default http://127.0.0.1:3100; use a local test server: it creates a test room
// owner account) and, for Ours, the models (npm run audio:models). Options: CALL_MODES=off,browser,ours,
// BROWSER_CHANNEL=chrome|msedge, HEADED=1.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { createTestRoom } from './test-room.mjs';

const env = process.env, root = fileURLToPath(new URL('..', import.meta.url));
const base = env.BASE_URL || 'http://127.0.0.1:3100';
const modes = (env.CALL_MODES || 'off,browser,ours').split(',').map(m => m.trim()).filter(Boolean);
for (const m of modes) assert(['off', 'browser', 'ours'].includes(m), `unknown mode "${m}" in CALL_MODES (use off, browser, ours)`);
const benchRoot = `${root}data/call-bench`;
const playlists = existsSync(benchRoot) ? readdirSync(benchRoot).filter(d => existsSync(`${benchRoot}/${d}/playlist.json`)).sort() : [];
const folder = resolve(process.argv[2] || (playlists.length ? `${benchRoot}/${playlists.at(-1)}` : ''));
if (!existsSync(`${folder}/playlist.json`)) { console.error('No playlist found. Make one with "npm run call:bench:make".'); process.exit(1); }
const meta = JSON.parse(readFileSync(`${folder}/playlist.json`, 'utf8'));
mkdirSync(`${folder}/recordings`, { recursive: true });
const log = (...a) => console.log(...a);
log(`${modes.length} mode(s) × ${Math.ceil(meta.seconds / 60)} min through ${base}. Playlist: ${relative(root, folder)}`);

// In the receiver's page: record the first remote microphone track (as the page plays it) until told to stop,
// then hand the 48 kHz mono 16-bit WAV over as a download.
function recordRemote() {
  const consumer = [...window.lab.consumers.values()].find(c => c.kind === 'audio');
  const ctx = new AudioContext({ sampleRate: 48000 }), parts = [];
  window.callBench = { ctx, parts, consumer };
  return ctx.audioWorklet.addModule('/audio/recorder-worklet.js').then(() => {
    const node = new AudioWorkletNode(ctx, 'pcm-recorder', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute).connect(ctx.destination);
    ctx.createMediaStreamSource(new MediaStream([consumer.track])).connect(node, 0, 0);
    window.callBench.done = new Promise(resolve => { node.port.onmessage = ({ data }) => (data.done ? resolve() : parts.push(data.a)); });
    window.callBench.stop = () => node.port.postMessage('stop');
    return ctx.resume();
  });
}
async function saveRecording() {
  const { parts, ctx } = window.callBench;
  window.callBench.stop(); await window.callBench.done; ctx.close();
  const n = parts.reduce((s, p) => s + p.length, 0), bytes = new ArrayBuffer(44 + n * 2), v = new DataView(bytes);
  const text = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); text(8, 'WAVE'); text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 48000, true); v.setUint32(28, 96000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44; for (const p of parts) for (const x of p) { v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(x * 32767))), true); o += 2; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); a.download = 'received.wav';
  document.body.append(a); a.click();
}

const recordings = [];
for (const mode of modes) {
  const browser = await chromium.launch({ headless: env.HEADED !== '1', channel: env.BROWSER_CHANNEL || 'chrome', args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    `--use-file-for-fake-audio-capture=${folder}/playlist.wav`,
  ] });
  try {
    const room = await createTestRoom(browser, base, `Call bench ${mode}`), errors = [];
    // Receiver: the room owner joins first and mutes its microphone (the fake microphone plays the playlist too, and
    // the sender's echo canceller must not get it as far-end sound).
    await room.context.grantPermissions(['microphone', 'camera'], { origin: base });
    const receiver = await room.context.newPage();
    receiver.on('pageerror', e => errors.push(`receiver: ${e.message}`));
    await receiver.goto(`${base}/?${room.query}${room.fragment}`);
    await receiver.locator('#join').click(); await receiver.waitForFunction(() => window.lab.joined, null, { timeout: 60000 });
    await receiver.locator('#mic').click();
    await receiver.waitForFunction(() => window.lab.producers.find(p => p.kind === 'audio')?.paused, null, { timeout: 10000 });
    // Sender: a guest with the audio mode under test saved as its preference.
    const context = await browser.newContext();
    await context.grantPermissions(['microphone', 'camera'], { origin: base });
    const entry = await context.request.post(`${base}/api/auth/guest`, { headers: { Origin: new URL(base).origin }, data: { name: `Sender ${mode}` } });
    assert.equal(entry.status(), 201, `guest sign-in at ${base} failed (is the server running?)`);
    await context.addInitScript(m => localStorage.setItem('audio-processing', JSON.stringify({ mode: m, echo: true, noise: true })), mode);
    const sender = await context.newPage();
    sender.on('pageerror', e => errors.push(`sender: ${e.message}`));
    await sender.goto(`${base}/?${room.query}${room.fragment}`);
    await sender.locator('#join').click(); await sender.waitForFunction(() => window.lab.joined, null, { timeout: 120000 });
    const active = await sender.evaluate(() => window.lab.metadata?.audioProcessing?.mode ?? null);
    assert.equal(active, mode, `the sender is running "${active}", not "${mode}" (did Ours fail to start? see the page's audio panel)`);
    // Record from the moment the sender's audio reaches the receiver; the playlist starts with silence.
    await receiver.waitForFunction(() => [...window.lab.consumers.values()].some(c => c.kind === 'audio'), null, { timeout: 30000 });
    await receiver.evaluate(recordRemote);
    log(`${mode}: recording ${Math.ceil(meta.seconds)} s…`);
    await receiver.waitForTimeout((meta.seconds + 2) * 1000);
    const download = receiver.waitForEvent('download', { timeout: 120000 });
    await receiver.evaluate(saveRecording);
    const file = `${folder}/recordings/${mode}.wav`;
    await (await download).saveAs(file);
    assert.deepEqual(errors, [], `page errors during ${mode}`);
    recordings.push(`${mode}=${file}`);
    log(`${mode}: saved ${relative(root, file)}`);
  } finally { await browser.close(); }
}

const python = `${root}.venv-bench/bin/python`, score = [`${root}scripts/call_bench_score.py`, folder, ...recordings];
if (!existsSync(python)) { log(`Recorded. Scoring tools missing: run "npm run audio:bench:install", then:\n  .venv-bench/bin/python ${score.map(a => JSON.stringify(a)).join(' ')}`); process.exit(0); }
log('To score these together with Zoom / Meet / Teams recordings later, add them to the same command:\n  npm run call:bench:score -- ' +
  [relative(root, folder), ...recordings.map(r => r.replace(root, ''))].join(' ') + ' zoom=<file> meet=<file> …');
const scored = spawnSync(python, score, { stdio: 'inherit' });
process.exit(scored.status ?? 1);
