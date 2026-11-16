// End-to-end check of the audio processing modes in Chrome (or Edge with BROWSER_CHANNEL=msedge).
//   1. Offline: the official DTLN-aec sample recordings through our worker (echo removal, near-end kept).
//   2. Meeting: two participants; one switches Off / Browser / Ours live while the other keeps receiving audio,
//      with the reported getSettings() values checked after every switch.
//   3. Test page: an A/B take per mode, the recognition check (when the server has a recognizer) and the echo test.
// Uses Chrome's fake devices (no real microphone or speakers) and mutes output. Set SPEECH_TEST_WAV to a spoken WAV
// to use it as the fake microphone (the recognition check needs speech). With NOISE_DB=<snr> as well, the fake
// microphone gets that speech plus generated pink noise at that speech-to-noise ratio (noise test).
// Results go under ignored data/audio-test/.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestRoom } from './test-room.mjs';
import { decodeWav, encodeWav, Upsampler, Downsampler, meanSquare, powerDb, estimateDelay } from '../client/audio/dsp.js';
import { pinkNoise } from '../client/audio-test/signals.js';

const base = process.env.BASE_URL || 'http://127.0.0.1:3100';
const speech = process.env.SPEECH_TEST_WAV;
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = `${root}data/audio-test/`; mkdirSync(outDir, { recursive: true });
const log = (...a) => console.log(...a);
// Speech plus pink noise at `snrDb` (relative to the speech segment's power). Same noise for every run.
function addNoise(clean, snrDb, speechFrom, speechTo) {
  const noise = pinkNoise(48000, clean.length / 48000, -40, 11);
  const gain = Math.sqrt(meanSquare(clean, speechFrom, speechTo) / meanSquare(noise) / 10 ** (snrDb / 10));
  return clean.map((v, i) => v + gain * noise[i]);
}
const clean = speech ? decodeWav(readFileSync(speech)) : null;
if (clean) assert.equal(clean.rate, 48000, 'SPEECH_TEST_WAV must be 48 kHz');
const speechRange = clean ? [3 * 48000, Math.min(clean.samples.length, 15 * 48000)] : null; // after the 3 s lead-in
let micFile = speech;
if (speech && process.env.NOISE_DB) {
  micFile = `${outDir}noisy-mic-${process.env.NOISE_DB}dB.wav`;
  writeFileSync(micFile, encodeWav(addNoise(clean.samples, Number(process.env.NOISE_DB), ...speechRange), 48000));
}
const browser = await chromium.launch({ headless: process.env.HEADED !== '1', channel: process.env.BROWSER_CHANNEL || 'chrome', args: [
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  ...(micFile ? [`--use-file-for-fake-audio-capture=${micFile}`] : []),
] });
const errors = [];
async function join(page) {
  await page.waitForFunction(() => !document.querySelector('#join').disabled);
  await page.locator('#join').click();
  try { await page.waitForFunction(() => window.lab.joined, null, { timeout: 45000 }); }
  catch (error) { throw Error(`join did not complete: ${await page.evaluate(() => JSON.stringify({ status: document.querySelector('#status').textContent, audio: document.querySelector('#audioError').textContent, errors: window.lab.errors }))}`); }
}
async function guest(name) {
  const context = await browser.newContext();
  await context.grantPermissions(['microphone', 'camera'], { origin: base });
  const entry = await context.request.post(`${base}/api/auth/guest`, { headers: { Origin: new URL(base).origin }, data: { name } });
  assert.equal(entry.status(), 201);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => {
    // The missing DeepFilterNet3 build is an expected 404 when it is not installed (checked separately).
    // The app has never served a favicon; browsers request one anyway.
    if (m.type() === 'error' && !/\/(deepfilternet3\/df_bg\.wasm|favicon\.ico)$/.test(m.location().url || '')) errors.push(`${name} console: ${m.text()} ${m.location().url || ''}`);
  });
  return { context, page };
}
const report = { startedAt: new Date().toISOString(), base, browser: browser.version(), speech: Boolean(speech), micNoiseDb: process.env.NOISE_DB ?? null };
try {
  // ---- 1. Offline check with the DTLN-aec repository's sample recordings (downloaded at test time, not committed).
  const SAMPLES = 'https://raw.githubusercontent.com/breizhn/DTLN-aec/9d24e128b4f409db18227b8babb343016625921f/audio_samples/';
  const cases = { farend: '9mkQhVtzTEy2hDk-6u2Sww_farend_singletalk', nearend: 'DLhjtuwiEkS-68TsUVvW5g_nearend_singletalk', doubletalk: 'DMTgmZwtgUilp4omPK7-OQ_doubletalk' };
  const sampleDir = `${outDir}dtln-samples/`; mkdirSync(sampleDir, { recursive: true });
  const load = async name => {
    const file = `${sampleDir}${name}.wav`;
    if (!existsSync(file)) writeFileSync(file, Buffer.from(await (await fetch(`${SAMPLES}${name}.wav`)).arrayBuffer()));
    const { samples, rate } = decodeWav(readFileSync(file)); assert.equal(rate, 16000);
    return samples;
  };
  const tester = await guest('Audio tester');
  await tester.page.goto(`${base}/audio-test`);
  await tester.page.waitForFunction(() => window.audioTest);
  report.offline = {};
  for (const [label, name] of Object.entries(cases)) {
    const mic16 = await load(`${name}_mic`), ref16 = await load(`${name}_lpb`), n = Math.min(mic16.length, ref16.length);
    const mic = new Upsampler().process(mic16.subarray(0, n)), ref = new Upsampler().process(ref16.subarray(0, n));
    const result = await tester.page.evaluate(async ({ mic, ref }) => {
      const r = await window.audioTest.offline({ mic: Float32Array.from(mic), ref: Float32Array.from(ref), echo: true, noise: false });
      return { output: Array.from(r.output), stats: r.stats };
    }, { mic: Array.from(mic), ref: Array.from(ref) });
    const out16 = new Downsampler().process(Float32Array.from(result.output)), inp16 = new Downsampler().process(mic);
    const from = 16000, to = Math.min(out16.length, inp16.length) - 8000;
    const inDb = powerDb(meanSquare(inp16, from, to)), outDb = powerDb(meanSquare(out16, from, to));
    const { lag } = estimateDelay(inp16.subarray(from, to), out16.subarray(from, to), 4000);
    let dot = 0, ea = 0, eb = 0; for (let i = from + lag; i < to; i++) { const a = inp16[i - lag], b = out16[i]; dot += a * b; ea += a * a; eb += b * b; }
    report.offline[label] = { inputDb: +inDb.toFixed(1), outputDb: +outDb.toFixed(1), reductionDb: +(inDb - outDb).toFixed(1), correlation: +(dot / Math.sqrt(ea * eb)).toFixed(3), chainDelayMs: result.stats.chainDelay?.ms ?? null, aecMeanMs: +result.stats.aec.mean.toFixed(3), aecP95Ms: +result.stats.aec.p95.toFixed(3), busy: +result.stats.busyRatio.toFixed(3) };
    log(`offline ${label}:`, JSON.stringify(report.offline[label]));
  }
  // Wiring checks: far-end echo is removed, near-end speech survives (both fail if the model inputs were swapped).
  assert.ok(report.offline.farend.reductionDb > 15, 'DTLN-aec removes most far-end echo');
  assert.ok(report.offline.nearend.reductionDb < 6 && report.offline.nearend.correlation > 0.7, 'DTLN-aec keeps near-end speech');

  // DeepFilterNet3 offline: clean speech + pink noise at 5 dB SNR. Noise removed in the silent lead-in, and
  // scale-invariant SNR (SI-SNR) against the clean speech before and after, on the speech segment at 16 kHz.
  const dfInstalled = (await tester.page.request.head(`${base}/audio/models/deepfilternet3/df_bg.wasm`)).ok();
  if (dfInstalled && clean) {
    const noisy = addNoise(clean.samples, 5, ...speechRange);
    const result = await tester.page.evaluate(async ({ mic }) => {
      const r = await window.audioTest.offline({ mic: Float32Array.from(mic), echo: false, noise: true });
      return { output: Array.from(r.output), stats: r.stats };
    }, { mic: Array.from(noisy) });
    const down = x => new Downsampler().process(Float32Array.from(x));
    const c16 = down(clean.samples), n16 = down(noisy), o16 = down(result.output);
    const [from, to] = speechRange.map(v => Math.round(v / 3));
    const { lag } = estimateDelay(c16.subarray(from, to), o16.subarray(from, to), 4000);
    const siSnr = (ref, est, shift) => {
      let dot = 0, rr = 0; for (let i = from; i < to; i++) { dot += est[i + shift] * ref[i]; rr += ref[i] * ref[i]; }
      const a = dot / rr; let target = 0, error = 0;
      for (let i = from; i < to; i++) { const t = a * ref[i]; target += t * t; error += (est[i + shift] - t) ** 2; }
      return 10 * Math.log10(target / error);
    };
    const lead = [Math.round(0.5 * 16000), Math.round(2.5 * 16000)];
    report.offline.deepfilter = {
      noiseInDb: +powerDb(meanSquare(n16, ...lead)).toFixed(1), noiseOutDb: +powerDb(meanSquare(o16, ...lead)).toFixed(1),
      siSnrInDb: +siSnr(c16, n16, 0).toFixed(1), siSnrOutDb: +siSnr(c16, o16, lag).toFixed(1), lagMs: lag / 16,
      chainDelayMs: result.stats.chainDelay?.ms ?? null, nsMeanMs: +result.stats.ns.mean.toFixed(3), nsP95Ms: +result.stats.ns.p95.toFixed(3), busy: +result.stats.busyRatio.toFixed(3),
    };
    const d = report.offline.deepfilter;
    log('offline deepfilter (5 dB SNR pink noise):', JSON.stringify(d));
    assert.ok(d.noiseInDb - d.noiseOutDb > 10, 'DeepFilterNet3 removes noise between words');
    assert.ok(d.siSnrOutDb > d.siSnrInDb, 'DeepFilterNet3 improves SI-SNR');
    // Both stages together on the far-end sample.
    const mic16 = await load(`${cases.farend}_mic`), ref16 = await load(`${cases.farend}_lpb`), n = Math.min(mic16.length, ref16.length);
    const both = await tester.page.evaluate(async ({ mic, ref }) => {
      const r = await window.audioTest.offline({ mic: Float32Array.from(mic), ref: Float32Array.from(ref), echo: true, noise: true });
      return { outDb: 10 * Math.log10(r.output.slice(48000).reduce((s, v) => s + v * v, 0) / (r.output.length - 48000)), stats: r.stats };
    }, { mic: Array.from(new Upsampler().process(mic16.subarray(0, n))), ref: Array.from(new Upsampler().process(ref16.subarray(0, n))) });
    report.offline.farendBoth = { outputDb: +both.outDb.toFixed(1), chainDelayMs: both.stats.chainDelay?.ms ?? null, aecMeanMs: +both.stats.aec.mean.toFixed(3), nsMeanMs: +both.stats.ns.mean.toFixed(3), busy: +both.stats.busyRatio.toFixed(3) };
    log('offline farend, echo + noise:', JSON.stringify(report.offline.farendBoth));
  } else log(`offline deepfilter: skipped (${dfInstalled ? 'needs SPEECH_TEST_WAV' : 'DeepFilterNet3 build not installed'})`);

  // ---- 2. Live switching in a two-participant call.
  const room = await createTestRoom(browser, base, `audio-${Date.now()}`);
  const alice = await guest('Alice'), bob = await guest('Bob');
  for (const [p, synthetic] of [[alice, false], [bob, true]]) {
    await p.page.goto(`${base}/?${synthetic ? 'synthetic=1&' : ''}${room.query}${room.fragment}`);
    await join(p.page);
  }
  await bob.page.waitForFunction(() => [...window.lab.consumers.values()].some(c => c.kind === 'audio' && c.appData.source === 'microphone'));
  const bobConsumer = await bob.page.evaluate(() => [...window.lab.consumers.values()].find(c => c.kind === 'audio').id);
  const received = () => bob.page.evaluate(async () => {
    const c = [...window.lab.consumers.values()].find(x => x.kind === 'audio' && x.appData.source === 'microphone');
    const r = [...(await c.getStats()).values()].find(x => x.type === 'inbound-rtp');
    return { bytes: r?.bytesReceived || 0, energy: r?.totalAudioEnergy || 0, id: c.id };
  });
  const flowing = async label => {
    const a = await received(); await bob.page.waitForTimeout(2500); const b = await received();
    assert.equal(b.id, bobConsumer, `${label}: Bob still uses the same consumer`);
    assert.ok(b.bytes > a.bytes + 2000, `${label}: Bob keeps receiving Alice's audio`);
    assert.ok(b.energy > a.energy, `${label}: received audio is not silent`);
    return { bytesPerSecond: Math.round((b.bytes - a.bytes) / 2.5), energyDelta: +(b.energy - a.energy).toFixed(6) };
  };
  const micTrack = () => alice.page.evaluate(() => { const p = window.lab.producers.find(x => x.appData.source === 'microphone'); return { id: p.track?.id, state: p.track?.readyState, producer: p.id }; });
  const readout = () => alice.page.evaluate(() => ({ active: document.querySelector('#audioActive').textContent, settings: document.querySelector('#audioSettings').textContent, error: document.querySelector('#audioError').textContent, stats: document.querySelector('#audioStats').textContent }));
  const choose = async ({ mode, echo, noise }) => {
    const box = async (id, on) => { if ((await alice.page.locator(id).isChecked()) !== on) await alice.page.locator(id).click(); await alice.page.waitForFunction(() => !document.querySelector('#audioEcho').disabled, null, { timeout: 60000 }); };
    if (echo !== undefined) await box('#audioEcho', echo);
    if (noise !== undefined) await box('#audioNoise', noise);
    if (mode) await alice.page.locator(`input[name="audioMode"][value="${mode}"]`).check();
    await alice.page.waitForFunction(() => !document.querySelector('#audioEcho').disabled && !document.querySelector('#audioActive').textContent.startsWith('Switching'), null, { timeout: 60000 });
    return readout();
  };
  report.live = [];
  const step = async (label, wanted, expect) => {
    const before = await micTrack(), r = await choose(wanted), after = await micTrack();
    assert.match(r.active, expect.active, `${label}: active mode`);
    if (expect.settings) assert.match(r.settings, expect.settings, `${label}: reported settings`);
    if (expect.error) assert.match(r.error, expect.error, `${label}: error shown`); else assert.equal(r.error, '', `${label}: no error`);
    assert.equal(after.producer, before.producer, `${label}: same producer`);
    assert.equal(after.state, 'live', `${label}: published track is live`);
    if (expect.newTrack !== false) assert.notEqual(after.id, before.id, `${label}: track replaced`);
    if (expect.stats) await alice.page.waitForFunction(re => new RegExp(re).test(document.querySelector('#audioStats').textContent), expect.stats.source, { timeout: 20000 });
    const flow = await flowing(label), final = await readout();
    report.live.push({ step: label, active: final.active, settings: final.settings, stats: final.stats, error: final.error, ...flow });
    log(`live ${label}: ${final.active} | ${final.settings}${final.stats ? ` | ${final.stats}` : ''}${final.error ? ` | ERROR SHOWN: ${final.error}` : ''}`);
  };
  await step('initial Browser', {}, { active: /Browser \(built-in\) · echo cancellation on · noise suppression on/, settings: /echoCancellation true · noiseSuppression true · autoGainControl true/, newTrack: false });
  await step('Off', { mode: 'off' }, { active: /^Active: Off \(raw\)$/, settings: /echoCancellation false · noiseSuppression false · autoGainControl false/ });
  if (!dfInstalled) await step('Ours with noise suppression (DeepFilterNet3 build missing)', { mode: 'ours' }, { active: /^Active: Off \(raw\)$/, error: /Could not switch to Ours.*DeepFilterNet3 web build.*Still using Off/, newTrack: false });
  await step('Ours, echo only', { mode: 'ours', echo: true, noise: false }, { active: /Ours \(DTLN-aec 128 \+ DeepFilterNet3\) · echo cancellation on · noise suppression off/, settings: /input to Ours\) reports: echoCancellation false · noiseSuppression false · autoGainControl false/, stats: /Echo canceller: [\d.]+ ms per 8 ms block/ });
  if (dfInstalled) await step('Ours, echo and noise', { noise: true }, { active: /echo cancellation on · noise suppression on/, stats: /Noise suppression: [\d.]+ ms per 10 ms frame/ });
  await step('Ours, both stages off', { echo: false, noise: false }, { active: /Ours .* echo cancellation off · noise suppression off/, settings: /echoCancellation false/ });
  await step('Browser, echo and noise off', { mode: 'browser' }, { active: /Browser \(built-in\) · echo cancellation off · noise suppression off/, settings: /echoCancellation false · noiseSuppression false · autoGainControl true/ });
  // Mute, switch while muted, unmute: the new track must follow the producer's paused state.
  await alice.page.locator('#mic').click(); await alice.page.waitForFunction(() => document.querySelector('#mic').textContent === 'Unmute microphone');
  await choose({ echo: true, noise: true });
  assert.equal(await alice.page.evaluate(() => window.lab.producers.find(p => p.appData.source === 'microphone').track.enabled), false, 'muted after switching');
  await alice.page.locator('#mic').click(); await alice.page.waitForFunction(() => document.querySelector('#mic').textContent === 'Mute microphone');
  await step('Browser, all on (after mute/unmute)', {}, { active: /Browser \(built-in\) · echo cancellation on · noise suppression on/, settings: /echoCancellation true · noiseSuppression true · autoGainControl true/, newTrack: false });
  assert.deepEqual(JSON.parse(await alice.page.evaluate(() => localStorage.getItem('audio-processing'))), { mode: 'browser', echo: true, noise: true });
  report.events = await alice.page.evaluate(() => window.lab.events.filter(e => e.type.startsWith('audioProcessing')).map(e => `${e.type}:${e.mode}`));
  log(`audio events: ${report.events.join(', ')}`);
  // Persisted choice is applied at the next join.
  await choose({ mode: 'off' });
  const roomUrl = alice.page.url();
  await alice.page.locator('#leave').click(); await alice.page.waitForURL(`${base}/`);
  await alice.page.goto(roomUrl); await join(alice.page);
  assert.match((await readout()).active, /^Active: Off \(raw\)$/, 'saved mode used at join');
  await bob.page.waitForFunction(() => [...window.lab.consumers.values()].some(c => c.kind === 'audio' && c.appData.source === 'microphone'));
  for (const p of [alice, bob]) assert.deepEqual(await p.page.evaluate(() => window.lab.errors), []);

  // ---- 3. Test page: one take per mode, recognition check and echo test.
  const t = tester.page;
  await t.locator('#noiseSwitch').uncheck(); // Ours with echo cancellation only unless the DeepFilterNet3 build is installed
  if (dfInstalled) await t.locator('#noiseSwitch').check();
  for (const mode of ['off', 'browser', 'ours']) {
    await t.locator(`[data-record="${mode}"]`).click();
    await t.waitForFunction(() => !document.querySelector('#echoRun').disabled, null, { timeout: 90000 });
    assert.equal(await t.locator('#error').textContent(), '', `test page ${mode}: no error`);
  }
  await t.locator('#werRun').click();
  await t.waitForFunction(() => !document.querySelector('#echoRun').disabled, null, { timeout: 300000 });
  await t.locator('#echoRun').click();
  await t.waitForFunction(() => !document.querySelector('#echoRun').disabled, null, { timeout: 120000 });
  // The fake microphone is a file, so no played sound can reach it: the echo test must say its result is not valid.
  assert.match(await t.locator('#echoStatus').textContent(), /did not pick up the played clip/);
  report.testPage = await t.evaluate(() => ({
    table: [...document.querySelectorAll('#results tr')].map(tr => [...tr.children].map(c => c.textContent)),
    recognition: document.querySelector('#werStatus').textContent, echo: document.querySelector('#echoStatus').textContent, error: document.querySelector('#error').textContent,
  }));
  for (const row of report.testPage.table) log(`table | ${row.join(' | ')}`);
  log(`recognition status: ${report.testPage.recognition}`); log(`echo status: ${report.testPage.echo}`);
  assert.equal(report.testPage.error, '');
  assert.deepEqual(errors, []);
  writeFileSync(`${outDir}audio-processing-${Date.now()}.json`, JSON.stringify(report, null, 2));
  log('PASS: offline DTLN-aec sample check, live Off/Browser/Ours switching without dropping the two-participant call, getSettings() read-back after every switch, failed switch keeps the previous mode, mute across switches, saved mode at rejoin, test page takes, recognition check and echo test.');
} finally { await browser.close(); }
