const WS_URL = 'ws://127.0.0.1:5055';
const PORT_NAME = 'island-bridge';
const MAX_RETRY_DELAY_MS = 5000;

let ws = null;
let retry = 0;
let reconnectTimer = null;
let lastState = null;
let lastQueue = null;

/** tabId -> { port, connectedAt, lastPlayingAt, playing, lastState, lastQueue } */
const tabs = new Map();
// The tab whose player the island currently shows.
let mirroredTabId = null;

function wsSend(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** retry);
  retry += 1;
  reconnectTimer = setTimeout(connect, delay);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(reconnectTimer);

  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;
  // A socket replaced while CLOSING still fires its events; acting on them would null the
  // new socket and open a third one, and every command would then run twice.
  const current = () => ws === socket;

  socket.onopen = () => {
    if (!current()) return;
    retry = 0;
    wsSend({ type: 'hello', client: 'music-island-extension', version: chrome.runtime.getManifest().version });
    if (lastState) wsSend({ type: 'state', data: lastState });
    if (lastQueue) wsSend({ type: 'queue', data: lastQueue });
    else activePort()?.postMessage({ type: 'command', command: 'refresh_queue' });
  };

  socket.onmessage = (event) => {
    if (!current()) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg?.type === 'command') activePort()?.postMessage(msg);
  };

  socket.onclose = () => {
    if (!current()) return;
    ws = null;
    scheduleReconnect();
  };

  // onclose always follows onerror; reconnect is scheduled there.
  socket.onerror = () => {};
}

// A playing tab beats a paused one; among equals, the one that started playing last wins.
function rank(entry) {
  return [entry.playing ? 1 : 0, entry.lastPlayingAt, entry.connectedAt];
}

function activeTabId() {
  let best = null;
  for (const [tabId, entry] of tabs) {
    const r = rank(entry);
    const b = best && rank(best.entry);
    if (!best || r[0] > b[0] || (r[0] === b[0] && (r[1] > b[1] || (r[1] === b[1] && r[2] > b[2])))) {
      best = { tabId, entry };
    }
  }
  return best ? best.tabId : null;
}

function activePort() {
  const id = activeTabId();
  return id == null ? null : tabs.get(id).port;
}

// When another tab takes over (say Spotify starts while SoundCloud is paused), the island must
// switch at once to that tab's last state and queue, not keep the previous service's queue
// until the new tab happens to change track.
// Returns true when it switched, i.e. it has just sent that tab's state and queue itself.
function syncActive({ force = false } = {}) {
  const id = activeTabId();
  if (id === mirroredTabId && !force) return false;
  mirroredTabId = id;
  if (id == null) {
    lastState = null;
    lastQueue = null;
    wsSend({ type: 'tab_closed' });
    return true;
  }
  const entry = tabs.get(id);
  lastState = entry.lastState;
  lastQueue = entry.lastQueue || { items: [], fetchedAt: Date.now() };
  if (lastState) wsSend({ type: 'state', data: lastState });
  wsSend({ type: 'queue', data: lastQueue });
  if (!entry.lastQueue) entry.port.postMessage({ type: 'command', command: 'refresh_queue' });
  return true;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME || !port.sender?.tab) return;
  const tabId = port.sender.tab.id;
  tabs.set(tabId, { port, connectedAt: Date.now(), lastPlayingAt: 0, playing: false, lastState: null, lastQueue: null });
  connect();

  port.onMessage.addListener((msg) => {
    const entry = tabs.get(tabId);
    if (!entry || entry.port !== port) return;
    if (msg.type === 'state') {
      const playing = Boolean(msg.data?.isPlaying);
      // Only the moment playback starts counts: if two tabs play at once, stamping every
      // report would hand the island back and forth between them twice a second.
      if (playing && !entry.playing) entry.lastPlayingAt = Date.now();
      entry.playing = playing;
      entry.lastState = msg.data;
    } else if (msg.type === 'queue') {
      entry.lastQueue = msg.data;
    }

    // With several player tabs open, only the one that started playing last is mirrored.
    if (syncActive() || activeTabId() !== tabId) return;

    if (msg.type === 'state') {
      lastState = msg.data;
      wsSend(msg);
    } else if (msg.type === 'queue') {
      lastQueue = msg.data;
      wsSend(msg);
    }
  });

  port.onDisconnect.addListener(() => {
    // A re-injected content script may already have replaced this port for the same tab.
    if (tabs.get(tabId)?.port !== port) return;
    tabs.delete(tabId);
    if (mirroredTabId !== tabId) return;
    syncActive({ force: true });
    // Its queue was stored while it was in the background and may be behind.
    activePort()?.postMessage({ type: 'command', command: 'refresh_queue' });
  });
});

// Tabs opened before install/reload have no content script (or an orphaned one); inject the
// same files the manifest declares for each site, in their declared worlds.
chrome.runtime.onInstalled.addListener(async () => {
  for (const script of chrome.runtime.getManifest().content_scripts || []) {
    const found = await chrome.tabs.query({ url: script.matches });
    for (const tab of found) {
      const target = { tabId: tab.id };
      if (script.css) chrome.scripting.insertCSS({ target, files: script.css }).catch(() => {});
      chrome.scripting.executeScript({ target, files: script.js, world: script.world || 'ISOLATED' }).catch(() => {});
    }
  }
});

connect();
