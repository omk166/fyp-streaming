// Screen pen: a transparent layer over your whole screen so you can draw over any app while sharing.
// Start it with `npm run overlay` and leave it running. The meeting page shows it when you share your
// Entire screen and hides it when you stop. What you draw is sent to the page, which shows it to everyone.
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const { WebSocketServer } = require('ws');
const path = require('node:path');

const PORT = 47321;
const ORIGINS = [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, /^https:\/\/[a-z0-9-]+\.sslip\.io$/];
let win, page = null, pen = false, overBar = false;

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...bounds, show: false, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
    fullscreenable: false, skipTaskbar: true, enableLargerThanScreen: true,
    focusable: false,       // never steals focus from the app you are presenting
    acceptFirstMouse: true, // macOS: without this, clicks on a never-focused window are swallowed
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the ink and toolbar out of the shared video: viewers get the ink from the page instead, as a layer
  // over your share, so it stays live while the share is paused.
  win.setContentProtection(true);
  applyMouse();
  win.loadFile('overlay.html');
}
// Click-through unless the pen is on or the mouse is over the toolbar.
function applyMouse() { win.setIgnoreMouseEvents(!(pen || overBar), { forward: true }); }
const toPage = message => { if (page?.readyState === 1) page.send(JSON.stringify(message)); };
const toWin = message => win.webContents.send('msg', message);

function setPen(on) {
  pen = Boolean(on) && win.isVisible();
  applyMouse();
  if (pen) globalShortcut.register('Escape', () => setPen(false)); else globalShortcut.unregister('Escape');
  toWin({ cmd: 'pen', on: pen }); toPage({ event: 'pen', on: pen });
}
function show() {
  const { bounds } = screen.getPrimaryDisplay();
  win.showInactive();
  win.setBounds(bounds); setTimeout(() => win.setBounds(bounds), 300); // macOS: cover the menu bar too
}
function hide() { setPen(false); toWin({ cmd: 'clear' }); win.hide(); }

function startServer() {
  const wss = new WebSocketServer({
    host: '127.0.0.1', port: PORT, maxPayload: 64 * 1024,
    verifyClient: ({ origin }) => ORIGINS.some(r => r.test(origin || '')) || (Boolean(origin) && origin === process.env.OVERLAY_ALLOWED_ORIGIN)
  });
  wss.on('error', error => { console.log(`[screen pen] cannot use port ${PORT}: ${error.message} (already running?)`); app.quit(); });
  wss.on('connection', ws => {
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      // Test hook, only with OVERLAY_DEBUG=1.
      if (process.env.OVERLAY_DEBUG && m.cmd === 'debug') { win.webContents.executeJavaScript(String(m.js)).then(r => ws.send(JSON.stringify({ debug: r ?? null }))); return; }
      if (m.cmd === 'show') { if (page && page !== ws) page.close(); page = ws; show(); return; } // the page sharing now
      if (ws !== page) return;
      if (m.cmd === 'pen') setPen(m.on);
      else if (['remove', 'clear', 'paused'].includes(m.cmd)) toWin(m);
    });
    ws.on('close', () => { if (page === ws) { page = null; hide(); } }); // share stopped, page closed or reloaded
  });
}

ipcMain.on('pen-toggle', () => setPen(!pen));
ipcMain.on('mouse', (_event, over) => { overBar = Boolean(over); applyMouse(); });
ipcMain.on('page', (_event, message) => toPage(message)); // strokes and toolbar actions go to the page

if (!app.requestSingleInstanceLock()) app.quit();
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide();
  createWindow(); startServer();
  globalShortcut.register('CommandOrControl+Shift+D', () => setPen(!pen));
  screen.on('display-metrics-changed', () => win.setBounds(screen.getPrimaryDisplay().bounds));
  console.log('[screen pen] Ready. Share your Entire screen in the meeting page and it appears. Ctrl+C here to quit.');
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', event => event.preventDefault());
