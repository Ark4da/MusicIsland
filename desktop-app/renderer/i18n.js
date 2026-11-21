// Shared by main.js (require) and the page (<script>), so the menu and the card always agree.
// To add a language: copy the `en` table, translate it, add an entry to LANGUAGES.
(function (root) {
  const STRINGS = {
    en: {
      notConnected: 'No music connected',
      openPlayer: 'Open SoundCloud, Spotify, YouTube Music or Apple Music in Chrome',
      nothingPlaying: 'Nothing playing',
      startTrack: 'Start a track in the player',
      unavailableIn: 'Not available in {service}',
      queueUnavailable: 'The queue is not available in {service}',
      unlikeOnlyIn: 'Remove from your likes in {service} itself',
      unshuffleOnlyIn: 'Turn shuffle off in {service} itself',
      shuffle: 'Shuffle',
      prev: 'Previous',
      playPause: 'Play / pause',
      next: 'Next',
      like: 'Like',
      mute: 'Player tab sound on / off',
      volume: 'Player tab volume (mouse wheel over the island)',
      nextUp: 'Next Up',
      refreshQueue: 'Refresh queue',
      queueEmpty: 'Queue is empty — press ↻',

      menuAppearance: 'Appearance',
      // No '&' in menu labels: Windows menus treat it as a keyboard-mnemonic marker and drop it.
      menuAccent: 'Progress bar and equalizer color',
      menuSize: 'Size: {percent}',
      menuSmaller: 'Smaller  (Ctrl + wheel down)',
      menuBigger: 'Bigger  (Ctrl + wheel up)',
      menuCollapse: 'Collapse to pill',
      menuCollapseNow: 'Collapse now  (double-click)',
      collapsePaused: 'When paused',
      collapseAlways: 'Always (open with a click)',
      collapseNever: 'Never',
      menuLanguage: 'Language',
      menuLanguageAuto: 'System default',
      menuQuit: 'Close island',
      trayShow: 'Show island',
      trayHide: 'Hide island',

      themeBlack: 'Black, no glass',
      themeCover: 'Glass from artwork',
      themeNeon: 'Neon',
      themeSunset: 'Sunset',
      themeOcean: 'Ocean',
      themeAurora: 'Aurora',

      accentBlue: 'Blue',
      accentViolet: 'Violet',
      accentTeal: 'Teal',
      accentGreen: 'Green',
      accentPink: 'Pink',
      accentAmber: 'Amber',
      accentWhite: 'White',
      accentSunset: 'Sunset (gradient)',
      accentAurora: 'Aurora (gradient)',

      errorPortBusy: 'Port {port} is used by another process. The island cannot start.',
      errorServer: 'WebSocket server error: {message}',
    },
    ru: {
      notConnected: 'Музыка не подключена',
      openPlayer: 'Открой SoundCloud, Spotify, YouTube Music или Apple Music в Chrome',
      nothingPlaying: 'Ничего не играет',
      startTrack: 'Запусти трек в плеере',
      unavailableIn: 'Недоступно в {service}',
      queueUnavailable: 'Очередь недоступна в {service}',
      unlikeOnlyIn: 'Убрать из любимых можно только в самом {service}',
      unshuffleOnlyIn: 'Выключить перемешивание можно только в самом {service}',
      shuffle: 'Перемешать',
      prev: 'Назад',
      playPause: 'Играть / пауза',
      next: 'Вперёд',
      like: 'Нравится',
      mute: 'Звук вкладки плеера: вкл / выкл',
      volume: 'Громкость вкладки плеера (колесо мыши над островком)',
      nextUp: 'Next Up',
      refreshQueue: 'Обновить очередь',
      queueEmpty: 'Очередь пуста — нажми ↻',

      menuAppearance: 'Оформление',
      menuAccent: 'Цвет полосы и эквалайзера',
      menuSize: 'Размер: {percent}',
      menuSmaller: 'Меньше  (Ctrl + колесо вниз)',
      menuBigger: 'Больше  (Ctrl + колесо вверх)',
      menuCollapse: 'Сворачивать в пилюлю',
      menuCollapseNow: 'Свернуть сейчас  (двойной клик)',
      collapsePaused: 'На паузе',
      collapseAlways: 'Всегда (открывать кликом)',
      collapseNever: 'Никогда',
      menuLanguage: 'Язык',
      menuLanguageAuto: 'Как в системе',
      menuQuit: 'Закрыть островок',
      trayShow: 'Показать островок',
      trayHide: 'Скрыть островок',

      themeBlack: 'Чёрный, без стекла',
      themeCover: 'Стекло из обложки',
      themeNeon: 'Неон',
      themeSunset: 'Закат',
      themeOcean: 'Океан',
      themeAurora: 'Сияние',

      accentBlue: 'Синий',
      accentViolet: 'Фиолетовый',
      accentTeal: 'Бирюзовый',
      accentGreen: 'Зелёный',
      accentPink: 'Розовый',
      accentAmber: 'Янтарный',
      accentWhite: 'Белый',
      accentSunset: 'Закат (градиент)',
      accentAurora: 'Аврора (градиент)',

      errorPortBusy: 'Порт {port} занят другим процессом. Островок не может запуститься.',
      errorServer: 'Ошибка WebSocket-сервера: {message}',
    },
  };

  // Names are shown in their own language: someone stuck in a language they can't read must still find theirs.
  const LANGUAGES = [
    { id: 'en', name: 'English' },
    { id: 'ru', name: 'Русский' },
  ];

  // "ru-RU", "ru_RU" and "ru" all mean ru; anything without a table falls back to English.
  function pickLanguage(preferred) {
    for (const tag of preferred || []) {
      const base = String(tag).toLowerCase().split(/[-_]/)[0];
      if (STRINGS[base]) return base;
    }
    return 'en';
  }

  function translator(lang) {
    const table = STRINGS[lang] || STRINGS.en;
    return (key, vars = {}) =>
      (table[key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
  }

  const api = { LANGUAGES, pickLanguage, translator };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.i18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
