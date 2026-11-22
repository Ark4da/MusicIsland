const { app, BrowserWindow, ipcMain, screen, dialog, Menu, Tray, nativeImage, nativeTheme, clipboard, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const i18n = require('./renderer/i18n');

const WS_HOST = '127.0.0.1';
const WS_PORT = 5055;
// The card is 356×462; the transparent margin must hold the whole CSS shadow,
// otherwise the window edge cuts it into a visible grey rectangle.
const BASE_WIDTH = 404;
const BASE_HEIGHT = 510;
const PING_INTERVAL_MS = 20000;
const SCALE_MIN = 0.7;
const SCALE_MAX = 1.6;
const SCALE_STEP = 0.05;
const SCALE_PRESETS = [0.8, 0.9, 1, 1.15, 1.3, 1.5];

const APP_NAME = 'Music Island';
const configPath = () => path.join(app.getPath('userData'), 'config.json');

// Until 2.0 the app was "SoundCloud Island" and kept its settings under that name in %APPDATA%.
function migrateOldConfig() {
  const target = configPath();
  const old = path.join(app.getPath('appData'), 'SoundCloud Island', 'config.json');
  try {
    if (!fs.existsSync(target) && fs.existsSync(old)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(old, target);
    }
  } catch (err) {
    console.error('[island] config migration failed:', err.message);
  }
}

let win = null;
let wss = null;
let scale = 1;
let lastState = null;
let lastQueue = null;
const clients = new Set();

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    console.error('[island] config write failed:', err.message);
  }
}

const clampScale = (value) =>
  Number(Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(value / SCALE_STEP) * SCALE_STEP)).toFixed(2));

const windowSize = (s = scale) => ({
  width: Math.round(BASE_WIDTH * s),
  height: Math.round(BASE_HEIGHT * s),
});

function isVisibleOnSomeDisplay(x, y) {
  const { width } = windowSize();
  return screen.getAllDisplays().some(({ workArea: a }) =>
    x >= a.x - width / 2 &&
    y >= a.y - 30 &&
    x + width / 2 <= a.x + a.width &&
    y + 60 <= a.y + a.height
  );
}

function defaultPosition() {
  const primary = screen.getPrimaryDisplay();
  const target = screen.getAllDisplays().find((d) => d.id !== primary.id) || primary;
  const a = target.workArea;
  return {
    x: Math.round(a.x + (a.width - windowSize().width) / 2),
    y: a.y,
  };
}

function initialPosition() {
  const { x, y } = readConfig();
  if (Number.isFinite(x) && Number.isFinite(y) && isVisibleOnSomeDisplay(x, y)) return { x, y };
  return defaultPosition();
}

// Resizing keeps the top edge and the horizontal centre in place, so the island grows
// downward and to both sides like the real Dynamic Island.
function setScale(value) {
  const next = clampScale(value);
  if (!win || next === scale) return;
  const [x, y] = win.getPosition();
  const before = windowSize();
  const after = windowSize(next);
  scale = next;
  win.setBounds({ x: Math.round(x + (before.width - after.width) / 2), y, ...after });
  win.webContents.setZoomFactor(scale);
  writeConfig({ scale });
}

// Colours themselves live in styles.css under [data-accent]; ids here only have to match.
const ACCENTS = [
  { id: 'auto', key: 'accentAuto' },
  { id: 'blue', key: 'accentBlue' },
  { id: 'violet', key: 'accentViolet' },
  { id: 'teal', key: 'accentTeal' },
  { id: 'green', key: 'accentGreen' },
  { id: 'pink', key: 'accentPink' },
  { id: 'amber', key: 'accentAmber' },
  { id: 'white', key: 'accentWhite' },
  { id: 'sunset', key: 'accentSunset' },
  { id: 'aurora', key: 'accentAurora' },
];

// Card backgrounds; the gradients themselves are in styles.css under [data-theme].
const THEMES = [
  { id: 'black', key: 'themeBlack' },
  { id: 'cover', key: 'themeCover' },
  { id: 'neon', key: 'themeNeon' },
  { id: 'sunset', key: 'themeSunset' },
  { id: 'ocean', key: 'themeOcean' },
  { id: 'aurora', key: 'themeAurora' },
  { id: 'frosted', key: 'themeFrosted' },
  { id: 'mono', key: 'themeMono' },
  { id: 'titanium', key: 'themeTitanium' },
  { id: 'soundcloud', key: 'themeSoundcloud' },
  { id: 'light', key: 'themeLight' },
];

const COLLAPSE_MODES = [
  { id: 'paused', key: 'collapsePaused' },
  { id: 'always', key: 'collapseAlways' },
  { id: 'never', key: 'collapseNever' },
];

function collapseModeFrom(config) {
  if (COLLAPSE_MODES.some((m) => m.id === config.collapseMode)) return config.collapseMode;
  // Configs from before the modes had only the "collapse when paused" checkbox.
  return config.autoCollapse === false ? 'never' : 'paused';
}

function themeFrom(config) {
  if (THEMES.some((theme) => theme.id === config.theme)) return config.theme;
  // Configs from before themes only had the glass on/off switch.
  return config.glass === false ? 'black' : 'cover';
}

// 'auto' follows the Windows display language, not the regional format: a Russian-speaking user
// with English Windows gets English, the same as every other app on that machine.
function languageFrom(config) {
  const choice = i18n.LANGUAGES.some((l) => l.id === config.language) ? config.language : 'auto';
  const lang = choice === 'auto' ? i18n.pickLanguage(app.getPreferredSystemLanguages()) : choice;
  return { choice, lang };
}

function settings() {
  const config = readConfig();
  const { choice, lang } = languageFrom(config);
  return {
    collapseMode: collapseModeFrom(config),
    theme: themeFrom(config),
    accent: ACCENTS.some((a) => a.id === config.accent) ? config.accent : 'blue',
    languageChoice: choice,
    lang,
  };
}

const t = (key, vars) => i18n.translator(settings().lang)(key, vars);

// Windows "Run" entry. A portable build unpacks itself into a temp folder on every start, so the
// entry must point at the .exe the user launched; a source checkout starts electron.exe with the app folder.
function loginItemOptions() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { path: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  if (app.isPackaged) return { path: process.execPath, args: [] };
  return { path: process.execPath, args: [path.resolve(app.getAppPath())] };
}

// Read back from Windows rather than from the config: the user can also switch it off in Task
// Manager (enabled = false). Looked up by our entry name: `openAtLogin` matches Electron's default
// entry name, not the one set below.
const launchesAtStartup = () =>
  app.getLoginItemSettings(loginItemOptions()).launchItems.some((item) => item.name === APP_NAME && item.enabled);

function setLaunchAtStartup(on) {
  app.setLoginItemSettings({ openAtLogin: on, name: APP_NAME, ...loginItemOptions() });
  writeConfig({ launchAtStartup: on });
}

// Artwork pixels for the "auto" accent. The covers live on the players' CDNs, and a page cannot read
// cross-origin pixels from a canvas, so main downloads the image and hands over a 32x32 RGBA thumbnail.
const ARTWORK_SAMPLE = 32;
const pixelCache = new Map();

async function artworkPixels(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  if (pixelCache.has(url)) return pixelCache.get(url);
  let result = null;
  try {
    const response = await net.fetch(url);
    if (response.ok) {
      const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
      if (!image.isEmpty()) {
        const bgra = image.resize({ width: ARTWORK_SAMPLE, height: ARTWORK_SAMPLE, quality: 'good' }).toBitmap();
        const rgba = new Uint8Array(bgra.length);
        for (let i = 0; i < bgra.length; i += 4) {
          rgba[i] = bgra[i + 2];
          rgba[i + 1] = bgra[i + 1];
          rgba[i + 2] = bgra[i];
          rgba[i + 3] = bgra[i + 3];
        }
        result = rgba;
      }
    }
  } catch (err) {
    console.error('[island] artwork fetch failed:', err.message);
  }
  if (pixelCache.size > 60) pixelCache.delete(pixelCache.keys().next().value);
  pixelCache.set(url, result);
  return result;
}

const sendSettings = () => sendToRenderer('island:settings', settings());

function updateSetting(patch) {
  writeConfig(patch);
  sendSettings();
}

// One menu for both places: a right-click on the island and the tray icon. The tray version
// starts with show/hide, since the island may be hidden and then has no surface to click.
function menuTemplate({ fromTray = false } = {}) {
  const percent = (s) => `${Math.round(s * 100)} %`;
  const current = settings();
  const tr = i18n.translator(current.lang);
  const radioList = (items, selected, field) =>
    items.map(({ id, key }) => ({
      label: tr(key),
      type: 'radio',
      checked: id === selected,
      click: () => updateSetting({ [field]: id }),
    }));
  const visible = Boolean(win && win.isVisible());
  return [
    ...(fromTray
      ? [{ label: tr(visible ? 'trayHide' : 'trayShow'), click: toggleWindow }, { type: 'separator' }]
      : []),
    { label: tr('menuAppearance'), submenu: radioList(THEMES, current.theme, 'theme') },
    { label: tr('menuAccent'), submenu: radioList(ACCENTS, current.accent, 'accent') },
    { type: 'separator' },
    { label: tr('menuSize', { percent: percent(scale) }), enabled: false },
    // Checkboxes, not radios: a radio group with nothing checked gets its first item checked by
    // Electron, so a scale set with Ctrl + wheel (say 120 %) showed a dot on 80 %.
    ...SCALE_PRESETS.map((s) => ({
      label: percent(s),
      type: 'checkbox',
      checked: Math.abs(s - scale) < 0.001,
      click: () => setScale(s),
    })),
    { type: 'separator' },
    { label: tr('menuSmaller'), click: () => setScale(scale - 0.1) },
    { label: tr('menuBigger'), click: () => setScale(scale + 0.1) },
    { type: 'separator' },
    { label: tr('menuCollapseNow'), click: () => sendToRenderer('island:collapse-now') },
    { label: tr('menuCollapse'), submenu: radioList(COLLAPSE_MODES, current.collapseMode, 'collapseMode') },
    {
      label: tr('menuLanguage'),
      submenu: [
        { id: 'auto', name: tr('menuLanguageAuto') },
        ...i18n.LANGUAGES,
      ].map(({ id, name }) => ({
        label: name,
        type: 'radio',
        checked: id === current.languageChoice,
        click: () => updateSetting({ language: id }),
      })),
    },
    {
      label: tr('menuStartup'),
      type: 'checkbox',
      checked: launchesAtStartup(),
      click: (item) => setLaunchAtStartup(item.checked),
    },
    { type: 'separator' },
    { label: tr('menuQuit'), click: () => app.quit() },
  ];
}

function showContextMenu() {
  Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
}

let tray = null;

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

// Windows cuts tray tooltips at 127 characters.
function updateTrayTooltip() {
  if (!tray) return;
  const track = lastState?.hasTrack ? `${lastState.title} — ${lastState.artist}` : '';
  const text = track ? `${APP_NAME}\n${track}` : APP_NAME;
  tray.setToolTip(text.length > 127 ? `${text.slice(0, 126)}…` : text);
}

// The tray glyph has no background of its own, so it must contrast with the taskbar: white on the
// dark Windows theme, near-black on the light one. Each file has @1.25x/@1.5x/@2x siblings that
// nativeImage picks by display scale.
function trayImage() {
  const file = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'tray.png' : 'tray-light.png';
  return nativeImage.createFromPath(path.join(__dirname, 'assets', file));
}

function createTray() {
  tray = new Tray(trayImage());
  nativeTheme.on('updated', () => tray?.setImage(trayImage()));
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate(menuTemplate({ fromTray: true }))));
  updateTrayTooltip();
}

let drag = null;

// The window is moved from here, using the OS cursor position rather than event coordinates
// from the renderer: those are relative to a window that is itself moving, which makes it jitter.
function handleDrag(phase) {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  if (phase === 'start') {
    const [x, y] = win.getPosition();
    drag = { dx: cursor.x - x, dy: cursor.y - y };
  } else if (phase === 'move' && drag) {
    // setBounds with an explicit size: setPosition across monitors with different DPI
    // lets Windows rescale the window.
    win.setBounds({ x: cursor.x - drag.dx, y: cursor.y - drag.dy, ...windowSize() });
  } else if (phase === 'end') {
    drag = null;
  }
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  const saved = Number(readConfig().scale);
  scale = Number.isFinite(saved) ? clampScale(saved) : 1;
  const { x, y } = initialPosition();
  win = new BrowserWindow({
    x,
    y,
    ...windowSize(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // Lives in the tray instead of the taskbar.
    skipTaskbar: true,
    // .ico carries 16–256 px, so Windows picks a crisp size for Alt+Tab and the window list.
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    title: APP_NAME,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' keeps the island above the taskbar and borderless-fullscreen apps;
  // the default 'floating' level loses to them on Windows.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => win.showInactive());
  // A hidden island (tray) stops its animations entirely.
  win.on('hide', () => sendToRenderer('island:visibility', false));
  win.on('show', () => sendToRenderer('island:visibility', true));

  // A file or link dropped onto the window would otherwise replace the UI with a page
  // that still has the preload API.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Click-through until the renderer reports the cursor over the card; `forward` keeps
  // mousemove events coming so it can.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(scale);
    sendSettings();
    sendToRenderer('island:connection', clients.size > 0);
    if (lastState) sendToRenderer('island:state', lastState);
    if (lastQueue) sendToRenderer('island:queue', lastQueue);
  });

  // 'move' rather than 'moved': on Windows 'moved' fires only at the end of a user drag,
  // and 'close' is skipped when the process is killed, so persist on every settled move.
  let saveTimer = null;
  win.on('move', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [nx, ny] = win.getPosition();
      writeConfig({ x: nx, y: ny });
    }, 250);
  });

  win.on('close', () => {
    const [nx, ny] = win.getPosition();
    writeConfig({ x: nx, y: ny });
  });

  win.on('closed', () => {
    win = null;
  });
}

function broadcast(message) {
  const raw = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}

function handleClientMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  // `null` parses fine and would throw on `.type` inside the socket handler, after which
  // ws never emits 'close' for that client and the island stays "connected" forever.
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello':
      console.log(`[island] client hello: ${msg.client} v${msg.version}`);
      break;
    case 'state': {
      const trackChanged = lastState?.title !== msg.data?.title || lastState?.hasTrack !== msg.data?.hasTrack;
      lastState = msg.data;
      sendToRenderer('island:state', lastState);
      if (trackChanged) updateTrayTooltip();
      break;
    }
    case 'queue':
      lastQueue = msg.data;
      sendToRenderer('island:queue', lastQueue);
      break;
    case 'tab_closed':
      lastState = null;
      updateTrayTooltip();
      lastQueue = null;
      sendToRenderer('island:state', { hasTrack: false });
      sendToRenderer('island:queue', { items: [] });
      break;
  }
}

function isAllowedOrigin(origin) {
  // Any page in a browser can open ws://127.0.0.1; only the extension's service worker
  // (chrome-extension:// origin) or a local non-browser client (no Origin header) may drive the island.
  return !origin || origin.startsWith('chrome-extension://');
}

function startServer() {
  wss = new WebSocketServer({
    host: WS_HOST,
    port: WS_PORT,
    verifyClient: ({ origin }) => isAllowedOrigin(origin),
  });

  wss.on('listening', () => console.log(`[island] ws listening on ws://${WS_HOST}:${WS_PORT}`));

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      dialog.showErrorBox(APP_NAME, t('errorPortBusy', { port: WS_PORT }));
    } else {
      dialog.showErrorBox(APP_NAME, t('errorServer', { message: err.message }));
    }
    app.quit();
  });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    console.log(`[island] client connected (${req.headers.origin || 'no origin'}), total ${clients.size}`);
    sendToRenderer('island:connection', true);

    ws.on('message', (data) => handleClientMessage(data.toString()));
    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[island] client disconnected, total ${clients.size}`);
      if (clients.size === 0) sendToRenderer('island:connection', false);
    });
    ws.on('error', () => ws.terminate());
  });

  // JSON ping rather than a protocol-level ping: only messages delivered to the
  // MV3 service worker's onmessage extend its lifetime.
  setInterval(() => broadcast({ type: 'ping' }), PING_INTERVAL_MS);
}

const COMMANDS = new Set([
  'play_pause', 'next', 'prev', 'shuffle', 'like', 'refresh_queue',
  'seek', 'play_queue_item', 'set_volume', 'toggle_mute',
]);

ipcMain.on('island:command', (_event, { command, payload } = {}) => {
  if (!COMMANDS.has(command)) return;
  const message = { type: 'command', command };
  if (command === 'seek' || command === 'set_volume') {
    message.value = Math.min(1, Math.max(0, Number(payload?.value) || 0));
  }
  if (command === 'play_queue_item') message.index = Math.max(0, Math.floor(Number(payload?.index) || 0));
  broadcast(message);
});

ipcMain.on('island:drag', (_event, phase) => handleDrag(phase));
ipcMain.on('island:scale', (_event, delta) => setScale(scale + Math.sign(Number(delta) || 0) * SCALE_STEP));
ipcMain.on('island:menu', () => showContextMenu());
ipcMain.on('island:copy', (_event, text) => {
  if (typeof text === 'string' && text) clipboard.writeText(text.slice(0, 2000));
});
ipcMain.handle('island:artwork-pixels', (_event, url) => artworkPixels(url));
ipcMain.on('island:interactive', (_event, on) => {
  if (win) win.setIgnoreMouseEvents(!on, { forward: true });
});

// Software compositing: for a small widget it is cheaper than the GPU path, measured while playing
// at 0.2–0.7 s CPU per 10 s against 1.15 s and about 85 MB less private memory.
app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) win.showInactive();
  });

  app.whenReady().then(() => {
    migrateOldConfig();
    startServer();
    createWindow();
    createTray();
  });

  app.on('window-all-closed', () => app.quit());
}
