// Call benchmark, step 1: one long recording of a noise benchmark run's test clips (the noisy speech files), to play
// into a meeting app's microphone (Zoom, Meet, Teams, or this app). The audio that arrives at the other end of the
// call is recorded on /call-bench (or by scripts/call-bench-ours.mjs for this app) and scored by
// scripts/call_bench_score.py against the clean speech.
//
//   npm run call:bench:make                               clips of the newest noise benchmark run (npm run audio:bench)
//   npm run call:bench:make -- data/audio-bench/<run>     clips of that run
//
// Options (environment): CALL_VOICES, CALL_NOISES, CALL_SNRS pick a subset, e.g. CALL_SNRS=0,10 for a shorter test.
// Writes data/call-bench/<time>/playlist.wav (48 kHz mono 16-bit) and playlist.json (where each clip starts).
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { decodeWav, encodeWav } from '../client/audio/dsp.js';
import { SCRIPT } from '../client/audio-test/script.js';

const env = process.env, root = fileURLToPath(new URL('..', import.meta.url));
// HEAD: silence before the first clip. GAP: silence after each clip (the apps settle on each clip's own noise lead-in).
// TAIL: silence at the end, so the last clip's delayed output is still recorded.
const RATE = 48000, HEAD = 3, GAP = 1.5, TAIL = 4;
const list = value => value ? value.split(',').map(v => v.trim()).filter(Boolean) : null;

const benchRoot = `${root}data/audio-bench`;
const runs = existsSync(benchRoot) ? readdirSync(benchRoot).filter(d => existsSync(`${benchRoot}/${d}/manifest.json`)).sort() : [];
const run = resolve(process.argv[2] || (runs.length ? `${benchRoot}/${runs.at(-1)}` : ''));
if (!existsSync(`${run}/manifest.json`)) {
  console.error('No noise benchmark run found. Run "npm run audio:bench" first, or pass a run folder: npm run call:bench:make -- data/audio-bench/<run>');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(`${run}/manifest.json`, 'utf8'));
const voices = list(env.CALL_VOICES), noises = list(env.CALL_NOISES), snrs = list(env.CALL_SNRS)?.map(Number);
const conditions = manifest.conditions.filter(c => (!voices || voices.includes(c.speech)) && (!noises || noises.includes(c.noise)) && (!snrs || snrs.includes(c.snr)));
if (!conditions.length) { console.error('No clips match CALL_VOICES / CALL_NOISES / CALL_SNRS.'); process.exit(1); }

const read48k = file => {
  const { samples, rate } = decodeWav(readFileSync(file));
  if (rate !== RATE) throw Error(`${file} is ${rate} Hz, expected ${RATE}`);
  return samples;
};
const clips = [];
let position = HEAD * RATE;
for (const c of conditions) {
  const noisy = read48k(c.noisy);
  clips.push({ id: c.id, speech: c.speech, noise: c.noise, snr: c.snr, start: position, samples: noisy.length,
    clean: relative(root, c.clean), noisy: relative(root, c.noisy), audio: noisy });
  position += noisy.length + GAP * RATE;
}
const total = position - GAP * RATE + TAIL * RATE, playlist = new Float32Array(total);
for (const clip of clips) playlist.set(clip.audio, clip.start);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = `${root}data/call-bench/${stamp}/`;
mkdirSync(out, { recursive: true });
writeFileSync(`${out}playlist.wav`, encodeWav(playlist, RATE));
// speechText: what the voices say, for the word error rate (older benchmark runs always used the test script).
const speechText = 'speechText' in manifest ? manifest.speechText : SCRIPT;
writeFileSync(`${out}playlist.json`, JSON.stringify({
  createdAt: new Date().toISOString(), source: relative(root, run), rate: RATE, head: HEAD, gap: GAP, tail: TAIL,
  preroll: manifest.preroll, lead: manifest.lead, speechText, samples: total, seconds: total / RATE,
  clips: clips.map(({ audio, ...clip }) => clip),
}, null, 2));
const minutes = Math.floor(total / RATE / 60), seconds = Math.round(total / RATE % 60);
console.log(`${clips.length} clips from ${relative(root, run)}, ${minutes} min ${seconds} s.\nPlaylist: ${relative(root, out)}/playlist.wav\n` +
  `Next: play it into the app on /call-bench (see the README, "Call benchmark"), or run npm run call:bench:ours for this app.`);
