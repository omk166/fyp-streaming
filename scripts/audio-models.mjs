// Downloads the model files used by the "Ours" audio mode into public/audio/models/ and verifies them.
//
//   npm run audio:models          official model weights + the prebuilt libDF wasm from @workadventure/noise-suppression
//                                 0.2.0 (third-party build; the package.json script passes --deepfilter-wasm=workadventure)
//   node scripts/audio-models.mjs                           official model weights only
//   node scripts/audio-models.mjs --deepfilter-wasm=PATH    install a libDF wasm you built yourself (df_bg.wasm)
// When the flag is given more than once, the last one wins.
//
// Every download is pinned to a commit or version and checked against a SHA-256 / npm integrity value.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = `${root}public/audio/models/`;
const DTLN = 'https://raw.githubusercontent.com/breizhn/DTLN-aec/9d24e128b4f409db18227b8babb343016625921f/';
const DFN = 'https://raw.githubusercontent.com/Rikorose/DeepFilterNet/7b14b895fe7fc42cab72b4a4c1e49c982bd6404b/';
const files = [
  { url: `${DTLN}pretrained_models/dtln_aec_128_1.tflite`, path: 'dtln_aec_128_1.tflite', sha256: '8d241b3a732af8ca140b2e30043e56a6c3c7800c46e22c26f4eea2f70974ad1e' },
  { url: `${DTLN}pretrained_models/dtln_aec_128_2.tflite`, path: 'dtln_aec_128_2.tflite', sha256: '350bb01a1152ae3cabe09fe5e868ef2f7d8b988a9f22aae44f140195f6493126' },
  { url: `${DTLN}LICENSE`, path: 'LICENSES/DTLN-aec-LICENSE.txt' },
  { url: `${DFN}models/DeepFilterNet3_onnx.tar.gz`, path: 'deepfilternet3/DeepFilterNet3_onnx.tar.gz', sha256: 'c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616' },
  { url: `${DFN}LICENSE-MIT`, path: 'LICENSES/DeepFilterNet-LICENSE-MIT.txt' },
  { url: `${DFN}LICENSE-APACHE`, path: 'LICENSES/DeepFilterNet-LICENSE-APACHE.txt' },
];
const WA = {
  tarball: 'https://registry.npmjs.org/@workadventure/noise-suppression/-/noise-suppression-0.2.0.tgz',
  integrity: 'sha512-lNHmmOiMnWaLWK6hKBsYi/dC/L7lFspYMitWAhk2SXS7QFgHtizeT+4hTDvFDd3MHW+cvSb+Y4nhtQs7xQ5hrw==',
  member: 'package/dist/assets/deepfilternet/df_bg.wasm',
  sha256: '8ebf2b217b80fc128505b993c8d7d7d892df5a845ab7a2516fed74b76e7fe708',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) { if (attempt >= 3) throw Error(`${url}: ${error.message}`); }
  }
}
function save(path, bytes) {
  mkdirSync(`${dir}${path}`.replace(/[^/]+$/, ''), { recursive: true });
  writeFileSync(`${dir}${path}`, bytes);
}
// Only the API exported by libDF/src/wasm.rs is accepted. Compiling reads the module; it runs nothing.
function checkLibDf(bytes) {
  const exportsOf = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map(e => e.name);
  for (const name of ['df_create', 'df_get_frame_length', 'df_process_frame']) if (!exportsOf.includes(name)) throw Error(`not a libDF wasm build: export ${name} is missing`);
}
function untar(tgz, member) {
  const tar = gunzipSync(tgz);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.toString('utf8', offset + 124, offset + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    if (name === member) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw Error(`${member} not found in the package`);
}

let failed = false;
for (const file of files) {
  const target = `${dir}${file.path}`;
  if (existsSync(target) && (!file.sha256 || sha256(readFileSync(target)) === file.sha256)) { console.log(`ok       ${file.path}`); continue; }
  try {
    const bytes = await download(file.url);
    if (file.sha256 && sha256(bytes) !== file.sha256) throw Error(`checksum mismatch for ${file.url}`);
    save(file.path, bytes); console.log(`saved    ${file.path}`);
  } catch (error) { failed = true; console.error(`FAILED   ${file.path}: ${error.message}`); }
}

const option = process.argv.filter(a => a.startsWith('--deepfilter-wasm=')).at(-1)?.split('=').slice(1).join('=');
const wasmTarget = 'deepfilternet3/df_bg.wasm';
const installed = existsSync(`${dir}${wasmTarget}`) ? sha256(readFileSync(`${dir}${wasmTarget}`)) : null;
if (option === 'workadventure' && installed === WA.sha256) console.log(`ok       ${wasmTarget} (@workadventure/noise-suppression@0.2.0)`);
else if (option) {
  try {
    let bytes, source;
    if (option === 'workadventure') {
      const tgz = await download(WA.tarball);
      const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
      if (integrity !== WA.integrity) throw Error('npm tarball integrity mismatch');
      bytes = untar(tgz, WA.member);
      if (sha256(bytes) !== WA.sha256) throw Error('df_bg.wasm checksum mismatch');
      source = `@workadventure/noise-suppression@0.2.0 (${WA.member}); libDF from DeepFilterNet d375b2d with WorkAdventure's tract-0.23 patch`;
    } else {
      bytes = readFileSync(option); source = `local build ${option} (sha256 ${sha256(bytes)})`;
    }
    checkLibDf(bytes);
    save(wasmTarget, bytes);
    save('deepfilternet3/SOURCE.txt', `${source}\nInstalled ${new Date().toISOString()}\n`);
    console.log(`saved    ${wasmTarget} from ${source}`);
  } catch (error) { failed = true; console.error(`FAILED   ${wasmTarget}: ${error.message}`); }
} else if (!existsSync(`${dir}${wasmTarget}`)) {
  console.log(`missing  ${wasmTarget}: no DeepFilterNet3 web build installed. Ours runs echo cancellation only; with noise`);
  console.log('         suppression on it reports that the build is missing. See README "Audio processing" for the two ways to add it.');
}
if (failed) { console.error('Some audio model files could not be installed; Ours will report them as missing.'); process.exitCode = 1; }
