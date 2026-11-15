// Audio-thread segmentation: pauses, a short lead-in and at most eight seconds.
export class SpeechBuffer {
  constructor(emit, threshold = 0.001) { this.emit = emit; this.threshold = threshold; this.cursor = 0; this.reset(); }
  reset() { this.pre = []; this.blocks = []; this.quiet = 0; this.start = this.cursor; }
  push(block) {
    const at = this.cursor; this.cursor += block.length;
    const rms = Math.sqrt(block.reduce((sum, x) => sum + x * x, 0) / block.length);
    if (!this.blocks.length) {
      if (rms < this.threshold) { this.pre.push(block); if (this.pre.length > 12) this.pre.shift(); return; }
      this.start = at - this.pre.reduce((n, b) => n + b.length, 0);
      this.blocks = this.pre; this.pre = [];
    }
    this.blocks.push(block);
    this.quiet = rms < this.threshold ? this.quiet + block.length : 0;
    if (this.blocks.length >= 400 || (this.quiet >= 10240 && this.blocks.length >= 50)) this.flush();
  }
  flush() {
    const count = this.blocks.reduce((n, b) => n + b.length, 0);
    if (count >= 1600) {
      const samples = new Float32Array(count); let offset = 0;
      for (const block of this.blocks) { samples.set(block, offset); offset += block.length; }
      this.emit({ samples, startSample: this.start });
    }
    this.reset();
  }
}
