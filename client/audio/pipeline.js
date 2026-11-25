// Main-thread side of "Ours": AudioContext (48 kHz) + AudioWorklet + Worker.
//   raw mic track ─► MediaStreamSource ─► ours-processor (worklet) ⇄ Worker (models) ─► MediaStreamDestination ─► track
// The returned track is what the mediasoup producer sends; it stays at 48 kHz for Opus.
export const OURS_ASSETS = {
  worklet: '/audio/ours-worklet.js',
  worker: '/audio/ours-worker.js',
  litert: '/audio/vendor/litert/',
  aec1: '/audio/models/dtln_aec_128_1.tflite',
  aec2: '/audio/models/dtln_aec_128_2.tflite',
  dfWasm: '/audio/models/deepfilternet3/df_bg.wasm',
  dfModel: '/audio/models/deepfilternet3/DeepFilterNet3_onnx.tar.gz',
};

export function oursSupport() {
  if (typeof AudioWorkletNode !== 'function' || typeof AudioContext !== 'function') return 'this browser has no AudioWorklet support';
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.compile !== 'function') return 'this browser has no WebAssembly support';
  if (typeof Worker !== 'function') return 'this browser cannot run Web Workers';
  return null;
}

function timeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

// source: the microphone track (captured with all browser processing off).
export async function createOursPipeline({ source, echo, noise, onStats = () => {}, onError = () => {}, assets = OURS_ASSETS }) {
  const unsupported = oursSupport();
  if (unsupported) throw Error(`Ours cannot run: ${unsupported}.`);
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  let worker = null, node = null, disposed = false;
  const stats = { worklet: null, engine: null, queued: 0 };
  const dispose = () => {
    if (disposed) return; disposed = true;
    try { node?.port.postMessage('stop'); node?.disconnect(); } catch { /* closed */ }
    worker?.terminate();
    out?.stream.getTracks().forEach(t => t.stop());
    if (ctx.state !== 'closed') ctx.close().catch(() => {});
  };
  let out = null;
  try {
    // Neither step has a deadline of its own; a join must not wait on them forever.
    await timeout(ctx.resume(), 10000, 'the browser did not start audio within 10 s');
    if (ctx.sampleRate !== 48000) throw Error(`the browser opened audio at ${ctx.sampleRate} Hz instead of 48000 Hz`);
    try { await timeout(ctx.audioWorklet.addModule(assets.worklet), 30000, 'it did not load within 30 s'); }
    catch (error) { throw Error(`the audio worklet could not load (${error.message}); run "npm run build"`); }
    worker = new Worker(assets.worker);
    const settings = source.getSettings?.() || {};
    // Starting point for lining the far-end reference up with its echo (refined by measurement in the worker).
    const initialRefDelayMs = Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0) + (settings.latency || 0)) * 1000);
    const offline = new Map();
    let loaded = false;
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        const request = data.id ? offline.get(data.id) : null;
        if (request) { offline.delete(data.id); data.type === 'error' ? request.reject(Error(data.message)) : request.resolve(data); }
        else if (data.type === 'ready') resolve(data.info);
        else if (data.type === 'error') loaded ? onError(Error(data.message)) : reject(Error(data.message));
        else if (data.type === 'stats') { stats.engine = data.engine; stats.queued = data.queued; onStats(stats); }
      };
      worker.onerror = event => { event.preventDefault?.(); const error = Error(event.message || 'the processing worker stopped'); loaded ? onError(error) : reject(error); };
    });
    worker.postMessage({ type: 'init', config: { echo, noise, initialRefDelayMs }, assets });
    const info = await timeout(ready, 60000, 'loading the models took longer than 60 s');
    loaded = true;
    // Output buffer target: the largest burst the chain returns at once (a DeepFilterNet3 hop, or a DTLN-aec
    // block at 48 kHz) plus 256 samples of margin. It grows by 128 after each underrun.
    const prefill = 256 + (noise ? 480 : echo ? 384 : 0);
    node = new AudioWorkletNode(ctx, 'ours-processor', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers', processorOptions: { prefill } });
    const started = new Promise(resolve => {
      node.port.onmessage = ({ data }) => {
        if (data.started) resolve();
        if (data.stats) { stats.worklet = data.stats; onStats(stats); }
      };
    });
    const channel = new MessageChannel();
    node.port.postMessage({ port: channel.port1 }, [channel.port1]);
    worker.postMessage({ type: 'port', port: channel.port2 }, [channel.port2]);
    const mic = ctx.createMediaStreamSource(new MediaStream([source]));
    mic.connect(node, 0, 0);
    out = ctx.createMediaStreamDestination();
    node.connect(out);
    await timeout(started, 10000, 'the processing chain produced no audio within 10 s');
    return {
      ctx, track: out.stream.getAudioTracks()[0], source, info, stats, initialRefDelayMs,
      connectReference(bus) { bus.connect(node, 0, 1); },
      // Offline run of a whole buffer through a fresh chain with the same models (test page).
      process(micSamples, refSamples = null, config = {}) {
        const id = Math.random().toString(36).slice(2);
        return new Promise((resolve, reject) => {
          offline.set(id, { resolve, reject });
          const m = micSamples.slice(), r = refSamples ? refSamples.slice() : null;
          worker.postMessage({ type: 'offline', id, mic: m, ref: r, config }, r ? [m.buffer, r.buffer] : [m.buffer]);
          setTimeout(() => { if (offline.delete(id)) reject(Error('offline processing timed out')); }, 120000);
        });
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
