// AudioWorklet side of "Ours" (bundled to public/audio/ours-worklet.js).
// Input 0: raw microphone. Input 1: far-end reference bus (silent when echo cancellation is off).
// Every 128-sample render quantum is posted to the Worker; processed audio comes back over the same
// MessagePort and is played from a small ring buffer. Counting samples in and out gives the buffering
// delay exactly: a sample sent at index n is played when the output count reaches n.
const SILENCE = new Float32Array(128);

class OursProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions = {} }) {
    super();
    this.prefill = processorOptions.prefill ?? 736; this.maxPrefill = 4800;
    this.maxBuffered = processorOptions.maxBuffered ?? 14400; // 300 ms: beyond this the chain is not keeping up
    this.ring = new Float32Array(48000); this.read = 0; this.count = 0; this.playing = false;
    this.inCount = 0; this.outCount = 0; this.underruns = 0; this.droppedSamples = 0; this.since = 0; this.started = false;
    this.port.onmessage = ({ data }) => {
      if (data.port) { this.worker = data.port; this.worker.onmessage = ({ data: message }) => this.receive(message.out); }
      if (data === 'stop') { this.stopped = true; this.worker?.close(); }
    };
  }
  receive(samples) {
    const ring = this.ring, size = ring.length;
    if (this.count + samples.length > size) { this.drop(this.count + samples.length - size); }
    let write = (this.read + this.count) % size;
    for (let i = 0; i < samples.length; i++) { ring[write] = samples[i]; write = write + 1 === size ? 0 : write + 1; }
    this.count += samples.length;
  }
  drop(samples) {
    const n = Math.min(samples, this.count);
    this.read = (this.read + n) % this.ring.length; this.count -= n; this.outCount += n; this.droppedSamples += n;
  }
  process(inputs, outputs) {
    if (this.stopped) return false;
    const mic = inputs[0]?.[0] || SILENCE, ref = inputs[1]?.[0] || SILENCE, out = outputs[0][0];
    if (this.worker) {
      const m = mic.slice(), r = ref.slice();
      this.inCount += m.length; // count before the transfer below empties the array
      this.worker.postMessage({ mic: m, ref: r }, [m.buffer, r.buffer]);
    }
    // Not keeping up: discard the oldest processed audio down to the prefill level and report it.
    if (this.inCount - this.outCount > this.maxBuffered && this.count > this.prefill) this.drop(this.count - this.prefill);
    if (!this.playing && this.count >= this.prefill) this.playing = true;
    if (this.playing && this.count >= out.length) {
      const ring = this.ring, size = ring.length;
      for (let i = 0; i < out.length; i++) { out[i] = ring[this.read]; this.read = this.read + 1 === size ? 0 : this.read + 1; }
      this.count -= out.length; this.outCount += out.length;
      if (!this.started) { this.started = true; this.port.postMessage({ started: true }); }
    } else {
      out.fill(0);
      if (this.playing) { this.underruns++; this.playing = false; this.prefill = Math.min(this.maxPrefill, this.prefill + 128); }
    }
    this.since += out.length;
    if (this.since >= sampleRate) {
      this.since = 0;
      this.port.postMessage({ stats: { bufferedMs: (this.inCount - this.outCount) / sampleRate * 1000, prefillMs: this.prefill / sampleRate * 1000, underruns: this.underruns, droppedMs: this.droppedSamples / sampleRate * 1000 } });
    }
    return true;
  }
}
registerProcessor('ours-processor', OursProcessor);
