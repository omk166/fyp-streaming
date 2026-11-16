export function setupRooms({ $, identity, joined, onChange, onError, onEnded = () => {}, confirm: ask = async ({ text }) => confirm(text) }) {
  const params = new URLSearchParams(location.search), fragment = new URLSearchParams(location.hash.slice(1));
  let roomId = params.get('room') || '', invitation = fragment.get('invite') || '', current = null;
  async function api(path, data) {
    const response = await fetch(`/api/rooms${path}`, { method: data === undefined ? 'GET' : 'POST', cache: 'no-store',
      ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    const body = await response.json();
    if (!response.ok) throw Error(body.error || 'Room request failed.');
    return body;
  }
  function url() {
    const target = new URL(location.href);
    target.searchParams.set('room', roomId); target.hash = invitation ? new URLSearchParams({ invite: invitation }).toString() : '';
    return target;
  }
  function update(next) {
    current = next;
    $('room').value = next?.name || '';
    $('roomNotice').textContent = next ? `${next.role === 'owner' ? 'Your room' : 'Invited room'} · ${next.locked ? 'Locked to new participants' : 'Invitation required'}` : 'Open an invitation link to join, or log in to create a room.';
    $('roomOwner').hidden = next?.role !== 'owner';
    $('lockRoom').textContent = next?.locked ? 'Unlock room' : 'Lock room';
    $('join').disabled = !next || joined() || next.ended;
    $('roomCreate').hidden = identity()?.kind !== 'account';
    $('ownRooms').disabled = joined(); $('createRoom').disabled = joined();
    $('inviteLink').value = invitation ? url().href : '';
    $('inviteLink').hidden = !invitation; $('copyInvite').disabled = !invitation;
    onChange(next);
  }
  async function list() {
    const { rooms } = await api('');
    $('ownRooms').replaceChildren(new Option('Choose one of your rooms', ''));
    for (const room of rooms) $('ownRooms').append(new Option(room.name, room.id));
  }
  async function resolve() {
    if (!roomId) { update(null); return; }
    const result = await api('/resolve', { roomId, invitation }); update(result.room);
  }
  function adopt(result) {
    roomId = result.room.id; invitation = result.invitation || '';
    history.replaceState(null, '', url()); update(result.room);
  }
  $('roomCreate').onsubmit = async event => {
    event.preventDefault(); if (joined()) return;
    $('createRoom').disabled = true;
    try { adopt(await api('', { name: $('newRoomName').value })); await list(); $('ownRooms').value = roomId; }
    catch (error) { onError(error); } finally { $('createRoom').disabled = false; }
  };
  $('ownRooms').onchange = async () => {
    if (joined()) return;
    roomId = $('ownRooms').value; invitation = ''; history.replaceState(null, '', url());
    try { await resolve(); } catch (error) { update(null); onError(error); }
  };
  $('copyInvite').onclick = async () => {
    try { await navigator.clipboard.writeText($('inviteLink').value); $('roomNotice').textContent = 'Invitation copied. Anyone with this link can join while the room is unlocked.'; }
    catch { $('inviteLink').focus(); $('inviteLink').select(); $('roomNotice').textContent = 'Copy the selected invitation link.'; }
  };
  $('rotateInvite').onclick = async () => {
    try { const result = await api(`/${roomId}/invitation`, {}); adopt(result); $('roomNotice').textContent = 'New invitation ready. Previous links no longer admit participants.'; }
    catch (error) { onError(error); }
  };
  $('lockRoom').onclick = async () => {
    try { update((await api(`/${roomId}/lock`, { locked: !current.locked })).room); }
    catch (error) { onError(error); }
  };
  $('endRoom').onclick = async () => {
    if (!await ask({ title: 'End meeting for everyone?', text: 'Everyone will be removed from the call and its invitations will stop working.', ok: 'End meeting' })) return;
    try { update((await api(`/${roomId}/end`, {})).room); onEnded(); }
    catch (error) { onError(error); }
  };
  return {
    async init() { update(null); await list(); await resolve(); },
    credentials: () => ({ room: roomId, invitation }),
    refresh: () => update(current),
    changed(data) { if (data.id === roomId && current) update({ ...current, locked: data.locked, ended: data.ended }); },
  };
}
