// The three microphone processing modes and how each maps onto getUserMedia constraints.
export const MODES = {
  off: { label: 'Off (raw)', short: 'Off' },
  browser: { label: 'Browser (built-in)', short: 'Browser' },
  ours: { label: 'Ours (DTLN-aec 128 + DeepFilterNet3)', short: 'Ours' },
};
export const DEFAULT_PREFS = Object.freeze({ mode: 'browser', echo: true, noise: true });
export const STORAGE_KEY = 'audio-processing';
const KEYS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'];

// Off: everything false (unprocessed baseline). Browser: the browser's own echo cancellation and noise
// suppression follow the two switches, automatic gain control stays on (all three true by default,
// which is the app's previous behaviour). Ours: everything false, so audio is never processed twice.
export function browserConstraints({ mode, echo, noise }) {
  if (mode === 'browser') return { echoCancellation: Boolean(echo), noiseSuppression: Boolean(noise), autoGainControl: true };
  return { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
}
export function normalizePrefs(value) {
  const prefs = { ...DEFAULT_PREFS };
  if (value && typeof value === 'object') {
    if (Object.hasOwn(MODES, value.mode)) prefs.mode = value.mode;
    if (typeof value.echo === 'boolean') prefs.echo = value.echo;
    if (typeof value.noise === 'boolean') prefs.noise = value.noise;
  }
  return prefs;
}
export function loadPrefs(storage) {
  try { return normalizePrefs(JSON.parse(storage?.getItem(STORAGE_KEY) || 'null')); } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(storage, prefs) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(normalizePrefs(prefs))); return true; } catch { return false; }
}
// What the browser says it actually applied. null = not reported for this track.
export function readSettings(track) {
  let settings = {};
  try { settings = track?.getSettings?.() || {}; } catch { /* ended or unsupported */ }
  return Object.fromEntries(KEYS.map(key => [key, typeof settings[key] === 'boolean' ? settings[key] : null]));
}
// Requested settings the browser reported differently (unreported values are listed separately).
export function compareSettings(requested, reported) {
  const ignored = KEYS.filter(key => reported[key] !== null && reported[key] !== requested[key]);
  const unreported = KEYS.filter(key => reported[key] === null);
  return { ignored, unreported };
}
export function describe({ mode, echo, noise }) {
  if (mode === 'off') return MODES.off.label;
  const parts = [`echo cancellation ${echo ? 'on' : 'off'}`, `noise suppression ${noise ? 'on' : 'off'}`];
  return `${MODES[mode].label} · ${parts.join(' · ')}`;
}
export function formatSettings(values) {
  return KEYS.map(key => `${key} ${values[key] === null ? 'not reported' : values[key]}`).join(' · ');
}
