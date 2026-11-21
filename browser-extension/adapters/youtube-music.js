// YouTube Music (spike S6): state from the player bar and the <video> element, queue from the
// always-rendered queue list. Seek and volume go through page/youtube-music.js, because the
// slider's value and the player API are JS properties the isolated world cannot reach.
(() => {
  const { $, $$, warn, clamp01, tap, click, pageCommand } = globalThis.MI;

  const SEL = {
    bar: 'ytmusic-player-bar',
    title: '.title',
    byline: '.byline',
    image: 'img.image',
    play: '#play-pause-button',
    next: '.next-button',
    prev: '.previous-button',
    shuffle: '.shuffle',
    likeRenderer: 'ytmusic-like-button-renderer',
    likeButton: '#button-shape-like button',
    progress: '#progress-bar',
    volumeSlider: '#volume-slider',
    queueItem: 'ytmusic-player-queue-item',
    queueTitle: '.song-title',
    queueArtist: '.byline',
    queuePlay: 'ytmusic-play-button-renderer',
  };

  const bar = () => $(SEL.bar);
  const video = () => $('video');
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

  // Song covers come from googleusercontent with a size suffix (=w60-h60-…); ask for a bigger one.
  // Music videos use i.ytimg.com thumbnails, which are already large.
  const bigger = (url) => (url ? url.replace(/=w\d+-h\d+[^/]*$/, '=w226-h226-l90-rj') : null);

  // The byline reads "Artist • Album • Year" (or "Artist • views • likes" for videos).
  const artistOf = (el) => text(el).split(' • ')[0];

  function readState() {
    const root = bar();
    const title = text($(SEL.title, root));
    const v = video();
    const progress = $(SEL.progress, root);
    let elapsed = v && Number.isFinite(v.currentTime) ? v.currentTime : Number(progress?.getAttribute('aria-valuenow')) || 0;
    let duration = v && Number.isFinite(v.duration) ? v.duration : Number(progress?.getAttribute('aria-valuemax')) || 0;
    if (!title) elapsed = duration = 0;
    const slider = $(SEL.volumeSlider, root);
    const volume = Number(slider?.getAttribute('aria-valuenow'));

    return {
      hasTrack: Boolean(title),
      title,
      artist: artistOf($(SEL.byline, root)),
      artwork: bigger($(SEL.image, root)?.src || null),
      trackUrl: null,
      isPlaying: Boolean(v && !v.paused && !v.ended),
      isLiked: $(SEL.likeRenderer, root)?.getAttribute('like-status') === 'LIKE',
      // YouTube Music's shuffle is a one-off action on the queue, not a mode.
      isShuffle: false,
      elapsed: Math.round(elapsed * 10) / 10,
      duration: Math.round(duration),
      progress: duration ? Math.round(clamp01(elapsed / duration) * 10000) / 10000 : 0,
      volume: Number.isFinite(volume) ? Math.round(volume) / 100 : null,
      // Muting from the island drags the slider to zero (see page/youtube-music.js).
      muted: Boolean(v?.muted) || volume === 0,
    };
  }

  const queueItems = () => $$(SEL.queueItem);

  function upcoming() {
    const items = queueItems();
    const current = items.findIndex((el) => el.hasAttribute('selected'));
    return current === -1 ? null : items.slice(current + 1);
  }

  async function readQueue() {
    const items = queueItems();
    const current = items.find((el) => el.hasAttribute('selected'));
    // Right after a track change the list may still mark the previous track.
    if (!current || text($(SEL.queueTitle, current)) !== readState().title) return null;
    return upcoming().map((el, index) => ({
      index,
      title: text($(SEL.queueTitle, el)),
      artist: artistOf($(SEL.queueArtist, el)),
      artwork: bigger($('img', el)?.src || null),
    }));
  }

  function playQueueItem({ index, expectedTitle }) {
    const list = upcoming();
    if (!list?.length) return warn('queue is empty');
    let el = list[index];
    if (expectedTitle && text($(SEL.queueTitle, el)) !== expectedTitle) {
      el = list.find((item) => text($(SEL.queueTitle, item)) === expectedTitle) || el;
    }
    if (!el) return warn('queue index out of range:', index);
    // The play overlay reacts to a pointer press sequence, not to a bare click().
    tap($(SEL.queuePlay, el) || el);
  }

  globalThis.__miAdapter = {
    service: 'youtube-music',
    capabilities: { like: true, shuffle: true, queue: true, volume: true, seek: true },
    observeRoot: bar,
    readState,
    readQueue,
    commands: {
      play_pause: () => click(SEL.play, bar()),
      next: () => click(SEL.next, bar()),
      prev: () => click(SEL.prev, bar()),
      shuffle: () => click(SEL.shuffle, bar()),
      like: () => click(`${SEL.likeRenderer} ${SEL.likeButton}`, bar()),
      toggle_mute: () => pageCommand('toggle_mute'),
      seek: ({ value }) => pageCommand('seek', { value: clamp01(value) }),
      set_volume: ({ value }) => pageCommand('set_volume', { value: clamp01(value) }),
      play_queue_item: playQueueItem,
    },
  };
})();
