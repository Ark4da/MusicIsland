// Helpers shared by the service adapters and core.js (same isolated world, loaded first).
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const warn = (...args) => console.warn('[island]', ...args);
  const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));

  function parseTime(text) {
    if (!text) return null;
    const clean = text.trim().replace(/^-/, '');
    if (!/^\d+(:\d{1,2}){1,2}$/.test(clean)) return null;
    return clean.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }

  function pointerInit(el, fx = 0.5, fy = 0.5) {
    const rect = el.getBoundingClientRect();
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: rect.left + rect.width * fx,
      clientY: rect.top + rect.height * fy,
    };
  }

  // Full press sequence. Polymer (YouTube Music) and React (Spotify) listen to pointer/mouse
  // down and up rather than to `click`, so el.click() alone is ignored by some of their controls.
  function tap(el, { double = false, fx = 0.5, fy = 0.5 } = {}) {
    const init = pointerInit(el, fx, fy);
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1, detail: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', init));
    el.dispatchEvent(new MouseEvent('mouseup', { ...init, detail: 1 }));
    el.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
    if (double) el.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
  }

  // Press on a slider at a fraction of its width and release on the document: the way SoundCloud
  // and Spotify sliders expect a click-to-position.
  function pressAt(el, fx, fy = 0.5) {
    const init = pointerInit(el, fx, fy);
    init.clientX = Math.round(init.clientX);
    init.clientY = Math.round(init.clientY);
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', init));
    document.dispatchEvent(new MouseEvent('mouseup', init));
  }

  function click(selector, root) {
    const el = $(selector, root);
    if (!el) {
      warn('element not found:', selector);
      return false;
    }
    el.click();
    return true;
  }

  // MAIN-world helpers (page/*.js) own the page's JS objects; the isolated world can only reach
  // them through DOM events. Payloads are JSON strings: objects do not cross between worlds.
  function pageCommand(command, payload = {}) {
    document.dispatchEvent(new CustomEvent('music-island:command', { detail: JSON.stringify({ command, ...payload }) }));
  }

  function onPageMessage(handler) {
    const listener = (event) => {
      try {
        handler(JSON.parse(event.detail));
      } catch {
        /* not ours */
      }
    };
    document.addEventListener('music-island:page', listener);
    return () => document.removeEventListener('music-island:page', listener);
  }

  globalThis.MI = { $, $$, sleep, warn, clamp01, parseTime, tap, pressAt, click, pageCommand, onPageMessage };
})();
