// Draws on the screen and sends each stroke (as 0..1 of the screen) to the meeting page, which shows it to everyone.
const board = document.getElementById('board'), ctx = board.getContext('2d'), bar = document.getElementById('bar');
const SIZE = 6;
let strokes = [], current = null, color = '#ff2d2d', out = null, timer = null;

function resize() {
  const ratio = devicePixelRatio || 1;
  board.width = Math.round(innerWidth * ratio); board.height = Math.round(innerHeight * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); redraw();
}
function paint(s, from = 0) {
  ctx.strokeStyle = ctx.fillStyle = s.color; ctx.lineWidth = s.size; ctx.lineCap = ctx.lineJoin = 'round';
  if (s.pts.length === 1) { ctx.beginPath(); ctx.arc(s.pts[0][0], s.pts[0][1], s.size / 2, 0, 7); ctx.fill(); return; }
  ctx.beginPath(); ctx.moveTo(...s.pts[Math.max(0, from - 1)]);
  for (let i = Math.max(1, from); i < s.pts.length; i++) ctx.lineTo(...s.pts[i]);
  ctx.stroke();
}
function redraw() { ctx.clearRect(0, 0, innerWidth, innerHeight); for (const s of strokes) paint(s); }

// Send points in small batches (every 50 ms) so viewers see the line grow while you draw.
function flush() {
  clearTimeout(timer); timer = null;
  while (out?.pts.length) window.pen.send('page', { event: 'seg', id: out.s.id, color: out.s.color, size: out.s.size / innerWidth, pts: out.pts.splice(0, 200) });
}
function queue(p) { out.pts.push([p[0] / innerWidth, p[1] / innerHeight]); if (!timer) timer = setTimeout(flush, 50); }

board.addEventListener('pointerdown', e => {
  if (!document.body.classList.contains('pen') || e.button !== 0) return;
  board.setPointerCapture(e.pointerId); flush();
  current = { id: crypto.randomUUID().slice(0, 12), color, size: SIZE, pts: [[e.clientX, e.clientY]] };
  strokes.push(current); out = { s: current, pts: [] }; queue(current.pts[0]); paint(current);
});
board.addEventListener('pointermove', e => {
  if (!current) return;
  current.pts.push([e.clientX, e.clientY]); queue(current.pts.at(-1)); paint(current, current.pts.length - 1);
});
const finish = () => { if (current) { flush(); current = null; } };
board.addEventListener('pointerup', finish); board.addEventListener('pointercancel', finish);

// The toolbar stays clickable while the rest of the screen is click-through.
bar.addEventListener('mouseenter', () => window.pen.send('mouse', true));
bar.addEventListener('mouseleave', () => window.pen.send('mouse', false));
document.getElementById('pen').onclick = () => window.pen.send('pen-toggle');
document.getElementById('pause').onclick = () => window.pen.send('page', { event: 'pause' });
document.getElementById('undo').onclick = () => window.pen.send('page', { event: 'undo' });
document.getElementById('clear').onclick = () => window.pen.send('page', { event: 'clear' });
for (const dot of document.querySelectorAll('.dot')) dot.onclick = () => {
  color = dot.dataset.color;
  for (const d of document.querySelectorAll('.dot')) d.classList.toggle('sel', d === dot);
};

// Messages from the app / meeting page.
window.pen.on(m => {
  if (m.cmd === 'pen') { document.body.classList.toggle('pen', m.on); document.getElementById('pen').setAttribute('aria-pressed', String(m.on)); if (!m.on) finish(); }
  else if (m.cmd === 'paused') { const b = document.getElementById('pause'); b.setAttribute('aria-pressed', String(m.on)); b.innerHTML = m.on ? '&#9654;&#65039;' : '&#9208;'; b.title = m.on ? 'Resume the share' : 'Pause the share for viewers'; }
  else if (m.cmd === 'remove') { strokes = strokes.filter(s => s.id !== m.id); redraw(); }
  else if (m.cmd === 'clear') { strokes = []; current = null; out = null; redraw(); }
});
addEventListener('resize', resize); resize();
