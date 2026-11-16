// Dedicated Worker hosting the "Ours" models. Bundled as a classic script (public/audio/ours-worker.js)
// because LiteRT.js loads its WebAssembly glue with importScripts().
// Live audio arrives from the AudioWorklet over a MessagePort in 128-sample render quanta at 48 kHz and
// goes back the same way; the test page can also send whole buffers for offline processing.
import * as litert from '@litertjs/core';
import { DtlnAec, createLiteRtModels } from './dtln-aec.js';
import { createDeepFilter } from './deepfilter.js';
import { OursEngine } from './engine.js';

let models = null, dfModule = null, dfModel = null, engine = null, config = null, queue = Promise.resolve(), pending = 0;

async function fetchBytes(url, what, hint = 'Run "npm run audio:models" on the server') {
  let response;
  try {
    response = await fetch(url, { cache: 'force-cache' });
    // force-cache also returns a cached error, e.g. a 404 from before "npm run audio:models" ran; ask the server again.
    if (!response.ok) response = await fetch(url, { cache: 'reload' });
  } catch (error) { throw Error(`${what} could not be downloaded (${error.message})`); }
  if (!response.ok) throw Error(`${what} is missing on this server (${new URL(url, self.location.href).pathname}, HTTP ${response.status}). ${hint}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function load({ echo, noise }, assets) {
  const started = performance.now(), info = { stages: [] };
  if (echo && !models) {
    const dir = new URL(assets.litert, self.location.href).href;
    // In a worker the emscripten glue would look for its .wasm next to this script; point it at the vendor folder.
    // LiteRT prints its INFO/WARNING logs to stderr; keep real errors as errors only.
    const printErr = text => (/^INFO:/.test(text) ? console.debug(text) : /^WARNING:/.test(text) ? console.warn(text) : console.error(text));
    self.Module = { locateFile: file => new URL(file, dir).href, printErr };
    try { await litert.loadLiteRt(dir); }
    catch (error) { throw Error(`LiteRT.js runtime could not start (${error.message}). Check that "npm run build" copied public/audio/vendor/litert/.`); }
    const [m1, m2] = await Promise.all([fetchBytes(assets.aec1, 'DTLN-aec 128 model part 1'), fetchBytes(assets.aec2, 'DTLN-aec 128 model part 2')]);
    models = await createLiteRtModels(litert, m1, m2);
  }
  if (noise && !dfModule) {
    const [wasm, model] = await Promise.all([fetchBytes(assets.dfWasm, 'DeepFilterNet3 web build (libDF wasm)', 'It is not installed by default; see README "Audio processing" to add it, or turn noise suppression off'), fetchBytes(assets.dfModel, 'DeepFilterNet3 model')]);
    dfModule = await WebAssembly.compile(wasm); dfModel = model;
  }
  if (echo) info.stages.push({ stage: 'aec', model: 'DTLN-aec 128', runtime: 'LiteRT.js (WebAssembly, CPU)', rate: 16000, tensors: models.details });
  if (noise) info.stages.push({ stage: 'ns', model: 'DeepFilterNet3', runtime: 'libDF (WebAssembly)', rate: 48000 });
  info.loadMs = Math.round(performance.now() - started);
  return info;
}

async function createEngine({ echo, noise, initialRefDelayMs = 0, adaptRefDelay = true }, live = false) {
  const aec = echo ? new DtlnAec(models) : null;
  const ns = noise ? await createDeepFilter(dfModule, dfModel) : null;
  return new OursEngine({ aec, ns, initialRefDelayMs, adaptRefDelay, schedule: live ? run => setTimeout(run, 0) : undefined });
}

function attach(port) {
  port.onmessage = ({ data }) => {
    if (!engine) return;
    pending++;
    const current = engine;
    queue = queue.then(async () => {
      try {
        const out = await current.process(data.mic, data.ref);
        if (current === engine && out.length) port.postMessage({ out }, [out.buffer]);
      } catch (error) { self.postMessage({ type: 'error', message: `Processing failed: ${error.message}` }); }
      finally { pending--; }
    });
  };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      config = data.config;
      const info = await load(config, data.assets);
      engine = await createEngine(config, true);
      info.frameLength = engine.ns?.frameLength ?? null;
      self.postMessage({ type: 'ready', info });
      setInterval(() => { if (engine) self.postMessage({ type: 'stats', engine: engine.stats(), queued: pending }); }, 1000);
    } else if (data.type === 'port') attach(data.port);
    else if (data.type === 'offline') {
      // Whole-buffer run through a fresh chain with the same settings (test page measurements).
      const run = await createEngine({ ...config, ...data.config });
      const chunk = 128, mic = data.mic, ref = data.ref, parts = [];
      for (let i = 0; i < mic.length; i += chunk) {
        const m = mic.subarray(i, Math.min(mic.length, i + chunk));
        parts.push(await run.process(m, ref ? ref.subarray(i, i + m.length) : null));
      }
      const output = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0; for (const p of parts) { output.set(p, o); o += p.length; }
      self.postMessage({ type: 'offline', id: data.id, output, stats: run.stats() }, [output.buffer]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, message: error.message || String(error) });
  }
};
