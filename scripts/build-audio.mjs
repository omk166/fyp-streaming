// Builds the audio processing bundles and copies the LiteRT.js runtime into public/audio/.
// Run by `npm run build`. Model files are fetched separately with `npm run audio:models`.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}public/audio/`;
mkdirSync(`${out}vendor/litert`, { recursive: true });

await Promise.all([
  // Classic worker script: LiteRT.js loads its wasm glue with importScripts().
  build({ entryPoints: [`${root}client/audio/worker.js`], bundle: true, format: 'iife', platform: 'browser', outfile: `${out}ours-worker.js`, logLevel: 'warning' }),
  build({ entryPoints: [`${root}client/audio/worklet.js`], bundle: true, format: 'iife', platform: 'browser', outfile: `${out}ours-worklet.js`, logLevel: 'warning' }),
  build({ entryPoints: [`${root}client/audio-test/main.js`], bundle: true, format: 'esm', platform: 'browser', outfile: `${root}public/audio-test.js`, logLevel: 'warning' }),
  build({ entryPoints: [`${root}client/audio-test/recorder-worklet.js`], bundle: true, format: 'iife', platform: 'browser', outfile: `${out}recorder-worklet.js`, logLevel: 'warning' }),
]);

// LiteRT.js picks the relaxed-SIMD build when available and the "compat" build otherwise.
const wasmDir = `${root}node_modules/@litertjs/core/wasm/`;
if (!existsSync(wasmDir)) throw Error('node_modules/@litertjs/core is missing: run npm ci');
for (const name of ['litert_wasm_internal', 'litert_wasm_compat_internal'])
  for (const ext of ['.js', '.wasm']) copyFileSync(`${wasmDir}${name}${ext}`, `${out}vendor/litert/${name}${ext}`);
writeFileSync(`${out}vendor/litert/NOTICE.txt`, 'LiteRT.js (@litertjs/core 2.6.0), Copyright Google LLC.\nLicensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0\nSource: https://github.com/google-ai-edge/LiteRT/tree/main/litert/js\n');
console.log('Audio bundles built; LiteRT.js runtime copied to public/audio/vendor/litert/.');
