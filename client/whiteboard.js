export function setupWhiteboard({ $, state, rpc }) {
  const canvas = $('boardCanvas'), ctx = canvas.getContext('2d');
  let revision, items = [], draft = null, pointer = null;
  const pending = new Map();
  const freehand = tool => ['pencil', 'marker', 'highlighter', 'eraser'].includes(tool);
  const message = text => { $('boardMessage').textContent = text; };
  function draw(item) {
    const points = item.pts.map(([x, y]) => [x * canvas.width, y * canvas.height]);
    const [a, b] = [points[0], points.at(-1)];
    ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = item.color; ctx.fillStyle = item.color; ctx.lineWidth = item.size;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (item.tool === 'marker') ctx.lineWidth *= 1.5;
    if (item.tool === 'highlighter') { ctx.globalAlpha = 0.3; ctx.lineWidth *= 2; }
    // Erasing is part of the shared drawing history, so undo restores erased ink.
    if (item.tool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth *= 2; }
    ctx.beginPath();
    if (freehand(item.tool) && points.every(p => p[0] === a[0] && p[1] === a[1])) {
      ctx.arc(a[0], a[1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore(); return;
    }
    if (item.tool === 'rectangle') ctx.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    else if (item.tool === 'ellipse') ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
    else {
      ctx.moveTo(...a);
      for (const point of points.slice(1)) ctx.lineTo(...point);
      if (item.tool === 'arrow') {
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]), length = Math.max(15, item.size * 4);
        for (const offset of [-0.5, 0.5]) { ctx.moveTo(...b); ctx.lineTo(b[0] - length * Math.cos(angle + offset), b[1] - length * Math.sin(angle + offset)); }
      }
    }
    ctx.stroke(); ctx.restore();
  }
  function paint() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const item of items) draw(item);
    for (const item of pending.values()) draw(item);
    if (draft) draw(draft);
    // Fill behind the ink after erasing, keeping both the canvas and PNG opaque white.
    ctx.save(); ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.restore();
    $('boardUndo').disabled = !state.joined || pending.size > 0 || !items.some(item => item.peerId === state.peerId);
  }
  function cancel() {
    const previousPointer = pointer;
    draft = null; pointer = null;
    if (previousPointer !== null && canvas.hasPointerCapture(previousPointer)) canvas.releasePointerCapture(previousPointer);
    paint();
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
  }
  function update(event) {
    let p = point(event);
    if (freehand(draft.tool)) {
      if (draft.pts.length < 2000) draft.pts.push(p);
      else message('Stroke size limit reached. Release, then continue with a new stroke.');
    } else {
      if (event.shiftKey && ['rectangle', 'ellipse'].includes(draft.tool)) {
        const [x, y] = draft.pts[0], dx = (p[0] - x) * canvas.width, dy = (p[1] - y) * canvas.height;
        const sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
        const size = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), (sx > 0 ? 1 - x : x) * canvas.width, (sy > 0 ? 1 - y : y) * canvas.height);
        p = [x + sx * size / canvas.width, y + sy * size / canvas.height];
      }
      draft.pts[1] = p;
    }
    paint();
  }
  const act = async (method, data = {}) => {
    try { await rpc(method, data); }
    catch (error) { message(error.message); }
  };
  canvas.onpointerdown = event => {
    if (!state.joined || pointer !== null || event.button !== 0) return;
    event.preventDefault(); pointer = event.pointerId; canvas.setPointerCapture(pointer);
    const p = point(event);
    draft = { revision, clientId: crypto.randomUUID(), tool: $('boardTool').value, color: $('boardColor').value, size: Number($('boardSize').value), pts: [p, [...p]] };
    paint();
  };
  canvas.onpointermove = event => { if (draft && event.pointerId === pointer) update(event); };
  canvas.onpointerup = event => {
    if (!draft || event.pointerId !== pointer) return;
    update(event); const item = draft;
    // Keep the finished stroke visible while waiting for the server's broadcast.
    pending.set(item.clientId, item); cancel();
    rpc('whiteboardAdd', item).catch(error => {
      if (!pending.delete(item.clientId)) return;
      paint(); message(`Drawing could not be shared: ${error.message}`);
    });
  };
  canvas.onpointercancel = cancel;
  canvas.onlostpointercapture = event => { if (draft && event.pointerId === pointer) cancel(); };
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && draft) cancel(); });
  function open(show) {
    if (!show) cancel();
    $('boardPanel').hidden = !show; $('boardToggle').setAttribute('aria-expanded', String(show));
    if (show) { paint(); $('boardPanel').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  }
  $('boardToggle').onclick = () => open($('boardPanel').hidden);
  $('boardClose').onclick = () => open(false);
  $('boardPresent').onclick = () => act('whiteboardShow');
  $('boardTool').onchange = () => {
    const erasing = $('boardTool').value === 'eraser';
    $('boardColor').disabled = erasing;
    canvas.style.cursor = erasing ? 'cell' : 'crosshair';
    message(erasing ? 'Drag over the parts you want to erase. Size controls the eraser width. Undo restores your last erasure.'
      : $('boardTool').value === 'highlighter' ? 'Highlighter ink is intentionally translucent. Choose Pencil or Marker for solid ink.'
      : 'Drag to draw with solid ink. Hold Shift for a square or circle.');
  };
  $('boardUndo').onclick = () => act('whiteboardUndo');
  $('boardClear').onclick = () => { if (confirm('Clear the whiteboard for everyone? This cannot be undone.')) act('whiteboardClear'); };
  $('boardSave').onclick = () => {
    cancel(); canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'meeting-whiteboard.png'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  };
  return {
    load(data) { pending.clear(); cancel(); revision = data.revision; items = data.items; if (data.showing) open(true); paint(); },
    refresh() { $('boardToggle').disabled = !state.joined; $('boardClear').hidden = state.room?.role !== 'owner'; paint(); },
    receive(event, data) {
      if (event === 'whiteboardClear') { pending.clear(); cancel(); revision = data.revision; items = []; message('The owner cleared the whiteboard.'); }
      else if (data.revision !== revision) return;
      else if (event === 'whiteboardShow') { open(true); message(`${data.presenter || 'A participant'} opened the whiteboard for everyone. Your call continues.`); }
      else if (event === 'whiteboardAdd') {
        if (data.item.peerId === state.peerId) pending.delete(data.item.clientId);
        if (!items.some(item => item.id === data.item.id)) items.push(data.item);
      }
      else if (event === 'whiteboardUndo') items = items.filter(item => item.id !== data.id);
      paint();
    },
    leave() { pending.clear(); open(false); items = []; revision = null; $('boardToggle').disabled = true; paint(); },
  };
}
