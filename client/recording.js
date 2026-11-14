// Local output only: never replaces, pauses or stops an original media track.
export class MeetingRecorder {
  constructor({ tiles, audioTracks, saved, failed }) {
    Object.assign(this, { tiles, audioTracks, saved, failed });
    this.prepared = null; this.job = null; this.generation = 0;
  }
  static supported() { return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'; }
  async prepare() {
    if (!MeetingRecorder.supported()) throw Error('Recording is unavailable in this browser. Try desktop Chrome or Edge.');
    if (!this.prepared) this.prepared = new AudioContext();
    await this.prepared.resume();
  }
  async start({ id, peerIds }) {
    const generation = ++this.generation;
    await this.prepare();
    if (generation !== this.generation) return;
    const ctx = this.prepared; this.prepared = null;
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const mix = ctx.createMediaStreamDestination(), compressor = ctx.createDynamicsCompressor(); compressor.connect(mix);
    const job = this.job = { id, ctx, canvas, peerIds: new Set(peerIds), sources: new Map(), chunks: [], bytes: 0, timer: null, stopped: false, stream: null, recorder: null };
    job.finished = new Promise(resolve => { job.resolveFinished = resolve; });
    const sync = () => {
      const tracks = this.audioTracks().filter(item => job.peerIds.has(item.peerId) && item.track.readyState === 'live');
      const ids = new Set(tracks.map(item => item.track.id));
      for (const [id, source] of job.sources) if (!ids.has(id)) { source.disconnect(); job.sources.delete(id); }
      for (const { track } of tracks) if (!job.sources.has(track.id)) {
        const source = ctx.createMediaStreamSource(new MediaStream([track])); source.connect(compressor); job.sources.set(track.id, source);
      }
    };
    const draw = () => {
      const c = canvas.getContext('2d'); c.fillStyle = '#101827'; c.fillRect(0, 0, 1280, 720);
      const visible = this.tiles().filter(tile => job.peerIds.has(tile.dataset.peerId));
      const cols = Math.max(1, Math.ceil(Math.sqrt(visible.length * 16 / 9))), rows = Math.max(1, Math.ceil(visible.length / cols));
      const w = 1280 / cols, h = 680 / rows;
      visible.forEach((tile, i) => {
        const video = tile.querySelector('video'), x = (i % cols) * w + 5, y = Math.floor(i / cols) * h + 5, bw = w - 10, bh = h - 40;
        c.fillStyle = '#000'; c.fillRect(x, y, bw, bh);
        const frozen = tile.querySelector('.freeze'), source = frozen || video;
        if (!tile.classList.contains('camera-paused') && video?.videoWidth && (source === video ? video.readyState >= 2 : source.tagName !== 'IMG' || source.complete)) {
          const scale = Math.min(bw / video.videoWidth, bh / video.videoHeight), dw = video.videoWidth * scale, dh = video.videoHeight * scale, dx = x + (bw - dw) / 2, dy = y + (bh - dh) / 2;
          c.drawImage(source, dx, dy, dw, dh);
          const ink = tile.querySelector('.annot'); if (ink) c.drawImage(ink, dx, dy, dw, dh);
        }
        c.fillStyle = '#edf4ff'; c.font = '16px sans-serif';
        c.fillText(tile.querySelector('footer span')?.childNodes[0]?.textContent || 'Participant', x + 6, y + bh + 23, bw - 12);
      });
      c.fillStyle = '#ffb2a5'; c.font = '16px sans-serif'; c.fillText('● Meeting recording · ' + new Date().toLocaleTimeString(), 16, 706);
      sync();
    };
    const cleanup = () => {
      clearInterval(job.timer);
      for (const source of job.sources.values()) source.disconnect(); job.sources.clear();
      job.stream?.getTracks().forEach(track => track.stop());
      ctx.close().catch(() => {});
      if (this.job === job) this.job = null;
    };
    try {
      draw();
      const stream = job.stream = canvas.captureStream(15); stream.addTrack(mix.stream.getAudioTracks()[0]);
      const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw Error('No supported recording format is available.');
      const recorder = job.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1500000, audioBitsPerSecond: 128000 });
      recorder.ondataavailable = ({ data }) => {
        if (!data.size) return;
        job.chunks.push(data); job.bytes += data.size;
        if (job.bytes >= 200 * 1024 * 1024 && !job.stopped) { this.stop(); this.failed(Error('Recording reached the 200 MB limit. The current clip is saved.'), id); }
      };
      recorder.onerror = () => { this.stop(); this.failed(Error('Recording stopped unexpectedly. The call continues.'), id); };
      recorder.onstop = () => {
        cleanup();
        if (job.chunks.length) this.saved(new Blob(job.chunks, { type: recorder.mimeType }), id, [...job.peerIds]);
        else this.failed(Error('Recording ended before any media was captured.'), id);
        job.chunks = [];
        job.resolveFinished();
      };
      recorder.start(1000);
      draw(); stream.getVideoTracks()[0].requestFrame?.();
      job.timer = setInterval(() => {
        if (job.stopped) return;
        try { draw(); } catch (error) { this.stop(); this.failed(error, id); }
      }, 1000 / 15);
    } catch (error) { cleanup(); job.resolveFinished(); throw error; }
  }
  stop() {
    this.generation++;
    const prepared = this.prepared; this.prepared = null; prepared?.close().catch(() => {});
    const job = this.job;
    if (!job) return Promise.resolve();
    if (job.stopped) return job.finished;
    job.stopped = true; clearInterval(job.timer);
    if (job.recorder && job.recorder.state !== 'inactive') job.recorder.stop();
    return job.finished;
  }
}
