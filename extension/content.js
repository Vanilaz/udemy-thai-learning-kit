// Runs on Udemy lecture pages.
//
// Where the English text comes from — verified against the live site:
// Udemy does NOT expose captions as HTML5 TextTracks (video.textTracks is
// empty even while subtitles are visibly playing); it fetches WebVTT files and
// renders them itself. It also clears the resource-timing buffer, so scraping
// the URL after the fact is unreliable.
//
// So we ask Udemy's own API for the lecture's caption list, which is
// deterministic and needs no interception:
//   /api-2.0/courses/<slug>/                        -> courseId
//   /api-2.0/users/me/subscribed-courses/<courseId>/lectures/<lectureId>/
//       ?fields[lecture]=asset&fields[asset]=captions
//       &fields[caption]=locale_id,title,url,source -> caption list + URLs
//
// If a Thai caption already exists we stay out of the way — Udemy's own track
// is better than anything we would produce. We only translate when it doesn't.

(() => {
  "use strict";

  // Ceiling on how much a sentence may be sped up to fit its slot. Thai stays
  // followable well past 1.35, and too low a cap is what made the dub fall
  // steadily behind: every overrun pushed the next sentence later still.
  // Declared up here because the initial state below reads it.
  const DEFAULT_DUB_RATE_CAP = 1.6;

  const state = {
    lectureKey: null,
    cues: [],
    activeIndex: -1,
    status: "idle",
    enabled: true,
    dualMode: true,
    capSize: "m",
    overlay: null,
    line: null,
    video: null,
    dubbingEnabled: false,
    ttsEngine: "edge",
    // Discovered from the server; empty until loadServerEngines() answers.
    serverEngines: [],
    serverReachable: false,
    // Language the captions were actually in, shown in the menu header.
    sourceLang: "EN",
    ttsVoice: "",
    dubbingVolume: 1,
    originalAudioVolume: 0.15,
    sourceVolume: null,
    audio: null,
    audioUrls: new Map(),
    audioPending: new Map(),
    // Decoded and ready to play, so a segment does not begin with a fetch.
    audioElements: new Map(),
    audioGeneration: 0,
    dubRateCap: DEFAULT_DUB_RATE_CAP,
    nativeVoices: [],
    nativeSpeech: false,
    hasNativeThai: false,
    // The dub track. Deliberately not the cue list: see buildDubSegments.
    // `cursor` is the next segment eligible to be spoken, `playing` guards
    // against starting a second one over the top, and `token` invalidates
    // callbacks belonging to speech that has since been cancelled.
    dub: { segments: [], cursor: 0, playing: false, token: 0, deadline: 0 },
    // Quiz mode: english text (normalised) -> thai, plus the DOM watcher that
    // injects it as Udemy renders one question at a time.
    quizMap: null,
    quizObserver: null,
    // Bumped on every lecture change. Work started under an older value is
    // abandoned instead of being written into the page the user has moved to.
    generation: 0,
    // Section batch. Deliberately untouched by lecture changes: the queue lives
    // on the server and keeps running while the user watches something else.
    batch: { preparing: false, timer: null, total: 0, label: "" },
  };

  const log = (...args) => console.log("[udth]", ...args);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Reloading the extension while a Udemy tab is open orphans the content
  // script already injected in that tab: it keeps running but can no longer
  // reach the service worker. Name that case instead of leaving the user to
  // guess, because the fix (reload the page) is not obvious.
  function describeSendError(err) {
    const message = String((err && err.message) || err || "");
    if (/context invalidated|receiving end does not exist/i.test(message)) {
      return "ส่วนขยายเพิ่งถูกอัปเดต — กด F5 รีเฟรชหน้านี้หนึ่งครั้ง";
    }
    if (/message channel closed|message port closed/i.test(message)) {
      return "การเชื่อมต่อกับส่วนขยายหลุด กำลังลองใหม่ ...";
    }
    return `ติดต่อส่วนขยายไม่ได้: ${message.slice(0, 80)}`;
  }

  // Every failure the user can actually act on, phrased as what to do next.
  function describeTranslateError(err) {
    const message = String((err && err.message) || err || "");
    if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(message)) {
      return "ยังไม่ได้เปิดเซิร์ฟเวอร์แปล — ดับเบิลคลิก start-server.cmd";
    }
    if (/context invalidated|receiving end does not exist|message channel closed/i.test(message)) {
      return describeSendError(err);
    }
    return `แปลไม่สำเร็จ: ${message.slice(0, 120)}`;
  }

  const POLL_INTERVAL_MS = 2000;
  const POLL_TIMEOUT_MS = 15 * 60 * 1000;

  class Stale extends Error {}

  // Ask the service worker to start a job, then wait here rather than there.
  // Each message is a single short round trip, which is all an MV3 worker can
  // reliably serve; the waiting happens in the page, which Chrome never kills.
  //
  // `generation` guards against the user moving to another lecture mid-flight:
  // when it no longer matches, the result belongs to a page that is gone.
  async function requestTranslation(payload, generation, onProgress, onPartial) {
    const started = await chrome.runtime.sendMessage({ type: "startJob", payload });
    if (generation !== state.generation) throw new Stale();
    if (!started || !started.ok) {
      throw new Error((started && started.error) || "เริ่มงานแปลไม่สำเร็จ");
    }

    const job = started.data || {};
    if (job.status === "done" && job.cues) return job.cues;

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (generation !== state.generation) throw new Stale();

      const polled = await chrome.runtime.sendMessage({
        type: "jobStatus",
        jobId: job.job,
      });
      if (generation !== state.generation) throw new Stale();
      if (!polled || !polled.ok) {
        throw new Error((polled && polled.error) || "อ่านสถานะงานไม่ได้");
      }

      const info = polled.data || {};
      if (info.status === "done") return info.cues || [];
      if (info.status === "error") throw new Error(info.error || "แปลไม่สำเร็จ");
      // A running job publishes what it has finished so far. Handing it over
      // now is what lets the lecture start before the whole thing is done.
      if (onPartial && info.cues && info.cues.length) onPartial(info.cues);
      if (onProgress) onProgress(info.progress || 0, info.chunks || 0);
    }
    throw new Error("แปลนานเกินไป ยกเลิกแล้ว");
  }

  // ---------------------------------------------------------------- overlay

  function ensureOverlay(video) {
    if (state.overlay && state.overlay.isConnected) return;

    const container = site.playerContainer() || video.parentElement || document.body;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    const overlay = document.createElement("div");
    overlay.className = "udth-overlay";
    const line = document.createElement("div");
    line.className = "udth-line";
    overlay.appendChild(line);
    container.appendChild(overlay);

    state.overlay = overlay;
    state.line = line;
    window.addEventListener("resize", placeOverlay);
    document.addEventListener("fullscreenchange", placeOverlay);
    // The pointer events go on the container: the overlay itself is
    // pointer-events:none so it can never swallow a click meant for the player.
    for (const type of ["mousemove", "pointerdown", "keydown", "touchstart"]) {
      container.addEventListener(type, onPointerActivity, { passive: true });
    }
    state.video && state.video.addEventListener("pause", placeOverlay);
    state.video && state.video.addEventListener("play", placeOverlay);
    onPointerActivity();
  }

  // The overlay used to sit a fixed 9% above the bottom. Udemy's control bar and
  // scrubber have a fixed pixel height, so on a short player (or a window that
  // is not full height) 9% landed on top of the progress bar. Measure the bar
  // instead and ride just above whichever is taller.
  // Where the subtitle sits depends on whether the player's controls are on
  // screen. Udemy fades its control bar out a few seconds after the mouse stops
  // and the bar's box stays in the layout while invisible, so measuring it
  // alone left the subtitle floating high over an empty picture. Controls count
  // as showing while the video is paused or the pointer moved recently.
  const UI = { lastMove: 0, timer: null };
  const CONTROLS_IDLE_MS = 2800;

  function controlsShowing() {
    const video = state.video;
    if (video && video.paused) return true;
    if (Date.now() - UI.lastMove < CONTROLS_IDLE_MS) return true;
    if (panel.open) return true;
    return false;
  }

  function onPointerActivity() {
    const wasHidden = !controlsShowing();
    UI.lastMove = Date.now();
    if (wasHidden) placeOverlay();
    clearTimeout(UI.timer);
    UI.timer = setTimeout(placeOverlay, CONTROLS_IDLE_MS + 60);
  }

  let placeQueued = false;
  function placeOverlay() {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      const overlay = state.overlay;
      const video = state.video;
      if (!overlay || !overlay.isConnected || !video) return;
      const box = overlay.offsetParent || overlay.parentElement;
      if (!box) return;
      const boxRect = box.getBoundingClientRect();
      if (!boxRect.height) return;

      const showing = controlsShowing();
      // Resting position: close to the bottom edge, like film subtitles.
      let lift = Math.max(18, boxRect.height * 0.045);
      if (showing) {
        lift = boxRect.height * 0.09;
        try {
          const bar = site.controlBar && site.controlBar();
          if (bar) {
            const r = bar.getBoundingClientRect();
            if (r.height && r.bottom > boxRect.top) {
              lift = Math.max(lift, boxRect.bottom - r.top + 18);
            }
          }
        } catch {
          /* keep the percentage fallback */
        }
      }
      lift = Math.min(lift, boxRect.height * 0.45);
      overlay.style.bottom = `${Math.round(lift)}px`;
      overlay.classList.toggle("udth-raised", showing);

      if (panel.el) {
        const barTop = Math.max(64, boxRect.height * 0.09, lift - 8);
        const menuBottom = Math.round(Math.max(64, showing ? barTop : 72));
        panel.el.style.bottom = `${menuBottom}px`;
        panel.el.style.maxHeight = `${Math.max(160, Math.round(boxRect.height - menuBottom - 12))}px`;
      }
    });
  }

  function renderStatus(text, kind = "info") {
    if (!state.line) return;
    state.line.innerHTML = "";
    const badge = document.createElement("div");
    badge.className = `udth-status udth-${kind}`;
    badge.textContent = text;
    state.line.appendChild(badge);
  }

  function clearLine() {
    if (state.line) state.line.innerHTML = "";
  }

  // Suppress Udemy's own caption layer only while we are actually showing
  // Thai — measured on a live lecture, the two overlap by ~40-60px otherwise.
  function syncNativeCaptions() {
    const hide = state.enabled && state.status === "ready" && state.cues.length > 0;
    document.documentElement.classList.toggle("udth-hide-native", hide);
  }

  function renderCue(cue) {
    if (!state.line) return;
    state.line.innerHTML = "";
    if (!cue) return;

    if (state.dualMode && cue.en) {
      const en = document.createElement("div");
      en.className = "udth-en";
      en.textContent = cue.en;
      state.line.appendChild(en);
    }
    const th = document.createElement("div");
    th.className = "udth-th";
    th.lang = "th";
    // The background sits on an inline span, so it hugs each wrapped line
    // instead of filling a rectangle across the picture.
    const span = document.createElement("span");
    const text = cue.th || cue.en || "";
    // One nowrap span per word, a zero-width space between them as the only
    // place the browser may break.
    thaiWords(text).forEach((word, i) => {
      if (i) span.appendChild(document.createTextNode("\u200b"));
      const w = document.createElement("span");
      w.className = "udth-w";
      w.textContent = word;
      span.appendChild(w);
    });
    th.appendChild(span);
    state.line.appendChild(th);
    if (state.overlay) state.overlay.dataset.size = state.capSize;
    placeOverlay();
  }

  // -------------------------------------------------------- in-player panel
  //
  // The popup is only reachable through the browser's extension menu, which is
  // the wrong place for a control you reach for mid-sentence. This panel sits
  // on the player itself: two toggles always visible, the rest a click away.
  // Every change is written to the same storage keys the popup uses, so the two
  // never disagree about the current settings.

  // The browser's own voices are an engine like any other from here on; every
  // other entry is discovered from the server, so a new server-side engine
  // appears in this picker without the extension changing at all.
  const BROWSER_ENGINE = {
    name: "windows",
    label: "Windows Natural (ในเบราว์เซอร์)",
    ready: true,
    voices: [],
  };

  const panel = { el: null, button: null, open: false };

  function engineCatalogue() {
    return [BROWSER_ENGINE, ...state.serverEngines];
  }

  // An engine the catalogue does not have is reported as itself-but-unusable,
  // not silently swapped for the browser one: the picker would otherwise claim
  // a setting is active when requests are actually being refused.
  function engineByName(name) {
    return (
      engineCatalogue().find((e) => e.name === name) || {
        name,
        label: name,
        ready: false,
        error: "เซิร์ฟเวอร์ไม่มีเครื่องมือเสียงนี้",
        voices: [],
      }
    );
  }

  // Re-asked every time the settings are opened, not just once at page load:
  // the server is frequently started *after* the Udemy tab is already sitting
  // there, and a list fetched before that would stay empty forever.
  async function loadServerEngines() {
    try {
      const health = await chrome.runtime.sendMessage({ type: "health" });
      state.serverEngines = (health && health.ok && health.voices) || [];
      state.serverReachable = Boolean(health && health.ok);
    } catch {
      state.serverEngines = [];
      state.serverReachable = false;
    }
    if (panel.el) renderPanel();
  }

  // What to tell the user when the picker has nothing useful in it. An empty
  // dropdown with no explanation is the worst possible outcome here.
  function engineHint() {
    if (!state.serverReachable) {
      return "ต่อเซิร์ฟเวอร์แปลไม่ได้ — เปิด start-server.cmd แล้วเปิดการตั้งค่านี้ใหม่";
    }
    if (!state.serverEngines.length) {
      return "เซิร์ฟเวอร์ยังไม่ส่งรายการเสียงมา — เป็นเวอร์ชันเก่า ปิดแล้วเปิด start-server.cmd ใหม่";
    }
    const engine = engineByName(state.ttsEngine);
    if (!engine.ready && engine.error) return engine.error;
    return "";
  }

  // The control appears as one button in the player's own control bar, next to
  // the site's native buttons, and opens a menu above itself — the same shape
  // the player's own settings button already has, so it needs no explaining.
  //
  // Nothing is drawn over the picture: an always-present panel floating on the
  // video is in the way of the thing you are trying to watch.
  function ensurePanel() {
    if (panel.button && panel.button.isConnected && panel.el && panel.el.isConnected) {
      return panel.el;
    }
    if (!state.video) return null;

    const host = site.playerContainer() || state.video.parentElement;
    if (!host) return null;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    removePanel();

    const button = document.createElement("button");
    button.type = "button";
    button.className = "udth-pill";
    button.dataset.udth = "settings";
    button.setAttribute("aria-label", "ซับไทยและเสียงพากย์");
    button.title = "ซับไทยและเสียงพากย์";
    // A glyph in the same family as the player's own icons (ก → A), not a word
    // floating on its own. The state dot says whether anything is switched on.
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">' +
      '<rect x="2.5" y="3.5" width="19" height="17" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M6.800 9.200h5.400M9.500 9.200v.8c0 1.700-.9 3.200-2.600 4M9.600 11.800c.6 1 1.500 1.700 2.600 2.100" ' +
      'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M13.300 16l2.300-6.300 2.300 6.300M14.100 14h3" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '<i class="udth-dot" aria-hidden="true"></i>';

    // Parked in the corner to begin with; dockButton moves it into the real
    // control bar as soon as one exists. Udemy builds its bar well after the
    // <video> element, so at this moment there is usually nothing to dock to.
    button.classList.add("udth-pill-floating");
    host.appendChild(button);
    dockButton(button);

    const el = document.createElement("div");
    el.className = "udth-menu";
    el.hidden = true;
    const version = (() => {
      try {
        return chrome.runtime.getManifest().version;
      } catch {
        return "";
      }
    })();
    el.innerHTML =
      '<div class="udth-menu-head">' +
      '<div class="udth-logo" aria-hidden="true">ท</div>' +
      '<div class="udth-menu-titles"><div class="udth-menu-title">ฮองเรียน</div>' +
      '<div class="udth-menu-sub"><span data-udth="src">EN</span><span class="udth-menu-arrow">→</span>ไทย</div></div>' +
      `<span class="udth-ver">v${version}</span></div>` +
      '<div class="udth-row-label">ซับบนวิดีโอ</div>' +
      '<div class="udth-seg" role="group" aria-label="ซับบนวิดีโอ">' +
      '<button type="button" data-udth="mode" data-val="off">ปิด</button>' +
      '<button type="button" data-udth="mode" data-val="th">ไทย</button>' +
      '<button type="button" data-udth="mode" data-val="both">ไทย + EN</button></div>' +
      '<div class="udth-row-label">ขนาดตัวอักษร</div>' +
      '<div class="udth-seg" role="group" aria-label="ขนาดตัวอักษร">' +
      '<button type="button" data-udth="size" data-val="s">เล็ก</button>' +
      '<button type="button" data-udth="size" data-val="m">กลาง</button>' +
      '<button type="button" data-udth="size" data-val="l">ใหญ่</button></div>' +
      '<button type="button" class="udth-dubrow" data-udth="dub" aria-pressed="false">' +
      '<span class="udth-dubrow-txt"><b>พากย์เสียงไทย</b><small data-state="dub">ปิด</small></span>' +
      '<span class="udth-switch" aria-hidden="true"></span></button>' +
      '<details class="udth-adv"><summary>ตั้งค่าเสียงขั้นสูง</summary>' +
      '<div class="udth-card">' +
      '<label class="udth-field"><span>เครื่องมือเสียง</span><select data-udth="engine"></select></label>' +
      '<label class="udth-field"><span>เลือกเสียง</span><select data-udth="voice"></select></label>' +
      '<label class="udth-field"><span>เสียงพากย์</span>' +
      '<input type="range" min="0" max="1" step="0.05" data-udth="dubVol"><output data-udth="dubVolOut"></output></label>' +
      '<label class="udth-field"><span>เสียงต้นฉบับ</span>' +
      '<input type="range" min="0" max="1" step="0.05" data-udth="srcVol"><output data-udth="srcVolOut"></output></label>' +
      '<label class="udth-field"><span>เร่งเสียงได้สูงสุด</span>' +
      '<input type="range" min="1" max="2" step="0.05" data-udth="rate"><output data-udth="rateOut"></output></label>' +
      "</div></details>" +
      '<div class="udth-menu-actions">' +
      '<button type="button" class="udth-btn" data-udth="retry">↻ แปลใหม่</button>' +
      '<button type="button" class="udth-btn udth-btn-primary" data-udth="section">แปลทั้ง Section</button>' +
      "</div>" +
      '<div class="udth-panel-note"></div>';

    host.appendChild(el);
    panel.button = button;
    panel.el = el;
    wirePanel(el);
    wirePanel(button);
    return el;
  }

  // Move the button into the player's control bar once that bar exists.
  //
  // Split out from ensurePanel because the bar is built later than the <video>
  // element on both sites — on Udemy by a wide margin. Creating the button and
  // docking it are therefore separate events, and docking has to keep being
  // retried. Leaving it parked in the corner forever was the bug.
  function dockButton(button) {
    const visible = (el) => el.offsetWidth > 0 && el.offsetHeight > 0;
    // Docked somewhere real already. A button that exists but measures 0x0 is
    // sitting inside a hidden menu — measured on the live Udemy page, where
    // `[data-purpose*="settings"]` also matched "go-to-settings", an item in
    // the closed settings dropdown, and the button vanished into it.
    if (button.isConnected && !button.classList.contains("udth-pill-floating") && visible(button)) {
      return true;
    }

    const root = (() => {
      let el = state.video;
      for (let i = 0; i < 8 && el && el.parentElement; i += 1) el = el.parentElement;
      return el || document;
    })();

    // Exact names first (Udemy), then the aria-labels of both languages, then
    // YouTube. Every candidate must be on screen and outside any menu.
    const anchors = [
      '[data-purpose="settings-button"]',
      '[data-purpose="captions-dropdown-button"]',
      '[data-purpose="theatre-mode-toggle-button"]',
      '[data-purpose="fullscreen-toggle"]',
      'button[aria-label="การตั้งค่า"]',
      'button[aria-label="คำบรรยาย"]',
      'button[aria-label="เข้าสู่เต็มหน้าจอ"]',
      'button[aria-label="Settings"]',
      'button[aria-label="Captions"]',
      ".ytp-settings-button",
    ];
    for (const selector of anchors) {
      const found = [...root.querySelectorAll(selector)].find(
        (el) => visible(el) && !el.closest('[class*="dropdown-menu"], [role="menu"], ul')
      );
      if (!found) continue;
      let native = found;
      // Step up while the control is alone in its wrapper (Udemy wraps each
      // button in a popper div) so we land among its peers, not inside one.
      while (native.parentElement && native.parentElement.children.length < 2) {
        native = native.parentElement;
      }
      const bar = native.parentElement;
      if (!bar || bar === document.body || bar.contains(state.video)) continue;
      bar.insertBefore(button, native);
      button.classList.remove("udth-pill-floating");
      button.classList.add("udth-tool");
      log("วางปุ่มไว้ข้างเครื่องมือของเพลเยอร์:", selector);
      return true;
    }

    const bar = site.controlBar();
    if (!bar || !visible(bar)) return false;
    bar.insertBefore(button, bar.firstChild);
    button.classList.remove("udth-pill-floating");
    button.classList.add("udth-tool");
    return true;
  }

  function panelEl(key) {
    return panel.el && panel.el.querySelector(`[data-udth="${key}"]`);
  }

  // Clicking the video to pause it should also put the menu away, the way the
  // player's own menus behave.
  function closeMenuOnOutsideClick(event) {
    if (!panel.open || !panel.el) return;
    if (panel.el.contains(event.target) || (panel.button && panel.button.contains(event.target))) {
      return;
    }
    panel.open = false;
    renderPanel();
  }
  document.addEventListener("click", closeMenuOnOutsideClick, true);

  function fillEngines(selected) {
    const select = panelEl("engine");
    if (!select) return;
    select.innerHTML = "";
    for (const engine of engineCatalogue()) {
      // An unusable engine is listed with its reason rather than hidden —
      // hiding it just makes a supported option look like it does not exist.
      const suffix = engine.ready ? "" : " — ยังตั้งค่าไม่ครบ";
      select.add(new Option(engine.label + suffix, engine.name));
    }
    // The saved engine can be one the server has not offered — it was stored
    // before the server was restarted, or the server is down entirely. Keep it
    // visible rather than leaving the box blank with no explanation.
    if (![...select.options].some((o) => o.value === selected)) {
      select.add(new Option(`${selected} — ยังไม่พร้อมใช้`, selected));
    }
    select.value = selected;
  }

  function fillVoices(engineName, selected) {
    const select = panelEl("voice");
    if (!select) return;

    const engine = engineByName(engineName);
    const voices =
      engineName === "windows"
        ? state.nativeVoices.map((v) => ({ id: v.name, label: v.name }))
        : engine.voices || [];

    select.innerHTML = "";
    if (!voices.length) {
      select.add(
        new Option(
          engineName === "windows"
            ? "เลือกอัตโนมัติ (รอ Windows โหลดเสียง)"
            : "เครื่องมือนี้ยังใช้ไม่ได้",
          ""
        )
      );
    } else {
      voices.forEach((v) => select.add(new Option(v.label, v.id)));
    }
    if ([...select.options].some((o) => o.value === selected)) select.value = selected;
    else if (select.options.length) select.selectedIndex = 0;
  }

  // One writer for every setting, so the panel, the popup and storage can never
  // drift apart: whatever the panel shows is what was just persisted.
  async function commitOptions(changes) {
    Object.assign(state, changes);
    if (changes.ttsEngine !== undefined || changes.ttsVoice !== undefined) {
      stopDubbing();
      resetAudioCache();
    }
    if (changes.dubbingEnabled === false) stopDubbing();

    syncDubbingVolume();
    if (state.overlay) state.overlay.style.display = state.enabled ? "" : "none";
    syncNativeCaptions();
    if (state.status === "ready") {
      resyncDub();
      if (state.dubbingEnabled) prefetchAudio(state.dub.cursor);
    }
    state.activeIndex = -1;
    onTimeUpdate();
    renderPanel();

    try {
      await chrome.storage.local.set({
        enabled: state.enabled,
        dualMode: state.dualMode,
        capSize: state.capSize,
        dubbingEnabled: state.dubbingEnabled,
        ttsEngine: state.ttsEngine,
        ttsVoice: state.ttsVoice,
        dubbingVolume: state.dubbingVolume,
        originalAudioVolume: state.originalAudioVolume,
        dubRateCap: state.dubRateCap,
      });
    } catch {
      /* storage unavailable — the settings still apply to this page */
    }
  }

  function wirePanel(el) {
    el.addEventListener("click", (event) => {
      const button = event.target.closest("[data-udth]");
      if (!button || button.tagName !== "BUTTON") return;
      // The button sits inside the player's control bar, and both players
      // treat stray clicks on themselves as play/pause. Without this, opening
      // the menu would also pause the lecture.
      event.stopPropagation();
      event.preventDefault();

      const action = button.dataset.udth;
      const val = button.dataset.val;
      if (action === "mode") {
        commitOptions(
          val === "off"
            ? { enabled: false }
            : { enabled: true, dualMode: val === "both" }
        );
      } else if (action === "size") commitOptions({ capSize: val });
      else if (action === "dub") commitOptions({ dubbingEnabled: !state.dubbingEnabled });
      else if (action === "settings") {
        panel.open = !panel.open;
        renderPanel();
        // The server is often started after the tab is already open, so the
        // list is refetched here rather than trusted from page load.
        if (panel.open) loadServerEngines();
      } else if (action === "retry") retranslateHere();
      else if (action === "section") {
        setPanelNote("กำลังเตรียมคิว ...");
        translateSection()
          .then((res) => setPanelNote(res.ok ? "ส่งเข้าคิวแล้ว" : res.error, !res.ok))
          .catch((err) => setPanelNote(describeTranslateError(err), true));
      }
    });

    el.addEventListener("change", (event) => {
      const key = event.target.dataset.udth;
      if (key === "engine") {
        const engine = event.target.value;
        fillVoices(engine, "");
        // Switching engine invalidates the old voice: voice ids are what route
        // a request to its engine, so keeping one would send it to the old one.
        commitOptions({ ttsEngine: engine, ttsVoice: panelEl("voice").value || "" });
      } else if (key === "voice") {
        commitOptions({ ttsVoice: event.target.value });
      }
    });

    el.addEventListener("input", (event) => {
      const key = event.target.dataset.udth;
      const value = Number(event.target.value);
      if (key === "dubVol") commitOptions({ dubbingVolume: value });
      else if (key === "srcVol") commitOptions({ originalAudioVolume: value });
      else if (key === "rate") commitOptions({ dubRateCap: value });
    });
  }

  function setPanelNote(text, isError = false) {
    const note = panel.el && panel.el.querySelector(".udth-panel-note");
    if (!note) return;
    note.textContent = text || "";
    note.classList.toggle("udth-panel-note-error", Boolean(isError));
  }

  async function retranslateHere() {
    const id = site.cacheId();
    if (id) {
      try {
        await chrome.storage.local.set({ forceLecture: String(id) });
      } catch {
        /* without the flag the reload just reuses the cache */
      }
    }
    location.reload();
  }

  function renderPanel() {
    const el = ensurePanel();
    if (!el) return;

    const mode = !state.enabled ? "off" : state.dualMode ? "both" : "th";
    for (const b of el.querySelectorAll('[data-udth="mode"]')) {
      const on = b.dataset.val === mode;
      b.classList.toggle("udth-seg-on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    for (const b of el.querySelectorAll('[data-udth="size"]')) {
      const on = b.dataset.val === state.capSize;
      b.classList.toggle("udth-seg-on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    const dub = el.querySelector('[data-udth="dub"]');
    dub.classList.toggle("udth-dubrow-on", state.dubbingEnabled);
    el.querySelector('[data-state="dub"]').textContent = state.dubbingEnabled ? "เปิดอยู่" : "ปิด";
    dub.setAttribute("aria-pressed", String(state.dubbingEnabled));
    if (state.overlay) state.overlay.dataset.size = state.capSize;

    // The button carries the state, so what is on is readable without opening
    // anything — the same job the player's own CC button does.
    panel.button.classList.toggle("udth-pill-on", state.enabled || state.dubbingEnabled);
    panel.button.classList.toggle("udth-pill-open", panel.open);
    panel.button.setAttribute("aria-expanded", String(panel.open));

    el.hidden = !panel.open;
    if (!panel.open) return;

    panelEl("src").textContent = state.sourceLang;
    fillEngines(state.ttsEngine);
    fillVoices(state.ttsEngine, state.ttsVoice);
    const hint = engineHint();
    if (hint) setPanelNote(hint, true);
    else if (panel.el.querySelector(".udth-panel-note-error")) setPanelNote("");
    panelEl("dubVol").value = String(state.dubbingVolume);
    panelEl("dubVolOut").value = `${Math.round(state.dubbingVolume * 100)}%`;
    panelEl("srcVol").value = String(state.originalAudioVolume);
    panelEl("srcVolOut").value = `${Math.round(state.originalAudioVolume * 100)}%`;
    panelEl("rate").value = String(state.dubRateCap);
    panelEl("rateOut").value = `${state.dubRateCap.toFixed(2)}x`;
    panelEl("section").hidden = !site.supportsSection;
  }

  function removePanel() {
    if (panel.el) panel.el.remove();
    if (panel.button) panel.button.remove();
    panel.el = null;
    panel.button = null;
    panel.open = false;
  }

  // ------------------------------------------------------------ loading gate
  //
  // Translation takes tens of seconds on a cold lecture. Letting the video run
  // through it means the first minute is watched with no Thai at all, so the
  // player is held until the subtitles exist — the same bargain other dubbing
  // extensions make. The escape hatch is deliberate: a wedged server must never
  // leave the page unusable.

  const gate = { el: null, video: null, hold: null, skipped: false, wasPlaying: false };

  function ensureGate() {
    if (gate.el && gate.el.isConnected) return gate.el;

    const el = document.createElement("div");
    el.className = "udth-gate";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML =
      '<div class="udth-gate-card">' +
      '<div class="udth-gate-spinner"></div>' +
      '<div class="udth-gate-title"></div>' +
      '<div class="udth-gate-detail"></div>' +
      '<button type="button" class="udth-gate-skip">ข้ามการรอ แล้วดูไปก่อน</button>' +
      "</div>";
    // A fixed element outside the fullscreen subtree is not painted while the
    // player is fullscreen, so the gate has to live inside it.
    (document.fullscreenElement || document.body).appendChild(el);
    el.querySelector(".udth-gate-skip").addEventListener("click", () => {
      gate.skipped = true;
      hideGate();
    });
    gate.el = el;
    return el;
  }

  // Pausing once is not enough: Udemy's own player, and the user, can both
  // start playback again while we are still waiting.
  function showGate(title, detail = "", kind = "info") {
    if (gate.skipped) return;
    const el = ensureGate();
    el.querySelector(".udth-gate-title").textContent = title;
    el.querySelector(".udth-gate-title").style.color = kind === "error" ? "#fb7185" : "";
    const detailEl = el.querySelector(".udth-gate-detail");
    detailEl.textContent = detail;
    detailEl.style.display = detail ? "" : "none";

    const spinner = el.querySelector(".udth-gate-spinner");
    if (spinner) spinner.style.display = kind === "error" ? "none" : "";

    const video = state.video;
    if (video && gate.video !== video) {
      releaseGateHold();
      gate.video = video;
      gate.wasPlaying = !video.paused;
      gate.hold = () => {
        gate.wasPlaying = true;
        video.pause();
      };
      video.addEventListener("play", gate.hold);
    }
    if (gate.video) gate.video.pause();
  }

  function releaseGateHold() {
    const video = gate.video;
    if (video && gate.hold) video.removeEventListener("play", gate.hold);
    gate.video = null;
    gate.hold = null;
    if (video && gate.wasPlaying) video.play().catch(() => {});
    gate.wasPlaying = false;
  }

  function hideGate() {
    releaseGateHold();
    if (gate.el) gate.el.remove();
    gate.el = null;
  }

  // ------------------------------------------------------------- Thai audio

  // Free, needs no setup, and the same neural voice Windows exposes locally.
  const DEFAULT_TTS_VOICE = "th-TH-NiwatNeural";
  // Google synthesis is not instantaneous, so keep a few segments buffered.
  const PREFETCH_AHEAD = 4;
  // A merged sentence is cut here even with no full stop in sight, so one
  // run-on passage cannot swallow a minute of speech into a single utterance.
  const MAX_SEGMENT_SECONDS = 14;
  // A pause this long between cues reads as a sentence break on its own.
  const SEGMENT_GAP_SECONDS = 1.2;
  // How late a segment may still begin. Past this the video has moved on and
  // speaking it would talk over what comes next, so it is dropped.
  const DUB_LATE_TOLERANCE = 2.5;
  // `timeupdate` fires about four times a second, so a segment is noticed up to
  // 250ms after it should have started; starting this early cancels the average
  // of that out instead of letting it read as lag.
  const DUB_START_LEAD = 0.25;
  // Windows voices report no duration up front. Rough measured pace of Thai
  // TTS, used only to decide how much to speed an utterance up.
  const THAI_CHARS_PER_SECOND = 12;

  // Udemy's caption cues are display fragments: three or four words, wrapped to
  // fit the screen and routinely cut mid-sentence. Dubbing them one-for-one is
  // what made the audio sound broken — every fragment became its own utterance,
  // and the next fragment's clock arrived long before the Thai sentence had
  // finished being said.
  //
  // So the dub runs on its own track, rebuilt by merging consecutive cues back
  // into sentences. Sentence boundaries are taken from the English, which has
  // the punctuation Thai output usually lacks.
  function endsSentence(text) {
    return /[.!?][")'\]]?\s*$/.test(text || "");
  }

  function buildDubSegments(cues) {
    const segments = [];
    let current = null;

    const flush = () => {
      if (current) segments.push(current);
      current = null;
    };

    for (const cue of cues) {
      const th = (cue.th || "").trim();
      if (!th) continue;

      const breaks =
        current &&
        (cue.start - current.end > SEGMENT_GAP_SECONDS ||
          cue.end - current.start > MAX_SEGMENT_SECONDS);
      if (breaks) flush();

      if (current) {
        current.text += " " + th;
        current.end = cue.end;
      } else {
        current = { start: cue.start, end: cue.end, text: th };
      }
      if (endsSentence(cue.en)) flush();
    }
    flush();

    // The real budget for a sentence is not when its subtitle disappears — it
    // is when the next sentence has to start. Instructors pause between
    // sentences, and spending that pause is what keeps the dub level with them
    // instead of drifting a little further behind on every line.
    segments.forEach((segment, n) => {
      const next = segments[n + 1];
      segment.budgetEnd = next ? next.start : segment.end + 3;
    });
    return segments;
  }

  function stopDubbing() {
    // Invalidate every in-flight callback before tearing anything down, so a
    // late `onended` cannot resume the scheduler after we asked it to stop.
    state.dub.token += 1;
    state.dub.playing = false;
    if (state.nativeSpeech) {
      window.speechSynthesis.cancel();
      state.nativeSpeech = false;
    }
    if (!state.audio) return;
    state.audio.pause();
    state.audio = null;
  }

  // After a seek the cursor must point at the segment covering the new time,
  // not wherever playback happened to be.
  function resyncDub() {
    stopDubbing();
    const now = (state.video && state.video.currentTime) || 0;
    const segments = state.dub.segments;
    let i = 0;
    while (i < segments.length && segments[i].end <= now) i += 1;
    state.dub.cursor = i;
  }

  // Requests cannot be aborted reliably once a service worker has passed them
  // to the local server. A generation token makes every old completion inert
  // after a seek, lecture change, or voice/engine switch.
  function resetAudioCache() {
    state.audioGeneration += 1;
    // These are blob URLs, and a blob stays in memory until its last URL is
    // revoked. A three-hour course would otherwise end holding every line it
    // ever spoke.
    state.audioUrls.forEach((url) => URL.revokeObjectURL(url));
    state.audioUrls.clear();
    state.audioPending.clear();
    state.audioElements.clear();
  }

  // The audio arrives as bytes rather than as a URL to fetch, because the page
  // is not always allowed to reach the local server — see synthesizeSpeech in
  // background.js. Turning it into a blob gives back a URL the page owns
  // outright, so playback no longer depends on a per-site permission.
  function blobUrl(data) {
    const binary = atob(data.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: data.type || "audio/mpeg" }));
  }

  // Knowing the URL is not the same as being ready to play it: the browser
  // still has to fetch and decode the MP3, which is long enough to hear as lag.
  // Decoding it during prefetch means playback starts on the same tick it is
  // asked for.
  function preloadAudio(index, url) {
    if (!url || state.audioElements.has(index)) return;
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = url;
    audio.load();
    state.audioElements.set(index, audio);
  }

  function syncDubbingVolume() {
    if (!state.video) return;
    if (state.dubbingEnabled) {
      if (state.sourceVolume === null) state.sourceVolume = state.video.volume;
      state.video.volume = state.originalAudioVolume;
    } else if (state.sourceVolume !== null) {
      state.video.volume = state.sourceVolume;
      state.sourceVolume = null;
    }
  }

  async function audioUrlFor(index) {
    const segment = state.dub.segments[index];
    if (!segment || !segment.text) return null;
    if (state.audioUrls.has(index)) return state.audioUrls.get(index);
    if (state.audioPending.has(index)) return state.audioPending.get(index);

    const generation = state.audioGeneration;
    const request = chrome.runtime
      .sendMessage({
        type: "synthesizeSpeech",
        payload: { text: segment.text, voice: state.ttsVoice || DEFAULT_TTS_VOICE },
      })
      .then((res) => {
        if (!res || !res.ok) throw new Error((res && res.error) || "สร้างเสียงไม่สำเร็จ");
        // Checked before the blob is built, so a stale reply allocates nothing.
        if (generation !== state.audioGeneration) return null;
        const url = blobUrl(res.data);
        state.audioUrls.set(index, url);
        preloadAudio(index, url);
        return url;
      })
      .finally(() => {
        // Never erase the newer request for the same cue.
        if (generation === state.audioGeneration) state.audioPending.delete(index);
      });
    state.audioPending.set(index, request);
    return request;
  }

  function prefetchAudio(index) {
    if (!state.dubbingEnabled || state.ttsEngine === "windows") return;
    const last = Math.min(state.dub.segments.length, index + PREFETCH_AHEAD);
    for (let i = Math.max(0, index); i < last; i += 1) {
      audioUrlFor(i).catch((err) => log("สร้างเสียงล่วงหน้าไม่สำเร็จ", err));
    }
  }

  // How fast this utterance has to be spoken to land inside the window it has
  // left. Watching at 1.5x shrinks that window in real time, so the video's own
  // speed raises the ceiling too — someone already listening fast expects it.
  function fitRate(durationSeconds, segment) {
    const speed = (state.video && state.video.playbackRate) || 1;
    const cap = state.dubRateCap * speed;
    const remaining = (segment.budgetEnd - state.video.currentTime) / speed;
    if (!(durationSeconds > 0) || !(remaining > 0)) return cap;
    return Math.max(1, Math.min(cap, durationSeconds / remaining));
  }

  // The scheduler. Called on every timeupdate and again whenever an utterance
  // ends — never on a cue boundary, which is what used to cut speech off.
  function tickDubbing() {
    if (!state.dubbingEnabled) return;
    if (!state.video || state.video.paused || state.video.ended) return;

    if (state.dub.playing) {
      // Chrome drops `onend` on long speechSynthesis utterances, and a stalled
      // MP3 never fires `ended` either. Without this the flag would stay set
      // and the rest of the lecture would play silent.
      if (Date.now() < state.dub.deadline) return;
      log("เสียงพากย์ค้าง — ข้ามไปประโยคถัดไป");
      stopDubbing();
    }

    const segments = state.dub.segments;
    const now = state.video.currentTime;

    // Skip anything the video has already run past — a sentence spoken this
    // late would be talking over the one after it.
    while (
      state.dub.cursor < segments.length &&
      now > segments[state.dub.cursor].end + DUB_LATE_TOLERANCE
    ) {
      state.dub.cursor += 1;
    }

    const index = state.dub.cursor;
    const segment = segments[index];
    if (!segment || now < segment.start - DUB_START_LEAD) return;

    state.dub.cursor = index + 1;
    prefetchAudio(index + 1);
    speakSegment(index, segment);
  }

  async function speakSegment(index, segment) {
    const token = (state.dub.token += 1);
    state.dub.playing = true;
    // Replaced with a real figure as soon as one is known; until then this is
    // only a ceiling on how long a wedged utterance can block the queue.
    state.dub.deadline = Date.now() + 45000;
    const setDeadline = (seconds, rate) => {
      state.dub.deadline = Date.now() + ((seconds / rate) + 5) * 1000;
    };

    // One exit for every outcome — ended, failed, or never started. Missing any
    // of them would leave `playing` stuck true and silence the rest of the
    // lecture, so the scheduler is always re-armed from here.
    const finish = () => {
      if (state.dub.token !== token) return;
      state.dub.playing = false;
      state.nativeSpeech = false;
      state.audio = null;
      tickDubbing();
    };

    if (state.ttsEngine === "windows") {
      const utterance = new SpeechSynthesisUtterance(segment.text);
      const voices = window.speechSynthesis.getVoices();
      const chosen = voices.find((voice) => voice.name === state.ttsVoice);
      // Windows exposes its cloud-backed voices as "Online (Natural)". Prefer
      // them but degrade gracefully to any installed Thai voice.
      utterance.voice = chosen || voices.find(
        (voice) => /^th(?:-|_)/i.test(voice.lang) && /natural|online/i.test(voice.name)
      ) || voices.find((voice) => /^th(?:-|_)/i.test(voice.lang)) || null;
      utterance.lang = "th-TH";
      utterance.volume = state.dubbingVolume;
      const spoken = segment.text.length / THAI_CHARS_PER_SECOND;
      utterance.rate = fitRate(spoken, segment);
      setDeadline(spoken, utterance.rate);
      utterance.onend = finish;
      utterance.onerror = finish;
      state.nativeSpeech = true;
      window.speechSynthesis.speak(utterance);
      return;
    }

    let url = state.audioUrls.get(index);
    if (!url) {
      // Waiting on synthesis is better than dropping the line silently, which
      // is what the old code did whenever the buffer had not caught up.
      try {
        url = await audioUrlFor(index);
      } catch (err) {
        log("สร้างเสียงไม่สำเร็จ", err);
        renderStatus(
          `ซับพร้อมแล้ว แต่พากย์เสียงไม่ได้: ${String(err.message || err).slice(0, 90)}`,
          "error"
        );
        finish();
        return;
      }
      if (state.dub.token !== token) return;
      // Synthesis may have taken long enough that this sentence is now stale.
      if (!url || state.video.currentTime > segment.end + DUB_LATE_TOLERANCE) {
        finish();
        return;
      }
    }

    // Prefer the element prefetch already decoded; only build one from scratch
    // when this segment was reached before the buffer got to it.
    const audio = state.audioElements.get(index) || new Audio(url);
    state.audioElements.delete(index);
    try {
      audio.currentTime = 0;
    } catch {
      /* not seekable yet — it starts at zero anyway */
    }
    audio.volume = state.dubbingVolume;
    // Without this Chrome shifts pitch along with rate and the voice squeaks.
    audio.preservesPitch = true;
    audio.onended = finish;
    audio.onerror = finish;

    const applyRate = () => {
      if (state.dub.token !== token || !(audio.duration > 0)) return;
      audio.playbackRate = fitRate(audio.duration, segment);
      setDeadline(audio.duration, audio.playbackRate);
    };
    // A preloaded element already has its metadata, and `loadedmetadata` has
    // then long since fired — so the rate must be applied directly as well.
    if (audio.readyState >= 1) applyRate();
    else audio.addEventListener("loadedmetadata", applyRate);

    // An element that neither loads nor errors is otherwise invisible: the
    // 45-second watchdog eventually steps over it and the only symptom is
    // silence. That is exactly how a browser-level block on reaching the local
    // server looked, and it cost a long hunt through the speech engines to
    // find. Say so instead.
    const stalled = setTimeout(() => {
      if (state.dub.token === token && audio.readyState < 1) {
        log("เสียงโหลดไม่ขึ้นและไม่แจ้ง error", {
          readyState: audio.readyState,
          networkState: audio.networkState,
          src: String(audio.src).slice(0, 60),
        });
      }
    }, 3000);
    const clearStall = () => clearTimeout(stalled);
    audio.addEventListener("loadedmetadata", clearStall);
    audio.addEventListener("error", clearStall);

    state.audio = audio;
    try {
      await audio.play();
    } catch (err) {
      log("พากย์เสียงไม่ได้", err);
      finish();
    }
  }

  // ------------------------------------------------------------------ video

  function findVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.find((v) => v.duration > 1) || videos[0] || null;
  }

  // The player mounts well after document_idle — on a real lecture page it took
  // ~14s. Poll rather than guess a delay; giving up after one miss was what
  // made the overlay never appear at all.
  async function waitForVideo(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    while (Date.now() < deadline) {
      const video = findVideo();
      if (video && video.readyState >= 1) return video;
      if (!announced) {
        log("รอตัวเล่นวิดีโอ ...");
        announced = true;
      }
      await sleep(700);
    }
    return null;
  }

  // -------------------------------------------------------------- Udemy API

  function lectureId() {
    return (location.pathname.match(/\/learn\/lecture\/(\d+)/) || [])[1] || null;
  }

  function courseSlug() {
    return (location.pathname.match(/\/course\/([^/]+)/) || [])[1] || null;
  }

  const getJson = UDTH.util.getJson;
  const findControlBarNear = UDTH.findControlBar;

  let courseIdCache = { slug: null, id: null };

  async function getCourseId() {
    const slug = courseSlug();
    if (!slug) throw new Error("อ่านรหัสคอร์สจาก URL ไม่ได้");
    if (courseIdCache.slug === slug && courseIdCache.id) return courseIdCache.id;

    const course = await getJson(`/api-2.0/courses/${slug}/?fields[course]=id`);
    const id = course && course.id;
    if (!id) throw new Error("หา course id ไม่เจอ");
    courseIdCache = { slug, id };
    return id;
  }

  // One call describes the whole lecture: is it a video or an article, which
  // captions exist, and (for articles) the HTML body.
  //
  // The id is a parameter rather than always being read from the URL, because
  // translating a section ahead of time means asking about lectures the user
  // has not opened yet.
  async function fetchLectureAsset(lecture) {
    const target = lecture || lectureId();
    if (!target) throw new Error("อ่านรหัสบทเรียนจาก URL ไม่ได้");

    const courseId = await getCourseId();
    const data = await getJson(
      `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${target}/` +
        `?fields[lecture]=asset,title&fields[asset]=asset_type,captions,body` +
        `&fields[caption]=locale_id,title,url,source`
    );
    const asset = (data && data.asset) || {};
    return {
      courseId,
      title: (data && data.title) || "",
      type: asset.asset_type || "",
      captions: asset.captions || [],
      body: asset.body || "",
    };
  }

  function pickCaption(captions, prefix) {
    const matches = captions.filter((c) =>
      new RegExp(`^${prefix}`, "i").test(c.locale_id || "")
    );
    if (!matches.length) return null;
    // A human-made caption beats an auto-generated one.
    return matches.find((c) => c.source === "manual") || matches[0];
  }

  // ------------------------------------------------------------- VTT parsing

  function parseVtt(text) {
    const cues = [];
    const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
    const timing =
      /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

    for (const block of blocks) {
      const match = block.match(timing);
      if (!match) continue;
      const start = toSeconds(match[1], match[2], match[3], match[4]);
      const end = toSeconds(match[5], match[6], match[7], match[8]);

      const body = block
        .slice(block.indexOf(match[0]) + match[0].length)
        .split("\n")
        .slice(1)
        .join(" ")
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (body) cues.push({ start, end, text: body });
    }
    return cues;
  }

  function toSeconds(hours, minutes, seconds, fraction) {
    const h = hours ? parseInt(hours, 10) : 0;
    const frac = parseInt(fraction, 10) / Math.pow(10, String(fraction).length);
    return h * 3600 + parseInt(minutes, 10) * 60 + parseInt(seconds, 10) + frac;
  }

  // ------------------------------------------------------- cues from an asset
  //
  // The lecture on screen and a lecture queued for later both come through
  // here. That matters: the server keys its cache on the cue list, so if the
  // two paths built cues even slightly differently, everything translated in
  // advance would miss the cache and be translated a second time.

  const SKIP_TEXT = {
    "no-english": "บทนี้ไม่มีคำบรรยายอังกฤษให้แปล",
    "no-captions": "วิดีโอนี้ไม่มีคำบรรยายเลย จึงแปลไม่ได้",
    "caption-blocked": "YouTube ไม่ยอมส่งไฟล์คำบรรยายมา — ลองเปิด CC บนวิดีโอสักครั้งแล้วกด F5",
    "caption-no-token":
      "ขอ token จาก YouTube ไม่ได้ — เล่นวิดีโอสักครู่ แล้วกดปุ่ม CC หนึ่งครั้ง จากนั้นกด F5",
    "caption-fetch-failed": "โหลดไฟล์คำบรรยายไม่สำเร็จ",
    "caption-parse-failed": "อ่านไฟล์คำบรรยายไม่ได้",
    "empty-article": "บทความนี้ไม่มีเนื้อหาให้แปล",
    "code-only": "บทความนี้มีแต่โค้ด ไม่มีข้อความให้แปล",
  };

  async function videoCues(asset) {
    const captions = asset.captions || [];

    // Only a human-made Thai track beats what we produce. Udemy's "auto" Thai
    // is machine translation stacked on machine transcription — the errors
    // compound, so we translate it ourselves instead.
    const thai = pickCaption(captions, "th");
    if (thai && thai.source === "manual") return { ok: false, code: "native-thai" };

    const english = pickCaption(captions, "en");
    if (!english || !english.url) return { ok: false, code: "no-english" };

    const vtt = await fetch(english.url).then((r) => (r.ok ? r.text() : null));
    if (!vtt) return { ok: false, code: "caption-fetch-failed" };

    const cues = parseVtt(vtt);
    if (!cues.length) return { ok: false, code: "caption-parse-failed" };
    return { ok: true, cues, replacingAutoThai: !!thai };
  }

  function articleCues(asset) {
    if (!asset.body) return { ok: false, code: "empty-article" };

    // Work on a detached copy of the HTML Udemy gave us, not the live page.
    const holder = document.createElement("div");
    holder.innerHTML = asset.body;

    const blocks = collectBlocks(holder).filter((el) => !isCodeBlock(el));
    if (!blocks.length) return { ok: false, code: "code-only" };

    return {
      ok: true,
      holder,
      blocks,
      cues: blocks.map((el, n) => ({
        start: n,
        end: n + 1,
        text: (el.textContent || "").replace(/\s+/g, " ").trim(),
      })),
    };
  }

  // ---------------------------------------------------------- site adapter
  //
  // Udemy's half of the interface described in sites.js. It is assembled here
  // rather than there because every function it wraps already lives in this
  // file; only YouTube needed code that did not exist yet.

  const udemySite = {
    name: "udemy",
    supportsSection: true,

    pageKey: () => lectureId() || quizId() || assignmentId(),
    cacheScope: courseSlug,
    cacheId: () => lectureId() || (quizId() ? `quiz-${quizId()}` : (assignmentId() ? `assignment-${assignmentId()}` : null)),
    title: lessonTitle,
    playerContainer: () => null, // the overlay anchors to the video's parent

    // Udemy marks its player parts with `data-purpose`, which survives the
    // per-build class-name hashing that made every class-based guess fail.
    // The anchor search is kept as a last resort for builds that drop it.
    controlBar() {
      return (
        document.querySelector('[data-purpose="video-control-bar"]') ||
        document.querySelector('[data-purpose="video-controls"]') ||
        findControlBarNear(document.querySelector("video"))
      );
    },

    async describe() {
      // Quiz and Assignment pages carry no lecture id, so they must be detected first.
      const quiz = quizId();
      if (quiz) return { kind: "quiz", payload: quiz };
      const assignment = assignmentId();
      if (assignment) return { kind: "assignment", payload: assignment };

      const asset = await fetchLectureAsset();
      log("ชนิดบทเรียน", asset.type || "(ไม่ระบุ)");
      return { kind: asset.type === "Article" ? "article" : "video", payload: asset };
    },

    videoCues,
  };

  const site = UDTH.isYouTube ? UDTH.youtube : udemySite;

  // --------------------------------------------------------------- sync loop

  // Udemy cuts captions into 3-5 word display fragments, often mid-clause
  // ("...another tutorial on this section where we are covering"). Shown one by
  // one, the Thai changes every second or two and each piece starts and ends in
  // the middle of a thought, which is what makes it so hard to read. The
  // viewer therefore shows whole sentences: consecutive fragments are merged
  // using the English punctuation, and each sentence stays up for as long as it
  // is being spoken. Long sentences are split at a fragment boundary, never in
  // the middle of one, so no word is ever cut.
  // Captions are built in two steps. First fragments are merged back into whole
  // sentences, however long. Then each sentence is cut into display chunks at
  // *word* boundaries so no chunk is more than two lines, with the sentence's
  // time shared out by how much text each chunk holds. Cutting by cue instead
  // (the old way) left chunks that stopped mid-clause ("...เทียบกับค่าใน").
  const VIEW_CHUNK_CHARS = 58; // two lines of Thai at the caption width
  const VIEW_MAX_SENTENCE_SECONDS = 16;
  const VIEW_BRIDGE_GAP = 0.6; // keep a caption up across a tiny pause: no flicker
  const view = { src: null, len: -1, cues: [] };

  const segmenter =
    typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("th", { granularity: "word" }) : null;

  // Thai has no spaces between words. The browser's own line breaking split
  // words in half ("ตรวจ" / "สอบ"), so words are found here and each one is
  // kept whole when drawn.
  function thaiWords(text) {
    if (!segmenter) return text.split(/(\s+)/).filter(Boolean);
    return [...segmenter.segment(text)].map((p) => p.segment);
  }

  function splitEvenly(words, maxChars) {
    const total = words.reduce((n, w) => n + w.length, 0);
    if (total <= maxChars) return [words];
    const parts = Math.ceil(total / maxChars);
    const target = total / parts;
    const chunks = [];
    let cur = [];
    let curLen = 0;
    for (const w of words) {
      cur.push(w);
      curLen += w.length;
      // Prefer to break right after a space or a closing bracket.
      const soft = /\s$|[)\]]$/.test(w);
      if (chunks.length < parts - 1 && (curLen >= target * 1.05 || (soft && curLen >= target * 0.85))) {
        chunks.push(cur);
        cur = [];
        curLen = 0;
      }
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  function buildViewCues(cues) {
    const sentences = [];
    let cur = null;
    const flush = () => {
      if (cur) sentences.push(cur);
      cur = null;
    };
    for (const cue of cues) {
      const th = (cue.th || "").trim();
      const en = (cue.en || "").trim();
      if (!th && !en) continue;
      if (cur && (cue.start - cur.end > 1.2 || cue.end - cur.start > VIEW_MAX_SENTENCE_SECONDS)) flush();
      if (cur) {
        cur.th = (cur.th + " " + th).trim();
        cur.en = (cur.en + " " + en).trim();
        cur.end = cue.end;
      } else {
        cur = { start: cue.start, end: cue.end, th, en };
      }
      if (endsSentence(en) && cur.th.length >= 8) flush();
    }
    flush();

    const out = [];
    for (const sentence of sentences) {
      const chunks = splitEvenly(thaiWords(sentence.th), VIEW_CHUNK_CHARS);
      const enWords = sentence.en.split(/\s+/).filter(Boolean);
      const total = chunks.reduce((n, c) => n + c.join("").length, 0) || 1;
      const span = sentence.end - sentence.start;
      let at = sentence.start;
      let enAt = 0;
      chunks.forEach((chunk, i) => {
        const len = chunk.join("").length;
        const dur = (span * len) / total;
        const last = i === chunks.length - 1;
        const enTake = last ? enWords.length - enAt : Math.round((enWords.length * len) / total);
        out.push({
          start: at,
          end: last ? sentence.end : at + dur,
          th: chunk.join("").trim(),
          en: enWords.slice(enAt, enAt + enTake).join(" "),
        });
        at += dur;
        enAt += enTake;
      });
    }
    // Hold each caption through a short pause rather than blanking the screen.
    out.forEach((c, n) => {
      const next = out[n + 1];
      if (next && next.start - c.end <= VIEW_BRIDGE_GAP) c.end = next.start;
    });
    return out;
  }

  function viewCues() {
    if (view.src !== state.cues || view.len !== state.cues.length) {
      view.src = state.cues;
      view.len = state.cues.length;
      view.cues = buildViewCues(state.cues);
      state.activeIndex = -1;
    }
    return view.cues;
  }

  function findCueAt(time) {
    const cues = viewCues();
    if (!cues.length) return -1;

    const current = cues[state.activeIndex];
    if (current && time >= current.start && time < current.end) return state.activeIndex;

    for (let i = 0; i < cues.length; i += 1) {
      if (time >= cues[i].start && time < cues[i].end) return i;
    }
    return -1;
  }

  // Subtitles and dubbing are driven separately: the caption must change on the
  // cue boundary, the voice must not.
  function onTimeUpdate() {
    if (state.status !== "ready" || !state.video) return;
    if (state.enabled) {
      const index = findCueAt(state.video.currentTime);
      if (index !== state.activeIndex) {
        state.activeIndex = index;
        renderCue(index >= 0 ? viewCues()[index] : null);
      }
    }
    tickDubbing();
  }

  function onVideoPause() {
    stopDubbing();
  }

  function onVideoSeeking() {
    resyncDub();
    state.activeIndex = -1;
  }

  function onVideoPlay() {
    state.activeIndex = -1;
    // Resuming mid-sentence would replay it from the top; re-aim at wherever
    // the playhead now is instead.
    resyncDub();
    onTimeUpdate();
  }

  // ------------------------------------------------------------ orchestration

  // "แปลบทเรียนนี้ใหม่" reloads the page, so the request has to survive in
  // storage rather than in memory — keyed by lesson so it cannot leak into a
  // different one, and consumed on read so it only applies once.
  async function takeForceFlag(id) {
    if (!id) return false;
    try {
      const stored = await chrome.storage.local.get("forceLecture");
      if (stored.forceLecture && String(stored.forceLecture) === String(id)) {
        await chrome.storage.local.remove("forceLecture");
        return true;
      }
    } catch {
      /* storage unavailable — fall back to using the cache */
    }
    return false;
  }

  function lessonTitle() {
    const heading = document.querySelector(
      '[class*="curriculum-item-view--title"], [data-purpose="lecture-title"], h1'
    );
    const text = heading && heading.textContent ? heading.textContent.trim() : "";
    return text || document.title.replace(/\s*\|\s*Udemy.*$/i, "").trim() || "บทเรียน";
  }

  // Ask what kind of lecture this is before touching the player — article
  // lectures have no <video>, so waiting for one would just stall for 90s.
  // A leftover panel from the previous lecture would otherwise sit above the
  // new one, showing the wrong translation.
  function cleanupArticle() {
    const panel = document.querySelector(".udth-doc");
    if (panel) panel.remove();
    document
      .querySelectorAll('[class*="article-asset--container"],[class*="article-asset"]')
      .forEach((el) => {
        if (el.style.display === "none") el.style.display = "";
      });
  }

  async function start() {
    // Anything still in flight from the previous lecture is now stale.
    state.generation += 1;
    hideGate();
    // Skipping the wait was a decision about that lecture, not about the course.
    gate.skipped = false;
    cleanupArticle();
    cleanupQuiz();
    cleanupAssignment();

    const described = await site.describe();
    if (!described) return; // not a page this site knows how to translate

    if (described.kind === "quiz") return startQuiz(described.payload);
    if (described.kind === "assignment") return startAssignment(described.payload);
    if (described.kind === "article") return startArticle(described.payload);
    return startVideo(described.payload);
  }

  // How much translated runway is enough to hand the player back. Chunks land
  // out of order, so what matters is not how many are done but whether the
  // stretch the viewer is about to watch is covered.
  const READY_AHEAD_SECONDS = 90;

  function coveredUntil(cues, from) {
    let until = from;
    for (const cue of cues) {
      if (!cue.th || cue.end <= until) continue;
      // A gap means the run of translated lines has ended.
      if (cue.start > until + 0.5) break;
      until = cue.end;
    }
    return until;
  }

  // Enough runway to hand the player back — either the configured lookahead,
  // or everything that is left. Near the end of a lecture there is simply less
  // than the lookahead remaining, and waiting for runway that cannot exist
  // would hold a fully translated lecture hostage.
  function readyToRelease(cues, from) {
    const until = coveredUntil(cues, from);
    if (until - from >= READY_AHEAD_SECONDS) return true;
    const last = cues.length ? cues[cues.length - 1] : null;
    return Boolean(last && last.th && until >= last.end - 0.01);
  }

  // Show a partial translation and, once there is enough of it ahead of the
  // playhead, let the lecture run while the rest keeps arriving. Waiting for
  // the whole lecture was most of the wait; almost none of it was needed.
  function applyPartial(partial, generation) {
    if (generation !== state.generation || !state.video) return;

    state.cues = partial;
    state.dub.segments = buildDubSegments(partial);
    syncNativeCaptions();

    if (state.status === "ready") {
      // Already released — just keep the growing translation flowing in.
      resyncDub();
      if (state.dubbingEnabled) prefetchAudio(state.dub.cursor);
      state.activeIndex = -1;
      onTimeUpdate();
      return;
    }

    const now = state.video.currentTime || 0;
    const ready = coveredUntil(partial, now) - now;
    if (!readyToRelease(partial, now)) {
      const done = partial.filter((c) => c.th).length;
      showGate(
        `กำลังแปลเป็นไทย ... (${done}/${partial.length} บรรทัด)`,
        `พร้อมแล้ว ${Math.max(0, Math.round(ready))} วินาทีข้างหน้า — เริ่มดูได้เมื่อถึง ${READY_AHEAD_SECONDS} วินาที`
      );
      return;
    }

    log("ปล่อยให้ดูได้แล้ว — แปลล่วงหน้าไว้", Math.round(ready), "วินาที");
    state.status = "ready";
    state.activeIndex = -1;
    resyncDub();
    prefetchAudio(state.dub.cursor);
    hideGate();
    renderStatus("เริ่มดูได้เลย — ส่วนที่เหลือกำลังแปลอยู่เบื้องหลัง", "ok");
    onTimeUpdate();
  }

  async function startVideo(payload) {
    const generation = state.generation;
    const video = await waitForVideo();
    if (!video) {
      log("ไม่พบวิดีโอในหน้านี้");
      return;
    }
    log("พบวิดีโอ", { duration: video.duration });

    state.video = video;
    state.sourceVolume = null;
    state.cues = [];
    state.activeIndex = -1;
    state.dub.segments = [];
    state.dub.cursor = 0;
    resetAudioCache();
    stopDubbing();
    // A new Udemy lecture mounts a new <video> with its own volume. Reapply
    // ducking immediately or the instructor suddenly returns at full volume.
    syncDubbingVolume();
    state.hasNativeThai = false;
    syncNativeCaptions(); // a new lecture starts with the site's captions visible
    ensureOverlay(video);
    // The player is rebuilt on every lecture change, taking the panel with it.
    removePanel();
    renderPanel();

    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("pause", onVideoPause);
    video.removeEventListener("seeking", onVideoSeeking);
    video.removeEventListener("play", onVideoPlay);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("pause", onVideoPause);
    video.addEventListener("seeking", onVideoSeeking);
    video.addEventListener("play", onVideoPlay);

    state.status = "loading";
    renderStatus("กำลังตรวจคำบรรยายของวิดีโอนี้ ...");
    showGate("กำลังตรวจคำบรรยายของวิดีโอนี้ ...", site.title());

    const built = await site.videoCues(payload);
    if (!built.ok && built.code === "native-thai") {
      hideGate();
      state.hasNativeThai = true;
      state.status = "native";
      renderStatus(
        "บทนี้มีซับไทยที่คนแปลไว้แล้ว — กด CC เลือกไทย จะดีกว่าให้ AI แปล",
        "ok"
      );
      setTimeout(() => {
        if (state.status === "native") clearLine();
      }, 8000);
      return;
    }
    if (!built.ok) {
      hideGate();
      state.status = "error";
      renderStatus(SKIP_TEXT[built.code] || "แปลบทนี้ไม่ได้", "error");
      return;
    }

    const cues = built.cues;
    const replacingAutoThai = built.replacingAutoThai;
    if (built.sourceLang) {
      state.sourceLang = built.sourceLang;
      renderPanel();
    }
    if (replacingAutoThai) {
      log("มีซับไทยอัตโนมัติอยู่แล้ว — จะแปลใหม่ด้วย AI แทน");
    }

    const force = await takeForceFlag(site.cacheId());

    state.status = "translating";
    const headline = force
      ? `กำลังแปล ${cues.length} บรรทัดใหม่ (ไม่ใช้ของเดิม) ...`
      : `กำลังแปล ${cues.length} บรรทัดเป็นไทย ... (ครั้งแรกใช้เวลาสักครู่)`;
    renderStatus(headline);
    showGate(headline, site.title());

    let translated;
    try {
      translated = await requestTranslation(
        {
          course: site.cacheScope(),
          lecture: site.cacheId(), // stable cache identity, unlike the title
          title: site.title(),
          cues,
          force,
        },
        generation,
        (done, total) => {
          const suffix = total ? ` (${done}/${total})` : "";
          renderStatus(`กำลังแปลเป็นไทย ...${suffix}`);
          showGate(
            `กำลังแปลเป็นไทย ...${suffix}`,
            total ? `แปลไปแล้ว ${done} จาก ${total} ช่วง` : site.title()
          );
        },
        (partial) => applyPartial(partial, generation)
      );
    } catch (err) {
      if (err instanceof Stale) return; // user moved on; nothing to report
      hideGate();
      state.status = "error";
      renderStatus(describeTranslateError(err), "error");
      return;
    }

    state.cues = translated || [];
    state.dub.segments = buildDubSegments(state.cues);
    state.status = "ready";
    state.activeIndex = -1;
    syncNativeCaptions();
    log("ช่วงพากย์เสียง", state.dub.segments.length, "ประโยค");
    // Buffer ahead of the playhead before releasing the video, so the first
    // sentences are ready instead of arriving one late request at a time.
    resyncDub();
    prefetchAudio(state.dub.cursor);
    hideGate();
    renderStatus(
      replacingAutoThai
        ? `พร้อมแล้ว — ซับไทย ${state.cues.length} บรรทัด (แปลใหม่แทนซับอัตโนมัติของ Udemy)`
        : `พร้อมแล้ว — ซับไทย ${state.cues.length} บรรทัด`,
      "ok"
    );
    setTimeout(() => {
      if (state.status === "ready") onTimeUpdate();
    }, 1500);
  }

  // ---------------------------------------------------------------- quiz mode


  // ---------------------------------------------------------- assignment mode

  function assignmentId() {
    return (location.pathname.match(/\/learn\/practice\/(\d+)/) || [])[1] || null;
  }

  function collectAssignmentBlocks(root) {
    const blocks = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walk.nextNode())) {
      const text = node.nodeValue.replace(/\s+/g, " ").trim();
      if (!text || text.length < 2) continue;
      if (/^[\d\.]*$/.test(text)) continue;
      
      const el = node.parentElement;
      if (!el) continue;
      if (el.tagName === "CODE" || el.tagName === "PRE" || el.closest("pre")) continue;
      if (el.classList.contains("udth-assignment-th")) continue;
      if (el.closest('button') || el.closest('[class*="progress-bar"]') || el.closest('[class*="banner"]')) continue;
      
      blocks.push({ el, text });
    }
    // Deduplicate elements while remembering the text we found
    const unique = [];
    const seen = new Set();
    for (const b of blocks) {
      if (!seen.has(b.el)) {
        seen.add(b.el);
        unique.push(b);
      }
    }
    return unique;
  }

  async function startAssignment(id) {
    const generation = state.generation;
    let container = null;
    for (let i = 0; i < 40; i++) {
      container =
        document.querySelector('[class*="assignment-instructions--"]') ||
        document.querySelector('[class*="assignment--content"]') ||
        document.querySelector('[class*="practice--mt-xxx1"]') ||
        document.querySelector('[class*="question--title-text"]') ||
        document.querySelector('[data-purpose="curriculum-item-viewer-content"]');
      if (container) break;
      await sleep(500);
    }
    if (!container) return;

    const blocks = collectAssignmentBlocks(container);
    if (!blocks.length) return;

    state.status = "translating";
    showGate(`กำลังแปลคำสั่ง Assignment ${blocks.length} บรรทัดเป็นไทย ...`);

    const payload = {
      course: courseSlug(),
      lecture: `assignment-${id}`,
      title: lessonTitle(),
      cues: blocks.map((b, n) => { return { start: n, end: n + 1, text: b.text }; }),
      mode: "doc",
    };

    let translated;
    try {
      translated = await requestTranslation(
        { ...payload, force: await takeForceFlag(payload.lecture) },
        generation,
        (done, total) => {
          const suffix = total ? ` (${done}/${total})` : "";
          showGate(`กำลังแปลคำสั่ง Assignment ...${suffix}`);
        }
      );
    } catch (err) {
      if (err instanceof Stale) return;
      state.status = "error";
      showGate(describeTranslateError(err), "error");
      return;
    }

    state.quizMap = new Map();
    (translated || []).forEach((cue, n) => {
      if (cue && cue.th && payload.cues[n]) {
        state.quizMap.set(normalizeText(payload.cues[n].text), cue.th);
      }
    });

    state.status = "ready";
    hideGate();
    watchAssignmentDom(container);
  }

  function injectAssignmentTranslations(container) {
    if (!state.quizMap || !state.enabled) return;
    collectAssignmentBlocks(container).forEach((b) => {
      const el = b.el;
      if (el.nextElementSibling && el.nextElementSibling.classList.contains("udth-assignment-th")) return;
      const thai = state.quizMap.get(normalizeText(b.text));
      if (!thai) return;
      const line = document.createElement("div");
      line.className = "udth-assignment-th";
      line.textContent = thai;
      line.style.fontSize = "0.95em";
      line.style.marginTop = "2px";
      line.style.color = "#c084fc";
      line.style.opacity = "0.95";
      line.style.lineHeight = "1.6";
      // Ensure we stay block-level so we don't flow inline with the next phrase
      line.style.display = "block";
      if (el.nextSibling) el.parentNode.insertBefore(line, el.nextSibling);
      else el.parentNode.appendChild(line);
    });
  }

  function watchAssignmentDom(container) {
    injectAssignmentTranslations(container);
    if (state.assignmentObserver) state.assignmentObserver.disconnect();
    state.assignmentObserver = new MutationObserver(() => injectAssignmentTranslations(container));
    state.assignmentObserver.observe(container, { childList: true, subtree: true });
  }

  function cleanupAssignment() {
    if (state.assignmentObserver) {
      state.assignmentObserver.disconnect();
      state.assignmentObserver = null;
    }
    document.querySelectorAll(".udth-assignment-th").forEach((el) => el.remove());
  }

  function quizId() {
    return (location.pathname.match(/\/learn\/quiz\/(\d+)/) || [])[1] || null;
  }

  // Normalising makes the lookup survive Udemy re-ordering answers or
  // re-wrapping whitespace between renders.
  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  async function fetchAssessments(id) {
    const data = await getJson(
      `/api-2.0/quizzes/${id}/assessments/?page_size=200` +
        `&fields[assessment]=id,assessment_type,prompt`
    );
    return (data && data.results) || [];
  }

  // Pull every translatable string out of the quiz: the question, each answer,
  // and the explanation Udemy shows after you answer.
  function collectQuizStrings(assessments) {
    const seen = new Set();
    const strings = [];

    const add = (raw) => {
      const text = stripHtml(raw);
      const key = normalizeText(text);
      if (!text || seen.has(key) || text.length < 2) return;
      seen.add(key);
      strings.push(text);
    };

    for (const item of assessments) {
      const prompt = item.prompt || {};
      add(prompt.question);
      const answers = Array.isArray(prompt.answers) ? prompt.answers : [];
      answers.forEach(add);
      const feedbacks = Array.isArray(prompt.feedbacks) ? prompt.feedbacks : [];
      feedbacks.forEach(add);
    }
    return strings;
  }

  function stripHtml(value) {
    if (!value) return "";
    const holder = document.createElement("div");
    holder.innerHTML = value;
    return (holder.textContent || "").replace(/\s+/g, " ").trim();
  }

  async function startQuiz(id) {
    const generation = state.generation;
    const assessments = await fetchAssessments(id);
    if (!assessments.length) {
      log("แบบทดสอบนี้ไม่มีข้อคำถาม");
      return;
    }

    const strings = collectQuizStrings(assessments);
    log("แบบทดสอบ", assessments.length, "ข้อ /", strings.length, "ข้อความ");

    const banner = ensureQuizBanner();
    setQuizBanner(banner, `กำลังแปลแบบทดสอบ ${assessments.length} ข้อเป็นไทย ...`);
    state.status = "translating";

    const force = await takeForceFlag(id);

    let translated;
    try {
      translated = await requestTranslation(
        {
          course: courseSlug(),
          lecture: `quiz-${id}`, // stable cache identity, unlike the title
          title: `แบบทดสอบ ${id}`,
          cues: strings.map((text, n) => ({ start: n, end: n + 1, text })),
          mode: "doc",
          force,
        },
        generation,
        (done, total) => {
          const suffix = total ? ` (${done}/${total})` : "";
          setQuizBanner(banner, `กำลังแปลแบบทดสอบ ...${suffix}`);
        }
      );
    } catch (err) {
      if (err instanceof Stale) return; // user moved on; nothing to report
      state.status = "error";
      setQuizBanner(banner, describeTranslateError(err), "error");
      return;
    }

    state.quizMap = new Map();
    (translated || []).forEach((cue, n) => {
      if (cue && cue.th && strings[n]) {
        state.quizMap.set(normalizeText(strings[n]), cue.th);
      }
    });

    state.status = "ready";
    setQuizBanner(
      banner,
      `แปลแล้ว ${state.quizMap.size} ข้อความ — คำแปลไทยจะขึ้นใต้ข้อความอังกฤษ`,
      "ok"
    );
    watchQuizDom();
  }

  // Udemy renders one question at a time, so translations are injected as the
  // DOM changes rather than all at once.
  const QUIZ_TEXT_SELECTOR =
    '[class*="mc-quiz-question--question-prompt"],' +
    '[class*="mc-quiz-answer--answer-body"],' +
    '[class*="feedback"] p';

  function injectQuizTranslations() {
    if (!state.quizMap || !state.enabled) return;

    document.querySelectorAll(QUIZ_TEXT_SELECTOR).forEach((el) => {
      if (el.dataset.udthDone === "1") return;

      const thai = state.quizMap.get(normalizeText(el.textContent));
      if (!thai) return;

      const line = document.createElement("div");
      line.className = "udth-quiz-th";
      line.textContent = thai;
      el.appendChild(line);
      el.dataset.udthDone = "1";
    });
  }

  function watchQuizDom() {
    injectQuizTranslations();
    if (state.quizObserver) state.quizObserver.disconnect();
    state.quizObserver = new MutationObserver(() => {
      // Cheap and idempotent: already-translated nodes are skipped by the flag.
      injectQuizTranslations();
    });
    state.quizObserver.observe(document.body, { childList: true, subtree: true });
  }

  function ensureQuizBanner() {
    let banner = document.querySelector(".udth-quiz-banner");
    if (banner) return banner;

    banner = document.createElement("div");
    banner.className = "udth-quiz-banner";
    const host =
      document.querySelector('[class*="quiz-page-content"]') ||
      document.querySelector('[class*="quiz-view--container"]') ||
      document.body;
    host.insertBefore(banner, host.firstChild);
    return banner;
  }

  function setQuizBanner(banner, text, kind = "info") {
    banner.innerHTML = "";
    const badge = document.createElement("div");
    badge.className = `udth-status udth-${kind}`;
    badge.textContent = text;
    banner.appendChild(badge);
  }

  function cleanupQuiz() {
    if (state.quizObserver) {
      state.quizObserver.disconnect();
      state.quizObserver = null;
    }
    state.quizMap = null;
    document.querySelectorAll(".udth-quiz-th").forEach((el) => el.remove());
    document
      .querySelectorAll('[data-udth-done="1"]')
      .forEach((el) => delete el.dataset.udthDone);
    const banner = document.querySelector(".udth-quiz-banner");
    if (banner) banner.remove();
  }

  // ------------------------------------------------------------- article mode

  // Leaf-level block elements only: a <p> nested in an <li> would otherwise be
  // collected twice and translated twice.
  const BLOCK_SELECTOR =
    "p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td,th,dd,dt,figcaption";

  function collectBlocks(root) {
    return Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter(
      (el) => !el.querySelector(BLOCK_SELECTOR) && (el.textContent || "").trim()
    );
  }

  function isCodeBlock(el) {
    return (
      el.tagName === "PRE" ||
      el.tagName === "CODE" ||
      !!el.closest("pre") ||
      // A block that is nothing but a <code> element is code too.
      (el.children.length === 1 && el.children[0].tagName === "CODE")
    );
  }

  async function waitForArticleContainer(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = document.querySelector(
        '[class*="article-asset--container"],[class*="article-asset"]'
      );
      if (el) return el;
      await sleep(600);
    }
    return null;
  }

  async function startArticle(asset) {
    const generation = state.generation;
    const container = await waitForArticleContainer();
    if (!container) {
      log("ไม่พบกล่องบทความในหน้านี้");
      return;
    }
    const built = articleCues(asset);
    if (!built.ok) {
      log(SKIP_TEXT[built.code] || built.code);
      return;
    }
    const { holder, blocks, cues } = built;

    state.status = "translating";
    const panel = ensureDocPanel(container);
    setDocStatus(panel, `กำลังแปลเอกสาร ${blocks.length} ย่อหน้าเป็นไทย ...`);

    const force = await takeForceFlag(lectureId());

    let translations;
    try {
      translations = await requestTranslation(
        {
          course: courseSlug(),
          lecture: lectureId(), // stable cache identity, unlike the title
          title: `${lessonTitle()} (เอกสาร)`,
          cues,
          mode: "doc",
          force,
        },
        generation,
        (done, total) => {
          const suffix = total ? ` (${done}/${total})` : "";
          setDocStatus(panel, `กำลังแปลเอกสาร ...${suffix}`);
        }
      );
    } catch (err) {
      if (err instanceof Stale) return; // user moved on; nothing to report
      state.status = "error";
      setDocStatus(panel, describeTranslateError(err), "error");
      return;
    }

    // Write the Thai text back into the copied DOM, so headings stay headings
    // and code blocks stay exactly as the instructor wrote them.
    translations = translations || [];
    blocks.forEach((el, n) => {
      const th = translations[n] && translations[n].th;
      if (th) el.textContent = th;
    });

    state.status = "ready";
    renderDocPanel(panel, holder, container, blocks.length);
    log("แปลเอกสารเสร็จ", blocks.length, "ย่อหน้า");
  }

  function ensureDocPanel(container) {
    let panel = document.querySelector(".udth-doc");
    if (panel) return panel;

    panel = document.createElement("section");
    panel.className = "udth-doc";
    panel.innerHTML =
      '<div class="udth-doc-bar">' +
      '<span class="udth-doc-title">ฉบับแปลไทย</span>' +
      '<button type="button" class="udth-doc-toggle">ดูต้นฉบับอังกฤษ</button>' +
      "</div>" +
      '<div class="udth-doc-body"></div>';
    container.parentElement.insertBefore(panel, container);
    return panel;
  }

  function setDocStatus(panel, text, kind = "info") {
    const body = panel.querySelector(".udth-doc-body");
    body.innerHTML = "";
    const badge = document.createElement("div");
    badge.className = `udth-status udth-${kind}`;
    badge.textContent = text;
    body.appendChild(badge);
  }

  function renderDocPanel(panel, holder, original, count) {
    const body = panel.querySelector(".udth-doc-body");
    body.innerHTML = "";
    body.appendChild(holder);

    panel.querySelector(".udth-doc-title").textContent = `ฉบับแปลไทย (${count} ย่อหน้า)`;

    const toggle = panel.querySelector(".udth-doc-toggle");
    original.style.display = "none"; // Thai first — that is the whole point
    toggle.onclick = () => {
      const showingOriginal = original.style.display !== "none";
      original.style.display = showingOriginal ? "none" : "";
      toggle.textContent = showingOriginal ? "ดูต้นฉบับอังกฤษ" : "ซ่อนต้นฉบับอังกฤษ";
    };
  }

  // --------------------------------------------------------- section batching
  //
  // Translating only the lecture on screen means waiting at the start of every
  // single one. Queueing the whole section instead means waiting once: by the
  // time you reach lecture 3, the server has already translated it and the
  // page finds it in the cache.

  // Measured on a real course: the curriculum comes back paginated at 200 items
  // and a large course ran to 520, so reading only the first page would hide
  // most of its sections.
  const CURRICULUM_PAGE_SIZE = 200;
  const CURRICULUM_MAX_PAGES = 12;

  async function fetchCurriculum(courseId) {
    const items = [];
    for (let page = 1; page <= CURRICULUM_MAX_PAGES; page += 1) {
      const data = await getJson(
        `/api-2.0/courses/${courseId}/subscriber-curriculum-items/` +
          `?page_size=${CURRICULUM_PAGE_SIZE}&page=${page}` +
          `&fields[lecture]=id,title,object_index,asset` +
          `&fields[chapter]=id,title,object_index` +
          `&fields[quiz]=id,title,object_index,type` +
          `&fields[practice]=id,title,object_index` +
          `&fields[asset]=asset_type`
      );
      items.push(...((data && data.results) || []));
      if (!data || !data.next) break;
    }
    return items;
  }

  // The list is flat; a "chapter" entry marks where each section begins.
  function sectionContaining(items, id) {
    const sections = [];
    let current = null;
    for (const item of items) {
      if (item._class === "chapter") {
        current = { title: item.title || "Section", items: [] };
        sections.push(current);
      } else if (current) {
        current.items.push(item);
      }
    }
    const wanted = String(id);
    const index = sections.findIndex((s) =>
      s.items.some((i) => String(i.id) === wanted)
    );
    if (index < 0) return null;
    return { ...sections[index], number: index + 1, total: sections.length };
  }

  // Videos and articles only. Practice tests are a different endpoint, and one
  // of them held 250 questions — queueing that behind a section the user wants
  // to watch tonight would bury the queue.
  const BATCH_ASSET_TYPES = ["Video", "Article"];

  async function queueLecture(item) {
    const asset = await fetchLectureAsset(item.id);
    const title = item.title || asset.title || `บทเรียน ${item.id}`;

    let payload;
    if (asset.type === "Article") {
      const built = articleCues(asset);
      if (!built.ok) return { outcome: "skipped", reason: built.code };
      payload = {
        course: courseSlug(),
        lecture: String(item.id),
        title: `${title} (เอกสาร)`,
        cues: built.cues,
        mode: "doc",
      };
    } else {
      const built = await videoCues(asset);
      if (!built.ok) return { outcome: "skipped", reason: built.code };
      payload = {
        course: courseSlug(),
        lecture: String(item.id),
        title,
        cues: built.cues,
      };
    }

    const started = await chrome.runtime.sendMessage({
      type: "startJob",
      payload: { ...payload, batch: true },
    });
    if (!started || !started.ok) {
      throw new Error((started && started.error) || "ส่งงานเข้าคิวไม่สำเร็จ");
    }
    const data = started.data || {};
    return { outcome: data.cached ? "cached" : "queued" };
  }

  async function translateSection() {
    if (!site.supportsSection) {
      return { ok: false, error: "แปลล่วงหน้าทั้ง Section ใช้ได้เฉพาะบน Udemy" };
    }
    if (state.batch.preparing) {
      return { ok: false, error: "กำลังเตรียมคิวอยู่แล้ว" };
    }

    const here = lectureId() || quizId();
    if (!here) {
      return { ok: false, error: "เปิดบทเรียนสักบทก่อน แล้วค่อยสั่งแปลทั้ง Section" };
    }

    state.batch.preparing = true;
    showBatch("กำลังอ่านรายการบทเรียนใน Section ...", "");
    try {
      const courseId = await getCourseId();
      const items = await fetchCurriculum(courseId);
      const section = sectionContaining(items, here);
      if (!section) throw new Error("หา Section ของบทเรียนนี้ไม่เจอ");

      const targets = section.items.filter(
        (i) =>
          i._class === "lecture" &&
          BATCH_ASSET_TYPES.includes((i.asset || {}).asset_type)
      );
      const label = `Section ${section.number} — ${section.title}`;
      log("แปลทั้ง Section", label, targets.length, "บทเรียน");

      if (!targets.length) {
        showBatch("Section นี้ไม่มีวิดีโอหรือบทความให้แปล", "ok", label);
        setTimeout(hideBatch, 8000);
        return { ok: true, queued: 0, cached: 0, skipped: 0, section: label };
      }

      let queued = 0;
      let cached = 0;
      let skipped = 0;
      // Kept apart from `skipped`: a lecture with no English captions is a fact
      // about the course, but a refused request means something is wrong and
      // the user needs to be told what.
      let lastError = null;

      for (let n = 0; n < targets.length; n += 1) {
        showBatch(
          `กำลังเตรียม ${n + 1}/${targets.length} บทเรียน`,
          "",
          label,
          n / targets.length
        );
        try {
          const result = await queueLecture(targets[n]);
          if (result.outcome === "cached") cached += 1;
          else if (result.outcome === "queued") queued += 1;
          else {
            skipped += 1;
            log("ข้าม", targets[n].title, result.reason);
          }
        } catch (err) {
          lastError = err;
          log("ข้าม", targets[n].title, err);
        }
      }

      // Nothing got through and every attempt threw — report the cause rather
      // than claiming the section has nothing to translate.
      if (!queued && !cached && lastError) throw lastError;

      state.batch.label = label;
      state.batch.total = queued;
      log("เข้าคิวแล้ว", { queued, cached, skipped, failed: lastError ? 1 : 0 });

      if (queued) {
        startQueueWatch();
      } else {
        showBatch(
          cached ? `Section นี้แปลไว้หมดแล้ว (${cached} บทเรียน)` : "ไม่มีบทเรียนที่แปลได้",
          "ok",
          label
        );
        setTimeout(hideBatch, 8000);
      }
      return { ok: true, queued, cached, skipped, section: label };
    } catch (err) {
      const text = describeTranslateError(err);
      showBatch(text, "error");
      return { ok: false, error: text };
    } finally {
      state.batch.preparing = false;
    }
  }

  // ------------------------------------------------------------- batch badge

  function ensureBatchBadge() {
    let badge = document.querySelector(".udth-batch");
    if (badge) return badge;

    badge = document.createElement("div");
    badge.className = "udth-batch";
    // Progress is announced, not shouted: polite means a screen reader finishes
    // the sentence it is on before reading the update.
    badge.setAttribute("aria-live", "polite");
    badge.innerHTML =
      '<div class="udth-batch-head">' +
      '<span class="udth-batch-title"></span>' +
      '<button type="button" class="udth-batch-close" aria-label="ปิดกล่องสถานะ">&times;</button>' +
      "</div>" +
      '<div class="udth-batch-detail"></div>' +
      '<div class="udth-batch-track"><div class="udth-batch-fill"></div></div>';
    document.body.appendChild(badge);
    badge.querySelector(".udth-batch-close").addEventListener("click", hideBatch);
    return badge;
  }

  function showBatch(text, kind = "", detail = "", ratio = null) {
    const badge = ensureBatchBadge();
    badge.className = `udth-batch${kind ? ` udth-batch-${kind}` : ""}`;
    badge.querySelector(".udth-batch-title").textContent = text;

    const detailEl = badge.querySelector(".udth-batch-detail");
    detailEl.textContent = detail;
    detailEl.style.display = detail ? "" : "none";

    const track = badge.querySelector(".udth-batch-track");
    track.style.display = ratio === null ? "none" : "";
    if (ratio !== null) {
      const percent = Math.max(0, Math.min(1, ratio)) * 100;
      badge.querySelector(".udth-batch-fill").style.width = `${percent}%`;
    }
  }

  function hideBatch() {
    stopQueueWatch();
    const badge = document.querySelector(".udth-batch");
    if (badge) badge.remove();
  }

  const QUEUE_POLL_MS = 3000;

  function stopQueueWatch() {
    if (state.batch.timer) {
      clearInterval(state.batch.timer);
      state.batch.timer = null;
    }
  }

  // Keeps reporting after the user moves to the next lecture — the queue lives
  // on the server, so it outlives whichever page happens to be open.
  function startQueueWatch() {
    if (state.batch.timer) return;

    const tick = async () => {
      let info = null;
      try {
        const res = await chrome.runtime.sendMessage({ type: "queueStatus" });
        if (res && res.ok) info = res.data;
      } catch {
        /* worker asleep or extension reloaded — try again next tick */
      }
      if (!info) return;

      const left = (info.queued || 0) + (info.running ? 1 : 0);
      if (!left) {
        stopQueueWatch();
        showBatch(
          info.failed
            ? `แปลล่วงหน้าเสร็จ — พลาด ${info.failed} บทเรียน`
            : "แปลล่วงหน้าเสร็จแล้ว เปิดบทถัดไปได้เลย",
          info.failed ? "error" : "ok",
          state.batch.label
        );
        setTimeout(hideBatch, 10000);
        return;
      }

      const total = state.batch.total || left;
      const done = Math.max(0, total - left);
      const now = info.running ? info.running.title : "";
      showBatch(
        `กำลังแปลล่วงหน้า ${done}/${total} บทเรียน`,
        "",
        now || state.batch.label,
        total ? done / total : null
      );
    };

    tick();
    state.batch.timer = setInterval(tick, QUEUE_POLL_MS);
  }

  // Udemy is a single-page app: the URL changes without a reload.
  const MAX_RETRIES = 3;

  function watchForLectureChange() {
    let running = false;
    let failures = 0;
    // A retry clears state.lectureKey, so the next tick looks exactly like a
    // lecture change. Tracking the key separately is what keeps the retry
    // counter climbing instead of resetting to zero on every attempt — without
    // it MAX_RETRIES never bites and the loop runs forever.
    let attemptedKey = null;

    const tick = async () => {
      // Both sites re-render their player on their own schedule, taking our
      // nodes with it. Re-attaching here is cheaper than a MutationObserver on
      // a busy subtree, and the poll is already running anyway.
      //
      // Not gated on the lecture being translated: the control belongs on the
      // player from the moment there is one, and the control bar it docks into
      // usually appears while the translation is still running.
      if (state.video && state.video.isConnected) {
        if (state.status === "ready" && (!state.overlay || !state.overlay.isConnected)) {
          state.overlay = null;
          ensureOverlay(state.video);
          renderCue(state.activeIndex >= 0 ? viewCues()[state.activeIndex] : null);
        }
        if (!panel.el || !panel.el.isConnected || !panel.button || !panel.button.isConnected) {
          renderPanel();
        } else if (panel.button.classList.contains("udth-pill-floating")) {
          // Built before the control bar existed — keep trying to dock it.
          dockButton(panel.button);
        }
      }

      const key = site.pageKey() || location.pathname;
      if (key === state.lectureKey || running) return;

      if (key !== attemptedKey) {
        attemptedKey = key;
        failures = 0;
      }
      state.lectureKey = key;
      state.status = "idle";
      running = true;
      log("เริ่มบทเรียน", key);
      try {
        await start();
      } catch (err) {
        failures += 1;
        log("ผิดพลาด", err);
        state.status = "error";

        // Clearing lectureKey immediately made the next tick retry 1.5s later,
        // and a failure that repeats (a dead server, say) turned into an error
        // message flashing forever. Back off, and give up after a few tries.
        if (failures <= MAX_RETRIES) {
          const delay = 4000 * failures;
          renderStatus(
            `${describeTranslateError(err)} — ลองใหม่ใน ${Math.round(delay / 1000)} วินาที`,
            "error"
          );
          setTimeout(() => {
            if (state.lectureKey === key) state.lectureKey = null;
          }, delay);
        } else {
          renderStatus(
            `${describeTranslateError(err)} — หยุดลองแล้ว กด F5 เพื่อเริ่มใหม่`,
            "error"
          );
        }
      } finally {
        running = false;
      }
    };

    tick();
    setInterval(tick, 1500);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "getState") {
      sendResponse({
        status: state.status,
        count: state.cues.length,
        enabled: state.enabled,
        dualMode: state.dualMode,
        dubbingEnabled: state.dubbingEnabled,
        dubbingVolume: state.dubbingVolume,
        originalAudioVolume: state.originalAudioVolume,
        dubRateCap: state.dubRateCap,
        ttsVoice: state.ttsVoice || DEFAULT_TTS_VOICE,
        ttsEngine: state.ttsEngine,
        nativeVoices: state.nativeVoices,
        audioCached: state.audioUrls.size,
        audioPending: state.audioPending.size,
        hasNativeThai: state.hasNativeThai,
      });
      return false;
    }
    if (message.type === "setOptions") {
      // The popup sends whole settings objects; commitOptions applies them the
      // same way the in-player panel does, so the two cannot diverge.
      const changes = {};
      if (typeof message.enabled === "boolean") changes.enabled = message.enabled;
      if (typeof message.dualMode === "boolean") changes.dualMode = message.dualMode;
      if (typeof message.dubbingEnabled === "boolean") {
        changes.dubbingEnabled = message.dubbingEnabled;
      }
      if (typeof message.ttsEngine === "string" && message.ttsEngine) {
        changes.ttsEngine = message.ttsEngine;
      }
      if (typeof message.dubbingVolume === "number") changes.dubbingVolume = message.dubbingVolume;
      if (typeof message.originalAudioVolume === "number") {
        changes.originalAudioVolume = message.originalAudioVolume;
      }
      if (typeof message.dubRateCap === "number" && message.dubRateCap >= 1) {
        changes.dubRateCap = message.dubRateCap;
      }
      if (typeof message.ttsVoice === "string" && message.ttsVoice !== state.ttsVoice) {
        changes.ttsVoice = message.ttsVoice;
      }
      commitOptions(changes);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "retranslate") {
      state.lectureKey = null;
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "translateSection") {
      // Answer now and keep working. Gathering a section takes tens of seconds
      // and the popup usually closes long before then; holding the message
      // channel open that long is exactly what broke the old design.
      if (state.batch.preparing) {
        sendResponse({ ok: false, error: "กำลังเตรียมคิวอยู่แล้ว" });
        return false;
      }
      translateSection().catch((err) => log("แปลทั้ง Section ล้มเหลว", err));
      sendResponse({ ok: true, started: true });
      return false;
    }
    return false;
  });

  chrome.storage.local
    .get(["enabled", "dualMode", "capSize", "dubbingEnabled", "ttsEngine", "dubbingVolume", "originalAudioVolume", "ttsVoice", "dubRateCap"])
    .then((stored) => {
      if (typeof stored.enabled === "boolean") state.enabled = stored.enabled;
      if (typeof stored.dualMode === "boolean") state.dualMode = stored.dualMode;
      if (["s", "m", "l"].includes(stored.capSize)) state.capSize = stored.capSize;
      if (typeof stored.dubbingEnabled === "boolean") state.dubbingEnabled = stored.dubbingEnabled;
      if (typeof stored.ttsEngine === "string" && stored.ttsEngine) {
        state.ttsEngine = stored.ttsEngine;
      }
      if (typeof stored.dubbingVolume === "number") state.dubbingVolume = stored.dubbingVolume;
      if (typeof stored.originalAudioVolume === "number") {
        state.originalAudioVolume = stored.originalAudioVolume;
      }
      if (typeof stored.ttsVoice === "string") state.ttsVoice = stored.ttsVoice;
      if (typeof stored.dubRateCap === "number" && stored.dubRateCap >= 1) {
        state.dubRateCap = stored.dubRateCap;
      }
      syncDubbingVolume();
    })
    .catch(() => {})
    .finally(() => {
      loadServerEngines();
      watchForLectureChange();
    });

  function loadNativeVoices() {
    state.nativeVoices = window.speechSynthesis.getVoices()
      .filter((voice) => /^th(?:-|_)/i.test(voice.lang))
      .map((voice) => ({ name: voice.name, lang: voice.lang }));
  }
  loadNativeVoices();
  window.speechSynthesis.addEventListener("voiceschanged", loadNativeVoices);
})();
