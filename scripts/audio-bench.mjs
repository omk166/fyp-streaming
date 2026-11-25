// Noise suppression benchmark: the same noisy recordings go through Off, Browser (Chrome's built-in processing,
// with and without its automatic gain control) and Ours, each captured live through Chrome's fake microphone on the /audio-test page, then scored against the
// clean speech by scripts/audio_bench_score.py (PESQ, STOI, SI-SDR, DNSMOS, noise reduction).
//
//   npm run audio:bench:install                         once: Python scoring tools into .venv-bench/
//   BASE_URL=http://127.0.0.1:3000 npm run audio:bench  server running, models installed (npm run audio:models)
//
// Options (environment):
//   BENCH_SNRS=0,5,10,20                speech-to-noise ratios in dB
//   BENCH_NOISES=pink,babble,keyboard,fan   generated noise types (any subset; empty for none)
//   BENCH_NOISE_DIR=<folder>            extra noise: every .wav in it (48 kHz) becomes a noise type, e.g. your own recordings
//   BENCH_VOICES=Samantha,Daniel        macOS voices that speak the test script (needs `say`)
//   BENCH_SPEECH_DIR=<folder>           use these clean speech recordings (48 kHz .wav) instead of `say`
//   BENCH_ECHO=1, BENCH_NOISE=1         the two switches for Browser and Ours (default both on, as in a meeting)
//   BENCH_MODES=off,browser,browser-noagc,ours   modes to capture; browser-noagc is Browser with automatic gain
//                                       control off, which measures Chrome's noise suppression on its own
//   BROWSER_CHANNEL=chrome|msedge, HEADED=1
// Everything goes to data/audio-bench/<time>/ (ignored by git). Nothing is uploaded anywhere.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeWav, encodeWav, meanSquare } from '../client/audio/dsp.js';
import { pinkNoise, normalize } from '../client/audio-test/signals.js';
import { SCRIPT } from '../client/audio-test/script.js';
import { timingSlip } from './audio-bench-timing.mjs';

const env = process.env, root = fileURLToPath(new URL('..', import.meta.url));
const base = env.BASE_URL || 'http://127.0.0.1:3100';
// PRE: noise-only pre-roll that is captured but not scored. Chrome restarts the fake microphone file whenever a
// capture opens and loops it with a small jump at the seam, so the scored part [PRE, end) must sit in one pass.
const RATE = 48000, PRE = 2.5, LEAD = 2, TAIL = 1, SPEECH_DB = -26;
const list = (value, fallback) => (value ?? fallback).split(',').map(v => v.trim()).filter(Boolean);
// Bench mode -> capture options on the page. browser-noagc: Browser as in a meeting, but automatic gain control off.
const CAPTURE = { off: { mode: 'off' }, browser: { mode: 'browser' }, 'browser-noagc': { mode: 'browser', agc: false }, ours: { mode: 'ours' } };
const MODES = list(env.BENCH_MODES, Object.keys(CAPTURE).join(','));
for (const m of MODES) assert(CAPTURE[m], `unknown mode "${m}" in BENCH_MODES (use ${Object.keys(CAPTURE).join(', ')})`);
const snrs = list(env.BENCH_SNRS, '0,5,10,20').map(Number);
const switches = { echo: env.BENCH_ECHO !== '0', noise: env.BENCH_NOISE !== '0' };
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const run = `${root}data/audio-bench/${stamp}/`;
for (const dir of ['clean', 'noise', 'noisy', ...MODES.map(m => `out/${m}`)]) mkdirSync(`${run}${dir}`, { recursive: true });
const log = (...a) => console.log(...a);

// ---- Seeded random numbers so every run and every machine generates the same noise.
function random(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const read48k = file => {
  const { samples, rate } = decodeWav(readFileSync(file));
  if (rate !== RATE) throw Error(`${file} is ${rate} Hz; convert it first: afconvert -f WAVE -d LEI16@48000 -c 1 in.wav out.wav`);
  return samples;
};
function say(voice, text, file) {
  execFileSync('say', ['-v', voice, '-o', file, '--data-format=LEI16@48000', text]);
  return read48k(file);
}
// Level of the active speech (20 ms frames within 40 dB of the loudest), a simple stand-in for ITU-T P.56.
function activePower(x) {
  const size = RATE / 50, powers = [];
  for (let i = 0; i + size <= x.length; i += size) powers.push(meanSquare(x, i, i + size));
  const top = Math.max(...powers), active = powers.filter(p => p > top * 1e-4);
  return active.reduce((a, b) => a + b, 0) / active.length;
}
const scaleTo = (x, db) => { const g = Math.sqrt(10 ** (db / 10) / activePower(x)); return x.map(v => v * g); };
function loopTo(x, n, offset = 0) { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = x[(i + offset) % x.length]; return out; }

// ---- Generated noise types (no third-party recordings, no licences to check).
const BABBLE = [
  ['Karen', 'We moved the review to Thursday afternoon, because half of the team is travelling on Wednesday and the room upstairs is already booked for the training session.'],
  ['Moira', 'If you take the second left after the bridge, the bakery is on the corner, and they still sell the bread with seeds that you liked so much last summer.'],
  ['Tessa', 'The battery lasted most of the day, but the screen was hard to read outside in the sun, so I ended up going back to the older model after a week.'],
  ['Rishi', 'Could you send me the spreadsheet again, the one with the totals for each region, since the copy I have stops at the end of March and nothing after that.'],
  ['Fred', 'The match was delayed by rain for almost an hour, and when it started again the visiting side scored twice before anyone had even found their seats.'],
  ['Ralph', 'Remember to water the tomatoes in the evening and not at noon, otherwise the leaves burn, and check the hose because it leaked all over the path last time.'],
];
function babble(n) {
  const out = new Float32Array(n), rnd = random(5);
  let talkers = 0;
  for (const [voice, text] of BABBLE) {
    let talk;
    try { talk = say(voice, text, `${run}noise/babble-${voice}.wav`); } catch { log(`babble: voice ${voice} not installed, skipped`); continue; }
    talk = scaleTo(talk, -30); talkers++;
    const offset = Math.floor(rnd() * talk.length);
    for (let i = 0; i < n; i++) out[i] += talk[(i + offset) % talk.length];
  }
  assert.ok(talkers >= 3, 'babble needs at least three installed macOS voices (Karen, Moira, Tessa, Rishi, Fred, Ralph)');
  return out;
}
// Typing: short resonant clicks for key press and release, in bursts with pauses, over a faint room floor.
function keyboard(n) {
  const out = new Float32Array(n), rnd = random(17);
  for (let i = 0; i < n; i++) out[i] = (rnd() * 2 - 1) * 0.0005;
  const click = (at, gain, freq) => {
    const decay = RATE * (0.002 + rnd() * 0.003), length = Math.round(decay * 6), w = 2 * Math.PI * freq / RATE;
    for (let j = 0; j < length && at + j < n; j++) out[at + j] += gain * Math.exp(-j / decay) * ((rnd() * 2 - 1) * 0.6 + Math.sin(w * j) * 0.4);
  };
  let t = Math.round(0.1 * RATE);
  while (t < n) {
    const burst = 4 + Math.floor(rnd() * 12);
    for (let k = 0; k < burst && t < n; k++) {
      const gain = 0.3 + rnd() * 0.7, freq = 1800 + rnd() * 2500;
      click(t, gain, freq); click(t + Math.round((0.06 + rnd() * 0.05) * RATE), gain * 0.4, freq * 0.8);
      t += Math.round((0.09 + rnd() * 0.16) * RATE);
    }
    t += Math.round((0.3 + rnd() * 1.2) * RATE);
  }
  return out;
}
// Fan or air conditioning: low-pass broadband rumble plus a slowly wavering blade tone and its harmonics.
function fan(n) {
  const pink = pinkNoise(RATE, n / RATE, -30, 23), out = new Float32Array(n);
  let a = 0, b = 0;
  const k = 1 - Math.exp(-2 * Math.PI * 900 / RATE);
  for (let i = 0; i < n; i++) {
    a += k * (pink[i] - a); b += k * (a - b);
    const t = i / RATE, wobble = 1 + 0.15 * Math.sin(2 * Math.PI * 0.3 * t);
    out[i] = b + 0.004 * wobble * (Math.sin(2 * Math.PI * 118 * t) + 0.5 * Math.sin(2 * Math.PI * 236 * t + 1) + 0.25 * Math.sin(2 * Math.PI * 354 * t + 2));
  }
  return out;
}
const GENERATED = { pink: n => pinkNoise(RATE, n / RATE, -30, 11), babble, keyboard, fan };

// ---- Clean speech: the script spoken by macOS voices, or the tester's own recordings.
const speech = [];
if (env.BENCH_SPEECH_DIR) {
  for (const name of readdirSync(env.BENCH_SPEECH_DIR).filter(f => f.toLowerCase().endsWith('.wav')).sort())
    speech.push({ id: name.replace(/\.wav$/i, '').replace(/[^\w-]+/g, '_'), samples: read48k(`${env.BENCH_SPEECH_DIR}/${name}`) });
  assert.ok(speech.length, `no .wav files in ${env.BENCH_SPEECH_DIR}`);
} else {
  for (const voice of list(env.BENCH_VOICES, 'Samantha,Daniel')) speech.push({ id: voice.replace(/[^\w-]+/g, '_'), samples: say(voice, SCRIPT, `${run}clean/say-${voice.replace(/[^\w-]+/g, '_')}.wav`) });
}
const longest = Math.max(...speech.map(s => s.samples.length)) + (PRE + LEAD + TAIL) * RATE;
const noises = [];
for (const name of list(env.BENCH_NOISES, 'pink,babble,keyboard,fan')) {
  assert.ok(GENERATED[name], `unknown noise type ${name} (generated types: ${Object.keys(GENERATED).join(', ')})`);
  noises.push({ id: name, samples: GENERATED[name](longest + RATE) });
}
if (env.BENCH_NOISE_DIR) for (const name of readdirSync(env.BENCH_NOISE_DIR).filter(f => f.toLowerCase().endsWith('.wav')).sort())
  noises.push({ id: name.replace(/\.wav$/i, '').replace(/[^\w-]+/g, '_'), samples: read48k(`${env.BENCH_NOISE_DIR}/${name}`) });
assert.ok(noises.length, 'no noise types selected');
for (const n of noises) writeFileSync(`${run}noise/${n.id}.wav`, encodeWav(normalize(Float32Array.from(n.samples.subarray(0, Math.min(n.samples.length, 20 * RATE))), -26), RATE));

// ---- Mixtures: [PRE + LEAD s noise only][speech + noise][TAIL s noise only], speech at -26 dBFS active level,
// noise scaled to the requested SNR against that level.
const conditions = [];
for (const s of speech) {
  const clean = new Float32Array(s.samples.length + (PRE + LEAD + TAIL) * RATE);
  clean.set(scaleTo(s.samples, SPEECH_DB), (PRE + LEAD) * RATE);
  const cleanFile = `${run}clean/${s.id}.wav`; writeFileSync(cleanFile, encodeWav(clean, RATE));
  for (const noise of noises) for (const snr of snrs) {
    const id = `${s.id}__${noise.id}__${snr}dB`;
    const nz = loopTo(noise.samples, clean.length, Math.floor(random(31)() * noise.samples.length));
    const gain = Math.sqrt(activePower(clean) / meanSquare(nz) / 10 ** (snr / 10));
    let noisy = clean.map((v, i) => v + gain * nz[i]), scale = 1;
    const peak = noisy.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (peak > 0.95) { scale = 0.95 / peak; noisy = noisy.map(v => v * scale); }
    const noisyFile = `${run}noisy/${id}.wav`; writeFileSync(noisyFile, encodeWav(noisy, RATE));
    const cleanScaled = scale === 1 ? cleanFile : `${run}clean/${id}.wav`;
    if (scale !== 1) writeFileSync(cleanScaled, encodeWav(clean.map(v => v * scale), RATE));
    conditions.push({ id, speech: s.id, noise: noise.id, snr, clean: cleanScaled, noisy: noisyFile, samples: clean.length, outputs: {}, capture: {} });
  }
}
log(`${conditions.length} conditions (${speech.length} speech × ${noises.length} noise × ${snrs.length} SNR), ${MODES.length} modes each, about ${Math.round(conditions.length * (MODES.length * (longest / RATE + 1.5) + 6) / 60)} min. Output: ${run}`);

// ---- Live capture: one browser per mixture, since the fake microphone file is a launch option.
async function guestPage(browser) {
  const context = await browser.newContext();
  await context.grantPermissions(['microphone'], { origin: base });
  const entry = await context.request.post(`${base}/api/auth/guest`, { headers: { Origin: new URL(base).origin }, data: { name: 'Audio bench' } });
  assert.equal(entry.status(), 201, `guest sign-in at ${base} failed (is the server running?)`);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/audio-test`);
  await page.waitForFunction(() => window.audioTest?.capture, null, { timeout: 30000 });
  return { page, errors };
}
// speechText: what the speech says (the test script when macOS voices read it; unknown for your own recordings).
const manifest = { startedAt: new Date().toISOString(), base, rate: RATE, preroll: PRE, lead: LEAD, tail: TAIL, speechDb: SPEECH_DB, switches, modes: MODES,
  speechText: env.BENCH_SPEECH_DIR ? null : SCRIPT, conditions };
let browserVersion = null;
for (const [index, c] of conditions.entries()) {
  const browser = await chromium.launch({ headless: env.HEADED !== '1', channel: env.BROWSER_CHANNEL || 'chrome', args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    `--use-file-for-fake-audio-capture=${c.noisy}`,
  ] });
  browserVersion ??= browser.version();
  try {
    const { page, errors } = await guestPage(browser);
    const input = read48k(c.noisy);
    for (const mode of MODES) {
      const seconds = c.samples / RATE + 0.5;
      // A capture whose delay moves partway through (Chrome skipping audio, or an underrun in Ours's playout) is a
      // machine hiccup, not the processing, but would make STOI and SDR read far too low: capture it again (twice at most).
      let r, bytes, timing, tries = 0;
      do {
        r = await page.evaluate(args => window.audioTest.capture(args), { ...CAPTURE[mode], seconds, ...switches });
        bytes = Buffer.from(r.wav, 'base64'); timing = timingSlip(input, decodeWav(bytes).samples, PRE); tries++;
      } while (timing.slipMs > 1 && tries < 3);
      const file = `${run}out/${mode}/${c.id}.wav`; writeFileSync(file, bytes);
      const w = r.stats?.worklet;
      c.outputs[mode] = file;
      c.capture[mode] = { settings: r.settings, notes: r.notes, underruns: w?.underruns ?? null, droppedMs: w?.droppedMs ?? null,
        slipMs: timing.slipMs, timingSegments: timing.segments, retries: tries - 1 };
    }
    assert.deepEqual(errors, [], `page errors in ${c.id}`);
    const retried = MODES.filter(m => c.capture[m].retries).map(m => `${m} ×${c.capture[m].retries}`);
    log(`[${index + 1}/${conditions.length}] ${c.id}: captured ${MODES.join(', ')}${retried.length ? ` (recaptured after a timing slip: ${retried.join(', ')})` : ''}${c.capture.ours?.droppedMs ? ` (Ours dropped ${Math.round(c.capture.ours.droppedMs)} ms)` : ''}`);
  } finally { await browser.close(); }
}
manifest.browser = browserVersion; manifest.finishedAt = new Date().toISOString();
writeFileSync(`${run}manifest.json`, JSON.stringify(manifest, null, 2));

// ---- Scoring (Python: PESQ, STOI and DNSMOS have reference implementations there).
const python = `${root}.venv-bench/bin/python`;
if (!existsSync(python)) { log(`Captured. Scoring tools missing: run "npm run audio:bench:install", then:\n  .venv-bench/bin/python scripts/audio_bench_score.py "${run}"`); process.exit(0); }
const scored = spawnSync(python, [`${root}scripts/audio_bench_score.py`, run], { stdio: 'inherit' });
process.exit(scored.status ?? 1);
