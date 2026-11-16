const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let target = '/';
try {
  const url = new URL(params.get('next') || '/', location.origin);
  if (url.origin === location.origin && ['/', '/index.html', '/home', '/meeting'].includes(url.pathname)) target = url.pathname + url.search + (url.hash || location.hash);
} catch {}
const room = new URL(target, location.origin).searchParams.get('room');
if (room) { $('roomHint').textContent = `Joining room: ${room.slice(0, 48)}`; $('roomHint').hidden = false; }
const messages = {
  google_unavailable: 'Google sign-in is not available yet. Use email or continue as guest.',
  google_failed: 'Google sign-in could not be completed. Please try again.',
  google_cancelled: 'Google sign-in was cancelled. You can try again or choose another option.',
  account_method: 'This email already uses another sign-in method. Please log in with that method.',
};
function feedback(message) { $('feedback').textContent = message; $('feedback').hidden = !message; }
if (messages[params.get('error')]) feedback(messages[params.get('error')]);
// OAuth codes and errors do not need to remain in browser history.
if (params.has('error')) history.replaceState(null, '', `/auth?next=${encodeURIComponent(target)}`);
let busy = false;
function select(view) {
  if (busy) return;
  for (const tab of document.querySelectorAll('[data-view]')) {
    const active = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    $(`${tab.dataset.view}Panel`).hidden = !active;
  }
  feedback('');
}
const tabs = [...document.querySelectorAll('[data-view]')];
for (const tab of tabs) {
  tab.onclick = () => select(tab.dataset.view);
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    select(tabs[index].dataset.view); tabs[index].focus();
  };
}
for (const button of document.querySelectorAll('[data-password]')) button.onclick = () => {
  const input = $(button.dataset.password), show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); button.setAttribute('aria-pressed', String(show));
};
for (const method of ['login', 'signup', 'guest']) $(`${method}Form`).onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  const form = event.currentTarget, submit = form.querySelector('[type=submit]'), label = submit.textContent;
  const data = Object.fromEntries(new FormData(form));
  busy = true; feedback('');
  for (const control of document.querySelectorAll('button')) control.disabled = true;
  submit.textContent = method === 'signup' ? 'Creating account…' : method === 'guest' ? 'Joining…' : 'Logging in…';
  try {
    const response = await fetch(`/api/auth/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Could not continue. Please try again.');
    location.assign(target);
  } catch (error) {
    feedback(error.message === 'Failed to fetch' ? 'Could not connect. Check your connection and try again.' : error.message);
    $('feedback').focus();
  } finally {
    busy = false; submit.textContent = label;
    for (const control of document.querySelectorAll('button')) control.disabled = false;
    $('google').disabled = !googleEnabled;
  }
};
let googleEnabled = false;
$('google').onclick = () => { if (googleEnabled && !busy) location.assign(`/api/auth/google?next=${encodeURIComponent(target)}`); };
$('continue').onclick = () => location.assign(target);
async function loadOptions() {
  const [options, session] = await Promise.allSettled([
    fetch('/api/auth/options', { cache: 'no-store' }).then(r => { if (!r.ok) throw Error(); return r.json(); }),
    fetch('/api/auth/session', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
  ]);
  googleEnabled = options.status === 'fulfilled' && options.value.google;
  $('google').disabled = busy || !googleEnabled; $('googleNote').hidden = googleEnabled;
  if (session.status === 'fulfilled' && session.value) {
    $('existingName').textContent = `${session.value.kind === 'guest' ? 'Guest session' : 'Signed in'}: ${session.value.name}`;
    $('existing').hidden = false;
  }
}
loadOptions();
