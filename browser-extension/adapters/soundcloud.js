// SoundCloud: everything is read from and done through its own player bar (see spikes S1–S5).
(() => {
  const { $, sleep, warn, clamp01, parseTime, click } = globalThis.MI;

  const QUEUE_RENDER_WAIT_MS = 300;
  // SoundCloud's queue panel slides with a 0.3 s transition; keep it hidden until it is fully closed.
  const QUEUE_CLOSE_SETTLE_MS = 450;
  const QUEUE_SYNC_TIMEOUT_MS = 2500;

  const SEL = {
    title: '.playbackSoundBadge__titleLink',
    artist: '.playbackSoundBadge__lightLink',
    artwork: '.playbackSoundBadge__avatar span.sc-artwork',
    play: '.playControl',
    next: '.skipControl__next',
    prev: '.skipControl__previous',
    shuffle: '.shuffleControl',
    like: '.playbackSoundBadge__like',
    timePassed: '.playbackTimeline__timePassed span:last-child',
    duration: '.playbackTimeline__duration span:last-child',
    progressWrapper: '.playbackTimeline__progressWrapper',
    progressBackground: '.playbackTimeline__progressBackground',
    queueButton: '.playbackSoundBadge__queueCircle, .playbackSoundBadge__showQueue',
    queueOpen: '.queue.m-visible, .playControls.m-queueVisible',
    queueItem: '.queueItemView',
    queueItemTitle: '.queueItemView__title a, .queueItemView__title',
    // .queueItemView__username is itself the <a>, unlike the title, which wraps one.
    queueItemArtist: '.queueItemView__username',
    queueItemArtwork: 'span.sc-artwork',
    queueItemPlay: '.queueItemView__playButton .sc-button-play, .queueItemView__playButton',
    controlsRoot: '.playControls',
    volume: '.volume',
    volumeSlider: '.volume__sliderWrapper',
    volumeTrack: '.volume__sliderBackground',
    volumeButton: '.volume__button',
  };

  let panelOpenedForTrack = null;

  function visibleText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.sc-visuallyhidden').forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  function artworkUrl(el) {
    if (!el) return null;
    const bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
    const match = bg && bg.match(/url\(["']?(.*?)["']?\)/);
    if (!match || !match[1]) return null;
    // SoundCloud size suffixes: -t50x50, -t500x500, -large (100px), -crop, -small, -badge, -tiny, -mini.
    return match[1].replace(/-(t\d+x\d+|large|crop|small|badge|tiny|mini)\./, '-t200x200.');
  }

  function readTimes() {
    const elapsedText = $(SEL.timePassed)?.textContent || '';
    const durationText = $(SEL.duration)?.textContent || '';
    let elapsed = parseTime(elapsedText) ?? 0;
    let duration = parseTime(durationText) ?? 0;
    // A click on SoundCloud's duration label toggles it to "time remaining" (-2:25).
    if (durationText.trim().startsWith('-')) duration += elapsed;

    let progress = duration ? elapsed / duration : 0;
    const wrapper = $(SEL.progressWrapper);
    const now = Number(wrapper?.getAttribute('aria-valuenow'));
    const max = Number(wrapper?.getAttribute('aria-valuemax'));
    if (max > 0 && Number.isFinite(now)) {
      const ariaProgress = now / max;
      // aria values carry sub-second precision, but their units are undocumented:
      // trust them only while they agree with the visible labels.
      if (!duration || Math.abs(ariaProgress - progress) < 0.05) {
        progress = ariaProgress;
        if (duration) elapsed = ariaProgress * duration;
      }
    }
    return { elapsed, duration, progress: clamp01(progress) };
  }

  function readState() {
    const titleEl = $(SEL.title);
    const artistEl = $(SEL.artist);
    const attr = (el) => (el?.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const title = attr(titleEl) || visibleText(titleEl);
    const artist = attr(artistEl) || visibleText(artistEl);
    const { elapsed, duration, progress } = readTimes();
    const volume = Number($(SEL.volumeSlider)?.getAttribute('aria-valuenow'));

    return {
      hasTrack: Boolean(title),
      title,
      artist,
      artwork: artworkUrl($(SEL.artwork)),
      trackUrl: titleEl?.href || null,
      isPlaying: Boolean($(SEL.play)?.classList.contains('playing')),
      isLiked: Boolean($(SEL.like)?.classList.contains('sc-button-selected')),
      isShuffle: Boolean($(SEL.shuffle)?.classList.contains('m-shuffling')),
      elapsed: Math.round(elapsed * 10) / 10,
      duration,
      progress: Math.round(progress * 10000) / 10000,
      volume: Number.isFinite(volume) ? Math.round(volume * 100) / 100 : null,
      muted: Boolean($(SEL.volume)?.classList.contains('muted')),
    };
  }

  // The queue list is virtualised: items sit in absolutely-positioned wrappers, so DOM order
  // is not play order. The wrapper's Y offset is.
  // The computed transform is always a resolved matrix(); the inline one may hold calc()/%,
  // which DOMMatrixReadOnly refuses ("Values must be resolvable at parse time").
  function itemOffset(el) {
    const wrapper = el.closest('.queue__itemWrapper') || el;
    const computed = getComputedStyle(wrapper).transform;
    if (computed && computed !== 'none') {
      try {
        return new DOMMatrixReadOnly(computed).m42;
      } catch {
        /* fall back to the inline value */
      }
    }
    const transform = wrapper.style.transform || '';
    const match =
      transform.match(/translate(?:3d)?\(\s*-?[\d.]+(?:px)?\s*,\s*(-?[\d.]+)px/) ||
      transform.match(/translateY\(\s*(-?[\d.]+)px/);
    if (match) return Number(match[1]);
    return parseFloat(wrapper.style.top) || 0;
  }

  function orderedQueueItems() {
    return [...document.querySelectorAll(SEL.queueItem)]
      .map((el, domIndex) => ({ el, y: itemOffset(el), domIndex }))
      .sort((a, b) => a.y - b.y || a.domIndex - b.domIndex)
      .map((x) => x.el);
  }

  function upcomingQueueElements() {
    const items = orderedQueueItems();
    const active = items.findIndex((el) => el.classList.contains('m-active'));
    return active === -1 ? null : items.slice(active + 1);
  }

  function activeQueueTitle() {
    const active = document.querySelector(`${SEL.queueItem}.m-active`);
    return active ? visibleText($(SEL.queueItemTitle, active)) : null;
  }

  function parseQueue() {
    const upcoming = upcomingQueueElements();
    if (!upcoming) return null;
    return upcoming.map((el, index) => ({
      index,
      title: visibleText($(SEL.queueItemTitle, el)),
      artist: visibleText($(SEL.queueItemArtist, el)),
      artwork: artworkUrl($(SEL.queueItemArtwork, el)),
    }));
  }

  // The queue DOM is trustworthy only if its active item is the track in the player bar:
  // while the panel is hidden SoundCloud does not re-sync it after a track change.
  function queueDomIsFresh() {
    const current = readState();
    if (!current.hasTrack) return false;
    const activeTitle = activeQueueTitle();
    return activeTitle != null && activeTitle === current.title;
  }

  async function waitForFreshQueue() {
    const deadline = Date.now() + QUEUE_SYNC_TIMEOUT_MS;
    await sleep(QUEUE_RENDER_WAIT_MS);
    while (!queueDomIsFresh() && Date.now() < deadline) await sleep(150);
    return queueDomIsFresh();
  }

  async function withQueuePanelOpen(read) {
    if ($(SEL.queueOpen)) return (await waitForFreshQueue()) ? read() : null;

    const button = $(SEL.queueButton);
    if (!button) {
      warn('queue button not found');
      return null;
    }

    const root = document.documentElement;
    root.classList.add('mi-stealth-queue');
    try {
      button.click();
      // Reading before the panel re-syncs returns the previous track's queue.
      const result = (await waitForFreshQueue()) ? read() : null;
      if (!result) warn('queue did not sync with the current track');
      if ($(SEL.queueOpen)) button.click();
      return result;
    } finally {
      setTimeout(() => root.classList.remove('mi-stealth-queue'), QUEUE_CLOSE_SETTLE_MS);
    }
  }

  async function readQueue({ force, key }) {
    let items = !force && queueDomIsFresh() ? parseQueue() : null;
    // A never-opened panel renders only the history up to the active item, so an empty
    // upcoming list is believed only after the panel has been opened for this track.
    if (items && items.length === 0 && panelOpenedForTrack !== key) items = null;
    // The panel is opened once per track; periodic rechecks only re-read the DOM.
    if (!items && (force || panelOpenedForTrack !== key)) {
      panelOpenedForTrack = key;
      items = await withQueuePanelOpen(parseQueue);
    }
    return items;
  }

  function seek({ value }) {
    const wrapper = $(SEL.progressWrapper);
    const target = $(SEL.progressBackground) || wrapper;
    if (!wrapper || !target) return warn('timeline not found');
    const rect = wrapper.getBoundingClientRect();
    if (!rect.width) return warn('timeline has no width');

    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: rect.left + rect.width * clamp01(value),
      clientY: rect.top + rect.height / 2,
    };
    // SoundCloud starts scrubbing on mousedown over the wrapper and seeks on the
    // document's next mouseup, using clientX of that mouseup.
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
    document.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
  }

  // Same scheme as the timeline: mousedown on the slider, mouseup on the document. SoundCloud maps
  // pageY onto its vertical track; the collapsed slider keeps its height, so nothing needs expanding.
  // Y is rounded because MouseEvent coordinates are whole pixels (0.61 otherwise lands on 0.62).
  function setVolume({ value }) {
    const slider = $(SEL.volumeSlider);
    const track = $(SEL.volumeTrack);
    if (!slider || !track) return warn('volume slider not found');
    const rect = track.getBoundingClientRect();
    if (!rect.height) return warn('volume slider has no height');

    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: Math.round(rect.top + 4 + (1 - clamp01(value)) * rect.height),
    };
    slider.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
    document.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
  }

  async function playQueueItem({ index, expectedTitle }) {
    let upcoming = upcomingQueueElements();
    if (!upcoming) {
      await withQueuePanelOpen(() => (upcoming = upcomingQueueElements()));
    }
    if (!upcoming || !upcoming.length) return warn('queue is empty');

    let el = upcoming[index];
    if (expectedTitle && (!el || visibleText($(SEL.queueItemTitle, el)) !== expectedTitle)) {
      el = upcoming.find((item) => visibleText($(SEL.queueItemTitle, item)) === expectedTitle) || el;
    }
    if (!el) return warn('queue index out of range:', index);

    ($(SEL.queueItemPlay, el) || el).click();
  }

  globalThis.__miAdapter = {
    service: 'soundcloud',
    capabilities: { like: true, shuffle: true, queue: true, volume: true, seek: true },
    observeRoot: () => $(SEL.controlsRoot),
    readState,
    readQueue,
    commands: {
      play_pause: () => click(SEL.play),
      next: () => click(SEL.next),
      prev: () => click(SEL.prev),
      shuffle: () => click(SEL.shuffle),
      like: () => click(SEL.like),
      toggle_mute: () => click(SEL.volumeButton),
      seek,
      set_volume: setVolume,
      play_queue_item: playQueueItem,
    },
  };
})();
