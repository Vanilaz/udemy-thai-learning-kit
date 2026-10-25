// User settings: one schema, one store, shared by the popup and the page.
//
// Everything is kept under a single storage key and written only through
// `save`, so the popup and the in-player menu can never disagree. Each open
// view listens for changes instead of messaging the others. Values from older
// versions (flat keys) are migrated once and removed.
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});

  const KEY = "settings";
  // Interface language for settings saved before it could be chosen (1.2.0):
  // those users have only ever seen Thai, so "auto" must not switch them to
  // English because their browser happens to be in English.
  const EARLIER_USERS_LANG = "th";
  const LEGACY_KEYS = [
    "enabled", "dualMode", "capSize", "dubbingEnabled", "ttsEngine", "ttsVoice",
    "dubSource", "dubbingVolume", "originalAudioVolume", "dubRateCap",
  ];

  const DEFAULTS = Object.freeze({
    v: 2,
    active: false, // master power switch: off until the user turns the extension on
    subtitles: "both", // "off" | "th" | "both" (Thai with the original under it)
    textSize: "m", // "s" | "m" | "l"
    lang: "auto", // interface language: "auto" (follow the browser) | "th" | "en"
    dub: Object.freeze({
      on: false,
      engine: "edge",
      voice: "", // "" = the engine's first voice
      start: "instant", // "instant": play now, refine as AI text arrives | "accurate": wait for AI text
      volume: 1,
      sourceVolume: 0.15, // the instructor, under the dub
      maxRate: 1.6, // fastest a line may be sped up to fit its slot
    }),
  });

  const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const clamp = (value, min, max, fallback) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  const text = (value, fallback) => (typeof value === "string" ? value : fallback);

  // Accepts anything (stored data, a partial update merged onto it) and
  // returns a complete, valid settings object.
  function normalize(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const d = r.dub && typeof r.dub === "object" ? r.dub : {};
    const D = DEFAULTS.dub;
    return {
      v: 2,
      active: typeof r.active === "boolean" ? r.active : DEFAULTS.active,
      subtitles: oneOf(r.subtitles, ["off", "th", "both"], DEFAULTS.subtitles),
      textSize: oneOf(r.textSize, ["s", "m", "l"], DEFAULTS.textSize),
      lang: oneOf(r.lang, ["auto", "th", "en"], DEFAULTS.lang),
      dub: {
        on: typeof d.on === "boolean" ? d.on : D.on,
        engine: text(d.engine, D.engine) || D.engine,
        voice: text(d.voice, D.voice),
        start: oneOf(d.start, ["instant", "accurate"], D.start),
        volume: clamp(d.volume, 0, 1, D.volume),
        sourceVolume: clamp(d.sourceVolume, 0, 1, D.sourceVolume),
        maxRate: clamp(d.maxRate, 1, 2, D.maxRate),
      },
    };
  }

  function fromLegacy(old) {
    const subtitles = old.enabled === false ? "off" : old.dualMode === false ? "th" : "both";
    return normalize({
      active: old.enabled !== false,
      subtitles,
      textSize: old.capSize,
      dub: {
        on: old.dubbingEnabled,
        engine: old.ttsEngine,
        voice: old.ttsVoice,
        start: old.dubSource === "thai" ? "accurate" : "instant",
        volume: old.dubbingVolume,
        sourceVolume: old.originalAudioVolume,
        maxRate: old.dubRateCap,
      },
    });
  }

  /**
   * @param {{area: chrome.storage.StorageArea, onChanged: chrome.storage.StorageChangedEvent}} storage
   */
  function createSettingsStore(storage) {
    const { area, onChanged } = storage;
    let current = null;

    async function load() {
      const stored = await area.get([KEY, ...LEGACY_KEYS]);
      if (stored[KEY]) {
        current = normalize({ lang: EARLIER_USERS_LANG, ...stored[KEY] });
      } else if (LEGACY_KEYS.some((k) => k in stored)) {
        current = { ...fromLegacy(stored), lang: EARLIER_USERS_LANG };
        await area.set({ [KEY]: current });
        await area.remove(LEGACY_KEYS);
      } else {
        current = normalize({});
      }
      return current;
    }

    async function save(patch) {
      const base = current || (await load());
      const dubPatch = (patch && patch.dub) || {};
      const merged = { ...base, ...patch, dub: { ...base.dub, ...dubPatch } };
      // A voice id belongs to one engine; carried across, it would route the
      // request back to the old engine.
      if (dubPatch.engine !== undefined && dubPatch.engine !== base.dub.engine && dubPatch.voice === undefined) {
        merged.dub.voice = "";
      }
      current = normalize(merged);
      await area.set({ [KEY]: current });
      return current;
    }

    function subscribe(listener) {
      const handle = (changes, areaName) => {
        if ((areaName && areaName !== "local") || !changes[KEY]) return;
        current = normalize(changes[KEY].newValue);
        listener(current);
      };
      onChanged.addListener(handle);
      return () => onChanged.removeListener(handle);
    }

    return { load, save, subscribe, get: () => current };
  }

  UDTH.settings = { createSettingsStore, normalize, DEFAULTS, EARLIER_USERS_LANG };
  if (typeof module !== "undefined") module.exports = UDTH.settings;
})();
