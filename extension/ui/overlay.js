// The subtitle line drawn over the player, plus short status messages.
//
// Renders whatever caption it is given (see core/timeline.js captionAt): Thai
// in the main line, the original under it when the viewer wants both. A draft
// (fast provisional translation) is drawn dimmer with a small tag, so nobody
// mistakes it for the checked translation that replaces it.
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});

  const CONTROLS_IDLE_MS = 2800; // players fade their controls after this
  const STATUS_MS = 6000; // an info/ok status clears itself after this

  const segmenter =
    typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("th", { granularity: "word" }) : null;

  // Thai has no spaces; the browser's own line breaking split words in half
  // ("ตรวจ" / "สอบ"). One nowrap span per word, a zero-width space between
  // them as the only place a line may break.
  function wordSpans(text) {
    const span = document.createElement("span");
    const words = segmenter ? [...segmenter.segment(text)].map((p) => p.segment) : text.split(/(\s+)/);
    words.filter(Boolean).forEach((word, i) => {
      if (i) span.appendChild(document.createTextNode("​"));
      const w = document.createElement("span");
      w.className = "udth-w";
      w.textContent = word;
      span.appendChild(w);
    });
    return span;
  }

  /**
   * @param {object} deps
   * @param {object} deps.site            controlBar(), playerContainer()
   * @param {HTMLMediaElement} deps.video
   * @param {() => boolean} [deps.isMenuOpen]
   */
  function createOverlay({ site, video, isMenuOpen = () => false }) {
    let overlay = null;
    let line = null;
    let shown = null; // the caption currently drawn, to skip identical redraws
    let shownKey = "";
    let statusTimer = null;
    let statusActive = false; // a status message holds the line until a caption replaces it
    let lastMove = 0;
    let idleTimer = null;
    let placeQueued = false;
    let container = null;

    function controlsShowing() {
      return video.paused || Date.now() - lastMove < CONTROLS_IDLE_MS || isMenuOpen();
    }

    function onActivity() {
      const wasHidden = !controlsShowing();
      lastMove = Date.now();
      if (wasHidden) place();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(place, CONTROLS_IDLE_MS + 60);
    }

    // Ride just above the control bar while it is on screen, and drop close
    // to the bottom edge, like film subtitles, when it fades out. A fixed
    // percentage landed on the progress bar on short players.
    function place() {
      if (placeQueued) return;
      placeQueued = true;
      requestAnimationFrame(() => {
        placeQueued = false;
        if (!overlay || !overlay.isConnected) return;
        const box = overlay.offsetParent || overlay.parentElement;
        if (!box) return;
        const boxRect = box.getBoundingClientRect();
        if (!boxRect.height) return;
        const showing = controlsShowing();
        let lift = Math.max(18, boxRect.height * 0.045);
        if (showing) {
          lift = boxRect.height * 0.09;
          const bar = site.controlBar && site.controlBar();
          if (bar) {
            const r = bar.getBoundingClientRect();
            if (r.height && r.bottom > boxRect.top) lift = Math.max(lift, boxRect.bottom - r.top + 18);
          }
        }
        lift = Math.min(lift, boxRect.height * 0.45);
        overlay.style.bottom = `${Math.round(lift)}px`;
        overlay.classList.toggle("udth-raised", showing);
      });
    }

    const ACTIVITY = ["mousemove", "pointerdown", "keydown", "touchstart"];

    function ensure() {
      if (overlay && overlay.isConnected) return;
      container = site.playerContainer() || video.parentElement || document.body;
      if (getComputedStyle(container).position === "static") container.style.position = "relative";
      overlay = document.createElement("div");
      overlay.className = "udth-overlay";
      line = document.createElement("div");
      line.className = "udth-line";
      line.setAttribute("aria-live", "off");
      overlay.appendChild(line);
      container.appendChild(overlay);
      // On the container: the overlay is pointer-events:none so it can never
      // swallow a click meant for the player.
      for (const type of ACTIVITY) container.addEventListener(type, onActivity, { passive: true });
      shown = null;
      shownKey = "";
      place();
    }

    function clear() {
      clearTimeout(statusTimer);
      statusActive = false;
      if (line) line.textContent = "";
      shown = null;
      shownKey = "";
    }

    window.addEventListener("resize", place);
    document.addEventListener("fullscreenchange", place);
    video.addEventListener("pause", place);
    video.addEventListener("play", place);

    return {
      ensure,
      place,

      /**
       * @param {object|null} caption  {text, source, quality} from the timeline
       * @param {{subtitles: string, textSize: string}} view
       */
      caption(caption, { subtitles, textSize }) {
        ensure();
        overlay.dataset.size = textSize;
        const key = `${subtitles}|${textSize}`;
        if (statusActive && !caption) return; // nothing to say: keep the message up
        if (!statusActive && caption === shown && key === shownKey) return;
        clear();
        shown = caption;
        shownKey = key;
        if (!caption || subtitles === "off") return;

        const translated = caption.quality !== "source";
        const main = document.createElement("div");
        main.className = "udth-th";
        main.lang = translated ? "th" : "";
        main.appendChild(wordSpans(caption.text));
        if (caption.quality === "draft") {
          main.classList.add("udth-draft");
          const tag = document.createElement("span");
          tag.className = "udth-draft-tag";
          tag.textContent = UDTH.i18n.t("แปลด่วน");
          main.appendChild(tag);
        }
        line.appendChild(main);
        // The original goes underneath only when there is a translation above
        // it; otherwise it would just repeat the main line.
        if (subtitles === "both" && translated && caption.source) {
          const original = document.createElement("div");
          original.className = "udth-en";
          original.textContent = caption.source;
          line.appendChild(original);
        }
      },

      /** A short message in the subtitle line ("ready", an error, ...). */
      status(text, kind = "info") {
        ensure();
        clear();
        const badge = document.createElement("div");
        badge.className = `udth-status udth-${kind}`;
        badge.setAttribute("role", kind === "error" ? "alert" : "status");
        badge.textContent = text;
        line.appendChild(badge);
        statusActive = true;
        if (kind !== "error") statusTimer = setTimeout(clear, STATUS_MS);
      },

      clear,

      /** Hide the site's own captions while ours are on screen. */
      hideNative(hide) {
        document.documentElement.classList.toggle("udth-hide-native", hide);
      },

      dispose() {
        clear();
        clearTimeout(idleTimer);
        window.removeEventListener("resize", place);
        document.removeEventListener("fullscreenchange", place);
        video.removeEventListener("pause", place);
        video.removeEventListener("play", place);
        if (container) for (const type of ACTIVITY) container.removeEventListener(type, onActivity);
        if (overlay) overlay.remove();
        overlay = null;
        document.documentElement.classList.remove("udth-hide-native");
      },
    };
  }

  UDTH.overlay = { createOverlay };
})();
