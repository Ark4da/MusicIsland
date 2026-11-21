const $ = (id) => document.getElementById(id);

const ui = {
  island: $('island'),
  artImgs: [...document.querySelectorAll('.artwork__img')],
  glassImgs: [...document.querySelectorAll('.glass__img')],
  title: $('title'),
  artist: $('artist'),
  eq: $('eq'),
  elapsed: $('elapsed'),
  remaining: $('remaining'),
  bar: $('bar'),
  barFill: $('barFill'),
  shuffle: $('btnShuffle'),
  prev: $('btnPrev'),
  play: $('btnPlay'),
  next: $('btnNext'),
  like: $('btnLike'),
  refresh: $('btnRefresh'),
  volumeRow: $('volumeRow'),
  mute: $('btnMute'),
  volBar: $('volBar'),
  volFill: $('volFill'),
  queue: document.querySelector('.queue'),
  queueEmpty: $('queueEmpty'),
  service: $('service'),
  queueList: $('queueList'),
};

const MARQUEE_SPEED_PX_S = 32;
const QUEUE_LOADING_TIMEOUT_MS = 4000;

// Until main sends the configured language, guess from the same system languages it would use.
let lang = window.i18n.pickLanguage(navigator.languages);
let t = window.i18n.translator(lang);

function applyLanguage(next) {
  lang = next;
  t = window.i18n.translator(lang);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}

let connected = false;
let state = { hasTrack: false };
let trackKey = '';
// Playback clock: the browser reports time at ~1 s resolution, so the bar is
// extrapolated between reports to move smoothly.
let clock = { elapsed: 0, duration: 0, playing: false, at: performance.now() };
let seekPreview = null;

const formatTime = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};

let artFront = 0;
let artUrl = null;

function setArtwork(url) {
  if (url === artUrl) return;
  artUrl = url;
  const back = ui.artImgs[1 - artFront];
  const front = ui.artImgs[artFront];
  // The glass tint is the same artwork, blurred: it crossfades in step with the cover.
  const glassBack = ui.glassImgs[1 - artFront];
  const glassFront = ui.glassImgs[artFront];
  if (!url) {
    for (const img of [front, back, glassFront, glassBack]) img.classList.remove('is-shown');
    return;
  }
  back.onload = () => {
    if (artUrl !== url) return;
    glassBack.src = url;
    for (const img of [back, glassBack]) img.classList.add('is-shown');
    for (const img of [front, glassFront]) img.classList.remove('is-shown');
    artFront = 1 - artFront;
  };
  back.onerror = () => back.classList.remove('is-shown');
  back.src = url;
}

function setTitle(text, force = false) {
  const track = ui.title.querySelector('.marquee__track');
  if (!force && track.dataset.text === text) return;
  track.dataset.text = text;
  ui.title.classList.remove('is-scrolling');
  startMarquee(0);
  track.replaceChildren(makeSpan(text));
  requestAnimationFrame(() => {
    // A newer title may have replaced this one before the frame; its own callback handles it.
    if (track.dataset.text !== text) return;
    const overflow = track.scrollWidth > ui.title.clientWidth + 1;
    if (!overflow) return;
    track.append(makeSpan(text));
    ui.title.classList.add('is-scrolling');
    // One copy plus its gap: after moving this far the second copy sits where the first began.
    startMarquee(track.scrollWidth / 2);
  });
}

function makeSpan(text) {
  const span = document.createElement('span');
  span.className = 'marquee__text';
  span.textContent = text;
  return span;
}

function applyState(next) {
  state = next || { hasTrack: false };
  const live = connected && state.hasTrack;
  ui.island.classList.toggle('is-disconnected', !live);
  ui.island.classList.toggle('is-playing', live && state.isPlaying);
  ui.eq.classList.toggle('is-playing', live && state.isPlaying);

  if (!connected) {
    setTitle(t('notConnected'));
    ui.artist.textContent = t('openPlayer');
    setArtwork(null);
  } else if (!state.hasTrack) {
    setTitle(t('nothingPlaying'));
    ui.artist.textContent = t('startTrack');
    setArtwork(null);
  } else {
    setTitle(state.title);
    ui.artist.textContent = state.artist;
    setArtwork(state.artwork);
  }

  applyCapabilities(live);
  ui.shuffle.classList.toggle('is-active', live && state.isShuffle);
  const wasLiked = ui.like.classList.contains('is-active');
  if (wasLiked !== Boolean(live && state.isLiked)) ui.like.classList.toggle('is-active');

  const key = state.trackUrl || `${state.title}|${state.artist}`;
  const sameTrack = key === trackKey;
  trackKey = key;

  const elapsed = state.elapsed || 0;
  const predicted = currentElapsed();
  const drift = elapsed - predicted;
  clock = {
    // Small drift is blended in instead of snapping, so the bar never jitters backwards
    // on the 1 s granularity of SoundCloud's time label.
    elapsed: sameTrack && state.isPlaying && clock.playing && Math.abs(drift) < 1.5
      ? predicted + drift * 0.25
      : elapsed,
    duration: state.duration || 0,
    playing: live && state.isPlaying,
    at: performance.now(),
  };
  scheduleRender();
  updateMotion();
  updateCollapse();
  renderVolume();
}

// Volume of the SoundCloud player itself, i.e. of that browser tab only — not the system mixer.
const VOLUME_STEP = 0.05;
const VOLUME_SEND_INTERVAL_MS = 60;
// After a local change the browser still reports the old value for a moment; holding the local
// value avoids the slider jumping back and forth.
const VOLUME_HOLD_MS = 800;

let volumePreview = null;
let localVolume = null;
let volumeHoldUntil = 0;
let lastVolumeSend = 0;

function shownVolume() {
  if (volumePreview != null) return volumePreview;
  if (localVolume != null && performance.now() < volumeHoldUntil) return localVolume;
  if (state.volume == null) return null;
  return state.muted ? 0 : state.volume;
}

function renderVolume() {
  const v = shownVolume();
  ui.volumeRow.classList.toggle('is-unavailable', v == null);
  ui.volFill.style.width = `${Math.round((v || 0) * 100)}%`;
  ui.mute.classList.toggle('is-muted', !v);
  ui.mute.classList.toggle('is-low', v > 0 && v < 0.5);
}

function sendVolume(value, force = false) {
  localVolume = value;
  volumeHoldUntil = performance.now() + VOLUME_HOLD_MS;
  renderVolume();
  const now = performance.now();
  if (!force && now - lastVolumeSend < VOLUME_SEND_INTERVAL_MS) return;
  lastVolumeSend = now;
  window.island.send('set_volume', { value });
}

function volumeFromEvent(event) {
  const rect = ui.volBar.getBoundingClientRect();
  return Math.round(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * 100) / 100;
}

ui.volBar.addEventListener('pointerdown', (event) => {
  if (state.volume == null) return;
  try {
    ui.volBar.setPointerCapture(event.pointerId);
  } catch {
    /* synthetic or already-released pointer */
  }
  volumePreview = volumeFromEvent(event);
  sendVolume(volumePreview);
});

ui.volBar.addEventListener('pointermove', (event) => {
  if (volumePreview == null) return;
  volumePreview = volumeFromEvent(event);
  sendVolume(volumePreview);
});

const endVolumeDrag = (event) => {
  if (volumePreview == null) return;
  const value = event.type === 'pointerup' ? volumeFromEvent(event) : volumePreview;
  volumePreview = null;
  sendVolume(value, true);
};
ui.volBar.addEventListener('pointerup', endVolumeDrag);
ui.volBar.addEventListener('pointercancel', endVolumeDrag);

ui.mute.addEventListener('click', () => {
  window.island.send('toggle_mute');
  // Unmuting restores SoundCloud's own previous level, which only the next state report knows.
  localVolume = shownVolume() ? 0 : null;
  volumeHoldUntil = localVolume === 0 ? performance.now() + VOLUME_HOLD_MS : 0;
  renderVolume();
});

// Pause between tracks reports isPlaying=false for a moment; without the delay the island
// would flicker shut on every track change.
const COLLAPSE_DELAY_MS = 1500;
const HOVER_LINGER_MS = 2500;
const CLICK_SLOP_PX = 4;

let collapsed = true;
let collapseMode = 'paused';
// Collapsed by hand (double-click or menu): stays a pill, music or not, until the pill is clicked.
let manualCollapse = false;
let peek = false;
let hovering = false;
let collapseTimer = null;
let lingerTimer = null;

function shouldExpand() {
  if (manualCollapse) return false;
  if (peek || (hovering && !collapsed)) return true;
  if (collapseMode === 'never') return true;
  if (collapseMode === 'always') return false;
  return connected && state.hasTrack && state.isPlaying;
}

function collapseNow() {
  if (collapsed) return;
  manualCollapse = true;
  peek = false;
  clearTimeout(collapseTimer);
  collapseTimer = null;
  setCollapsed(true);
}

function setCollapsed(on) {
  if (on === collapsed) return;
  collapsed = on;
  ui.island.classList.toggle('is-collapsed', on);
}

function updateCollapse() {
  if (shouldExpand()) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
    setCollapsed(false);
  } else if (!collapsed && !collapseTimer) {
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      if (!shouldExpand()) setCollapsed(true);
    }, COLLAPSE_DELAY_MS);
  }
}

// The title width differs between the card and the pill (narrower, smaller font): whether it
// needs the marquee is decided again once the morph has finished, in both directions.
ui.island.addEventListener('transitionend', (event) => {
  if (event.target !== ui.island || event.propertyName !== 'width') return;
  setTitle(ui.title.querySelector('.marquee__track').dataset.text || '', true);
});

ui.island.addEventListener('mouseenter', () => {
  hovering = true;
  clearTimeout(lingerTimer);
});

ui.island.addEventListener('mouseleave', () => {
  hovering = false;
  clearTimeout(lingerTimer);
  lingerTimer = setTimeout(() => {
    peek = false;
    updateCollapse();
  }, HOVER_LINGER_MS);
});

function currentElapsed() {
  const { elapsed, duration, playing, at } = clock;
  const value = playing ? elapsed + (performance.now() - at) / 1000 : elapsed;
  return duration ? Math.min(value, duration) : value;
}

let lastElapsedText = '';
let lastRemainingText = '';
let renderQueued = 0;

// The island is always on screen, so frames are drawn only while something moves:
// an idle rAF loop costs several percent of a core for a static picture.
function scheduleRender() {
  if (!renderQueued) renderQueued = requestAnimationFrame(renderClock);
}

function renderClock() {
  renderQueued = 0;
  const duration = clock.duration;
  const elapsed = seekPreview != null ? seekPreview * duration : currentElapsed();
  const ratio = duration ? Math.min(1, elapsed / duration) : 0;
  ui.barFill.style.width = `${(ratio * 100).toFixed(3)}%`;

  const e = formatTime(elapsed);
  // Rounded up like SoundCloud's own label, so elapsed + remaining always adds up to the duration.
  const r = `-${formatTime(Math.ceil(duration - elapsed))}`;
  if (e !== lastElapsedText) ui.elapsed.textContent = lastElapsedText = e;
  if (r !== lastRemainingText) ui.remaining.textContent = lastRemainingText = r;
}

// Motion. One timer moves the marquee, the equalizer and the clock together, so the GPU composes
// one frame per tick: 30 fps while the title scrolls, 12 fps otherwise, nothing on pause or when
// the island is hidden. Three CSS animations at 60 fps cost about 0.4 s of CPU per second.
const MARQUEE_FPS = 30;
const EQ_FPS = 12;
const CLOCK_INTERVAL_MS = 250;
const MARQUEE_HOLD_MS = 3000;

const marquee = { distance: 0, since: performance.now() };
let motionTimer = null;
let lastClockAt = 0;
let lastEqAt = 0;
let windowHidden = false;

function startMarquee(distance) {
  marquee.distance = distance;
  marquee.since = performance.now();
  ui.title.querySelector('.marquee__track').style.transform = '';
}

// Returns whether the title is in its moving phase (it rests MARQUEE_HOLD_MS at the start of each lap).
function renderMarquee(now) {
  if (!marquee.distance) return false;
  const travelMs = (marquee.distance / MARQUEE_SPEED_PX_S) * 1000;
  const phase = (now - marquee.since) % (MARQUEE_HOLD_MS + travelMs);
  const x = phase < MARQUEE_HOLD_MS ? 0 : ((phase - MARQUEE_HOLD_MS) / travelMs) * marquee.distance;
  ui.title.querySelector('.marquee__track').style.transform = x ? `translateX(${-x.toFixed(1)}px)` : '';
  return phase >= MARQUEE_HOLD_MS;
}

// Each bar mixes two slow waves with its own periods, which reads as music rather than a pattern.
const EQ_WAVES = [[0.82, 1.9], [0.58, 1.3], [0.97, 2.3], [0.69, 1.7]];

function renderEq(now) {
  const t = now / 1000;
  ui.eq.querySelectorAll('span').forEach((bar, i) => {
    const [a, b] = EQ_WAVES[i];
    const level = 0.6 * Math.abs(Math.sin((Math.PI * t) / a + i)) + 0.4 * Math.abs(Math.sin((Math.PI * t) / b + 2 * i));
    bar.style.transform = `scaleY(${(0.22 + 0.78 * level).toFixed(2)})`;
  });
}

function motionTick() {
  motionTimer = null;
  const now = performance.now();
  if (now - lastClockAt >= CLOCK_INTERVAL_MS) {
    lastClockAt = now;
    renderClock();
  }
  if (now - lastEqAt >= 1000 / EQ_FPS - 4) {
    lastEqAt = now;
    renderEq(now);
  }
  const scrolling = renderMarquee(now);
  motionTimer = setTimeout(motionTick, 1000 / (scrolling ? MARQUEE_FPS : EQ_FPS));
}

function updateMotion() {
  const run = clock.playing && !windowHidden;
  if (run && !motionTimer) {
    motionTick();
  } else if (!run && motionTimer) {
    clearTimeout(motionTimer);
    motionTimer = null;
    // Back to the CSS rest silhouette and the title's start.
    ui.eq.querySelectorAll('span').forEach((bar) => (bar.style.transform = ''));
    marquee.since = performance.now();
    ui.title.querySelector('.marquee__track').style.transform = '';
    scheduleRender();
  }
}

window.island.onVisibility((visible) => {
  windowHidden = !visible;
  updateMotion();
});

function ratioFromEvent(event) {
  const rect = ui.bar.getBoundingClientRect();
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

ui.bar.addEventListener('pointerdown', (event) => {
  if (!clock.duration) return;
  try {
    ui.bar.setPointerCapture(event.pointerId);
  } catch {
    /* synthetic or already-released pointer */
  }
  seekPreview = ratioFromEvent(event);
  scheduleRender();
});

ui.bar.addEventListener('pointermove', (event) => {
  if (seekPreview == null) return;
  seekPreview = ratioFromEvent(event);
  scheduleRender();
});

ui.bar.addEventListener('pointerup', (event) => {
  if (seekPreview == null) return;
  const value = ratioFromEvent(event);
  seekPreview = null;
  window.island.send('seek', { value });
  clock = { ...clock, elapsed: value * clock.duration, at: performance.now() };
  scheduleRender();
});

ui.bar.addEventListener('pointercancel', () => {
  seekPreview = null;
  scheduleRender();
});

const bind = (el, command) =>
  el.addEventListener('click', () => {
    if (!el.classList.contains('is-unavailable')) window.island.send(command);
  });

ui.shuffle.addEventListener('click', () => {
  if (ui.shuffle.classList.contains('is-unavailable')) return;
  if (state.isShuffle && caps.unshuffle === false) return;
  window.island.send('shuffle');
});
bind(ui.prev, 'prev');
bind(ui.next, 'next');

ui.play.addEventListener('click', () => {
  window.island.send('play_pause');
  // Optimistic flip; the next state report from the browser confirms or reverts it.
  applyState({ ...state, isPlaying: !state.isPlaying });
});

ui.like.addEventListener('click', () => {
  if (ui.like.classList.contains('is-unavailable')) return;
  // Spotify can save a track but not un-save it from its player bar (that opens a dialog).
  if (state.isLiked && caps.unlike === false) return;
  window.island.send('like');
  applyState({ ...state, isLiked: !state.isLiked });
});

let queueLoadingTimer = null;

function setQueueLoading(on) {
  clearTimeout(queueLoadingTimer);
  ui.refresh.classList.toggle('is-loading', on);
  if (on) queueLoadingTimer = setTimeout(() => setQueueLoading(false), QUEUE_LOADING_TIMEOUT_MS);
}

ui.refresh.addEventListener('click', () => {
  setQueueLoading(true);
  window.island.send('refresh_queue');
});

let queueKey = null;

const SERVICE_NAMES = {
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  'youtube-music': 'YouTube Music',
  'apple-music': 'Apple Music',
};

// Controls a service cannot drive stay in place but greyed out, so the card keeps one layout.
// Extension builds from before the adapters send no capabilities: they are SoundCloud with all.
let caps = {};

function applyCapabilities(live) {
  caps = { like: true, unlike: true, shuffle: true, queue: true, volume: true, seek: true, ...(state.capabilities || {}) };
  const service = SERVICE_NAMES[state.service] || 'SoundCloud';
  ui.service.textContent = live ? ` · ${service}` : '';
  const gate = (el, available) => {
    const off = live && !available;
    el.classList.toggle('is-unavailable', off);
    el.title = off ? t('unavailableIn', { service }) : t(el.dataset.i18nTitle);
  };
  gate(ui.like, caps.like);
  gate(ui.shuffle, caps.shuffle);
  // On and unable to switch off from here: keep the active colour, explain instead of acting.
  if (live && state.isLiked && caps.unlike === false) ui.like.title = t('unlikeOnlyIn', { service });
  if (live && state.isShuffle && caps.unshuffle === false) ui.shuffle.title = t('unshuffleOnlyIn', { service });
  ui.bar.classList.toggle('is-unavailable', live && !caps.seek);
  const noQueue = live && !caps.queue;
  ui.queue.classList.toggle('is-unavailable', noQueue);
  ui.queueEmpty.textContent = noQueue ? t('queueUnavailable', { service }) : t('queueEmpty');
}

function renderQueue(queue) {
  setQueueLoading(false);
  const items = (queue && queue.items) || [];
  const key = JSON.stringify(items);
  if (key === queueKey) return;
  queueKey = key;
  ui.queue.classList.toggle('is-empty', items.length === 0);

  const fragment = document.createDocumentFragment();
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'queue__item';
    li.style.animationDelay = `${Math.min(i, 8) * 25}ms`;
    li.title = `${item.title} — ${item.artist}`;

    const img = document.createElement('img');
    img.className = 'queue__art';
    img.alt = '';
    img.draggable = false;
    if (item.artwork) img.src = item.artwork;

    const text = document.createElement('div');
    text.className = 'queue__text';
    const title = document.createElement('span');
    title.className = 'queue__title';
    title.textContent = item.title;
    const artist = document.createElement('span');
    artist.className = 'queue__artist';
    artist.textContent = item.artist;
    text.append(title, artist);

    li.append(img, text);
    li.addEventListener('click', () => window.island.send('play_queue_item', { index: item.index }));
    fragment.append(li);
  });

  const scroll = ui.queueList.scrollTop;
  ui.queueList.replaceChildren(fragment);
  ui.queueList.scrollTop = scroll;
}

window.island.onConnection((value) => {
  connected = Boolean(value);
  if (!connected) renderQueue({ items: [] });
  applyState(state);
});

// Dragging is done in JS instead of `-webkit-app-region: drag`: native drag regions turn into
// window caption on Windows, which only covered part of the card and swallowed right-click and wheel.
const NOT_DRAGGABLE = 'button, .bar, .queue__list';
let dragPointer = null;
let dragFrom = null;

ui.island.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest(NOT_DRAGGABLE)) return;
  dragPointer = event.pointerId;
  dragFrom = { x: event.screenX, y: event.screenY };
  ui.island.setPointerCapture(dragPointer);
  ui.island.classList.add('is-dragging');
  window.island.drag('start');
});

ui.island.addEventListener('pointermove', (event) => {
  if (event.pointerId === dragPointer) window.island.drag('move');
});

const endDrag = (event) => {
  if (event.pointerId !== dragPointer) return;
  dragPointer = null;
  ui.island.classList.remove('is-dragging');
  window.island.drag('end');
  // A click (not a drag) on the pill opens the island until the mouse leaves it,
  // so playback can be started from here while nothing is playing.
  const moved = dragFrom && Math.hypot(event.screenX - dragFrom.x, event.screenY - dragFrom.y);
  if (event.type === 'pointerup' && collapsed && moved < CLICK_SLOP_PX) {
    manualCollapse = false;
    peek = true;
    updateCollapse();
  }
};

// Double-click on the card itself (not on a control or the queue) folds it into the pill at once.
ui.island.addEventListener('dblclick', (event) => {
  if (collapsed || event.target.closest(NOT_DRAGGABLE)) return;
  collapseNow();
});

window.island.onCollapseNow(collapseNow);

// The window keeps its full size while the card is a pill, so its empty part must not swallow
// clicks meant for the windows below. Ignored mouse events are still forwarded as mousemove,
// which is how the cursor coming back over the card is noticed.
let interactive = null;

function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  window.island.setInteractive(on);
}

document.addEventListener('mousemove', (event) => {
  if (dragPointer != null) return;
  setInteractive(Boolean(event.target.closest('.island')));
});
document.documentElement.addEventListener('mouseleave', () => {
  if (dragPointer == null) setInteractive(false);
});

window.island.onSettings((settings) => {
  collapseMode = settings.collapseMode || 'paused';
  const theme = settings.theme || 'cover';
  ui.island.dataset.theme = theme;
  ui.island.classList.toggle('is-glass', theme !== 'black');
  ui.island.dataset.accent = settings.accent || 'blue';
  if (settings.lang && settings.lang !== lang) {
    applyLanguage(settings.lang);
    applyState(state);
  }
  updateCollapse();
});
ui.island.addEventListener('pointerup', endDrag);
ui.island.addEventListener('pointercancel', endDrag);
ui.island.addEventListener('lostpointercapture', endDrag);

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.island.menu();
});

// Ctrl + wheel resizes the island; a plain wheel over the card changes the tab's volume,
// except over the queue list, which it scrolls.
window.addEventListener('wheel', (event) => {
  if (event.ctrlKey) {
    event.preventDefault();
    window.island.scale(event.deltaY < 0 ? 1 : -1);
    return;
  }
  if (event.target.closest('.queue__list') || !event.target.closest('.island')) return;
  const current = shownVolume();
  if (current == null || !connected || collapsed) return;
  event.preventDefault();
  const next = Math.round(Math.min(1, Math.max(0, current + (event.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP))) * 100) / 100;
  sendVolume(next, true);
}, { passive: false });

window.island.onState(applyState);
window.island.onQueue(renderQueue);

applyLanguage(lang);
renderQueue({ items: [] });
applyState(state);
