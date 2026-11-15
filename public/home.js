const $ = id => document.getElementById(id);
let identity, meetings = [], filter = 'all', busy = false;
const feedback = message => { $('feedback').textContent = message; $('feedback').hidden = !message; if (message) $('feedback').focus(); };
const date = value => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(value);
const time = value => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value);
async function api(path, data) {
  const response = await fetch(path, { cache: 'no-store', ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  if (response.status === 401) { location.replace('/auth?next=%2F'); throw Error('Your session ended. Please sign in again.'); }
  if (response.status === 204) return {};
  const body = await response.json(); if (!response.ok) throw Error(body.error || 'Could not complete that request.'); return body;
}
function openMeeting(room, invitation) {
  const url = new URL('/meeting', location.origin); url.searchParams.set('room', room.id);
  if (invitation) url.hash = new URLSearchParams({ invite: invitation }).toString();
  location.assign(url);
}
function status(room) { return room.ended ? 'Ended' : room.expiresAt <= Date.now() ? 'Expired' : room.locked ? 'Locked' : 'Available'; }
function render() {
  const search = $('historySearch').value.trim().toLocaleLowerCase();
  const selected = meetings.filter(room => room.name.toLocaleLowerCase().includes(search) && (filter === 'all' || (filter === 'ended' ? ['Ended', 'Expired'].includes(status(room)) : !['Ended', 'Expired'].includes(status(room)))));
  $('historyCount').textContent = String(meetings.length); $('historyRows').replaceChildren();
  $('emptyHistory').hidden = Boolean(selected.length); document.querySelector('.table-scroll').hidden = !selected.length;
  $('emptyHistory').querySelector('h3').textContent = meetings.length ? 'No meetings match your search.' : 'Your story starts with a conversation.';
  $('emptyHistory').querySelector('p').textContent = meetings.length ? 'Try a different name or filter.' : 'Meetings you create or join will appear here.';
  for (const room of selected) {
    const row = document.createElement('tr'), nameCell = document.createElement('td'), meeting = document.createElement('div'); meeting.className = 'meeting-cell';
    const symbol = document.createElement('span'); symbol.className = 'meeting-symbol'; symbol.ariaHidden = 'true'; symbol.textContent = '↗';
    const text = document.createElement('div'), title = document.createElement('strong'), role = document.createElement('small'); title.textContent = room.name; title.dir = 'auto'; role.textContent = room.role === 'owner' ? 'You hosted this meeting' : 'You joined this meeting'; text.append(title, role); meeting.append(symbol, text); nameCell.append(meeting);
    const activity = document.createElement('td'); activity.className = 'activity'; const at = room.lastJoinedAt || room.createdAt; activity.append(document.createTextNode(date(at))); const detail = document.createElement('small'); detail.textContent = `${time(at)} · ${room.lastJoinedAt ? 'Last joined' : 'Created'}`; activity.append(detail);
    const stateCell = document.createElement('td'), badge = document.createElement('span'), state = status(room); badge.textContent = state; badge.className = 'badge' + (['Ended', 'Expired'].includes(state) ? ' past' : state === 'Locked' ? ' locked' : ''); stateCell.append(badge);
    const actionCell = document.createElement('td'), button = document.createElement('button'); button.className = 'small-button'; button.textContent = ['Ended', 'Expired'].includes(state) ? 'Closed' : room.role === 'owner' ? 'Open meeting ↗' : 'Join again ↗'; button.disabled = ['Ended', 'Expired'].includes(state) || (state === 'Locked' && room.role !== 'owner'); button.setAttribute('aria-label', `${button.textContent.replace(' ↗', '')}: ${room.name}`);
    button.onclick = () => {
      if (room.role === 'owner') return openMeeting(room);
      $('meetingName').value = room.name; $('invitationDetails').open = true; $('invitationCode').focus(); feedback('Enter a current invitation code, or paste the invitation link from your host.');
      $('joinForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    actionCell.append(button); row.append(nameCell, activity, stateCell, actionCell); $('historyRows').append(row);
  }
}
async function refresh() { $('refreshHistory').disabled = true; try { meetings = (await api('/api/rooms/history')).meetings; render(); } catch (error) { feedback(error.message); } finally { $('refreshHistory').disabled = false; } }
$('refreshHistory').onclick = refresh; $('historySearch').oninput = render;
for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => { filter = button.dataset.filter; for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b === button)); render(); };
$('newMeeting').onclick = () => { $('createFeedback').hidden = true; $('createDialog').showModal(); $('newMeetingName').focus(); };
for (const id of ['closeCreate', 'cancelCreate']) $(id).onclick = () => $('createDialog').close();
$('createForm').onsubmit = async event => {
  event.preventDefault(); if (busy) return; busy = true; $('createMeeting').disabled = true;
  try { const result = await api('/api/rooms', { name: $('newMeetingName').value.trim() }); openMeeting(result.room, result.invitation); }
  catch (error) { $('createFeedback').textContent = error.message; $('createFeedback').hidden = false; }
  finally { busy = false; $('createMeeting').disabled = false; }
};
$('joinForm').onsubmit = async event => {
  event.preventDefault(); if (busy) return; busy = true; $('joinMeeting').disabled = true; feedback('');
  try {
    const value = $('meetingName').value.trim(); let roomId, invitation = $('invitationCode').value.trim(), name = value;
    if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin || !['/', '/index.html', '/meeting'].includes(url.pathname)) throw Error('Use an invitation link from this meeting website.');
      roomId = url.searchParams.get('room'); invitation = new URLSearchParams(url.hash.slice(1)).get('invite') || invitation;
      if (!roomId) throw Error('This link does not contain a meeting.'); name = undefined;
    }
    const result = await api('/api/rooms/find', { roomId, name, invitation }); openMeeting(result.room, invitation);
  } catch (error) { $('invitationDetails').open = true; feedback(error.message); }
  finally { busy = false; $('joinMeeting').disabled = false; }
};
$('logout').onclick = async () => {
  $('logout').disabled = true;
  try { await api('/api/auth/logout', {}); sessionStorage.removeItem('meeting-exit'); location.assign('/auth'); }
  catch (error) { feedback(error.message); $('logout').disabled = false; }
};
function showLastMeeting() {
  try {
    const last = JSON.parse(sessionStorage.getItem('meeting-exit') || 'null');
    if (!last || last.viewerKey !== identity.viewerKey) { sessionStorage.removeItem('meeting-exit'); return; }
    $('exitTitle').textContent = last.reason === 'ended' ? 'Your meeting has ended.' : last.reason === 'disconnected' ? 'Your connection to the meeting was lost.' : 'You’ve left the meeting.';
    $('exitCopy').textContent = last.name || 'Ready for your next conversation.';
    $('exitNotice').hidden = false;
    for (const [id, format] of [['lastTxt', 'txt'], ['lastSrt', 'srt']]) if (last.transcript?.[format]) {
      $(id).hidden = false; $(id).onclick = () => {
        const url = URL.createObjectURL(new Blob([last.transcript[format]], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a'); a.href = url; a.download = `meeting-transcript.${format}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      $('exitCopy').textContent = `${last.name || 'Meeting'} · Caption downloads remain available in this tab until your next meeting.`;
    }
  } catch { sessionStorage.removeItem('meeting-exit'); }
}
$('dismissNotice').onclick = () => { $('exitNotice').hidden = true; sessionStorage.removeItem('meeting-exit'); };
async function init() {
  try {
    identity = await api('/api/auth/session');
    $('profileName').textContent = identity.name; $('profileKind').textContent = identity.kind === 'guest' ? 'Guest session' : 'Personal workspace';
    $('avatar').textContent = identity.name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join('').toLocaleUpperCase();
    $('greeting').textContent = `WELCOME${identity.kind === 'guest' ? '' : ' BACK'}, ${identity.name.toLocaleUpperCase()}`;
    $('today').dateTime = new Date().toISOString().slice(0, 10); $('today').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
    $('logout').disabled = $('joinMeeting').disabled = false; $('newMeeting').disabled = identity.kind !== 'account'; $('hostSignIn').hidden = identity.kind === 'account';
    $('historyNote').textContent = identity.kind === 'guest' ? 'History is available for this guest session. Sign in to keep your meeting history across sessions.' : 'Your latest 100 meetings. History is private to your account.';
    showLastMeeting(); await refresh();
  } catch (error) { feedback(error.message); }
}
init();
