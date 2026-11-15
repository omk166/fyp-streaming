import { SpeechBuffer } from './speech-buffer.js';
class SpeechCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.block = []; this.sum = 0; this.count = 0; this.phase = 0; this.silence = new Float32Array(128);
    this.buffer = new SpeechBuffer(message => this.port.postMessage(message, [message.samples.buffer]));
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        if (this.block.length) this.buffer.push(new Float32Array(this.block));
        this.block = []; this.buffer.flush(); this.port.postMessage({ flushed: true });
      } else { this.block = []; this.buffer.reset(); this.sum = this.count = this.phase = 0; }
    };
  }
  process(inputs) {
    // Some capture devices omit the input channel during silence. Advance the
    // silence detector anyway so the last sentence does not wait for more speech.
    const input = inputs[0]?.[0] || this.silence;
    for (const value of input) {
      this.sum += value; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.block.push(this.sum / this.count); this.sum = this.count = 0; this.phase -= sampleRate;
        if (this.block.length === 320) { this.buffer.push(new Float32Array(this.block)); this.block = []; }
      }
    }
    return true;
  }
}
registerProcessor('speech-capture', SpeechCapture);
