// Runs in Apple Music's own JS world (manifest "world": "MAIN"). The web player is built on
// MusicKit, whose instance knows the track, time, queue, volume and shuffle mode directly
// (spike S8), so this side sends snapshots and executes commands; adapters/apple-music.js relays.
(() => {
  const VERSION = 1;
  const QUEUE_LIMIT = 50;
  const TIME_PUSH_MS = 1000;

  const previous = window.__musicIslandPage;
  if (previous?.version === VERSION) return;
  previous?.stop?.();

  let mk = null;
  let savedVolume = 0.5;
  let lastTimePush = 0;
  let waitTimer = null;

  const emit = (payload) =>
    document.dispatchEvent(new CustomEvent('music-island:page', { detail: JSON.stringify(payload) }));

  const artworkUrl = (item, size = 200) => {
    const template = item?.artwork?.url || item?.attributes?.artwork?.url;
    return template ? template.replace('{w}', size).replace('{h}', size).replace('{f}', 'jpg') : null;
  };

  const titleOf = (item) => item?.title || item?.attributes?.name || '';
  const artistOf = (item) => item?.artistName || item?.attributes?.artistName || '';

  function snapshot() {
    const item = mk.nowPlayingItem;
    const duration = mk.currentPlaybackDuration || (item?.playbackDuration || 0) / 1000;
    const elapsed = mk.currentPlaybackTime || 0;
    const muted = mk.volume === 0;
    const position = mk.queue?.position ?? -1;
    const queue = (mk.queue?.items || []).slice(position + 1, position + 1 + QUEUE_LIMIT).map((q, index) => ({
      index,
      title: titleOf(q),
      artist: artistOf(q),
      artwork: artworkUrl(q, 100),
    }));
    const title = titleOf(item);
    return {
      type: 'snapshot',
      state: {
        hasTrack: Boolean(item && title),
        title,
        artist: artistOf(item),
        artwork: artworkUrl(item),
        trackUrl: item ? `apple-music:${item.id}` : null,
        isPlaying: Boolean(mk.isPlaying),
        isLiked: false,
        isShuffle: mk.shuffleMode === 1,
        elapsed: Math.round(elapsed * 10) / 10,
        duration: Math.round(duration),
        progress: duration ? Math.round(Math.min(1, elapsed / duration) * 10000) / 10000 : 0,
        volume: Math.round((muted ? savedVolume : mk.volume) * 100) / 100,
        muted,
      },
      queue,
      queueKey: item ? `apple-music:${item.id}` : null,
    };
  }

  const push = () => mk && emit(snapshot());

  function onTime() {
    const now = Date.now();
    if (now - lastTimePush < TIME_PUSH_MS) return;
    lastTimePush = now;
    push();
  }

  const EVENTS = [
    'nowPlayingItemDidChange',
    'playbackStateDidChange',
    'playbackVolumeDidChange',
    'shuffleModeDidChange',
    'queueItemsDidChange',
    'queuePositionDidChange',
    'playbackDurationDidChange',
  ];

  async function run(msg) {
    const position = mk.queue?.position ?? -1;
    switch (msg.command) {
      case 'snapshot':
        break;
      case 'play_pause':
        await (mk.isPlaying ? mk.pause() : mk.play());
        break;
      case 'next':
        await mk.skipToNextItem();
        break;
      case 'prev':
        await mk.skipToPreviousItem();
        break;
      case 'shuffle':
        mk.shuffleMode = mk.shuffleMode === 1 ? 0 : 1;
        break;
      case 'seek':
        if (mk.currentPlaybackDuration) await mk.seekToTime(msg.value * mk.currentPlaybackDuration);
        break;
      case 'set_volume':
        mk.volume = msg.value;
        if (msg.value > 0) savedVolume = msg.value;
        break;
      case 'toggle_mute':
        if (mk.volume > 0) {
          savedVolume = mk.volume;
          mk.volume = 0;
        } else {
          mk.volume = savedVolume || 0.5;
        }
        break;
      case 'play_queue_item': {
        const items = mk.queue?.items || [];
        let target = position + 1 + msg.index;
        // The queue may have moved on since the island rendered it; find the track it showed.
        if (msg.expectedTitle && titleOf(items[target]) !== msg.expectedTitle) {
          const found = items.findIndex((q, i) => i > position && titleOf(q) === msg.expectedTitle);
          if (found !== -1) target = found;
        }
        if (items[target]) await mk.changeToMediaAtIndex(target);
        break;
      }
    }
    push();
  }

  function onCommand(event) {
    let msg;
    try {
      msg = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!mk) return;
    run(msg).catch((err) => console.warn('[island]', msg.command, 'failed:', err));
  }

  // MusicKit is configured by the page after load; wait for its instance.
  function attach() {
    const instance = window.MusicKit?.getInstance?.();
    if (!instance) {
      waitTimer = setTimeout(attach, 500);
      return;
    }
    mk = instance;
    if (mk.volume > 0) savedVolume = mk.volume;
    EVENTS.forEach((name) => mk.addEventListener(name, push));
    mk.addEventListener('playbackTimeDidChange', onTime);
    push();
  }

  document.addEventListener('music-island:command', onCommand);
  attach();

  window.__musicIslandPage = {
    version: VERSION,
    stop() {
      clearTimeout(waitTimer);
      document.removeEventListener('music-island:command', onCommand);
      if (mk) {
        EVENTS.forEach((name) => mk.removeEventListener(name, push));
        mk.removeEventListener('playbackTimeDidChange', onTime);
      }
    },
  };
})();
