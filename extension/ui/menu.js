// The control on the player: one button in the player's own control bar that
// opens a menu above it. Every control writes through the settings store and
// the menu re-renders from it, so the popup and this menu cannot disagree.
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});
  const log = (...args) => console.log("[udth]", ...args);

  // Small inline icons (Lucide-style strokes): SVG, never emoji.
  const icon = (d, size = 16) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  const BUTTON_GLYPH =
    '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">' +
    '<rect x="2.5" y="3.5" width="19" height="17" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M6.800 9.200h5.400M9.500 9.200v.8c0 1.700-.9 3.200-2.600 4M9.600 11.800c.6 1 1.500 1.700 2.600 2.100" ' +
    'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M13.300 16l2.300-6.300 2.300 6.300M14.100 14h3" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '<i class="udth-dot" aria-hidden="true"></i>';

  const BROWSER_ENGINE = {
    name: "windows", label: "Windows (เสียงในเบราว์เซอร์)", ready: true, translates: false, voices: [], error: "",
  };

  function menuHtml(version) {
    return (
      '<div class="udth-menu-head">' +
      '<div class="udth-logo" aria-hidden="true">ท</div>' +
      '<div class="udth-menu-titles"><div class="udth-menu-title">ฮองเรียน</div>' +
      '<div class="udth-menu-sub"><span data-udth="src">EN</span><span class="udth-menu-arrow">→</span>ไทย' +
      `<span class="udth-ver">· v${version}</span></div></div>` +
      '<button type="button" class="udth-icon-btn" data-udth="close" aria-label="ปิดเมนู">' +
      icon('<path d="M18 6 6 18M6 6l12 12"/>', 18) + "</button></div>" +
      '<div class="udth-group">' +
      '<div class="udth-row-label">' +
      icon('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>', 14) +
      "ซับบนวิดีโอ</div>" +
      '<div class="udth-seg" role="group" aria-label="ซับบนวิดีโอ">' +
      '<button type="button" data-udth="subtitles" data-val="off">ปิด</button>' +
      '<button type="button" data-udth="subtitles" data-val="th">ไทย</button>' +
      '<button type="button" data-udth="subtitles" data-val="both">ไทย + ต้นฉบับ</button></div>' +
      '<div class="udth-row"><span class="udth-row-label">ขนาดตัวอักษร</span>' +
      '<div class="udth-seg udth-seg-size" role="group" aria-label="ขนาดตัวอักษร">' +
      '<button type="button" data-udth="textSize" data-val="s" aria-label="เล็ก" title="เล็ก">ก</button>' +
      '<button type="button" data-udth="textSize" data-val="m" aria-label="กลาง" title="กลาง">ก</button>' +
      '<button type="button" data-udth="textSize" data-val="l" aria-label="ใหญ่" title="ใหญ่">ก</button></div></div>' +
      "</div>" +
      '<div class="udth-group udth-dub-group">' +
      '<button type="button" class="udth-dubrow" data-udth="dub" aria-pressed="false">' +
      '<span class="udth-dubrow-ico">' +
      icon('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>', 18) +
      "</span>" +
      '<span class="udth-dubrow-txt"><b>พากย์เสียงไทย</b><small data-state="dub">ปิด</small></span>' +
      '<span class="udth-switch" aria-hidden="true"></span></button>' +
      '<div class="udth-start" data-udth-row="start">' +
      '<div class="udth-seg" role="group" aria-label="เริ่มเล่นเมื่อไหร่">' +
      '<button type="button" data-udth="start" data-val="instant">' +
      icon('<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>', 14) + "เริ่มทันที</button>" +
      '<button type="button" data-udth="start" data-val="accurate">' +
      icon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>', 14) +
      "แม่นยำ</button></div>" +
      '<p class="udth-start-hint" data-state="start"></p></div>' +
      "</div>" +
      '<details class="udth-adv"><summary>' +
      icon('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>', 15) +
      'ตั้งค่าเสียงพากย์<span class="udth-chev">' + icon('<path d="m6 9 6 6 6-6"/>', 16) + "</span></summary>" +
      '<div class="udth-card">' +
      '<label class="udth-field"><span>เครื่องมือเสียง</span><select data-udth="engine"></select></label>' +
      '<label class="udth-field"><span>เสียง</span><select data-udth="voice"></select></label>' +
      '<label class="udth-field"><span>ความดังเสียงพากย์</span>' +
      '<input type="range" min="0" max="1" step="0.05" data-udth="volume"><output data-udth="volumeOut"></output></label>' +
      '<label class="udth-field"><span>ความดังเสียงผู้สอน</span>' +
      '<input type="range" min="0" max="1" step="0.05" data-udth="sourceVolume"><output data-udth="sourceVolumeOut"></output></label>' +
      '<label class="udth-field"><span>เร่งเสียงพากย์ได้สูงสุด</span>' +
      '<input type="range" min="1" max="2" step="0.05" data-udth="maxRate"><output data-udth="maxRateOut"></output></label>' +
      "</div></details>" +
      '<div class="udth-menu-actions">' +
      '<button type="button" class="udth-btn" data-udth="retry">' +
      icon('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/>', 15) +
      "แปลใหม่</button>" +
      '<button type="button" class="udth-btn udth-btn-primary" data-udth="section">' +
      icon('<path d="M5 12h14M13 6l6 6-6 6"/>', 15) + "แปลทั้ง Section ล่วงหน้า</button>" +
      "</div>" +
      '<div class="udth-panel-note" role="status" aria-live="polite"></div>'
    );
  }

  /**
   * @param {object} deps
   * @param {object} deps.site
   * @param {HTMLMediaElement} deps.video
   * @param {object} deps.store             core/settings.js store
   * @param {() => object[]} deps.engines   server engine catalogue (may be empty)
   * @param {() => Promise<void>} deps.refreshEngines
   * @param {() => string} deps.sourceLang
   * @param {() => string} deps.serverIssue why engines are missing, or ""
   * @param {() => void} deps.onRetranslate
   * @param {(() => Promise<{ok:boolean,error?:string}>)|null} deps.onTranslateSection
   * @param {(open: boolean) => void} [deps.onToggle]
   */
  function createMenu({ site, video, store, engines, refreshEngines, sourceLang, serverIssue, onRetranslate,
    onTranslateSection, onToggle = () => {} }) {
    let button = null;
    let el = null;
    let open = false;
    let version = "";
    try {
      version = chrome.runtime.getManifest().version;
    } catch {
      /* the page outlived an extension update */
    }

    const catalogue = () => [BROWSER_ENGINE, ...engines()];
    const engineByName = (name) =>
      catalogue().find((e) => e.name === name) ||
      { name, label: name, ready: false, translates: false, voices: [], error: "เซิร์ฟเวอร์ไม่มีเครื่องมือเสียงนี้" };
    const browserVoices = () => (UDTH.voices ? UDTH.voices.browserVoiceNames() : []).map((n) => ({ id: n, label: n }));
    const voicesOf = (name) => (name === "windows" ? browserVoices() : engineByName(name).voices || []);
    const $ = (key) => el && el.querySelector(`[data-udth="${key}"]`);

    function setNote(text, isError = false) {
      const note = el && el.querySelector(".udth-panel-note");
      if (!note) return;
      note.textContent = text || "";
      note.classList.toggle("udth-panel-note-error", Boolean(isError));
    }

    function setOpen(next) {
      open = next;
      render();
      onToggle(open);
      // The server is often started after the tab: refetch on every open.
      if (open) refreshEngines().then(render, render);
    }

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
        let el = video;
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
        if (!bar || bar === document.body || bar.contains(video)) continue;
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

    function ensure() {
      if (button && button.isConnected && el && el.isConnected) {
        if (button.classList.contains("udth-pill-floating")) dockButton(button);
        return;
      }
      removeNodes();
      const host = site.playerContainer() || video.parentElement;
      if (!host) return;
      if (getComputedStyle(host).position === "static") host.style.position = "relative";

      button = document.createElement("button");
      button.type = "button";
      button.className = "udth-pill udth-pill-floating";
      button.dataset.udth = "toggle";
      button.setAttribute("aria-label", "ซับไทยและเสียงพากย์");
      button.setAttribute("aria-haspopup", "dialog");
      button.title = "ซับไทยและเสียงพากย์";
      button.innerHTML = BUTTON_GLYPH;
      host.appendChild(button);
      dockButton(button);

      el = document.createElement("div");
      el.className = "udth-menu";
      el.hidden = true;
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-label", "ฮองเรียน: ซับไทยและเสียงพากย์");
      el.innerHTML = menuHtml(version);
      host.appendChild(el);
      wire(button);
      wire(el);
      render();
    }

    function wire(root) {
      root.addEventListener("click", (event) => {
        const target = event.target.closest("button[data-udth]");
        if (!target) return;
        // Both players treat stray clicks on themselves as play/pause.
        event.stopPropagation();
        event.preventDefault();
        const action = target.dataset.udth;
        const val = target.dataset.val;
        const dub = store.get().dub;
        if (action === "toggle") setOpen(!open);
        else if (action === "close") {
          setOpen(false);
          button.focus();
        } else if (action === "subtitles") store.save({ subtitles: val });
        else if (action === "textSize") store.save({ textSize: val });
        else if (action === "dub") store.save({ dub: { on: !dub.on } });
        else if (action === "start") store.save({ dub: { start: val } });
        else if (action === "retry") onRetranslate();
        else if (action === "section" && onTranslateSection) {
          setNote("กำลังเตรียมคิว ...");
          onTranslateSection().then(
            (res) => setNote(res.ok ? "ส่งเข้าคิวแล้ว ดูความคืบหน้าที่มุมซ้ายล่าง" : res.error, !res.ok),
            (err) => setNote(String((err && err.message) || err), true)
          );
        }
      });
      root.addEventListener("change", (event) => {
        const key = event.target.dataset.udth;
        if (key === "engine") store.save({ dub: { engine: event.target.value } });
        else if (key === "voice") store.save({ dub: { voice: event.target.value } });
      });
      root.addEventListener("input", (event) => {
        const key = event.target.dataset.udth;
        if (["volume", "sourceVolume", "maxRate"].includes(key)) {
          store.save({ dub: { [key]: Number(event.target.value) } });
        }
      });
      root.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        button.focus();
      });
    }

    // Clicking the video to pause it puts the menu away, as the player's own
    // menus behave.
    function onOutsideClick(event) {
      if (!open || !el) return;
      if (el.contains(event.target) || (button && button.contains(event.target))) return;
      setOpen(false);
    }
    document.addEventListener("click", onOutsideClick, true);

    function fillSelect(select, options, selected) {
      const signature = JSON.stringify([options, selected]);
      if (select.dataset.sig === signature) return;
      select.dataset.sig = signature;
      select.textContent = "";
      for (const o of options) select.add(new Option(o.label, o.value));
      const has = options.some((o) => o.value === selected);
      select.value = has ? selected : options.length ? options[0].value : "";
    }

    function voiceLabel(dub) {
      const voices = voicesOf(dub.engine);
      const chosen = voices.find((v) => v.id === dub.voice) || voices[0];
      const name = engineByName(dub.engine).label.replace(/\s*\(.*\)\s*$/, "");
      return chosen ? `${chosen.label} · ${name}` : name;
    }

    function render() {
      if (!el) return;
      const s = store.get();
      if (!s) return;
      const dub = s.dub;
      const engine = engineByName(dub.engine);
      const current = { subtitles: s.subtitles, textSize: s.textSize, start: dub.start };
      for (const b of el.querySelectorAll('[data-udth="subtitles"], [data-udth="textSize"], [data-udth="start"]')) {
        const on = b.dataset.val === current[b.dataset.udth];
        b.classList.toggle("udth-seg-on", on);
        b.setAttribute("aria-pressed", String(on));
      }
      const dubRow = $("dub");
      dubRow.classList.toggle("udth-dubrow-on", dub.on);
      dubRow.setAttribute("aria-pressed", String(dub.on));
      el.querySelector('[data-state="dub"]').textContent = dub.on
        ? `เปิดอยู่ · ${voiceLabel(dub)}`
        : "ปิด · กดเพื่อฟังเสียงพากย์ไทย";

      // The start choice only means something for a voice that can translate.
      el.querySelector('[data-udth-row="start"]').hidden = !(dub.on && engine.translates);
      el.querySelector('[data-state="start"]').textContent =
        dub.start === "instant"
          ? "เล่นได้ทันที Seamless แปลและพากย์จากต้นฉบับ แล้วเปลี่ยนเป็นคำแปล AI เมื่อแปลเสร็จ"
          : "รอ AI แปลก่อนราว 1 นาที ซับและเสียงตรงกันทุกคำ แม่นที่สุด";

      button.classList.toggle("udth-pill-on", s.subtitles !== "off" || dub.on);
      button.classList.toggle("udth-pill-open", open);
      button.setAttribute("aria-expanded", String(open));
      el.hidden = !open;
      if (!open) return;

      $("src").textContent = sourceLang() || "EN";
      const engineOptions = catalogue().map((e) => ({
        value: e.name,
        label: e.ready ? e.label : `${e.label} (ยังไม่พร้อม)`,
      }));
      if (!catalogue().some((e) => e.name === dub.engine)) {
        engineOptions.push({ value: dub.engine, label: `${dub.engine} (ยังไม่พร้อม)` });
      }
      fillSelect($("engine"), engineOptions, dub.engine);
      const voices = voicesOf(dub.engine);
      fillSelect(
        $("voice"),
        voices.length ? voices.map((v) => ({ value: v.id, label: v.label })) : [{ value: "", label: "เลือกอัตโนมัติ" }],
        dub.voice
      );
      $("volume").value = String(dub.volume);
      $("volumeOut").value = `${Math.round(dub.volume * 100)}%`;
      $("sourceVolume").value = String(dub.sourceVolume);
      $("sourceVolumeOut").value = `${Math.round(dub.sourceVolume * 100)}%`;
      $("maxRate").value = String(dub.maxRate);
      $("maxRateOut").value = `${dub.maxRate.toFixed(2)}x`;
      $("section").hidden = !site.supportsSection || !onTranslateSection;

      const issue = serverIssue() || (!engine.ready && engine.error) || "";
      if (issue) setNote(issue, true);
      else if (el.querySelector(".udth-panel-note-error")) setNote("");
    }

    function removeNodes() {
      if (button) button.remove();
      if (el) el.remove();
      button = null;
      el = null;
    }

    return {
      ensure,
      render,
      isOpen: () => open,
      setNote,
      dispose() {
        removeNodes();
        document.removeEventListener("click", onOutsideClick, true);
      },
    };
  }

  UDTH.menu = { createMenu };
})();
