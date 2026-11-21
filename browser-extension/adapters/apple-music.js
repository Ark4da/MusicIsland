// Apple Music: page/apple-music.js reads MusicKit in the page's world and sends snapshots;
// this side caches the latest one and forwards commands. Like needs a signed-in Apple ID and the
// ratings API, which could not be verified, so it is not offered.
(() => {
  const { sleep, pageCommand, onPageMessage } = globalThis.MI;

  let latest = null;
  let unsubscribe = null;

  const forward = (command) => (msg) => pageCommand(command, { value: msg.value, index: msg.index, expectedTitle: msg.expectedTitle });

  async function readQueue({ key }) {
    if (latest?.queueKey !== key) {
      pageCommand('snapshot');
      await sleep(400);
    }
    return latest?.queueKey === key ? latest.queue : null;
  }

  globalThis.__miAdapter = {
    service: 'apple-music',
    capabilities: { like: false, shuffle: true, queue: true, volume: true, seek: true },
    readState: () => latest?.state || { hasTrack: false },
    readQueue,
    start({ onChange }) {
      unsubscribe = onPageMessage((msg) => {
        if (msg?.type !== 'snapshot') return;
        latest = msg;
        onChange();
      });
      pageCommand('snapshot');
    },
    stop: () => unsubscribe?.(),
    commands: {
      play_pause: forward('play_pause'),
      next: forward('next'),
      prev: forward('prev'),
      shuffle: forward('shuffle'),
      toggle_mute: forward('toggle_mute'),
      seek: forward('seek'),
      set_volume: forward('set_volume'),
      play_queue_item: forward('play_queue_item'),
    },
  };
})();
