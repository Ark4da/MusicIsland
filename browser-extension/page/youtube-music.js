// Runs in YouTube Music's own JS world (manifest "world": "MAIN"): the player API and the Polymer
// slider's `value` property exist only here. Commands arrive from adapters/youtube-music.js.
(() => {
  const VERSION = 3;
  const previous = window.__musicIslandPage;
  if (previous?.version === VERSION) return;
  previous?.stop?.();

  let savedVolume = 50;

  const slider = () => document.querySelector('ytmusic-player-bar #volume-slider');

  function setSlider(value) {
    const el = slider();
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new CustomEvent('change', { bubbles: true }));
  }

  function onCommand(event) {
    let msg;
    try {
      msg = JSON.parse(event.detail);
    } catch {
      return;
    }
    const player = document.getElementById('movie_player');
    if (msg.command === 'seek' && player?.seekTo) {
      const duration = player.getDuration?.() || 0;
      if (duration) player.seekTo(msg.value * duration, true);
    } else if (msg.command === 'set_volume') {
      // Through the visible slider, not player.setVolume(): the player call leaves the slider
      // behind, and YouTube Music later re-applies the slider's value.
      setSlider(Math.round(msg.value * 100));
      if (msg.value > 0 && player?.isMuted?.()) player.unMute();
    } else if (msg.command === 'toggle_mute') {
      // YouTube Music's own mute button restores its internally remembered level, not the one
      // set through the slider, so mute is done here as "slider to 0 and back".
      // A slider at 0 also flags the player as muted, so the slider is checked first.
      const current = Number(slider()?.value) || 0;
      if (current === 0) {
        setSlider(savedVolume || 50);
        if (player?.isMuted?.()) player.unMute();
      } else if (player?.isMuted?.()) {
        player.unMute();
      } else {
        savedVolume = current;
        setSlider(0);
      }
    }
  }

  document.addEventListener('music-island:command', onCommand);
  window.__musicIslandPage = {
    version: VERSION,
    stop: () => document.removeEventListener('music-island:command', onCommand),
  };
})();
