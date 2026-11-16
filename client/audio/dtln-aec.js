// DTLN-aec streaming wrapper, a line-by-line port of the reference loop in
// https://github.com/breizhn/DTLN-aec/blob/main/run_aec.py (MIT, Nils L. Westhausen).
// The two TF-lite models are run by whatever runtime is passed in (LiteRT.js in the browser,
// a fake in unit tests), so this file only does the framing and the FFT work around them.
import { RealFFT } from './dsp.js';

export const DTLN_RATE = 16000;
export const DTLN_BLOCK = 512; // 32 ms window
export const DTLN_SHIFT = 128; // 8 ms hop
// Streaming output trails the input by block_len - block_shift samples (run_aec.py pads by the same amount).
export const DTLN_DELAY_SAMPLES = DTLN_BLOCK - DTLN_SHIFT; // 384 samples = 24 ms at 16 kHz
const BINS = DTLN_BLOCK / 2 + 1;

// models: { run1(inMag, states1, lpbMag) -> { mask, states }, run2(block, states2, lpbBlock) -> { block, states },
//           stateSize1, stateSize2 }; both run functions may return promises.
export class DtlnAec {
  constructor(models) {
    this.models = models;
    this.fft = new RealFFT(DTLN_BLOCK);
    this.inBuffer = new Float32Array(DTLN_BLOCK); this.lpbBuffer = new Float32Array(DTLN_BLOCK); this.outBuffer = new Float32Array(DTLN_BLOCK);
    this.re = new Float64Array(BINS); this.im = new Float64Array(BINS); this.lre = new Float64Array(BINS); this.lim = new Float64Array(BINS);
    this.inMag = new Float32Array(BINS); this.lpbMag = new Float32Array(BINS); this.estimated = new Float32Array(DTLN_BLOCK);
    this.reset();
  }
  reset() {
    this.states1 = new Float32Array(this.models.stateSize1); this.states2 = new Float32Array(this.models.stateSize2);
    this.inBuffer.fill(0); this.lpbBuffer.fill(0); this.outBuffer.fill(0);
  }
  // mic and lpb: DTLN_SHIFT new samples each (16 kHz). Returns DTLN_SHIFT output samples.
  async process(mic, lpb) {
    const { inBuffer, lpbBuffer, outBuffer, fft, re, im, lre, lim, inMag, lpbMag, estimated } = this;
    inBuffer.copyWithin(0, DTLN_SHIFT); inBuffer.set(mic, DTLN_BLOCK - DTLN_SHIFT);
    lpbBuffer.copyWithin(0, DTLN_SHIFT); lpbBuffer.set(lpb, DTLN_BLOCK - DTLN_SHIFT);
    fft.forward(inBuffer, re, im); fft.forward(lpbBuffer, lre, lim);
    for (let k = 0; k < BINS; k++) { inMag[k] = Math.hypot(re[k], im[k]); lpbMag[k] = Math.hypot(lre[k], lim[k]); }
    const first = await this.models.run1(inMag, this.states1, lpbMag);
    this.states1 = first.states;
    const mask = first.mask;
    for (let k = 0; k < BINS; k++) { re[k] *= mask[k]; im[k] *= mask[k]; }
    fft.inverse(re, im, estimated);
    const second = await this.models.run2(estimated, this.states2, lpbBuffer);
    this.states2 = second.states;
    outBuffer.copyWithin(0, DTLN_SHIFT); outBuffer.fill(0, DTLN_BLOCK - DTLN_SHIFT);
    const block = second.block;
    for (let i = 0; i < DTLN_BLOCK; i++) outBuffer[i] += block[i];
    return outBuffer.slice(0, DTLN_SHIFT);
  }
}

// Wires the two official TF-lite files into the interface above using LiteRT.js.
// The models have three inputs each: [magnitude or block, LSTM states, far-end magnitude or block], in the
// order run_aec.py uses (input_details[0], [1], [2]); outputs are [mask or block, states].
export async function createLiteRtModels(litert, model1Bytes, model2Bytes) {
  const { loadAndCompile, Tensor } = litert;
  const [m1, m2] = await Promise.all([
    loadAndCompile(model1Bytes, { accelerator: 'wasm' }),
    loadAndCompile(model2Bytes, { accelerator: 'wasm' }),
  ]);
  const describe = model => ({
    inputs: model.getInputDetails().map(d => ({ name: d.name, index: d.index, shape: [...d.shape] })),
    outputs: model.getOutputDetails().map(d => ({ name: d.name, index: d.index, shape: [...d.shape] })),
  });
  const details = { model1: describe(m1), model2: describe(m2) };
  const order = details => [...details.inputs].sort((a, b) => a.index - b.index);
  const statesOf = model => {
    // The LSTM state input is the only four-dimensional one: (1, 2, units, 2).
    const input = order(model).find(d => d.shape.length === 4);
    if (!input) throw Error('DTLN-aec model has no LSTM state input; unexpected model file');
    return input;
  };
  const s1 = statesOf(details.model1), s2 = statesOf(details.model2);
  const size = shape => shape.reduce((a, b) => a * b, 1);
  const runner = (model, info) => {
    const inputs = order(info), outputs = [...info.outputs].sort((a, b) => a.index - b.index);
    if (inputs.length !== 3 || outputs.length !== 2) throw Error('Unexpected DTLN-aec model signature');
    return async (a, states, b) => {
      // Map our three arrays onto the model's inputs in index order, as run_aec.py does.
      const values = [a, states, b];
      const tensors = inputs.map((d, i) => new Tensor(values[i], d.shape));
      let result;
      try { result = await model.run(tensors); } finally { tensors.forEach(t => t.delete()); }
      try {
        const arrays = result.map(t => t.toTypedArray().slice());
        // Outputs: the state output is the four-dimensional one, the other is the mask/block.
        const stateIndex = result.findIndex(t => t.shape.length === 4);
        return { main: arrays[stateIndex === 0 ? 1 : 0], states: arrays[stateIndex] };
      } finally { result.forEach(t => t.delete()); }
    };
  };
  const run1 = runner(m1, details.model1), run2 = runner(m2, details.model2);
  return {
    details,
    stateSize1: size(s1.shape), stateSize2: size(s2.shape),
    async run1(mag, states, lpbMag) { const r = await run1(mag, states, lpbMag); return { mask: r.main, states: r.states }; },
    async run2(block, states, lpbBlock) { const r = await run2(block, states, lpbBlock); return { block: r.main, states: r.states }; },
    delete() { m1.delete?.(); m2.delete?.(); },
  };
}
