// Records two inputs sample-aligned (input 0: the track under test, input 1: a raw reference capture)
// and posts them to the page every 100 ms. Bundled to public/audio/recorder-worklet.js.
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.a = []; this.b = []; this.count = 0; this.recording = true;
    this.port.onmessage = ({ data }) => { if (data === 'stop') { this.flush(); this.recording = false; this.port.postMessage({ done: true }); } };
  }
  process(inputs) {
    if (!this.recording) return false;
    const a = inputs[0]?.[0], b = inputs[1]?.[0];
    this.a.push(a ? a.slice() : new Float32Array(128)); this.b.push(b ? b.slice() : new Float32Array(128));
    this.count += 128;
    if (this.count >= sampleRate / 10) this.flush();
    return true;
  }
  flush() {
    if (!this.count) return;
    const join = parts => { const out = new Float32Array(this.count); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
    const a = join(this.a), b = join(this.b);
    this.port.postMessage({ a, b }, [a.buffer, b.buffer]);
    this.a = []; this.b = []; this.count = 0;
  }
}
registerProcessor('pcm-recorder', PcmRecorder);
