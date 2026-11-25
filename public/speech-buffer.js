// Audio-thread segmentation into 4-second windows (blocks are 20 ms at 16 kHz).
// A pause (0.64 s of quiet after at least 1 s) closes a window early. Speech that runs past
// 4 s is cut there, and the next window starts 1 s before the cut, so a word split by the cut is
// heard whole in one of the two windows: 0-4 s, 3-7 s, 6-10 s ... The page removes the words the
// two windows share (client/transcript-merge.js).
export const WINDOW_BLOCKS = 200, OVERLAP_BLOCKS = 50;
const PAUSE_SAMPLES = 10240, MIN_BLOCKS = 50, LEAD_IN_BLOCKS = 12, MIN_SAMPLES = 1600;

export class SpeechBuffer {
  constructor(emit, threshold = 0.001) { this.emit = emit; this.threshold = threshold; this.cursor = 0; this.reset(); }
  reset() { this.pre = []; this.blocks = []; this.quiet = 0; this.overlap = 0; this.start = this.cursor; }
  push(block) {
    const at = this.cursor; this.cursor += block.length;
    const rms = Math.sqrt(block.reduce((sum, x) => sum + x * x, 0) / block.length);
    if (!this.blocks.length) {
      if (rms < this.threshold) { this.pre.push(block); if (this.pre.length > LEAD_IN_BLOCKS) this.pre.shift(); return; }
      this.start = at - this.pre.reduce((n, b) => n + b.length, 0);
      this.blocks = this.pre; this.pre = [];
    }
    this.blocks.push(block);
    this.quiet = rms < this.threshold ? this.quiet + block.length : 0;
    if (this.blocks.length >= WINDOW_BLOCKS) this.flush(true);
    else if (this.quiet >= PAUSE_SAMPLES && this.blocks.length >= MIN_BLOCKS) this.flush();
  }
  // continues: speech goes on past this window, so the next one repeats its last second.
  flush(continues = false) {
    const count = this.blocks.reduce((n, b) => n + b.length, 0);
    if (count >= MIN_SAMPLES) {
      const samples = new Float32Array(count); let offset = 0;
      for (const block of this.blocks) { samples.set(block, offset); offset += block.length; }
      const overlapSamples = this.overlap ? this.blocks.slice(0, this.overlap).reduce((n, b) => n + b.length, 0) : 0;
      this.emit({ samples, startSample: this.start, overlapSamples, continues });
    }
    if (continues) {
      const carry = this.blocks.slice(-OVERLAP_BLOCKS), quiet = this.quiet;
      this.reset();
      this.blocks = carry; this.overlap = carry.length; this.quiet = quiet;
      this.start = this.cursor - carry.reduce((n, b) => n + b.length, 0);
    } else this.reset();
  }
}
