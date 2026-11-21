// Spotify web player (spike S7). Labels are localised, so state is read from data-testid hooks,
// icon shapes and input values, never from aria-label text.
(() => {
  const { $, $$, sleep, warn, clamp01, parseTime, tap, pressAt, click } = globalThis.MI;

  const QUEUE_SYNC_TIMEOUT_MS = 2500;
  // Closing the queue tab animates for about a second; keep it hidden until it is gone.
  const QUEUE_CLOSE_SETTLE_MS = 1300;

  const tid = (id, root = document) => $(`[data-testid="${id}"]`, root);
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

  // The pause icon (shown while playing) starts with this path; the play icon does not.
  const PAUSE_ICON_PREFIX = 'M2.7 1a';

  let panelOpenedForTrack = null;

  const widget = () => tid('now-playing-widget-v2') || tid('now-playing-widget');

  function shuffleButton() {
    const back = tid('control-button-skip-back');
    const buttons = $$('button', tid('player-controls') || document);
    const index = buttons.indexOf(back);
    return index > 0 ? buttons[index - 1] : null;
  }

  // Album art ids carry the size: …4851 = 64 px, …1e02 = 300 px, …b273 = 640 px.
  const coverAt300 = (url) => (url ? url.replace(/(ab67616d0000)[0-9a-f]{4}/, '$11e02') : null);

  function artwork(title) {
    // The page's own Media Session entry lists proper sizes; use it while it describes this track.
    const meta = navigator.mediaSession?.metadata;
    if (meta && meta.title === title && meta.artwork?.length) {
      const sized = [...meta.artwork].map((a) => ({ src: a.src, size: parseInt(a.sizes, 10) || 0 }));
      const pick = sized.filter((a) => a.size >= 200).sort((a, b) => a.size - b.size)[0] || sized.sort((a, b) => b.size - a.size)[0];
      if (pick?.src) return pick.src;
    }
    return coverAt300(tid('cover-art-image', widget() || document)?.src || null);
  }

  function readTimes() {
    const input = $('input[type="range"]', tid('playback-progressbar') || document.createElement('div'));
    let elapsed = Number(input?.value) / 1000;
    let duration = Number(input?.max) / 1000;
    if (!Number.isFinite(elapsed) || !Number.isFinite(duration) || !duration) {
      elapsed = parseTime(text(tid('playback-position'))) ?? 0;
      duration = parseTime(text(tid('playback-duration'))) ?? 0;
    }
    return { elapsed, duration };
  }

  function readVolume() {
    const input = $('input[type="range"]', tid('volume-bar') || document.createElement('div'));
    // The value attribute keeps full precision; input.value is rounded to the 0.1 step.
    const value = parseFloat(input?.getAttribute('value'));
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  }

  function readState() {
    const root = widget();
    const title = text(tid('context-item-link', root || document));
    const byline = tid('now-playing-widget-v2-byline', root || document);
    const artists = byline ? $$('a', byline).map(text) : $$('[data-testid="context-item-info-artist"]', root || document).map(text);
    const { elapsed, duration } = readTimes();
    const icon = $('svg path', tid('control-button-playpause') || document.createElement('div'))?.getAttribute('d') || '';
    const like = root && $('button[aria-checked]', root);
    const volume = readVolume();

    return {
      hasTrack: Boolean(title),
      title,
      artist: artists.join(', ') || text(byline),
      artwork: title ? artwork(title) : null,
      trackUrl: null,
      isPlaying: icon.startsWith(PAUSE_ICON_PREFIX),
      isLiked: like?.getAttribute('aria-checked') === 'true',
      // Active toggles use the accent colour class; there is no aria state on the shuffle button.
      isShuffle: /bright-accent|positive/.test(shuffleButton()?.className || ''),
      elapsed: Math.round(elapsed * 10) / 10,
      duration: Math.round(duration),
      progress: duration ? Math.round(clamp01(elapsed / duration) * 10000) / 10000 : 0,
      volume,
      // Muting drags Spotify's slider to zero.
      muted: volume === 0,
    };
  }

  const queuePanel = () => $('[role="tabpanel"][aria-labelledby="queue-tab"]');
  const rowTitle = (row) => text($('[data-encore-id="listRowTitle"]', row));

  function rowArtist(row) {
    const subtitle = $('[data-encore-id="listRowSubtitle"]', row);
    const links = $$('a', subtitle || document.createElement('div')).map(text);
    return links.join(', ') || text(subtitle);
  }

  // The first row of the queue tab is the track now playing; everything after it is upcoming.
  function queueRows() {
    const panel = queuePanel();
    return panel ? $$('li[role="row"]', panel) : null;
  }

  function queueIsFresh() {
    const rows = queueRows();
    return Boolean(rows?.length) && rowTitle(rows[0]) === readState().title;
  }

  function parseQueue() {
    const rows = queueRows();
    if (!rows?.length) return null;
    return rows.slice(1).map((row, index) => ({
      index,
      title: rowTitle(row),
      artist: rowArtist(row),
      artwork: coverAt300($('img', row)?.src || null),
    }));
  }

  async function waitForFreshQueue() {
    const deadline = Date.now() + QUEUE_SYNC_TIMEOUT_MS;
    await sleep(300);
    while (!queueIsFresh() && Date.now() < deadline) await sleep(150);
    return queueIsFresh();
  }

  // The queue lives in the right-hand panel. It is opened invisibly for the read and the user's
  // previous panel is restored by toggling the same button again.
  async function withQueueOpen(read) {
    if (queuePanel()) return (await waitForFreshQueue()) ? read() : null;
    const button = tid('control-button-queue');
    if (!button) {
      warn('queue button not found');
      return null;
    }
    const root = document.documentElement;
    root.classList.add('mi-stealth-queue');
    try {
      button.click();
      const result = (await waitForFreshQueue()) ? read() : null;
      if (queuePanel()) button.click();
      return result;
    } finally {
      setTimeout(() => root.classList.remove('mi-stealth-queue'), QUEUE_CLOSE_SETTLE_MS);
    }
  }

  async function readQueue({ force, key }) {
    let items = !force && queueIsFresh() ? parseQueue() : null;
    if (!items && (force || panelOpenedForTrack !== key)) {
      panelOpenedForTrack = key;
      items = await withQueueOpen(parseQueue);
    }
    return items;
  }

  async function playQueueItem({ index, expectedTitle }) {
    const pick = () => {
      const rows = queueRows()?.slice(1);
      if (!rows?.length) return null;
      let row = rows[index];
      if (expectedTitle && rowTitle(row) !== expectedTitle) row = rows.find((r) => rowTitle(r) === expectedTitle) || row;
      // A row plays on double-click, the same as with the mouse.
      if (row) tap($('[role="button"]', row) || row, { double: true, fx: 0.1 });
      return row;
    };
    const played = queuePanel() ? pick() : await withQueueOpen(pick);
    if (!played) warn('queue item not found:', index);
  }

  // React keeps range inputs controlled: set through the native setter so it sees the change.
  function seek({ value }) {
    const input = $('input[type="range"]', tid('playback-progressbar') || document.createElement('div'));
    if (!input) return warn('timeline not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(Math.round(clamp01(value) * Number(input.max))));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // The volume input has a 0.1 step, so it is set by pressing on the bar instead (full precision).
  function setVolume({ value }) {
    const bar = tid('progress-bar', tid('volume-bar') || document.createElement('div'));
    if (!bar) return warn('volume bar not found');
    pressAt(bar, clamp01(value));
  }

  function like() {
    const button = widget() && $('button[aria-checked]', widget());
    if (!button) return warn('like button not found');
    // On a saved track this button opens Spotify's "add to playlist" dialog instead of un-saving.
    if (button.getAttribute('aria-checked') === 'true') return warn('already saved; un-saving needs the dialog');
    button.click();
  }

  // A scripted click cycles off → shuffle → smart shuffle, but Spotify ignores it in smart shuffle
  // (leaving it takes a real click), so from the island shuffle can only be switched on.
  function shuffle() {
    if (readState().isShuffle) return warn('shuffle can only be turned off in Spotify itself');
    shuffleButton()?.click();
  }

  globalThis.__miAdapter = {
    service: 'spotify',
    capabilities: { like: true, unlike: false, shuffle: true, unshuffle: false, queue: true, volume: true, seek: true },
    observeRoot: () => tid('now-playing-bar') || $('footer'),
    readState,
    readQueue,
    commands: {
      play_pause: () => click('[data-testid="control-button-playpause"]'),
      next: () => click('[data-testid="control-button-skip-forward"]'),
      prev: () => click('[data-testid="control-button-skip-back"]'),
      shuffle,
      like,
      toggle_mute: () => click('[data-testid="volume-bar-toggle-mute-button"]'),
      seek,
      set_volume: setVolume,
      play_queue_item: playQueueItem,
    },
  };
})();
