// Service-independent half of the content script: the port to the service worker, the state
// push loop and queue scheduling. Everything about a particular player lives in the adapter that
// the manifest loads before this file, as globalThis.__miAdapter:
//
//   service        'soundcloud' | 'spotify' | 'youtube-music' | 'apple-music'
//   capabilities   { like, shuffle, queue, volume, seek }: what the island may offer for it
//   readState()    { hasTrack, title, artist, artwork, trackUrl, isPlaying, isLiked, isShuffle,
//                    elapsed, duration, progress, volume, muted }
//   readQueue({ force, key })  upcoming items, or null when they cannot be read right now
//   commands       { play_pause, next, prev, shuffle, like, seek, set_volume, toggle_mute,
//                    play_queue_item }: each receives the command message
//   observeRoot()  element whose mutations signal a player change (optional)
//   start(), stop()  optional lifecycle hooks
(() => {
  // A reloaded extension re-injects into the same isolated world; retire the orphaned instance.
  // __scIslandShutdown is the name used before the adapters existed.
  for (const key of ['__musicIslandShutdown', '__scIslandShutdown']) {
    if (typeof window[key] === 'function') window[key]();
  }

  const adapter = globalThis.__miAdapter;
  if (!adapter) return;
  const { warn } = globalThis.MI;

  const PORT_NAME = 'island-bridge';
  const POLL_MS = 500;
  const HEARTBEAT_MS = 5000;
  const QUEUE_RECHECK_MS = 30000;

  let port = null;
  let alive = true;
  let lastStateJson = '';
  let lastSentAt = 0;
  let lastTrackKey = '';
  let lastQueue = [];
  let queueBusy = false;
  let queueTimer = null;
  let queueSentForTrack = null;
  let observedRoot = null;
  const timers = [];

  const trackKey = (state) => state.trackUrl || `${state.title}|${state.artist}`;

  function readState() {
    let state;
    try {
      state = adapter.readState();
    } catch (err) {
      warn('readState failed:', err);
      state = { hasTrack: false };
    }
    return { ...state, service: adapter.service, capabilities: adapter.capabilities };
  }

  async function refreshQueue({ force = false } = {}) {
    if (!alive || queueBusy || !adapter.capabilities.queue) return;
    const current = readState();
    if (!current.hasTrack) return;
    queueBusy = true;
    try {
      const key = trackKey(current);
      let items = null;
      try {
        items = await adapter.readQueue({ force, key });
      } catch (err) {
        warn('readQueue failed:', err);
      }
      // Unreadable: an empty list is better than leaving the previous track's queue,
      // headed by the track now playing, on the island.
      if (!items && queueSentForTrack !== key) items = [];
      if (items && alive) {
        lastQueue = items;
        queueSentForTrack = key;
        send({ type: 'queue', data: { items, fetchedAt: Date.now() } });
      }
    } finally {
      queueBusy = false;
    }
  }

  function scheduleQueueRefresh(delay = 800) {
    clearTimeout(queueTimer);
    queueTimer = setTimeout(() => refreshQueue(), delay);
  }

  async function handleCommand(msg) {
    const { command } = msg;
    if (command === 'refresh_queue') {
      await refreshQueue({ force: true });
    } else if (typeof adapter.commands[command] === 'function') {
      // The island addresses queue items by index; the title lets the adapter notice a queue
      // that has shifted since the island last saw it.
      const expectedTitle = command === 'play_queue_item' ? lastQueue[msg.index]?.title : undefined;
      try {
        await adapter.commands[command]({ ...msg, expectedTitle });
      } catch (err) {
        warn(`${command} failed:`, err);
      }
    }
    setTimeout(() => pushState(true), 150);
  }

  function send(message) {
    if (!port) return;
    try {
      port.postMessage(message);
    } catch {
      port = null;
    }
  }

  function pushState(force = false) {
    if (!alive) return;
    const state = readState();
    const json = JSON.stringify(state);
    const now = Date.now();
    if (!force && json === lastStateJson && now - lastSentAt < HEARTBEAT_MS) return;
    lastStateJson = json;
    lastSentAt = now;
    send({ type: 'state', data: state });

    const key = trackKey(state);
    if (state.hasTrack && key !== lastTrackKey) {
      lastTrackKey = key;
      scheduleQueueRefresh();
    }
  }

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function shutdown() {
    alive = false;
    timers.forEach(clearInterval);
    clearTimeout(queueTimer);
    observer.disconnect();
    observedRoot = null;
    adapter.stop?.();
    try {
      port?.disconnect();
    } catch {
      /* already gone */
    }
    port = null;
  }

  function connect() {
    if (!extensionAlive()) return shutdown();
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      return shutdown();
    }
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'command') handleCommand(msg);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // The service worker restarts on its own; an invalidated context means the extension was reloaded.
      if (extensionAlive()) setTimeout(connect, 1000);
      else shutdown();
    });
    lastStateJson = '';
    pushState(true);
    if (lastQueue.length) send({ type: 'queue', data: { items: lastQueue, fetchedAt: Date.now() } });
  }

  // Background tabs throttle timers to ≥1 s (and to 1/min after 5 min of silence);
  // DOM mutations of the player bar still arrive promptly, so they drive updates too.
  let lastMutationPush = 0;
  const observer = new MutationObserver(() => {
    const now = Date.now();
    if (now - lastMutationPush < 250) return;
    lastMutationPush = now;
    pushState();
  });

  function observeControls() {
    const root = adapter.observeRoot?.();
    if (!root || root === observedRoot) return;
    observedRoot = root;
    observer.disconnect();
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'title', 'style', 'aria-label', 'aria-valuenow', 'aria-checked', 'value', 'like-status', 'src'],
    });
  }

  timers.push(setInterval(() => {
    observeControls();
    pushState();
  }, POLL_MS));
  timers.push(setInterval(() => refreshQueue(), QUEUE_RECHECK_MS));

  window.__musicIslandShutdown = shutdown;
  // Adapters fed by a page helper (Apple Music) push as soon as fresh data arrives.
  adapter.start?.({ onChange: () => pushState() });
  observeControls();
  connect();
})();
