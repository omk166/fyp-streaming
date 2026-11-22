// Segmentation runs locally. Only the composited camera track is published.
let library;
function loadLibrary() {
  if (window.SelfieSegmentation) return Promise.resolve();
  if (!library) library = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/selfie-segmentation/selfie_segmentation.js';
    script.onload = resolve;
    script.onerror = () => { script.remove(); library = null; reject(Error('Could not load background effects. Try again.')); };
    document.head.append(script);
  });
  return library;
}

function drawCover(ctx, image, width, height) {
  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  const scale = Math.max(width / iw, height / ih);
  ctx.drawImage(image, (width - iw * scale) / 2, (height - ih * scale) / 2, iw * scale, ih * scale);
}

async function loadImage(url) {
  const image = new Image(); image.src = url;
  await image.decode(); return image;
}

async function createBackgroundEffect(rawTrack, { mode, image, blur = 12, onError }) {
  if (!HTMLCanvasElement.prototype.captureStream) throw Error('Background effects are unavailable in this browser. Try Chrome.');
  await loadLibrary();
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  video.srcObject = new MediaStream([rawTrack]);
  const canvas = document.createElement('canvas');
  const settings = rawTrack.getSettings();
  canvas.width = settings.width || 640; canvas.height = settings.height || 360;
  const ctx = canvas.getContext('2d');
  const segmenter = new window.SelfieSegmentation({ locateFile: file => `/vendor/selfie-segmentation/${file}` });
  let stopped = false, timer, output, pending;
  const stop = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer);
    output?.getTracks().forEach(track => track.stop());
    video.pause(); video.srcObject = null;
    // Close WASM only after any inference already in flight has finished.
    Promise.resolve(pending).catch(() => {}).then(() => segmenter.close()).catch(() => {});
  };
  segmenter.setOptions({ modelSelection: 1 });
  segmenter.onResults(results => {
    if (stopped) return;
    const w = canvas.width, h = canvas.height;
    ctx.save(); ctx.clearRect(0, 0, w, h);
    ctx.drawImage(results.segmentationMask, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(results.image, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-over';
    if (mode === 'blur') {
      ctx.filter = `blur(${blur}px)`;
      // Overscan avoids transparent borders around the blurred background.
      ctx.drawImage(results.image, -blur * 2, -blur * 2, w + blur * 4, h + blur * 4);
    } else drawCover(ctx, image, w, h);
    ctx.restore();
  });
  try {
    await video.play();
    pending = segmenter.send({ image: video }); await pending;
    output = canvas.captureStream(24);
    const frame = async () => {
      if (stopped) return;
      const started = performance.now();
      try {
        pending = segmenter.send({ image: video }); await pending;
        if (!stopped) timer = setTimeout(frame, Math.max(0, 1000 / 24 - (performance.now() - started)));
      } catch (error) {
        if (!stopped) {
          // Never reveal the original room automatically if processing fails.
          ctx.fillStyle = '#101827'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          onError?.(error);
        }
      }
    };
    timer = setTimeout(frame, 1000 / 24);
    return { track: output.getVideoTracks()[0], stop };
  } catch (error) { stop(); throw error; }
}

export function setupBackgroundEffects({ $, producer, preview }) {
  let raw, active, customImage, current = 'none', generation = 0, busy = false;
  const status = message => { $('backgroundStatus').textContent = message; };
  const refresh = () => {
    for (const id of ['backgroundMode', 'backgroundImage', 'backgroundBlur']) $(id).disabled = !raw || busy;
    $('backgroundBlurLabel').hidden = $('backgroundMode').value !== 'blur';
  };
  async function apply() {
    if (!raw || busy) return;
    const token = generation, mode = $('backgroundMode').value;
    let next;
    busy = true; refresh(); status('Applying background…');
    try {
      if (mode === 'custom' && !customImage) throw Error('Choose an image first.');
      if (mode !== 'none') {
        const image = mode === 'custom' ? customImage : mode === 'blur' ? null : await loadImage(`/backgrounds/${mode}.svg`);
        next = await createBackgroundEffect(raw, { mode, image, blur: Number($('backgroundBlur').value),
          onError: () => { if (token === generation) status('Background processing stopped. Choose an effect again, or select None to restore your camera.'); } });
      }
      if (token !== generation) { next?.stop(); return; }
      const p = producer();
      if (!p || p.closed) throw Error('Join a meeting to change your background.');
      await p.replaceTrack({ track: next?.track || raw });
      if (token !== generation) { next?.stop(); return; }
      // The processed output inherits producer pause. Its private input must
      // remain usable, including when the user joined with the camera off.
      if (next) raw.enabled = true;
      preview(next?.track || raw);
      active?.stop(); active = next; current = mode;
      status(mode === 'none' ? 'Background effects off.' : 'Background applied to your preview and outgoing video.');
    } catch (error) {
      next?.stop();
      if (token === generation) { $('backgroundMode').value = current; status(error.message); }
    } finally { if (token === generation) { busy = false; refresh(); } }
  }
  $('backgroundMode').onchange = apply;
  $('backgroundBlur').onchange = apply;
  $('backgroundImage').onchange = async () => {
    const file = $('backgroundImage').files[0];
    if (!file || busy || !raw) return;
    const token = generation;
    let url;
    busy = true; refresh(); status('Loading image…');
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw Error('Choose a JPG, PNG or WebP image under 10 MB.');
      url = URL.createObjectURL(file);
      const decoded = await loadImage(url);
      if (token !== generation) return;
      // Bound retained image size and per-frame compositing cost.
      const image = document.createElement('canvas');
      const scale = Math.min(1, 1920 / Math.max(decoded.width, decoded.height));
      image.width = Math.max(1, Math.round(decoded.width * scale)); image.height = Math.max(1, Math.round(decoded.height * scale));
      image.getContext('2d').drawImage(decoded, 0, 0, image.width, image.height);
      customImage = image; $('backgroundMode').value = 'custom';
      busy = false; await apply();
    } catch (error) { if (token === generation) status(error.message); }
    finally { if (url) URL.revokeObjectURL(url); if (token === generation) { busy = false; $('backgroundImage').value = ''; refresh(); } }
  };
  refresh();
  return {
    start(track) { raw = track; refresh(); status('Choose a background or upload your own image.'); },
    stop() {
      generation++; active?.stop(); active = null; raw = null; customImage = null; busy = false; current = 'none';
      $('backgroundMode').value = 'none'; $('backgroundImage').value = ''; refresh(); status('Join a meeting to use background effects.');
    },
  };
}
