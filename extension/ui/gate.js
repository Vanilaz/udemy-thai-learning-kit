// The "please wait" card over the page. Display only: whether the video is
// held is the session's decision (pipeline/session.js), never this view's.
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});

  /** @param {{onSkip: () => void}} deps */
  function createGateView({ onSkip }) {
    let el = null;

    function ensure() {
      if (el && el.isConnected) return el;
      el = document.createElement("div");
      el.className = "udth-gate";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.innerHTML =
        '<div class="udth-gate-card">' +
        '<div class="udth-gate-spinner" aria-hidden="true"></div>' +
        '<div class="udth-gate-title"></div>' +
        '<ul class="udth-gate-steps"></ul>' +
        '<div class="udth-gate-detail"></div>' +
        '<div class="udth-gate-bar" hidden><i></i></div>' +
        '<button type="button" class="udth-gate-skip">ข้ามการรอ แล้วดูไปก่อน</button>' +
        "</div>";
      el.querySelector(".udth-gate-skip").addEventListener("click", () => onSkip());
      // A fixed element outside the fullscreen subtree is not painted while
      // the player is fullscreen, so the card lives inside it when needed.
      (document.fullscreenElement || document.body).appendChild(el);
      return el;
    }

    return {
      /**
       * @param {object} view
       * @param {string} view.title
       * @param {string} [view.detail]
       * @param {string[]} [view.steps]   one line per thing still being waited on
       * @param {number|null} [view.progress]  0..1 when known
       * @param {boolean} [view.error]
       * @param {boolean} [view.skippable]
       */
      show({ title, detail = "", steps = [], progress = null, error = false, skippable = true }) {
        const card = ensure();
        card.classList.toggle("udth-gate-error", error);
        card.querySelector(".udth-gate-title").textContent = title;
        const list = card.querySelector(".udth-gate-steps");
        list.textContent = "";
        for (const step of steps) {
          const li = document.createElement("li");
          li.textContent = step;
          list.appendChild(li);
        }
        list.hidden = !steps.length;
        const detailEl = card.querySelector(".udth-gate-detail");
        detailEl.textContent = detail;
        detailEl.hidden = !detail;
        const bar = card.querySelector(".udth-gate-bar");
        bar.hidden = progress === null;
        if (progress !== null) bar.firstChild.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
        card.querySelector(".udth-gate-skip").hidden = !skippable;
      },

      hide() {
        if (el) el.remove();
        el = null;
      },
    };
  }

  UDTH.gateView = { createGateView };
})();
