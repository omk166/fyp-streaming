// Presentation-only behaviour for the meeting page: lobby, panels, popovers, toasts and small indicators.
// Media, signalling and permissions stay in main.js and the feature modules; this file only reads the DOM they update.

// Buttons in the control bar show an icon and keep their text in a `.label` span, so tests and screen readers
// still find "Mute microphone", "Share screen" and so on.
export function setLabel(el, text) {
  if (!el) return;
  const label = el.querySelector('.label');
  if (label) label.textContent = text; else el.textContent = text;
  if (el.closest('#controls') || el.id === 'viewMode') el.dataset.tip = text;
}

export const initials = name => (name || '').replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).slice(0, 2).map(word => [...word][0] || '').join('').toLocaleUpperCase() || '·';

export function setupUI({ $ }) {
  const body = document.body;
  const params = new URLSearchParams(location.search);
  if (params.has('debug')) body.classList.add('debug');
  $('debugPanel').hidden = !params.has('debug');
  for (const el of document.querySelectorAll('[data-debug-toggle]')) el.onclick = () => { $('debugPanel').hidden = !$('debugPanel').hidden; closePopovers(); };

  // Tooltips for icon-only controls.
  for (const el of document.querySelectorAll('#controls button')) {
    const text = el.querySelector('.label')?.textContent || el.title || el.querySelector('.sr-only')?.textContent;
    if (text) { el.dataset.tip = text; el.removeAttribute('title'); }
  }

  const tip = document.createElement('div'); tip.id = 'tip'; tip.setAttribute('aria-hidden', 'true'); document.body.append(tip);
  document.addEventListener('pointerover', event => {
    const target = event.target.closest?.('[data-tip]');
    if (!target || event.pointerType === 'touch' || target.closest('.pop-wrap')?.querySelector('.popover:not([hidden])')) { tip.classList.remove('show'); return; }
    const box = target.getBoundingClientRect();
    tip.textContent = target.dataset.tip; tip.style.left = `${box.left + box.width / 2}px`; const below = box.top < 80; tip.classList.toggle('below', below); tip.style.top = `${below ? box.bottom + 8 : box.top - 10}px`; tip.classList.add('show');
  });
  document.addEventListener('pointerdown', () => tip.classList.remove('show'));

  // ---- Toasts: #status (and #roomNotice once in the call) appear briefly above the control bar.
  let toastTimer;
  const toast = text => {
    if (!text) return;
    const status = $('status');
    if (status.textContent !== text) { observingStatus = false; status.textContent = text; observingStatus = true; }
    status.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => status.classList.remove('show'), Math.min(9000, 3500 + text.length * 40));
  };
  let observingStatus = true;
  new MutationObserver(() => { if (observingStatus) toast($('status').textContent); }).observe($('status'), { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => {
    const text = $('roomNotice').textContent;
    if (body.dataset.phase === 'call' && /copied|invitation ready|Copy the selected/i.test(text)) toast(text);
  }).observe($('roomNotice'), { childList: true, characterData: true, subtree: true });

  // ---- Popovers (reactions, more, account).
  function closePopovers(except) {
    for (const trigger of document.querySelectorAll('[data-popover]')) {
      const pop = $(trigger.dataset.popover);
      if (pop && pop !== except) { pop.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
    }
  }
  for (const trigger of document.querySelectorAll('[data-popover]')) {
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      const pop = $(trigger.dataset.popover), open = pop.hidden;
      closePopovers(pop); pop.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
    });
  }
  document.addEventListener('click', event => { if (!event.target.closest('.popover')) closePopovers(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closePopovers(); if (!$('confirmModal').hidden) $('confirmCancel').click(); } });
  for (const button of document.querySelectorAll('#reactPop button')) button.addEventListener('click', () => setTimeout(closePopovers, 150));
  for (const item of document.querySelectorAll('button.menu-item')) item.addEventListener('click', () => setTimeout(closePopovers, 0));
  for (const proxy of document.querySelectorAll('[data-proxy]')) proxy.onclick = () => { closePopovers(); $(proxy.dataset.proxy).click(); };

  // ---- Side panel: Chat / People / Transcript.
  let unread = 0;
  function openPanel(name) {
    body.dataset.panel = name || '';
    for (const tab of document.querySelectorAll('#sidePanel [data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const button of document.querySelectorAll('#controls [data-panel-open]')) button.classList.toggle('panel-on', button.dataset.panelOpen === name);
    if (name === 'chat') { unread = 0; $('chatBadge').hidden = true; if (matchMedia('(min-width: 861px)').matches) $('message').focus({ preventScroll: true }); }
  }
  for (const button of document.querySelectorAll('[data-panel-open]')) button.addEventListener('click', () => openPanel(body.dataset.panel === button.dataset.panelOpen && button.closest('#controls') ? '' : button.dataset.panelOpen));
  for (const tab of document.querySelectorAll('#sidePanel [data-tab]')) tab.onclick = () => openPanel(tab.dataset.tab);
  for (const button of document.querySelectorAll('[data-panel-close]')) button.onclick = () => openPanel('');
  new MutationObserver(records => {
    const added = records.reduce((n, r) => n + [...r.addedNodes].filter(node => node.classList?.contains('msg') && !node.classList.contains('mine')).length, 0);
    if (!added || body.dataset.panel === 'chat') return;
    unread += added; $('chatBadge').textContent = unread > 9 ? '9+' : String(unread); $('chatBadge').hidden = false;
  }).observe($('chat'), { childList: true });
  new MutationObserver(() => { $('peopleCount').textContent = String($('participants').children.length); }).observe($('participants'), { childList: true });

  // ---- Live caption overlay: the newest transcript line shows over the video for a few seconds.
  let captionTimer;
  new MutationObserver(() => {
    const last = $('transcript').lastElementChild;
    if (!last || body.dataset.phase !== 'call') return;
    $('captionText').textContent = last.textContent.replace(/^\[[\d:]+\]\s*/, '');
    $('captionOverlay').hidden = false; clearTimeout(captionTimer);
    captionTimer = setTimeout(() => { $('captionOverlay').hidden = true; }, 7000);
  }).observe($('transcript'), { childList: true });
  new MutationObserver(() => { $('ccPill').hidden = !/active/i.test($('transcriptionStatus').textContent); })
    .observe($('transcriptionStatus'), { childList: true, characterData: true, subtree: true });

  // ---- Recording pill in the top bar.
  new MutationObserver(() => {
    const active = $('recordingIndicator').dataset.active === 'true';
    $('recPill').hidden = !active; $('moreToggle').classList.toggle('active', active);
  }).observe($('recordingIndicator'), { attributes: true, attributeFilter: ['data-active'] });

  // ---- Lobby: optional camera check, and whether to join muted / with camera off.
  let preview = null, previewGeneration = 0;
  function stopPreview() {
    previewGeneration++;
    preview?.getTracks().forEach(track => track.stop()); preview = null;
    $('preview').srcObject = null; $('preview').hidden = true; $('previewEmpty').hidden = false;
  }
  $('previewToggle').onclick = async () => {
    const request = ++previewGeneration;
    try {
      const captured = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 } });
      if (request !== previewGeneration) { captured.getTracks().forEach(track => track.stop()); return; }
      preview?.getTracks().forEach(track => track.stop()); preview = captured;
      $('preview').srcObject = preview; $('preview').hidden = false; $('previewEmpty').hidden = true;
      $('lobbyCam').setAttribute('aria-pressed', 'false');
    } catch (error) { toast(`Camera unavailable: ${error.message}`); }
  };
  for (const [id, on, off] of [['lobbyMic', 'Microphone will be on', 'You’ll join muted'], ['lobbyCam', 'Camera will be on', 'You’ll join with camera off']]) {
    $(id).onclick = () => {
      const pressed = $(id).getAttribute('aria-pressed') !== 'true';
      $(id).setAttribute('aria-pressed', String(pressed)); $(id).title = pressed ? off : on;
      if (id === 'lobbyCam' && pressed) stopPreview();
      toast(pressed ? off : on);
    };
  }

  // ---- Audio settings dialog (the audio panel itself is driven by client/audio/controller.js).
  const openSettings = () => { closePopovers(); $('settingsModal').hidden = false; $('settingsModal').querySelector('[data-close-settings]').focus(); };
  const closeSettings = () => { $('settingsModal').hidden = true; };
  for (const el of document.querySelectorAll('[data-open-settings]')) el.addEventListener('click', openSettings);
  for (const el of document.querySelectorAll('[data-close-settings]')) el.addEventListener('click', closeSettings);
  $('settingsModal').addEventListener('click', event => { if (event.target === $('settingsModal')) closeSettings(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('settingsModal').hidden) closeSettings(); });

  // ---- Preferred language: chosen in the lobby, remembered on this device, and used as the caption language.
  // (When translated captions/speech arrive, this is also the language people will hear.)
  try { const saved = localStorage.getItem('preferred-language'); if (saved && [...$('preferredLanguage').options].some(o => o.value === saved)) $('preferredLanguage').value = saved; } catch {}
  const syncLanguage = (from, to) => {
    $(to).value = $(from).value;
    try { localStorage.setItem('preferred-language', $(from).value); } catch {}
  };
  $('transcriptionLanguage').value = $('preferredLanguage').value;
  $('preferredLanguage').addEventListener('change', () => syncLanguage('preferredLanguage', 'transcriptionLanguage'));
  $('transcriptionLanguage').addEventListener('change', () => syncLanguage('transcriptionLanguage', 'preferredLanguage'));

  // Private-message notices appear as toasts.
  new MutationObserver(() => { if ($('chatNotice').textContent && body.dataset.panel !== 'chat') toast($('chatNotice').textContent); })
    .observe($('chatNotice'), { childList: true, characterData: true, subtree: true });

  // ---- Phase: lobby before joining, call afterwards. Host tools move between the two.
  let clock = null;
  function setPhase(phase) {
    body.dataset.phase = phase;
    const slot = $(phase === 'call' ? 'ownerSlotCall' : 'ownerSlotLobby');
    if ($('roomOwner').parentElement !== slot) slot.append($('roomOwner'));
    clearInterval(clock); $('elapsed').textContent = '00:00';
    if (phase === 'call') {
      stopPreview(); closePopovers();
      const started = Date.now();
      clock = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000), h = Math.floor(s / 3600);
        $('elapsed').textContent = `${h ? `${h}:` : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }, 1000);
      if (matchMedia('(min-width: 1101px)').matches) openPanel('chat');
    } else { openPanel(''); body.classList.remove('alone'); }
  }

  function roomChanged(room) {
    const name = room?.name || 'Meeting';
    $('roomTitle').textContent = name; $('lobbyTitle').textContent = room ? name : 'No meeting selected';
    document.title = `${name} · FYP Streaming Lab`;
    $('lockBadge').hidden = !room?.locked;
  }
  function identityChanged(identity) {
    const text = initials(identity?.name);
    $('myInitials').textContent = text; $('previewInitials').textContent = text;
  }

  // ---- Styled confirmation, used for "End meeting for everyone?".
  function confirmDialog({ title, text, ok }) {
    return new Promise(resolve => {
      $('confirmTitle').textContent = title; $('confirmText').textContent = text; $('confirmOk').textContent = ok;
      $('confirmModal').hidden = false; $('confirmCancel').focus();
      const done = value => { $('confirmModal').hidden = true; $('confirmOk').onclick = $('confirmCancel').onclick = null; resolve(value); };
      $('confirmOk').onclick = () => done(true); $('confirmCancel').onclick = () => done(false);
    });
  }

  return { preferredLanguage: () => $('preferredLanguage').value, setPhase, roomChanged, identityChanged, confirmDialog, stopPreview, toast,
    joinMuted: () => $('lobbyMic').getAttribute('aria-pressed') === 'true',
    joinCameraOff: () => $('lobbyCam').getAttribute('aria-pressed') === 'true',
    setAlone: alone => body.classList.toggle('alone', alone) };
}
