const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (cb) => {
  ipcRenderer.on(channel, (_event, payload) => cb(payload));
};

contextBridge.exposeInMainWorld('island', {
  onState: subscribe('island:state'),
  onQueue: subscribe('island:queue'),
  onConnection: subscribe('island:connection'),
  send: (command, payload) => ipcRenderer.send('island:command', { command, payload }),
  drag: (phase) => ipcRenderer.send('island:drag', phase),
  reportCollapsed: (on) => ipcRenderer.send('island:collapsed', Boolean(on)),
  onDirection: subscribe('island:direction'),
  onFlip: subscribe('island:flip'),
  onFlipDone: subscribe('island:flip-done'),
  flipReady: (token) => ipcRenderer.send('island:flip-ready', token),
  scale: (delta) => ipcRenderer.send('island:scale', delta),
  menu: () => ipcRenderer.send('island:menu'),
  setInteractive: (on) => ipcRenderer.send('island:interactive', Boolean(on)),
  onSettings: subscribe('island:settings'),
  onCollapseNow: subscribe('island:collapse-now'),
  onVisibility: subscribe('island:visibility'),
  copy: (text) => ipcRenderer.send('island:copy', String(text)),
  artworkPixels: (url) => ipcRenderer.invoke('island:artwork-pixels', String(url)),
});
